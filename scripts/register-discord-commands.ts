export {};

const required = [
  'DISCORD_APPLICATION_ID',
  'DISCORD_BOT_TOKEN',
  'DISCORD_GUILD_ID',
] as const;
for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`${key} is required`);
  }
}

const commands = [
  {
    name: 'hanni',
    description: 'URL과 Pin을 archive Draft PR로 준비합니다',
    options: [
      {
        name: 'url',
        description: '보관할 공개 http/https URL',
        type: 3,
        required: true,
      },
      {
        name: 'pin',
        description: '첫 번째로 보관할 문장',
        type: 3,
        required: true,
        max_length: 2000,
      },
      ...Array.from({ length: 9 }, (_, index) => ({
        name: `pin-${index + 2}`,
        description: `${index + 2}번째로 보관할 문장 (선택)`,
        type: 3,
        required: false,
        max_length: 2000,
      })),
    ],
  },
  {
    name: 'hanni-cost',
    description: '이번 달 Hanni 토큰과 예상 비용을 확인합니다',
  },
  { name: 'hanni-status', description: '내 최근 Hanni 실행 상태를 확인합니다' },
];

const response = await fetch(
  `https://discord.com/api/v10/applications/${process.env.DISCORD_APPLICATION_ID}/guilds/${process.env.DISCORD_GUILD_ID}/commands`,
  {
    method: 'PUT',
    headers: {
      authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(commands),
  },
);
if (!response.ok) {
  throw new Error(
    `Discord command registration failed: ${response.status} ${await response.text()}`,
  );
}
process.stdout.write(`${JSON.stringify(await response.json(), null, 2)}\n`);
