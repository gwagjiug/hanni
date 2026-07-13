import { describe, expect, it, vi } from 'vitest';
import { fetchMetadata } from '../../src/tools/web/metadata';

describe('web metadata', () => {
  it('extracts title and a safe canonical URL', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          '<html><head><title>Example &amp; Test</title><link rel="canonical" href="/canonical?utm_source=x"></head></html>',
          { headers: { 'content-type': 'text/html' } },
        ),
      );
    await expect(
      fetchMetadata('https://example.com/source', fetcher),
    ).resolves.toEqual({
      title: 'Example & Test',
      canonicalUrl: 'https://example.com/canonical',
    });
  });

  it('blocks redirects to private addresses', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: 'http://127.0.0.1/admin' },
      }),
    );
    await expect(fetchMetadata('https://example.com', fetcher)).rejects.toThrow(
      'blocked_redirect_target',
    );
  });
});
