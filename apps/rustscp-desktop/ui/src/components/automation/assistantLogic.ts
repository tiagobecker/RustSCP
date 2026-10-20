/**
 * Rule-based helpers behind the Assistant modal: listing filter, batch-rename planning and the
 * folder permission audit. Pure functions so they are easy to reason about and test.
 */
import type { FileEntry } from '../../types.ts';

/* -------------------------------------------------------------------------- */
/* Natural-language filter                                                     */
/* -------------------------------------------------------------------------- */

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'heic', 'avif', 'tif', 'tiff'];
const ARCHIVE_EXT = ['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'txz', '7z', 'rar', 'zst'];
const CONFIG_EXT = ['env', 'json', 'yaml', 'yml', 'conf', 'config', 'cfg', 'ini', 'toml', 'xml', 'properties'];
const CODE_EXT = ['rs', 'go', 'py', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'sh', 'bash', 'zsh', 'php', 'rb', 'html', 'css', 'java', 'kt', 'c', 'h', 'cpp', 'cs', 'swift', 'sql'];

export interface FilterCriteria {
  kind?: 'dir' | 'file';
  minBytes?: number;
  maxBytes?: number;
  exts?: Set<string>;
  nameTerm?: string;
}

const UNIT: Record<string, number> = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 };

function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function extOf(name: string): string {
  const lower = name.toLowerCase();
  const i = lower.lastIndexOf('.');
  return i > 0 ? lower.slice(i + 1) : lower.startsWith('.') ? lower.slice(1) : '';
}

/** Parses free text such as "arquivos > 5MB", "images (.png, .jpg)" or "folders only". */
export function parseFilterQuery(query: string): FilterCriteria | null {
  const raw = query.trim().toLowerCase();
  if (!raw) return null;
  const q = stripAccents(raw);
  const c: FilterCriteria = {};
  let recognized = false;

  if (/\b(pastas?|diretorios?|folders?|dirs?|directory|directories)\b/.test(q)) {
    c.kind = 'dir';
    recognized = true;
  } else if (/\b(arquivos?|files?)\b/.test(q)) {
    c.kind = 'file';
    recognized = true;
  }

  const size = /(>=|<=|>|<|maior(?:es)?(?:\s+(?:do\s+)?que)?|menor(?:es)?(?:\s+(?:do\s+)?que)?|acima\s+de|abaixo\s+de|larger\s+than|bigger\s+than|smaller\s+than|over|under|above|below)?\s*(\d+(?:[.,]\d+)?)\s*(kb|k|mb|m|gb|g|kilo\w*|mega\w*|giga\w*|bytes?|b)\b/.exec(q);
  if (size) {
    const n = parseFloat(size[2].replace(',', '.'));
    const unitKey = size[3].startsWith('kilo') ? 'k' : size[3].startsWith('mega') ? 'm' : size[3].startsWith('giga') ? 'g' : size[3][0];
    const bytes = n * (UNIT[unitKey] ?? 1);
    const op = size[1] || '';
    if (/^(<|menor|abaixo|smaller|under|below)/.test(op)) c.maxBytes = bytes;
    else c.minBytes = bytes;
    recognized = true;
  } else if (/\b(grandes?|maiores|large|big|huge)\b/.test(q)) {
    c.minBytes = 5 * 1024 ** 2;
    recognized = true;
  }

  const exts = new Set<string>();
  if (/\b(imagens?|fotos?|images?|pictures?|photos?)\b/.test(q)) IMAGE_EXT.forEach((e) => exts.add(e));
  if (/\b(compactad\w*|comprimid\w*|archives?|compressed|zips?)\b/.test(q)) ARCHIVE_EXT.forEach((e) => exts.add(e));
  if (/\b(config\w*|configurac\w*|env|settings)\b/.test(q)) CONFIG_EXT.forEach((e) => exts.add(e));
  if (/\b(codigos?|code|scripts?|source)\b/.test(q)) CODE_EXT.forEach((e) => exts.add(e));
  for (const m of q.matchAll(/(?:^|[\s,(*;])\.([a-z0-9]{1,12})\b/g)) exts.add(m[1]);
  if (exts.size > 0) {
    c.exts = exts;
    recognized = true;
  }

  if (!recognized) c.nameTerm = raw;
  return c;
}

export function matchesFilter(f: FileEntry, c: FilterCriteria | null): boolean {
  if (!c) return true;
  const isDir = f.file_type === 'directory';
  const name = f.name.toLowerCase();
  if (c.nameTerm !== undefined) return name.includes(c.nameTerm);
  if (c.kind === 'dir' && !isDir) return false;
  if (c.kind === 'file' && isDir) return false;
  if (c.minBytes !== undefined || c.maxBytes !== undefined) {
    if (isDir) return false;
    const size = f.size || 0;
    if (c.minBytes !== undefined && size < c.minBytes) return false;
    if (c.maxBytes !== undefined && size > c.maxBytes) return false;
  }
  if (c.exts) {
    if (isDir) return false;
    const ext = extOf(name);
    if (!c.exts.has(ext) && !(c.exts.has('env') && (name === '.env' || name.startsWith('.env.')))) return false;
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/* Batch rename                                                                */
/* -------------------------------------------------------------------------- */

export type RenamePattern = 'kebab' | 'snake' | 'lower' | 'upper' | 'prefix' | 'suffix' | 'replace';

export interface RenameOptions {
  prefix: string;
  suffix: string;
  find: string;
  replace: string;
}

export type RenameProblem = 'invalid' | 'duplicate' | 'exists' | 'cycle';

export interface RenameRow {
  file: FileEntry;
  original: string;
  newName: string;
  changed: boolean;
  problem?: RenameProblem;
}

export interface RenamePlan {
  rows: RenameRow[];
  /** Rows to rename, in an order that never overwrites a name still in use */
  ordered: RenameRow[];
  changedCount: number;
  problemCount: number;
}

export function transformName(name: string, pattern: RenamePattern, o: RenameOptions): string {
  const lastDot = name.lastIndexOf('.');
  const base = lastDot > 0 ? name.slice(0, lastDot) : name;
  const ext = lastDot > 0 ? name.slice(lastDot) : '';
  switch (pattern) {
    case 'kebab':
      return `${base.toLowerCase().replace(/[\s_]+/g, '-')}${ext.toLowerCase()}`;
    case 'snake':
      return `${base.toLowerCase().replace(/[\s-]+/g, '_')}${ext.toLowerCase()}`;
    case 'lower':
      return name.toLowerCase();
    case 'upper':
      return `${base.toUpperCase()}${ext.toUpperCase()}`;
    case 'prefix':
      return `${o.prefix}${name}`;
    case 'suffix':
      return `${base}${o.suffix}${ext}`;
    case 'replace':
      return o.find ? name.split(o.find).join(o.replace) : name;
  }
}

function isInvalidName(n: string): boolean {
  return !n.trim() || n === '.' || n === '..' || /[/\\\0]/.test(n);
}

/**
 * Plans a rename of every file (not folder) in the listing. Names are compared case-insensitively
 * because macOS and Windows file systems are, so `Foo.txt` and `foo.txt` count as the same name.
 */
export function buildRenamePlan(files: FileEntry[], pattern: RenamePattern, o: RenameOptions): RenamePlan {
  const rows: RenameRow[] = files
    .filter((f) => f.file_type !== 'directory')
    .map((f) => {
      const newName = transformName(f.name, pattern, o);
      return { file: f, original: f.name, newName, changed: newName !== f.name };
    });

  const changed = rows.filter((r) => r.changed);
  const key = (n: string) => n.toLowerCase();

  // Names that stay in place: folders and files that are not renamed
  const staying = new Set<string>();
  for (const f of files) if (f.file_type === 'directory') staying.add(key(f.name));
  for (const r of rows) if (!r.changed) staying.add(key(r.original));

  const targetCount = new Map<string, number>();
  for (const r of changed) targetCount.set(key(r.newName), (targetCount.get(key(r.newName)) || 0) + 1);

  for (const r of changed) {
    if (isInvalidName(r.newName)) r.problem = 'invalid';
    else if ((targetCount.get(key(r.newName)) || 0) > 1) r.problem = 'duplicate';
    else if (staying.has(key(r.newName))) r.problem = 'exists';
  }

  // Order the renames so a target is free (its current owner was renamed first); cycles are reported
  const pending = changed.filter((r) => !r.problem);
  const occupiedBy = new Map<string, RenameRow>();
  for (const r of pending) occupiedBy.set(key(r.original), r);
  const ordered: RenameRow[] = [];
  let remaining = pending.slice();
  while (remaining.length > 0) {
    const next: RenameRow[] = [];
    let progressed = false;
    for (const r of remaining) {
      const owner = occupiedBy.get(key(r.newName));
      if (!owner || owner === r) {
        ordered.push(r);
        occupiedBy.delete(key(r.original));
        progressed = true;
      } else {
        next.push(r);
      }
    }
    if (!progressed) {
      for (const r of next) r.problem = 'cycle';
      break;
    }
    remaining = next;
  }

  const problemCount = changed.filter((r) => r.problem).length;
  return { rows, ordered: problemCount > 0 ? [] : ordered, changedCount: changed.length, problemCount };
}

export function renameProblemText(p: RenameProblem, isPt: boolean): string {
  switch (p) {
    case 'invalid':
      return isPt ? 'Nome inválido' : 'Invalid name';
    case 'duplicate':
      return isPt ? 'Dois arquivos teriam este nome' : 'Two files would get this name';
    case 'exists':
      return isPt ? 'Já existe um item com este nome' : 'An item with this name already exists';
    case 'cycle':
      return isPt ? 'Troca circular de nomes' : 'Circular name swap';
  }
}

/* -------------------------------------------------------------------------- */
/* Permission audit                                                            */
/* -------------------------------------------------------------------------- */

export type AuditSeverity = 'critical' | 'warning' | 'info';

export interface AuditReason {
  severity: AuditSeverity;
  title: string;
  description: string;
}

export interface AuditIssue {
  item: FileEntry;
  severity: AuditSeverity;
  reasons: AuditReason[];
  currentMode: number;
  /** Mode after clearing the risky bits (special bits such as setgid/sticky are kept) */
  newMode: number;
}

export interface AuditReport {
  score: number;
  issues: AuditIssue[];
  critCount: number;
  warnCount: number;
}

const SEVERITY_RANK: Record<AuditSeverity, number> = { critical: 3, warning: 2, info: 1 };

function isSecretName(name: string): boolean {
  const n = name.toLowerCase();
  if (n.endsWith('.pub')) return false; // public keys are meant to be readable
  return n === '.env' || n.startsWith('.env.') || /^id_(rsa|dsa|ecdsa|ed25519)(_|$|\.)/.test(n) || n.endsWith('.pem') || n.endsWith('.key');
}

function isDumpName(name: string): boolean {
  const n = name.toLowerCase();
  return n.endsWith('.sql') || n.endsWith('.sql.gz') || n.endsWith('.dump') || n.endsWith('.bak') || n.endsWith('.old');
}

export const formatMode = (mode: number) => (mode & 0o7777).toString(8).padStart(4, '0');

/**
 * Audits the listing. Only regular files and folders are checked: symlinks report the link's own
 * mode (0777) and chmod would follow them to the target, so they are skipped.
 */
export function auditPermissions(files: FileEntry[], isPt: boolean): AuditReport {
  const issues: AuditIssue[] = [];
  for (const f of files) {
    const mode = f.permissions?.mode || 0;
    if (!mode) continue;
    const isFile = f.file_type === 'file';
    const isDir = f.file_type === 'directory';
    if (!isFile && !isDir) continue;

    const perm = mode & 0o7777;
    let clear = 0;
    const reasons: AuditReason[] = [];

    if (perm & 0o002) {
      const sticky = isDir && (perm & 0o1000) !== 0;
      clear |= 0o002;
      reasons.push(
        sticky
          ? {
              severity: 'info',
              title: isPt ? `Pasta compartilhada gravável por todos (${formatMode(perm)})` : `Shared folder writable by everyone (${formatMode(perm)})`,
              description: isPt
                ? 'Tem o sticky bit (como /tmp ou pastas de upload): outros usuários podem criar arquivos, mas não apagar os seus. Mude só se ninguém mais precisa gravar aqui.'
                : 'It has the sticky bit (like /tmp or upload folders): other users can create files but not delete yours. Change it only if nobody else needs to write here.',
            }
          : {
              severity: 'critical',
              title: isPt ? `Gravável por qualquer usuário (${formatMode(perm)})` : `Writable by any user (${formatMode(perm)})`,
              description: isPt
                ? `"${f.name}" pode ser alterado por qualquer usuário do servidor.`
                : `"${f.name}" can be changed by any user on the server.`,
            }
      );
    }

    if (isFile && isSecretName(f.name) && (perm & 0o077) !== 0) {
      clear |= 0o077;
      reasons.push({
        severity: 'critical',
        title: isPt ? `Segredo legível por outros (${f.name})` : `Secret readable by others (${f.name})`,
        description: isPt
          ? `Arquivos com senhas ou chaves privadas devem ser acessíveis só pelo dono (600). Atual: ${formatMode(perm)}.`
          : `Files with passwords or private keys should be accessible by the owner only (600). Current: ${formatMode(perm)}.`,
      });
    }

    if (isFile && isDumpName(f.name) && (perm & 0o077) !== 0) {
      clear |= 0o077;
      reasons.push({
        severity: 'warning',
        title: isPt ? `Backup ou dump acessível por outros (${f.name})` : `Backup or dump readable by others (${f.name})`,
        description: isPt
          ? 'Backups em pastas públicas podem ser baixados se o servidor web estiver mal configurado.'
          : 'Backups in public folders can be downloaded if the web server is misconfigured.',
      });
    }

    if (reasons.length === 0) continue;
    const severity = reasons.reduce<AuditSeverity>((acc, r) => (SEVERITY_RANK[r.severity] > SEVERITY_RANK[acc] ? r.severity : acc), 'info');
    issues.push({ item: f, severity, reasons, currentMode: perm, newMode: perm & ~clear });
  }

  issues.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  const critCount = issues.filter((i) => i.severity === 'critical').length;
  const warnCount = issues.filter((i) => i.severity === 'warning').length;
  return { score: Math.max(0, 100 - critCount * 25 - warnCount * 10), issues, critCount, warnCount };
}
