use crate::schema::{
    ActionDefinition, ActionField, FieldType, LocalizedText, RiskLevel, Scope, SelectOption,
};

pub struct ActionCatalog;

impl ActionCatalog {
    pub fn builtin_actions() -> Vec<ActionDefinition> {
        vec![
            // 1. Tar Gzip Compression
            ActionDefinition {
                id: "tar-compress".to_string(),
                category: "compression".to_string(),
                icon: "file-archive".to_string(),
                risk_level: RiskLevel::Safe,
                scope: Scope::SelectedFiles,
                name: LocalizedText::new("Compress with Tar/Gzip", "Compactar com Tar/Gzip"),
                description: LocalizedText::new(
                    "Compress selected files into a .tar.gz archive",
                    "Compacta os arquivos selecionados em um arquivo .tar.gz",
                ),
                fields: vec![
                    ActionField {
                        id: "archive_name".to_string(),
                        field_type: FieldType::Text,
                        label: LocalizedText::new("Archive Name", "Nome do Arquivo"),
                        description: Some(LocalizedText::new(
                            "Output filename ending in .tar.gz",
                            "Nome do arquivo final terminando em .tar.gz",
                        )),
                        default_value: Some("${selected_first_name}.tar.gz".to_string()),
                        required: true,
                        validation_regex: Some(r"^[a-zA-Z0-9_\-\.]+\.tar\.gz$".to_string()),
                        risk_warning: false,
                    },
                    ActionField {
                        id: "compression_level".to_string(),
                        field_type: FieldType::Select {
                            options: vec![
                                SelectOption {
                                    value: "-1".to_string(),
                                    label: LocalizedText::new("Fast (1)", "Rápido (1)"),
                                    is_default: false,
                                },
                                SelectOption {
                                    value: "-6".to_string(),
                                    label: LocalizedText::new("Balanced (6)", "Equilibrado (6)"),
                                    is_default: true,
                                },
                                SelectOption {
                                    value: "-9".to_string(),
                                    label: LocalizedText::new("Maximum (9)", "Máximo (9)"),
                                    is_default: false,
                                },
                            ],
                        },
                        label: LocalizedText::new("Compression Level", "Nível de Compressão"),
                        description: None,
                        default_value: Some("-6".to_string()),
                        required: true,
                        validation_regex: None,
                        risk_warning: false,
                    },
                ],
                template: "tar -czf {{archive_name}} ${selected_files}".to_string(),
            },
            // 2. Extract Archive
            ActionDefinition {
                id: "tar-extract".to_string(),
                category: "compression".to_string(),
                icon: "folder-open".to_string(),
                risk_level: RiskLevel::Warning,
                scope: Scope::SelectedFiles,
                name: LocalizedText::new("Extract Archive", "Descompactar Arquivo"),
                description: LocalizedText::new(
                    "Extract tar.gz, tar.bz2, zip or tar archive",
                    "Extrai arquivos compactados no diretório atual ou selecionado",
                ),
                fields: vec![
                    ActionField {
                        id: "dest_dir".to_string(),
                        field_type: FieldType::Text,
                        label: LocalizedText::new("Extract to Directory", "Extrair para a Pasta"),
                        description: Some(LocalizedText::new("Leave . for current folder", "Deixe . para pasta atual")),
                        default_value: Some(".".to_string()),
                        required: true,
                        validation_regex: None,
                        risk_warning: false,
                    },
                ],
                template: "tar -xzf ${selected_files} -C {{dest_dir}}".to_string(),
            },
            // 3. Disk Usage
            ActionDefinition {
                id: "disk-usage".to_string(),
                category: "system".to_string(),
                icon: "hard-drive".to_string(),
                risk_level: RiskLevel::Safe,
                scope: Scope::Any,
                name: LocalizedText::new("Analyze Disk Usage", "Analisar Uso de Disco"),
                description: LocalizedText::new(
                    "Show largest folders and files in current directory",
                    "Exibe as maiores pastas e arquivos no diretório atual",
                ),
                fields: vec![
                    ActionField {
                        id: "limit".to_string(),
                        field_type: FieldType::Number {
                            min: Some(5.0),
                            max: Some(50.0),
                            step: Some(5.0),
                        },
                        label: LocalizedText::new("Number of items", "Número de itens"),
                        description: None,
                        default_value: Some("15".to_string()),
                        required: true,
                        validation_regex: None,
                        risk_warning: false,
                    },
                ],
                template: "du -sh * 2>/dev/null | sort -hr | head -n {{limit}}".to_string(),
            },
            // 4. Find Files
            ActionDefinition {
                id: "find-files".to_string(),
                category: "search".to_string(),
                icon: "search".to_string(),
                risk_level: RiskLevel::Safe,
                scope: Scope::Any,
                name: LocalizedText::new("Search Files (Find)", "Buscar Arquivos (Find)"),
                description: LocalizedText::new(
                    "Locate files by name, extension or pattern",
                    "Localiza arquivos por nome, extensão ou padrão",
                ),
                fields: vec![
                    ActionField {
                        id: "pattern".to_string(),
                        field_type: FieldType::Text,
                        label: LocalizedText::new("File Pattern (e.g. *.log, *.conf)", "Padrão de Nome (ex: *.log, *.conf)"),
                        description: None,
                        default_value: Some("*.*".to_string()),
                        required: true,
                        validation_regex: None,
                        risk_warning: false,
                    },
                ],
                template: "find . -name {{pattern}} -maxdepth 4".to_string(),
            },
            // 5. Visual Chmod
            ActionDefinition {
                id: "visual-chmod".to_string(),
                category: "permissions".to_string(),
                icon: "shield".to_string(),
                risk_level: RiskLevel::Warning,
                scope: Scope::SelectedFiles,
                name: LocalizedText::new("Change Permissions (chmod)", "Alterar Permissões (chmod)"),
                description: LocalizedText::new(
                    "Set numeric octal permissions on selected items",
                    "Aplica permissões numéricas nos itens selecionados",
                ),
                fields: vec![
                    ActionField {
                        id: "mode".to_string(),
                        field_type: FieldType::Select {
                            options: vec![
                                SelectOption {
                                    value: "0644".to_string(),
                                    label: LocalizedText::new("Standard File (0644 - rw-r--r--)", "Arquivo Padrão (0644 - rw-r--r--)"),
                                    is_default: true,
                                },
                                SelectOption {
                                    value: "0755".to_string(),
                                    label: LocalizedText::new("Script / Folder (0755 - rwxr-xr-x)", "Script / Pasta (0755 - rwxr-xr-x)"),
                                    is_default: false,
                                },
                                SelectOption {
                                    value: "0600".to_string(),
                                    label: LocalizedText::new("Private / Key (0600 - rw-------)", "Privado / Chave (0600 - rw-------)"),
                                    is_default: false,
                                },
                                SelectOption {
                                    value: "0777".to_string(),
                                    label: LocalizedText::new("Full Access (0777 - rwxrwxrwx)", "Acesso Total (0777 - rwxrwxrwx)"),
                                    is_default: false,
                                },
                            ],
                        },
                        label: LocalizedText::new("Permission Preset", "Predefinição de Permissão"),
                        description: None,
                        default_value: Some("0644".to_string()),
                        required: true,
                        validation_regex: None,
                        risk_warning: false,
                    },
                    ActionField {
                        id: "recursive".to_string(),
                        field_type: FieldType::Checkbox,
                        label: LocalizedText::new("Apply recursively to subfolders", "Aplicar recursivamente em subpastas"),
                        description: None,
                        default_value: Some("false".to_string()),
                        required: false,
                        validation_regex: None,
                        risk_warning: true,
                    },
                ],
                template: "chmod {% if recursive == 'true' %}-R {% endif %}{{mode}} ${selected_files}".to_string(),
            },
            // 6. Systemd Service Management
            ActionDefinition {
                id: "systemctl-manager".to_string(),
                category: "sysadmin".to_string(),
                icon: "cpu".to_string(),
                risk_level: RiskLevel::Warning,
                scope: Scope::Global,
                name: LocalizedText::new("Systemd Service Manager", "Gerenciador de Serviços (systemd)"),
                description: LocalizedText::new(
                    "Check status, restart or inspect systemd units",
                    "Verifica status, reinicia ou inspeciona serviços systemd",
                ),
                fields: vec![
                    ActionField {
                        id: "service".to_string(),
                        field_type: FieldType::Text,
                        label: LocalizedText::new("Service Name (e.g. nginx, docker, redis)", "Nome do Serviço (ex: nginx, docker, redis)"),
                        description: None,
                        default_value: Some("nginx".to_string()),
                        required: true,
                        validation_regex: Some(r"^[a-zA-Z0-9_\-\.]+$".to_string()),
                        risk_warning: false,
                    },
                    ActionField {
                        id: "subcommand".to_string(),
                        field_type: FieldType::Select {
                            options: vec![
                                SelectOption {
                                    value: "status".to_string(),
                                    label: LocalizedText::new("Check Status", "Verificar Status"),
                                    is_default: true,
                                },
                                SelectOption {
                                    value: "restart".to_string(),
                                    label: LocalizedText::new("Restart Service", "Reiniciar Serviço"),
                                    is_default: false,
                                },
                                SelectOption {
                                    value: "reload".to_string(),
                                    label: LocalizedText::new("Reload Config", "Recarregar Configuração"),
                                    is_default: false,
                                },
                            ],
                        },
                        label: LocalizedText::new("Action", "Ação"),
                        description: None,
                        default_value: Some("status".to_string()),
                        required: true,
                        validation_regex: None,
                        risk_warning: false,
                    },
                ],
                template: "systemctl {{subcommand}} {{service}}".to_string(),
            },
            // 7. Docker Containers
            ActionDefinition {
                id: "docker-ps".to_string(),
                category: "containers".to_string(),
                icon: "box".to_string(),
                risk_level: RiskLevel::Safe,
                scope: Scope::Global,
                name: LocalizedText::new("Docker Containers Status", "Status de Containers Docker"),
                description: LocalizedText::new(
                    "List running containers with status and ports",
                    "Lista os containers em execução com status e portas",
                ),
                fields: vec![],
                template: "docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'".to_string(),
            },
        ]
    }
}
