import { approveDraft } from '../../skills/archive-url/approve';
import { errorCategory } from '../../skills/archive-url/errors';
import { PublicationStore } from '../../storage/publications';
import { RunStore } from '../../storage/runs';
import {
  previewPayload,
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
import { dispatchArchivePublication } from '../../workflows/publication-dispatch';

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
    if (row.status !== 'AWAITING_APPROVAL') {
      return errorResponse('이미 승인되었거나 종료된 실행은 수정할 수 없어요.');
    }
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
    try {
      const publication = await approveDraft(env, runId!, userId);
      if (publication.outcome === 'failed') {
        return errorResponse(
          '종료된 실행이에요. `/hanni-status`에서 확인해주세요.',
        );
      }
      if (publication.outcome === 'succeeded' && publication.pr_url) {
        return jsonResponse({
          type: InteractionResponseType.UPDATE_MESSAGE,
          data: {
            content: `Draft PR이 이미 생성되었어요.\n${publication.pr_url}`,
            components: [],
            embeds: [],
            allowed_mentions: { parse: [] },
          },
        });
      }
      // The intent is committed before acknowledging; cron can recover dispatch.
      ctx.waitUntil(
        dispatchArchivePublication(env, runId!).catch(
          async (error: unknown) => {
            const category = errorCategory(error);
            await new PublicationStore(env.DB).markUnknown(runId!, category);
            console.warn({
              event: 'hanni.publication.dispatch_failed',
              runId,
              errorCategory: category,
            });
          },
        ),
      );
      const draft = parseArchiveDraft(publication.draft_json!);
      return jsonResponse({
        type: InteractionResponseType.UPDATE_MESSAGE,
        data: {
          ...previewPayload(draft),
          content:
            `**${draft.title}** 승인을 저장했어요. Draft PR 생성을 진행합니다.\n` +
            `실행 ID: \`${runId}\` · \`/hanni-status\`에서 진행 상황을 확인할 수 있어요.`,
          components: [],
        },
      });
    } catch (error) {
      const category = errorCategory(error);
      return errorResponse(
        category === 'approval_expired'
          ? '승인 기한이 만료되었어요.'
          : '승인 상태를 확인하지 못했어요. `/hanni-status`에서 확인한 뒤 다시 시도해주세요.',
      );
    }
  }
  return errorResponse('지원하지 않는 Hanni 동작이에요.');
}
