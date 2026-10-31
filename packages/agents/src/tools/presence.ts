import type { PageSignals } from './seo';
import { parseSocialUrl, type ParsedSocialUrl } from './social';

/**
 * Cross-channel consistency checks (F2). Pure and deterministic: it compares only data that was already
 * collected (the website's pages, the supplied social URLs, the F1 product name). It never goes to the
 * network, never visits social platforms and never guesses.
 *
 * Channel states keep four different situations apart:
 *   not_supplied  - the user gave no URL for it
 *   unverified    - a URL was supplied, but nobody could open it (no authorized access): NOT evidence of absence
 *   linked_from_site / not_linked_from_site - observed on the website
 *   invalid       - the supplied URL is malformed or belongs to another platform
 */
export interface ChannelStatus {
  platform: string;
  url: string | null;
  state: 'not_supplied' | 'supplied' | 'invalid';
  parse: ParsedSocialUrl | null;
  /** Observed on the website's pages (only meaningful when the website was read). */
  linkedFromWebsite: boolean | null;
}

export interface PresenceFacts {
  website: { supplied: boolean; reachable: boolean | null; finalHost: string | null; redirectedToOtherHost: boolean };
  channels: ChannelStatus[];
  websiteSocialLinksNotSupplied: { platform: string; url: string }[];
  identity: { productName: string; inTitle: boolean | null; inOgSiteName: boolean | null; inH1: boolean | null; handleMatches: { platform: string; matches: boolean }[] };
  contact: { emails: string[]; phones: string[]; contactPageLink: boolean | null };
  trust: { structuredDataTypes: string[]; hasAboutPage: boolean | null; hasPrivacyOrTerms: boolean | null };
  issues: string[];
}

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
const sameProfile = (a: string, b: string) => {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.hostname.replace(/^www\./, '') === y.hostname.replace(/^www\./, '') && x.pathname.replace(/\/$/, '').toLowerCase() === y.pathname.replace(/\/$/, '').toLowerCase();
  } catch {
    return false;
  }
};

export function checkPresence(args: {
  productName: string;
  websiteUrl: string | null;
  pages: PageSignals[] | null;
  socials: { platform: string; url: string }[];
}): PresenceFacts {
  const { productName, websiteUrl, pages, socials } = args;
  const home = pages?.[0] ?? null;
  const issues: string[] = [];
  const wanted = norm(productName);

  const supplied = socials.map((s) => ({ s, parse: parseSocialUrl(s.platform, s.url) }));
  const siteLinks = pages ? pages.flatMap((p) => p.socialLinks) : [];
  const channels: ChannelStatus[] = supplied.map(({ s, parse }) => ({
    platform: parse.declared,
    url: s.url,
    state: parse.valid ? 'supplied' : 'invalid',
    parse,
    linkedFromWebsite: pages ? siteLinks.some((l) => sameProfile(l.url, s.url)) : null,
  }));
  for (const c of channels) if (c.state === 'invalid') issues.push(`${c.platform}: ${c.parse!.issues.join(' ')}`);
  const duplicates = channels.filter((c, i) => channels.findIndex((d) => d.platform === c.platform) !== i);
  for (const d of duplicates) issues.push(`More than one ${d.platform} profile was supplied.`);

  const suppliedPlatforms = new Set(channels.map((c) => c.platform));
  const notSupplied = siteLinks.filter((l, i) => !suppliedPlatforms.has(l.platform) && siteLinks.findIndex((x) => x.url === l.url) === i);

  const handleMatches = channels
    .filter((c) => c.parse?.handle)
    .map((c) => ({ platform: c.platform, matches: !!wanted && (norm(c.parse!.handle!).includes(wanted) || wanted.includes(norm(c.parse!.handle!))) }));

  const emails = [...new Set((pages ?? []).flatMap((p) => p.contact.emails))];
  const phones = [...new Set((pages ?? []).flatMap((p) => p.contact.phones))];

  const hasPath = (re: RegExp) => (pages ? pages.some((p) => re.test(new URL(p.finalUrl).pathname) || p.internalLinks.some((l) => re.test(new URL(l).pathname))) : null);

  let redirectedToOtherHost = false;
  if (websiteUrl && home) {
    try {
      redirectedToOtherHost = new URL(websiteUrl).hostname.replace(/^www\./, '') !== new URL(home.finalUrl).hostname.replace(/^www\./, '');
    } catch {
      /* ignore */
    }
  }
  if (redirectedToOtherHost) issues.push(`The supplied website URL redirects to a different host (${new URL(home!.finalUrl).hostname}).`);
  if (pages) {
    for (const c of channels) if (c.state === 'supplied' && c.linkedFromWebsite === false) issues.push(`The website does not link to the supplied ${c.platform} profile.`);
    for (const l of notSupplied) issues.push(`The website links to ${l.platform} (${l.url}), which was not supplied as a project profile.`);
    if (home && wanted && !norm(home.title ?? '').includes(wanted)) issues.push('The product name does not appear in the home page title.');
  }

  return {
    website: { supplied: !!websiteUrl, reachable: websiteUrl ? !!home : null, finalHost: home ? new URL(home.finalUrl).hostname : null, redirectedToOtherHost },
    channels,
    websiteSocialLinksNotSupplied: notSupplied.slice(0, 8),
    identity: {
      productName,
      inTitle: home ? norm(home.title ?? '').includes(wanted) : null,
      inOgSiteName: home ? (home.og.siteName ? norm(home.og.siteName).includes(wanted) : null) : null,
      inH1: home ? home.h1.some((h) => norm(h).includes(wanted)) : null,
      handleMatches,
    },
    contact: { emails, phones, contactPageLink: pages ? pages.some((p) => p.contact.hasContactLink) : null },
    trust: {
      structuredDataTypes: [...new Set((pages ?? []).flatMap((p) => p.jsonLdTypes))],
      hasAboutPage: hasPath(/about|o-nama|o-nama|about-us/i),
      hasPrivacyOrTerms: hasPath(/privacy|terms|politika|uslovi|gdpr/i),
    },
    issues,
  };
}

export function describePresence(f: PresenceFacts): string {
  const t = (v: boolean | null) => (v === null ? 'not checked' : String(v));
  return [
    `website_supplied: ${f.website.supplied}; reachable: ${t(f.website.reachable)}; final_host: ${f.website.finalHost ?? 'n/a'}`,
    ...f.channels.map((c) => `channel ${c.platform}: ${c.state} ${c.url ?? ''} | linked_from_website: ${t(c.linkedFromWebsite)} | live_check: not performed (no authorized access)`),
    f.channels.length ? '' : 'channels: no social profile was supplied for this project',
    ...f.websiteSocialLinksNotSupplied.map((l) => `website_links_to_unsupplied_channel: ${l.platform} ${l.url}`),
    `identity: product_name="${f.identity.productName}"; in_home_title=${t(f.identity.inTitle)}; in_og_site_name=${t(f.identity.inOgSiteName)}; in_h1=${t(f.identity.inH1)}`,
    ...f.identity.handleMatches.map((h) => `handle_resembles_product_name ${h.platform}: ${h.matches}`),
    `contact: emails=${f.contact.emails.join(',') || '(none found)'}; phones=${f.contact.phones.join(',') || '(none found)'}; contact_page_link=${t(f.contact.contactPageLink)}`,
    `trust_signals: structured_data=${f.trust.structuredDataTypes.join(',') || '(none)'}; about_page_linked=${t(f.trust.hasAboutPage)}; privacy_or_terms_linked=${t(f.trust.hasPrivacyOrTerms)}`,
    f.issues.length ? `consistency_issues:\n- ${f.issues.join('\n- ')}` : 'consistency_issues: none detected by the deterministic checks',
  ]
    .filter((l) => l !== '')
    .join('\n');
}
