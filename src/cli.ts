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
  transferNative,
} from './layers/execution/index.js';
import {
  addRecommendation,
  getMemoryPath,
  getRecommendationById,
  listRecentRecommendations,
  logExecutionFailed,
  logExecutionRequested,
  logExecutionSubmitted,
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

interface TokenMetadata {
  symbol: string;
  address: string;
  decimals: number;
}

function getNetworkLabel(chainId: number): string {
  if (chainId === 11155111) return 'Sepolia';
  if (chainId === 1) return 'Ethereum Mainnet';
  return `Chain ${chainId}`;
}

function getTokenDirectory(chainId: number): Record<string, TokenMetadata> {
  if (chainId === 11155111) {
    return {
      ETH: { symbol: 'WETH', address: '0xfff9976782d46cc05630d1f6ebab18b2324d6b14', decimals: 18 },
      WETH: { symbol: 'WETH', address: '0xfff9976782d46cc05630d1f6ebab18b2324d6b14', decimals: 18 },
      USDC: { symbol: 'USDC', address: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238', decimals: 6 },
    };
  }

  if (chainId === 1) {
    return {
      ETH: { symbol: 'WETH', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18 },
      WETH: { symbol: 'WETH', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18 },
      USDC: { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6 },
    };
  }

  return {};
}

function resolveToken(chainId: number, tokenInput: string, decimalsOverride?: string): TokenMetadata {
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
  if (!found) {
    throw new Error(`Unsupported token "${tokenInput}" on ${getNetworkLabel(chainId)}.`);
  }

  return found;
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
  "What is my balance?"
  "Send 0.001 ETH to 0x..."
  "Give me quote for swapping 0.007 ETH to USDC"
  "What is my balance, and if above 0.005 ETH then quote ETH to USDC"
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
  return process.env.ALCHEMY_SEPOLIA_ENDPOINT ?? '';
}

async function ensureWalletReady(): Promise<{
  created: boolean;
  walletAddress: string;
  chainId: number;
  privateKey?: string;
}> {
  const chainId = 11155111;
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

function parseTransferFromMessage(message: string): { to?: string; amountEth?: string } {
  const addressMatch = message.match(/0x[a-fA-F0-9]{40}/);
  const amountMatch = message.match(/(\d+(\.\d+)?)\s*eth\b/i);
  return {
    to: addressMatch?.[0],
    amountEth: amountMatch?.[1],
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

function missingDetailsForStep(step: ActionStep): string[] {
  if (step.action === 'wallet-transfer') {
    return ['to', 'amountEth'].filter((key) => !step.flags[key]);
  }
  if (step.action === 'swap-quote' || step.action === 'swap-execute') {
    const missing: string[] = [];
    if (!step.flags.tokenIn) missing.push('tokenIn');
    if (!step.flags.tokenOut) missing.push('tokenOut');
    if (!step.flags.amount && !step.flags.amountIn && !step.flags.amountEth) missing.push('amount');
    return missing;
  }
  if (step.action === 'mode') {
    return step.flags.set ? [] : ['mode'];
  }
  return [];
}

function enrichPendingStepFromMessage(step: ActionStep, message: string): ActionStep {
  const enriched: ActionStep = { ...step, flags: { ...step.flags } };
  if (step.action === 'wallet-transfer') {
    const extracted = parseTransferFromMessage(message);
    if (!enriched.flags.to && extracted.to) enriched.flags.to = extracted.to;
    if (!enriched.flags.amountEth && extracted.amountEth) enriched.flags.amountEth = extracted.amountEth;
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

  if (/\b(balance|portfolio|funds)\b/.test(lower)) {
    return { action: 'wallet-balance', flags: {}, reply: 'Checking your balance.' };
  }

  const quote = parseSwapDetailsFromMessage(message);
  const asksQuote = /\b(quote|price|how much)\b/.test(lower);
  const asksSwapExecute = /\b(swap|execute|trade)\b/.test(lower) && !asksQuote;
  if (quote.tokenIn && quote.tokenOut && quote.amount) {
    return {
      action: asksSwapExecute ? 'swap-execute' : 'swap-quote',
      flags: {
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
        ...(parsed.to ? { to: parsed.to } : {}),
        ...(parsed.amountEth ? { amountEth: parsed.amountEth } : {}),
      },
      reply: 'Preparing transfer.',
    };
  }

  if (asksQuote) {
    return {
      action: 'swap-quote',
      flags: {
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
  const asksNetwork =
    lower.includes('mainnet') ||
    lower.includes('sepolia') ||
    lower.includes('which network') ||
    lower.includes('what network') ||
    lower.includes('is this mainnet');

  if (!asksNetwork) {
    return undefined;
  }

  await ensureWalletReady();
  const { activeUser } = await getActiveUserFromConfig();
  return `You are on ${getNetworkLabel(activeUser.wallet.chainId)} (chain ${activeUser.wallet.chainId}).`;
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

async function buildActionSteps(message: string): Promise<{ steps: ActionStep[]; reply?: string }> {
  const conditional = parseConditionalBalanceQuote(message);
  if (conditional) {
    return {
      steps: [
        { action: 'wallet-balance', flags: {} },
        {
          action: 'swap-quote',
          flags: { tokenIn: 'ETH', tokenOut: conditional.tokenOut },
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

      const plannedSub = await planFromUserMessage(request);
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

  const planned = await planFromUserMessage(message);
  if (planned.action === 'none' || !EXECUTABLE_ACTIONS.includes(planned.action)) {
    return { steps: [], reply: planned.reply };
  }
  return {
    steps: [{ action: planned.action, flags: planned.flags }],
  };
}

async function planFromUserMessage(userMessage: string): Promise<ActionPlan> {
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
- For transfers, extract recipient address and ETH amount from natural language.
- For swap quotes, extract amount + token pair from natural language (example: "0.007 eth with usdc").
- If required values are missing, keep action as best guess and include missing details in reply.
- Never invent addresses/private keys.
- Keep flags string-to-string.

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
      await ensureWalletReady();
      const { activeUser } = await getActiveUserFromConfig();
      const nativeBalance = await getNativeBalance(activeUser.wallet);
      const portfolio = await getWalletPortfolio(activeUser.wallet);
      return {
        command: 'wallet-balance',
        wallet: activeUser.wallet.address,
        chainId: activeUser.wallet.chainId,
        nativeBalance,
        portfolio,
      };
    }
    case 'wallet-transfer': {
      const values = requireStringFlags(flags, ['to', 'amountEth']);
      await ensureWalletReady();
      const { activeUser } = await getActiveUserFromConfig();
      const privateKey = (await getActiveUserPrivateKey()) ?? process.env.PRIVATE_KEY ?? '';
      const tx = await transferNative(activeUser.wallet, privateKey, values.to, values.amountEth);
      return {
        command: 'wallet-transfer',
        from: activeUser.wallet.address,
        to: values.to,
        amountEth: values.amountEth,
        transactionHash: tx.transactionHash,
      };
    }
    case 'swap-quote': {
      await ensureWalletReady();
      const { activeUser } = await getActiveUserFromConfig();
      const tokenInInput = asStringFlag(flags, 'tokenIn');
      const tokenOutInput = asStringFlag(flags, 'tokenOut');
      if (!tokenInInput || !tokenOutInput) {
        throw new Error('Missing required details: tokenIn, tokenOut');
      }

      const tokenIn = resolveToken(
        activeUser.wallet.chainId,
        tokenInInput,
        asStringFlag(flags, 'tokenInDecimals'),
      );
      const tokenOut = resolveToken(
        activeUser.wallet.chainId,
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
        wallet: activeUser.wallet,
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
      await ensureWalletReady();
      const { activeUser } = await getActiveUserFromConfig();
      const tokenInInput = asStringFlag(flags, 'tokenIn');
      const tokenOutInput = asStringFlag(flags, 'tokenOut');
      if (!tokenInInput || !tokenOutInput) {
        throw new Error('Missing required details: tokenIn, tokenOut');
      }
      const tokenIn = resolveToken(
        activeUser.wallet.chainId,
        tokenInInput,
        asStringFlag(flags, 'tokenInDecimals'),
      );
      const tokenOut = resolveToken(
        activeUser.wallet.chainId,
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
        wallet: activeUser.wallet,
        privateKey,
        tokenIn: tokenIn.address,
        tokenOut: tokenOut.address,
        amountIn: amountRaw,
        fee,
        slippageBps,
        useNativeIn: tokenInInput.toUpperCase() === 'ETH',
      });
      return { command: 'swap-execute', transactionHash: tx.transactionHash };
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

function printChatFriendlyResult(action: CommandName, result: unknown): void {
  if (action === 'setup') {
    const payload = result as {
      walletAddress: string;
      chainId: number;
      privateKey?: string;
      autoCreated?: boolean;
      note?: string;
    };
    if (payload.autoCreated) {
      console.log('Assistant: I created your wallet.');
      console.log(`Assistant: Address: ${payload.walletAddress}`);
      if (payload.privateKey) {
        console.log(`Assistant: Private key: ${payload.privateKey}`);
      }
      if (payload.note) {
        console.log(`Assistant: ${payload.note}`);
      }
      return;
    }
    console.log('Assistant: Wallet setup updated.');
    return;
  }

  if (action === 'mode') {
    const payload = result as { mode?: string };
    console.log(`Assistant: Mode set to ${payload.mode ?? 'unknown'}.`);
    return;
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
    console.log(`Assistant: Wallet ${payload.wallet} on ${getNetworkLabel(payload.chainId)} (chain ${payload.chainId})`);
    console.log(`Assistant: Native balance: ${payload.portfolio.native.ether}`);
    if (payload.portfolio.tokens.length === 0) {
      console.log('Assistant: No ERC-20 token balances found via Alchemy.');
      return;
    }
    console.log('Assistant: Token balances:');
    for (const token of payload.portfolio.tokens) {
      console.log(`- ${token.symbol}: ${token.balanceFormatted} (${token.contractAddress})`);
    }
    return;
  }

  if (action === 'swap-quote') {
    const payload = result as {
      tokenIn: { symbol: string };
      tokenOut: { symbol: string };
      amountInFormatted: string;
      amountOutFormatted: string;
    };
    console.log(
      `Assistant: Uniswap V3 quote — ${payload.amountInFormatted} ${payload.tokenIn.symbol} -> ${payload.amountOutFormatted} ${payload.tokenOut.symbol}`,
    );
    return;
  }

  if (action === 'swap-execute') {
    const payload = result as { transactionHash?: string };
    if (payload.transactionHash) {
      console.log(`Assistant: Swap submitted on Uniswap. Tx hash: ${payload.transactionHash}`);
      return;
    }
  }

  console.log(`Assistant: ${JSON.stringify(result, null, 2)}`);
}

async function runChatMode(): Promise<void> {
  console.log('NonceSense chat mode started. Ask naturally (type "exit" to quit).');
  const initialized = await ensureWalletReady();
  if (initialized.created) {
    console.log('Assistant: I created a new wallet for you (first-time setup).');
    console.log(`Assistant: Address: ${initialized.walletAddress}`);
    if (initialized.privateKey) {
      console.log(`Assistant: Private key: ${initialized.privateKey}`);
      console.log('Assistant: Save this private key securely. It is stored locally for chat execution.');
    }
  }
  const rl = createInterface({ input, output });
  let lastErrorText: string | undefined;
  let pendingStep: ActionStep | undefined;
  try {
    while (true) {
      const message = (await rl.question('You: ')).trim();
      if (!message) {
        continue;
      }
      if (message.toLowerCase() === 'exit' || message.toLowerCase() === 'quit') {
        break;
      }

      if (shouldExplainLastError(message) && lastErrorText) {
        console.log(`Assistant: ${explainError(lastErrorText)}`);
        continue;
      }

      if (pendingStep) {
        const enriched = enrichPendingStepFromMessage(pendingStep, message);
        const missing = missingDetailsForStep(enriched);
        if (missing.length === 0) {
          try {
            const result = await executeCommand(enriched.action, enriched.flags);
            lastErrorText = undefined;
            pendingStep = undefined;
            printChatFriendlyResult(enriched.action, result);
            continue;
          } catch (error: unknown) {
            const text = error instanceof Error ? error.message : String(error);
            lastErrorText = text;
            pendingStep = undefined;
            if (text.startsWith('Missing required details:')) {
              console.log(`Assistant: ${humanizeMissingDetails(text)}`);
            } else {
              console.log(`Assistant: ${text}`);
            }
            continue;
          }
        }
        pendingStep = enriched;
      }

      const directAnswer = await directNetworkAnswer(message);
      if (directAnswer) {
        console.log(`Assistant: ${directAnswer}`);
        continue;
      }

      let built: { steps: ActionStep[]; reply?: string };
      try {
        built = await buildActionSteps(message);
      } catch (error: unknown) {
        const text = error instanceof Error ? error.message : String(error);
        console.log(`Assistant: I could not parse that yet (${text}). Try rephrasing.`);
        continue;
      }

      if (built.steps.length === 0) {
        console.log(`Assistant: ${built.reply ?? 'Got it.'}`);
        continue;
      }

      let currentNativeBalanceEth: string | undefined;
      for (const step of built.steps) {
        if (step.action === 'wallet-transfer') {
          const extracted = parseTransferFromMessage(message);
          if (!step.flags.to && extracted.to) {
            step.flags.to = extracted.to;
          }
          if (!step.flags.amountEth && extracted.amountEth) {
            step.flags.amountEth = extracted.amountEth;
          }
        }

        if (step.useCurrentNativeBalanceAsAmount && currentNativeBalanceEth) {
          step.flags.amount = currentNativeBalanceEth;
        }

        if (step.minNativeBalanceEth && currentNativeBalanceEth) {
          const current = Number(currentNativeBalanceEth);
          const threshold = Number(step.minNativeBalanceEth);
          if (Number.isFinite(current) && Number.isFinite(threshold) && current <= threshold) {
            console.log(
              `Assistant: Skipping quote because balance ${currentNativeBalanceEth} ETH is not above ${step.minNativeBalanceEth} ETH.`,
            );
            continue;
          }
        }

        try {
          const result = await executeCommand(step.action, step.flags);
          lastErrorText = undefined;
          pendingStep = undefined;
          printChatFriendlyResult(step.action, result);

          if (step.action === 'wallet-balance') {
            const payload = result as { portfolio: { native: { ether: string } } };
            currentNativeBalanceEth = payload.portfolio.native.ether;
          }
        } catch (error: unknown) {
          const text = error instanceof Error ? error.message : String(error);
          lastErrorText = text;
          if (text.startsWith('Missing required details:')) {
            pendingStep = step;
            console.log(`Assistant: ${humanizeMissingDetails(text)}`);
          } else {
            pendingStep = undefined;
            console.log(`Assistant: ${text}`);
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
  console.error(`CLI error: ${message}`);
  process.exitCode = 1;
});
