import { RunStore } from '../storage/runs';
import { DiscordClient } from '../tools/discord';
import type { Env } from '../types';
import {
  interactionUserId,
  normalizedUrlHash,
  type DiscordInteraction,
} from './interaction';

export async function createAndAnalyze(
  env: Env,
  interaction: DiscordInteraction,
  runId: string,
  url: string,
  pins: string[],
  note: string,
): Promise<void> {
  const store = new RunStore(env.DB);
  try {
    await store.create({
      id: runId,
      userId: interactionUserId(interaction),
      guildId: interaction.guild_id ?? '',
      channelId: interaction.channel_id ?? '',
      interactionToken: interaction.token,
      sourceUrl: url,
      urlHash: await normalizedUrlHash(url),
      workflowInput: { pins, ...(note ? { note } : {}) },
      ttlHours: Number(env.APPROVAL_TTL_HOURS),
    });
  } catch (error) {
    const message = String(error).includes('UNIQUE')
      ? '이 URL은 이미 처리 중이에요. `/hanni-status`에서 현재 상태를 확인해주세요.'
      : '실행을 시작하지 못했어요. 잠시 후 다시 시도해주세요.';
    await new DiscordClient(env)
      .editOriginal(interaction.token, {
        content: message,
        allowed_mentions: { parse: [] },
      })
      .catch(() => undefined);
    return;
  }
  try {
    const instance = await env.ARCHIVE_WORKFLOW.create({
      id: runId,
      params: { runId },
      retention: { successRetention: '7 days', errorRetention: '7 days' },
    });
    await store.setWorkflowInstance(runId, instance.id);
  } catch (error) {
    const category = 'workflow_start_failed';
    await new DiscordClient(env)
      .editOriginal(interaction.token, {
        content: '분석 작업을 시작하지 못했어요. 잠시 후 다시 시도해주세요.',
        allowed_mentions: { parse: [] },
      })
      .catch(() => undefined);
    await store.fail(runId, 'RECEIVED', 'FAILED_EXTERNAL', category);
    console.error({
      event: 'hanni.workflow.start_failed',
      runId,
      errorCategory: category,
      cause: error instanceof Error ? error.name : 'unknown',
    });
  }
}
