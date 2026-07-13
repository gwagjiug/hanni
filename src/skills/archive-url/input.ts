import { z } from 'zod';

export const MAX_PINS = 10;
export const MAX_PIN_CHARS = 2_000;
export const MAX_TOTAL_PIN_CHARS = 8_000;

export function parsePins(input: string): string[] {
  const raw = input.replace(/\r\n/g, '\n').trim();
  if (!raw) {
    throw new Error('Pin을 한 개 이상 입력해주세요.');
  }
  if (raw.length > MAX_TOTAL_PIN_CHARS) {
    throw new Error(
      `Pin 전체 길이는 ${MAX_TOTAL_PIN_CHARS}자 이하여야 합니다.`,
    );
  }
  const pins = raw
    .split(/\n[ \t]*\n+/)
    .map((pin) => pin.trim())
    .filter(Boolean);
  return validatePins(pins);
}

export function validatePins(pins: string[]): string[] {
  if (pins.length === 0) {
    throw new Error('Pin을 한 개 이상 입력해주세요.');
  }
  if (pins.length > MAX_PINS) {
    throw new Error(`Pin은 최대 ${MAX_PINS}개까지 입력할 수 있습니다.`);
  }
  if (pins.some((pin) => pin.length > MAX_PIN_CHARS)) {
    throw new Error(`각 Pin은 ${MAX_PIN_CHARS}자 이하여야 합니다.`);
  }
  if (
    pins.reduce((total, pin) => total + pin.length, 0) > MAX_TOTAL_PIN_CHARS
  ) {
    throw new Error(
      `Pin 전체 길이는 ${MAX_TOTAL_PIN_CHARS}자 이하여야 합니다.`,
    );
  }
  return pins;
}

export const editableDraftSchema = z.object({
  title: z.string().trim().min(1).max(300),
  category: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .refine((v) => !v.includes('\n')),
  slug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(100),
  pins: z.array(z.string().min(1).max(MAX_PIN_CHARS)).min(1).max(MAX_PINS),
  prTitle: z.string().trim().min(1).max(256),
  prBody: z.string().trim().min(1).max(10_000),
});
