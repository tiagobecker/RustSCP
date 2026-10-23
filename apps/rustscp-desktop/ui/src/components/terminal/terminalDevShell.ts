/**
 * A pretend server shell for the UI preview in a plain browser (vite dev), where there is no
 * Tauri backend. It echoes typing, answers a handful of commands and reports them the way
 * the real prompt hook does, so the terminal UI can be tried end to end. Never loaded in the
 * desktop app.
 */
type Dispatch = (name: string, payload: any) => void;

interface FakeShell {
  id: string;
  cwd: string;
  line: string;
  seq: number;
  busySince: number | null;
  pendingCommand: string | null;
  waiting: ((answer: string) => void) | null;
  hidden: boolean;
  answer: string;
}

const shells = new Map<string, FakeShell>();
const history: any[] = [];
const HOME = '/home/demo';
const SITE = 'demo@sftp.example.com:22';

const prompt = (s: FakeShell) => `\x1b[1;32mdemo@demo-server\x1b[0m:\x1b[1;34m${s.cwd.replace(HOME, '~')}\x1b[0m$ `;
const marker = (kind: string, value: string | number) => `\x1b]6973;${kind};${value}\x07`;

export async function devCall<T>(cmd: string, args: any, dispatch: Dispatch): Promise<T> {
  const out = (s: FakeShell, data: string) => dispatch('terminal-output', { id: s.id, seq: ++s.seq, data });
  const state = (s: FakeShell) => dispatch('terminal-state', { id: s.id, busy: s.busySince != null, integration: true, cwd: s.cwd });

  const finish = (s: FakeShell, code: number, outputTail = '') => {
    const command = s.pendingCommand;
    const duration = s.busySince != null ? Date.now() - s.busySince : null;
    out(s, (command ? marker('cmd', command) : '') + marker('cwd', s.cwd) + marker('done', code) + prompt(s));
    s.busySince = null;
    s.pendingCommand = null;
    if (command) {
      history.push({ id: `h${history.length + 1}`, command, site_key: SITE, site_name: 'Demo server', cwd: s.cwd, exit_code: code, duration_ms: duration, finished_at: new Date().toISOString() });
      dispatch('terminal-command', { id: s.id, command, exit_code: code, duration_ms: duration, cwd: s.cwd, output_tail: outputTail });
    }
    state(s);
  };

  const ask = (s: FakeShell, question: string, hidden: boolean) =>
    new Promise<string>((resolve) => {
      out(s, question);
      s.hidden = hidden;
      s.answer = '';
      s.waiting = resolve;
    });

  const run = async (s: FakeShell, line: string) => {
    const command = line.trim();
    if (!command) {
      finish(s, 0);
      return;
    }
    s.pendingCommand = command;
    const words = command.split(/\s+/);
    const name = words[0] === 'sudo' ? words[1] : words[0];
    if (words[0] === 'sudo') {
      await ask(s, '[sudo] password for demo: ', true);
      out(s, '\r\n');
    }
    const say = (text: string) => out(s, text.replace(/\n/g, '\r\n'));
    switch (name) {
      case 'ls':
        say('\x1b[1;34mpublic\x1b[0m  nginx.conf  app.log  backup_database.sql.gz\n');
        return finish(s, 0);
      case 'pwd':
        say(`${s.cwd}\n`);
        return finish(s, 0);
      case 'cd': {
        const target = words[1] ?? '~';
        if (target === '/nope') {
          say(`bash: cd: ${target}: No such file or directory\n`);
          return finish(s, 1, `bash: cd: ${target}: No such file or directory`);
        }
        s.cwd = target === '~' ? HOME : target.startsWith('/') ? target : `${s.cwd}/${target}`.replace(/\/+/g, '/');
        return finish(s, 0);
      }
      case 'df':
        say('Filesystem      Size  Used Avail Use% Mounted on\n/dev/sda1        48G   31G   17G  65% /\ntmpfs           2.0G     0  2.0G   0% /dev/shm\n');
        return finish(s, 0);
      case 'cat':
        if ((words[1] ?? '').startsWith('/etc/shadow')) {
          say(`cat: ${words[1]}: Permission denied\n`);
          return finish(s, 1, `cat: ${words[1]}: Permission denied`);
        }
        say(`cat: ${words[1] ?? ''}: No such file or directory\n`);
        return finish(s, 1, `cat: ${words[1] ?? ''}: No such file or directory`);
      case 'sleep': {
        const secs = Math.min(60, Number(words[1]) || 1);
        await new Promise((r) => setTimeout(r, secs * 1000));
        return s.pendingCommand ? finish(s, 0) : undefined;
      }
      case 'apt': {
        say('Reading package lists... Done\nBuilding dependency tree... Done\nThe following packages will be upgraded:\n  openssl libssl3 nginx\n3 upgraded, 0 newly installed.\n');
        const answer = await ask(s, 'Do you want to continue? [Y/n] ', false);
        out(s, '\r\n');
        if (/^n/i.test(answer)) {
          say('Abort.\n');
          return finish(s, 1, 'Abort.');
        }
        for (const pkg of ['openssl', 'libssl3', 'nginx']) {
          await new Promise((r) => setTimeout(r, 900));
          say(`Setting up ${pkg} ...\n`);
        }
        return finish(s, 0);
      }
      case 'exit':
        dispatch('terminal-exit', { id: s.id, exit_code: Number(words[1]) || 0, error: null });
        shells.delete(s.id);
        return;
      default:
        say(`bash: ${name}: command not found\n`);
        return finish(s, 127, `bash: ${name}: command not found`);
    }
  };

  const type = (s: FakeShell, data: string) => {
    for (const ch of data) {
      if (s.waiting) {
        if (ch === '\r') {
          const resolve = s.waiting;
          s.waiting = null;
          resolve(s.answer);
        } else if (ch === '\x7f') s.answer = s.answer.slice(0, -1);
        else {
          s.answer += ch;
          if (!s.hidden) out(s, ch);
        }
        continue;
      }
      if (ch === '\x03') {
        out(s, '^C\r\n');
        s.line = '';
        if (s.busySince != null) finish(s, 130);
        else out(s, marker('cwd', s.cwd) + marker('done', 130) + prompt(s));
        continue;
      }
      if (s.busySince != null) continue;
      if (ch === '\r') {
        out(s, '\r\n');
        const line = s.line;
        s.line = '';
        s.busySince = Date.now();
        state(s);
        void run(s, line);
      } else if (ch === '\x7f') {
        if (s.line) {
          s.line = s.line.slice(0, -1);
          out(s, '\b \b');
        }
      } else if (ch === '\x15') {
        out(s, '\b \b'.repeat(s.line.length));
        s.line = '';
      } else if (ch >= ' ') {
        s.line += ch;
        out(s, ch);
      }
    }
  };

  switch (cmd) {
    case 'terminal_list':
      return [] as T;
    case 'terminal_snapshot':
      return { data: '', seq: 0 } as T;
    case 'terminal_open':
    case 'terminal_reconnect': {
      const id: string = args.id;
      const s: FakeShell = { id, cwd: args.path && args.path !== '/' ? args.path : HOME, line: '', seq: shells.get(id)?.seq ?? 0, busySince: null, pendingCommand: null, waiting: null, hidden: false, answer: '' };
      shells.set(id, s);
      await new Promise((r) => setTimeout(r, 400));
      setTimeout(() => {
        out(s, 'Welcome to Ubuntu 24.04 LTS (demo)\r\n\r\n' + marker('cwd', s.cwd) + marker('done', 0) + prompt(s));
        state(s);
      }, 50);
      return { id, session_id: args.sessionId ?? 'demo', title: 'Demo server', host: 'sftp.example.com', username: 'demo', site_key: SITE, status: 'running', exit_code: null, error: null, cwd: s.cwd, integration: true, busy: false, created_at: new Date().toISOString() } as T;
    }
    case 'terminal_write': {
      const s = shells.get(args.id);
      if (s) type(s, args.data);
      return undefined as T;
    }
    case 'terminal_run': {
      const s = shells.get(args.id);
      if (s) type(s, `\x15${args.command}\r`);
      return undefined as T;
    }
    case 'terminal_close':
      shells.delete(args.id);
      return undefined as T;
    case 'terminal_history': {
      const q = String(args?.query ?? '').toLowerCase();
      return history
        .filter((h) => (!args?.siteKey || h.site_key === args.siteKey) && h.command.toLowerCase().includes(q))
        .slice()
        .reverse() as T;
    }
    case 'terminal_history_delete': {
      const ids: string[] = args?.ids ?? [];
      const before = history.length;
      for (let i = history.length - 1; i >= 0; i--) if (ids.includes(history[i].id)) history.splice(i, 1);
      return (before - history.length) as T;
    }
    case 'terminal_history_clear': {
      const n = history.length;
      history.length = 0;
      return n as T;
    }
    case 'clipboard_read_text':
      return (await navigator.clipboard.readText()) as T;
    case 'open_external_url':
      window.open(args.url, '_blank', 'noopener');
      return undefined as T;
    case 'detect_remote_system':
      return { os_name: 'Ubuntu 24.04 LTS', distro_id: 'ubuntu', kernel: 'Linux 6.8.0', default_shell: '/bin/bash', package_manager: 'apt-get', is_root: false, has_sudo: true, hostname: 'demo-server', architecture: 'x86_64' } as T;
    default:
      return undefined as T;
  }
}
