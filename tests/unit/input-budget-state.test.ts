import { describe, expect, it } from 'vitest';
import { estimateCost } from '../../src/agent/budget';
import { canTransition } from '../../src/agent/state';
import { parsePins, validatePins } from '../../src/skills/archive-url/input';

describe('input, budget and state', () => {
  it('splits multiple pins on blank lines', () => {
    expect(parsePins('pin one\n\npin two\ncontinued')).toEqual([
      'pin one',
      'pin two\ncontinued',
    ]);
  });

  it('rejects missing and excessive pins', () => {
    expect(() => parsePins('   ')).toThrow();
    expect(() =>
      parsePins(Array.from({ length: 11 }, (_, i) => `pin ${i}`).join('\n\n')),
    ).toThrow();
  });

  it('revalidates combined slash-command pin limits', () => {
    expect(() => validatePins(Array.from({ length: 11 }, () => 'pin'))).toThrow(
      'Pin은 최대 10개',
    );
    expect(() =>
      validatePins(Array.from({ length: 5 }, () => 'a'.repeat(2_000))),
    ).toThrow('Pin 전체 길이는 8000자');
  });

  it('calculates model cost from actual usage buckets', () => {
    expect(
      estimateCost({
        inputTokens: 1_000_000,
        cachedInputTokens: 1_000_000,
        outputTokens: 1_000_000,
      }),
    ).toBe(2.275);
  });

  it('does not allow success or writes before approval', () => {
    expect(canTransition('ANALYZING', 'CREATING_PR')).toBe(false);
    expect(canTransition('AWAITING_APPROVAL', 'CREATING_PR')).toBe(true);
    expect(canTransition('CREATING_PR', 'COMPLETED')).toBe(true);
    expect(canTransition('COMPLETED', 'CREATING_PR')).toBe(false);
  });
});
