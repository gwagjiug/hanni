import { editableDraftSchema, parsePins } from '../../skills/archive-url/input';
import { normalizePublicUrl, OUT_OF_SCOPE_MESSAGE } from '../../policies/scope';
import {
  archiveEntry,
  extractCategories,
  insertReadmeEntry,
  renderPinFile,
} from '../../skills/archive-url/render';
import { RunStore } from '../../storage/runs';
import {
  componentValue,
  errorResponse,
  InteractionResponseType,
  jsonResponse,
  previewPayload,
} from '../../tools/discord';
import type { ArchiveDraft, Env } from '../../types';
import { parseArchiveDraft } from '../../skills/archive-url/schema';
import {
  interactionUserId,
  isInteractionAuthorized,
  type DiscordModalInteraction,
} from '../interaction';
import { createAndAnalyze } from '../start-run';

export async function handleModal(
  interaction: DiscordModalInteraction,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const [, action, runId] = (interaction.data?.custom_id ?? '').split(':');
  const store = new RunStore(env.DB);
  if (action === 'create') {
    if (!runId || !isInteractionAuthorized(interaction, env)) {
      return errorResponse(
        '이 서버·채널·사용자에게는 Hanni 실행 권한이 없어요.',
      );
    }
    let pins: string[];
    try {
      pins = parsePins(componentValue(interaction.data, 'pins'));
    } catch (error) {
      return errorResponse(
        error instanceof Error ? error.message : 'Pin 입력이 올바르지 않아요.',
      );
    }
    let url: string;
    try {
      url = normalizePublicUrl(componentValue(interaction.data, 'url'));
    } catch {
      return errorResponse(OUT_OF_SCOPE_MESSAGE);
    }
    const note = componentValue(interaction.data, 'note').trim();
    const defer = (promise: Promise<unknown>) => ctx.waitUntil(promise);
    ctx.waitUntil(
      createAndAnalyze(env, interaction, runId, url, pins, note, defer),
    );
    return jsonResponse({
      type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE,
      data: { allowed_mentions: { parse: [] } },
    });
  }
  const row = runId ? await store.get(runId) : null;
  if (!row || row.discord_user_id !== interactionUserId(interaction)) {
    return errorResponse('이 실행을 수정할 권한이 없어요.');
  }
  if (action !== 'edit-submit' || !row.draft_json) {
    return errorResponse('지원하지 않는 Hanni 모달이에요.');
  }

  let previous: ArchiveDraft;
  try {
    previous = parseArchiveDraft(row.draft_json);
  } catch {
    return errorResponse(
      '저장된 변경안 형식이 올바르지 않아 수정할 수 없어요.',
    );
  }
  const prCopy = componentValue(interaction.data, 'pr_copy').replace(
    /\r\n/g,
    '\n',
  );
  const [prTitle = '', ...bodyLines] = prCopy.split('\n');
  let parsedPins: string[];
  try {
    parsedPins = parsePins(componentValue(interaction.data, 'pins'));
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : 'Pin 입력이 올바르지 않아요.',
    );
  }
  const candidate = editableDraftSchema.safeParse({
    title: componentValue(interaction.data, 'title'),
    category: componentValue(interaction.data, 'category'),
    slug: componentValue(interaction.data, 'slug'),
    pins: parsedPins,
    prTitle,
    prBody: bodyLines.join('\n').trim(),
  });
  if (!candidate.success) {
    return errorResponse(
      `수정 내용을 검증하지 못했어요: ${candidate.error.issues[0]?.message ?? 'invalid'}`,
    );
  }
  const pinPath = `pins/${candidate.data.slug}.md`;
  const categoryMode = extractCategories(previous.readmeBefore).includes(
    candidate.data.category,
  )
    ? 'existing'
    : 'new';
  const updated: ArchiveDraft = {
    ...previous,
    title: candidate.data.title,
    category: {
      name: candidate.data.category,
      mode: categoryMode,
      rationale: '사용자가 미리보기에서 수정함',
    },
    slug: candidate.data.slug,
    pins: candidate.data.pins,
    prTitle: candidate.data.prTitle,
    prBody: candidate.data.prBody,
    pinPath,
    pinContent: renderPinFile(
      candidate.data.title,
      previous.url,
      candidate.data.pins,
    ),
    readmeAfter: insertReadmeEntry(
      previous.readmeBefore,
      candidate.data.category,
      archiveEntry(candidate.data.title, previous.url, candidate.data.slug),
    ),
  };
  await store.replaceDraft(runId!, updated);
  return jsonResponse({
    type: InteractionResponseType.UPDATE_MESSAGE,
    data: previewPayload(updated),
  });
}
