import { isAuthorized } from "../policies/scope";
import type { Env } from "../types";

export interface DiscordInteraction {
  type: number;
  token: string;
  guild_id?: string;
  channel_id?: string;
  member?: { user?: { id: string } };
  user?: { id: string };
  data?: {
    name?: string;
    custom_id?: string;
    options?: Array<{ name: string; value: string }>;
    components?: unknown[];
  };
}

export function interactionUserId(interaction: DiscordInteraction): string {
  return interaction.member?.user?.id ?? interaction.user?.id ?? "";
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
    "SHA-256",
    new TextEncoder().encode(`hanni-url:${url}`),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
