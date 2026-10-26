/**
 * Search for the connections tree: a plain-text query grammar (words AND together, `key:value`
 * qualifiers with commas for OR, `-` to negate, quotes for spaces), matching, ranking, highlight
 * ranges, and the helpers the filter menu and the summary pills use to edit the text.
 *
 * The text is the only source of truth; pills and checkboxes are derived from it.
 *
 *   query     := token (WS+ token)*
 *   token     := '-'? (qualifier | word)
 *   qualifier := key ':' value (',' value)*      key case-insensitive; commas = OR
 *   value     := bare | '"' any-but-quote '"'
 *   word      := bare | '"' phrase '"'           words AND together
 *
 * Pure (no React, no i18n): tested with `node --test`.
 */
import type { ConnectionConfig, Protocol } from '../../types.ts';
import type { FolderNode, SearchResult, TreeModel } from './types.ts';
import {
  LOCAL_ID,
  authKind,
  canonicalProtocol,
  duplicateCounts,
  duplicateKey,
  folderChain,
  fold,
  isLocalSite,
  naturalCompare,
  needsPassword,
  normalizeGroup,
  protocolTag,
} from './siteTreeModel.ts';

/* -------------------------------------------------------------------------- */
/* Addresses                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * `user@host:port`, `sftp://user@host:2222/path`, `s3://endpoint`, `https://endpoint`.
 * Moved here from LoginDialog's `splitHostInput`, which uses `parseAddressInput`.
 */
export const ADDRESS_RE = /^(?:(sftp|scp|ftps|ftpes|ftp|s3|https?):\/\/)?(?:([^@\s/]+)@)?([^:/\s]+)(?::(\d{1,5}))?(\/[^\s]*)?$/i;

export interface ParsedAddress {
  /** Scheme as typed, lowercase (`null` when none) */
  scheme: string | null;
  /** Protocol the scheme selects (`ftpes` → `ftps`); `null` for none or http(s) */
  protocol: Protocol | null;
  /** http(s):// — an S3 endpoint that keeps its URL form: the host field is left as typed */
  httpEndpoint: boolean;
  user: string | null;
  host: string;
  port: string | null;
  path: string | null;
}

/**
 * Splits a pasted address into fields, with the same rules as LoginDialog's `splitHostInput`:
 * `null` unless the text matches and has a scheme, a user, a port or a path.
 */
export const parseAddressInput = (raw: string): ParsedAddress | null => {
  const value = raw.trim();
  const m = value.match(ADDRESS_RE);
  if (!m || !(m[1] || m[2] || m[4] || m[5])) return null;
  const [, scheme, user, host, port, path] = m;
  const lower = scheme ? scheme.toLowerCase() : null;
  const httpEndpoint = !!lower && /^https?$/.test(lower);
  const protocol = !lower || httpEndpoint ? null : ((lower === 'ftpes' ? 'ftps' : lower) as Protocol);
  return { scheme: lower, protocol, httpEndpoint, user: user ?? null, host, port: port ?? null, path: path ?? null };
};

/**
 * True when search text reads as an address worth offering "New connection to …" for: it matches
 * `ADDRESS_RE` and has a scheme, `user@` or `:port`, or contains a dot.
 */
export const looksLikeAddress = (raw: string): boolean => {
  const value = raw.trim();
  const m = value.match(ADDRESS_RE);
  return !!m && !!(m[1] || m[2] || m[4] || value.includes('.'));
};

/* -------------------------------------------------------------------------- */
/* Parsing                                                                     */
/* -------------------------------------------------------------------------- */

export type QualifierKey = 'p' | 'in' | 'host' | 'user' | 'port' | 'is' | 'auth' | 'label';

const KEY_ALIASES: Record<string, QualifierKey> = {
  p: 'p',
  proto: 'p',
  protocol: 'p',
  in: 'in',
  host: 'host',
  user: 'user',
  port: 'port',
  is: 'is',
  auth: 'auth',
  label: 'label',
};

export type IsValue = 'fav' | 'recent' | 'open' | 'unfiled' | 'empty' | 'dup' | 'nopass';

const PROTOCOL_ALIASES: Record<string, string> = {
  sftp: 'sftp',
  ssh: 'sftp',
  scp: 'sftp',
  ftp: 'ftp',
  ftps: 'ftps',
  ftpes: 'ftps',
  s3: 's3',
  webdav: 'webdav',
  local: 'local',
};

const IS_ALIASES: Record<string, IsValue> = {
  fav: 'fav',
  favs: 'fav',
  favorite: 'fav',
  favorites: 'fav',
  favourite: 'fav',
  favourites: 'fav',
  star: 'fav',
  starred: 'fav',
  recent: 'recent',
  open: 'open',
  connected: 'open',
  unfiled: 'unfiled',
  empty: 'empty',
  dup: 'dup',
  dups: 'dup',
  duplicate: 'dup',
  duplicates: 'dup',
  nopass: 'nopass',
  nopassword: 'nopass',
};

const AUTH_ALIASES: Record<string, string> = {
  password: 'password',
  pass: 'password',
  pw: 'password',
  key: 'key',
  agent: 'agent',
  none: 'none',
};

export interface QueryToken {
  /** Position among the tokens */
  index: number;
  /** Span in the text, `[start, end)` */
  start: number;
  end: number;
  raw: string;
  negated: boolean;
  /** `null` for a plain word */
  key: QualifierKey | null;
  /** The key as typed (`proto`), kept when the token is rewritten */
  keyText: string | null;
  /** Unquoted values (a word has one) */
  values: string[];
  /** Folded values, index-aligned; protocol, `is:` and `auth:` values are canonical (`ssh` → `sftp`) */
  folded: string[];
}

export interface ParsedQuery {
  text: string;
  tokens: QueryToken[];
  /** Words with text */
  words: QueryToken[];
  /** Qualifiers with at least one value (an unfinished `p:` is ignored) */
  qualifiers: QueryToken[];
  hasQualifiers: boolean;
  /** Nothing to filter on */
  isEmpty: boolean;
}

const WS = /\s/;

/** Splits a qualifier value list on commas outside quotes. */
const splitValues = (s: string): string[] => {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (const c of s) {
    if (c === '"') quoted = !quoted;
    else if (c === ',' && !quoted) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.map((v) => v.trim()).filter(Boolean);
};

/** Canonical folded form of a value for `key`. */
export const canonicalValue = (key: QualifierKey | null, value: string): string => {
  const f = fold(value.trim());
  if (key === 'p') return PROTOCOL_ALIASES[f] ?? f;
  if (key === 'is') return IS_ALIASES[f] ?? f;
  if (key === 'auth') return AUTH_ALIASES[f] ?? f;
  if (key === 'in') return normalizeGroup(f);
  return f;
};

/** Parses search text. Never throws; unknown keys (`foo:bar`) are plain words. */
export function parseQuery(text: string): ParsedQuery {
  const tokens: QueryToken[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    while (i < n && WS.test(text[i])) i++;
    if (i >= n) break;
    const start = i;
    let quoted = false;
    while (i < n) {
      const c = text[i];
      if (c === '"') quoted = !quoted;
      else if (!quoted && WS.test(c)) break;
      i++;
    }
    const raw = text.slice(start, i);
    let body = raw;
    let negated = false;
    if (body.length > 1 && body[0] === '-') {
      negated = true;
      body = body.slice(1);
    } else if (body === '-') {
      continue;
    }
    const m = /^([A-Za-z]+):([\s\S]*)$/.exec(body);
    const key = m ? KEY_ALIASES[m[1].toLowerCase()] : undefined;
    if (m && key) {
      const values = splitValues(m[2]);
      tokens.push({ index: tokens.length, start, end: i, raw, negated, key, keyText: m[1], values, folded: values.map((v) => canonicalValue(key, v)) });
    } else {
      const word = body.replace(/"/g, '').trim();
      tokens.push({ index: tokens.length, start, end: i, raw, negated, key: null, keyText: null, values: word ? [word] : [], folded: word ? [fold(word)] : [] });
    }
  }
  const words = tokens.filter((t) => t.key === null && t.values.length > 0);
  const qualifiers = tokens.filter((t) => t.key !== null && t.values.length > 0);
  return { text, tokens, words, qualifiers, hasQualifiers: qualifiers.length > 0, isEmpty: words.length === 0 && qualifiers.length === 0 };
}

/* -------------------------------------------------------------------------- */
/* Editing the text (filter menu, pills)                                       */
/* -------------------------------------------------------------------------- */

const quoteIfNeeded = (v: string): string => {
  const clean = v.replace(/"/g, '');
  return /[\s,]/.test(clean) ? `"${clean}"` : clean;
};

const formatToken = (key: string, values: string[], negated = false): string => `${negated ? '-' : ''}${key}:${values.map(quoteIfNeeded).join(',')}`;

/** Removes `[start, end)` and the spaces around it, keeping one space between the neighbours. */
const removeSpan = (text: string, start: number, end: number): string => {
  const before = text.slice(0, start).replace(/\s+$/, '');
  const after = text.slice(end).replace(/^\s+/, '');
  return before && after ? `${before} ${after}` : before + after;
};

const replaceSpan = (text: string, start: number, end: number, replacement: string): string => text.slice(0, start) + replacement + text.slice(end);

const appendToken = (text: string, token: string): string => {
  const base = text.replace(/\s+$/, '');
  return base ? `${base} ${token}` : token;
};

/**
 * Turns one qualifier value on or off in the text (the filter menu's checkboxes).
 * `is:` values are separate tokens (AND); other keys share one token with commas (OR).
 * Turning a value on and then off again gives back the original text.
 */
export function toggleQualifier(text: string, key: QualifierKey, value: string, on: boolean): string {
  const q = parseQuery(text);
  const canon = canonicalValue(key, value);
  const mine = q.tokens.filter((t) => t.key === key && !t.negated);
  if (on) {
    if (mine.some((t) => t.folded.includes(canon))) return text;
    const unfinished = mine.find((t) => t.values.length === 0);
    if (unfinished) return replaceSpan(text, unfinished.start, unfinished.end, formatToken(unfinished.keyText ?? key, [value]));
    const shared = key === 'is' ? undefined : mine[0];
    if (shared) return replaceSpan(text, shared.start, shared.end, formatToken(shared.keyText ?? key, [...shared.values, value]));
    return appendToken(text, formatToken(key, [value]));
  }
  let out = text;
  // Right to left, so earlier spans stay valid
  for (const t of [...mine].reverse()) {
    if (!t.folded.includes(canon)) continue;
    const keep = t.values.filter((_, i) => t.folded[i] !== canon);
    out = keep.length ? replaceSpan(out, t.start, t.end, formatToken(t.keyText ?? key, keep)) : removeSpan(out, t.start, t.end);
  }
  return out;
}

/** Removes the token at `index` (a pill's ×). */
export function removeToken(text: string, index: number): string {
  const t = parseQuery(text).tokens[index];
  return t ? removeSpan(text, t.start, t.end) : text;
}

/** Removes every qualifier and keeps the words ("Clear filters"). */
export function clearQualifiers(text: string): string {
  let out = text;
  for (const t of [...parseQuery(text).tokens].reverse()) if (t.key !== null) out = removeSpan(out, t.start, t.end);
  return out;
}

/** Canonical values of the positive tokens with `key` (checkbox state in the filter menu). */
export function activeValues(q: ParsedQuery, key: QualifierKey): Set<string> {
  const out = new Set<string>();
  for (const t of q.qualifiers) if (t.key === key && !t.negated) t.folded.forEach((v) => out.add(v));
  return out;
}

export interface TokenPill {
  /** Token index, for `removeToken` */
  index: number;
  key: QualifierKey;
  negated: boolean;
  /** Canonical values for `p`, `is` and `auth`; the typed values for the others */
  values: string[];
}

/** One pill per qualifier, for the summary row ("Protocol: SFTP, FTPS", "Not: FTP"). */
export function describeTokens(q: ParsedQuery): TokenPill[] {
  return q.qualifiers.map((t) => ({
    index: t.index,
    key: t.key as QualifierKey,
    negated: t.negated,
    values: t.key === 'p' || t.key === 'is' || t.key === 'auth' ? [...new Set(t.folded)] : t.values,
  }));
}

/** Display text of a canonical protocol value ("sftp" → "SFTP"). */
export const protocolValueLabel = (v: string): string => protocolTag(v);

/** The address-row text when the query is just an address, else `null`. */
export function addressFromQuery(q: ParsedQuery): string | null {
  if (q.tokens.length !== 1 || q.hasQualifiers || q.tokens[0].negated || q.tokens[0].key !== null) return null;
  const text = q.text.trim();
  return looksLikeAddress(text) ? text : null;
}

/* -------------------------------------------------------------------------- */
/* Matching                                                                    */
/* -------------------------------------------------------------------------- */

/** Folded fields of a site, built once per site object. */
export interface SearchRecord {
  name: string;
  host: string;
  user: string;
  /** Folder path ('' at the top level) */
  path: string;
  segments: string[];
  tag: string;
  port: string;
  /** Everything a plain word can match, newline-joined */
  hay: string;
}

const records = new WeakMap<ConnectionConfig, SearchRecord>();

/** Search record of a site; cached per object, so replacing `savedSites` invalidates it. */
export function buildSearchRecord(site: ConnectionConfig): SearchRecord {
  const cached = records.get(site);
  if (cached) return cached;
  const name = fold(site.name || '');
  const host = fold(site.host || '');
  const user = fold(site.username || '');
  const path = isLocalSite(site) ? '' : fold(normalizeGroup(site.group));
  const tag = fold(protocolTag(site.protocol));
  const port = site.port ? String(site.port) : '';
  const rec: SearchRecord = {
    name,
    host,
    user,
    path,
    segments: path ? path.split('/') : [],
    tag,
    port,
    hay: [name, host, user, path, tag, port, user ? `${user}@${host}` : host, port ? `${host}:${port}` : host].join('\n'),
  };
  records.set(site, rec);
  return rec;
}

export interface MatchContext {
  /** Milliseconds (`Date.now()`) */
  nowMs: number;
  favoriteSites: ReadonlySet<string>;
  favoriteFolders: ReadonlySet<string>;
  /** Site id → `recents.at` (Unix seconds; null when unknown) */
  recentAt: ReadonlyMap<string, number | null>;
  /** Ids of sites with an open tab (WP8) */
  openSiteIds?: ReadonlySet<string>;
  /** `duplicateKey` → number of saved sites with it */
  dupCounts: ReadonlyMap<string, number>;
  /** Site id → effective label name */
  siteLabelName: (siteId: string) => string | null;
  /** Folder path → effective label name */
  folderLabelName: (path: string) => string | null;
}

const dupCache = new WeakMap<TreeModel, Map<string, number>>();

/** Context for matching against a built tree. */
export function matchContext(model: TreeModel, opts: { nowMs?: number; openSiteIds?: ReadonlySet<string> } = {}): MatchContext {
  let dups = dupCache.get(model);
  if (!dups) {
    dups = duplicateCounts(model.sitesById.values());
    dupCache.set(model, dups);
  }
  const labelName = (id: string | null | undefined) => (id ? model.labels.get(id)?.name ?? null : null);
  return {
    nowMs: opts.nowMs ?? Date.now(),
    favoriteSites: model.favoriteSites,
    favoriteFolders: model.favoriteFolders,
    recentAt: model.recentAt,
    openSiteIds: opts.openSiteIds,
    dupCounts: dups,
    siteLabelName: (id) => labelName(model.siteLabel.get(id)),
    folderLabelName: (path) => labelName(model.folders.get(path)?.effectiveLabel),
  };
}

const DAY_SECS = 86_400;

const isRecent = (ctx: MatchContext, id: string, days: number): boolean => {
  if (!ctx.recentAt.has(id)) return false;
  const at = ctx.recentAt.get(id);
  // Entries seeded from older data have no time: they still count as recently used
  if (at == null) return days >= 30;
  return ctx.nowMs / 1000 - at <= days * DAY_SECS;
};

const underFavoriteFolder = (ctx: MatchContext, rawPath: string): boolean =>
  ctx.favoriteFolders.size > 0 && folderChain(rawPath).some((p) => ctx.favoriteFolders.has(p));

/** `in:` — a segment starts with the value, or the path does when the value contains '/'. */
const inFolder = (segments: string[], path: string, value: string): boolean => {
  if (!value) return false;
  if (value.includes('/')) return path === value || path.startsWith(value);
  return segments.some((s) => s.startsWith(value));
};

const siteTokenMatches = (site: ConnectionConfig, rec: SearchRecord, t: QueryToken, ctx: MatchContext): boolean => {
  const local = isLocalSite(site);
  switch (t.key) {
    case null: {
      const v = t.folded[0];
      if (rec.hay.includes(v)) return true;
      const label = ctx.siteLabelName(site.id);
      return !!label && fold(label).includes(v);
    }
    case 'p': {
      const p = local ? 'local' : canonicalProtocol(site.protocol);
      return t.folded.includes(p);
    }
    case 'in':
      return t.folded.some((v) => inFolder(rec.segments, rec.path, v));
    case 'host':
      return t.folded.some((v) => rec.host.includes(v));
    case 'user':
      return t.folded.some((v) => rec.user.includes(v));
    case 'port':
      return t.folded.some((v) => String(site.port ?? '') === v.replace(/^:/, ''));
    case 'auth':
      return !local && t.folded.includes(authKind(site));
    case 'label': {
      const label = ctx.siteLabelName(site.id);
      return !!label && t.folded.some((v) => fold(label).startsWith(v));
    }
    case 'is':
      return t.folded.some((v) => {
        switch (v) {
          case 'fav':
            return ctx.favoriteSites.has(site.id) || (!local && underFavoriteFolder(ctx, normalizeGroup(site.group)));
          case 'recent':
            return isRecent(ctx, site.id, 30);
          case 'open':
            return !!ctx.openSiteIds?.has(site.id);
          case 'unfiled':
            return !local && !normalizeGroup(site.group);
          case 'dup': {
            const k = duplicateKey(site);
            return !!k && (ctx.dupCounts.get(k) ?? 0) >= 2;
          }
          case 'nopass':
            return needsPassword(site);
          default:
            return false;
        }
      });
    default:
      return false;
  }
};

/** True when the site satisfies every token (negated tokens must not match). */
export function matchSite(site: ConnectionConfig, q: ParsedQuery, ctx: MatchContext): boolean {
  const rec = buildSearchRecord(site);
  for (const t of q.tokens) {
    if (t.folded.length === 0) continue;
    const hit = siteTokenMatches(site, rec, t, ctx);
    if (hit === t.negated) return false;
  }
  return true;
}

/**
 * Folders match on their own only when they hold no connections (so empty folders can be found):
 * words and `in:` against the path, `is:empty`, `is:fav`, `label:`. Site-only qualifiers never match.
 */
export function matchFolder(node: FolderNode, q: ParsedQuery, ctx: MatchContext): boolean {
  if (!node.path || node.count > 0) return false;
  const path = fold(node.path);
  const segments = path.split('/');
  for (const t of q.tokens) {
    if (t.folded.length === 0) continue;
    let hit: boolean;
    switch (t.key) {
      case null: {
        const label = ctx.folderLabelName(node.path);
        hit = path.includes(t.folded[0]) || (!!label && fold(label).includes(t.folded[0]));
        break;
      }
      case 'in':
        hit = t.folded.some((v) => inFolder(segments, path, v));
        break;
      case 'is':
        hit = t.folded.some((v) => v === 'empty' || (v === 'fav' && underFavoriteFolder(ctx, node.path)));
        break;
      case 'label': {
        const label = ctx.folderLabelName(node.path);
        hit = !!label && t.folded.some((v) => fold(label).startsWith(v));
        break;
      }
      default:
        hit = false;
    }
    if (hit === t.negated) return false;
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/* Ranking ("results as a list")                                               */
/* -------------------------------------------------------------------------- */

const WORD_SPLIT = /[\s\-_.@/:]+/;

const nameScore = (name: string, v: string): number => {
  if (name === v) return 100;
  if (name.startsWith(v)) return 80;
  if (name.split(WORD_SPLIT).some((w) => w.startsWith(v))) return 60;
  if (name.includes(v)) return 40;
  return 0;
};

/**
 * Rank of a matching site: per positive word, the best of exact name 100, name starts 80, a word
 * of the name starts 60, name contains 40, host starts 35, host contains 25, user 15, folder 10;
 * plus 10 when used in the last 7 days and 5 for a favorite.
 */
export function rankSite(site: ConnectionConfig, q: ParsedQuery, ctx: MatchContext): number {
  const rec = buildSearchRecord(site);
  let score = 0;
  for (const t of q.words) {
    if (t.negated) continue;
    const v = t.folded[0];
    score += Math.max(
      nameScore(rec.name, v),
      rec.host.startsWith(v) ? 35 : rec.host.includes(v) ? 25 : 0,
      rec.user.includes(v) ? 15 : 0,
      rec.path.includes(v) ? 10 : 0
    );
  }
  if (isRecent(ctx, site.id, 7)) score += 10;
  if (ctx.favoriteSites.has(site.id)) score += 5;
  return score;
}

const rankFolder = (node: FolderNode, q: ParsedQuery, ctx: MatchContext): number => {
  const name = fold(node.name);
  let score = 0;
  for (const t of q.words) if (!t.negated) score += Math.max(nameScore(name, t.folded[0]), fold(node.path).includes(t.folded[0]) ? 10 : 0);
  if (ctx.favoriteFolders.has(node.path)) score += 5;
  return score;
};

/* -------------------------------------------------------------------------- */
/* Search over a tree                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Runs a parsed query over the tree. With `asList`, also ranks the matches (ties keep natural
 * name order). Target: well under 8 ms for 3,000 sites (records are cached per site object).
 */
export function searchTree(model: TreeModel, q: ParsedQuery, ctx: MatchContext, opts: { asList?: boolean } = {}): SearchResult {
  const siteIds = new Set<string>();
  for (const site of model.sitesById.values()) if (matchSite(site, q, ctx)) siteIds.add(site.id);
  const folderPaths = new Set<string>();
  for (const node of model.folders.values()) if (node.path && node.count === 0 && matchFolder(node, q, ctx)) folderPaths.add(node.path);
  if (!opts.asList) return { siteIds, folderPaths };

  const scored: Array<{ key: string; score: number; name: string; tie: string }> = [];
  for (const id of siteIds) {
    const site = model.sitesById.get(id) as ConnectionConfig;
    scored.push({ key: `s:${id}`, score: id === LOCAL_ID ? -1 : rankSite(site, q, ctx), name: site.name || '', tie: id });
  }
  for (const path of folderPaths) {
    const node = model.folders.get(path) as FolderNode;
    scored.push({ key: `f:${path}`, score: rankFolder(node, q, ctx), name: node.name, tie: path });
  }
  scored.sort((a, b) => b.score - a.score || naturalCompare(a.name, b.name) || (a.tie < b.tie ? -1 : a.tie > b.tie ? 1 : 0));
  return { siteIds, folderPaths, ranked: scored.map((s) => s.key) };
}

/* -------------------------------------------------------------------------- */
/* Highlighting                                                                */
/* -------------------------------------------------------------------------- */

/** Folded terms to highlight in a field: positive words, plus `host:` / `user:` on the address and `in:` on the path. */
export function highlightTerms(q: ParsedQuery, field: 'name' | 'address' | 'path'): string[] {
  const terms: string[] = [];
  for (const t of q.tokens) {
    if (t.negated || t.folded.length === 0) continue;
    if (t.key === null) terms.push(t.folded[0]);
    else if (field === 'address' && (t.key === 'host' || t.key === 'user')) terms.push(...t.folded);
    else if (field === 'path' && t.key === 'in') terms.push(...t.folded);
  }
  return terms.filter(Boolean);
}

/**
 * `[start, end)` ranges of `text` (original indices) where any folded term occurs, merged and
 * sorted. Folding is done character by character, so accents and case are ignored and the ranges
 * still line up with the original text.
 */
export function matchRanges(text: string, terms: readonly string[]): Array<[number, number]> {
  if (!text || terms.length === 0) return [];
  let folded = '';
  // For each folded code unit: [start, end) of the original character it came from
  const origin: Array<[number, number]> = [];
  let i = 0;
  for (const ch of text) {
    const f = fold(ch);
    for (let k = 0; k < f.length; k++) origin.push([i, i + ch.length]);
    folded += f;
    i += ch.length;
  }
  const ranges: Array<[number, number]> = [];
  for (const term of terms) {
    if (!term) continue;
    let from = 0;
    for (;;) {
      const at = folded.indexOf(term, from);
      if (at < 0) break;
      ranges.push([origin[at][0], origin[at + term.length - 1][1]]);
      from = at + Math.max(1, term.length);
    }
  }
  if (ranges.length === 0) return ranges;
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [ranges[0]];
  for (const r of ranges.slice(1)) {
    const last = merged[merged.length - 1];
    if (r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}
