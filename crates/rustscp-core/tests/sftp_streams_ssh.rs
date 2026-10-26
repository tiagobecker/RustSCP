//! What SFTP leaves open on the server: one-off `read_range` / `write_at` calls close
//! their file before they return, streams (`read_range_in` / `write_at_in`) keep one
//! file open only until they are finished or abandoned, and a one-off read never sees
//! stale bytes after the file changed. Runs against real OpenSSH servers the test
//! starts itself (native SFTP and compatibility mode), counting the files the server
//! has open with `lsof`. Skipped unless `RUSTSCP_TEST_SPAWN_SSHD=1`, `/usr/sbin/sshd`
//! and `lsof` exist:
//!
//! `RUSTSCP_TEST_SPAWN_SSHD=1 cargo test -p rustscp-core --test sftp_streams_ssh -- --nocapture`

#[path = "support/sshd.rs"]
mod sshd;

use bytes::Bytes;
use rustscp_core::{
    AuthMethod, ConnectionConfig, LocalFsDriver, Protocol, SftpDriver, SftpMode, StreamId,
    TransferQueueManager, TransferStatus, VirtualFileSystem,
};
use sshd::{Sshd, Variant};
use std::collections::HashMap;
use std::io::{Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

fn site(server: &Sshd) -> ConnectionConfig {
    ConnectionConfig {
        id: format!("streams-{}-{}", server.variant.name(), server.port),
        name: format!("{} server", server.variant.name()),
        protocol: Protocol::Sftp,
        host: "127.0.0.1".into(),
        port: server.port,
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
    }
}

/// How many processes have `path` open (the servers run on this machine).
fn open_count(path: &str) -> usize {
    let out = std::process::Command::new("lsof")
        .args(["-t", "--", path])
        .output()
        .expect("lsof");
    String::from_utf8_lossy(&out.stdout).lines().count()
}

/// Waits up to `secs` for `path` to have no open handle; returns the last count.
async fn settles_closed(path: &str, secs: u64) -> usize {
    let deadline = Instant::now() + Duration::from_secs(secs);
    loop {
        let n = open_count(path);
        if n == 0 || Instant::now() >= deadline {
            return n;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn pattern(len: usize, seed: u8) -> Vec<u8> {
    (0..len)
        .map(|i| (i as u8).wrapping_mul(31).wrapping_add(seed) ^ (i >> 11) as u8)
        .collect()
}

async fn check(variant: Variant) {
    let server = Sshd::start(variant);
    let d = SftpDriver::new(site(&server));
    d.connect().await.expect("SSH login");
    let work = server.work.to_string_lossy().into_owned();
    d.list_dir(&work).await.unwrap();
    let compat = d.compatibility_mode().is_some();
    assert_eq!(
        compat,
        variant == Variant::NoSubsystem,
        "{}",
        variant.name()
    );
    let label = variant.name();

    // One-off writes (editor save, sync, WebDAV) leave nothing open once they return.
    let f = format!("{work}/oneoff.bin");
    let data = pattern(3_000_000, 1);
    d.write_at(&f, 0, Bytes::copy_from_slice(&data[..1_000_000]))
        .await
        .unwrap();
    assert_eq!(open_count(&f), 0, "{label}: open after write_at at 0");
    d.write_at(&f, 1_000_000, Bytes::copy_from_slice(&data[1_000_000..]))
        .await
        .unwrap();
    assert_eq!(open_count(&f), 0, "{label}: open after write_at");
    // One-off reads too, and they always see the file as it is now.
    let page = d.read_range(&f, 0, 65_536).await.unwrap();
    assert_eq!(&page[..], &data[..65_536]);
    assert_eq!(open_count(&f), 0, "{label}: open after read_range");
    let replacement = pattern(3_000_000, 2);
    let staged = format!("{work}/oneoff.new");
    std::fs::write(&staged, &replacement).unwrap();
    std::fs::rename(&staged, &f).unwrap(); // a new file under the same name
    let page = d.read_range(&f, 65_536, 65_536).await.unwrap();
    assert_eq!(
        &page[..],
        &replacement[65_536..131_072],
        "{label}: stale bytes"
    );
    let mut in_place = std::fs::OpenOptions::new().write(true).open(&f).unwrap();
    in_place.seek(SeekFrom::Start(140_000)).unwrap();
    in_place.write_all(b"CHANGED").unwrap();
    drop(in_place);
    let page = d.read_range(&f, 131_072, 65_536).await.unwrap();
    assert_eq!(&page[140_000 - 131_072..][..7], b"CHANGED", "{label}");

    // A write stream keeps one file open until it is finished; then nothing is open.
    let g = format!("{work}/stream.bin");
    let w = StreamId::new();
    let mut at = 0u64;
    for part in data.chunks(700_000) {
        d.write_at_in(w, &g, at, Bytes::copy_from_slice(part))
            .await
            .unwrap();
        at += part.len() as u64;
        assert_eq!(open_count(&g), 1, "{label}: write stream reuses one file");
    }
    d.finish_stream(w).await.unwrap();
    assert_eq!(open_count(&g), 0, "{label}: open after finish_stream");
    assert_eq!(std::fs::read(&g).unwrap(), data, "{label}: streamed write");

    // A read stream: ranges of any size, a jump (opens again), the end of the file.
    let r = StreamId::new();
    let mut back = Vec::new();
    for len in [100_000u64, 900_000, 1_234_567, 2_000_000] {
        let got = d
            .read_range_in(r, &g, back.len() as u64, len)
            .await
            .unwrap();
        back.extend_from_slice(&got);
        assert_eq!(open_count(&g), 1, "{label}: read stream reuses one file");
    }
    assert_eq!(back, data, "{label}: streamed read");
    let mid = d.read_range_in(r, &g, 777_777, 10_000).await.unwrap();
    assert_eq!(&mid[..], &data[777_777..787_777]);
    d.finish_stream(r).await.unwrap();
    assert_eq!(
        open_count(&g),
        0,
        "{label}: open after a finished read stream"
    );

    // Abandoned streams and streams open when a command runs are closed in the
    // background.
    let r = StreamId::new();
    d.read_range_in(r, &g, 0, 300_000).await.unwrap();
    d.abandon_stream(r).await;
    assert_eq!(settles_closed(&g, 5).await, 0, "{label}: abandoned stream");
    let r = StreamId::new();
    d.read_range_in(r, &g, 0, 300_000).await.unwrap();
    d.execute_command("true").await.unwrap();
    assert_eq!(
        settles_closed(&g, 5).await,
        0,
        "{label}: stream after a command"
    );
    d.finish_stream(r).await.unwrap();

    // The transfer queue: after a completed upload and download, neither the
    // source nor the destination is open.
    let local = tempfile::tempdir().unwrap();
    let up_src = local.path().join("up.bin");
    std::fs::write(&up_src, &data).unwrap();
    let sessions: Arc<RwLock<HashMap<String, Arc<dyn VirtualFileSystem>>>> =
        Arc::new(RwLock::new(HashMap::from([
            (
                "local".to_string(),
                Arc::new(LocalFsDriver::new()) as Arc<dyn VirtualFileSystem>,
            ),
            (
                "ssh".to_string(),
                Arc::new(d.clone()) as Arc<dyn VirtualFileSystem>,
            ),
        ])));
    let q = TransferQueueManager::new(2);
    let wait = |id: String| {
        let q = &q;
        async move {
            loop {
                let t = q.get_task(&id).await.unwrap();
                if !matches!(
                    t.status,
                    TransferStatus::Queued | TransferStatus::InProgress
                ) {
                    return t;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }
    };
    let remote = format!("{work}/queued.bin");
    let id = q
        .enqueue(
            "local".into(),
            up_src.to_string_lossy().into(),
            "ssh".into(),
            remote.clone(),
            false,
            sessions.clone(),
        )
        .await;
    let t = wait(id).await;
    assert_eq!(
        t.status,
        TransferStatus::Completed,
        "{label}: {:?}",
        t.error
    );
    assert_eq!(open_count(&remote), 0, "{label}: open after an upload");
    assert_eq!(std::fs::read(&remote).unwrap(), data);
    let down = local.path().join("down.bin");
    let id = q
        .enqueue(
            "ssh".into(),
            remote.clone(),
            "local".into(),
            down.to_string_lossy().into(),
            false,
            sessions.clone(),
        )
        .await;
    let t = wait(id).await;
    assert_eq!(
        t.status,
        TransferStatus::Completed,
        "{label}: {:?}",
        t.error
    );
    assert_eq!(
        open_count(&remote),
        0,
        "{label}: source open after a download"
    );
    assert_eq!(std::fs::read(&down).unwrap(), data);
    assert!(Path::new(&remote).exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sftp_leaves_no_file_open() {
    if let Some(reason) = sshd::skip_reason() {
        eprintln!("skipped: {reason}");
        return;
    }
    if std::process::Command::new("lsof")
        .arg("-v")
        .output()
        .is_err()
    {
        eprintln!("skipped: lsof is not installed");
        return;
    }
    let config = tempfile::tempdir().unwrap();
    std::env::set_var("RUSTSCP_CONFIG_DIR", config.path());
    check(Variant::Good).await;
    check(Variant::NoSubsystem).await;
}
