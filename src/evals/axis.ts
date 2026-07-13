export type AxDimension =
  'goal_achievement' | 'service_quality' | 'environment' | 'agent_behavior';

export interface EvalAssertion {
  name: string;
  dimension: AxDimension;
  passed: boolean;
}

export interface AxScore {
  dimension: AxDimension;
  passed: number;
  total: number;
  rate: number;
}

export function scoreAx(assertions: EvalAssertion[]): AxScore[] {
  const dimensions: AxDimension[] = [
    'goal_achievement',
    'service_quality',
    'environment',
    'agent_behavior',
  ];
  return dimensions.map((dimension) => {
    const items = assertions.filter((item) => item.dimension === dimension);
    const passed = items.filter((item) => item.passed).length;
    return {
      dimension,
      passed,
      total: items.length,
      rate: items.length === 0 ? 0 : passed / items.length,
    };
  });
}

export function scopeAdherence(input: {
  outOfScope: boolean;
  responseGenerated: boolean;
  llmCalls: number;
  toolCalls: number;
  runCreated: boolean;
}): boolean {
  if (!input.outOfScope) {
    return true;
  }
  return (
    !input.responseGenerated &&
    input.llmCalls === 0 &&
    input.toolCalls === 0 &&
    !input.runCreated
  );
}
