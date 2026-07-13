import { describe, expect, it } from 'vitest';
import {
  CircuitBreaker,
  type CircuitLimits,
} from '../../src/agent/circuit-breaker';

const limits: CircuitLimits = {
  maxSteps: 3,
  maxLlmCalls: 1,
  maxToolCalls: 2,
  maxRepeatedCalls: 1,
  maxExecutionSeconds: 30,
  maxInputTokens: 10,
  maxOutputTokens: 5,
  maxNoProgressSteps: 1,
};

describe('CircuitBreaker', () => {
  it('blocks a repeated tool call with the same arguments', () => {
    const circuit = new CircuitBreaker(limits);
    circuit.tool('github.read', 'same');
    expect(() => circuit.tool('github.read', 'same')).toThrow(
      'circuit_repeated_tool_call',
    );
  });

  it('enforces token limits reported by the model', () => {
    const circuit = new CircuitBreaker(limits);
    expect(() =>
      circuit.usage({ inputTokens: 11, cachedInputTokens: 0, outputTokens: 1 }),
    ).toThrow('circuit_max_input_tokens');
  });
});
