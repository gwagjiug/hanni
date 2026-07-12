import { normalizePublicUrl, OUT_OF_SCOPE_MESSAGE } from '../../policies/scope';
import { RunStore } from '../../storage/runs';
import { parsePins, validatePins } from '../../skills/archive-url/input';
import {
  errorResponse,
  InteractionResponseType,
  jsonResponse,
} from '../../tools/discord';
import type { Env } from '../../types';
import {
  interactionUserId,
  isInteractionAuthorized,
  type DiscordCommandInteraction,
} from '../interaction';
import { createAndAnalyze } from '../start-run';

export async function handleCommand(
  interaction: DiscordCommandInteraction,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (!isInteractionAuthorized(interaction, env)) {
    return errorResponse('이 서버·채널·사용자에게는 Hanni 실행 권한이 없어요.');
  }
  const store = new RunStore(env.DB);
  const userId = interactionUserId(interaction);
  if (interaction.data?.name === 'hanni-cost') {
    const summary = await store.costSummary(userId);
    return errorResponse(
      `이번 달 Hanni 사용량\n실행 ${summary.run_count ?? 0}회 · 완료 ${summary.completed_count ?? 0}회 · 실패 ${summary.failed_count ?? 0}회\n` +
        `입력 ${summary.input_tokens ?? 0} tokens · 출력 ${summary.output_tokens ?? 0} tokens\n` +
        `예상 비용 $${Number(summary.estimated_cost_usd ?? 0).toFixed(6)} · 최대 $${Number(summary.max_cost_usd ?? 0).toFixed(6)}`,
    );
  }
  if (interaction.data?.name === 'hanni-status') {
    const latest = await store.latestForUser(userId);
    return errorResponse(
      latest
        ? `최근 실행 \`${latest.id}\`: **${latest.status}**${latest.github_pr_url ? `\n${latest.github_pr_url}` : ''}`
        : '아직 Hanni 실행 기록이 없어요.',
    );
  }
  if (interaction.data?.name !== 'hanni') {
    return errorResponse('Hanni가 지원하지 않는 명령이에요.');
  }
  const rawUrl =
    interaction.data.options?.find((option) => option.name === 'url')?.value ??
    '';
  let url: string;
  try {
    url = normalizePublicUrl(rawUrl);
  } catch {
    return errorResponse(OUT_OF_SCOPE_MESSAGE);
  }
  let pins: string[];
  try {
    const options = interaction.data.options ?? [];
    const pinNames = [
      'pin',
      ...Array.from({ length: 9 }, (_, index) => `pin-${index + 2}`),
    ];
    pins = validatePins(
      pinNames.flatMap((name) => {
        const value =
          options.find((option) => option.name === name)?.value ?? '';
        return value ? parsePins(value) : [];
      }),
    );
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : 'Pin 입력이 올바르지 않아요.',
    );
  }
  const runId = crypto.randomUUID();
  const defer = (promise: Promise<unknown>) => ctx.waitUntil(promise);
  ctx.waitUntil(
    createAndAnalyze(env, interaction, runId, url, pins, '', defer),
  );
  return jsonResponse({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE,
    data: { allowed_mentions: { parse: [] } },
  });
}
