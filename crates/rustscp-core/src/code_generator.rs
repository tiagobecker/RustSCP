use crate::types::{AuthMethod, ConnectionConfig, Protocol};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodeTargetLanguage {
    #[serde(alias = "session_url")]
    WinScpUrl,
    #[serde(alias = "batch_script")]
    WinScpScript,
    Curl,
    Python,
    BashRsync,
    DotNetCSharp,
}

/// Environment variable the generated code reads the password (or S3 secret) from.
/// Generated code never contains a stored password or secret.
pub const PASSWORD_ENV_VAR: &str = "RUSTSCP_PASSWORD";
/// Environment variable for the private-key passphrase.
pub const PASSPHRASE_ENV_VAR: &str = "RUSTSCP_KEY_PASSPHRASE";
/// Placeholder for the server's host-key fingerprint (generated code never trusts any key).
pub const HOSTKEY_PLACEHOLDER: &str = "PASTE_SERVER_HOST_KEY_FINGERPRINT";

/// Quotes a value for a POSIX shell: `'...'` with every `'` encoded as `'\''`
/// (delegates to the crate-wide [`crate::shell::sh_quote`]).
pub fn posix_shell_quote(value: &str) -> String {
    crate::shell::sh_quote(value)
}

/// Python string literal (single quotes, with `\`, `'` and control characters escaped).
fn py_str(value: &str) -> String {
    let mut out = String::from("'");
    for ch in value.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '\'' => out.push_str("\\'"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 || c as u32 == 0x7f => {
                out.push_str(&format!("\\x{:02x}", c as u32))
            }
            c => out.push(c),
        }
    }
    out.push('\'');
    out
}

/// C# verbatim string literal (`@"..."` with `"` doubled).
fn cs_str(value: &str) -> String {
    format!("@\"{}\"", value.replace('"', "\"\""))
}

/// WinSCP script argument: double quotes with `"` doubled.
fn winscp_arg(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

/// Percent-encodes everything except RFC 3986 unreserved characters (and `/` when
/// `keep_slash`), so user names and paths cannot change the meaning of a URL.
fn percent_encode(value: &str, keep_slash: bool) -> String {
    let mut out = String::with_capacity(value.len());
    for b in value.bytes() {
        let keep = b.is_ascii_alphanumeric()
            || matches!(b, b'-' | b'.' | b'_' | b'~')
            || (keep_slash && b == b'/');
        if keep {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn default_port(protocol: &Protocol) -> u16 {
    match protocol {
        Protocol::Ftp => 21,
        Protocol::S3 | Protocol::WebDav => 443,
        Protocol::Sftp | Protocol::Local => 22,
    }
}

/// Remote path with a leading slash; home paths (`~`, `~/...`) are kept as they are.
fn normalize_remote_path(remote_path: &str) -> String {
    let p = remote_path.trim();
    if p.is_empty() {
        "/".to_string()
    } else if p.starts_with('/') || p == "~" || p.starts_with("~/") {
        p.to_string()
    } else {
        format!("/{p}")
    }
}

/// Path part of a URL: `~` paths become `/~/...` (the curl/WinSCP home convention).
fn url_path(remote: &str) -> String {
    if remote.starts_with('~') {
        format!("/{remote}")
    } else {
        remote.to_string()
    }
}

fn basename(path: &str) -> String {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty() && *s != "~")
        .unwrap_or("download")
        .to_string()
}

fn join_local(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        return name.to_string();
    }
    let sep = if dir.contains('\\') && !dir.contains('/') {
        '\\'
    } else {
        '/'
    };
    format!("{}{}{}", dir.trim_end_matches(['/', '\\']), sep, name)
}

pub struct CodeGenerator;

impl CodeGenerator {
    /// Generates automation code for a session.
    ///
    /// Stored passwords, S3 secrets and key passphrases are never written into the
    /// output: every format reads them from `RUSTSCP_PASSWORD` /
    /// `RUSTSCP_KEY_PASSPHRASE` at run time. Host keys are verified (no "accept any key").
    /// User names and paths are escaped for each target language.
    pub fn generate(
        config: &ConnectionConfig,
        target_lang: CodeTargetLanguage,
        remote_path: &str,
        local_path: &str,
    ) -> String {
        let scheme = match config.protocol {
            Protocol::Local => "sftp".to_string(),
            ref p => p.to_string(),
        };
        let user = if config.username.is_empty() {
            "user"
        } else {
            &config.username
        };
        let host = if config.host.is_empty() {
            "example.com"
        } else {
            &config.host
        };
        let port = if config.port == 0 {
            default_port(&config.protocol)
        } else {
            config.port
        };
        let key_path = match &config.auth {
            AuthMethod::PrivateKey { path, .. } if !path.is_empty() => Some(path.as_str()),
            _ => None,
        };
        let has_passphrase = matches!(
            &config.auth,
            AuthMethod::PrivateKey { passphrase: Some(p), .. } if !p.is_empty()
        );
        let remote = normalize_remote_path(remote_path);
        let encoded_user = percent_encode(user, false);
        let encoded_path = percent_encode(&url_path(&remote), true);

        match target_lang {
            CodeTargetLanguage::WinScpUrl => {
                format!("{scheme}://{encoded_user}@{host}:{port}{encoded_path}")
            }

            CodeTargetLanguage::WinScpScript => {
                let auth = match key_path {
                    Some(k) => {
                        let mut s = format!(" -privatekey={}", winscp_arg(k));
                        if has_passphrase {
                            s.push_str(&format!(" -passphrase=\"%{PASSPHRASE_ENV_VAR}%\""));
                        }
                        s
                    }
                    None => format!(" -password=\"%{PASSWORD_ENV_VAR}%\""),
                };
                let hostkey = if matches!(config.protocol, Protocol::Sftp | Protocol::Local) {
                    format!(" -hostkey={}", winscp_arg(HOSTKEY_PLACEHOLDER))
                } else {
                    String::new()
                };
                format!(
                    "# RustSCP Batch Automation Script (WinSCP syntax)\n\
                    # Set %{PASSWORD_ENV_VAR}% (or %{PASSPHRASE_ENV_VAR}%) in the environment;\n\
                    # no password is stored in this script.\n\
                    # Replace {HOSTKEY_PLACEHOLDER} with the server's host key fingerprint\n\
                    # (e.g. \"ssh-ed25519 255 SHA256:...\").\n\
                    open {scheme}://{encoded_user}@{host}:{port}/{auth}{hostkey}\n\
                    cd {}\n\
                    lcd {}\n\
                    get -neweronly *\n\
                    exit\n",
                    winscp_arg(&remote),
                    winscp_arg(local_path)
                )
            }

            CodeTargetLanguage::Curl => {
                let output = join_local(local_path, &basename(&remote));
                let (url, extra) = match config.protocol {
                    Protocol::S3 => {
                        let region = host
                            .strip_prefix("s3.")
                            .and_then(|h| h.split('.').next())
                            .filter(|r| !r.is_empty() && *r != "amazonaws")
                            .unwrap_or("us-east-1");
                        (
                            format!("https://{host}:{port}{encoded_path}"),
                            format!(
                                " --aws-sigv4 {}",
                                posix_shell_quote(&format!("aws:amz:{region}:s3"))
                            ),
                        )
                    }
                    Protocol::WebDav => (
                        format!("https://{host}:{port}{encoded_path}"),
                        String::new(),
                    ),
                    _ => (
                        format!("{scheme}://{host}:{port}{encoded_path}"),
                        String::new(),
                    ),
                };
                let auth = match key_path {
                    Some(k) => {
                        let mut s = format!(
                            " --user {} --key {}",
                            posix_shell_quote(user),
                            posix_shell_quote(k)
                        );
                        if has_passphrase {
                            s.push_str(&format!(" --pass \"${PASSPHRASE_ENV_VAR}\""));
                        }
                        s
                    }
                    None => format!(
                        " --user {}:\"${PASSWORD_ENV_VAR}\"",
                        posix_shell_quote(user)
                    ),
                };
                format!(
                    "# The password is read from ${PASSWORD_ENV_VAR}; it is not stored here.\n\
                    curl{auth}{extra} {} -o {}\n",
                    posix_shell_quote(&url),
                    posix_shell_quote(&output)
                )
            }

            CodeTargetLanguage::Python => {
                let auth = match key_path {
                    Some(k) => format!(
                        "key_filename={}, passphrase=os.environ.get({})",
                        py_str(k),
                        py_str(PASSPHRASE_ENV_VAR)
                    ),
                    None => format!("password=os.environ[{}]", py_str(PASSWORD_ENV_VAR)),
                };
                let note = if matches!(config.protocol, Protocol::Sftp | Protocol::Local) {
                    ""
                } else {
                    "# Note: this snippet uses SFTP (paramiko); adapt it for other protocols.\n"
                };
                format!(
                    "# Python Automation Script\n\
                    # The password is read from the {PASSWORD_ENV_VAR} environment variable.\n\
                    {note}\
                    import os\n\
                    import paramiko\n\n\
                    ssh = paramiko.SSHClient()\n\
                    # Only connect to servers already listed in ~/.ssh/known_hosts.\n\
                    ssh.load_system_host_keys()\n\
                    ssh.set_missing_host_key_policy(paramiko.RejectPolicy())\n\
                    ssh.connect({}, port={port}, username={}, {auth})\n\
                    sftp = ssh.open_sftp()\n\
                    sftp.get({}, {})\n\
                    sftp.close()\n\
                    ssh.close()\n",
                    py_str(host),
                    py_str(user),
                    py_str(&remote),
                    py_str(&join_local(local_path, &basename(&remote)))
                )
            }

            CodeTargetLanguage::BashRsync => {
                let mut ssh_cmd = format!("ssh -p {port}");
                if let Some(k) = key_path {
                    ssh_cmd.push_str(&format!(" -i {}", posix_shell_quote(k)));
                }
                let local_dir = if local_path.is_empty() {
                    "./".to_string()
                } else {
                    format!("{}/", local_path.trim_end_matches('/'))
                };
                // -s (--protect-args) keeps the remote shell from splitting the path.
                format!(
                    "# Uses your SSH keys/agent; no password is stored here.\n\
                    rsync -avzs -e {} {} {}\n",
                    posix_shell_quote(&ssh_cmd),
                    posix_shell_quote(&local_dir),
                    posix_shell_quote(&format!("{user}@{host}:{remote}"))
                )
            }

            CodeTargetLanguage::DotNetCSharp => {
                let client = match key_path {
                    Some(k) => format!(
                        "new SftpClient({}, {port}, {}, new PrivateKeyFile({}, Environment.GetEnvironmentVariable(\"{PASSPHRASE_ENV_VAR}\")))",
                        cs_str(host),
                        cs_str(user),
                        cs_str(k)
                    ),
                    None => format!(
                        "new SftpClient({}, {port}, {}, Environment.GetEnvironmentVariable(\"{PASSWORD_ENV_VAR}\"))",
                        cs_str(host),
                        cs_str(user)
                    ),
                };
                format!(
                    "// C# .NET Automation (SSH.NET)\n\
                    // The password is read from the {PASSWORD_ENV_VAR} environment variable.\n\
                    using System;\n\
                    using Renci.SshNet;\n\n\
                    using (var client = {client})\n\
                    {{\n\
                        // Trust only the expected server key (SHA-256 fingerprint).\n\
                        client.HostKeyReceived += (sender, e) =>\n\
                            e.CanTrust = e.FingerPrintSHA256 == \"{HOSTKEY_PLACEHOLDER}\";\n\
                        client.Connect();\n\
                        using (var fileStream = System.IO.File.OpenWrite({}))\n\
                        {{\n\
                            client.DownloadFile({}, fileStream);\n\
                        }}\n\
                        client.Disconnect();\n\
                    }}\n",
                    cs_str(&join_local(local_path, &basename(&remote))),
                    cs_str(&remote)
                )
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "S3cr3t'\"$;@:/#pass";

    fn config(auth: AuthMethod, protocol: Protocol) -> ConnectionConfig {
        ConnectionConfig {
            id: "site".into(),
            name: "Site".into(),
            protocol,
            host: "srv.example.com".into(),
            port: 0,
            username: "deploy@corp".into(),
            auth,
            remote_root: "/".into(),
        }
    }

    const ALL: [CodeTargetLanguage; 6] = [
        CodeTargetLanguage::WinScpUrl,
        CodeTargetLanguage::WinScpScript,
        CodeTargetLanguage::Curl,
        CodeTargetLanguage::Python,
        CodeTargetLanguage::BashRsync,
        CodeTargetLanguage::DotNetCSharp,
    ];

    #[test]
    fn test_no_format_embeds_stored_secrets() {
        let configs = [
            config(AuthMethod::Password(SECRET.into()), Protocol::Sftp),
            config(AuthMethod::Password(SECRET.into()), Protocol::Ftp),
            config(AuthMethod::Password(SECRET.into()), Protocol::S3),
            config(
                AuthMethod::PrivateKey {
                    path: "/home/u/.ssh/id_ed25519".into(),
                    passphrase: Some(SECRET.into()),
                },
                Protocol::Sftp,
            ),
        ];
        for cfg in &configs {
            for lang in ALL {
                let out = CodeGenerator::generate(cfg, lang, "/var/www/a b.txt", "/tmp/out");
                assert!(!out.contains(SECRET), "{lang:?} leaked the secret:\n{out}");
                assert!(
                    !out.contains("S3cr3t"),
                    "{lang:?} leaked part of the secret"
                );
                assert!(!out.contains("AutoAddPolicy"));
                assert!(!out.contains("-hostkey=\"*\""));
            }
        }
    }

    #[test]
    fn test_home_paths_are_kept() {
        let cfg = config(AuthMethod::None, Protocol::Sftp);
        let url = CodeGenerator::generate(&cfg, CodeTargetLanguage::WinScpUrl, "~/site", "");
        assert!(url.ends_with(":22/~/site"), "{url}");
        let script = CodeGenerator::generate(&cfg, CodeTargetLanguage::WinScpScript, "~/site", "");
        assert!(script.contains("cd \"~/site\""), "{script}");
    }

    #[test]
    fn test_url_is_percent_encoded_and_uses_protocol_port() {
        let cfg = config(AuthMethod::Password(SECRET.into()), Protocol::Sftp);
        let url = CodeGenerator::generate(&cfg, CodeTargetLanguage::WinScpUrl, "var/www/a b#1", "");
        assert_eq!(
            url,
            "sftp://deploy%40corp@srv.example.com:22/var/www/a%20b%231"
        );

        let ftp = config(AuthMethod::None, Protocol::Ftp);
        let url = CodeGenerator::generate(&ftp, CodeTargetLanguage::WinScpUrl, "/", "");
        assert_eq!(url, "ftp://deploy%40corp@srv.example.com:21/");
    }

    #[test]
    fn test_shell_and_language_literals_are_escaped() {
        let cfg = config(AuthMethod::Password(SECRET.into()), Protocol::Sftp);
        let rsync = CodeGenerator::generate(
            &cfg,
            CodeTargetLanguage::BashRsync,
            "/srv/it's here",
            "/tmp/my dir",
        );
        assert!(rsync.contains("'/tmp/my dir/'"), "{rsync}");
        assert!(
            rsync.contains("'deploy@corp@srv.example.com:/srv/it'\\''s here'"),
            "{rsync}"
        );

        let curl = CodeGenerator::generate(&cfg, CodeTargetLanguage::Curl, "/a;b", "/tmp");
        assert!(
            curl.contains("--user 'deploy@corp':\"$RUSTSCP_PASSWORD\""),
            "{curl}"
        );
        assert!(curl.contains("'sftp://srv.example.com:22/a%3Bb'"), "{curl}");

        let py = CodeGenerator::generate(&cfg, CodeTargetLanguage::Python, "/it's", "/tmp");
        assert!(py.contains("'/it\\'s'"), "{py}");
        assert!(py.contains("os.environ['RUSTSCP_PASSWORD']"));
        assert!(py.contains("RejectPolicy"));

        let cs = CodeGenerator::generate(
            &cfg,
            CodeTargetLanguage::DotNetCSharp,
            "/say \"hi\"",
            "C:\\out",
        );
        assert!(cs.contains("@\"/say \"\"hi\"\"\""), "{cs}");
        assert!(cs.contains("@\"C:\\out\\say \"\"hi\"\"\""), "{cs}");
        assert!(cs.contains("GetEnvironmentVariable(\"RUSTSCP_PASSWORD\")"));

        let script =
            CodeGenerator::generate(&cfg, CodeTargetLanguage::WinScpScript, "/x \"y\"", "C:\\dl");
        assert!(script.contains("cd \"/x \"\"y\"\"\""), "{script}");
        assert!(script.contains("-password=\"%RUSTSCP_PASSWORD%\""));
    }
}
