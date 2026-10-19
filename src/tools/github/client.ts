import { z } from 'zod';
import type { Env } from '../../types';

const shaSchema = z.object({ sha: z.string().min(1) });
const installationTokenSchema = z.object({
  token: z.string().min(1),
  expires_at: z.string().datetime(),
});
const refSchema = z.object({
  ref: z.string().min(1),
  object: shaSchema.extend({ type: z.literal('commit') }),
});
const commitSchema = z.object({ tree: shaSchema });
const contentSchema = z.object({ content: z.string() });
const treeSchema = z.object({
  tree: z.array(z.object({ path: z.string() })),
});
const pullRequestRefSchema = z.object({
  ref: z.string().min(1),
  sha: z.string().min(1),
  repo: z
    .object({
      name: z.string().min(1),
      owner: z.object({ login: z.string().min(1) }),
    })
    .nullable(),
});
const pullRequestSchema = z.object({
  number: z.number().int().positive(),
  html_url: z.string().url(),
  state: z.enum(['open', 'closed']),
  draft: z.boolean().optional(),
  head: pullRequestRefSchema,
  base: pullRequestRefSchema,
});
type PullRequest = z.infer<typeof pullRequestSchema>;

class GitHubHttpError extends Error {
  constructor(
    readonly status: number,
    path: string,
  ) {
    super(`github_http_${status}:${path}`);
  }
}

class GitHubConflictError extends Error {}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function utf8Base64(value: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(value)));
}

function base64Utf8(value: string): string {
  const bytes = Uint8Array.from(atob(value.replace(/\n/g, '')), (char) =>
    char.charCodeAt(0),
  );
  return new TextDecoder().decode(bytes);
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const normalized = pem.replace(/\\n/g, '\n');
  const body = normalized.replace(
    /-----BEGIN (?:RSA )?PRIVATE KEY-----|-----END (?:RSA )?PRIVATE KEY-----|\s/g,
    '',
  );
  const der = Uint8Array.from(atob(body), (char) => char.charCodeAt(0));
  return crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

async function appJwt(appId: string, privateKey: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(
    new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })),
  );
  const payload = base64Url(
    new TextEncoder().encode(
      JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }),
    ),
  );
  const unsigned = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    await importPrivateKey(privateKey),
    new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
}

export interface ArchiveSnapshot {
  readme: string;
  baseCommitSha: string;
  baseTreeSha: string;
  files: Set<string>;
}

export interface CreateArchiveCommitInput {
  commitMessage: string;
  baseCommitSha: string;
  baseTreeSha: string;
  readme: string;
  pinPath: string;
  pinContent: string;
}

export class GitHubClient {
  private installationToken?: { value: string; expiresAt: number };

  constructor(
    private readonly env: Env,
    private readonly fetcher: typeof fetch = (input, init) =>
      fetch(input, init),
  ) {}

  private async token(): Promise<string> {
    if (
      this.installationToken &&
      this.installationToken.expiresAt > Date.now() + 60_000
    ) {
      return this.installationToken.value;
    }
    const jwt = await appJwt(
      this.env.GITHUB_APP_ID,
      this.env.GITHUB_APP_PRIVATE_KEY,
    );
    const response = await this.fetcher(
      `https://api.github.com/app/installations/${this.env.GITHUB_INSTALLATION_ID}/access_tokens`,
      { method: 'POST', headers: this.headers(jwt) },
    );
    if (!response.ok) {
      throw new Error(`github_installation_token_${response.status}`);
    }
    const data = await response.json().catch(() => null);
    const parsed = installationTokenSchema.safeParse(data);
    if (!parsed.success) {
      throw new Error('github_installation_token_invalid_response');
    }
    this.installationToken = {
      value: parsed.data.token,
      expiresAt: Date.parse(parsed.data.expires_at),
    };
    return parsed.data.token;
  }

  private headers(token: string, input?: HeadersInit): Headers {
    const headers = new Headers(input);
    headers.set('accept', 'application/vnd.github+json');
    headers.set('authorization', `Bearer ${token}`);
    headers.set('x-github-api-version', '2022-11-28');
    headers.set('user-agent', 'hanni-agent');
    headers.set('content-type', 'application/json');
    return headers;
  }

  private async request<T>(
    path: string,
    schema: z.ZodType<T>,
    init: RequestInit = {},
  ): Promise<T> {
    const method = init.method ?? 'GET';
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await this.fetcher(`https://api.github.com${path}`, {
        ...init,
        headers: this.headers(await this.token(), init.headers),
      });
      if (response.ok) {
        try {
          const value =
            response.status === 204 ? undefined : await response.json();
          const parsed = schema.safeParse(value);
          if (parsed.success) {
            return parsed.data;
          }
        } catch {
          // Response bodies may contain credentials or untrusted remote content.
        }
        throw new Error(`github_invalid_response:${path}`);
      }
      const retryableRead =
        method === 'GET' &&
        attempt === 0 &&
        (response.status === 429 || response.status >= 500);
      if (!retryableRead) {
        throw new GitHubHttpError(response.status, path);
      }
    }
    throw new Error(`github_retry_exhausted:${path}`);
  }

  async readArchive(): Promise<ArchiveSnapshot> {
    const {
      ARCHIVE_OWNER: owner,
      ARCHIVE_REPO: repo,
      ARCHIVE_DEFAULT_BRANCH: branch,
    } = this.env;
    const ref = await this.request(
      `/repos/${owner}/${repo}/git/ref/heads/${branch}`,
      refSchema,
    );
    const commit = await this.request(
      `/repos/${owner}/${repo}/git/commits/${ref.object.sha}`,
      commitSchema,
    );
    const readme = await this.request(
      `/repos/${owner}/${repo}/contents/README.md?ref=${ref.object.sha}`,
      contentSchema,
    );
    const tree = await this.request(
      `/repos/${owner}/${repo}/git/trees/${commit.tree.sha}?recursive=1`,
      treeSchema,
    );
    return {
      readme: base64Utf8(readme.content),
      baseCommitSha: ref.object.sha,
      baseTreeSha: commit.tree.sha,
      files: new Set(tree.tree.map((item) => item.path)),
    };
  }

  async createArchiveCommit(input: CreateArchiveCommitInput): Promise<string> {
    const { ARCHIVE_OWNER: owner, ARCHIVE_REPO: repo } = this.env;
    const readmeBlob = await this.request(
      `/repos/${owner}/${repo}/git/blobs`,
      shaSchema,
      {
        method: 'POST',
        body: JSON.stringify({
          content: utf8Base64(input.readme),
          encoding: 'base64',
        }),
      },
    );
    const pinBlob = await this.request(
      `/repos/${owner}/${repo}/git/blobs`,
      shaSchema,
      {
        method: 'POST',
        body: JSON.stringify({
          content: utf8Base64(input.pinContent),
          encoding: 'base64',
        }),
      },
    );
    const tree = await this.request(
      `/repos/${owner}/${repo}/git/trees`,
      shaSchema,
      {
        method: 'POST',
        body: JSON.stringify({
          base_tree: input.baseTreeSha,
          tree: [
            {
              path: 'README.md',
              mode: '100644',
              type: 'blob',
              sha: readmeBlob.sha,
            },
            {
              path: input.pinPath,
              mode: '100644',
              type: 'blob',
              sha: pinBlob.sha,
            },
          ],
        }),
      },
    );
    const commit = await this.request(
      `/repos/${owner}/${repo}/git/commits`,
      shaSchema,
      {
        method: 'POST',
        body: JSON.stringify({
          message: input.commitMessage,
          tree: tree.sha,
          parents: [input.baseCommitSha],
        }),
      },
    );
    return commit.sha;
  }

  private async archiveBranch(
    branch: string,
  ): Promise<z.infer<typeof refSchema> | null> {
    const { ARCHIVE_OWNER: owner, ARCHIVE_REPO: repo } = this.env;
    try {
      const ref = await this.request(
        `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
        refSchema,
      );
      if (ref.ref !== `refs/heads/${branch}`) {
        throw new GitHubConflictError('github_branch_conflict');
      }
      return ref;
    } catch (error) {
      if (error instanceof GitHubHttpError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  private assertBranchCommit(
    ref: z.infer<typeof refSchema>,
    branch: string,
    commitSha: string,
  ): void {
    if (ref.ref !== `refs/heads/${branch}` || ref.object.sha !== commitSha) {
      throw new GitHubConflictError('github_branch_conflict');
    }
  }

  async ensureArchiveBranch(branch: string, commitSha: string): Promise<void> {
    const existing = await this.archiveBranch(branch);
    if (existing) {
      this.assertBranchCommit(existing, branch, commitSha);
      return;
    }
    const { ARCHIVE_OWNER: owner, ARCHIVE_REPO: repo } = this.env;
    let created: z.infer<typeof refSchema>;
    try {
      created = await this.request(
        `/repos/${owner}/${repo}/git/refs`,
        refSchema,
        {
          method: 'POST',
          body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commitSha }),
        },
      );
    } catch (error) {
      let observed: z.infer<typeof refSchema> | null;
      try {
        observed = await this.archiveBranch(branch);
      } catch (reconciliationError) {
        if (reconciliationError instanceof GitHubConflictError) {
          throw reconciliationError;
        }
        throw new Error('github_reconciliation_failed');
      }
      if (!observed) {
        throw error;
      }
      this.assertBranchCommit(observed, branch, commitSha);
      return;
    }
    this.assertBranchCommit(created, branch, commitSha);
  }

  private assertPullRequest(
    pr: PullRequest,
    branch: string,
    commitSha: string,
  ): void {
    const {
      ARCHIVE_OWNER: owner,
      ARCHIVE_REPO: repo,
      ARCHIVE_DEFAULT_BRANCH: base,
    } = this.env;
    if (
      pr.head.ref !== branch ||
      pr.head.sha !== commitSha ||
      pr.head.repo?.owner.login.toLowerCase() !== owner.toLowerCase() ||
      pr.head.repo?.name.toLowerCase() !== repo.toLowerCase() ||
      pr.base.ref !== base ||
      pr.base.repo?.owner.login.toLowerCase() !== owner.toLowerCase() ||
      pr.base.repo?.name.toLowerCase() !== repo.toLowerCase()
    ) {
      throw new GitHubConflictError('github_pr_conflict');
    }
  }

  private async findArchivePullRequest(
    branch: string,
    commitSha: string,
  ): Promise<PullRequest | null> {
    const {
      ARCHIVE_OWNER: owner,
      ARCHIVE_REPO: repo,
      ARCHIVE_DEFAULT_BRANCH: base,
    } = this.env;
    const query = new URLSearchParams({
      state: 'all',
      head: `${owner}:${branch}`,
      base,
      per_page: '100',
      page: '1',
    });
    let matches = await this.request(
      `/repos/${owner}/${repo}/pulls?${query}`,
      z.array(pullRequestSchema),
    );
    if (matches.length === 0) {
      // A manually retargeted PR must not turn a replay into a second PR.
      query.delete('base');
      matches = await this.request(
        `/repos/${owner}/${repo}/pulls?${query}`,
        z.array(pullRequestSchema),
      );
    }
    // A full page cannot establish uniqueness without an unbounded lookup.
    if (matches.length >= 100) {
      throw new Error('github_pr_lookup_limit');
    }
    for (const pr of matches) {
      this.assertPullRequest(pr, branch, commitSha);
    }
    if (matches.length > 1) {
      throw new GitHubConflictError('github_pr_ambiguous');
    }
    return matches[0] ?? null;
  }

  async findArchiveDraftPr(
    branch: string,
    commitSha: string,
  ): Promise<{ branch: string; prUrl: string } | null> {
    const existing = await this.findArchivePullRequest(branch, commitSha);
    return existing ? { branch, prUrl: existing.html_url } : null;
  }

  async ensureArchiveDraftPr(input: {
    branch: string;
    commitSha: string;
    title: string;
    body: string;
  }): Promise<{ branch: string; prUrl: string }> {
    const existing = await this.findArchivePullRequest(
      input.branch,
      input.commitSha,
    );
    if (existing) {
      return { branch: input.branch, prUrl: existing.html_url };
    }
    const ref = await this.archiveBranch(input.branch);
    if (!ref) {
      throw new Error('github_branch_missing');
    }
    this.assertBranchCommit(ref, input.branch, input.commitSha);
    const {
      ARCHIVE_OWNER: owner,
      ARCHIVE_REPO: repo,
      ARCHIVE_DEFAULT_BRANCH: base,
    } = this.env;
    let created: PullRequest;
    try {
      created = await this.request(
        `/repos/${owner}/${repo}/pulls`,
        pullRequestSchema,
        {
          method: 'POST',
          body: JSON.stringify({
            title: input.title,
            body: input.body,
            head: input.branch,
            base,
            draft: true,
          }),
        },
      );
    } catch (error) {
      let observed: PullRequest | null;
      try {
        observed = await this.findArchivePullRequest(
          input.branch,
          input.commitSha,
        );
      } catch (reconciliationError) {
        if (reconciliationError instanceof GitHubConflictError) {
          throw reconciliationError;
        }
        throw new Error('github_reconciliation_failed');
      }
      if (!observed) {
        throw error;
      }
      return { branch: input.branch, prUrl: observed.html_url };
    }
    this.assertPullRequest(created, input.branch, input.commitSha);
    if (created.draft !== true) {
      throw new GitHubConflictError('github_pr_conflict');
    }
    return { branch: input.branch, prUrl: created.html_url };
  }
}
