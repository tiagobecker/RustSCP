/** Preferences of the built-in terminal, kept in this browser profile (per computer). */
export interface TerminalSettings {
  fontSize: number;
  /** PuTTY-style: selecting text copies it. */
  copyOnSelect: boolean;
  /** PuTTY-style: right click pastes instead of opening the menu. */
  rightClickPaste: boolean;
  /** Ask before pasting several lines (each line would run as a command). */
  confirmMultiline: boolean;
  /** Keep a local history of the commands run in terminals. */
  keepHistory: boolean;
  /** Show the command assistant under the terminal. */
  assistant: boolean;
  /** Follow the app's light/dark theme, or always use a dark terminal. */
  theme: 'app' | 'dark';
}

export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  fontSize: 13,
  copyOnSelect: true,
  rightClickPaste: false,
  confirmMultiline: true,
  keepHistory: true,
  assistant: true,
  theme: 'app',
};

export const MIN_FONT_SIZE = 9;
export const MAX_FONT_SIZE = 28;

const KEY = 'rustscp_terminal_settings';

export function loadTerminalSettings(): TerminalSettings {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    const s = { ...DEFAULT_TERMINAL_SETTINGS, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
    s.fontSize = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Number(s.fontSize) || DEFAULT_TERMINAL_SETTINGS.fontSize));
    if (s.theme !== 'dark') s.theme = 'app';
    for (const k of ['copyOnSelect', 'rightClickPaste', 'confirmMultiline', 'keepHistory', 'assistant'] as const) {
      s[k] = typeof s[k] === 'boolean' ? s[k] : DEFAULT_TERMINAL_SETTINGS[k];
    }
    return s;
  } catch {
    return { ...DEFAULT_TERMINAL_SETTINGS };
  }
}

export function saveTerminalSettings(s: TerminalSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}
