import { lookup as dnsLookupCb, type LookupAddress } from 'node:dns';
import { lookup as dnsLookup } from 'node:dns/promises';
import net from 'node:net';

/**
 * SSRF protection for fetching UNTRUSTED URLs (a user's website, links found on it, redirects).
 *
 * Layers: scheme/port/credential checks, hostname patterns, DNS resolution with every returned
 * address validated, validation of every redirect hop, and a guarded `lookup` that re-validates the
 * address at CONNECT time, so a hostname that resolves to a public IP during validation and to a
 * private IP when connecting (DNS rebinding) is still refused.
 */
export type UnsafeUrlCode =
  | 'invalid_url'
  | 'blocked_scheme'
  | 'blocked_port'
  | 'credentials_in_url'
  | 'blocked_host'
  | 'blocked_address'
  | 'dns_failed';

export class UnsafeUrlError extends Error {
  constructor(
    readonly code: UnsafeUrlCode,
    message: string,
  ) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

export interface UrlPolicy {
  /** Only these destination ports may be contacted. */
  allowedPorts: ReadonlySet<number>;
  /**
   * TESTS ONLY. Lets automated tests talk to a fake server on 127.0.0.1 / ::1. Only loopback is
   * allowed: private ranges, link-local and cloud-metadata addresses stay blocked, so SSRF defences can
   * still be tested. Production code never sets this (no environment variable or API option exists).
   */
  allowLoopbackForTests: boolean;
  /** Test seam for DNS. */
  resolver?: (hostname: string) => Promise<{ address: string; family: number }[]>;
}

export const DEFAULT_URL_POLICY: UrlPolicy = { allowedPorts: new Set([80, 443]), allowLoopbackForTests: false };

// ---- address checks --------------------------------------------------------------------------

const V4_BLOCKS: [string, number][] = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, incl. cloud metadata 169.254.169.254
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
];

const v4ToInt = (ip: string) => ip.split('.').reduce((acc, o) => ((acc << 8) | Number(o)) >>> 0, 0);

function isBlockedV4(ip: string): boolean {
  const n = v4ToInt(ip);
  return V4_BLOCKS.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (v4ToInt(base) & mask);
  });
}

/** Expands an IPv6 literal to 8 hextets (supports `::` and an embedded dotted IPv4 tail). */
function expandV6(ip: string): number[] | null {
  let s = ip.toLowerCase().split('%')[0];
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    const n = v4ToInt(tail[1]);
    s = s.slice(0, -tail[1].length) + ((n >>> 16) & 0xffff).toString(16) + ':' + (n & 0xffff).toString(16);
  }
  const [head, rest] = s.split('::');
  const h = head ? head.split(':') : [];
  const r = rest !== undefined && rest !== '' ? rest.split(':') : [];
  const missing = 8 - h.length - r.length;
  if (rest === undefined ? h.length !== 8 : missing < 0) return null;
  const parts = rest === undefined ? h : [...h, ...Array(missing).fill('0'), ...r];
  const nums = parts.map((p) => parseInt(p || '0', 16));
  return nums.length === 8 && nums.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffff) ? nums : null;
}

const embeddedV4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

function isBlockedV6(ip: string): boolean {
  const g = expandV6(ip);
  if (!g) return true; // unparseable: refuse
  const [a, b, c, d, e, f, x, y] = g;
  if (g.every((v) => v === 0)) return true; // ::
  if (g.slice(0, 7).every((v) => v === 0) && y === 1) return true; // ::1
  if ((a & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((a & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((a & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((a & 0xff00) === 0xff00) return true; // multicast
  if (a === 0x2001 && b === 0x0db8) return true; // documentation
  if (a === 0x2001 && b === 0) return true; // Teredo
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) return isBlockedV4(embeddedV4(x, y)); // IPv4-mapped
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0) return isBlockedV4(embeddedV4(x, y)); // IPv4-compatible
  if (a === 0x64 && b === 0xff9b) return isBlockedV4(embeddedV4(x, y)); // NAT64
  if (a === 0x2002) return isBlockedV4(embeddedV4(b, c)); // 6to4
  return false;
}

const isLoopback = (ip: string) => ip === '::1' || /^127./.test(ip) || /^::ffff:127./i.test(ip);

/** Address check honoring the (tests-only) loopback allowance. */
export function addressBlocked(ip: string, policy: UrlPolicy): boolean {
  if (policy.allowLoopbackForTests && isLoopback(ip)) return false;
  return isBlockedAddress(ip);
}

/** True for any loopback, private, link-local, multicast, reserved or metadata address. */
export function isBlockedAddress(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return isBlockedV4(ip);
  if (kind === 6) return isBlockedV6(ip);
  return true; // not an IP at all
}

// ---- URL / hostname checks -------------------------------------------------------------------

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.localdomain', '.internal', '.intranet', '.lan', '.home', '.corp', '.test.invalid'];
const BLOCKED_HOSTS = new Set(['localhost', 'metadata', 'metadata.google.internal', 'instance-data', 'kubernetes.default.svc']);

/** Synchronous checks. Throws UnsafeUrlError. */
export function parseHttpUrl(raw: string, policy: UrlPolicy = DEFAULT_URL_POLICY): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UnsafeUrlError('invalid_url', 'Not a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UnsafeUrlError('blocked_scheme', 'Only http and https URLs are allowed.');
  if (url.username || url.password) throw new UnsafeUrlError('credentials_in_url', 'URLs with embedded credentials are not allowed.');

  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (!policy.allowedPorts.has(port)) throw new UnsafeUrlError('blocked_port', `Port ${port} is not allowed.`);

  const host = url.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (!host) throw new UnsafeUrlError('invalid_url', 'URL has no host.');
  if (net.isIP(host)) {
    if (addressBlocked(host, policy)) throw new UnsafeUrlError('blocked_address', 'That address is not publicly routable.');
  } else if (BLOCKED_HOSTS.has(host) || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s)) || !host.includes('.')) {
    throw new UnsafeUrlError('blocked_host', 'That host name refers to an internal or non-public network.');
  }
  return url;
}

/** Resolves a host and validates EVERY address it resolves to. */
export async function resolveSafe(hostname: string, policy: UrlPolicy = DEFAULT_URL_POLICY): Promise<{ address: string; family: number }[]> {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (addressBlocked(host, policy)) throw new UnsafeUrlError('blocked_address', 'That address is not publicly routable.');
    return [{ address: host, family: net.isIP(host) }];
  }
  let addresses: { address: string; family: number }[];
  try {
    addresses = policy.resolver ? await policy.resolver(host) : await dnsLookup(host, { all: true, verbatim: true });
  } catch {
    throw new UnsafeUrlError('dns_failed', 'The host name could not be resolved.');
  }
  if (!addresses.length) throw new UnsafeUrlError('dns_failed', 'The host name did not resolve.');
  if (addresses.some((a) => addressBlocked(a.address, policy))) {
    throw new UnsafeUrlError('blocked_address', 'The host resolves to a non-public address.');
  }
  return addresses;
}

/** Full validation used before any request: syntax, host rules and DNS. */
export async function assertSafeUrl(raw: string, policy: UrlPolicy = DEFAULT_URL_POLICY): Promise<URL> {
  const url = parseHttpUrl(raw, policy);
  await resolveSafe(url.hostname, policy);
  return url;
}

/**
 * `lookup` function for node:http(s). Runs when the socket is about to connect, so the address that
 * is actually used has just been validated (closes the DNS-rebinding gap between check and use).
 */
export function guardedLookup(policy: UrlPolicy = DEFAULT_URL_POLICY) {
  return (
    hostname: string,
    options: { all?: boolean; family?: number | string } | number,
    callback: (err: NodeJS.ErrnoException | null, address?: string | LookupAddress[], family?: number) => void,
  ) => {
    const opts = typeof options === 'object' && options ? options : {};
    const done = (addresses: { address: string; family: number }[]) => {
      if (opts.all) return callback(null, addresses as LookupAddress[]);
      callback(null, addresses[0].address, addresses[0].family);
    };
    if (policy.resolver) {
      resolveSafe(hostname, policy).then(done, (e) => callback(e));
      return;
    }
    dnsLookupCb(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) return callback(err);
      if (addresses.some((a) => addressBlocked(a.address, policy))) {
        const blocked = new UnsafeUrlError('blocked_address', 'The host resolves to a non-public address.') as unknown as NodeJS.ErrnoException;
        return callback(blocked);
      }
      done(addresses);
    });
  };
}
