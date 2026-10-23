/** 'ftps' is explicit FTP over TLS (AUTH TLS on the FTP port). */
export type Protocol = 'sftp' | 'scp' | 's3' | 'ftp' | 'ftps' | 'local' | 'webdav';

export type FileType = 'file' | 'directory' | 'symlink' | 'other';

export interface Permissions {
  mode: number;
  readonly: boolean;
  owner?: string;
  group?: string;
}

export interface FileEntry {
  name: string;
  path: string;
  file_type: FileType;
  size: number;
  modified_at?: string;
  created_at?: string;
  permissions: Permissions;
  is_hidden: boolean;
}

export interface AuthMethod {
  type: string;
  value: any;
}

export interface ConnectionConfig {
  id: string;
  name: string;
  protocol: Protocol;
  host: string;
  port: number;
  username: string;
  auth: AuthMethod;
  remote_root: string;
  /** FTPS only: SHA-256 fingerprint of a self-signed server certificate to trust. */
  tls_fingerprint?: string | null;
  /** Folder in the site list, '/'-separated (e.g. "Production/Web"). Missing or null: top level. */
  group?: string | null;
}

/** Result of `preview_winscp_ini`. `sites` carry the stored-secret marker instead of passwords. */
export interface WinScpImportResult {
  total_sessions: number;
  /** Sessions whose saved WinSCP password was recovered. */
  decrypted_passwords: number;
  /** Sessions that authenticate with a private key file. */
  key_auth_sessions: number;
  /** WinSCP folders, '/'-separated. */
  folders: string[];
  sites: ConnectionConfig[];
  /** Stored passwords that could not be recovered; those sites are imported without one. */
  undecrypted_passwords?: number;
  /** Key sites whose key is a PuTTY .ppk file (RustSCP reads these directly). */
  ppk_key_sessions?: number;
  /** Key sites whose key file does not exist on this computer. */
  missing_key_files?: number;
  /** WinSCP protects its passwords with a master password: no password was imported. */
  master_password_protected?: boolean;
  /** Entries left out (workspace entries, or sessions beyond the import limit). */
  skipped_sessions?: number;
}

export type SyncDirection = 'local_to_remote' | 'remote_to_local' | 'both';
export type SyncActionType = 'upload' | 'download' | 'delete_remote' | 'delete_local' | 'identical' | 'conflict';

export interface SyncItem {
  relative_path: string;
  action: SyncActionType;
  local_size?: number;
  remote_size?: number;
  local_modified?: string;
  remote_modified?: string;
}

export interface SyncOptions {
  direction: SyncDirection;
  mirror_delete: boolean;
  compare_by_size_only: boolean;
}

export type RiskLevel = 'safe' | 'warning' | 'dangerous';
export type Scope = 'global' | 'selected_files' | 'selected_dir' | 'any';

export interface LocalizedText {
  'en-US': string;
  'pt-BR': string;
}

export interface SelectOption {
  value: string;
  label: LocalizedText;
  is_default?: boolean;
}

export interface ActionField {
  id: string;
  kind: 'text' | 'number' | 'select' | 'checkbox' | 'path_picker';
  label: LocalizedText;
  description?: LocalizedText;
  default_value?: string;
  required: boolean;
  validation_regex?: string;
  risk_warning: boolean;
  options?: SelectOption[];
  min?: number;
  max?: number;
  step?: number;
}

export interface ActionDefinition {
  id: string;
  category: string;
  icon: string;
  risk_level: RiskLevel;
  scope: Scope;
  name: LocalizedText;
  description: LocalizedText;
  fields: ActionField[];
  template: string;
}

export interface AuditEvent {
  id: string;
  timestamp: string;
  agent_id: string;
  tool_name: string;
  connection_id: string;
  parameters_summary: string;
  status: string;
  diff?: string;
}

export interface McpStatusInfo {
  enabled: boolean;
  active_sessions_count: number;
  total_audit_events: number;
  /** True when this build ships an MCP transport agents can connect to. */
  transport_available?: boolean;
  /** True while that transport is accepting connections. */
  transport_running?: boolean;
  /** Command an agent uses to register the gateway (e.g. `claude mcp add …`), when there is one. */
  setup_command?: string | null;
  /** `mcpServers` JSON for clients configured with a file (Cursor, Claude Desktop, …). */
  setup_json?: string | null;
  /** Agents connected right now. */
  connected_agents?: number;
  /** Why the gateway could not start, when it could not. */
  gateway_error?: string | null;
  /** The user turned the gateway off (it stays off across restarts). */
  turned_off?: boolean;
  /** How agent shell commands are handled: 'off', 'ask', 'auto' or 'trusted'. */
  command_access?: CommandAccess;
}

/** How agent shell commands (`run_command`) are handled. */
export type CommandAccess = 'off' | 'ask' | 'auto' | 'trusted';

/** What an agent's pending request is about. */
export type ApprovalKind = 'write' | 'command';

/** An AI agent's file write or command waiting for Allow / Deny (`mcp-approval-request` event). */
export interface McpApprovalPrompt {
  id: string;
  /** 'write' (the default) or 'command'. */
  kind?: ApprovalKind;
  agent_id: string;
  tool_name: string;
  connection_id: string;
  connection_name: string;
  path: string;
  summary: string;
  new_size: number;
  new_sha256: string;
  /** Size of the file being replaced; null for a new file. */
  previous_size: number | null;
  /** Start of the new content when it is text. */
  preview: string | null;
  preview_truncated: boolean;
  /** The command line, for a 'command' request. */
  command?: string | null;
  /** How risky the command looks: 'safe', 'caution' or 'dangerous'. */
  risk?: string | null;
  /** Unix time (ms) at which the request is denied if nobody answers. */
  expires_at_ms: number;
}

export interface TransferItem {
  id: string;
  name: string;
  progress: number;
  speed: string;
  status: 'active' | 'completed' | 'paused';
}

export type QueueTransferStatus = 'queued' | 'in_progress' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface QueueTransferTask {
  id: string;
  name: string;
  source_session: string;
  source_path: string;
  dest_session: string;
  dest_path: string;
  is_move: boolean;
  total_bytes: number;
  transferred_bytes: number;
  status: QueueTransferStatus;
  speed_bps: number;
  error?: string;
}

export interface ClipboardState {
  action: 'copy' | 'cut';
  sourceSession: string;
  paths: string[];
}

export interface RemoteSystemInfo {
  os_name: string;
  distro_id: string;
  kernel: string;
  default_shell: string;
  package_manager: string;
  is_root: boolean;
  has_sudo: boolean;
  hostname: string;
  architecture: string;
}

export interface RemoteTrashItem {
  id: string;
  original_path: string;
  trash_path: string;
  filename: string;
  deletion_date: string;
  size: number;
  is_dir: boolean;
}

export interface RemoteTrashStatus {
  enabled: boolean;
  initialized: boolean;
  trash_dir: string;
  item_count: number;
  total_size_bytes: number;
}

export interface RemoteTrashResponse {
  status: RemoteTrashStatus;
  items: RemoteTrashItem[];
  message: string;
}

export interface MarketplaceTool {
  id: string;
  name: string;
  category: 'disk' | 'search' | 'compression' | 'monitor' | 'transfer' | 'utility';
  icon: string;
  description: {
    'pt-BR': string;
    'en-US': string;
  };
  checkCommand: string;
  isEssential: boolean;
}

export interface EditorTab {
  id: string;
  name: string;
  path: string;
  content: string;
  initialContent: string;
  isDirty: boolean;
  isRemote: boolean;
  sessionId: string;
  language: string;
  cursorLine: number;
  cursorCol: number;
}


/** One of the two Commander panes (Explorer mode shows the focused one). */
export type PaneId = 'left' | 'right';

/** Response of `get_vault_security_info`. `load_error`/`backup_path` are set when the vault could not be read at startup. */
export interface VaultSecurityInfo {
  is_encrypted: boolean;
  cipher: string;
  kdf: string;
  kdf_iterations: number;
  vault_path: string;
  site_count: number;
  has_custom_master_password: boolean;
  /** 'macos-keychain' (key_path names the Keychain item) or 'file' (key_path is the 0600 key file). */
  key_storage?: string;
  key_path?: string;
  export_kdf_iterations?: number;
  protection_note?: string;
  load_error?: string | null;
  backup_path?: string | null;
}
