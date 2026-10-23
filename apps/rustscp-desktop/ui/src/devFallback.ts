/**
 * Mock responses used when the UI runs in a plain browser (vite dev / preview) instead of Tauri.
 * Loaded lazily by App's invoke helper, so it never ships in the main bundle and is never fetched
 * inside the desktop app. Contains no real hosts or credentials.
 */
import type { FileEntry } from './types.ts';

const DEMO_HOME = '/home/demo';

/** The AI gateway switch in preview mode. */
let previewGatewayOff = false;
let previewCommandAccess = 'ask';

export function getFallbackData<T>(cmd: string, args?: any): T {
  if (cmd === 'list_directory') {
    const p: string = args?.path || '/';
    const parent = p === '/' ? '/' : p.split('/').slice(0, -1).join('/') || '/';
    const join = (name: string) => `${p.replace(/\/$/, '')}/${name}`;
    const now = new Date().toISOString();
    const fallbackFiles: FileEntry[] = [
      { name: '..', path: parent, file_type: 'directory', size: 0, permissions: { mode: 0o755, readonly: false }, is_hidden: false },
      { name: 'public', path: join('public'), file_type: 'directory', size: 0, modified_at: now, permissions: { mode: 0o755, readonly: false }, is_hidden: false },
      { name: 'nginx.conf', path: join('nginx.conf'), file_type: 'file', size: 2450, modified_at: now, permissions: { mode: 0o644, readonly: false }, is_hidden: false },
      { name: 'app.log', path: join('app.log'), file_type: 'file', size: 89120, modified_at: now, permissions: { mode: 0o644, readonly: false }, is_hidden: false },
      { name: 'backup_database.sql.gz', path: join('backup_database.sql.gz'), file_type: 'file', size: 15420000, modified_at: now, permissions: { mode: 0o600, readonly: false }, is_hidden: false },
    ];
    return fallbackFiles as unknown as T;
  }

  if (cmd === 'get_saved_sites') {
    return [
      {
        id: 'local',
        name: 'Local Machine',
        protocol: 'local',
        host: 'localhost',
        port: 0,
        username: 'user',
        auth: { type: 'None', value: null },
        remote_root: '/',
      },
      {
        id: 'demo-sftp',
        name: 'Demo server',
        protocol: 'sftp',
        host: 'sftp.example.com',
        port: 22,
        username: 'demo',
        auth: { type: 'Password', value: '' },
        remote_root: '/var/www',
      },
    ] as unknown as T;
  }

  if (cmd === 'connect_session') {
    return (args?.config?.id || `demo-${Date.now()}`) as unknown as T;
  }

  if (cmd === 'read_file_content') {
    return `# Example configuration\nserver {\n    listen 80;\n    server_name example.com;\n    root /var/www/html;\n    index index.html;\n}\n` as unknown as T;
  }

  if (cmd === 'execute_remote_command') {
    return {
      exit_code: 0,
      stdout: `Linux demo-host 6.5.0-x86_64 #1 SMP PREEMPT_DYNAMIC\n`,
      stderr: '',
    } as unknown as T;
  }

  if (cmd === 'compare_and_sync_plan') {
    return [{ relative_path: 'index.html', action: 'upload', local_size: 4096, remote_size: 3800 }] as unknown as T;
  }

  if (cmd === 'calculate_checksum') {
    return { algorithm: 'SHA-256', hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' } as unknown as T;
  }

  if (cmd === 'calculate_directory_size') {
    return (1024 * 1024 * 50) as unknown as T;
  }

  if (cmd === 'get_session_default_path') {
    return DEMO_HOME as unknown as T;
  }

  if (cmd === 'manage_remote_trash') {
    return {
      status: { enabled: true, initialized: true, trash_dir: '~/.local/share/Trash', item_count: 0, total_size_bytes: 0 },
      items: [],
      message: '',
    } as unknown as T;
  }

  if (
    cmd === 'get_transfer_queue_tasks' ||
    cmd === 'get_actions_catalog' ||
    cmd === 'manage_custom_actions' ||
    cmd === 'get_mcp_audit_logs' ||
    cmd === 'get_pending_mcp_approvals' ||
    cmd === 'compare_directories_fast'
  ) {
    return [] as unknown as T;
  }

  if (cmd === 'get_mcp_status' || cmd === 'set_mcp_gateway_enabled' || cmd === 'set_mcp_command_access') {
    if (cmd === 'set_mcp_gateway_enabled') previewGatewayOff = args?.enabled === false;
    if (cmd === 'set_mcp_command_access' && typeof args?.access === 'string') previewCommandAccess = args.access;
    return {
      enabled: false,
      active_sessions_count: 0,
      total_audit_events: 0,
      transport_available: true,
      transport_running: false,
      connected_agents: 0,
      setup_command: 'claude mcp add rustscp -- /Applications/RustSCP.app/Contents/MacOS/rustscp-desktop --mcp-stdio',
      setup_json: null,
      gateway_error: previewGatewayOff ? null : 'Preview mode: the gateway runs in the desktop app.',
      turned_off: previewGatewayOff,
      command_access: previewCommandAccess,
    } as unknown as T;
  }

  if (cmd === 'is_continuous_sync_running') {
    return false as unknown as T;
  }

  return {} as T;
}
