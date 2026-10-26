//! Native SFTP vs compatibility mode (`sftp-server` started as a command) on two
//! throwaway local OpenSSH servers: one with an absolute `Subsystem` line (native) and
//! one with a relative line (compatibility mode). Optionally through an in-process TCP
//! proxy that delays each direction, to see how both paths cope with latency. Prints
//! the median of N runs. Skipped unless `RUSTSCP_TEST_SPAWN_SSHD=1` (see
//! `tests/support/sshd.rs`):
//!
//! `RUSTSCP_TEST_SPAWN_SSHD=1 cargo run --release -p rustscp-core --example sftp_fallback_bench -- --delay-ms 0,20`
//!
//! Options: `--runs N` (3), `--size-mib N` (64), `--chunk-mib N` (4), `--parallel-mib N`
//! (16, read by 4 tasks at once) and `--delay-ms A,B,..` (one-way delay per setting,
//! RTT = 2x; 0 = direct).

#[path = "../tests/support/sshd.rs"]
mod sshd;

use bytes::Bytes;
use rustscp_core::{
    AuthMethod, ConnectionConfig, Protocol, SftpDriver, SftpMode, VirtualFileSystem,
};
use sshd::{Sshd, Variant};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio::time::Instant;

const MIB: usize = 1024 * 1024;

struct Options {
    runs: usize,
    size: usize,
    chunk: usize,
    parallel: usize,
    delays_ms: Vec<u64>,
}

impl Options {
    fn parse() -> Options {
        let mut o = Options {
            runs: 3,
            size: 64 * MIB,
            chunk: 4 * MIB,
            parallel: 16 * MIB,
            delays_ms: vec![0],
        };
        let mut args = std::env::args().skip(1);
        while let Some(flag) = args.next() {
            let mut value = || args.next().unwrap_or_else(|| usage(&flag));
            match flag.as_str() {
                "--runs" => o.runs = number(&value()).max(1),
                "--size-mib" => o.size = number(&value()).max(1) * MIB,
                "--chunk-mib" => o.chunk = number(&value()).max(1) * MIB,
                "--parallel-mib" => o.parallel = number(&value()).max(1) * MIB,
                "--delay-ms" => {
                    o.delays_ms = value().split(',').map(|v| number(v) as u64).collect()
                }
                _ => usage(&flag),
            }
        }
        o
    }
}

fn number(v: &str) -> usize {
    v.trim()
        .parse()
        .unwrap_or_else(|_| usage(&format!("not a number: {v}")))
}

fn usage(bad: &str) -> ! {
    eprintln!(
        "{bad}\nusage: sftp_fallback_bench [--runs N] [--size-mib N] [--chunk-mib N] \
         [--parallel-mib N] [--delay-ms A,B,..]"
    );
    std::process::exit(2)
}

/// Forwards a new 127.0.0.1 port to `target`, holding every chunk for `one_way` in each
/// direction (RTT = 2 x `one_way`): a long link with unlimited bandwidth.
async fn delay_proxy(target: u16, one_way: Duration) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((client, _)) = listener.accept().await {
            tokio::spawn(async move {
                let Ok(server) = TcpStream::connect(("127.0.0.1", target)).await else {
                    return;
                };
                let _ = client.set_nodelay(true);
                let _ = server.set_nodelay(true);
                let (client_read, client_write) = client.into_split();
                let (server_read, server_write) = server.into_split();
                tokio::join!(
                    pump(client_read, server_write, one_way),
                    pump(server_read, client_write, one_way)
                );
            });
        }
    });
    port
}

async fn pump(mut from: OwnedReadHalf, mut to: OwnedWriteHalf, delay: Duration) {
    let (tx, mut rx) = mpsc::unbounded_channel::<(Instant, Vec<u8>)>();
    let writer = tokio::spawn(async move {
        while let Some((due, data)) = rx.recv().await {
            tokio::time::sleep_until(due).await;
            if to.write_all(&data).await.is_err() {
                break;
            }
        }
        let _ = to.shutdown().await;
    });
    let mut buf = vec![0u8; 64 * 1024];
    while let Ok(n @ 1..) = from.read(&mut buf).await {
        if tx
            .send((Instant::now() + delay, buf[..n].to_vec()))
            .is_err()
        {
            break;
        }
    }
    drop(tx);
    let _ = writer.await;
}

/// Reproducible bytes that do not compress (xorshift64*).
fn pseudo_random(len: usize, seed: u64) -> Vec<u8> {
    let mut x = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
    let mut out = Vec::with_capacity(len + 8);
    while out.len() < len {
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        out.extend_from_slice(&x.wrapping_mul(0x2545_F491_4F6C_DD1D).to_le_bytes());
    }
    out.truncate(len);
    out
}

/// A connected driver ready to measure (its first operation, where the driver chooses
/// native SFTP or compatibility mode, already done).
struct Target {
    driver: SftpDriver,
    work: String,
    first_op: Duration,
    mode: Option<String>,
}

async fn open(server: &Sshd, port: u16) -> Result<Target, String> {
    let driver = SftpDriver::new(ConnectionConfig {
        id: format!("bench-{}-{port}", server.variant.name()),
        name: format!("bench {}", server.variant.name()),
        protocol: Protocol::Sftp,
        host: "127.0.0.1".into(),
        port,
        username: server.user.clone(),
        auth: AuthMethod::PrivateKey {
            path: server.key.to_string_lossy().into_owned(),
            passphrase: None,
            key_data: None,
        },
        remote_root: "/".into(),
        tls_fingerprint: None,
        sftp_mode: SftpMode::Auto,
        group: None,
    });
    driver.connect().await.map_err(|e| e.to_string())?;
    let work = server.work.to_string_lossy().into_owned();
    let started = Instant::now();
    driver.list_dir(&work).await.map_err(|e| e.to_string())?;
    let first_op = started.elapsed();
    let mode = driver.compatibility_mode();
    Ok(Target {
        driver,
        work,
        first_op,
        mode,
    })
}

#[derive(Clone, Copy)]
enum Op {
    WriteFile,
    ReadFile,
    WriteAtChunks,
    ReadRangeChunks,
    ParallelReads,
}

const OPS: [Op; 5] = [
    Op::WriteFile,
    Op::ReadFile,
    Op::WriteAtChunks,
    Op::ReadRangeChunks,
    Op::ParallelReads,
];

impl Op {
    fn label(self, o: &Options) -> String {
        let (size, chunk, par) = (o.size / MIB, o.chunk / MIB, o.parallel / MIB);
        match self {
            Op::WriteFile => format!("write_file {size} MiB"),
            Op::ReadFile => format!("read_file {size} MiB"),
            Op::WriteAtChunks => format!("write_at {chunk} MiB chunks, {size} MiB"),
            Op::ReadRangeChunks => format!("read_range {chunk} MiB chunks, {size} MiB"),
            Op::ParallelReads => format!("4 parallel read_file {par} MiB"),
        }
    }

    fn bytes(self, o: &Options) -> usize {
        match self {
            Op::ParallelReads => 4 * o.parallel,
            _ => o.size,
        }
    }
}

/// Files the read operations read, written once per target before measuring.
fn read_path(t: &Target) -> String {
    format!("{}/read.bin", t.work)
}
fn parallel_path(t: &Target) -> String {
    format!("{}/parallel.bin", t.work)
}

/// One timed run of `op`; the result is checked outside the timing.
async fn run(
    op: Op,
    t: &Target,
    o: &Options,
    data: &Bytes,
    par: &Bytes,
) -> Result<Duration, String> {
    let d = &t.driver;
    let err = |e: rustscp_core::CoreError| e.to_string();
    let write_path = format!("{}/write.bin", t.work);
    let started = Instant::now();
    match op {
        Op::WriteFile => {
            d.write_file(&write_path, data.clone()).await.map_err(err)?;
            let took = started.elapsed();
            check_size(d, &write_path, data.len()).await?;
            Ok(took)
        }
        Op::ReadFile => {
            let got = d.read_file(&read_path(t)).await.map_err(err)?;
            let took = started.elapsed();
            check_same(&got, data)?;
            Ok(took)
        }
        Op::WriteAtChunks => {
            for offset in (0..data.len()).step_by(o.chunk) {
                let end = (offset + o.chunk).min(data.len());
                d.write_at(&write_path, offset as u64, data.slice(offset..end))
                    .await
                    .map_err(err)?;
            }
            let took = started.elapsed();
            check_size(d, &write_path, data.len()).await?;
            Ok(took)
        }
        Op::ReadRangeChunks => {
            let mut got = Vec::with_capacity(data.len());
            for offset in (0..data.len()).step_by(o.chunk) {
                let chunk = d
                    .read_range(&read_path(t), offset as u64, o.chunk as u64)
                    .await
                    .map_err(err)?;
                got.extend_from_slice(&chunk);
            }
            let took = started.elapsed();
            check_same(&got, data)?;
            Ok(took)
        }
        Op::ParallelReads => {
            let path = parallel_path(t);
            let reads = (0..4).map(|_| {
                let (d, path) = (d.clone(), path.clone());
                tokio::spawn(async move { d.read_file(&path).await })
            });
            let handles: Vec<_> = reads.collect();
            let mut results = Vec::with_capacity(4);
            for h in handles {
                results.push(h.await.map_err(|e| e.to_string())?.map_err(err)?);
            }
            let took = started.elapsed();
            for got in &results {
                check_same(got, par)?;
            }
            Ok(took)
        }
    }
}

async fn check_size(d: &SftpDriver, path: &str, len: usize) -> Result<(), String> {
    let size = d.metadata(path).await.map_err(|e| e.to_string())?.size;
    if size != len as u64 {
        return Err(format!("{path} has {size} bytes, expected {len}"));
    }
    Ok(())
}

fn check_same(got: &[u8], want: &[u8]) -> Result<(), String> {
    if got != want {
        return Err(format!(
            "read {} bytes that differ from the {} written",
            got.len(),
            want.len()
        ));
    }
    Ok(())
}

/// Median throughput (MiB/s) of `runs` runs, or why it could not be measured.
async fn measure(
    op: Op,
    t: &Target,
    o: &Options,
    data: &Bytes,
    par: &Bytes,
) -> Result<f64, String> {
    let mut times = Vec::with_capacity(o.runs);
    for _ in 0..o.runs {
        times.push(run(op, t, o, data, par).await?);
    }
    times.sort();
    let median = times[times.len() / 2].as_secs_f64();
    Ok(op.bytes(o) as f64 / MIB as f64 / median)
}

fn cell(r: &Result<f64, String>) -> String {
    match r {
        Ok(v) => format!("{v:>10.1}"),
        Err(_) => format!("{:>10}", "failed"),
    }
}

#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn main() {
    if let Some(reason) = sshd::skip_reason() {
        eprintln!("skipped: {reason}");
        return;
    }
    let o = Options::parse();
    let config_dir = tempfile::tempdir().unwrap();
    std::env::set_var("RUSTSCP_CONFIG_DIR", config_dir.path());
    let native_server = Sshd::start(Variant::Good);
    let compat_server = Sshd::start(Variant::Relative);
    let data = Bytes::from(pseudo_random(o.size, 1));
    let par = Bytes::from(pseudo_random(o.parallel, 2));

    for &delay in &o.delays_ms {
        let one_way = Duration::from_millis(delay);
        let mut targets = Vec::new();
        for server in [&native_server, &compat_server] {
            let port = if delay == 0 {
                server.port
            } else {
                delay_proxy(server.port, one_way).await
            };
            let target = match open(server, port).await {
                Ok(t) => {
                    let ready = async {
                        t.driver.write_file(&read_path(&t), data.clone()).await?;
                        t.driver.write_file(&parallel_path(&t), par.clone()).await
                    };
                    ready.await.map(|_| t).map_err(|e| e.to_string())
                }
                Err(e) => Err(e),
            };
            targets.push(target);
        }

        println!(
            "\none-way delay {delay} ms (RTT {} ms), median of {} runs, MiB/s",
            2 * delay,
            o.runs
        );
        for (name, t) in ["native", "compat"].iter().zip(&targets) {
            match t {
                Ok(t) => println!(
                    "  {name}: first operation {:.2} s, compatibility mode {:?}",
                    t.first_op.as_secs_f64(),
                    t.mode
                ),
                Err(e) => println!("  {name}: unavailable: {e}"),
            }
        }
        println!(
            "  {:<36}{:>10}{:>10}{:>16}",
            "operation", "native", "compat", "compat/native"
        );
        for op in OPS {
            let mut results = Vec::new();
            for t in &targets {
                results.push(match t {
                    Ok(t) => measure(op, t, &o, &data, &par).await,
                    Err(e) => Err(e.clone()),
                });
            }
            let ratio = match (&results[0], &results[1]) {
                (Ok(n), Ok(c)) => format!("{:>16.2}", c / n),
                _ => format!("{:>16}", "-"),
            };
            println!(
                "  {:<36}{}{}{ratio}",
                op.label(&o),
                cell(&results[0]),
                cell(&results[1])
            );
            for ((name, t), r) in ["native", "compat"].iter().zip(&targets).zip(&results) {
                if let (Ok(_), Err(e)) = (t, r) {
                    println!("    {name} failed: {e}");
                }
            }
        }
    }
    // The servers' folders (and every file written) go away with them.
}
