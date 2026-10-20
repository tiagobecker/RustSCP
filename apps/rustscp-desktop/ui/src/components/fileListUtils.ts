/**
 * Display helpers shared by FilePanel, FileContextMenu and TransferQueue.
 * Pure functions only (no React), so they can run once per listing instead of once per render.
 */

/** C0/C1 controls and bidi overrides/isolates that can disguise a file name (e.g. 'invoice‮fdp.sh'). */
const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g;

/**
 * Name as shown to the user: control and bidi characters become visible escapes (⟨U+202E⟩).
 * Only for display; operations must keep using the original path.
 */
export function safeDisplayName(name: string): string {
  if (!name) return '';
  return name.replace(UNSAFE_NAME_CHARS, (c) => `⟨U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}⟩`);
}

const ARCHIVE_SUFFIXES = ['.zip', '.tar.gz', '.tgz', '.tar.bz2', '.tbz2', '.tar.xz', '.txz', '.tar', '.gz', '.zst'];

export function isArchiveName(fileName: string): boolean {
  const lower = (fileName || '').toLowerCase();
  return ARCHIVE_SUFFIXES.some((s) => lower.endsWith(s));
}

const CODE_EXTENSIONS = new Set([
  'rs', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'yaml', 'yml', 'toml', 'py', 'rb', 'go', 'java', 'kt', 'c', 'h',
  'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'ps1', 'sql', 'html', 'css', 'scss', 'xml', 'vue', 'svelte', 'lua', 'swift',
]);

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'tif', 'tiff', 'heic', 'avif']);

export type FileIconKind = 'folder' | 'folderLink' | 'link' | 'archive' | 'code' | 'image' | 'text';

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

export function iconKindFor(name: string, fileType: string): FileIconKind {
  if (fileType === 'directory') return 'folder';
  if (fileType === 'symlink') return 'link';
  if (isArchiveName(name)) return 'archive';
  const ext = extensionOf(name);
  if (CODE_EXTENSIONS.has(ext)) return 'code';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  return 'text';
}

/** Human readable size ('0 B' for empty files). */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const k = 1024;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1))} ${units[i]}`;
}

const dateFormatters = new Map<string, Intl.DateTimeFormat>();

/** One cached formatter per locale: '19/10/2026 12:26' (pt-BR) or '10/19/2026 12:26 PM' (en-US). */
function dateFormatter(locale: string): Intl.DateTimeFormat {
  let f = dateFormatters.get(locale);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    dateFormatters.set(locale, f);
  }
  return f;
}

/** Compact single-line date; '' when missing, the raw value when unparsable. */
export function formatCompactDate(iso: string | undefined, locale: string): { text: string; ts: number } {
  if (!iso) return { text: '', ts: 0 };
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return { text: iso, ts: 0 };
  return { text: dateFormatter(locale).format(ts).replace(/,\s*/, ' '), ts };
}

/** Rough remaining time, e.g. '12 s', '3 min', '1 h 5 min'. */
export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export const isMacPlatform = (): boolean =>
  typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform || '');

/**
 * The file drag in progress, shared by both panes. `dataTransfer.getData` is empty during
 * dragover, so the target pane reads the source session from here to pick copy vs move.
 */
export interface ActiveFileDrag {
  sourceSessionId: string;
  paths: string[];
}

let activeFileDrag: ActiveFileDrag | null = null;

export const fileDragState = {
  get: (): ActiveFileDrag | null => activeFileDrag,
  set: (drag: ActiveFileDrag | null) => {
    activeFileDrag = drag;
  },
};
