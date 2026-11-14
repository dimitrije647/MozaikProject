import type { ExtractedPage } from '../tools/html';

/**
 * VERIFIED BRAND FACTS (deterministic, no model): what the business's OWN website says about its identity, each with the page it came from.
 *
 *   officialSlogan  a short line the site uses as its slogan: the part of a page title next to the business name ("Firmenfels Group - Stand firm.
 *                   Move faster.") that the site ALSO shows as a heading, or the same line in the titles of two pages. One place alone is not
 *                   enough: the headline of one page is not the company's slogan. Kept verbatim with the language of its page; never translated.
 *   name            the name the site gives itself (JSON-LD organization, og:site_name, the title)
 *   website         the address that was really read
 *   contact         e-mail addresses and phone numbers the site itself links (mailto: / tel:)
 *
 * A generated campaign tagline is never one of these facts. When nothing is verified the field is null and nothing is claimed. Works for any business:
 * nothing here knows a particular company.
 */
export interface VerifiedFact {
  text: string;
  /** language of the page it was read on (html lang), null when the page does not say */
  lang: string | null;
  sourceUrl: string;
  /** where on the site it was seen, e.g. "title of https://x/en", "heading of https://x/en" */
  evidence: string[];
}

export interface BrandFacts {
  version: 1;
  name: VerifiedFact | null;
  officialSlogan: VerifiedFact | null;
  website: string | null;
  contact: { emails: string[]; phones: string[]; sourceUrl: string | null };
  /** how the facts were found, for the report */
  notes: string[];
}

const SEP = /\s+[–—|·:•]\s+|\s+-\s+/;
const GENERIC = /^(home|homepage|start|startseite|welcome|willkommen|accueil|inicio|po[čc]etna|our team|team|about( us)?|über uns|ueber uns|kontakt|contact|blog|news|services?|leistungen|impressum|privacy|datenschutz|login)$/i;
const norm = (s: string) => s.toLowerCase().normalize('NFKC').replace(/[\s ]+/g, ' ').replace(/["'“”‘’]/g, '').trim();

/** The verified facts of a set of pages of ONE site (the business's own website). Pure. */
export function brandFactsOf(pages: readonly { url: string; page: ExtractedPage }[], brandName: string): BrandFacts {
  const notes: string[] = [];
  const brandWords = norm(brandName).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3);
  const namesBrand = (t: string) => brandWords.some((w) => norm(t).includes(w));
  const titleParts = (p: ExtractedPage) => (p.title ?? '').split(SEP).map((x) => x.trim()).filter(Boolean);
  // candidates: the parts of every page title that are not the business name
  const cands = new Map<string, { text: string; lang: string | null; sourceUrl: string; evidence: Set<string> }>();
  for (const { url, page } of pages) {
    const parts = titleParts(page);
    if (parts.length < 2) continue;
    for (const part of parts) {
      const words = part.split(/\s+/).length;
      if (namesBrand(part) || GENERIC.test(part) || words < 2 || words > 9 || part.length > 70) continue;
      const k = norm(part);
      const c = cands.get(k) ?? { text: part, lang: page.lang ? page.lang.slice(0, 5) : null, sourceUrl: url, evidence: new Set<string>() };
      c.evidence.add(`title of ${url}`);
      cands.set(k, c);
    }
  }
  // confirmed by a heading of the site, or by the titles of two different pages
  for (const { url, page } of pages) {
    for (const h of page.headings.slice(0, 12)) {
      const nh = norm(h);
      for (const [k, c] of cands) if (nh === k || (nh.includes(k) && nh.length <= k.length + 4)) c.evidence.add(`heading of ${url}`);
    }
  }
  const verified = [...cands.values()].filter((c) => c.evidence.size >= 2).sort((a, b) => b.evidence.size - a.evidence.size || a.text.length - b.text.length);
  const top = verified[0];
  const officialSlogan = top ? { text: top.text, lang: top.lang, sourceUrl: top.sourceUrl, evidence: [...top.evidence].slice(0, 4) } : null;
  if (officialSlogan) notes.push(`Official slogan found on the website: "${officialSlogan.text}" (${officialSlogan.evidence.join('; ')}).`);
  else notes.push(cands.size ? 'A possible slogan appears in one page title only and is not confirmed anywhere else on the site, so no official slogan is claimed.' : 'No official slogan was found on the pages read; none is claimed.');

  let name: VerifiedFact | null = null;
  for (const { url, page } of pages) {
    const org = page.organization?.name?.trim();
    const v = org || page.siteName?.trim();
    if (v && v.length <= 80) {
      name = { text: v, lang: page.lang, sourceUrl: url, evidence: [org ? `structured data of ${url}` : `og:site_name of ${url}`] };
      break;
    }
  }
  if (!name)
    for (const { url, page } of pages) {
      const part = titleParts(page).find((x) => namesBrand(x) && x.length <= 60);
      if (part) {
        name = { text: part, lang: page.lang, sourceUrl: url, evidence: [`title of ${url}`] };
        break;
      }
    }
  const contactPage = pages.find((p) => (p.page.contacts?.emails.length ?? 0) + (p.page.contacts?.phones.length ?? 0) > 0);
  return {
    version: 1,
    name,
    officialSlogan,
    website: pages[0]?.url ?? null,
    contact: { emails: [...new Set(pages.flatMap((p) => p.page.contacts?.emails ?? []))].slice(0, 3), phones: [...new Set(pages.flatMap((p) => p.page.contacts?.phones ?? []))].slice(0, 3), sourceUrl: contactPage?.url ?? null },
    notes,
  };
}

/** Reads stored brand facts defensively (older reports have none). */
export function readBrandFacts(v: unknown): BrandFacts | null {
  if (!v || typeof v !== 'object' || (v as { version?: unknown }).version !== 1) return null;
  const o = v as BrandFacts;
  return { version: 1, name: o.name ?? null, officialSlogan: o.officialSlogan ?? null, website: o.website ?? null, contact: { emails: o.contact?.emails ?? [], phones: o.contact?.phones ?? [], sourceUrl: o.contact?.sourceUrl ?? null }, notes: Array.isArray(o.notes) ? o.notes : [] };
}
