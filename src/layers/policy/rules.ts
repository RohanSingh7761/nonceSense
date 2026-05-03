import type { PolicyConstraints, UserMode } from '../../types/index.js';

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
  requiresConfirmation: boolean;
}

export interface ExecutionPolicyInput {
  mode: UserMode;
  policy: PolicyConstraints;
  tokenInSymbol: string;
  amountUsd?: number;
  explicitConfirmation?: boolean;
}

export function evaluateExecutionPolicy(input: ExecutionPolicyInput): PolicyDecision {
  const token = input.tokenInSymbol.toUpperCase();
  const blocked = input.policy.blockedTokens.map((item) => item.toUpperCase());
  if (blocked.includes(token)) {
    return {
      allowed: false,
      reason: `Token ${token} is blocked by policy.`,
      requiresConfirmation: false,
    };
  }

  if (input.mode === 'recommendation-only') {
    return {
      allowed: false,
      reason: 'Execution disabled in recommendation-only mode.',
      requiresConfirmation: false,
    };
  }

  const usdAmount = input.amountUsd;
  const overSingleLimit =
    typeof usdAmount === 'number' && usdAmount > input.policy.maxSingleSwapUsd;

  if (overSingleLimit) {
    return {
      allowed: false,
      reason: `Swap amount exceeds maxSingleSwapUsd (${input.policy.maxSingleSwapUsd}).`,
      requiresConfirmation: false,
    };
  }

  const requiresConfirmationByMode = input.mode === 'assisted-execution';
  const requiresConfirmationByAmount =
    typeof usdAmount === 'number' &&
    usdAmount > input.policy.requireUserConfirmationAboveUsd;
  const requiresConfirmation = requiresConfirmationByMode || requiresConfirmationByAmount;

  if (requiresConfirmation && !input.explicitConfirmation) {
    return {
      allowed: false,
      reason:
        'Execution requires explicit confirmation. Re-run with --confirm true in assisted mode or for high amount.',
      requiresConfirmation: true,
    };
  }

  return {
    allowed: true,
    reason: 'Execution allowed by policy.',
    requiresConfirmation,
  };
}
