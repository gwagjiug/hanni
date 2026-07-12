import { z } from 'zod';
import type { ArchiveDraft, Env } from '../types';

const api = 'https://discord.com/api/v10';
const discordMessageSchema = z.object({
  id: z.string().min(1),
  channel_id: z.string().min(1),
});
const discordThreadSchema = z.object({ id: z.string().min(1) });

export const InteractionResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE: 4,
  DEFERRED_CHANNEL_MESSAGE: 5,
  DEFERRED_UPDATE: 6,
  UPDATE_MESSAGE: 7,
  MODAL: 9,
} as const;

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function errorResponse(content: string): Response {
  return jsonResponse({
    type: InteractionResponseType.CHANNEL_MESSAGE,
    data: { content, flags: 64, allowed_mentions: { parse: [] } },
  });
}

export function pinsModal(runId: string, url: string): Response {
  return jsonResponse({
    type: InteractionResponseType.MODAL,
    data: {
      custom_id: `hanni:create:${runId}`,
      title: 'Hanni에 Pin 보관하기',
      components: [
        modalRow('url', 'URL', 1, url, 2000),
        modalRow('pins', 'Pins (빈 줄로 구분)', 2, '', 4000),
        modalRow('note', 'PR 참고 메모 (선택)', 2, '', 1000, false),
      ],
    },
  });
}

export function editModal(draft: ArchiveDraft): Response {
  const pins = draft.pins.join('\n\n');
  if (pins.length > 4000) {
    return errorResponse(
      'Pin 전체가 Discord 수정창의 4,000자 제한을 넘어 수정할 수 없어요.',
    );
  }
  const prCopy = `${draft.prTitle}\n\n${draft.prBody}`;
  return jsonResponse({
    type: InteractionResponseType.MODAL,
    data: {
      custom_id: `hanni:edit-submit:${draft.runId}`,
      title: 'Hanni 변경안 수정',
      components: [
        modalRow('title', '제목', 1, draft.title, 300),
        modalRow('category', '카테고리', 1, draft.category.name, 100),
        modalRow('slug', 'Slug', 1, draft.slug, 100),
        modalRow('pins', 'Pins', 2, pins, 4000),
        modalRow(
          'pr_copy',
          'PR 제목 + 빈 줄 + 본문',
          2,
          prCopy.slice(0, 4000),
          4000,
        ),
      ],
    },
  });
}

function modalRow(
  customId: string,
  label: string,
  style: 1 | 2,
  value: string,
  maxLength: number,
  required = true,
): Record<string, unknown> {
  return {
    type: 1,
    components: [
      {
        type: 4,
        custom_id: customId,
        label,
        style,
        ...(value ? { value } : {}),
        required,
        max_length: maxLength,
      },
    ],
  };
}

function clip(value: string, max = 950): string {
  return value.length <= max ? value : `${value.slice(0, max - 20)}\n…(생략)`;
}

export function previewPayload(draft: ArchiveDraft): Record<string, unknown> {
  return {
    content: `📌 **${draft.title}**\n카테고리: **${draft.category.name}** (${draft.category.mode})\n파일: \`${draft.pinPath}\`\n모델: \`${draft.model}\` · LLM 1회 · ${draft.usage.inputTokens} in / ${draft.usage.outputTokens} out · 예상 $${draft.estimatedCostUsd.toFixed(6)}`,
    embeds: [
      {
        title: 'README 변경',
        description: `\`\`\`diff\n${clip(draft.readmeAfter)}\n\`\`\``,
      },
      {
        title: 'Pin 파일',
        description: `\`\`\`md\n${clip(draft.pinContent)}\n\`\`\``,
      },
      {
        title: 'PR',
        description: `**${draft.prTitle}**\n${clip(draft.prBody)}`,
      },
    ],
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 2,
            custom_id: `hanni:edit:${draft.runId}`,
            label: '수정',
          },
          {
            type: 2,
            style: 3,
            custom_id: `hanni:approve:${draft.runId}`,
            label: '승인',
          },
          {
            type: 2,
            style: 4,
            custom_id: `hanni:cancel:${draft.runId}`,
            label: '취소',
          },
        ],
      },
    ],
    allowed_mentions: { parse: [] },
  };
}

export class DiscordClient {
  constructor(
    private readonly env: Env,
    private readonly fetcher: typeof fetch = (input, init) =>
      fetch(input, init),
  ) {}

  private headers(): Record<string, string> {
    return {
      authorization: `Bot ${this.env.DISCORD_BOT_TOKEN}`,
      'content-type': 'application/json',
    };
  }

  async editOriginal(
    token: string,
    payload: unknown,
  ): Promise<{ id: string; channel_id: string }> {
    const response = await this.fetcher(
      `${api}/webhooks/${this.env.DISCORD_APPLICATION_ID}/${token}/messages/@original`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      },
    );
    if (!response.ok) {
      throw new Error(`discord_edit_original_${response.status}`);
    }
    return discordMessageSchema.parse(await response.json());
  }

  async createThread(
    channelId: string,
    messageId: string,
    name: string,
  ): Promise<{ id: string }> {
    const response = await this.fetcher(
      `${api}/channels/${channelId}/messages/${messageId}/threads`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          name: name.slice(0, 100),
          auto_archive_duration: 1440,
        }),
      },
    );
    if (!response.ok) {
      throw new Error(`discord_create_thread_${response.status}`);
    }
    return discordThreadSchema.parse(await response.json());
  }

  async sendMessage(channelId: string, payload: unknown): Promise<void> {
    const response = await this.fetcher(
      `${api}/channels/${channelId}/messages`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(payload),
      },
    );
    if (!response.ok) {
      throw new Error(`discord_send_message_${response.status}`);
    }
  }
}

export function componentValue(data: unknown, id: string): string {
  if (!data || typeof data !== 'object') {
    return '';
  }
  if ('custom_id' in data && data.custom_id === id && 'value' in data) {
    return typeof data.value === 'string' ? data.value : '';
  }
  if ('component' in data) {
    const value = componentValue(data.component, id);
    if (value) {
      return value;
    }
  }
  const components =
    'components' in data && Array.isArray(data.components)
      ? data.components
      : [];
  for (const child of components) {
    const value = componentValue(child, id);
    if (value) {
      return value;
    }
  }
  return '';
}
