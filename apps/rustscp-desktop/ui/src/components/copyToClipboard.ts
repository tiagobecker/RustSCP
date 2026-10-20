import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Copies text and reports whether it really worked. WKWebView can reject
 * navigator.clipboard (permission or focus rules), so a hidden-textarea
 * execCommand fallback is tried before giving up.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall back below */
  }
  try {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '-9999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    previouslyFocused?.focus?.();
    return ok;
  } catch {
    return false;
  }
}

/** `copy(text)` resolves to true on success and flips `copied` for a moment so buttons can show feedback. */
export function useCopyFeedback(timeoutMs = 1600) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  const copy = useCallback(
    async (text: string) => {
      const ok = await copyText(text);
      if (timer.current) clearTimeout(timer.current);
      setCopied(ok);
      if (ok) timer.current = setTimeout(() => setCopied(false), timeoutMs);
      return ok;
    },
    [timeoutMs]
  );

  return { copied, copy };
}
