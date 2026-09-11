use crate::types::{AuthMethod, ConnectionConfig};
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

pub struct CodeGenerator;

impl CodeGenerator {
    pub fn generate(
        config: &ConnectionConfig,
        target_lang: CodeTargetLanguage,
        remote_path: &str,
        local_path: &str,
    ) -> String {
        let proto = config.protocol.to_string();
        let user = if config.username.is_empty() {
            "user"
        } else {
            &config.username
        };
        let pass = match &config.auth {
            AuthMethod::Password(p) => p.as_str(),
            _ => "password",
        };
        let host = if config.host.is_empty() {
            "example.com"
        } else {
            &config.host
        };
        let port = if config.port == 0 { 22 } else { config.port };

        match target_lang {
            CodeTargetLanguage::WinScpUrl => {
                format!(
                    "{}://{}:{}@{}:{}{}",
                    proto, user, pass, host, port, remote_path
                )
            }

            CodeTargetLanguage::WinScpScript => {
                format!(
                    "# RustSCP Batch Automation Script\n\
                    open {}://{}:{}@{}:{}/ -hostkey=\"*\"\n\
                    cd {}\n\
                    lcd {}\n\
                    get -neweronly *\n\
                    exit\n",
                    proto, user, pass, host, port, remote_path, local_path
                )
            }

            CodeTargetLanguage::Curl => {
                format!(
                    "curl -u {}:{} {}://{}:{}{} -o filename",
                    user, pass, proto, host, port, remote_path
                )
            }

            CodeTargetLanguage::Python => {
                format!(
                    "# Python Automation Script\n\
                    import paramiko\n\n\
                    ssh = paramiko.SSHClient()\n\
                    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())\n\
                    ssh.connect('{}', port={}, username='{}', password='{}')\n\
                    sftp = ssh.open_sftp()\n\
                    sftp.get('{}', '{}')\n\
                    sftp.close()\n\
                    ssh.close()\n",
                    host, port, user, pass, remote_path, local_path
                )
            }

            CodeTargetLanguage::BashRsync => {
                format!(
                    "rsync -avz -e \"ssh -p {}\" {}/ {}@{}:{}",
                    port, local_path, user, host, remote_path
                )
            }

            CodeTargetLanguage::DotNetCSharp => {
                format!(
                    "// C# .NET Automation (SSH.NET)\n\
                    using Renci.SshNet;\n\n\
                    using (var client = new SftpClient(\"{}\", {}, \"{}\", \"{}\"))\n\
                    {{\n\
                        client.Connect();\n\
                        using (var fileStream = System.IO.File.OpenWrite(\"{}\"))\n\
                        {{\n\
                            client.DownloadFile(\"{}\", fileStream);\n\
                        }}\n\
                        client.Disconnect();\n\
                    }}\n",
                    host, port, user, pass, local_path, remote_path
                )
            }
        }
    }
}
