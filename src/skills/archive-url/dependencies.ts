import { CircuitBreaker } from '../../agent/circuit-breaker';
import { RunStore } from '../../storage/runs';
import { Tracer } from '../../telemetry/tracer';
import { DiscordClient } from '../../tools/discord';
import { GitHubClient, type ArchiveSnapshot } from '../../tools/github/client';
import { prepareArchiveEntry } from '../../tools/openai';
import { fetchMetadata } from '../../tools/web/metadata';
import type { Env } from '../../types';

type PreparedEntry = Awaited<ReturnType<typeof prepareArchiveEntry>>;

export interface ArchiveWorkflowDependencies {
  store: Pick<RunStore, 'get' | 'transition' | 'saveDraft' | 'fail'>;
  github: {
    readArchive(): Promise<ArchiveSnapshot>;
  };
  discord: Pick<DiscordClient, 'editOriginal' | 'createThread' | 'sendMessage'>;
  metadata(url: string): ReturnType<typeof fetchMetadata>;
  prepare(
    input: Parameters<typeof prepareArchiveEntry>[0],
  ): Promise<PreparedEntry>;
  tracer: Pick<Tracer, 'span'>;
  circuit: CircuitBreaker;
}

export function createArchiveWorkflowDependencies(
  env: Env,
  runId: string,
): ArchiveWorkflowDependencies {
  return {
    store: new RunStore(env.DB),
    github: new GitHubClient(env),
    discord: new DiscordClient(env),
    metadata: fetchMetadata,
    prepare: prepareArchiveEntry,
    tracer: new Tracer(runId),
    circuit: new CircuitBreaker(),
  };
}
