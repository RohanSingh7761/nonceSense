import 'dotenv/config';

import { GoogleGenAI } from '@google/genai';
import { ethers } from 'ethers';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import {
  ensureActiveUserWallet,
  getActiveUserPrivateKey,
  getConfigPath,
  loadConfig,
  setActiveUserMode,
  setActiveUserWallet,
} from './config/store.js';
import {
  getNativeBalance,
  getWalletPortfolio,
  quoteExactInputSingle,
  swapExactInputSingle,
  transferErc20,
  transferNative,
} from './layers/execution/index.js';
import {
  addRecommendation,
  getRecentActionHistory,
  getRecentUserMessages,
  getLogsPath,
  getMemoryPath,
  getRecommendationById,
  listRecentRecommendations,
  logActionEvent,
  logChatMessage,
  logErrorEvent,
  logExecutionFailed,
  logExecutionRequested,
  logExecutionSubmitted,
  logSystemEvent,
} from './layers/memory/index.js';
import { evaluateExecutionPolicy } from './layers/policy/index.js';
import { evaluateTrigger } from './layers/trigger/index.js';
import type { Recommendation, UserMode } from './types/index.js';

type CommandName =
  | 'help'
  | 'setup'
  | 'recommend'
  | 'execute'
  | 'mode'
  | 'wallet-balance'
  | 'wallet-transfer'
  | 'swap-quote'
  | 'swap-execute'
  | 'recent-recommendations'
  | 'trigger-eval'
  | 'workflow-smoke'
  | 'version';

interface ActionPlan {
  action: CommandName | 'none';
  flags: Record<string, string>;
  reply: string;
}

interface ActionStep {
  action: CommandName;
  flags: Record<string, string>;
  minNativeBalanceEth?: string;
  useCurrentNativeBalanceAsAmount?: boolean;
}

interface ChatContextTurn {
  role: 'user' | 'assistant';
  message: string;
}

interface PendingSwapConfirmation {
  flags: Record<string, string>;
}

interface TokenMetadata {
  symbol: string;
  address: string;
  decimals: number;
}

interface TokenListEntry {
  chainId: number;
  address: string;
  symbol: string;
  decimals: number;
}

const UNISWAP_TOKEN_LIST_URL = 'https://tokens.uniswap.org';
const TOKEN_LIST_TTL_MS = 10 * 60 * 1000;
let tokenListCache:
  | {
      fetchedAt: number;
      tokens: TokenListEntry[];
    }
  | undefined;

const MAX_CONTEXT_TURNS = 12;
const UI = {
  reset: '\x1b[0m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
};

function isAffirmative(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return /^(yes|y|confirm|confirmed|proceed|go ahead|do it|execute)\b/.test(normalized);
}

function isNegative(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return /^(no|n|cancel|stop|don'?t|do not)\b/.test(normalized);
}

function getNetworkLabel(chainId: number): string {
  if (chainId === 11155111) return 'Sepolia';
  if (chainId === 1) return 'Ethereum Mainnet';
  return `Chain ${chainId}`;
}

function detectChainIdFromText(message: string): number | undefined {
  const lower = message.toLowerCase();
  const hasMainnet =
    /\bmainnet\b/.test(lower) || /\bethereum\b/.test(lower) || /\beth mainnet\b/.test(lower);
  const hasSepolia = /\bsepolia\b/.test(lower);
  if (hasMainnet && hasSepolia) {
    return undefined;
  }
  if (hasMainnet) {
    return 1;
  }
  if (hasSepolia) {
    return 11155111;
  }
  return undefined;
}

function getRpcUrlForChainId(chainId: number): string {
  if (chainId === 1) {
    return process.env.ALCHEMY_MAINNET_ENDPOINT ?? '';
  }
  if (chainId === 11155111) {
    return process.env.ALCHEMY_SEPOLIA_ENDPOINT ?? '';
  }
  return '';
}

function getNetworkPromptText(): string {
  return 'Which network should I use for this action: Sepolia or Ethereum Mainnet?';
}

function getRpcHost(rpcUrl: string): string {
  try {
    return new URL(rpcUrl).host;
  } catch {
    return 'unknown';
  }
}

function getTokenDirectory(chainId: number): Record<string, TokenMetadata> {
  if (chainId === 11155111) {
    return {
      ETH: { symbol: 'WETH', address: '0xfff9976782d46cc05630d1f6ebab18b2324d6b14', decimals: 18 },
      WETH: { symbol: 'WETH', address: '0xfff9976782d46cc05630d1f6ebab18b2324d6b14', decimals: 18 },
      USDC: { symbol: 'USDC', address: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238', decimals: 6 },
      DAI: { symbol: 'DAI', address: '0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357', decimals: 18 },
      USDT: { symbol: 'USDT', address: '0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0', decimals: 6 },
    };
  }

  if (chainId === 1) {
    return {
      ETH: { symbol: 'WETH', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18 },
      WETH: { symbol: 'WETH', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18 },
      USDC: { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
    };
  }

  return {};
}

async function loadTokenList(): Promise<TokenListEntry[]> {
  if (tokenListCache && Date.now() - tokenListCache.fetchedAt < TOKEN_LIST_TTL_MS) {
    return tokenListCache.tokens;
  }

  const response = await fetch(UNISWAP_TOKEN_LIST_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch Uniswap token list: ${response.status}`);
  }

  const parsed = (await response.json()) as { tokens?: TokenListEntry[] };
  const tokens = parsed.tokens ?? [];
  tokenListCache = {
    fetchedAt: Date.now(),
    tokens,
  };
  return tokens;
}

async function resolveToken(chainId: number, tokenInput: string, decimalsOverride?: string): Promise<TokenMetadata> {
  if (tokenInput.startsWith('0x')) {
    return {
      symbol: 'TOKEN',
      address: tokenInput,
      decimals: decimalsOverride ? parsePositiveInteger(decimalsOverride, 'token decimals') : 18,
    };
  }

  const normalized = tokenInput.toUpperCase();
  const directory = getTokenDirectory(chainId);
  const found = directory[normalized];
  if (found) {
    return found;
  }

  const tokens = await loadTokenList();
  const candidates = tokens.filter(
    (token) => token.chainId === chainId && token.symbol.toUpperCase() === normalized,
  );

  if (candidates.length === 0) {
    throw new Error(`Unsupported token "${tokenInput}" on ${getNetworkLabel(chainId)}.`);
  }

  const selected = candidates[0];
  return {
    symbol: selected.symbol,
    address: selected.address,
    decimals: selected.decimals,
  };
}

function parseConditionalBalanceQuote(message: string): { thresholdEth: string; tokenOut: string } | undefined {
  const lower = message.toLowerCase();
  if (!lower.includes('balance') || !lower.includes('quote') || !lower.includes('if')) {
    return undefined;
  }

  const thresholdMatch = message.match(/more than\s+(\d+(\.\d+)?)\s*eth/i);
  if (!thresholdMatch) {
    return undefined;
  }

  const withMatch = message.match(/with\s+(?:equivalent\s+amt\s+of\s+)?([a-zA-Z]+)/i);
  const toMatch = message.match(/to\s+([a-zA-Z]+)/i);
  let tokenOut = (withMatch?.[1] ?? toMatch?.[1] ?? 'USDC').toUpperCase();
  if (['SWAPPING', 'QUOTE', 'QUOTES', 'EQUIVALENT', 'AMT'].includes(tokenOut)) {
    tokenOut = 'USDC';
  }
  return {
    thresholdEth: thresholdMatch[1],
    tokenOut,
  };
}

const VALID_MODES: UserMode[] = [
  'recommendation-only',
  'assisted-execution',
  'limited-auto-execution',
];

const EXECUTABLE_ACTIONS: CommandName[] = [
  'setup',
  'recommend',
  'execute',
  'mode',
  'wallet-balance',
  'wallet-transfer',
  'swap-quote',
  'swap-execute',
  'recent-recommendations',
  'trigger-eval',
  'workflow-smoke',
];

function asStringFlag(flags: Record<string, string | boolean>, key: string): string | undefined {
  const value = flags[key];
  return typeof value === 'string' ? value : undefined;
}

function requireStringFlags(
  flags: Record<string, string | boolean>,
  keys: string[],
): Record<string, string> {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const key of keys) {
    const value = asStringFlag(flags, key);
    if (!value) {
      missing.push(key);
      continue;
    }
    values[key] = value;
  }
  if (missing.length > 0) {
    throw new Error(`Missing required details: ${missing.join(', ')}`);
  }
  return values;
}

function parseBoolean(value: string | undefined): boolean {
  return value === 'true' || value === '1' || value === 'yes';
}

function parsePositiveInteger(value: string, fieldName: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${fieldName}: ${value}`);
  }
  return parsed;
}

function parseNumber(value: string, fieldName: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${fieldName}: ${value}`);
  }
  return parsed;
}

function humanizeMissingDetails(errorText: string): string {
  const raw = errorText.replace('Missing required details:', '').trim();
  const parts = raw.split(',').map((item) => item.trim()).filter(Boolean);
  const mapped = parts.map((item) => {
    switch (item) {
      case 'tokenIn':
        return 'input token (example: ETH)';
      case 'tokenOut':
        return 'output token (example: USDC)';
      case 'amount':
      case 'amountEth':
        return 'amount';
      case 'to':
        return 'recipient wallet address';
      case 'mode':
        return 'mode (recommendation-only / assisted-execution / limited-auto-execution)';
      case 'network':
      case 'chainId':
        return 'network (Sepolia or Ethereum Mainnet)';
      default:
        return item;
    }
  });
  return `I need these details: ${mapped.join(', ')}.`;
}

function printHelp(): void {
  console.log(`NonceSense CLI

Usage:
  npm run dev

Chat examples:
  "What is my balance on sepolia?"
  "Send 0.001 ETH to 0x... on mainnet"
  "Send 0.01 WETH to 0x... on mainnet"
  "Give me quote for swapping 0.007 ETH to USDC on sepolia"
  "What is my balance, and if above 0.005 ETH then quote ETH to USDC on mainnet"
  "Set mode to assisted execution"
`);
}

async function getActiveUserFromConfig() {
  const config = await loadConfig();
  const activeUser = config.users.find((user) => user.id === config.activeUserId);
  if (!activeUser) {
    throw new Error('Active user not found.');
  }
  return { config, activeUser };
}

function getDefaultRpcUrl(): string {
  return process.env.ALCHEMY_SEPOLIA_ENDPOINT ?? process.env.ALCHEMY_MAINNET_ENDPOINT ?? '';
}

function getDefaultChainId(): number {
  if (process.env.ALCHEMY_SEPOLIA_ENDPOINT) {
    return 11155111;
  }
  if (process.env.ALCHEMY_MAINNET_ENDPOINT) {
    return 1;
  }
  return 11155111;
}

async function ensureWalletReady(): Promise<{
  created: boolean;
  walletAddress: string;
  chainId: number;
  privateKey?: string;
}> {
  const chainId = getDefaultChainId();
  const walletInit = await ensureActiveUserWallet(getDefaultRpcUrl(), chainId);
  const activeUser = walletInit.config.users.find((user) => user.id === walletInit.config.activeUserId);
  if (!activeUser) {
    throw new Error('Active user not found.');
  }
  return {
    created: walletInit.created,
    walletAddress: activeUser.wallet.address,
    chainId: activeUser.wallet.chainId,
    privateKey: walletInit.privateKey,
  };
}

function extractJsonObject(text: string): string {
  const fenceMatch = text.match(/```json\s*([\s\S]*?)```/i);
  if (fenceMatch && fenceMatch[1]) {
    return fenceMatch[1].trim();
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return text.slice(start, end + 1);
  }
  throw new Error('No JSON object found in model response.');
}

function parseTransferFromMessage(message: string): { to?: string; amountEth?: string; token?: string } {
  const addressMatch = message.match(/0x[a-fA-F0-9]{40}/);
  const explicitTokenMatch = message.match(
    /(\d+(\.\d+)?)\s*([a-zA-Z]{2,12})\s+to\s+0x[a-fA-F0-9]{40}/i,
  );
  const ethMatch = message.match(/(\d+(\.\d+)?)\s*eth\b/i);
  let amount = explicitTokenMatch?.[1] ?? ethMatch?.[1];
  let token = explicitTokenMatch?.[3]?.toUpperCase();

  if (!token && ethMatch) {
    token = 'ETH';
  }

  if (!token) {
    const tokenHint = message.match(/\b(weth|usdc|usdt|dai|wbtc|link|aave)\b/i);
    if (tokenHint) {
      token = tokenHint[1].toUpperCase();
    }
  }

  return {
    to: addressMatch?.[0],
    amountEth: amount,
    token,
  };
}

function parseSwapDetailsFromMessage(message: string): { tokenIn?: string; tokenOut?: string; amount?: string } {
  const compactPattern = /(\d+(\.\d+)?)\s*([a-zA-Z]{2,12})\s*(?:to|for|with|into)\s*([a-zA-Z]{2,12})/i;
  const compactMatch = message.match(compactPattern);
  if (compactMatch) {
    return {
      amount: compactMatch[1],
      tokenIn: compactMatch[3],
      tokenOut: compactMatch[4],
    };
  }

  const verbosePattern =
    /(?:swap(?:ping)?|quote(?: for)?(?: swapping)?|price)\s+(?:for\s+)?(\d+(\.\d+)?)\s*([a-zA-Z]{2,12})\s+(?:with|to|for)\s+([a-zA-Z]{2,12})/i;
  const verboseMatch = message.match(verbosePattern);
  if (verboseMatch) {
    return {
      amount: verboseMatch[1],
      tokenIn: verboseMatch[3],
      tokenOut: verboseMatch[4],
    };
  }

  return {};
}

function addContextTurn(
  contextWindow: ChatContextTurn[],
  role: ChatContextTurn['role'],
  message: string,
): void {
  contextWindow.push({ role, message });
  if (contextWindow.length > MAX_CONTEXT_TURNS) {
    contextWindow.splice(0, contextWindow.length - MAX_CONTEXT_TURNS);
  }
}

function missingDetailsForStep(step: ActionStep): string[] {
  const requiresNetwork =
    step.action === 'wallet-balance' ||
    step.action === 'wallet-transfer' ||
    step.action === 'swap-quote' ||
    step.action === 'swap-execute';

  const missing: string[] = [];
  if (requiresNetwork && !step.flags.chainId) {
    missing.push('network');
  }

  if (step.action === 'wallet-transfer') {
    missing.push(...['to', 'amountEth'].filter((key) => !step.flags[key]));
    return missing;
  }
  if (step.action === 'swap-quote' || step.action === 'swap-execute') {
    if (!step.flags.tokenIn) missing.push('tokenIn');
    if (!step.flags.tokenOut) missing.push('tokenOut');
    if (!step.flags.amount && !step.flags.amountIn && !step.flags.amountEth) missing.push('amount');
    return missing;
  }
  if (step.action === 'mode') {
    if (!step.flags.set) {
      missing.push('mode');
    }
    return missing;
  }
  return missing;
}

function enrichPendingStepFromMessage(step: ActionStep, message: string): ActionStep {
  const enriched: ActionStep = { ...step, flags: { ...step.flags } };
  const chainId = detectChainIdFromText(message);
  if (chainId) {
    enriched.flags.chainId = `${chainId}`;
  }
  if (step.action === 'wallet-transfer') {
    const extracted = parseTransferFromMessage(message);
    if (!enriched.flags.to && extracted.to) enriched.flags.to = extracted.to;
    if (!enriched.flags.amountEth && extracted.amountEth) enriched.flags.amountEth = extracted.amountEth;
    if (!enriched.flags.token && extracted.token) enriched.flags.token = extracted.token;
    return enriched;
  }

  if (step.action === 'swap-quote' || step.action === 'swap-execute') {
    const extracted = parseSwapDetailsFromMessage(message);
    if (!enriched.flags.tokenIn && extracted.tokenIn) enriched.flags.tokenIn = extracted.tokenIn;
    if (!enriched.flags.tokenOut && extracted.tokenOut) enriched.flags.tokenOut = extracted.tokenOut;
    if (!enriched.flags.amount && extracted.amount) enriched.flags.amount = extracted.amount;
    return enriched;
  }

  if (step.action === 'mode') {
    const lower = message.toLowerCase();
    if (lower.includes('assisted')) enriched.flags.set = 'assisted-execution';
    if (lower.includes('recommendation')) enriched.flags.set = 'recommendation-only';
    if (lower.includes('auto')) enriched.flags.set = 'limited-auto-execution';
  }

  return enriched;
}

function heuristicPlan(message: string): ActionPlan | undefined {
  const lower = message.toLowerCase();
  const chainId = detectChainIdFromText(message);
  const networkFlags: Record<string, string> = chainId ? { chainId: `${chainId}` } : {};
  const hasExecutionVerb = /\b(send|transfer|swap|trade|quote|execute)\b/.test(lower);
  const asksTokenHoldings =
    /\bhow much\s+[a-zA-Z0-9]{2,12}\s+do i have\b/.test(lower) ||
    /\bwhat(?:'s| is)\s+my\s+[a-zA-Z0-9]{2,12}\s+balance\b/.test(lower);

  if (/\b(balance|portfolio|funds)\b/.test(lower) || (asksTokenHoldings && !hasExecutionVerb)) {
    return { action: 'wallet-balance', flags: networkFlags, reply: 'Checking your balance.' };
  }

  const quote = parseSwapDetailsFromMessage(message);
  const hasSwapContext = /\b(swap|swapping|trade|convert|exchange)\b/.test(lower);
  const asksQuote = /\b(quote|price|rate)\b/.test(lower) || (/\bhow much\b/.test(lower) && hasSwapContext);
  const asksSwapExecute = /\b(swap|execute|trade)\b/.test(lower) && !asksQuote;
  if (quote.tokenIn && quote.tokenOut && quote.amount) {
    return {
      action: asksSwapExecute ? 'swap-execute' : 'swap-quote',
      flags: {
        ...networkFlags,
        tokenIn: quote.tokenIn,
        tokenOut: quote.tokenOut,
        amount: quote.amount,
      },
      reply: asksSwapExecute ? 'Preparing swap execution.' : 'Getting a swap quote.',
    };
  }

  if (/\b(send|transfer)\b/.test(lower) && /\beth\b/i.test(message) && /0x[a-fA-F0-9]{40}/.test(message)) {
    const parsed = parseTransferFromMessage(message);
    return {
      action: 'wallet-transfer',
      flags: {
        ...networkFlags,
        ...(parsed.to ? { to: parsed.to } : {}),
        ...(parsed.amountEth ? { amountEth: parsed.amountEth } : {}),
        ...(parsed.token ? { token: parsed.token } : {}),
      },
      reply: 'Preparing transfer.',
    };
  }

  if (/\b(send|transfer)\b/.test(lower) && /0x[a-fA-F0-9]{40}/.test(message)) {
    const parsed = parseTransferFromMessage(message);
    return {
      action: 'wallet-transfer',
      flags: {
        ...networkFlags,
        ...(parsed.to ? { to: parsed.to } : {}),
        ...(parsed.amountEth ? { amountEth: parsed.amountEth } : {}),
        ...(parsed.token ? { token: parsed.token } : {}),
      },
      reply: 'Preparing transfer.',
    };
  }

  if (asksQuote) {
    return {
      action: 'swap-quote',
      flags: {
        ...networkFlags,
        ...(quote.tokenIn ? { tokenIn: quote.tokenIn } : {}),
        ...(quote.tokenOut ? { tokenOut: quote.tokenOut } : {}),
        ...(quote.amount ? { amount: quote.amount } : {}),
      },
      reply: 'Sure — share token pair and amount if not already provided.',
    };
  }

  if (asksSwapExecute) {
    return {
      action: 'swap-execute',
      flags: {
        ...networkFlags,
        ...(quote.tokenIn ? { tokenIn: quote.tokenIn } : {}),
        ...(quote.tokenOut ? { tokenOut: quote.tokenOut } : {}),
        ...(quote.amount ? { amount: quote.amount } : {}),
      },
      reply: 'Sure — share token pair and amount for execution if not already provided.',
    };
  }

  return undefined;
}

async function directNetworkAnswer(message: string): Promise<string | undefined> {
  const lower = message.toLowerCase();
  const asksAction = /\b(balance|portfolio|funds|swap|quote|trade|send|transfer|recommend|execute)\b/.test(lower);
  const asksNetworkStatus =
    lower.includes('which network') ||
    lower.includes('what network') ||
    lower.includes('network am i on') ||
    lower.includes('current network') ||
    lower.includes('am i on') ||
    lower.includes('is this mainnet') ||
    lower.includes('is this sepolia');

  if (!asksNetworkStatus || asksAction) {
    return undefined;
  }

  await ensureWalletReady();
  const { activeUser } = await getActiveUserFromConfig();
  return `You are on ${getNetworkLabel(activeUser.wallet.chainId)} (chain ${activeUser.wallet.chainId}).`;
}

function shouldUseGeneralReasoning(message: string): boolean {
  const trimmed = message.trim();
  const lower = trimmed.toLowerCase();
  const hasAddress = /0x[a-fA-F0-9]{40}/.test(trimmed);
  const startsAsCommand = /^(send|transfer|swap|quote|get|check|show|set)\b/i.test(trimmed);
  const asksConceptual =
    /^(if|what if)\b/i.test(trimmed) ||
    /\b(do i need|should i|can i|would it|is it enough|why|how does)\b/.test(lower);
  return asksConceptual && !hasAddress && !startsAsCommand;
}

async function directGeneralAnswer(
  message: string,
  contextWindow: ChatContextTurn[],
): Promise<string | undefined> {
  if (!shouldUseGeneralReasoning(message)) {
    return undefined;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return 'I can explain that conceptually, but GEMINI_API_KEY is missing right now.';
  }

  const recentConversation =
    contextWindow.length > 0
      ? contextWindow.map((turn) => `${turn.role.toUpperCase()}: ${turn.message}`).join('\n')
      : 'No prior conversation context.';

  const prompt = `You are a helpful crypto assistant. Answer the user's question conversationally.

Rules:
- This is a conceptual/help question. Do NOT trigger or suggest executing actions.
- Be concise and practical.
- If the question depends on specific balances/amounts, explain the rule clearly.

Recent conversation:
${recentConversation}

User question:
${message}`;

  try {
    const ai = new GoogleGenAI({ apiKey });
    const model = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
    const response = await ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    });
    const text = (response.text ?? '').trim();
    return text || undefined;
  } catch {
    return undefined;
  }
}

function shouldExplainLastError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    (lower.includes('what does this error mean') ||
      lower.includes('explain this error') ||
      lower.includes('why this error') ||
      lower.includes('why did this fail') ||
      lower.includes('what is this error')) &&
    lower.includes('error')
  );
}

function explainError(errorText: string): string {
  if (errorText.includes('No Uniswap V3 pool found')) {
    return 'It means there is no available Uniswap V3 pool for that token pair at the selected fee tier on this network.';
  }
  if (errorText.includes('could not decode result data') || errorText.includes('BAD_DATA')) {
    return 'It means the quote contract call returned empty/invalid data. Common causes are wrong contract address for this network, missing pool for that fee tier, or RPC inconsistency.';
  }
  if (errorText.includes('Missing required details:')) {
    return humanizeMissingDetails(errorText);
  }
  if (errorText.includes('estimateGas') && errorText.includes('CALL_EXCEPTION')) {
    return 'It means swap simulation failed before submission. Common reasons: insufficient ETH for amount+gas, no available route/liquidity at chosen fee tier, or token transfer constraints.';
  }
  return `It means the operation failed with: ${errorText}`;
}

function humanizeAction(action: string): string {
  switch (action) {
    case 'wallet-balance':
      return 'checked wallet balance';
    case 'wallet-transfer':
      return 'sent funds';
    case 'swap-quote':
      return 'requested a swap quote';
    case 'swap-execute':
      return 'executed a swap';
    case 'mode':
      return 'changed execution mode';
    case 'recommend':
      return 'generated a recommendation';
    case 'execute':
      return 'executed a recommendation';
    default:
      return action;
  }
}

function formatActionFailureMessage(action: string, errorText: string): string {
  if (action === 'wallet-transfer') {
    return `Transfer failed: ${errorText}`;
  }
  if (action === 'swap-execute') {
    return `Swap failed: ${errorText}`;
  }
  return errorText;
}

async function directMemoryAnswer(message: string): Promise<string[] | undefined> {
  const lower = message.toLowerCase();
  const asksLastQuestion =
    /what did i ask (you )?(last time|before|previously)/i.test(message) ||
    /what was my last (question|prompt|message)/i.test(message);

  if (asksLastQuestion) {
    const recentUserMessages = await getRecentUserMessages(8);
    const previous = recentUserMessages.find((item) => item.trim().toLowerCase() !== lower.trim());
    if (!previous) {
      return ["I don't have a previous user message recorded yet in this workspace."];
    }
    return [`Your previous message was: "${previous}"`];
  }

  const asksActionHistory =
    /what (actions|activity) (have )?(i|we) (done|performed)/i.test(message) ||
    /what did i do (last|before|recently)/i.test(message) ||
    /show (my )?(recent )?(history|activity)/i.test(message);

  if (asksActionHistory) {
    const recentActions = await getRecentActionHistory(30);
    const successful = recentActions.filter((item) => item.phase === 'succeeded');
    if (successful.length === 0) {
      return ["I don't see any completed actions recorded yet."];
    }

    const uniqueActions: string[] = [];
    for (const action of successful) {
      const text = humanizeAction(action.action);
      if (!uniqueActions.includes(text)) {
        uniqueActions.push(text);
      }
      if (uniqueActions.length >= 5) {
        break;
      }
    }

    return [
      'Here are your recent completed actions:',
      ...uniqueActions.map((item, index) => `${index + 1}. ${item}`),
    ];
  }

  return undefined;
}

async function buildActionSteps(
  message: string,
  contextWindow: ChatContextTurn[],
): Promise<{ steps: ActionStep[]; reply?: string }> {
  const chainId = detectChainIdFromText(message);
  const networkFlags: Record<string, string> = chainId ? { chainId: `${chainId}` } : {};
  const conditional = parseConditionalBalanceQuote(message);
  if (conditional) {
    return {
      steps: [
        { action: 'wallet-balance', flags: networkFlags },
        {
          action: 'swap-quote',
          flags: { ...networkFlags, tokenIn: 'ETH', tokenOut: conditional.tokenOut },
          minNativeBalanceEth: conditional.thresholdEth,
          useCurrentNativeBalanceAsAmount: true,
        },
      ],
    };
  }

  const subRequests = message
    .split(/\b(?:and then|then|also| and )\b/i)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  if (subRequests.length > 1) {
    const steps: ActionStep[] = [];
    for (const request of subRequests) {
      const heuristicSub = heuristicPlan(request);
      if (heuristicSub && heuristicSub.action !== 'none') {
        steps.push({ action: heuristicSub.action, flags: heuristicSub.flags });
        continue;
      }

      const plannedSub = await planFromUserMessage(request, contextWindow);
      if (plannedSub.action !== 'none' && EXECUTABLE_ACTIONS.includes(plannedSub.action)) {
        steps.push({ action: plannedSub.action, flags: plannedSub.flags });
      }
    }
    if (steps.length > 0) {
      return { steps };
    }
  }

  const heuristic = heuristicPlan(message);
  if (heuristic && heuristic.action !== 'none') {
    return {
      steps: [{ action: heuristic.action, flags: heuristic.flags }],
    };
  }

  const planned = await planFromUserMessage(message, contextWindow);
  if (planned.action === 'none' || !EXECUTABLE_ACTIONS.includes(planned.action)) {
    return { steps: [], reply: planned.reply };
  }
  return {
    steps: [{ action: planned.action, flags: planned.flags }],
  };
}

async function planFromUserMessage(
  userMessage: string,
  contextWindow: ChatContextTurn[],
): Promise<ActionPlan> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      action: 'none',
      flags: {},
      reply:
        'GEMINI_API_KEY is not configured. Add it in .env, then restart `npm run dev`.',
    };
  }

  const ai = new GoogleGenAI({ apiKey });
  const recentConversation =
    contextWindow.length > 0
      ? contextWindow.map((turn) => `${turn.role.toUpperCase()}: ${turn.message}`).join('\n')
      : 'No prior conversation context.';

  const prompt = `You are a router for a chat-first crypto assistant. Convert user chat into one action.

Return STRICT JSON only:
{
  "action": "setup|wallet-balance|wallet-transfer|swap-quote|swap-execute|recommend|execute|mode|recent-recommendations|trigger-eval|workflow-smoke|none",
  "flags": { "key": "value" },
  "reply": "short user-facing sentence"
}

Rules:
- Prefer wallet-balance for balance queries.
- For mode changes, use action=mode and flags.set.
- For setup, user may provide no args. Use action=setup with empty flags to auto-create wallet.
- If user asks "how/steps" instead of executing, set action=none and explain in reply.
- If user asks a hypothetical or conceptual question (for example starts with "if", "what if", "do I need", "should I"), set action=none.
- For transfers, extract recipient address, amount, and token symbol (ETH or ERC-20 like WETH) from natural language.
- For swap quotes, extract amount + token pair from natural language (example: "0.007 eth with usdc").
- If user message specifies network, set flags.chainId to "1" for mainnet and "11155111" for sepolia.
- If network is not specified for balance/transfer/swap actions, do not invent one.
- If required values are missing, keep action as best guess and include missing details in reply.
- Never invent addresses/private keys.
- Keep flags string-to-string.

Recent conversation:
${recentConversation}

User message:
${userMessage}`;

  const model = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
  const response = await ai.models.generateContent({
    model,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
  });
  const raw = response.text ?? '';
  const parsed = JSON.parse(extractJsonObject(raw)) as ActionPlan;
  return {
    action: parsed.action,
    flags: parsed.flags ?? {},
    reply: parsed.reply ?? 'Working on it.',
  };
}

async function getWalletForAction(flags: Record<string, string | boolean>) {
  await ensureWalletReady();
  const { activeUser } = await getActiveUserFromConfig();
  let chainIdRaw = asStringFlag(flags, 'chainId');
  if (!chainIdRaw) {
    const network = asStringFlag(flags, 'network');
    if (network) {
      const detected = detectChainIdFromText(network);
      if (detected) {
        chainIdRaw = `${detected}`;
      }
    }
  }
  if (!chainIdRaw) {
    throw new Error('Missing required details: network');
  }
  const chainId = parsePositiveInteger(chainIdRaw, 'chainId');
  if (chainId !== 1 && chainId !== 11155111) {
    throw new Error('Only Ethereum Mainnet (1) and Sepolia (11155111) are supported right now.');
  }
  const rpcUrl = getRpcUrlForChainId(chainId);
  if (!rpcUrl) {
    const envName = chainId === 1 ? 'ALCHEMY_MAINNET_ENDPOINT' : 'ALCHEMY_SEPOLIA_ENDPOINT';
    throw new Error(`RPC URL is missing for ${getNetworkLabel(chainId)}. Add ${envName} in .env.`);
  }

  return {
    ...activeUser.wallet,
    chainId,
    rpcUrl,
  };
}

async function executeCommand(
  command: CommandName,
  flags: Record<string, string | boolean>,
): Promise<unknown> {
  switch (command) {
    case 'help':
      printHelp();
      return { command: 'help' };
    case 'version':
      return { command: 'version', version: '0.2.0' };
    case 'setup': {
      const wallet = asStringFlag(flags, 'wallet');
      if (!wallet) {
        const initialized = await ensureWalletReady();
        return {
          command: 'setup',
          saved: true,
          configPath: getConfigPath(),
          autoCreated: initialized.created,
          walletAddress: initialized.walletAddress,
          chainId: initialized.chainId,
          privateKey: initialized.privateKey,
          note: 'Private key is shown once here and stored locally in .noncesense/secrets.json',
        };
      }
      const rpc = asStringFlag(flags, 'rpc') ?? getDefaultRpcUrl();
      if (!rpc) {
        throw new Error('RPC URL is missing. Add ALCHEMY_SEPOLIA_ENDPOINT in .env.');
      }
      const chainIdRaw = asStringFlag(flags, 'chainId') ?? '11155111';
      const chainId = parsePositiveInteger(chainIdRaw, 'chainId');
      const config = await setActiveUserWallet(wallet, rpc, chainId);
      const activeUser = config.users.find((user) => user.id === config.activeUserId);
      return { command: 'setup', saved: true, configPath: getConfigPath(), activeUser, autoCreated: false };
    }
    case 'mode': {
      const mode = asStringFlag(flags, 'set');
      if (!mode) {
        throw new Error('Missing required details: mode');
      }
      if (!VALID_MODES.includes(mode as UserMode)) {
        throw new Error(`Invalid mode: ${mode}`);
      }
      const config = await setActiveUserMode(mode as UserMode);
      const activeUser = config.users.find((user) => user.id === config.activeUserId);
      return { command: 'mode', saved: true, configPath: getConfigPath(), mode: activeUser?.mode };
    }
    case 'wallet-balance': {
      const actionWallet = await getWalletForAction(flags);
      const nativeBalance = await getNativeBalance(actionWallet);
      const portfolio = await getWalletPortfolio(actionWallet);
      return {
        command: 'wallet-balance',
        wallet: actionWallet.address,
        chainId: actionWallet.chainId,
        nativeBalance,
        portfolio,
      };
    }
    case 'wallet-transfer': {
      const values = requireStringFlags(flags, ['to', 'amountEth']);
      const actionWallet = await getWalletForAction(flags);
      const privateKey = (await getActiveUserPrivateKey()) ?? process.env.PRIVATE_KEY ?? '';
      const tokenInput = (asStringFlag(flags, 'token') ?? 'ETH').toUpperCase();

      if (tokenInput === 'ETH') {
        const tx = await transferNative(actionWallet, privateKey, values.to, values.amountEth);
        return {
          command: 'wallet-transfer',
          transferType: 'native',
          token: 'ETH',
          status: tx.status,
          blockNumber: tx.blockNumber,
          from: actionWallet.address,
          to: values.to,
          amountEth: values.amountEth,
          chainId: actionWallet.chainId,
          rpcHost: getRpcHost(actionWallet.rpcUrl),
          transactionHash: tx.transactionHash,
        };
      }

      const token = await resolveToken(actionWallet.chainId, tokenInput, asStringFlag(flags, 'tokenDecimals'));
      const tx = await transferErc20(
        actionWallet,
        privateKey,
        token.address,
        token.decimals,
        values.to,
        values.amountEth,
      );
      return {
        command: 'wallet-transfer',
        transferType: 'erc20',
        token: token.symbol,
        tokenAddress: token.address,
        status: tx.status,
        blockNumber: tx.blockNumber,
        from: actionWallet.address,
        to: values.to,
        amountEth: values.amountEth,
        chainId: actionWallet.chainId,
        rpcHost: getRpcHost(actionWallet.rpcUrl),
        transactionHash: tx.transactionHash,
      };
    }
    case 'swap-quote': {
      const actionWallet = await getWalletForAction(flags);
      const tokenInInput = asStringFlag(flags, 'tokenIn');
      const tokenOutInput = asStringFlag(flags, 'tokenOut');
      if (!tokenInInput || !tokenOutInput) {
        throw new Error('Missing required details: tokenIn, tokenOut');
      }

      const tokenIn = await resolveToken(
        actionWallet.chainId,
        tokenInInput,
        asStringFlag(flags, 'tokenInDecimals'),
      );
      const tokenOut = await resolveToken(
        actionWallet.chainId,
        tokenOutInput,
        asStringFlag(flags, 'tokenOutDecimals'),
      );

      const amountRaw =
        asStringFlag(flags, 'amountIn') ??
        (() => {
          const amountHuman =
            asStringFlag(flags, 'amount') ??
            asStringFlag(flags, 'amountEth');
          if (!amountHuman) {
            return undefined;
          }
          return ethers.parseUnits(amountHuman, tokenIn.decimals).toString();
        })();

      if (!amountRaw) {
        throw new Error('Missing required details: amount');
      }

      const fee = parsePositiveInteger(asStringFlag(flags, 'fee') ?? '3000', 'fee');
      const quote = await quoteExactInputSingle({
        wallet: actionWallet,
        tokenIn: tokenIn.address,
        tokenOut: tokenOut.address,
        amountIn: amountRaw,
        fee,
      });
      return {
        command: 'swap-quote',
        tokenIn,
        tokenOut,
        amountInRaw: amountRaw,
        amountInFormatted: ethers.formatUnits(amountRaw, tokenIn.decimals),
        amountOutRaw: quote.amountOut,
        amountOutFormatted: ethers.formatUnits(quote.amountOut, tokenOut.decimals),
      };
    }
    case 'swap-execute': {
      const actionWallet = await getWalletForAction(flags);
      const tokenInInput = asStringFlag(flags, 'tokenIn');
      const tokenOutInput = asStringFlag(flags, 'tokenOut');
      if (!tokenInInput || !tokenOutInput) {
        throw new Error('Missing required details: tokenIn, tokenOut');
      }
      const tokenIn = await resolveToken(
        actionWallet.chainId,
        tokenInInput,
        asStringFlag(flags, 'tokenInDecimals'),
      );
      const tokenOut = await resolveToken(
        actionWallet.chainId,
        tokenOutInput,
        asStringFlag(flags, 'tokenOutDecimals'),
      );

      const amountRaw =
        asStringFlag(flags, 'amountIn') ??
        (() => {
          const amountHuman =
            asStringFlag(flags, 'amount') ??
            asStringFlag(flags, 'amountEth');
          if (!amountHuman) {
            return undefined;
          }
          return ethers.parseUnits(amountHuman, tokenIn.decimals).toString();
        })();
      if (!amountRaw) {
        throw new Error('Missing required details: amount');
      }

      const privateKey = (await getActiveUserPrivateKey()) ?? process.env.PRIVATE_KEY ?? '';
      const fee = parsePositiveInteger(asStringFlag(flags, 'fee') ?? '3000', 'fee');
      const slippageBps = parsePositiveInteger(
        asStringFlag(flags, 'slippageBps') ?? '100',
        'slippageBps',
      );
      const tx = await swapExactInputSingle({
        wallet: actionWallet,
        privateKey,
        tokenIn: tokenIn.address,
        tokenOut: tokenOut.address,
        amountIn: amountRaw,
        fee,
        slippageBps,
        useNativeIn: tokenInInput.toUpperCase() === 'ETH',
      });
      return {
        command: 'swap-execute',
        transactionHash: tx.transactionHash,
        status: tx.status,
        blockNumber: tx.blockNumber,
      };
    }
    case 'recommend': {
      const values = requireStringFlags(flags, ['tokenIn', 'tokenOut', 'amount']);
      await ensureWalletReady();
      const { activeUser } = await getActiveUserFromConfig();
      const recommendation: Recommendation = {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        request: {
          tokenIn: {
            chainId: activeUser.wallet.chainId,
            symbol: values.tokenIn,
            address: asStringFlag(flags, 'tokenInAddress') ?? '',
            decimals: parseInt(asStringFlag(flags, 'tokenInDecimals') ?? '18', 10),
          },
          tokenOut: {
            chainId: activeUser.wallet.chainId,
            symbol: values.tokenOut,
            address: asStringFlag(flags, 'tokenOutAddress') ?? '',
            decimals: parseInt(asStringFlag(flags, 'tokenOutDecimals') ?? '18', 10),
          },
          amountIn: values.amount,
          slippageBps: parseInt(asStringFlag(flags, 'slippageBps') ?? '100', 10),
        },
        rationale: `Mode=${activeUser.mode}; based on chat or CLI request`,
        estimatedAmountOut: asStringFlag(flags, 'estimatedAmountOut') ?? '0',
        routeLabel: 'uniswap-v3',
        validUntil: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      };
      await addRecommendation(recommendation);
      return {
        command: 'recommend',
        mode: activeUser.mode,
        memoryPath: getMemoryPath(),
        recommendation,
      };
    }
    case 'execute': {
      const values = requireStringFlags(flags, ['recommendationId']);
      const recommendation = await getRecommendationById(values.recommendationId);
      if (!recommendation) {
        throw new Error(`Recommendation not found: ${values.recommendationId}`);
      }

      const { activeUser } = await getActiveUserFromConfig();
      await logExecutionRequested(recommendation.id);

      const amountUsdRaw = asStringFlag(flags, 'amountUsd');
      const amountUsd = amountUsdRaw ? parseNumber(amountUsdRaw, 'amountUsd') : undefined;
      const decision = evaluateExecutionPolicy({
        mode: activeUser.mode,
        policy: activeUser.policy,
        tokenInSymbol: recommendation.request.tokenIn.symbol,
        amountUsd,
        explicitConfirmation: parseBoolean(asStringFlag(flags, 'confirm')),
      });
      if (!decision.allowed) {
        await logExecutionFailed(recommendation.id, decision.reason);
        throw new Error(decision.reason);
      }

      if (!recommendation.request.tokenIn.address || !recommendation.request.tokenOut.address) {
        const message =
          'Recommendation missing token addresses. Re-run recommend with token addresses.';
        await logExecutionFailed(recommendation.id, message);
        throw new Error(message);
      }

      const privateKey = (await getActiveUserPrivateKey()) ?? process.env.PRIVATE_KEY ?? '';
      const fee = parsePositiveInteger(asStringFlag(flags, 'fee') ?? '3000', 'fee');
      const slippageBps = parsePositiveInteger(
        asStringFlag(flags, 'slippageBps') ?? `${recommendation.request.slippageBps}`,
        'slippageBps',
      );
      const tx = await swapExactInputSingle({
        wallet: activeUser.wallet,
        tokenIn: recommendation.request.tokenIn.address,
        tokenOut: recommendation.request.tokenOut.address,
        amountIn: recommendation.request.amountIn,
        fee,
        slippageBps,
        privateKey,
      });
      await logExecutionSubmitted(recommendation.id, tx.transactionHash);
      return {
        command: 'execute',
        recommendationId: recommendation.id,
        mode: activeUser.mode,
        transactionHash: tx.transactionHash,
      };
    }
    case 'recent-recommendations': {
      const limitRaw = asStringFlag(flags, 'limit') ?? '5';
      const limit = parsePositiveInteger(limitRaw, 'limit');
      const recommendations = await listRecentRecommendations(limit);
      return { command: 'recent-recommendations', memoryPath: getMemoryPath(), recommendations };
    }
    case 'trigger-eval': {
      const values = requireStringFlags(flags, [
        'targetPrice',
        'currentPrice',
        'direction',
        'tokenIn',
        'tokenOut',
      ]);
      if (values.direction !== 'above' && values.direction !== 'below') {
        throw new Error('Invalid direction, use above|below.');
      }
      const result = evaluateTrigger({
        condition: {
          id: 'adhoc',
          label: 'ad-hoc trigger',
          enabled: true,
          tokenInSymbol: values.tokenIn,
          tokenOutSymbol: values.tokenOut,
          targetPrice: values.targetPrice,
          direction: values.direction,
        },
        currentPrice: values.currentPrice,
      });
      return { command: 'trigger-eval', result };
    }
    case 'workflow-smoke': {
      const values = requireStringFlags(flags, [
        'tokenIn',
        'tokenOut',
        'amount',
        'targetPrice',
        'currentPrice',
      ]);
      await ensureWalletReady();
      const { activeUser } = await getActiveUserFromConfig();
      const recommendation: Recommendation = {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        request: {
          tokenIn: {
            chainId: activeUser.wallet.chainId,
            symbol: values.tokenIn,
            address: '',
            decimals: 18,
          },
          tokenOut: {
            chainId: activeUser.wallet.chainId,
            symbol: values.tokenOut,
            address: '',
            decimals: 18,
          },
          amountIn: values.amount,
          slippageBps: 100,
        },
        rationale: 'Generated by workflow-smoke',
        estimatedAmountOut: '0',
        routeLabel: 'uniswap-v3',
        validUntil: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      };
      await addRecommendation(recommendation);

      const triggerResult = evaluateTrigger({
        condition: {
          id: 'smoke-trigger',
          label: 'smoke trigger',
          enabled: true,
          tokenInSymbol: values.tokenIn,
          tokenOutSymbol: values.tokenOut,
          targetPrice: values.targetPrice,
          direction: 'below',
        },
        currentPrice: values.currentPrice,
      });
      const policyDecision = evaluateExecutionPolicy({
        mode: activeUser.mode,
        policy: activeUser.policy,
        tokenInSymbol: values.tokenIn,
        amountUsd: undefined,
        explicitConfirmation: true,
      });
      return {
        command: 'workflow-smoke',
        mode: activeUser.mode,
        recommendationId: recommendation.id,
        triggerResult,
        policyDecision,
        memoryPath: getMemoryPath(),
      };
    }
  }
}

function formatChatFriendlyResult(action: CommandName, result: unknown): string[] {
  if (action === 'setup') {
    const payload = result as {
      walletAddress: string;
      chainId: number;
      privateKey?: string;
      autoCreated?: boolean;
      note?: string;
    };
    if (payload.autoCreated) {
      const lines = ['I created your wallet.', `Address: ${payload.walletAddress}`];
      if (payload.privateKey) {
        lines.push(`Private key: ${payload.privateKey}`);
      }
      if (payload.note) {
        lines.push(payload.note);
      }
      return lines;
    }
    return ['Wallet setup updated.'];
  }

  if (action === 'mode') {
    const payload = result as { mode?: string };
    return [`Mode set to ${payload.mode ?? 'unknown'}.`];
  }

  if (action === 'wallet-balance') {
    const payload = result as {
      wallet: string;
      chainId: number;
      portfolio: {
        native: { ether: string };
        tokens: Array<{ symbol: string; balanceFormatted: string; contractAddress: string }>;
      };
    };
    const lines = [
      `Wallet ${payload.wallet} on ${getNetworkLabel(payload.chainId)} (chain ${payload.chainId})`,
      `Native balance: ${payload.portfolio.native.ether}`,
    ];
    if (payload.portfolio.tokens.length === 0) {
      lines.push('No ERC-20 token balances found via Alchemy.');
      return lines;
    }
    lines.push('Token balances:');
    for (const token of payload.portfolio.tokens) {
      lines.push(`- ${token.symbol}: ${token.balanceFormatted} (${token.contractAddress})`);
    }
    return lines;
  }

  if (action === 'wallet-transfer') {
    const payload = result as {
      transactionHash?: string;
      amountEth?: string;
      to?: string;
      chainId?: number;
      rpcHost?: string;
      token?: string;
      transferType?: 'native' | 'erc20';
      tokenAddress?: string;
      status?: string;
      blockNumber?: number;
    };
    return [
      `${payload.transferType === 'erc20' ? 'Token transfer' : 'Transfer'} submitted${payload.chainId ? ` on ${getNetworkLabel(payload.chainId)}` : ''}.`,
      `Status: ${payload.status ?? 'submitted'}${payload.blockNumber ? ` (block ${payload.blockNumber})` : ''}`,
      `Amount: ${payload.amountEth ?? 'unknown'} ${payload.token ?? 'ETH'}`,
      `To: ${payload.to ?? 'unknown'}`,
      ...(payload.tokenAddress ? [`Token: ${payload.tokenAddress}`] : []),
      `RPC: ${payload.rpcHost ?? 'unknown'}`,
      `Tx hash: ${payload.transactionHash ?? 'unknown'}`,
    ];
  }

  if (action === 'swap-quote') {
    const payload = result as {
      tokenIn: { symbol: string };
      tokenOut: { symbol: string };
      amountInFormatted: string;
      amountOutFormatted: string;
    };
    return [
      `Uniswap V3 quote — ${payload.amountInFormatted} ${payload.tokenIn.symbol} -> ${payload.amountOutFormatted} ${payload.tokenOut.symbol}`,
    ];
  }

  if (action === 'swap-execute') {
    const payload = result as { transactionHash?: string; status?: string; blockNumber?: number };
    if (payload.transactionHash) {
      return [
        'Swap submitted on Uniswap.',
        `Status: ${payload.status ?? 'submitted'}${payload.blockNumber ? ` (block ${payload.blockNumber})` : ''}`,
        `Tx hash: ${payload.transactionHash}`,
      ];
    }
  }

  return [JSON.stringify(result, null, 2)];
}

function stripMarkdownFences(text: string): string {
  return text.replace(/```[\s\S]*?```/g, (block) =>
    block.replace(/^```[a-zA-Z]*\s*/m, '').replace(/```$/m, '').trim(),
  );
}

async function narrateActionResult(action: CommandName, result: unknown): Promise<string[]> {
  const fallback = formatChatFriendlyResult(action, result);
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return fallback;
  }

  const payloadJson = JSON.stringify(result, null, 2);
  const prompt = `You are NonceSense, a crypto assistant. Convert a structured action result into a concise human explanation.

Rules:
- Be factual and only use information present in the payload.
- Explain naturally for a non-technical user.
- Mention important outputs (network, amounts, token symbols, tx hash, wallet, mode, trigger outcome) when present.
- Keep it concise (2-6 lines).
- Do not output JSON.
- Do not include markdown code fences.

Action: ${action}
Result payload:
${payloadJson}`;

  try {
    const ai = new GoogleGenAI({ apiKey });
    const model = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
    const response = await ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    });
    const text = stripMarkdownFences((response.text ?? '').trim());
    if (!text) {
      return fallback;
    }
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return lines.length > 0 ? lines : fallback;
  } catch {
    return fallback;
  }
}

async function composeActionResponse(action: CommandName, result: unknown): Promise<string[]> {
  const narrated = await narrateActionResult(action, result);
  const details = formatChatFriendlyResult(action, result);

  const joinedNarrated = narrated.join('\n').trim();
  const joinedDetails = details.join('\n').trim();
  if (joinedNarrated === joinedDetails) {
    return details;
  }

  return [...narrated, 'Details:', ...details];
}

function formatSwapConfirmationLines(
  quoteResult: unknown,
  flags: Record<string, string>,
): string[] {
  const payload = quoteResult as {
    tokenIn?: { symbol?: string };
    tokenOut?: { symbol?: string };
    amountInFormatted?: string;
    amountOutFormatted?: string;
  };
  const chainId = parseInt(flags.chainId ?? '', 10);
  const slippageBps = flags.slippageBps ?? '100';

  return [
    'Before I execute the swap, please confirm these details:',
    `Network: ${Number.isFinite(chainId) ? getNetworkLabel(chainId) : 'Unknown'}`,
    `Pair: ${payload.tokenIn?.symbol ?? flags.tokenIn ?? 'TOKEN'} -> ${payload.tokenOut?.symbol ?? flags.tokenOut ?? 'TOKEN'}`,
    `Amount in: ${payload.amountInFormatted ?? flags.amount ?? flags.amountIn ?? 'unknown'}`,
    `Estimated amount out: ${payload.amountOutFormatted ?? 'unknown'}`,
    `Slippage: ${slippageBps} bps`,
    'Reply with "yes" to proceed or "no" to cancel.',
  ];
}

async function runChatMode(): Promise<void> {
  console.log('');
  console.log(`${UI.bold}NonceSense${UI.reset}`);
  console.log(`${UI.dim}Natural chat mode · type /exit to quit${UI.reset}`);
  console.log('');
  await logSystemEvent('chat-mode-started', { logsPath: getLogsPath() });
  const initialized = await ensureWalletReady();
  const contextWindow: ChatContextTurn[] = [];
  const emitAssistantLine = async (line: string): Promise<void> => {
    console.log(`${UI.cyan}${line}${UI.reset}`);
    addContextTurn(contextWindow, 'assistant', line);
    await logChatMessage('assistant', line);
  };
  const emitAssistantLines = async (lines: string[]): Promise<void> => {
    for (const line of lines) {
      await emitAssistantLine(line);
    }
  };

  if (initialized.created) {
    await emitAssistantLine('I created a new wallet for you (first-time setup).');
    await emitAssistantLine(`Address: ${initialized.walletAddress}`);
    if (initialized.privateKey) {
      await emitAssistantLine(`Private key: ${initialized.privateKey}`);
      await emitAssistantLine('Save this private key securely. It is stored locally for chat execution.');
    }
  }
  const rl = createInterface({ input, output });
  let lastErrorText: string | undefined;
  let pendingStep: ActionStep | undefined;
  let pendingSwapConfirmation: PendingSwapConfirmation | undefined;
  try {
    while (true) {
      const message = (await rl.question(`${UI.dim}> ${UI.reset}`)).trim();
      if (!message) {
        continue;
      }
      await logChatMessage('user', message);
      addContextTurn(contextWindow, 'user', message);
      if (
        message.toLowerCase() === 'exit' ||
        message.toLowerCase() === 'quit' ||
        message.toLowerCase() === '/exit'
      ) {
        await logSystemEvent('chat-mode-exit');
        break;
      }

      if (shouldExplainLastError(message) && lastErrorText) {
        await emitAssistantLine(explainError(lastErrorText));
        continue;
      }

      const memoryAnswer = await directMemoryAnswer(message);
      if (memoryAnswer) {
        await emitAssistantLines(memoryAnswer);
        continue;
      }

      if (pendingSwapConfirmation) {
        const confirmation = pendingSwapConfirmation;
        if (isAffirmative(message)) {
          try {
            await logActionEvent('swap-execute', 'started', {
              source: 'confirmation',
              chainId: confirmation.flags.chainId ?? 'unknown',
            });
            const result = await executeCommand('swap-execute', confirmation.flags);
            await logActionEvent('swap-execute', 'succeeded', {
              source: 'confirmation',
              chainId: confirmation.flags.chainId ?? 'unknown',
            });
            lastErrorText = undefined;
            pendingSwapConfirmation = undefined;
            await emitAssistantLines(await composeActionResponse('swap-execute', result));
          } catch (error: unknown) {
            const text = error instanceof Error ? error.message : String(error);
            await logActionEvent('swap-execute', 'failed', {
              source: 'confirmation',
              chainId: confirmation.flags.chainId ?? 'unknown',
              error: text,
            });
            await logErrorEvent(text, {
              action: 'swap-execute',
              source: 'confirmation',
              chainId: confirmation.flags.chainId ?? 'unknown',
            });
            lastErrorText = text;
            pendingSwapConfirmation = undefined;
            await emitAssistantLine(formatActionFailureMessage('swap-execute', text));
          }
          continue;
        }

        if (isNegative(message)) {
          await logSystemEvent('swap-cancelled-by-user', {
            chainId: confirmation.flags.chainId ?? 'unknown',
          });
          pendingSwapConfirmation = undefined;
          await emitAssistantLine('Swap cancelled.');
          continue;
        }

        await emitAssistantLine('Please reply with "yes" to proceed or "no" to cancel this swap.');
        continue;
      }

      if (pendingStep) {
        const enriched = enrichPendingStepFromMessage(pendingStep, message);
        const missing = missingDetailsForStep(enriched);
        if (missing.length === 0) {
          if (enriched.action === 'swap-execute') {
            try {
              const quoteResult = await executeCommand('swap-quote', enriched.flags);
              pendingSwapConfirmation = { flags: { ...enriched.flags } };
              pendingStep = undefined;
              await emitAssistantLines(formatSwapConfirmationLines(quoteResult, enriched.flags));
            } catch (error: unknown) {
              const text = error instanceof Error ? error.message : String(error);
              await logErrorEvent(text, { action: 'swap-quote', source: 'swap-confirmation-preview' });
              lastErrorText = text;
              pendingStep = undefined;
              await emitAssistantLine(text);
            }
            continue;
          }

          try {
            await logActionEvent(enriched.action, 'started', { source: 'pending-step' });
            const result = await executeCommand(enriched.action, enriched.flags);
            await logActionEvent(enriched.action, 'succeeded', { source: 'pending-step' });
            lastErrorText = undefined;
            pendingStep = undefined;
            await emitAssistantLines(await composeActionResponse(enriched.action, result));
            continue;
          } catch (error: unknown) {
            const text = error instanceof Error ? error.message : String(error);
            await logActionEvent(enriched.action, 'failed', { source: 'pending-step', error: text });
            await logErrorEvent(text, { action: enriched.action, source: 'pending-step' });
            lastErrorText = text;
            pendingStep = undefined;
            if (text.startsWith('Missing required details:')) {
              await emitAssistantLine(humanizeMissingDetails(text));
            } else {
              await emitAssistantLine(formatActionFailureMessage(enriched.action, text));
            }
            continue;
          }
        }
        pendingStep = enriched;
      }

      const directAnswer = await directNetworkAnswer(message);
      if (directAnswer) {
        await emitAssistantLine(directAnswer);
        continue;
      }

      const generalAnswer = await directGeneralAnswer(message, contextWindow);
      if (generalAnswer) {
        await emitAssistantLine(generalAnswer);
        continue;
      }

      let built: { steps: ActionStep[]; reply?: string };
      try {
        built = await buildActionSteps(message, contextWindow);
      } catch (error: unknown) {
        const text = error instanceof Error ? error.message : String(error);
        await logErrorEvent(text, { action: 'buildActionSteps' });
        await emitAssistantLine(`I could not parse that yet (${text}). Try rephrasing.`);
        continue;
      }

      if (built.steps.length === 0) {
        await emitAssistantLine(built.reply ?? 'Got it.');
        continue;
      }

      let currentNativeBalanceEth: string | undefined;
      for (const step of built.steps) {
        const stepWithNetwork = enrichPendingStepFromMessage(step, message);

        if (step.action === 'wallet-transfer') {
          const extracted = parseTransferFromMessage(message);
          if (!stepWithNetwork.flags.to && extracted.to) {
            stepWithNetwork.flags.to = extracted.to;
          }
          if (!stepWithNetwork.flags.amountEth && extracted.amountEth) {
            stepWithNetwork.flags.amountEth = extracted.amountEth;
          }
          if (!stepWithNetwork.flags.token && extracted.token) {
            stepWithNetwork.flags.token = extracted.token;
          }
        }

        if (stepWithNetwork.useCurrentNativeBalanceAsAmount && currentNativeBalanceEth) {
          stepWithNetwork.flags.amount = currentNativeBalanceEth;
        }

        if (stepWithNetwork.minNativeBalanceEth && currentNativeBalanceEth) {
          const current = Number(currentNativeBalanceEth);
          const threshold = Number(stepWithNetwork.minNativeBalanceEth);
          if (Number.isFinite(current) && Number.isFinite(threshold) && current <= threshold) {
            await emitAssistantLine(
              `Skipping quote because balance ${currentNativeBalanceEth} ETH is not above ${stepWithNetwork.minNativeBalanceEth} ETH.`,
            );
            continue;
          }
        }

        try {
          await logActionEvent(stepWithNetwork.action, 'planned', {
            chainId: stepWithNetwork.flags.chainId ?? 'unspecified',
          });
          const missing = missingDetailsForStep(stepWithNetwork);
          if (missing.includes('network')) {
            pendingStep = stepWithNetwork;
            await emitAssistantLine(getNetworkPromptText());
            break;
          }

          if (stepWithNetwork.action === 'swap-execute') {
            const quoteResult = await executeCommand('swap-quote', stepWithNetwork.flags);
            pendingSwapConfirmation = { flags: { ...stepWithNetwork.flags } };
            pendingStep = undefined;
            await emitAssistantLines(formatSwapConfirmationLines(quoteResult, stepWithNetwork.flags));
            break;
          }

          await logActionEvent(stepWithNetwork.action, 'started', {
            chainId: stepWithNetwork.flags.chainId ?? 'unknown',
          });
          const result = await executeCommand(stepWithNetwork.action, stepWithNetwork.flags);
          await logActionEvent(stepWithNetwork.action, 'succeeded', {
            chainId: stepWithNetwork.flags.chainId ?? 'unknown',
          });
          lastErrorText = undefined;
          pendingStep = undefined;
          await emitAssistantLines(await composeActionResponse(stepWithNetwork.action, result));

          if (stepWithNetwork.action === 'wallet-balance') {
            const payload = result as { portfolio: { native: { ether: string } } };
            currentNativeBalanceEth = payload.portfolio.native.ether;
          }
        } catch (error: unknown) {
          const text = error instanceof Error ? error.message : String(error);
          await logActionEvent(stepWithNetwork.action, 'failed', {
            chainId: stepWithNetwork.flags.chainId ?? 'unknown',
            error: text,
          });
          await logErrorEvent(text, {
            action: stepWithNetwork.action,
            chainId: stepWithNetwork.flags.chainId ?? 'unknown',
          });
          lastErrorText = text;
          if (text.startsWith('Missing required details:')) {
            pendingStep = stepWithNetwork;
            await emitAssistantLine(humanizeMissingDetails(text));
          } else {
            pendingStep = undefined;
            await emitAssistantLine(formatActionFailureMessage(stepWithNetwork.action, text));
          }
        }
      }
    }
  } finally {
    rl.close();
  }
}

async function run(): Promise<void> {
  await runChatMode();
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  void logErrorEvent(message, { source: 'run-catch' });
  console.error(`CLI error: ${message}`);
  process.exitCode = 1;
});
