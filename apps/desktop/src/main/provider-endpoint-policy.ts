import { createHash, randomUUID } from 'node:crypto';
import { lookup as systemLookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import {
  Agent,
  buildConnector,
  fetch as undiciFetch,
  type RequestInit as UndiciRequestInit,
} from 'undici';
import type { ProviderFetch } from './openai-provider-client';

export type ProviderEndpointAddress = Readonly<{ address: string; family: 4 | 6 }>;

const preparedEndpointBrand: unique symbol = Symbol('prepared-provider-endpoint');

export type PreparedProviderEndpoint = Readonly<{
  canonicalUrl: string;
  origin: string;
  trust: 'trusted-local' | 'trusted-remote';
  addresses: readonly ProviderEndpointAddress[];
  digest: string;
  [preparedEndpointBrand]: true;
}>;

export function isPreparedProviderEndpoint(value: unknown): value is PreparedProviderEndpoint {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[preparedEndpointBrand] === true
  );
}

export type ProviderEndpointLookup = (
  hostname: string,
) => Promise<readonly ProviderEndpointAddress[]>;

const MAX_REDIRECTS = 3;
const CONSENT_CHALLENGE_TTL_MS = 2 * 60 * 1_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class ProviderEndpointPolicy {
  constructor(
    private readonly lookup: ProviderEndpointLookup = async (hostname) =>
      (await systemLookup(hostname, { all: true, order: 'verbatim' })).map(
        ({ address, family }) => ({
          address,
          family: family as 4 | 6,
        }),
      ),
  ) {}

  canonicalizeBaseUrl(input: string): string {
    if (input.includes('?') || input.includes('#'))
      throw new Error('Provider base URL must not include query or fragment');
    const parsed = canonicalUrl(input, false);
    if (parsed.protocol !== 'https:' && !isExplicitLocalHostname(parsed.hostname))
      throw new Error('Custom Provider base URL must use HTTPS or loopback HTTP');
    return parsed.toString().replace(/\/+$/u, '');
  }

  async prepareBaseUrl(input: string): Promise<PreparedProviderEndpoint> {
    return this.prepare(this.canonicalizeBaseUrl(input), false);
  }

  digestForBaseUrl(input: string): string {
    const canonical = this.canonicalizeBaseUrl(input);
    const trust = this.trustForBaseUrl(canonical);
    return endpointDigest(canonical, trust);
  }

  trustForBaseUrl(input: string): PreparedProviderEndpoint['trust'] {
    const canonical = this.canonicalizeBaseUrl(input);
    return isExplicitLocalHostname(new URL(canonical).hostname)
      ? 'trusted-local'
      : 'trusted-remote';
  }

  async prepareRequestUrl(input: string | URL): Promise<PreparedProviderEndpoint> {
    return this.prepare(input, true);
  }

  private async prepare(
    input: string | URL,
    allowQuery: boolean,
  ): Promise<PreparedProviderEndpoint> {
    const parsed = canonicalUrl(input, allowQuery);
    const local = isExplicitLocalHostname(parsed.hostname);
    if (local && parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      throw new Error('Local Provider endpoint must use HTTP or HTTPS');
    if (!local && parsed.protocol !== 'https:')
      throw new Error('Remote Provider endpoint must use HTTPS');

    const family = isIP(unbracket(parsed.hostname));
    const addresses: readonly ProviderEndpointAddress[] =
      family === 0
        ? await this.lookup(parsed.hostname)
        : [{ address: unbracket(parsed.hostname), family: family as 4 | 6 }];
    if (addresses.length === 0) throw new Error('Provider endpoint did not resolve');
    for (const answer of addresses) {
      if (answer.family !== isIP(answer.address))
        throw new Error('Provider endpoint returned an invalid DNS answer');
      if (local ? !isLoopbackAddress(answer.address) : !isPublicAddress(answer.address))
        throw new Error('Provider endpoint resolved to a forbidden network address');
    }
    const unique = Object.freeze([
      ...new Map(
        addresses.map((answer) => [`${answer.family}:${answer.address}`, answer]),
      ).values(),
    ]);
    const canonical = parsed.toString();
    const trust = local ? 'trusted-local' : 'trusted-remote';
    return Object.freeze({
      canonicalUrl: canonical,
      origin: parsed.origin,
      trust,
      addresses: unique,
      digest: endpointDigest(canonical.replace(/\/+$/u, ''), trust),
      [preparedEndpointBrand]: true as const,
    });
  }
}

export type ProviderEndpointConsentChallenge = Readonly<{
  challenge: string;
  endpoint: PreparedProviderEndpoint;
  expiresAt: string;
}>;

export class ProviderEndpointConsentChallenges {
  private readonly pending = new Map<
    string,
    Readonly<{ endpoint: PreparedProviderEndpoint; expiresAtMs: number }>
  >();

  constructor(
    private readonly policy = new ProviderEndpointPolicy(),
    private readonly now: () => number = Date.now,
    private readonly id: () => string = randomUUID,
  ) {}

  async prepare(baseUrl: string): Promise<ProviderEndpointConsentChallenge> {
    this.prune();
    if (this.pending.size >= 64) throw new Error('Too many pending Provider endpoint challenges');
    const endpoint = await this.policy.prepareBaseUrl(baseUrl);
    const challenge = this.id();
    const expiresAtMs = this.now() + CONSENT_CHALLENGE_TTL_MS;
    this.pending.set(challenge, Object.freeze({ endpoint, expiresAtMs }));
    return Object.freeze({
      challenge,
      endpoint,
      expiresAt: new Date(expiresAtMs).toISOString(),
    });
  }

  confirm(challenge: string, endpointDigest: string): PreparedProviderEndpoint {
    const prepared = this.pending.get(challenge);
    this.pending.delete(challenge);
    if (prepared === undefined || prepared.expiresAtMs < this.now())
      throw new Error('Provider endpoint challenge is missing or expired');
    if (prepared.endpoint.digest !== endpointDigest)
      throw new Error('Provider endpoint challenge digest does not match');
    return prepared.endpoint;
  }

  cancel(challenge: string): void {
    this.pending.delete(challenge);
  }

  private prune(): void {
    const now = this.now();
    for (const [challenge, prepared] of this.pending)
      if (prepared.expiresAtMs < now) this.pending.delete(challenge);
  }
}

function endpointDigest(
  canonicalBaseUrl: string,
  trust: PreparedProviderEndpoint['trust'],
): string {
  return createHash('sha256')
    .update(JSON.stringify(['provider-endpoint-v1', canonicalBaseUrl, trust]))
    .digest('hex');
}

export type ProviderEndpointTransport = (
  prepared: PreparedProviderEndpoint,
  init: RequestInit,
) => Promise<Response>;

export const secureProviderFetch: ProviderFetch = (input, init = {}) =>
  fetchWithProviderEndpointPolicy(new ProviderEndpointPolicy(), input, init);

export async function fetchWithProviderEndpointPolicy(
  policy: ProviderEndpointPolicy,
  input: string | URL | Request,
  init: RequestInit = {},
  transport: ProviderEndpointTransport = pinnedProviderTransport,
): Promise<Response> {
  if (typeof Request !== 'undefined' && input instanceof Request)
    throw new Error('Prepared Provider fetch does not accept Request objects');
  let url = new URL(input.toString());
  let headers = new Headers(init.headers);
  const method = (init.method ?? 'GET').toUpperCase();
  let initialTrust: PreparedProviderEndpoint['trust'] | undefined;
  for (let redirectCount = 0; ; redirectCount += 1) {
    const prepared = await policy.prepareRequestUrl(url);
    initialTrust ??= prepared.trust;
    if (prepared.trust !== initialTrust)
      throw new Error('Provider redirect changed endpoint trust boundary');
    const response = await transport(prepared, { ...init, headers, redirect: 'manual' });
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    const location = response.headers.get('location');
    if (location === null) return response;
    await response.body?.cancel();
    if (redirectCount >= MAX_REDIRECTS) throw new Error('Provider redirect limit exceeded');
    if (method !== 'GET' && method !== 'HEAD')
      throw new Error('Provider redirects for requests with a body are forbidden');
    const next = new URL(location, prepared.canonicalUrl);
    if (next.origin !== prepared.origin) {
      headers = new Headers(headers);
      for (const name of ['authorization', 'cookie', 'proxy-authorization']) headers.delete(name);
    }
    url = next;
  }
}

async function pinnedProviderTransport(
  prepared: PreparedProviderEndpoint,
  init: RequestInit,
): Promise<Response> {
  const dispatcher = pinnedDispatcher(prepared);
  try {
    return (await undiciFetch(prepared.canonicalUrl, {
      ...(init as UndiciRequestInit),
      headers: [...new Headers(init.headers).entries()],
      dispatcher,
    })) as unknown as Response;
  } finally {
    void dispatcher.close().catch(() => undefined);
  }
}

function pinnedDispatcher(prepared: PreparedProviderEndpoint): Agent {
  const lookup: LookupFunction = (_hostname, options, callback) => {
    const requestedFamily = typeof options === 'number' ? options : (options.family ?? 0);
    const candidates = prepared.addresses.filter(
      ({ family }) => requestedFamily === 0 || requestedFamily === family,
    );
    if (candidates.length === 0) {
      const error = Object.assign(new Error('No approved address for Provider endpoint'), {
        code: 'ENOTFOUND',
      });
      callback(error, '', 0);
      return;
    }
    if (typeof options !== 'number' && options.all) callback(null, candidates);
    else callback(null, candidates[0]!.address, candidates[0]!.family);
  };
  return new Agent({ connect: buildConnector({ lookup }) });
}

function canonicalUrl(input: string | URL, allowQuery: boolean): URL {
  const parsed = new URL(input);
  if (parsed.username !== '' || parsed.password !== '')
    throw new Error('Provider endpoint must not include credentials');
  if (!allowQuery && parsed.search !== '')
    throw new Error('Provider base URL must not include query');
  if (parsed.hash !== '') throw new Error('Provider endpoint must not include a fragment');
  if (!['http:', 'https:'].includes(parsed.protocol))
    throw new Error('Provider endpoint protocol is unsupported');
  parsed.hostname = parsed.hostname.toLowerCase().replace(/\.$/u, '');
  return parsed;
}

function isExplicitLocalHostname(hostname: string): boolean {
  const normalized = unbracket(hostname).toLowerCase().replace(/\.$/u, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function unbracket(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

export function isLoopbackAddress(address: string): boolean {
  if (isIP(address) === 4) return address.split('.')[0] === '127';
  const bytes = ipv6Bytes(address);
  if (bytes === null) return false;
  const mapped = mappedIpv4(bytes);
  return mapped === null
    ? bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1
    : isLoopbackAddress(mapped);
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family !== 6) return false;
  const bytes = ipv6Bytes(address);
  if (bytes === null) return false;
  const mapped = mappedIpv4(bytes);
  if (mapped !== null) return isPublicIpv4(mapped);
  if ((bytes[0]! & 0xe0) !== 0x20) return false;
  // Documentation prefix 2001:db8::/32 is not globally routable.
  return !(bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8);
}

function isPublicIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return false;
  const [a, b, c] = octets as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function ipv6Bytes(address: string): number[] | null {
  const normalized = unbracket(address).split('%')[0]!;
  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const parseHalf = (value: string): number[] | null => {
    if (value === '') return [];
    const result: number[] = [];
    for (const field of value.split(':')) {
      if (field.includes('.')) {
        const ipv4 = field.split('.').map(Number);
        if (ipv4.length !== 4 || ipv4.some((part) => part < 0 || part > 255)) return null;
        result.push((ipv4[0]! << 8) | ipv4[1]!, (ipv4[2]! << 8) | ipv4[3]!);
      } else {
        const part = Number.parseInt(field, 16);
        if (!/^[a-f0-9]{1,4}$/iu.test(field) || !Number.isInteger(part)) return null;
        result.push(part);
      }
    }
    return result;
  };
  const left = parseHalf(halves[0]!);
  const right = parseHalf(halves[1] ?? '');
  if (left === null || right === null) return null;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const words = [...left, ...Array.from({ length: missing }, () => 0), ...right];
  if (words.length !== 8) return null;
  return words.flatMap((word) => [word >> 8, word & 0xff]);
}

function mappedIpv4(bytes: readonly number[]): string | null {
  if (
    bytes.length !== 16 ||
    !bytes.slice(0, 10).every((byte) => byte === 0) ||
    bytes[10] !== 0xff ||
    bytes[11] !== 0xff
  )
    return null;
  return bytes.slice(12).join('.');
}
