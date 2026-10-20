/**
 * Renders Smart Action templates in the UI (Command Studio and the legacy Smart Command modal).
 *
 * Mirrors `ActionExecutor::render_command` in crates/rustscp-actions so the preview is exactly
 * the command that runs:
 * - `${context}` variables are replaced by POSIX-quoted words (every path, name, stem and ext).
 * - `{{field}}` placeholders are replaced by the quoted field value (numbers: digits only,
 *   select values: bare when they are plain words, checkboxes: `true` / `false`).
 * - `{% if field == 'value' %}…{% else %}…{% endif %}` blocks are evaluated (also `!=`,
 *   `if field` and `if not field`), never just stripped.
 * - The template is scanned once, so text inside a substituted value is never re-expanded.
 * Unknown `${VAR}` / `{{x}}` (e.g. shell parameter expansions or docker's `{{.Names}}`) are left for the shell.
 */
import type { ActionDefinition, ActionField } from '../../types.ts';
import { shQuote, inDir } from '../../utils/shell.ts';
import { basename } from '../../utils/paths.ts';

export interface ActionContext {
  selectedPaths: string[];
  currentDir: string;
}

export type FieldErrorKind = 'required' | 'pattern' | 'option' | 'number' | 'range';

export interface FieldError {
  kind: FieldErrorKind;
  detail?: string;
}

export interface RenderResult {
  /** The final command (without the working-directory prefix). */
  command: string;
  /** Validation problems per field id. */
  fieldErrors: Record<string, FieldError>;
  /** Problems that are not tied to one field (missing selection, broken template). */
  error?: string;
}

const NEEDS_SELECTION = new Set([
  'selected_files',
  'selected_names',
  'selected_file',
  'selected_first_name',
  'selected_name',
  'selected_stem',
  'selected_ext',
]);

const TOKEN_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\{\{\s*([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}|\{%\s*(.*?)\s*%\}/g;
const COND_RE = /^if\s+(not\s+)?([A-Za-z_][A-Za-z0-9_-]*)\s*(?:(==|!=)\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z0-9_.-]+)))?$/;

function splitExt(name: string): [string, string] {
  const i = name.lastIndexOf('.');
  return i > 0 ? [name.slice(0, i), name.slice(i + 1)] : [name, ''];
}

/** Raw (unquoted) value of a context variable; undefined for unknown names. */
function rawVar(ctx: ActionContext, name: string): string | undefined {
  const first = ctx.selectedPaths[0] || '';
  const firstName = basename(first) || 'item';
  const [stem, ext] = splitExt(firstName);
  switch (name) {
    case 'selected_dir':
    case 'current_dir':
      return ctx.currentDir;
    case 'selected_file':
      return first;
    case 'selected_first_name':
    case 'selected_name':
      return firstName;
    case 'selected_stem':
      return stem;
    case 'selected_ext':
      return ext;
    default:
      return undefined;
  }
}

/** Shell-ready value of a context variable; undefined for unknown names (left for the shell). */
function quotedVar(ctx: ActionContext, name: string): string | undefined {
  if (name === 'selected_files') {
    return ctx.selectedPaths.length > 0 ? ctx.selectedPaths.map(shQuote).join(' ') : "''";
  }
  if (name === 'selected_names') {
    return ctx.selectedPaths.length > 0 ? ctx.selectedPaths.map((p) => shQuote(basename(p))).join(' ') : "''";
  }
  const raw = rawVar(ctx, name);
  return raw === undefined ? undefined : shQuote(raw);
}

/** Expands `${context}` variables (raw, unquoted) inside a field's default value. */
export function expandDefault(def: string, ctx: ActionContext): string {
  return def.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, name: string) => rawVar(ctx, name) ?? m);
}

/** Values a form starts with: defaults (context expanded), select default option, checkbox false. */
export function initialFieldValues(action: ActionDefinition, ctx: ActionContext): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of action.fields || []) {
    if (field.default_value != null && field.default_value !== '') {
      values[field.id] = expandDefault(field.default_value, ctx);
    } else if (field.kind === 'checkbox') {
      values[field.id] = 'false';
    } else if (field.kind === 'select' && field.options && field.options.length > 0) {
      values[field.id] = (field.options.find((o) => o.is_default) || field.options[0]).value;
    } else {
      values[field.id] = '';
    }
  }
  return values;
}

function isTruthy(v: string): boolean {
  return !(v === '' || v === 'false' || v === '0');
}

function normalizeCheckbox(v: string): string {
  return v === 'true' || v === '1' ? 'true' : 'false';
}

/** Validates one value the same way the backend does (required, regex, select whitelist, number range). */
export function validateField(field: ActionField, rawValue: string | undefined): FieldError | null {
  const value = (rawValue ?? '').trim();
  if (field.kind === 'checkbox') return null;
  if (!value) return field.required ? { kind: 'required' } : null;
  if (field.validation_regex) {
    try {
      if (!new RegExp(field.validation_regex).test(value)) return { kind: 'pattern', detail: field.validation_regex };
    } catch {
      // A pattern JS cannot parse is checked by the backend renderer only.
    }
  }
  if (field.kind === 'select' && field.options && !field.options.some((o) => o.value === value)) {
    return { kind: 'option' };
  }
  if (field.kind === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n) || !/^-?\d+(\.\d+)?$/.test(value)) return { kind: 'number' };
    if ((field.min != null && n < field.min) || (field.max != null && n > field.max)) {
      return { kind: 'range', detail: `${field.min ?? ''}..${field.max ?? ''}` };
    }
  }
  return null;
}

/** Leaves simple option-like words (`-6`, `status`, `0644`) bare and quotes anything else. */
function quoteIfNeeded(raw: string): string {
  return raw !== '' && /^[A-Za-z0-9\-_.,:=+@%/]+$/.test(raw) ? raw : shQuote(raw);
}

function renderField(field: ActionField, value: string): string {
  switch (field.kind) {
    case 'number':
      return value.replace(/[^0-9.-]/g, '');
    case 'select':
      return quoteIfNeeded(value);
    case 'checkbox':
      return normalizeCheckbox(value);
    default:
      return shQuote(value);
  }
}

/**
 * Renders `action.template` with `values` (field id → raw value). Always returns a command for
 * the preview; `fieldErrors` / `error` tell the caller whether it may run.
 */
export function renderActionTemplate(
  action: ActionDefinition,
  ctx: ActionContext,
  values: Record<string, string>,
  isPt = false
): RenderResult {
  const fieldErrors: Record<string, FieldError> = {};
  const effective: Record<string, string> = {};
  const fields = new Map<string, ActionField>();
  for (const field of action.fields || []) {
    fields.set(field.id, field);
    const provided = values[field.id];
    const raw = provided !== undefined ? provided : field.default_value ? expandDefault(field.default_value, ctx) : '';
    const err = validateField(field, raw);
    if (err) fieldErrors[field.id] = err;
    effective[field.id] = field.kind === 'checkbox' ? normalizeCheckbox(raw.trim()) : raw.trim();
  }

  let error: string | undefined;
  const noSelection = ctx.selectedPaths.length === 0;
  if (action.scope === 'selected_files' && noSelection) {
    error = isPt ? 'Selecione pelo menos um item para esta ação.' : 'Select at least one item for this action.';
  }

  const template = action.template || '';
  let out = '';
  // Each entry: [this branch is active, an earlier branch of this if was taken]
  const stack: Array<[boolean, boolean]> = [];
  const active = () => stack.every(([a]) => a);
  let last = 0;

  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(template)) !== null) {
    if (active()) out += template.slice(last, m.index);
    last = m.index + m[0].length;

    if (m[1] !== undefined) {
      if (!active()) continue;
      const name = m[1];
      if (NEEDS_SELECTION.has(name) && noSelection && !error) {
        error = isPt
          ? `Esta ação precisa de itens selecionados (\${${name}}).`
          : `This action needs selected items (\${${name}}).`;
      }
      out += quotedVar(ctx, name) ?? m[0];
    } else if (m[2] !== undefined) {
      if (!active()) continue;
      const field = fields.get(m[2]);
      out += field ? renderField(field, effective[m[2]] ?? '') : m[0];
    } else if (m[3] !== undefined) {
      const stmt = m[3].trim();
      if (stmt === 'endif') {
        if (!stack.pop()) error = error ?? (isPt ? 'Modelo inválido: {% endif %} inesperado.' : 'Template error: unexpected {% endif %}.');
      } else if (stmt === 'else') {
        const top = stack[stack.length - 1];
        if (top) {
          top[0] = !top[1];
          top[1] = true;
        } else {
          error = error ?? (isPt ? 'Modelo inválido: {% else %} inesperado.' : 'Template error: unexpected {% else %}.');
        }
      } else {
        const c = COND_RE.exec(stmt);
        if (c) {
          const val = effective[c[2]] ?? '';
          let result: boolean;
          if (c[3]) {
            const rhs = c[4] ?? c[5] ?? c[6] ?? '';
            result = c[3] === '==' ? val === rhs : val !== rhs;
          } else {
            result = isTruthy(val);
          }
          if (c[1]) result = !result;
          stack.push([result, result]);
        } else {
          error = error ?? (isPt ? `Modelo inválido: tag não suportada {% ${stmt} %}.` : `Template error: unsupported tag {% ${stmt} %}.`);
        }
      }
    }
  }
  if (stack.length > 0) {
    error = error ?? (isPt ? 'Modelo inválido: falta {% endif %}.' : 'Template error: missing {% endif %}.');
  }
  out += template.slice(last);
  return { command: out.trim(), fieldErrors, error };
}

/** Human text for a field validation error. */
export function describeFieldError(err: FieldError, isPt: boolean): string {
  switch (err.kind) {
    case 'required':
      return isPt ? 'Obrigatório' : 'Required';
    case 'pattern':
      return isPt ? `Formato inválido (${err.detail})` : `Invalid format (${err.detail})`;
    case 'option':
      return isPt ? 'Escolha uma das opções' : 'Choose one of the options';
    case 'number':
      return isPt ? 'Digite um número' : 'Enter a number';
    case 'range':
      return isPt ? `Fora do intervalo ${err.detail}` : `Outside the range ${err.detail}`;
  }
}

/** True for Windows-style local paths, where a POSIX `cd '…' &&` prefix does not apply. */
function isWindowsPath(dir: string): boolean {
  return /^[A-Za-z]:([\\/]|$)/.test(dir) || (dir.includes('\\') && !dir.includes('/'));
}

/**
 * The exact command to run: `cmd` inside `dir` (`cd '<dir>' && cmd`). Skips the prefix when the
 * command already starts in that folder or when `dir` is a Windows path (cmd.exe).
 */
export function commandInDir(dir: string, cmd: string): string {
  if (!dir || !cmd || isWindowsPath(dir)) return cmd;
  const prefix = `cd ${shQuote(dir)} && `;
  if (cmd.startsWith(prefix)) return cmd;
  return inDir(dir, cmd);
}
