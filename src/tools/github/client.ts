import { z } from 'zod';
import type { Env } from '../../types';

const shaSchema = z.object({ sha: z.string().min(1) });
const installationTokenSchema = z.object({
  token: z.string().min(1),
  expires_at: z.string().datetime(),
});
const refSchema = z.object({ object: shaSchema });
const commitSchema = z.object({ tree: shaSchema });
const contentSchema = z.object({ content: z.string() });
const treeSchema = z.object({
  tree: z.array(z.object({ path: z.string() })),
});
const pullRequestSchema = z.object({ html_url: z.string().url() });

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

export interface CreateDraftPrInput {
  runId: string;
  title: string;
  body: string;
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
    const data = installationTokenSchema.parse(await response.json());
    this.installationToken = {
      value: data.token,
      expiresAt: Date.parse(data.expires_at),
    };
    return data.token;
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
        const value =
          response.status === 204 ? undefined : await response.json();
        return schema.parse(value);
      }
      const retryableRead =
        method === 'GET' &&
        attempt === 0 &&
        (response.status === 429 || response.status >= 500);
      if (!retryableRead) {
        throw new Error(`github_http_${response.status}:${path}`);
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

  async createDraftPr(
    input: CreateDraftPrInput,
  ): Promise<{ branch: string; prUrl: string }> {
    const {
      ARCHIVE_OWNER: owner,
      ARCHIVE_REPO: repo,
      ARCHIVE_DEFAULT_BRANCH: base,
    } = this.env;
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const branch = `hanni/archive-${day}-${input.runId.slice(0, 8)}`;
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
    await this.request(`/repos/${owner}/${repo}/git/refs`, z.unknown(), {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }),
    });
    try {
      const pr = await this.request(
        `/repos/${owner}/${repo}/pulls`,
        pullRequestSchema,
        {
          method: 'POST',
          body: JSON.stringify({
            title: input.title,
            body: input.body,
            head: branch,
            base,
            draft: true,
          }),
        },
      );
      return { branch, prUrl: pr.html_url };
    } catch (error) {
      try {
        await this.request(
          `/repos/${owner}/${repo}/git/refs/heads/${branch}`,
          z.undefined(),
          { method: 'DELETE' },
        );
      } catch {
        throw new Error(`github_pr_failed_branch_cleanup_failed:${branch}`, {
          cause: error,
        });
      }
      throw error;
    }
  }
}
