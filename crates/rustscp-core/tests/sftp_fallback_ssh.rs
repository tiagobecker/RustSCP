//! SFTP compatibility mode (`sftp-server` started as a command when the server refuses
//! or breaks the `sftp` subsystem) against real OpenSSH servers the tests start
//! themselves. Skipped unless `RUSTSCP_TEST_SPAWN_SSHD=1` and `/usr/sbin/sshd` exists:
//!
//! `RUSTSCP_TEST_SPAWN_SSHD=1 cargo test -p rustscp-core --test sftp_fallback_ssh -- --nocapture`
//!
//! Each test starts an unprivileged sshd (`support/sshd.rs`) whose `Subsystem` line is
//! absolute, relative, missing, or overridden by `ForceCommand internal-sftp`, checks the
//! server treats the stock `sftp` client that way, then drives `SftpDriver` through a
//! full round trip inside the server's own temp folder. The servers log in as the
//! current OS user; nothing outside that folder is touched.

#[path = "support/sshd.rs"]
mod sshd;

use bytes::Bytes;
use rustscp_core::{
    AuthMethod, ConnectionConfig, CoreError, CoreResult, FileEntry, FindFileQuery, Protocol,
    SftpDriver, SftpMode, VirtualFileSystem,
};
use sshd::{Sshd, Variant};
use std::future::Future;
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

/// One throwaway known_hosts (`RUSTSCP_CONFIG_DIR`) for the tests running at the same
/// time: the variable is process-wide, so it is only set while no test holds it.
fn isolated_config_dir() -> Arc<tempfile::TempDir> {
    static SHARED: Mutex<Weak<tempfile::TempDir>> = Mutex::new(Weak::new());
    let mut shared = SHARED.lock().unwrap();
    if let Some(dir) = shared.upgrade() {
        return dir;
    }
    let dir = Arc::new(tempfile::tempdir().unwrap());
    std::env::set_var("RUSTSCP_CONFIG_DIR", dir.path());
    *shared = Arc::downgrade(&dir);
    dir
}

/// Starts the test's server once the environment allows it, and checks it behaves as
/// designed for the stock client (so a failure below is the driver's, not the setup's).
fn start(variant: Variant) -> Option<(Arc<tempfile::TempDir>, Sshd)> {
    if let Some(reason) = sshd::skip_reason() {
        eprintln!("skipped: {reason}");
        return None;
    }
    let config_dir = isolated_config_dir();
    let server = Sshd::start(variant);
    server.assert_openssh_sftp_behaviour();
    Some((config_dir, server))
}

fn site(server: &Sshd, sftp_mode: SftpMode) -> ConnectionConfig {
    ConnectionConfig {
        id: format!("fallback-{}-{}", server.variant.name(), server.port),
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
        sftp_mode,
        group: None,
    }
}

async fn connect(server: &Sshd, sftp_mode: SftpMode) -> SftpDriver {
    let driver = SftpDriver::new(site(server, sftp_mode));
    driver.connect().await.expect("SSH login");
    driver
}

/// The first SFTP operation, where the driver picks native SFTP or compatibility mode,
/// and how long it took.
async fn first_listing(
    driver: &SftpDriver,
    server: &Sshd,
) -> (Duration, CoreResult<Vec<FileEntry>>) {
    let started = Instant::now();
    let listing = within(90, "the first listing", driver.list_dir(&work(server))).await;
    (started.elapsed(), listing)
}

fn work(server: &Sshd) -> String {
    server.work.to_string_lossy().into_owned()
}

/// How many sshd log lines contain `needle` (the stock-client check logs some too).
fn log_count(server: &Sshd, needle: &str) -> usize {
    server
        .log_text()
        .lines()
        .filter(|l| l.contains(needle))
        .count()
}

/// Fails the test instead of hanging when an operation never returns.
async fn within<T>(secs: u64, what: &str, fut: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(secs), fut)
        .await
        .unwrap_or_else(|_| panic!("{what} did not finish within {secs} s"))
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

/// Byte equality that reports where buffers differ instead of printing megabytes.
fn assert_same(what: &str, got: &[u8], want: &[u8]) {
    if got != want {
        let at = got.iter().zip(want).position(|(a, b)| a != b);
        panic!(
            "{what}: got {} bytes, expected {}; first difference at {at:?}",
            got.len(),
            want.len()
        );
    }
}

/// Every file operation the app uses, inside `<work>/<label>`, then removes it all.
async fn round_trip(driver: &SftpDriver, server: &Sshd, label: &str) {
    let base = format!("{}/{label}", work(server));
    let deep = format!("{base}/a/b/c");
    driver.create_dir(&deep).await.unwrap();
    driver.create_dir(&deep).await.unwrap(); // already there: fine
    assert!(driver.metadata(&deep).await.unwrap().is_dir());

    // Whole-file write and read, 3 MiB (many SFTP packets).
    let data = pseudo_random(3 << 20, 1);
    let file = format!("{deep}/data.bin");
    driver
        .write_file(&file, Bytes::from(data.clone()))
        .await
        .unwrap();
    let meta = driver.metadata(&file).await.unwrap();
    assert!(meta.is_file());
    assert_eq!(meta.size, data.len() as u64);
    assert_same("read_file", &driver.read_file(&file).await.unwrap(), &data);

    // Ranges at odd offsets, and one that runs past the end.
    let (offset, length) = (1_234_567usize, 777_777usize);
    let range = driver
        .read_range(&file, offset as u64, length as u64)
        .await
        .unwrap();
    assert_same("read_range", &range, &data[offset..offset + length]);
    let tail = driver
        .read_range(&file, data.len() as u64 - 10, 100)
        .await
        .unwrap();
    assert_same("read_range at the end", &tail, &data[data.len() - 10..]);

    // Positional writes: offset 0 creates, a later offset continues, 0 again starts over.
    assert!(driver.supports_write_at());
    let chunks = format!("{deep}/chunks.bin");
    let split = 1_000_003;
    driver
        .write_at(&chunks, 0, Bytes::copy_from_slice(&data[..split]))
        .await
        .unwrap();
    driver
        .write_at(
            &chunks,
            split as u64,
            Bytes::copy_from_slice(&data[split..]),
        )
        .await
        .unwrap();
    assert_same("write_at", &driver.read_file(&chunks).await.unwrap(), &data);
    driver
        .write_at(&chunks, 0, Bytes::from_static(b"again"))
        .await
        .unwrap();
    assert_same(
        "write_at at 0 truncates",
        &driver.read_file(&chunks).await.unwrap(),
        b"again",
    );

    // SFTP status codes reach the driver: "no such file" is NotFound, and makes a
    // write create the missing folders on the way.
    let missing = format!("{base}/missing.bin");
    let err = driver.metadata(&missing).await.unwrap_err();
    assert!(matches!(err, CoreError::NotFound(_)), "{err:?}");
    let err = driver.read_file(&missing).await.unwrap_err();
    assert!(matches!(err, CoreError::NotFound(_)), "{err:?}");
    let nested = format!("{base}/new/parent/x.txt");
    driver
        .write_file(&nested, Bytes::from_static(b"x"))
        .await
        .unwrap();
    assert_same(
        "write_file into new folders",
        &driver.read_file(&nested).await.unwrap(),
        b"x",
    );

    // Rename, then the listing shows the new name with its full path.
    let renamed = format!("{deep}/renamed.bin");
    driver.rename(&file, &renamed).await.unwrap();
    let listing = driver.list_dir(&deep).await.unwrap();
    let names: Vec<&str> = listing.iter().map(|e| e.name.as_str()).collect();
    assert!(
        names.contains(&"renamed.bin") && !names.contains(&"data.bin"),
        "{names:?}"
    );
    let entry = listing.iter().find(|e| e.name == "renamed.bin").unwrap();
    assert_eq!(entry.path, renamed);
    assert_eq!(entry.size, data.len() as u64);

    driver.set_permissions(&renamed, 0o640).await.unwrap();
    assert_eq!(
        driver.metadata(&renamed).await.unwrap().permissions.mode & 0o777,
        0o640
    );
    assert!(driver.exists(&renamed).await.unwrap());
    assert!(!driver.exists(&file).await.unwrap());

    // GNU du reports bytes; BSD/macOS du only disk usage in KiB; no shell walks over SFTP.
    let expected = data.len() as u64 + 5 + 1;
    let size = driver.calculate_size(&base).await.unwrap();
    assert!(
        size >= expected && size < expected + 256 * 1024,
        "calculate_size: {size}, expected about {expected}"
    );

    let found = driver
        .find_files(&FindFileQuery {
            base_path: base.clone(),
            mask: "*.bin".into(),
            contains_text: None,
            case_sensitive: false,
            max_depth: None,
            max_results: 10,
        })
        .await
        .unwrap();
    let mut found: Vec<&str> = found.iter().map(|m| m.entry.path.as_str()).collect();
    found.sort_unstable();
    assert_eq!(found, [chunks.as_str(), renamed.as_str()]);

    let info = driver.get_filesystem_info(&base).await.unwrap();
    assert!(info.host_key_fingerprint_sha256.is_some(), "{info:?}");
    let home = driver.get_default_path().await.unwrap();
    assert!(home.starts_with('/'), "{home}");

    driver.remove_file(&chunks).await.unwrap();
    assert!(!driver.exists(&chunks).await.unwrap());
    let empty = format!("{base}/empty");
    driver.create_dir(&empty).await.unwrap();
    driver.remove_dir(&empty, false).await.unwrap();
    assert!(!driver.exists(&empty).await.unwrap());

    driver.remove_dir(&base, true).await.unwrap();
    assert!(!driver.exists(&base).await.unwrap());
}

/// Several transfers and listings at once on one session: 4 reads of an 8 MiB file,
/// 4 ranged reads and 4 listings, all checked.
async fn concurrent_transfers(driver: &SftpDriver, server: &Sshd, label: &str) {
    let base = format!("{}/{label}", work(server));
    let big = Arc::new(pseudo_random(8 << 20, 2));
    let path = format!("{base}/big.bin");
    driver
        .write_file(&path, Bytes::copy_from_slice(&big))
        .await
        .unwrap();

    let mut tasks = tokio::task::JoinSet::new();
    for i in 0..4usize {
        let (d, p, b) = (driver.clone(), path.clone(), big.clone());
        tasks.spawn(async move {
            let got = d.read_file(&p).await.unwrap();
            assert_same(&format!("concurrent read_file #{i}"), &got, &b);
        });
        let (d, p, b) = (driver.clone(), path.clone(), big.clone());
        tasks.spawn(async move {
            let offset = i * 2 * 1024 * 1024 + 12_345;
            let got = d.read_range(&p, offset as u64, 1_000_000).await.unwrap();
            assert_same(
                &format!("concurrent read_range #{i}"),
                &got,
                &b[offset..offset + 1_000_000],
            );
        });
        let (d, dir) = (driver.clone(), base.clone());
        tasks.spawn(async move {
            let listing = d.list_dir(&dir).await.unwrap();
            assert!(
                listing.iter().any(|e| e.name == "big.bin"),
                "concurrent list_dir #{i}: {listing:?}"
            );
        });
    }
    while let Some(done) = tasks.join_next().await {
        done.unwrap(); // re-raises a task's failed assertion
    }
    driver.remove_dir(&base, true).await.unwrap();
}

async fn exercise(driver: &SftpDriver, server: &Sshd) {
    let name = server.variant.name();
    within(180, "the round trip", round_trip(driver, server, name)).await;
    within(
        180,
        "the concurrent transfers",
        concurrent_transfers(driver, server, &format!("{name}-concurrent")),
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn absolute_subsystem_stays_native() {
    let Some((_config_dir, server)) = start(Variant::Good) else {
        return;
    };
    let driver = connect(&server, SftpMode::Auto).await;
    let (took, listing) = first_listing(&driver, &server).await;
    listing.expect("list over the SFTP subsystem");
    eprintln!("good: first listing in {took:?}");
    assert_eq!(driver.compatibility_mode(), None);

    exercise(&driver, &server).await;
    assert_eq!(driver.compatibility_mode(), None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn relative_subsystem_falls_back_to_exec() {
    let Some((_config_dir, server)) = start(Variant::Relative) else {
        return;
    };
    let asked = log_count(&server, "subsystem: exec() sftp-server");
    let driver = connect(&server, SftpMode::Auto).await;
    let (took, listing) = first_listing(&driver, &server).await;
    let mode = driver.compatibility_mode();
    // The subsystem is accepted, then its channel closes without an SFTP reply: libssh2
    // gives up only at its start timeout, so this first operation is the slow one.
    eprintln!("relative: first listing in {took:?}, compatibility mode {mode:?}");
    listing.expect("list in compatibility mode");
    assert!(
        mode.as_deref().is_some_and(|p| p.contains("sftp-server")),
        "{mode:?}"
    );
    if !(Duration::from_secs(10)..=Duration::from_secs(25)).contains(&took) {
        eprintln!("relative: note, expected roughly 10-25 s for the first listing");
    }
    assert!(
        log_count(&server, "subsystem: exec() sftp-server") > asked,
        "the driver should ask for the subsystem first"
    );

    // A second session to the same site in this process remembers the outcome.
    let again = connect(&server, SftpMode::Auto).await;
    let (took_again, listing) = first_listing(&again, &server).await;
    listing.expect("list in compatibility mode, second session");
    eprintln!("relative: second session's first listing in {took_again:?}");
    assert!(took_again < Duration::from_secs(3), "{took_again:?}");
    assert_eq!(again.compatibility_mode(), mode);
    drop(again);

    exercise(&driver, &server).await;
    assert_eq!(driver.compatibility_mode(), mode);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn missing_subsystem_falls_back_quickly() {
    let Some((_config_dir, server)) = start(Variant::NoSubsystem) else {
        return;
    };
    let refused = log_count(&server, "subsystem not found");
    let driver = connect(&server, SftpMode::Auto).await;
    let (took, listing) = first_listing(&driver, &server).await;
    let mode = driver.compatibility_mode();
    eprintln!("none: first listing in {took:?}, compatibility mode {mode:?}");
    listing.expect("list in compatibility mode");
    assert!(
        mode.as_deref().is_some_and(|p| p.contains("sftp-server")),
        "{mode:?}"
    );
    // A refused subsystem request is answered at once: no timeout to wait for.
    assert!(took < Duration::from_secs(3), "{took:?}");
    assert!(log_count(&server, "subsystem not found") > refused);

    exercise(&driver, &server).await;
    assert_eq!(driver.compatibility_mode(), mode);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn subsystem_only_points_at_the_server_config() {
    let Some((_config_dir, server)) = start(Variant::NoSubsystem) else {
        return;
    };
    let driver = connect(&server, SftpMode::SubsystemOnly).await;
    let (took, listing) = first_listing(&driver, &server).await;
    let err = listing.expect_err("SubsystemOnly must not fall back");
    eprintln!("subsystem_only: failed in {took:?}: {err}");
    assert!(
        err.to_string().contains("Subsystem"),
        "the error should name the sshd_config Subsystem line: {err}"
    );
    assert!(took < Duration::from_secs(15), "{took:?}");
    assert_eq!(driver.compatibility_mode(), None);

    // Later operations fail the same way, at once, without logging in again,
    // and still never start sftp-server.
    // The dedicated shell connection logs in in the background: let it finish.
    let _ = within(15, "shell connection", driver.execute_command("true")).await;
    let logins = log_count(&server, "Accepted publickey");
    let probe = format!("{}/nothing.txt", work(&server));
    assert!(driver.read_file(&probe).await.is_err());
    assert!(driver
        .write_file(&probe, Bytes::from_static(b"x"))
        .await
        .is_err());
    assert_eq!(driver.compatibility_mode(), None);
    assert!(!server.work.join("nothing.txt").exists());
    assert_eq!(log_count(&server, "Accepted publickey"), logins);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn compatibility_mode_recovers_when_sftp_server_dies() {
    let Some((_config_dir, server)) = start(Variant::NoSubsystem) else {
        return;
    };
    let driver = connect(&server, SftpMode::Auto).await;
    let (_, listing) = first_listing(&driver, &server).await;
    listing.expect("list in compatibility mode");
    let mode = driver.compatibility_mode();
    assert!(mode.is_some());
    // The dedicated shell connection logs in in the background: let it finish.
    let _ = within(15, "shell connection", driver.execute_command("true")).await;
    let logins = log_count(&server, "Accepted publickey");

    assert!(server.kill_sftp_servers() > 0, "no sftp-server to kill");
    // The operation that finds the channel dead reports a connection problem,
    // never "not found"; the next one starts sftp-server again.
    let dir = work(&server);
    if let Err(e) = within(15, "list after the kill", driver.list_dir(&dir)).await {
        assert!(!matches!(e, CoreError::NotFound(_)), "{e}");
    }
    within(15, "list after the restart", driver.list_dir(&dir))
        .await
        .expect("compatibility mode restarted");
    assert_eq!(driver.compatibility_mode(), mode);
    // The SSH connection itself was fine: no new login.
    assert_eq!(log_count(&server, "Accepted publickey"), logins);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn forced_internal_sftp_stays_native() {
    let Some((_config_dir, server)) = start(Variant::ForceCommand) else {
        return;
    };
    let forced = log_count(&server, "forced-command (config) 'internal-sftp'");
    let driver = connect(&server, SftpMode::Auto).await;
    let (took, listing) = first_listing(&driver, &server).await;
    listing.expect("list over internal-sftp");
    eprintln!("forcecommand: first listing in {took:?}");
    // internal-sftp answers the subsystem request even though the line is relative.
    assert_eq!(driver.compatibility_mode(), None);
    assert!(log_count(&server, "forced-command (config) 'internal-sftp'") > forced);

    exercise(&driver, &server).await;
    assert_eq!(driver.compatibility_mode(), None);
}
