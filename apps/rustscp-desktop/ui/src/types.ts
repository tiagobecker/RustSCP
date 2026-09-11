export type Protocol = 'sftp' | 'scp' | 's3' | 'ftp' | 'local' | 'webdav';

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

