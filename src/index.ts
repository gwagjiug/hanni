import { verifyKey } from 'discord-interactions';
import { handleCommand } from './discord/handlers/command';
import { handleComponent } from './discord/handlers/component';
import { handleModal } from './discord/handlers/modal';
import { parseDiscordInteraction } from './discord/interaction';
import { RunStore } from './storage/runs';
import {
  errorResponse,
  InteractionResponseType,
  jsonResponse,
  DiscordClient,
} from './tools/discord';
import type { Env } from './types';

export { ArchiveAnalysisWorkflow } from './workflows/archive-analysis';

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Not found', { status: 404 });
    }
    const signature = request.headers.get('x-signature-ed25519') ?? '';
    const timestamp = request.headers.get('x-signature-timestamp') ?? '';
    const body = await request.text();
    if (
      !(await verifyKey(body, signature, timestamp, env.DISCORD_PUBLIC_KEY))
    ) {
      return new Response('Bad request signature', { status: 401 });
    }
    let interaction;
    try {
      interaction = parseDiscordInteraction(body);
    } catch {
      return new Response('Invalid interaction payload', { status: 400 });
    }
    if (interaction.type === 1) {
      return jsonResponse({ type: InteractionResponseType.PONG });
    }
    if (interaction.type === 2) {
      return handleCommand(interaction, env, ctx);
    }
    if (interaction.type === 3) {
      return handleComponent(interaction, env, ctx);
    }
    if (interaction.type === 5) {
      return handleModal(interaction, env, ctx);
    }
    return errorResponse('Hanni가 지원하지 않는 interaction이에요.');
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    const store = new RunStore(env.DB);
    await store.expireOldRuns();
    const stale = await store.failStaleRuns(
      new Date(Date.now() - 5 * 60 * 1_000),
    );
    for (const row of stale) {
      await new DiscordClient(env)
        .sendMessage(row.channel_id, {
          content:
            `Hanni 실행 \`${row.id}\`이(가) ${row.current_step ?? '분석'} 단계에서 ` +
            '더 진행되지 않아 종료했어요. `/hanni-status`에서 확인해주세요.',
          allowed_mentions: { parse: [] },
        })
        .catch(() => undefined);
    }
  },
};
