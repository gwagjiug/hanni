import { describe, expect, it } from 'vitest';
import { parseDiscordInteraction } from '../../src/discord/interaction';

describe('Discord interaction parser', () => {
  it('narrows a valid command payload', () => {
    const interaction = parseDiscordInteraction(
      JSON.stringify({
        type: 2,
        token: 'token',
        guild_id: 'guild',
        channel_id: 'channel',
        member: { user: { id: 'owner' } },
        data: {
          name: 'hanni',
          options: [{ name: 'url', value: 'https://example.com' }],
        },
      }),
    );

    expect(interaction.type).toBe(2);
    if (interaction.type !== 2) {
      throw new Error('Expected a command interaction');
    }
    expect(interaction.data.name).toBe('hanni');
  });

  it('rejects malformed JSON, unknown types and missing command data', () => {
    expect(() => parseDiscordInteraction('{')).toThrow();
    expect(() =>
      parseDiscordInteraction(JSON.stringify({ type: 99, token: 'token' })),
    ).toThrow();
    expect(() =>
      parseDiscordInteraction(JSON.stringify({ type: 2, token: 'token' })),
    ).toThrow();
  });
});
