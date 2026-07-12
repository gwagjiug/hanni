import {
  approveDraft,
  createArchiveWorkflowDependencies,
} from "../../skills/archive-url/run";
import { RunStore } from "../../storage/runs";
import {
  DiscordClient,
  editModal,
  errorResponse,
  InteractionResponseType,
  jsonResponse,
} from "../../tools/discord";
import type { ArchiveDraft, Env } from "../../types";
import { interactionUserId, type DiscordInteraction } from "../interaction";

export async function handleComponent(
  interaction: DiscordInteraction,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const [, action, runId] = (interaction.data?.custom_id ?? "").split(":");
  const store = new RunStore(env.DB);
  const row = runId ? await store.get(runId) : null;
  const userId = interactionUserId(interaction);
  if (!row || row.discord_user_id !== userId)
    return errorResponse("이 실행을 변경할 권한이 없어요.");
  if (action === "edit" && row.draft_json)
    return editModal(JSON.parse(row.draft_json) as ArchiveDraft);
  if (action === "cancel") {
    if (!(await store.cancel(runId!)))
      return errorResponse("이미 처리된 실행이에요.");
    return jsonResponse({
      type: InteractionResponseType.UPDATE_MESSAGE,
      data: {
        content: "취소했어요. archive에는 아무 변경도 만들지 않았어요.",
        components: [],
        allowed_mentions: { parse: [] },
      },
    });
  }
  if (action === "approve") {
    const discord = new DiscordClient(env);
    const defer = (promise: Promise<unknown>) => ctx.waitUntil(promise);
    ctx.waitUntil(
      approveDraft(env, runId!, userId, createArchiveWorkflowDependencies(env, runId!, defer))
        .then((result) =>
          discord.sendMessage(row.thread_id ?? row.channel_id, {
            content: `✅ Draft PR을 만들었어요.\n${result.prUrl}`,
            allowed_mentions: { parse: [] },
          }),
        )
        .catch((error) =>
          discord.sendMessage(row.thread_id ?? row.channel_id, {
            content: `PR을 만들지 못했어요: \`${String(error).slice(0, 150)}\``,
            allowed_mentions: { parse: [] },
          }),
        ),
    );
    return jsonResponse({ type: InteractionResponseType.DEFERRED_UPDATE });
  }
  return errorResponse("지원하지 않는 Hanni 동작이에요.");
}
