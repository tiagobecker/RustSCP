/**
 * Path helpers shared by the workspace. They accept POSIX paths (remote servers, macOS, Linux)
 * and Windows local paths (`C:\Users\me`), which the local driver returns with backslashes.
 */

export type PathSep = '/' | '\\';

/** Separator style used by `p`: backslash for Windows-style paths, slash otherwise. */
export function detectSep(p: string): PathSep {
  if (!p) return '/';
  if (p.includes('\\') && !p.includes('/')) return '\\';
  if (/^[A-Za-z]:$/.test(p)) return '\\';
  return '/';
}

/** Last path component, splitting on both separators. */
export function basename(p: string): string {
  const trimmed = (p || '').replace(/[\\/]+$/, '');
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}

/** Parent directory ('' when there is none). Keeps '/' and 'C:\' roots intact. */
export function dirname(p: string): string {
  const trimmed = (p || '').replace(/[\\/]+$/, '');
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (i < 0) return '';
  if (i === 0) return trimmed[0];
  const head = trimmed.slice(0, i);
  if (/^[A-Za-z]:$/.test(head)) return head + trimmed[i];
  return head;
}

/** Joins a directory and a (possibly multi-segment) relative name using the directory's separator. */
export function joinPath(dir: string, name: string): string {
  const sep = detectSep(dir);
  const rel = (sep === '\\' ? name.replace(/\//g, '\\') : name).replace(/^[\\/]+/, '');
  if (!dir) return sep === '/' ? `/${rel}` : rel;
  if (dir.endsWith('/') || dir.endsWith('\\')) return dir + rel;
  return `${dir}${sep}${rel}`;
}

/** Comparable form: forward slashes, no duplicate or trailing separators. */
export function normalizeForCompare(p: string): string {
  let s = (p || '').replace(/\\/g, '/').replace(/\/+/g, '/');
  if (s.length > 1) s = s.replace(/\/$/, '');
  return s;
}

export function samePath(a: string, b: string): boolean {
  return normalizeForCompare(a) === normalizeForCompare(b);
}

/** True when `child` lies strictly inside `parent`. */
export function isInside(child: string, parent: string): boolean {
  const c = normalizeForCompare(child);
  const p = normalizeForCompare(parent);
  if (!p) return false;
  if (p === '/') return c !== '/' && c.startsWith('/');
  return c.startsWith(`${p}/`);
}

function segments(p: string): string[] {
  return normalizeForCompare(p).split('/').filter(Boolean);
}

/**
 * Describes a navigation from `oldPath` to `newPath` as "n levels up" or "into these subfolders".
 * Returns null for unrelated jumps (bookmarks, typed paths), which should not be mirrored.
 */
export function relativeMove(oldPath: string, newPath: string): { up: number; down: string[] } | null {
  const o = segments(oldPath);
  const n = segments(newPath);
  if (n.length >= o.length && o.every((s, i) => n[i] === s)) return { up: 0, down: n.slice(o.length) };
  if (o.length > n.length && n.every((s, i) => o[i] === s)) return { up: o.length - n.length, down: [] };
  return null;
}

/** Applies a relativeMove to another path; null when it would climb above the root. */
export function applyRelativeMove(base: string, move: { up: number; down: string[] }): string | null {
  let p = base;
  for (let i = 0; i < move.up; i++) {
    const parent = dirname(p);
    if (!parent || parent === p) return null;
    p = parent;
  }
  for (const seg of move.down) p = joinPath(p, seg);
  return p;
}

const BINARY_EXTENSIONS = new Set([
  // archives & disk images
  'gz', 'tgz', 'zip', 'tar', 'bz2', 'tbz2', 'xz', 'txz', 'zst', '7z', 'rar', 'lz', 'lzma', 'cab',
  'iso', 'dmg', 'img', 'vmdk', 'qcow2', 'vdi',
  // executables & libraries
  'bin', 'exe', 'dll', 'so', 'dylib', 'o', 'a', 'lib', 'class', 'jar', 'war', 'ear', 'pyc', 'pyo', 'wasm',
  'deb', 'rpm', 'pkg', 'msi', 'apk', 'ipa', 'appimage',
  // media
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'icns', 'tif', 'tiff', 'psd', 'heic', 'avif',
  'mp3', 'mp4', 'm4a', 'm4v', 'mov', 'avi', 'mkv', 'webm', 'wav', 'flac', 'ogg', 'aac', 'wma', 'wmv',
  // documents & data
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'key', 'numbers', 'pages',
  'sqlite', 'sqlite3', 'db', 'mdb', 'dat', 'parquet', 'avro',
  // fonts
  'woff', 'woff2', 'ttf', 'otf', 'eot',
]);

/** Extension-based guess used before handing a file to the built-in text editor. */
export function isLikelyBinaryName(name: string): boolean {
  const lower = basename(name).toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot <= 0) return false;
  return BINARY_EXTENSIONS.has(lower.slice(dot + 1));
}

/** Size limit of the built-in editor (the backend enforces the same limit). */
export const EDITOR_MAX_BYTES = 10 * 1024 * 1024;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const k = 1024;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1))} ${units[i]}`;
}
