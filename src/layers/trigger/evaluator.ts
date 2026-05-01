import type { TriggerCondition } from '../../types/index.js';

export interface TriggerEvaluationInput {
  condition: TriggerCondition;
  currentPrice: string;
}

export interface TriggerEvaluationResult {
  triggered: boolean;
  reason: string;
}

export function evaluateTrigger(input: TriggerEvaluationInput): TriggerEvaluationResult {
  if (!input.condition.enabled) {
    return {
      triggered: false,
      reason: `Condition ${input.condition.id} is disabled.`,
    };
  }

  const current = Number(input.currentPrice);
  const target = Number(input.condition.targetPrice);

  if (!Number.isFinite(current) || !Number.isFinite(target)) {
    return {
      triggered: false,
      reason: 'Invalid numeric price for trigger evaluation.',
    };
  }

  if (input.condition.direction === 'above') {
    return {
      triggered: current >= target,
      reason: `Current price ${current} ${current >= target ? '>=' : '<'} target ${target}.`,
    };
  }

  return {
    triggered: current <= target,
    reason: `Current price ${current} ${current <= target ? '<=' : '>'} target ${target}.`,
  };
}
