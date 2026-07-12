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
} from './tools/discord';
import type { Env } from './types';

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
    await new RunStore(env.DB).expireOldRuns();
  },
};
