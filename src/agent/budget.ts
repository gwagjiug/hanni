import type { TokenUsage } from '../types';

export interface ModelPrice {
  inputPerMillion: number;
  cachedInputPerMillion: number;
  outputPerMillion: number;
}

export const DEFAULT_MODEL_PRICE: ModelPrice = {
  inputPerMillion: 0.25,
  cachedInputPerMillion: 0.025,
  outputPerMillion: 2,
};

export function estimateCost(
  usage: TokenUsage,
  price: ModelPrice = DEFAULT_MODEL_PRICE,
): number {
  return (
    (usage.inputTokens * price.inputPerMillion +
      usage.cachedInputTokens * price.cachedInputPerMillion +
      usage.outputTokens * price.outputPerMillion) /
    1_000_000
  );
}

export const CIRCUIT_BREAKER = {
  maxSteps: 10,
  maxLlmCalls: 2,
  maxToolCalls: 8,
  maxRepeatedCalls: 1,
  maxExecutionSeconds: 30,
  maxInputTokens: 12_000,
  maxOutputTokens: 1_200,
  maxNoProgressSteps: 1,
} as const;
