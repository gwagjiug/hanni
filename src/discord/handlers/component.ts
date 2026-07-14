import { approvalFailureMessage } from '../../skills/archive-url/errors';
import {
  approveDraft,
  createArchiveWorkflowDependencies,
} from '../../skills/archive-url/run';
import { RunStore } from '../../storage/runs';
import {
  DiscordClient,
  editModal,
  errorResponse,
  InteractionResponseType,
  jsonResponse,
} from '../../tools/discord';
import type { Env } from '../../types';
import { parseArchiveDraft } from '../../skills/archive-url/schema';
import {
  interactionUserId,
  type DiscordComponentInteraction,
} from '../interaction';

export async function handleComponent(
  interaction: DiscordComponentInteraction,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const [, action, runId] = (interaction.data?.custom_id ?? '').split(':');
  const store = new RunStore(env.DB);
  const row = runId ? await store.get(runId) : null;
  const userId = interactionUserId(interaction);
  if (!row || row.discord_user_id !== userId) {
    return errorResponse('이 실행을 변경할 권한이 없어요.');
  }
  if (action === 'edit' && row.draft_json) {
    try {
      return editModal(parseArchiveDraft(row.draft_json));
    } catch {
      return errorResponse(
        '저장된 변경안 형식이 올바르지 않아 수정할 수 없어요.',
      );
    }
  }
  if (action === 'cancel') {
    if (!(await store.cancel(runId!))) {
      return errorResponse('이미 처리된 실행이에요.');
    }
    return jsonResponse({
      type: InteractionResponseType.UPDATE_MESSAGE,
      data: {
        content: '취소했어요. archive에는 아무 변경도 만들지 않았어요.',
        components: [],
        allowed_mentions: { parse: [] },
      },
    });
  }
  if (action === 'approve') {
    const discord = new DiscordClient(env);
    ctx.waitUntil(
      approveDraft(
        env,
        runId!,
        userId,
        createArchiveWorkflowDependencies(env, runId!),
      )
        .then((result) =>
          discord.sendMessage(row.thread_id ?? row.channel_id, {
            content: `✅ Draft PR을 만들었어요.\n${result.prUrl}`,
            allowed_mentions: { parse: [] },
          }),
        )
        .catch((error) =>
          discord.sendMessage(row.thread_id ?? row.channel_id, {
            content: approvalFailureMessage(error),
            allowed_mentions: { parse: [] },
          }),
        ),
    );
    return jsonResponse({ type: InteractionResponseType.DEFERRED_UPDATE });
  }
  return errorResponse('지원하지 않는 Hanni 동작이에요.');
}
