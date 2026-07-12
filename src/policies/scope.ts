import { z } from "zod";

const publicUrlSchema = z
  .string()
  .url()
  .transform((value) => new URL(value))
  .refine(
    (url) => url.protocol === "https:" || url.protocol === "http:",
    "http 또는 https URL이어야 합니다.",
  )
  .refine(
    (url) => isAllowedHostname(url.hostname),
    "공개 웹 URL만 사용할 수 있습니다.",
  );

const blockedHostnames = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
]);

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  )
    return false;
  const [a = 0, b = 0] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

export function isAllowedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  if (
    blockedHostnames.has(normalized) ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal")
  )
    return false;
  if (
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:")
  )
    return false;
  return !isPrivateIpv4(normalized);
}

export function normalizePublicUrl(input: string): string {
  const url = publicUrlSchema.parse(input.trim());
  url.hash = "";
  const removable = [
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "fbclid",
    "gclid",
  ];
  for (const key of removable) url.searchParams.delete(key);
  url.hostname = url.hostname.toLowerCase();
  if (
    (url.protocol === "https:" && url.port === "443") ||
    (url.protocol === "http:" && url.port === "80")
  )
    url.port = "";
  return url.toString();
}

export const OUT_OF_SCOPE_MESSAGE =
  "Hanni는 URL과 Pin을 archive에 추가하는 요청만 처리할 수 있어요. 유효한 http 또는 https URL을 입력해주세요.";

export interface ScopeContext {
  guildId: string | undefined;
  channelId: string | undefined;
  userId: string;
}

export function isAuthorized(
  context: ScopeContext,
  expected: { guildId: string; channelId: string; userId: string },
): boolean {
  return (
    context.guildId === expected.guildId &&
    context.channelId === expected.channelId &&
    context.userId === expected.userId
  );
}
