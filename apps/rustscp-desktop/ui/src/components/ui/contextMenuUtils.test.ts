import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ariaKeyShortcuts, foldLabel, formatShortcut, nextTypeaheadIndex, placeMenu, placeSubmenu } from './contextMenuUtils.ts';

const viewport = { width: 1000, height: 700 };
const size = { width: 240, height: 300 };

test('a point menu opens right and down when it fits', () => {
  const p = placeMenu({ x: 100, y: 100 }, size, viewport);
  assert.deepEqual([p.left, p.top, p.originX, p.originY], [100, 100, 'left', 'top']);
  assert.equal(p.maxHeight, 700 - 24);
});

test('a point menu flips left and up near the bottom-right corner', () => {
  const p = placeMenu({ x: 900, y: 650 }, size, viewport);
  assert.deepEqual([p.left, p.top, p.originX, p.originY], [660, 350, 'right', 'bottom']);
});

test('a point menu that fits neither way is clamped inside the 12px margin', () => {
  const p = placeMenu({ x: 5, y: 300 }, { width: 240, height: 500 }, viewport);
  assert.equal(p.left, 12);
  assert.ok(p.top >= 12 && p.top + 500 <= 700 - 12);
});

test('a menu taller than the window scrolls inside it', () => {
  const p = placeMenu({ x: 100, y: 100 }, { width: 240, height: 2000 }, viewport);
  assert.equal(p.top, 12);
  assert.equal(p.maxHeight, 676);
});

test('a dropdown sits below its button, aligned left, and flips above when there is no room', () => {
  const rect = { left: 50, top: 100, right: 78, bottom: 128 };
  const below = placeMenu({ rect }, size, viewport);
  assert.deepEqual([below.left, below.top, below.originY], [50, 132, 'top']);
  const low = { left: 50, top: 600, right: 78, bottom: 628 };
  const above = placeMenu({ rect: low }, size, viewport);
  assert.deepEqual([above.top, above.originY], [600 - 4 - 300, 'bottom']);
});

test('a dropdown near the right edge aligns its right edge with the button', () => {
  const rect = { left: 940, top: 100, right: 968, bottom: 128 };
  const p = placeMenu({ rect }, size, viewport);
  assert.equal(p.left, 968 - 240);
  assert.equal(p.originX, 'right');
});

test('placement "above" prefers the space above the anchor', () => {
  const rect = { left: 10, top: 650, right: 200, bottom: 690 };
  const p = placeMenu({ rect, placement: 'above' }, { width: 240, height: 120 }, viewport);
  assert.equal(p.top, 650 - 4 - 120);
  assert.equal(p.originY, 'bottom');
});

test('a dropdown with no room on either side takes the roomier side and scrolls', () => {
  const rect = { left: 10, top: 300, right: 40, bottom: 330 };
  const p = placeMenu({ rect }, { width: 240, height: 600 }, viewport);
  assert.equal(p.top, 334);
  assert.equal(p.maxHeight, 700 - 12 - 334);
});

test('placement "right" opens beside the anchor and flips left at the edge', () => {
  const right = placeMenu({ rect: { left: 100, top: 100, right: 300, bottom: 128 }, placement: 'right' }, size, viewport);
  assert.equal(right.left, 304);
  const flipped = placeMenu({ rect: { left: 700, top: 100, right: 900, bottom: 128 }, placement: 'right' }, size, viewport);
  assert.equal(flipped.left, 700 - 4 - 240);
});

test('a submenu opens to the right of its parent, level with the trigger, and flips left', () => {
  const panel = { left: 100, top: 100, right: 340, bottom: 400 };
  const trigger = { left: 105, top: 150, right: 335, bottom: 178 };
  const p = placeSubmenu(panel, trigger, { width: 240, height: 100 }, viewport);
  assert.deepEqual([p.left, p.top], [336, 145]);
  const wide = { left: 700, top: 100, right: 940, bottom: 400 };
  const q = placeSubmenu(wide, { ...trigger, left: 705, right: 935 }, { width: 240, height: 100 }, viewport);
  assert.equal(q.left, 704 - 240);
  assert.equal(q.originX, 'right');
});

test('a submenu keeps opening left once its parent did, when there is room', () => {
  const panel = { left: 400, top: 100, right: 640, bottom: 400 };
  const trigger = { left: 405, top: 150, right: 635, bottom: 178 };
  const right = placeSubmenu(panel, trigger, { width: 240, height: 100 }, viewport);
  assert.equal(right.left, 636);
  const left = placeSubmenu(panel, trigger, { width: 240, height: 100 }, viewport, undefined, true);
  assert.deepEqual([left.left, left.originX], [404 - 240, 'right']);
  const noRoom = placeSubmenu({ ...panel, left: 100, right: 340 }, trigger, { width: 240, height: 100 }, viewport, undefined, true);
  assert.equal(noRoom.left, 336);
});

test('formatShortcut uses glyphs on macOS and words elsewhere', () => {
  assert.equal(formatShortcut('Mod+Shift+N', true), '⇧⌘N');
  assert.equal(formatShortcut('Mod+Shift+N', false), 'Ctrl+Shift+N');
  assert.equal(formatShortcut('Ctrl+Mod+N', true), '⌃⌘N');
  assert.equal(formatShortcut('Ctrl+Alt+N', false), 'Ctrl+Alt+N');
  assert.equal(formatShortcut('Mod+Backspace', true), '⌘⌫');
  assert.equal(formatShortcut('Delete', false), 'Del');
  assert.equal(formatShortcut('Enter', true), '↩\uFE0E');
  assert.equal(formatShortcut('Enter', false), 'Enter');
  assert.equal(formatShortcut('Alt+ArrowRight', true), '⌥→');
  assert.equal(formatShortcut('F2', false), 'F2');
  assert.equal(formatShortcut('mod+d', true), '⌘D');
});

test('ariaKeyShortcuts turns display labels into aria-keyshortcuts values', () => {
  assert.equal(ariaKeyShortcuts('⇧⌘N'), 'Shift+Meta+N');
  assert.equal(ariaKeyShortcuts('⌃⌘N'), 'Control+Meta+N');
  assert.equal(ariaKeyShortcuts('⌘⌫'), 'Meta+Backspace');
  assert.equal(ariaKeyShortcuts('↩'), 'Enter');
  assert.equal(ariaKeyShortcuts(formatShortcut('Enter', true)), 'Enter');
  assert.equal(ariaKeyShortcuts(formatShortcut('Mod+Enter', true)), 'Meta+Enter');
  assert.equal(ariaKeyShortcuts('⌥→'), 'Alt+ArrowRight');
  assert.equal(ariaKeyShortcuts('Ctrl+Shift+N'), 'Control+Shift+N');
  assert.equal(ariaKeyShortcuts('Del'), 'Delete');
  assert.equal(ariaKeyShortcuts('Shift+F10'), 'Shift+F10');
  assert.equal(ariaKeyShortcuts('F2'), 'F2');
  assert.equal(ariaKeyShortcuts(''), undefined);
  assert.equal(ariaKeyShortcuts(undefined), undefined);
  assert.equal(ariaKeyShortcuts('Hello+World'), undefined);
});

test('type-ahead ignores case and accents, cycles on a repeated letter and extends a prefix', () => {
  const labels = ['Conectar', 'Copiar endereço', 'Renomear', 'Ações', 'Duplicar', 'Excluir'];
  assert.equal(foldLabel('Ações'), 'acoes');
  assert.equal(nextTypeaheadIndex(labels, -1, 'c'), 0);
  assert.equal(nextTypeaheadIndex(labels, 0, 'c'), 1);
  assert.equal(nextTypeaheadIndex(labels, 1, 'c'), 0);
  assert.equal(nextTypeaheadIndex(labels, 0, 'cc'), 1);
  assert.equal(nextTypeaheadIndex(labels, 0, 'cop'), 1);
  assert.equal(nextTypeaheadIndex(labels, 1, 'co'), 1);
  assert.equal(nextTypeaheadIndex(labels, -1, 'a'), 3);
  assert.equal(nextTypeaheadIndex(labels, 2, 'e'), 5);
  assert.equal(nextTypeaheadIndex(labels, 2, 'z'), -1);
  assert.equal(nextTypeaheadIndex([], -1, 'a'), -1);
});
