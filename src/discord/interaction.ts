import { z } from 'zod';
import { isAuthorized } from '../policies/scope';
import type { Env } from '../types';

const userSchema = z.object({ id: z.string().min(1) });
const baseInteractionSchema = z.object({
  token: z.string(),
  guild_id: z.string().optional(),
  channel_id: z.string().optional(),
  member: z.object({ user: userSchema.optional() }).optional(),
  user: userSchema.optional(),
});

const optionSchema = z.object({ name: z.string(), value: z.string() });
const commandInteractionSchema = baseInteractionSchema.extend({
  type: z.literal(2),
  data: z.object({
    name: z.string(),
    options: z.array(optionSchema).optional(),
  }),
});
const componentInteractionSchema = baseInteractionSchema.extend({
  type: z.literal(3),
  data: z.object({ custom_id: z.string().min(1) }),
});
const modalInteractionSchema = baseInteractionSchema.extend({
  type: z.literal(5),
  data: z.object({
    custom_id: z.string().min(1),
    components: z.array(z.unknown()).optional(),
  }),
});

export const discordInteractionSchema = z.discriminatedUnion('type', [
  baseInteractionSchema.extend({ type: z.literal(1) }),
  commandInteractionSchema,
  componentInteractionSchema,
  modalInteractionSchema,
]);

export type DiscordInteraction = z.infer<typeof discordInteractionSchema>;
export type DiscordCommandInteraction = z.infer<
  typeof commandInteractionSchema
>;
export type DiscordComponentInteraction = z.infer<
  typeof componentInteractionSchema
>;
export type DiscordModalInteraction = z.infer<typeof modalInteractionSchema>;

export function parseDiscordInteraction(body: string): DiscordInteraction {
  return discordInteractionSchema.parse(JSON.parse(body));
}

export function interactionUserId(interaction: DiscordInteraction): string {
  return interaction.member?.user?.id ?? interaction.user?.id ?? '';
}

export function isInteractionAuthorized(
  interaction: DiscordInteraction,
  env: Env,
): boolean {
  return isAuthorized(
    {
      guildId: interaction.guild_id,
      channelId: interaction.channel_id,
      userId: interactionUserId(interaction),
    },
    {
      guildId: env.DISCORD_GUILD_ID,
      channelId: env.DISCORD_CHANNEL_ID,
      userId: env.DISCORD_OWNER_USER_ID,
    },
  );
}

export async function normalizedUrlHash(url: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`hanni-url:${url}`),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
