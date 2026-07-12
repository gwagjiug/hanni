import { CIRCUIT_BREAKER } from "./budget";
import type { TokenUsage } from "../types";

export interface CircuitLimits {
  maxSteps: number;
  maxLlmCalls: number;
  maxToolCalls: number;
  maxRepeatedCalls: number;
  maxExecutionSeconds: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxNoProgressSteps: number;
}

export class CircuitBreaker {
  private readonly startedAt = Date.now();
  private steps = 0;
  private llmCalls = 0;
  private toolCalls = 0;
  private noProgressSteps = 0;
  private readonly calls = new Map<string, number>();

  constructor(private readonly limits: CircuitLimits = CIRCUIT_BREAKER) {}

  step(progress = true): void {
    this.steps += 1;
    this.noProgressSteps = progress ? 0 : this.noProgressSteps + 1;
    this.assertTime();
    if (this.steps > this.limits.maxSteps) throw new Error("circuit_max_steps");
    if (this.noProgressSteps > this.limits.maxNoProgressSteps)
      throw new Error("circuit_no_progress");
  }

  tool(name: string, fingerprint = name): void {
    this.step();
    this.toolCalls += 1;
    const key = `${name}:${fingerprint}`;
    const repeated = (this.calls.get(key) ?? 0) + 1;
    this.calls.set(key, repeated);
    if (this.toolCalls > this.limits.maxToolCalls)
      throw new Error("circuit_max_tool_calls");
    if (repeated > this.limits.maxRepeatedCalls)
      throw new Error("circuit_repeated_tool_call");
  }

  llm(): void {
    this.step();
    this.llmCalls += 1;
    if (this.llmCalls > this.limits.maxLlmCalls)
      throw new Error("circuit_max_llm_calls");
  }

  usage(usage: TokenUsage): void {
    this.assertTime();
    if (usage.inputTokens > this.limits.maxInputTokens)
      throw new Error("circuit_max_input_tokens");
    if (usage.outputTokens > this.limits.maxOutputTokens)
      throw new Error("circuit_max_output_tokens");
  }

  assertTime(): void {
    if (Date.now() - this.startedAt > this.limits.maxExecutionSeconds * 1_000)
      throw new Error("circuit_execution_timeout");
  }
}
