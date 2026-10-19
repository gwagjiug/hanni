import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  GitHubClient,
  type CreateArchiveCommitInput,
} from '../../src/tools/github/client';
import type { Env } from '../../src/types';

let privateKey = '';
const owner = 'gwagjiug';
const repo = 'archive';
const base = 'main';
const branch = 'hanni/archive-12345678-abcd-4321-8765-123456789abc';
const commitSha = 'a'.repeat(40);
const publication = {
  branch,
  commitSha,
  title: 'Archive item',
  body: 'Approved body',
};

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

interface RemotePullRequest {
  number: number;
  html_url: string;
  state: 'open' | 'closed';
  draft: boolean;
  title: string;
  body: string;
  head: {
    label: string;
    ref: string;
    sha: string;
    repo: { name: string; owner: { login: string } } | null;
  };
  base: RemotePullRequest['head'];
}

// The fake stores external effects independently of client lifetime or responses.
class GitHubRemote {
  readonly refs = new Map<string, string>();
  readonly pulls: RemotePullRequest[] = [];
  readonly blobs = new Map<string, Record<string, unknown>>();
  readonly trees = new Map<string, Record<string, unknown>>();
  readonly commits = new Map<string, Record<string, unknown>>();
  readonly reads: string[] = [];
  readonly writes: Array<{
    method: string;
    path: string;
    body: Record<string, unknown>;
  }> = [];
  beforeRefCreate?: () => Response | void;
  afterRefCreate?: () => Response | void;
  beforePrCreate?: () => Response | void;
  afterPrCreate?: (pr: RemotePullRequest) => Response | void;
  refReadFailureStatus?: number;
  pullReadFailureStatus?: number;
  refResponse?: unknown;
  pullListResponse?: unknown;

  addPull(state: 'open' | 'closed' = 'open'): RemotePullRequest {
    const number = this.pulls.length + 1;
    const pr: RemotePullRequest = {
      number,
      html_url: `https://github.com/${owner}/${repo}/pull/${number}`,
      state,
      draft: true,
      title: publication.title,
      body: publication.body,
      head: {
        label: `${owner}:${branch}`,
        ref: branch,
        sha: this.refs.get(branch) ?? commitSha,
        repo: { name: repo, owner: { login: owner } },
      },
      base: {
        label: `${owner}:${base}`,
        ref: base,
        sha: 'b'.repeat(40),
        repo: { name: repo, owner: { login: owner } },
      },
    };
    this.pulls.push(pr);
    return pr;
  }

  readonly fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = init?.method ?? 'GET';
    if (path === '/app/installations/2/access_tokens') {
      return Response.json({
        token: 'installation',
        expires_at: '2999-01-01T00:00:00Z',
      });
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<
      string,
      unknown
    >;
    if (method === 'GET') {
      this.reads.push(`${path}${url.search}`);
    } else {
      this.writes.push({ method, path, body });
    }
    const prefix = `/repos/${owner}/${repo}`;
    if (method === 'GET' && path.startsWith(`${prefix}/git/ref/heads/`)) {
      if (this.refReadFailureStatus) {
        return Response.json({}, { status: this.refReadFailureStatus });
      }
      if (this.refResponse !== undefined) {
        return Response.json(this.refResponse);
      }
      const name = decodeURIComponent(
        path.slice(`${prefix}/git/ref/heads/`.length),
      );
      const sha = this.refs.get(name);
      return sha
        ? Response.json({
            ref: `refs/heads/${name}`,
            object: { type: 'commit', sha },
          })
        : Response.json({}, { status: 404 });
    }
    if (method === 'POST' && path === `${prefix}/git/refs`) {
      const intercepted = this.beforeRefCreate?.();
      if (intercepted) {
        return intercepted;
      }
      const name = String(body.ref).replace(/^refs\/heads\//, '');
      if (this.refs.has(name)) {
        return Response.json(
          { message: 'Reference already exists' },
          { status: 422 },
        );
      }
      const sha = String(body.sha);
      this.refs.set(name, sha);
      return (
        this.afterRefCreate?.() ??
        Response.json(
          { ref: `refs/heads/${name}`, object: { type: 'commit', sha } },
          { status: 201 },
        )
      );
    }
    if (method === 'GET' && path === `${prefix}/pulls`) {
      if (this.pullReadFailureStatus) {
        return Response.json({}, { status: this.pullReadFailureStatus });
      }
      if (this.pullListResponse !== undefined) {
        return Response.json(this.pullListResponse);
      }
      const state = url.searchParams.get('state') ?? 'open';
      const head = url.searchParams.get('head');
      const target = url.searchParams.get('base');
      const matches = this.pulls.filter(
        (pr) =>
          (state === 'all' || pr.state === state) &&
          (!head || pr.head.label === head) &&
          (!target || pr.base.ref === target),
      );
      const perPage = Number(url.searchParams.get('per_page') ?? 30);
      return Response.json(matches.slice(0, perPage));
    }
    if (method === 'POST' && path === `${prefix}/pulls`) {
      const intercepted = this.beforePrCreate?.();
      if (intercepted) {
        return intercepted;
      }
      if (
        this.pulls.some(
          (pr) =>
            pr.state === 'open' &&
            pr.head.ref === body.head &&
            pr.base.ref === body.base,
        )
      ) {
        return Response.json(
          { message: 'Pull request already exists' },
          { status: 422 },
        );
      }
      if (!this.refs.has(String(body.head))) {
        return Response.json({ message: 'Missing head' }, { status: 422 });
      }
      const pr = this.addPull();
      pr.head.ref = String(body.head);
      pr.head.sha = this.refs.get(pr.head.ref)!;
      pr.base.ref = String(body.base);
      pr.draft = body.draft === true;
      pr.title = String(body.title);
      pr.body = String(body.body);
      return this.afterPrCreate?.(pr) ?? Response.json(pr, { status: 201 });
    }
    const objects =
      path === `${prefix}/git/blobs`
        ? this.blobs
        : path === `${prefix}/git/trees`
          ? this.trees
          : path === `${prefix}/git/commits`
            ? this.commits
            : null;
    if (method === 'POST' && objects) {
      const sha = String(
        this.blobs.size + this.trees.size + this.commits.size + 1,
      ).padStart(40, '0');
      objects.set(sha, body);
      return Response.json({ sha }, { status: 201 });
    }
    return Response.json({ message: 'Unexpected endpoint' }, { status: 404 });
  };
}

function clientFor(fetcher: typeof fetch): GitHubClient {
  return new GitHubClient(
    {
      GITHUB_APP_ID: '1',
      GITHUB_INSTALLATION_ID: '2',
      GITHUB_APP_PRIVATE_KEY: privateKey,
      ARCHIVE_OWNER: owner,
      ARCHIVE_REPO: repo,
      ARCHIVE_DEFAULT_BRANCH: base,
    } as Env,
    fetcher,
  );
}

const lostResponseModes = [
  'network',
  'server-error',
  'invalid-json',
  'invalid-shape',
] as const;

function lostResponse(mode: (typeof lostResponseModes)[number]): Response {
  if (mode === 'network') {
    throw new TypeError('Response lost after GitHub persisted the write');
  }
  if (mode === 'server-error') {
    return Response.json({ message: 'Internal error' }, { status: 500 });
  }
  if (mode === 'invalid-json') {
    return new Response('not json', { status: 201 });
  }
  return Response.json({}, { status: 201 });
}

describe('GitHubClient', () => {
  it('rejects a malformed installation token without exposing its contents', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ token: 'sensitive-token', expires_at: null }),
      );
    await expect(clientFor(fetcher).readArchive()).rejects.toThrow(
      'github_installation_token_invalid_response',
    );
  });

  it('prepares the approved commit without publishing a branch or PR', async () => {
    const remote = new GitHubRemote();
    const input: CreateArchiveCommitInput = {
      commitMessage: 'Archive approved item',
      baseCommitSha: 'b'.repeat(40),
      baseTreeSha: 'c'.repeat(40),
      readme: '# Archive\n한글 문서',
      pinPath: 'pins/item.md',
      pinContent: '> Approved quotation',
    };
    const sha = await clientFor(remote.fetcher).createArchiveCommit(input);
    const blobs = [...remote.blobs.entries()];
    const tree = [...remote.trees.entries()][0]!;
    expect(
      blobs.map(([, blob]) =>
        Buffer.from(String(blob.content), 'base64').toString('utf8'),
      ),
    ).toEqual([input.readme, input.pinContent]);
    expect(blobs.every(([, blob]) => blob.encoding === 'base64')).toBe(true);
    expect(tree[1]).toEqual({
      base_tree: input.baseTreeSha,
      tree: [
        { path: 'README.md', mode: '100644', type: 'blob', sha: blobs[0]![0] },
        {
          path: input.pinPath,
          mode: '100644',
          type: 'blob',
          sha: blobs[1]![0],
        },
      ],
    });
    expect(remote.commits.get(sha)).toEqual({
      message: input.commitMessage,
      tree: tree[0],
      parents: [input.baseCommitSha],
    });
    expect(remote.refs.size).toBe(0);
    expect(remote.pulls).toEqual([]);
  });

  it.each(lostResponseModes)(
    'recovers a branch saved before a %s response failure across restart',
    async (mode) => {
      const remote = new GitHubRemote();
      remote.afterRefCreate = () => lostResponse(mode);
      await clientFor(remote.fetcher).ensureArchiveBranch(branch, commitSha);
      await clientFor(remote.fetcher).ensureArchiveBranch(branch, commitSha);
      expect(remote.refs.get(branch)).toBe(commitSha);
      expect(remote.writes).toHaveLength(1);
      expect(remote.writes[0]?.method).toBe('POST');
    },
  );

  it('recovers a saved branch after the first attempt cannot reconcile its lost response', async () => {
    const remote = new GitHubRemote();
    remote.afterRefCreate = () => {
      remote.refReadFailureStatus = 503;
      throw new TypeError('Response lost');
    };
    await expect(
      clientFor(remote.fetcher).ensureArchiveBranch(branch, commitSha),
    ).rejects.toThrow('github_reconciliation_failed');
    expect(remote.refs.get(branch)).toBe(commitSha);
    delete remote.refReadFailureStatus;
    await clientFor(remote.fetcher).ensureArchiveBranch(branch, commitSha);
    expect(remote.writes).toHaveLength(1);
    expect(remote.writes[0]?.method).toBe('POST');
  });

  it('does not overwrite an existing branch at a different commit', async () => {
    const remote = new GitHubRemote();
    const otherCommit = 'd'.repeat(40);
    remote.refs.set(branch, otherCommit);
    await expect(
      clientFor(remote.fetcher).ensureArchiveBranch(branch, commitSha),
    ).rejects.toThrow('github_branch_conflict');
    expect(remote.refs.get(branch)).toBe(otherCommit);
    expect(remote.writes).toEqual([]);
  });

  it.each([true, false])(
    'reconciles a racing branch creation without overwriting it (same=%s)',
    async (sameCommit) => {
      const remote = new GitHubRemote();
      const racingCommit = sameCommit ? commitSha : 'd'.repeat(40);
      remote.beforeRefCreate = () => {
        remote.refs.set(branch, racingCommit);
      };
      const result = clientFor(remote.fetcher).ensureArchiveBranch(
        branch,
        commitSha,
      );
      if (sameCommit) {
        await expect(result).resolves.toBeUndefined();
      } else {
        await expect(result).rejects.toThrow('github_branch_conflict');
      }
      expect(remote.refs.get(branch)).toBe(racingCommit);
      expect(remote.writes).toHaveLength(1);
      expect(remote.writes[0]?.method).toBe('POST');
    },
  );

  it('validates ref response identity and object shape before considering a branch safe', async () => {
    const remote = new GitHubRemote();
    remote.refResponse = {
      ref: 'refs/heads/someone-else',
      object: { type: 'commit', sha: commitSha },
    };
    await expect(
      clientFor(remote.fetcher).ensureArchiveBranch(branch, commitSha),
    ).rejects.toThrow('github_branch_conflict');
    remote.refResponse = {
      ref: `refs/heads/${branch}`,
      object: { sha: commitSha },
    };
    await expect(
      clientFor(remote.fetcher).ensureArchiveBranch(branch, commitSha),
    ).rejects.toThrow('github_invalid_response');
    expect(remote.writes).toEqual([]);
  });

  it('creates a Draft PR with the approved payload and reuses it on repeated invocation', async () => {
    const remote = new GitHubRemote();
    const client = clientFor(remote.fetcher);
    await client.ensureArchiveBranch(branch, commitSha);
    const created = await client.ensureArchiveDraftPr(publication);
    const repeated = await client.ensureArchiveDraftPr(publication);
    expect(created).toEqual({ branch, prUrl: remote.pulls[0]?.html_url });
    expect(repeated).toEqual(created);
    expect(remote.pulls).toHaveLength(1);
    expect(remote.pulls[0]).toMatchObject({
      draft: true,
      title: publication.title,
      body: publication.body,
      head: { ref: branch, sha: commitSha },
      base: { ref: base },
    });
    expect(
      remote.writes.filter((write) => write.path.endsWith('/pulls')),
    ).toHaveLength(1);
  });

  it.each(lostResponseModes)(
    'finds a PR saved before a %s response failure, including after closure and restart',
    async (mode) => {
      const remote = new GitHubRemote();
      remote.refs.set(branch, commitSha);
      remote.afterPrCreate = () => lostResponse(mode);
      const observed = await clientFor(remote.fetcher).ensureArchiveDraftPr(
        publication,
      );
      remote.pulls[0]!.state = 'closed';
      remote.pulls[0]!.draft = false;
      remote.refs.delete(branch);
      const restarted = await clientFor(remote.fetcher).ensureArchiveDraftPr(
        publication,
      );
      expect(observed).toEqual({ branch, prUrl: remote.pulls[0]!.html_url });
      expect(restarted).toEqual(observed);
      expect(remote.pulls).toHaveLength(1);
      expect(remote.writes).toHaveLength(1);
      expect(remote.writes[0]?.method).toBe('POST');
    },
  );

  it('reconciles a concurrent PR creation reported as 422', async () => {
    const remote = new GitHubRemote();
    remote.refs.set(branch, commitSha);
    remote.beforePrCreate = () => {
      remote.addPull();
    };
    const result = await clientFor(remote.fetcher).ensureArchiveDraftPr(
      publication,
    );
    expect(result.prUrl).toBe(remote.pulls[0]!.html_url);
    expect(remote.pulls).toHaveLength(1);
    expect(remote.writes).toHaveLength(1);
  });

  it('preserves the branch after a failed PR POST and can publish it on a later retry', async () => {
    const remote = new GitHubRemote();
    remote.refs.set(branch, commitSha);
    remote.beforePrCreate = () =>
      Response.json({ message: 'sensitive remote body' }, { status: 500 });
    await expect(
      clientFor(remote.fetcher).ensureArchiveDraftPr(publication),
    ).rejects.toThrow('github_http_500');
    expect(remote.refs.get(branch)).toBe(commitSha);
    expect(remote.pulls).toEqual([]);
    delete remote.beforePrCreate;
    await clientFor(remote.fetcher).ensureArchiveDraftPr(publication);
    expect(remote.pulls).toHaveLength(1);
    expect(remote.writes.every((write) => write.method === 'POST')).toBe(true);
    expect(remote.writes.every((write) => write.path.endsWith('/pulls'))).toBe(
      true,
    );
  });

  it('preserves an unknown successful write when reconciliation is unavailable', async () => {
    const remote = new GitHubRemote();
    remote.refs.set(branch, commitSha);
    remote.afterPrCreate = () => {
      remote.pullReadFailureStatus = 503;
      throw new TypeError('Response lost');
    };
    await expect(
      clientFor(remote.fetcher).ensureArchiveDraftPr(publication),
    ).rejects.toThrow('github_reconciliation_failed');
    expect(remote.refs.get(branch)).toBe(commitSha);
    expect(remote.pulls).toHaveLength(1);
    delete remote.pullReadFailureStatus;
    const result = await clientFor(remote.fetcher).ensureArchiveDraftPr(
      publication,
    );
    expect(result.prUrl).toBe(remote.pulls[0]!.html_url);
    expect(remote.writes).toHaveLength(1);
  });

  it('refuses an existing PR whose head commit no longer matches the approved commit', async () => {
    const remote = new GitHubRemote();
    const pr = remote.addPull('closed');
    pr.head.sha = 'd'.repeat(40);
    await expect(
      clientFor(remote.fetcher).ensureArchiveDraftPr(publication),
    ).rejects.toThrow('github_pr_conflict');
    expect(remote.pulls).toHaveLength(1);
    expect(remote.writes).toEqual([]);
  });

  it('does not create a replacement PR when the existing PR was retargeted', async () => {
    const remote = new GitHubRemote();
    const pr = remote.addPull('closed');
    pr.base.ref = 'release';
    await expect(
      clientFor(remote.fetcher).ensureArchiveDraftPr(publication),
    ).rejects.toThrow('github_pr_conflict');
    expect(remote.pulls).toHaveLength(1);
    expect(remote.writes).toEqual([]);
  });

  it.each(['head', 'base'] as const)(
    'refuses a PR with a conflicting %s repository',
    async (side) => {
      const remote = new GitHubRemote();
      const pr = remote.addPull();
      pr[side].repo!.name = 'another-repository';
      await expect(
        clientFor(remote.fetcher).ensureArchiveDraftPr(publication),
      ).rejects.toThrow('github_pr_conflict');
      expect(remote.writes).toEqual([]);
    },
  );

  it('refuses ambiguous historical PRs rather than picking one or creating another', async () => {
    const remote = new GitHubRemote();
    remote.addPull('closed');
    remote.addPull('closed');
    await expect(
      clientFor(remote.fetcher).ensureArchiveDraftPr(publication),
    ).rejects.toThrow('github_pr_ambiguous');
    expect(remote.pulls).toHaveLength(2);
    expect(remote.writes).toEqual([]);
  });

  it('checks the current branch commit before creating a new PR', async () => {
    const remote = new GitHubRemote();
    remote.refs.set(branch, 'd'.repeat(40));
    await expect(
      clientFor(remote.fetcher).ensureArchiveDraftPr(publication),
    ).rejects.toThrow('github_branch_conflict');
    expect(remote.pulls).toEqual([]);
    expect(remote.writes).toEqual([]);
  });

  it('does not create a PR when the persisted branch has disappeared', async () => {
    const remote = new GitHubRemote();
    await expect(
      clientFor(remote.fetcher).ensureArchiveDraftPr(publication),
    ).rejects.toThrow('github_branch_missing');
    expect(remote.writes).toEqual([]);
  });

  it('validates PR response fields instead of trusting a URL alone', async () => {
    const remote = new GitHubRemote();
    remote.pullListResponse = [
      { html_url: 'https://github.com/gwagjiug/archive/pull/1' },
    ];
    await expect(
      clientFor(remote.fetcher).ensureArchiveDraftPr(publication),
    ).rejects.toThrow('github_invalid_response');
    expect(remote.writes).toEqual([]);
  });

  it('refuses a newly returned PR with a different head, target, or draft flag', async () => {
    for (const changedField of ['head', 'target', 'draft'] as const) {
      const remote = new GitHubRemote();
      remote.refs.set(branch, commitSha);
      remote.afterPrCreate = (pr) => {
        if (changedField === 'head') {
          pr.head.sha = 'd'.repeat(40);
        } else if (changedField === 'target') {
          pr.base.ref = 'release';
        } else {
          pr.draft = false;
        }
        return Response.json(pr, { status: 201 });
      };
      await expect(
        clientFor(remote.fetcher).ensureArchiveDraftPr(publication),
      ).rejects.toThrow('github_pr_conflict');
      expect(remote.refs.get(branch)).toBe(commitSha);
      expect(remote.writes).toHaveLength(1);
      expect(remote.writes[0]?.method).toBe('POST');
    }
  });

  it('keeps failing read attempts bounded and does not write after a failed lookup', async () => {
    const remote = new GitHubRemote();
    remote.pullReadFailureStatus = 503;
    await expect(
      clientFor(remote.fetcher).ensureArchiveDraftPr(publication),
    ).rejects.toThrow('github_http_503');
    expect(remote.reads).toHaveLength(2);
    expect(remote.writes).toEqual([]);
  });

  it('refuses to create after a full result page that cannot prove uniqueness', async () => {
    const remote = new GitHubRemote();
    for (let index = 0; index < 101; index++) {
      remote.addPull('closed');
    }
    await expect(
      clientFor(remote.fetcher).ensureArchiveDraftPr(publication),
    ).rejects.toThrow('github_pr_lookup_limit');
    expect(remote.reads).toHaveLength(1);
    expect(remote.writes).toEqual([]);
  });
});
