import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import {
  ProviderEndpointPolicy,
  ProviderEndpointConsentChallenges,
  fetchWithProviderEndpointPolicy,
  isLoopbackAddress,
  isPublicAddress,
  type ProviderEndpointAddress,
} from './provider-endpoint-policy';

function policy(records: Record<string, readonly ProviderEndpointAddress[]>) {
  return new ProviderEndpointPolicy(async (hostname) => records[hostname] ?? []);
}

describe('ProviderEndpointPolicy', () => {
  it.each([
    'https://user@example.com/v1',
    'https://example.com/v1?target=http://127.0.0.1',
    'https://example.com/v1#fragment',
  ])('rejects authority or URL components that can change base URL meaning: %s', async (input) => {
    await expect(policy({}).prepareBaseUrl(input)).rejects.toThrow();
  });

  it('canonicalizes scheme, punycode host, effective port, path, and trailing slash', async () => {
    const prepared = await policy({
      'xn--r8jz45g.xn--zckzah': [{ address: '8.8.8.8', family: 4 }],
    }).prepareBaseUrl('HTTPS://例え.テスト:443/a/../v1/');

    expect(prepared).toMatchObject({
      canonicalUrl: 'https://xn--r8jz45g.xn--zckzah/v1',
      origin: 'https://xn--r8jz45g.xn--zckzah',
      trust: 'trusted-remote',
    });
    expect(prepared.digest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it.each([
    ['private IPv4', [{ address: '10.0.0.8', family: 4 }] as const],
    [
      'mixed public/private DNS',
      [
        { address: '8.8.8.8', family: 4 },
        { address: '192.168.1.2', family: 4 },
      ] as const,
    ],
    ['link-local IPv6', [{ address: 'fe80::1', family: 6 }] as const],
    ['IPv4-mapped loopback', [{ address: '::ffff:127.0.0.1', family: 6 }] as const],
    ['multicast', [{ address: '224.0.0.1', family: 4 }] as const],
    ['unspecified', [{ address: '0.0.0.0', family: 4 }] as const],
  ])('rejects remote endpoints with %s answers', async (_label, answers) => {
    await expect(
      policy({ 'provider.test': answers }).prepareBaseUrl('https://provider.test/v1'),
    ).rejects.toThrow('forbidden network address');
  });

  it('allows a public HTTPS endpoint and exact loopback HTTP endpoints', async () => {
    await expect(
      policy({ 'provider.test': [{ address: '8.8.4.4', family: 4 }] }).prepareBaseUrl(
        'https://provider.test/v1',
      ),
    ).resolves.toMatchObject({ trust: 'trusted-remote' });
    await expect(
      policy({ localhost: [{ address: '::1', family: 6 }] }).prepareBaseUrl(
        'http://localhost:11434/v1',
      ),
    ).resolves.toMatchObject({
      canonicalUrl: 'http://localhost:11434/v1',
      trust: 'trusted-local',
    });
    await expect(policy({}).prepareBaseUrl('http://[::1]:8080/v1')).resolves.toMatchObject({
      trust: 'trusted-local',
    });
  });

  it('rejects remote HTTP even when DNS is public', async () => {
    await expect(
      policy({ 'provider.test': [{ address: '8.8.8.8', family: 4 }] }).prepareBaseUrl(
        'http://provider.test/v1',
      ),
    ).rejects.toThrow('must use HTTPS');
  });

  it('revalidates redirects and refuses a public-to-private DNS hop before transport', async () => {
    const endpointPolicy = policy({
      'public.test': [{ address: '8.8.8.8', family: 4 }],
      'private.test': [{ address: '10.0.0.5', family: 4 }],
    });
    const transport = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'https://private.test/admin' } }),
      );

    await expect(
      fetchWithProviderEndpointPolicy(endpointPolicy, 'https://public.test/v1', {}, transport),
    ).rejects.toThrow('forbidden network address');
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('does not carry authentication headers across a public cross-origin redirect', async () => {
    const endpointPolicy = policy({
      'one.test': [{ address: '8.8.8.8', family: 4 }],
      'two.test': [{ address: '1.1.1.1', family: 4 }],
    });
    const observed: Headers[] = [];
    const transport = vi.fn(async (_endpoint, init: RequestInit) => {
      observed.push(new Headers(init.headers));
      return observed.length === 1
        ? new Response(null, { status: 302, headers: { location: 'https://two.test/models' } })
        : new Response('ok', { status: 200 });
    });

    await expect(
      fetchWithProviderEndpointPolicy(
        endpointPolicy,
        'https://one.test/v1',
        { headers: { authorization: 'Bearer secret', 'x-safe': 'kept' } },
        transport,
      ),
    ).resolves.toMatchObject({ status: 200 });
    expect(observed[0]!.get('authorization')).toBe('Bearer secret');
    expect(observed[1]!.get('authorization')).toBeNull();
    expect(observed[1]!.get('x-safe')).toBe('kept');
  });

  it('pins one validated DNS answer set for the transport call', async () => {
    const lookup = vi.fn(async () => [{ address: '8.8.8.8', family: 4 }] as const);
    const endpointPolicy = new ProviderEndpointPolicy(lookup);
    const transport = vi.fn(async (prepared) => {
      expect(prepared.addresses).toEqual([{ address: '8.8.8.8', family: 4 }]);
      return new Response('ok');
    });

    await fetchWithProviderEndpointPolicy(
      endpointPolicy,
      'https://provider.test/v1',
      {},
      transport,
    );
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('uses the pinned dispatcher for normal consent-eligible loopback communication', async () => {
    const server = createServer((request, response) => {
      expect(request.headers.host).toMatch(/^localhost:/u);
      expect(request.url).toBe('/v1/models');
      response.end('pinned-ok');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Test server has no port');
    try {
      const response = await fetchWithProviderEndpointPolicy(
        policy({ localhost: [{ address: '127.0.0.1', family: 4 }] }),
        `http://localhost:${address.port}/v1/models`,
      );
      await expect(response.text()).resolves.toBe('pinned-ok');
    } finally {
      server.close();
      await once(server, 'close');
    }
  });

  it('classifies loopback, mapped, private, and global addresses explicitly', () => {
    expect(isLoopbackAddress('127.0.0.9')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isPublicAddress('::ffff:127.0.0.1')).toBe(false);
    expect(isPublicAddress('fc00::1')).toBe(false);
    expect(isPublicAddress('2001:4860:4860::8888')).toBe(true);
    expect(isPublicAddress('198.200.1.1')).toBe(true);
    expect(isPublicAddress('198.51.100.1')).toBe(false);
  });

  it('binds a short-lived one-use consent challenge to the exact endpoint digest', async () => {
    let now = Date.parse('2026-08-13T00:00:00.000Z');
    let sequence = 0;
    const challenges = new ProviderEndpointConsentChallenges(
      policy({ localhost: [{ address: '127.0.0.1', family: 4 }] }),
      () => now,
      () => `challenge-${++sequence}`,
    );
    const prepared = await challenges.prepare('http://localhost:11434/v1');

    expect(prepared).toMatchObject({
      challenge: 'challenge-1',
      endpoint: { canonicalUrl: 'http://localhost:11434/v1', trust: 'trusted-local' },
      expiresAt: '2026-08-13T00:02:00.000Z',
    });
    expect(() => challenges.confirm(prepared.challenge, '0'.repeat(64))).toThrow(
      'digest does not match',
    );
    expect(() => challenges.confirm(prepared.challenge, prepared.endpoint.digest)).toThrow(
      'missing or expired',
    );

    const expired = await challenges.prepare('http://localhost:11434/v1');
    now += 120_001;
    expect(() => challenges.confirm(expired.challenge, expired.endpoint.digest)).toThrow(
      'missing or expired',
    );
  });
});
