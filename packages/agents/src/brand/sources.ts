import * as cheerio from 'cheerio';
import { chroma, colorDistance, isNearBlack, isNearWhite, isNeutral, parseAnyColor, parseColor } from './color-parse';
import type { BrandCandidate, BrandRole, EvidenceTier } from './types';

/**
 * Brand colors out of TEXT SOURCES: CSS, Tailwind-style config files, design-token JSON, brand-guideline text and HTML. Everything here
 * is plain string/regex/JSON work on untrusted input: no code is evaluated, nothing is fetched, and results are capped. A function returns
 * candidates; it never decides the palette (that is ./suggest.ts).
 */

const MAX_TEXT = 400_000;
const MAX_CANDIDATES = 60;

// ---- names -> roles ----------------------------------------------------------------------------------------------------------------------

interface RoleHint {
  role: BrandRole;
  weight: number;
}

const IGNORED = /(^|[-_.\s])(muted|border|input|ring|destructive|danger|error|warning|warn|success|info|shadow|popover|chart|sidebar|overlay|disabled|placeholder|hover|focus|active|gradient|selection|scrollbar|code|syntax)([-_.\s]|$)/;
const ON_COLOR = /(-foreground$|^on[-_]|[-_]on[-_]|contrast)/;

/**
 * "--primary", "color-primary-500", "brandBlue", "theme.colors.accent" -> the role the name says. Variable names are the strongest hint we
 * have: a color called `primary` is the brand's own decision, a color found on some element is only evidence of use.
 */
export function roleOfName(raw: string): RoleHint | null {
  const name = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/^(--)?(tw|color|colors|clr|brand-color|theme)[-_.]/, '')
    .replace(/[_.]/g, '-');
  if (!name || /(^|-)dark(mode)?(-|$)/.test(name) || IGNORED.test(name)) return null;
  const scale = /-(\d{2,3})$/.exec(name);
  const scaled = (w: number) => (scale ? (['500', '600', '400'].includes(scale[1]) ? w - 0.05 : w - 0.3) : w);
  if (ON_COLOR.test(name)) return null; // text on a brand color tells nothing about the page text color
  if (/(^|-)(primary|brand|main|theme)(-|$)/.test(name) && !/secondary/.test(name)) return { role: 'primary', weight: scaled(/^(primary|brand)$/.test(name) ? 0.95 : 0.85) };
  if (/(^|-)secondary(-|$)/.test(name)) return { role: 'secondary', weight: scaled(0.85) };
  if (/(^|-)(accent|highlight|cta|action)(-|$)/.test(name)) return { role: 'accent', weight: scaled(0.85) };
  if (/(^|-)(link)(-|$)/.test(name)) return { role: 'accent', weight: 0.5 };
  if (/(^|-)(background|bg|surface|canvas|paper|page|body-bg)(-|$)/.test(name) && !/(btn|button|card|header|nav|footer)/.test(name)) return { role: 'background', weight: 0.7 };
  if (/(^|-)(foreground|text|ink|fg|body-color|font-color|content)(-|$)/.test(name) && !/(muted|secondary|light|inverse)/.test(name)) return { role: 'text', weight: 0.7 };
  return null;
}

// ---- CSS ---------------------------------------------------------------------------------------------------------------------------------

interface Rule {
  selector: string;
  decls: [string, string][];
}

/** Splits a declaration block at ';' outside parentheses in ONE pass (a regex lookahead here would be quadratic on hostile input). */
function splitDeclarations(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === ';' && depth === 0) {
      out.push(body.slice(start, i));
      start = i + 1;
    }
  }
  out.push(body.slice(start));
  return out;
}

/** A tolerant CSS reader: rules with their declarations. Rules inside a dark color-scheme media query are skipped; other @media blocks are flattened. */
export function cssRules(css: string): Rule[] {
  const text = css.slice(0, MAX_TEXT).replace(/\/\*[\s\S]*?\*\//g, ' ');
  const rules: Rule[] = [];
  let i = 0;
  const skipStack: boolean[] = [];
  let buf = '';
  while (i < text.length) {
    const ch = text[i];
    if (ch === '{') {
      const head = buf.trim();
      buf = '';
      if (head.startsWith('@')) {
        // an at-rule block: @media / @supports / @layer contain rules; @font-face / @keyframes / @page are skipped as a whole
        const isContainer = /^@(media|supports|layer|container|scope)\b/i.test(head);
        if (!isContainer) {
          let depth = 1;
          i++;
          while (i < text.length && depth > 0) {
            if (text[i] === '{') depth++;
            else if (text[i] === '}') depth--;
            i++;
          }
          continue;
        }
        skipStack.push(/prefers-color-scheme\s*:\s*dark/i.test(head));
        i++;
        continue;
      }
      // a style rule: read the declarations up to the matching close
      let depth = 1;
      let j = i + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === '{') depth++;
        else if (text[j] === '}') depth--;
        j++;
      }
      const body = text.slice(i + 1, j - 1);
      i = j;
      if (skipStack.some(Boolean)) continue;
      const decls: [string, string][] = [];
      for (const d of splitDeclarations(body)) {
        const k = d.indexOf(':');
        if (k > 0) decls.push([d.slice(0, k).trim().toLowerCase(), d.slice(k + 1).trim()]);
      }
      if (decls.length && head) rules.push({ selector: head.toLowerCase(), decls });
      if (rules.length > 4000) break;
      continue;
    }
    if (ch === '}') {
      skipStack.pop();
      buf = '';
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  return rules;
}

const LIGHT_SCOPE = /^(:root|html|body|\*|:host|\[data-theme=["']?light["']?\]|\.light)(\s*,\s*(:root|html|body|\*))*$/;
const isDarkScope = (sel: string) => /dark|night|\[data-theme=["']?dark/.test(sel);

type Source = { tier: EvidenceTier; label: string };

const push = (out: BrandCandidate[], c: BrandCandidate) => {
  if (out.length < MAX_CANDIDATES) out.push(c);
};

/** Custom properties (variables) of the light/root scope, with one level of var() resolved. */
export function cssVariables(rules: Rule[]): Map<string, string> {
  const vars = new Map<string, string>();
  for (const r of rules) {
    if (isDarkScope(r.selector)) continue;
    if (!r.selector.split(',').some((s) => LIGHT_SCOPE.test(s.trim()) || /^\.theme|^\.root|^\[data-theme/.test(s.trim()))) continue;
    for (const [k, v] of r.decls) if (k.startsWith('--') && !vars.has(k)) vars.set(k, v);
  }
  for (const [k, v] of vars) {
    const ref = /^var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)$/.exec(v);
    if (ref && vars.has(ref[1])) vars.set(k, vars.get(ref[1])!);
  }
  return vars;
}

/**
 * Brand colors of a stylesheet. Declared variables named like roles are DESIGN TOKENS (tier 2). Colors used on buttons, headers, the page body
 * and links are VISIBLE BRANDING (the tier the caller gives). A page background is only ever a background candidate: a white page does not
 * make white the brand's primary color.
 */
export function brandFromCss(css: string, from: Source & { tokenTier?: EvidenceTier }): BrandCandidate[] {
  const out: BrandCandidate[] = [];
  const rules = cssRules(css);
  const tokenTier = from.tokenTier ?? 2;

  for (const [name, value] of cssVariables(rules)) {
    const hint = roleOfName(name.slice(2));
    const hex = hint && parseAnyColor(value);
    if (!hint || !hex) continue;
    push(out, { hex, role: hint.role, tier: tokenTier, weight: hint.weight, evidence: `${from.label}: variable ${name}` });
  }

  // visible styling
  const buttonBg: string[] = [];
  const headerBg: string[] = [];
  let bodyBg: string | null = null;
  let bodyText: string | null = null;
  const linkColors: string[] = [];
  for (const r of rules) {
    if (isDarkScope(r.selector)) continue;
    const bg = r.decls.find(([k]) => k === 'background-color' || k === 'background')?.[1];
    const bgHex = bg ? parseColor(bg.split(/\s+(?![^(]*\))/).find((p) => parseColor(p)) ?? bg) : null;
    const fg = r.decls.find(([k]) => k === 'color')?.[1];
    const fgHex = fg ? parseColor(fg) : null;
    for (const sel of r.selector.split(',').map((s) => s.trim())) {
      if (/(^|[\s.#\[])(btn|button|cta)([-_.\s:#\[\]=\w"']*)?$/.test(sel) && !/(disabled|ghost|outline|link|secondary|danger|close)/.test(sel) && bgHex && !isNeutral(bgHex)) buttonBg.push(bgHex);
      else if (/^(header|\.header|\.site-header|\.navbar|\.nav|nav|\.topbar|#header)(\s|$|\.|:)/.test(sel) && bgHex && !isNearWhite(bgHex)) headerBg.push(bgHex);
      else if (/^(body|html)$/.test(sel)) {
        if (bgHex && !bodyBg) bodyBg = bgHex;
        if (fgHex && !bodyText) bodyText = fgHex;
      } else if (/^(a|a:link|\.link)$/.test(sel) && fgHex && !isNeutral(fgHex)) linkColors.push(fgHex);
    }
  }
  const mode = (list: string[]) => {
    const n = new Map<string, number>();
    for (const c of list) n.set(c, (n.get(c) ?? 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  };
  const buttons = mode(buttonBg);
  if (buttons[0]) push(out, { hex: buttons[0][0], role: 'primary', tier: from.tier, weight: 0.75, evidence: `${from.label}: primary button color` });
  const secondButton = buttons.find(([c]) => colorDistance(c, buttons[0][0]) > 90);
  if (secondButton) push(out, { hex: secondButton[0], role: 'accent', tier: from.tier, weight: 0.55, evidence: `${from.label}: second button color` });
  const headers = mode(headerBg).filter(([c]) => !isNearBlack(c) || chroma(c) > 0.08);
  if (headers[0]) push(out, { hex: headers[0][0], role: isNeutral(headers[0][0]) ? 'text' : 'primary', tier: from.tier, weight: isNeutral(headers[0][0]) ? 0.4 : 0.6, evidence: `${from.label}: header or navigation background` });
  if (bodyBg) push(out, { hex: bodyBg, role: 'background', tier: from.tier, weight: 0.7, evidence: `${from.label}: page background` });
  if (bodyText) push(out, { hex: bodyText, role: 'text', tier: from.tier, weight: 0.7, evidence: `${from.label}: page text color` });
  const link = mode(linkColors)[0];
  if (link) push(out, { hex: link[0], role: 'accent', tier: from.tier, weight: 0.5, evidence: `${from.label}: link color` });
  return out;
}

// ---- Tailwind-style config and JS/TS theme objects (read as text, never executed) -------------------------------------------------------------

const COLOR_VALUE = /^(?:#[0-9a-fA-F]{3,8}|(?:rgba?|hsla?|oklch)\([^)]*\))$/;

/** Finds the text of the {...} block that starts at the first "{" after `from`, brace matched and string aware. */
function block(text: string, from: number): string | null {
  const start = text.indexOf('{', from);
  if (start < 0) return null;
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < text.length && i < start + 60_000; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote && text[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(start + 1, i);
  }
  return null;
}

/** Walks a loose `{ key: 'value', nested: { 500: '#..', DEFAULT: '#..' } }` object text into [path, value] pairs. No evaluation. */
function walkObject(body: string, path: string[], out: [string[], string][], depth = 0) {
  if (depth > 5 || out.length > 400) return;
  const re = /(["']?)([A-Za-z0-9_$-]+)\1\s*:\s*(?:(["'`])((?:(?!\3).)*)\3|\{)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    if (m[3] === undefined) {
      const inner = block(body, m.index + m[0].length - 1);
      if (inner !== null) {
        walkObject(inner, [...path, m[2]], out, depth + 1);
        re.lastIndex = m.index + m[0].length + inner.length + 1;
      }
    } else out.push([[...path, m[2]], m[4]]);
  }
}

export function brandFromTailwindConfig(text: string, from: Source): BrandCandidate[] {
  const out: BrandCandidate[] = [];
  const src = text.slice(0, MAX_TEXT);
  const pairs: [string[], string][] = [];
  const re = /\bcolors\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) && pairs.length < 400) {
    const b = block(src, m.index + m[0].length);
    if (b) walkObject(b, [], pairs);
  }
  const seen = new Set<string>();
  for (const [path, value] of pairs) {
    const hex = COLOR_VALUE.test(value.trim()) ? parseColor(value) : parseAnyColor(value);
    if (!hex) continue;
    // "primary.500" and "primary.DEFAULT" are one color token named primary; other steps of the scale are weaker
    const leaf = path[path.length - 1];
    const group = path.length > 1 ? path.slice(0, -1).join('-') : path[0];
    const hint = roleOfName(group + (path.length > 1 && /^\d+$/.test(leaf) ? `-${leaf}` : ''));
    if (!hint) continue;
    const key = `${hint.role}:${group}`;
    const isDefault = leaf === 'DEFAULT' || leaf === '500' || path.length === 1;
    if (!isDefault && seen.has(key)) continue;
    if (isDefault) seen.add(key);
    push(out, { hex, role: hint.role, tier: from.tier, weight: isDefault ? hint.weight : Math.min(hint.weight, 0.55), evidence: `${from.label}: color ${path.join('.')}` });
  }
  return out;
}

// ---- design-token JSON (Style Dictionary / Tokens Studio / W3C draft) --------------------------------------------------------------------------

export function brandFromTokensJson(json: unknown, from: Source): BrandCandidate[] {
  const out: BrandCandidate[] = [];
  const visit = (node: unknown, path: string[], depth: number) => {
    if (depth > 8 || out.length >= MAX_CANDIDATES || node === null || typeof node !== 'object') return;
    const o = node as Record<string, unknown>;
    const value = o.$value ?? o.value;
    if (typeof value === 'string') {
      const hex = parseAnyColor(value);
      const hint = hex && roleOfName(path.filter((p) => !/^(color|colors|brand|base|core|global|semantic)$/i.test(p)).join('-') || path.join('-'));
      if (hex && hint) push(out, { hex, role: hint.role, tier: from.tier, weight: hint.weight, evidence: `${from.label}: token ${path.join('.')}` });
      return;
    }
    for (const [k, v] of Object.entries(o)) if (!k.startsWith('$')) visit(v, [...path, k], depth + 1);
  };
  visit(json, [], 0);
  return out;
}

// ---- brand guidelines (text of documents) -----------------------------------------------------------------------------------------------------

const LABELS: [RegExp, BrandRole][] = [
  [/primary|main\s+brand|brand\s+colou?r|brand\s+blue|brand\s+green|brand\s+red/i, 'primary'],
  [/secondary/i, 'secondary'],
  [/accent|highlight|call\s*to\s*action|cta/i, 'accent'],
  [/background|surface|paper/i, 'background'],
  [/text|body\s+copy|ink|typography\s+colou?r/i, 'text'],
];

/**
 * Colors named in brand guideline TEXT ("Primary: #0A5CFF", "Accent color - rgb(255, 120, 0)"). A color is taken only when a role word is on
 * the same line and within 60 characters before it.
 */
export function brandFromGuidelinesText(text: string, from: Source): BrandCandidate[] {
  const out: BrandCandidate[] = [];
  for (const line of text.slice(0, MAX_TEXT).split(/\r?\n/).slice(0, 4000)) {
    const re = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b|rgba?\([^)]{5,40}\)|hsla?\([^)]{5,40}\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      const hex = parseColor(m[0]);
      if (!hex) continue;
      const before = line.slice(Math.max(0, m.index - 60), m.index);
      const label = LABELS.find(([r]) => r.test(before));
      if (label) push(out, { hex, role: label[1], tier: from.tier, weight: 0.9, evidence: `${from.label}: "${before.trim().slice(-30).replace(/["<>]/g, '')}" color` });
    }
  }
  return out;
}

// ---- HTML --------------------------------------------------------------------------------------------------------------------------------------

export interface HtmlBrand {
  candidates: BrandCandidate[];
  /** href of stylesheets, in document order (absolute URLs are resolved by the caller against the page URL) */
  stylesheets: string[];
  /** Image URLs that look like the site's logo or touch icon, best first */
  logoCandidates: string[];
}

export function brandFromHtml(html: string, from: Source): HtmlBrand {
  const $ = cheerio.load(html.slice(0, MAX_TEXT));
  const candidates: BrandCandidate[] = [];
  const theme = $('meta[name="theme-color"]').first().attr('content');
  const themeHex = theme ? parseColor(theme) : null;
  if (themeHex && !isNearWhite(themeHex)) push(candidates, { hex: themeHex, role: 'primary', tier: from.tier, weight: 0.7, evidence: `${from.label}: theme-color meta tag` });
  const tile = $('meta[name="msapplication-TileColor"]').first().attr('content');
  const tileHex = tile ? parseColor(tile) : null;
  if (tileHex && !isNearWhite(tileHex)) push(candidates, { hex: tileHex, role: 'primary', tier: from.tier, weight: 0.5, evidence: `${from.label}: Windows tile color` });
  const inline = $('style')
    .toArray()
    .map((el) => $(el).text())
    .join('\n');
  if (inline.trim()) candidates.push(...brandFromCss(inline, { tier: from.tier, label: `${from.label} inline CSS`, tokenTier: 2 }));
  const stylesheets = $('link[rel~="stylesheet"][href]')
    .toArray()
    .map((el) => $(el).attr('href')!)
    .filter((h) => !/^(data:|javascript:)/i.test(h))
    .slice(0, 12);
  const logos: { src: string; score: number }[] = [];
  $('img[src]').each((_, el) => {
    const src = $(el).attr('src')!;
    const hay = `${$(el).attr('class') ?? ''} ${$(el).attr('alt') ?? ''} ${$(el).attr('id') ?? ''} ${src}`.toLowerCase();
    if (/logo|brand|wordmark/.test(hay) && !/^data:/.test(src)) logos.push({ src, score: (/logo/.test(hay) ? 2 : 1) + ($(el).closest('header, nav, .header, .navbar').length ? 1 : 0) });
  });
  const icons = $('link[rel~="apple-touch-icon"][href], link[rel~="icon"][href]')
    .toArray()
    .map((el) => $(el).attr('href')!)
    .filter((h) => /\.(png|jpe?g|webp)(\?|$)/i.test(h));
  const logoCandidates = [...logos.sort((a, b) => b.score - a.score).map((l) => l.src), ...icons].filter((v, i, a) => a.indexOf(v) === i && !/\.svg(\?|$)/i.test(v)).slice(0, 4);
  return { candidates, stylesheets, logoCandidates };
}
