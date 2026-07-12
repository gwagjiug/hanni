import { beforeAll, describe, expect, it, vi } from 'vitest';
import { GitHubClient } from '../../src/tools/github/client';
import type { Env } from '../../src/types';

let privateKey = '';

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  const bytes = new Uint8Array(
    await crypto.subtle.exportKey('pkcs8', pair.privateKey),
  );
  privateKey = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(bytes).toString('base64')}\n-----END PRIVATE KEY-----`;
});

describe('GitHubClient', () => {
  it('rejects a malformed installation token response', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ token: 123, expires_at: null }), {
        status: 200,
      }),
    );
    const client = new GitHubClient(
      {
        GITHUB_APP_ID: '1',
        GITHUB_INSTALLATION_ID: '2',
        GITHUB_APP_PRIVATE_KEY: privateKey,
        ARCHIVE_OWNER: 'gwagjiug',
        ARCHIVE_REPO: 'archive',
        ARCHIVE_DEFAULT_BRANCH: 'main',
      } as Env,
      fetcher,
    );

    await expect(client.readArchive()).rejects.toThrow();
  });

  it('deletes the created branch when Draft PR creation fails', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const replies = [
      new Response(
        JSON.stringify({
          token: 'installation',
          expires_at: '2999-01-01T00:00:00Z',
        }),
      ),
      new Response(JSON.stringify({ sha: 'readme-blob' })),
      new Response(JSON.stringify({ sha: 'pin-blob' })),
      new Response(JSON.stringify({ sha: 'tree' })),
      new Response(JSON.stringify({ sha: 'commit' })),
      new Response(JSON.stringify({}), { status: 201 }),
      new Response(JSON.stringify({ message: 'failed' }), { status: 500 }),
      new Response(null, { status: 204 }),
    ];
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), method: init?.method ?? 'GET' });
        return replies.shift()!;
      },
    ) as typeof fetch;
    const client = new GitHubClient(
      {
        GITHUB_APP_ID: '1',
        GITHUB_INSTALLATION_ID: '2',
        GITHUB_APP_PRIVATE_KEY: privateKey,
        ARCHIVE_OWNER: 'gwagjiug',
        ARCHIVE_REPO: 'archive',
        ARCHIVE_DEFAULT_BRANCH: 'main',
      } as Env,
      fetcher,
    );

    await expect(
      client.createDraftPr({
        runId: '12345678-abcd',
        title: 'title',
        body: 'body',
        commitMessage: 'commit',
        baseCommitSha: 'base',
        baseTreeSha: 'base-tree',
        readme: 'readme',
        pinPath: 'pins/item.md',
        pinContent: 'pin',
      }),
    ).rejects.toThrow('github_http_500');

    expect(calls.at(-1)).toMatchObject({
      method: 'DELETE',
      url: expect.stringContaining('/git/refs/heads/hanni/archive-'),
    });
  });
});
