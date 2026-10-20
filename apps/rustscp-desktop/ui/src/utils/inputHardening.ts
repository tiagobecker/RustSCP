/**
 * Text typed into RustSCP is almost always machine data: usernames, hosts, paths,
 * commands, keys. macOS WebKit applies "Capitalize words automatically", autocorrect,
 * smart quotes and spell checking to web inputs, which silently turned `root` into
 * `Root` and broke logins. These defaults are applied to every editable element.
 */

export const plainTextInputProps = {
  autoCapitalize: 'off',
  autoCorrect: 'off',
  autoComplete: 'off',
  spellCheck: false,
} as const;

const NON_TEXT_INPUT_TYPES = new Set([
  'checkbox',
  'radio',
  'range',
  'color',
  'file',
  'button',
  'submit',
  'reset',
  'image',
  'hidden',
]);

function harden(el: Element) {
  if (el instanceof HTMLInputElement) {
    if (NON_TEXT_INPUT_TYPES.has(el.type)) return;
  } else if (!(el instanceof HTMLTextAreaElement) && !(el instanceof HTMLElement && el.isContentEditable)) {
    return;
  }
  // Explicit opt-in to spellcheck (e.g. prose fields) is respected via data-allow-spellcheck.
  if ((el as HTMLElement).dataset.allowSpellcheck === 'true') return;
  if (el.getAttribute('autocapitalize') !== 'off') el.setAttribute('autocapitalize', 'off');
  if (el.getAttribute('autocorrect') !== 'off') el.setAttribute('autocorrect', 'off');
  if (el.getAttribute('spellcheck') !== 'false') el.setAttribute('spellcheck', 'false');
  // Keep password managers working on password fields; everything else gets no autofill.
  if (!el.hasAttribute('autocomplete') && !(el instanceof HTMLInputElement && el.type === 'password')) {
    el.setAttribute('autocomplete', 'off');
  }
}

function hardenTree(root: ParentNode) {
  root.querySelectorAll('input, textarea, [contenteditable]').forEach(harden);
}

/** Installs a document-wide guard so every current and future input types text verbatim. */
export function installInputHardening(): () => void {
  if (typeof document === 'undefined') return () => {};

  // Inherited by descendants for spellcheck; a cheap first line of defense.
  document.documentElement.setAttribute('spellcheck', 'false');
  document.documentElement.setAttribute('autocapitalize', 'off');
  document.documentElement.setAttribute('autocorrect', 'off');

  hardenTree(document);

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'attributes') {
        harden(m.target as Element);
        continue;
      }
      m.addedNodes.forEach((node) => {
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const el = node as Element;
        harden(el);
        if (el.firstElementChild) hardenTree(el);
      });
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['type', 'contenteditable'],
  });

  // Last line of defense: re-apply right as an element receives focus.
  const onFocusIn = (e: FocusEvent) => {
    if (e.target instanceof Element) harden(e.target);
  };
  document.addEventListener('focusin', onFocusIn, true);

  return () => {
    observer.disconnect();
    document.removeEventListener('focusin', onFocusIn, true);
  };
}
