import { describe, expect, it } from 'vitest';
import { scopeAdherence, scoreAx } from '../../src/evals/axis';

describe('Netlify AX evaluation', () => {
  it('scores all four AX dimensions independently', () => {
    expect(
      scoreAx([
        { name: 'draft PR', dimension: 'goal_achievement', passed: true },
        { name: 'latency', dimension: 'service_quality', passed: true },
        { name: 'schema', dimension: 'environment', passed: false },
        { name: 'scope', dimension: 'agent_behavior', passed: true },
      ]),
    ).toEqual([
      { dimension: 'goal_achievement', passed: 1, total: 1, rate: 1 },
      { dimension: 'service_quality', passed: 1, total: 1, rate: 1 },
      { dimension: 'environment', passed: 0, total: 1, rate: 0 },
      { dimension: 'agent_behavior', passed: 1, total: 1, rate: 1 },
    ]);
  });

  it('treats answering an unrelated message as agent failure', () => {
    expect(
      scopeAdherence({
        outOfScope: true,
        responseGenerated: false,
        llmCalls: 0,
        toolCalls: 0,
        runCreated: false,
      }),
    ).toBe(true);
    expect(
      scopeAdherence({
        outOfScope: true,
        responseGenerated: true,
        llmCalls: 1,
        toolCalls: 0,
        runCreated: true,
      }),
    ).toBe(false);
  });
});
