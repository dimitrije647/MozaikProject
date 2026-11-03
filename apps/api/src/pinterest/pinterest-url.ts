/**
 * "I found this Pin myself" support: turns a pasted pinterest.com Pin address into a canonical LINK the user can keep.
 * Pure string handling. It NEVER fetches the address (Pinterest's guidelines forbid scraping), so it cannot say whether the Pin
 * exists, only whether the text has the shape of a Pin address.
 */
export type PinterestUrlResult = { ok: true; pinId: string; url: string } | { ok: false; reason: string };

const HOST = /^(?:[a-z]{2,3}|www)\.pinterest\.com$|^pinterest\.com$/;

export function normalizePinterestPinUrl(input: string): PinterestUrlResult {
  const raw = (input ?? '').trim();
  if (!raw || raw.length > 2048) return { ok: false, reason: 'Paste a Pinterest Pin address like https://www.pinterest.com/pin/1234567890/.' };
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { ok: false, reason: 'That does not look like a web address.' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, reason: 'Only http(s) Pinterest addresses are accepted.' };
  if (u.username || u.password || u.port) return { ok: false, reason: 'That address contains credentials or a port, which is not accepted.' };
  const host = u.hostname.toLowerCase();
  if (host === 'pin.it') return { ok: false, reason: 'Short pin.it links cannot be resolved without opening them. Open the Pin and paste its full pinterest.com/pin/... address.' };
  if (!HOST.test(host)) return { ok: false, reason: 'Only pinterest.com Pin addresses are accepted.' };
  const m = /^\/pin\/(\d{5,30})\/?$/.exec(u.pathname);
  if (!m) return { ok: false, reason: 'Use the Pin address (pinterest.com/pin/<number>), not a board, profile or search page.' };
  return { ok: true, pinId: m[1], url: `https://www.pinterest.com/pin/${m[1]}/` };
}
