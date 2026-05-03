export type UserMode = 'recommendation-only' | 'assisted-execution' | 'limited-auto-execution';

export interface TokenRef {
  chainId: number;
  symbol: string;
  address: string;
  decimals: number;
}

export interface WalletConfig {
  address: string;
  rpcUrl: string;
  chainId: number;
}

export interface PolicyConstraints {
  maxSingleSwapUsd: number;
  maxDailySwapUsd: number;
  blockedTokens: string[];
  allowedProtocols: string[];
  requireUserConfirmationAboveUsd: number;
  /** Max ETH that can be spent in a single transfer without OS-level approval. 0 = always require approval. */
  maxAutoApproveEth: number;
}

export interface UserProfile {
  id: string;
  label: string;
  mode: UserMode;
  wallet: WalletConfig;
  policy: PolicyConstraints;
}

export interface QuoteRequest {
  tokenIn: TokenRef;
  tokenOut: TokenRef;
  amountIn: string;
  slippageBps: number;
}

export interface Recommendation {
  id: string;
  createdAt: string;
  request: QuoteRequest;
  rationale: string;
  estimatedAmountOut: string;
  routeLabel: string;
  validUntil: string;
}

export interface ExecutionRequest {
  recommendationId: string;
  requestedAt: string;
  modeAtRequest: UserMode;
}

export interface ExecutionResult {
  transactionHash: string;
  status: 'submitted' | 'confirmed' | 'failed';
  chainId: number;
  submittedAt: string;
  errorMessage?: string;
}

export interface TriggerCondition {
  id: string;
  label: string;
  enabled: boolean;
  tokenInSymbol: string;
  tokenOutSymbol: string;
  targetPrice: string;
  direction: 'above' | 'below';
}

export interface HabitLogEntry {
  id: string;
  createdAt: string;
  event: 'recommendation-generated' | 'execution-requested' | 'execution-submitted' | 'execution-failed';
  note: string;
  metadata?: Record<string, string>;
}

export interface AppConfig {
  activeUserId: string;
  users: UserProfile[];
  triggers: TriggerCondition[];
  /** News monitor poll interval in milliseconds. Defaults to 5 minutes. */
  newsIntervalMs?: number;
}
