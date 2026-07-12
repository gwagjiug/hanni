import { estimateCost } from '../../agent/budget';
import { normalizePublicUrl } from '../../policies/scope';
import { previewPayload } from '../../tools/discord';
import type { ArchiveDraft, Env } from '../../types';
import { createArchiveWorkflowDependencies } from './dependencies';
import { errorCategory, isBudgetFailure, userFacingError } from './errors';
import {
  archiveEntry,
  extractCategories,
  hasUrl,
  insertReadmeEntry,
  renderPinFile,
  shortHash,
  slugify,
} from './render';

export async function analyzeArchiveUrl(
  env: Env,
  input: { runId: string; pins: string[]; note?: string },
  dependencies = createArchiveWorkflowDependencies(env, input.runId),
): Promise<void> {
  const { store, github, discord, metadata, prepare, tracer, circuit } =
    dependencies;
  const row = await store.get(input.runId);
  if (!row?.source_url || !row.interaction_token) {
    return;
  }
  try {
    circuit.step();
    if (!(await store.transition(row.id, 'RECEIVED', 'VALIDATING'))) {
      return;
    }
    const normalizedUrl = normalizePublicUrl(row.source_url);
    circuit.step();
    await store.transition(row.id, 'VALIDATING', 'ANALYZING');

    circuit.tool('github.read_archive', row.id);
    const archive = await tracer.span(
      'github.read_archive',
      { 'tool.read_write': 'read', 'ax.dimension': 'environment' },
      () => github.readArchive(),
    );
    if (hasUrl(archive.readme, normalizedUrl)) {
      throw new Error('archive_duplicate_url');
    }

    circuit.tool('web.fetch_metadata', normalizedUrl);
    const document = await tracer.span(
      'web.fetch_metadata',
      { 'tool.read_write': 'read', 'ax.dimension': 'environment' },
      () => metadata(normalizedUrl),
    );
    if (!document.title) {
      throw new Error('metadata_title_missing');
    }
    const title = document.title;

    circuit.llm();
    const llm = await tracer.span(
      'llm.prepare_entry',
      {
        'ax.dimension': 'agent_behavior',
        model: env.OPENAI_MODEL,
        pin_count: input.pins.length,
      },
      () =>
        prepare({
          apiKey: env.OPENAI_API_KEY,
          model: env.OPENAI_MODEL,
          title,
          hostname: new URL(document.canonicalUrl).hostname,
          categories: extractCategories(archive.readme),
          pins: input.pins,
          ...(input.note ? { note: input.note } : {}),
        }),
    );
    circuit.usage(llm.usage);
    const cost = estimateCost(llm.usage);
    if (cost > Number(env.MAX_RUN_COST_USD)) {
      throw new Error('max_cost_exceeded');
    }

    let slug = slugify(title);
    if (archive.files.has(`pins/${slug}.md`)) {
      slug = `${slug}-${await shortHash(document.canonicalUrl)}`;
    }
    const pinPath = `pins/${slug}.md`;
    const draft: ArchiveDraft = {
      runId: row.id,
      title,
      url: document.canonicalUrl,
      pins: input.pins,
      slug,
      pinPath,
      pinContent: renderPinFile(title, document.canonicalUrl, input.pins),
      readmeBefore: archive.readme,
      readmeAfter: insertReadmeEntry(
        archive.readme,
        llm.preparation.category.name,
        archiveEntry(title, document.canonicalUrl, slug),
      ),
      baseCommitSha: archive.baseCommitSha,
      baseTreeSha: archive.baseTreeSha,
      model: env.OPENAI_MODEL,
      usage: llm.usage,
      estimatedCostUsd: cost,
      ...llm.preparation,
    };

    circuit.tool('discord.publish_preview', row.id);
    const original = await discord.editOriginal(row.interaction_token, {
      content: `📌 **${title}** 변경안을 준비했어요. 아래 스레드에서 확인해주세요.`,
      allowed_mentions: { parse: [] },
    });
    const thread = await discord.createThread(
      original.channel_id,
      original.id,
      `Hanni · ${title}`,
    );
    await discord.sendMessage(thread.id, previewPayload(draft));
    await store.saveDraft(row.id, draft, thread.id);
    await store.transition(row.id, 'ANALYZING', 'AWAITING_APPROVAL');
  } catch (error) {
    const current = await store.get(row.id);
    if (current?.status === 'ANALYZING') {
      const category = errorCategory(error);
      await store.fail(
        row.id,
        'ANALYZING',
        isBudgetFailure(category) ? 'FAILED_BUDGET' : 'FAILED_EXTERNAL',
        category,
      );
    }
    await discord
      .editOriginal(row.interaction_token, {
        content: userFacingError(error),
        allowed_mentions: { parse: [] },
      })
      .catch(() => undefined);
  }
}
