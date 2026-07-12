import { CircuitBreaker } from "../../agent/circuit-breaker";
import { estimateCost } from "../../agent/budget";
import { normalizePublicUrl } from "../../policies/scope";
import { RunStore } from "../../storage/runs";
import { Tracer } from "../../telemetry/tracer";
import { DiscordClient, previewPayload } from "../../tools/discord";
import { GitHubClient } from "../../tools/github/client";
import { prepareArchiveEntry } from "../../tools/openai";
import { fetchMetadata } from "../../tools/web/metadata";
import type { ArchiveDraft, Env } from "../../types";
import {
  archiveEntry,
  extractCategories,
  hasUrl,
  insertReadmeEntry,
  renderPinFile,
  shortHash,
  slugify,
} from "./render";

type ArchiveSnapshot = Awaited<ReturnType<GitHubClient["readArchive"]>>;
type PreparedEntry = Awaited<ReturnType<typeof prepareArchiveEntry>>;

export interface ArchiveWorkflowDependencies {
  store: Pick<
    RunStore,
    "get" | "transition" | "saveDraft" | "fail" | "complete"
  >;
  github: {
    readArchive(): Promise<ArchiveSnapshot>;
    createDraftPr(
      input: Parameters<GitHubClient["createDraftPr"]>[0],
    ): Promise<{ branch: string; prUrl: string }>;
  };
  discord: Pick<DiscordClient, "editOriginal" | "createThread" | "sendMessage">;
  metadata(url: string): ReturnType<typeof fetchMetadata>;
  prepare(input: Parameters<typeof prepareArchiveEntry>[0]): Promise<PreparedEntry>;
  tracer: Pick<Tracer, "span">;
  circuit: CircuitBreaker;
}

export function createArchiveWorkflowDependencies(
  env: Env,
  runId: string,
  defer?: (promise: Promise<unknown>) => void,
): ArchiveWorkflowDependencies {
  return {
    store: new RunStore(env.DB),
    github: new GitHubClient(env),
    discord: new DiscordClient(env),
    metadata: fetchMetadata,
    prepare: prepareArchiveEntry,
    tracer: new Tracer(env, runId, defer),
    circuit: new CircuitBreaker(),
  };
}

export async function analyzeArchiveUrl(
  env: Env,
  input: { runId: string; pins: string[]; note?: string },
  dependencies = createArchiveWorkflowDependencies(env, input.runId),
): Promise<void> {
  const { store, github, discord, metadata, prepare, tracer, circuit } = dependencies;
  const row = await store.get(input.runId);
  if (!row || !row.source_url || !row.interaction_token) return;
  try {
    circuit.step();
    if (!(await store.transition(row.id, "RECEIVED", "VALIDATING"))) return;
    const normalizedUrl = normalizePublicUrl(row.source_url);
    circuit.step();
    await store.transition(row.id, "VALIDATING", "ANALYZING");

    circuit.tool("github.read_archive", row.id);
    const archive = await tracer.span(
      "github.read_archive",
      { "tool.read_write": "read", "ax.dimension": "environment" },
      () => github.readArchive(),
    );
    if (hasUrl(archive.readme, normalizedUrl))
      throw new Error("archive_duplicate_url");

    circuit.tool("web.fetch_metadata", normalizedUrl);
    const document = await tracer.span(
      "web.fetch_metadata",
      { "tool.read_write": "read", "ax.dimension": "environment" },
      () => metadata(normalizedUrl),
    );
    if (!document.title) throw new Error("metadata_title_missing");

    circuit.llm();
    const llm = await tracer.span(
      "llm.prepare_entry",
      {
        "ax.dimension": "agent_behavior",
        model: env.OPENAI_MODEL,
        pin_count: input.pins.length,
      },
      () =>
        prepare({
          apiKey: env.OPENAI_API_KEY,
          model: env.OPENAI_MODEL,
          title: document.title!,
          hostname: new URL(document.canonicalUrl).hostname,
          categories: extractCategories(archive.readme),
          pins: input.pins,
          ...(input.note ? { note: input.note } : {}),
        }),
    );
    circuit.usage(llm.usage);
    const cost = estimateCost(llm.usage);
    if (cost > Number(env.MAX_RUN_COST_USD))
      throw new Error("max_cost_exceeded");

    let slug = slugify(document.title);
    if (archive.files.has(`pins/${slug}.md`))
      slug = `${slug}-${await shortHash(document.canonicalUrl)}`;
    const pinPath = `pins/${slug}.md`;
    const draft: ArchiveDraft = {
      runId: row.id,
      title: document.title,
      url: document.canonicalUrl,
      pins: input.pins,
      slug,
      pinPath,
      pinContent: renderPinFile(document.title, document.canonicalUrl, input.pins),
      readmeBefore: archive.readme,
      readmeAfter: insertReadmeEntry(
        archive.readme,
        llm.preparation.category.name,
        archiveEntry(document.title, document.canonicalUrl, slug),
      ),
      baseCommitSha: archive.baseCommitSha,
      baseTreeSha: archive.baseTreeSha,
      model: env.OPENAI_MODEL,
      usage: llm.usage,
      estimatedCostUsd: cost,
      ...llm.preparation,
    };

    circuit.tool("discord.publish_preview", row.id);
    const original = await discord.editOriginal(row.interaction_token, {
      content: `📌 **${document.title}** 변경안을 준비했어요. 아래 스레드에서 확인해주세요.`,
      allowed_mentions: { parse: [] },
    });
    const thread = await discord.createThread(
      original.channel_id,
      original.id,
      `Hanni · ${document.title}`,
    );
    await discord.sendMessage(thread.id, previewPayload(draft));
    await store.saveDraft(row.id, draft, thread.id);
    await store.transition(row.id, "ANALYZING", "AWAITING_APPROVAL");
  } catch (error) {
    const current = await store.get(row.id);
    if (current?.status === "ANALYZING") {
      const category = errorCategory(error);
      const terminal = isBudgetFailure(category) ? "FAILED_BUDGET" : "FAILED_EXTERNAL";
      await store.fail(row.id, "ANALYZING", terminal, category);
    }
    await discord
      .editOriginal(row.interaction_token, {
        content: userFacingError(error),
        allowed_mentions: { parse: [] },
      })
      .catch(() => undefined);
  }
}

export async function approveDraft(
  env: Env,
  runId: string,
  userId: string,
  dependencies = createArchiveWorkflowDependencies(env, runId),
): Promise<{ branch: string; prUrl: string }> {
  const { store, github, circuit, tracer } = dependencies;
  const row = await store.get(runId);
  if (!row || row.discord_user_id !== userId)
    throw new Error("approval_forbidden");
  if (Date.parse(row.expires_at) < Date.now()) {
    if (row.status === "AWAITING_APPROVAL")
      await store.transition(
        runId,
        "AWAITING_APPROVAL",
        "EXPIRED",
        "approval_timeout",
      );
    throw new Error("approval_expired");
  }
  if (!row.draft_json) throw new Error("draft_missing");
  if (!(await store.transition(runId, "AWAITING_APPROVAL", "CREATING_PR")))
    throw new Error("approval_already_processed");

  const draft = JSON.parse(row.draft_json) as ArchiveDraft;
  try {
    circuit.tool("github.revalidate", runId);
    const latest = await tracer.span(
      "github.revalidate",
      { "tool.read_write": "read", "ax.dimension": "agent_behavior" },
      () => github.readArchive(),
    );
    if (hasUrl(latest.readme, draft.url))
      throw new Error("archive_duplicate_url");
    if (latest.files.has(draft.pinPath))
      throw new Error("archive_slug_collision_after_approval");

    const readme = insertReadmeEntry(
      latest.readme,
      draft.category.name,
      archiveEntry(draft.title, draft.url, draft.slug),
    );
    const pinContent = renderPinFile(draft.title, draft.url, draft.pins);
    circuit.tool("github.create_archive_draft_pr", runId);
    const result = await tracer.span(
      "github.create_archive_draft_pr",
      { "tool.read_write": "write", "ax.dimension": "goal_achievement" },
      () =>
        github.createDraftPr({
          runId,
          title: draft.prTitle,
          body: draft.prBody,
          commitMessage: `archive: add ${draft.title}`,
          baseCommitSha: latest.baseCommitSha,
          baseTreeSha: latest.baseTreeSha,
          readme,
          pinPath: draft.pinPath,
          pinContent,
        }),
    );
    await store.complete(runId, result.branch, result.prUrl);
    return result;
  } catch (error) {
    await store.fail(
      runId,
      "CREATING_PR",
      isBudgetFailure(errorCategory(error)) ? "FAILED_BUDGET" : "FAILED_EXTERNAL",
      errorCategory(error),
    );
    throw error;
  }
}

function isBudgetFailure(category: string): boolean {
  return category === "max_cost_exceeded" || category.startsWith("circuit_");
}

function errorCategory(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.split(":", 1)[0]!.slice(0, 100);
}

function userFacingError(error: unknown): string {
  const category = errorCategory(error);
  if (category === "archive_duplicate_url")
    return "이 URL은 archive에 이미 등록되어 있어요.";
  if (category === "metadata_title_missing")
    return "문서 제목을 확인하지 못했어요. 현재 MVP에서는 자동 생성을 중단합니다.";
  if (isBudgetFailure(category))
    return "실행 제한을 초과해 archive 변경 없이 중단했어요.";
  return `변경안을 준비하지 못했어요. 오류 분류: \`${category}\``;
}
