import 'dotenv/config';

import { GoogleGenAI } from '@google/genai';
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

interface ParsedArgs {
  command?: CommandName;
  flags: Record<string, string | boolean>;
}

interface ActionPlan {
  action: CommandName | 'none';
  flags: Record<string, string>;
  reply: string;
}

function getNetworkLabel(chainId: number): string {
  if (chainId === 11155111) return 'Sepolia';
  if (chainId === 1) return 'Ethereum Mainnet';
  return `Chain ${chainId}`;
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

function parseArgv(argv: string[]): ParsedArgs {
  const [candidateCommand, ...rest] = argv;
  const command = isCommand(candidateCommand) ? candidateCommand : undefined;
  const source = command ? rest : argv;
  const flags: Record<string, string | boolean> = {};

  for (let index = 0; index < source.length; index += 1) {
    const token = source[index];
    if (!token.startsWith('--')) {
      continue;
    }
    const withoutPrefix = token.slice(2);
    const separatorIndex = withoutPrefix.indexOf('=');
    if (separatorIndex >= 0) {
      const key = withoutPrefix.slice(0, separatorIndex);
      const value = withoutPrefix.slice(separatorIndex + 1);
      flags[key] = value;
      continue;
    }
    const nextToken = source[index + 1];
    if (nextToken && !nextToken.startsWith('--')) {
      flags[withoutPrefix] = nextToken;
      index += 1;
      continue;
    }
    flags[withoutPrefix] = true;
  }

  return { command, flags };
}

function isCommand(value: string | undefined): value is CommandName {
  return (
    value === 'help' ||
    value === 'setup' ||
    value === 'recommend' ||
    value === 'execute' ||
    value === 'mode' ||
    value === 'wallet-balance' ||
    value === 'wallet-transfer' ||
    value === 'swap-quote' ||
    value === 'swap-execute' ||
    value === 'recent-recommendations' ||
    value === 'trigger-eval' ||
    value === 'workflow-smoke' ||
    value === 'version'
  );
}

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

function printHelp(): void {
  console.log(`NonceSense CLI

Usage:
  npm run dev                      # chat mode

Commands:
  help
  version
  setup (chat can auto-create wallet)
  wallet-balance
  wallet-transfer --to <address> --amountEth <amount>
  swap-quote --tokenIn <address> --tokenOut <address> --amountIn <raw> [--fee <500|3000|10000>]
  swap-execute --tokenIn <address> --tokenOut <address> --amountIn <raw> [--fee <500|3000|10000>] [--slippageBps <number>]
  recommend --tokenIn <symbol> --tokenOut <symbol> --amount <rawAmount>
  execute --recommendationId <id> [--confirm true] [--amountUsd <number>]
  recent-recommendations [--limit <number>]
  trigger-eval --targetPrice <number> --currentPrice <number> --direction <above|below> --tokenIn <symbol> --tokenOut <symbol>
  workflow-smoke --tokenIn <symbol> --tokenOut <symbol> --amount <rawAmount> --targetPrice <number> --currentPrice <number>
  mode --set <recommendation-only|assisted-execution|limited-auto-execution> (chat can infer)
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

function heuristicPlan(message: string): ActionPlan | undefined {
  const lower = message.toLowerCase();

  if (/\b(balance|portfolio|funds)\b/.test(lower)) {
    return { action: 'wallet-balance', flags: {}, reply: 'Checking your balance.' };
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
  const prompt = `You are a router for a crypto CLI. Convert user chat into one command action.

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
      const values = requireStringFlags(flags, ['tokenIn', 'tokenOut', 'amountIn']);
      await ensureWalletReady();
      const { activeUser } = await getActiveUserFromConfig();
      const fee = parsePositiveInteger(asStringFlag(flags, 'fee') ?? '3000', 'fee');
      const quote = await quoteExactInputSingle({
        wallet: activeUser.wallet,
        tokenIn: values.tokenIn,
        tokenOut: values.tokenOut,
        amountIn: values.amountIn,
        fee,
      });
      return { command: 'swap-quote', quote };
    }
    case 'swap-execute': {
      const values = requireStringFlags(flags, ['tokenIn', 'tokenOut', 'amountIn']);
      await ensureWalletReady();
      const { activeUser } = await getActiveUserFromConfig();
      const privateKey = (await getActiveUserPrivateKey()) ?? process.env.PRIVATE_KEY ?? '';
      const fee = parsePositiveInteger(asStringFlag(flags, 'fee') ?? '3000', 'fee');
      const slippageBps = parsePositiveInteger(
        asStringFlag(flags, 'slippageBps') ?? '100',
        'slippageBps',
      );
      const tx = await swapExactInputSingle({
        wallet: activeUser.wallet,
        privateKey,
        tokenIn: values.tokenIn,
        tokenOut: values.tokenOut,
        amountIn: values.amountIn,
        fee,
        slippageBps,
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
  try {
    while (true) {
      const message = (await rl.question('You: ')).trim();
      if (!message) {
        continue;
      }
      if (message.toLowerCase() === 'exit' || message.toLowerCase() === 'quit') {
        break;
      }

      const directAnswer = await directNetworkAnswer(message);
      if (directAnswer) {
        console.log(`Assistant: ${directAnswer}`);
        continue;
      }

      let plan: ActionPlan | undefined = heuristicPlan(message);
      if (!plan) {
        try {
          plan = await planFromUserMessage(message);
        } catch (error: unknown) {
          const text = error instanceof Error ? error.message : String(error);
          console.log(`Assistant: I could not parse that yet (${text}). Try rephrasing.`);
          continue;
        }
      }

      if (plan.action === 'wallet-transfer') {
        const extracted = parseTransferFromMessage(message);
        if (!plan.flags.to && extracted.to) {
          plan.flags.to = extracted.to;
        }
        if (!plan.flags.amountEth && extracted.amountEth) {
          plan.flags.amountEth = extracted.amountEth;
        }
      }

      if (plan.action === 'none' || !EXECUTABLE_ACTIONS.includes(plan.action)) {
        console.log(`Assistant: ${plan.reply}`);
        continue;
      }

      try {
        const result = await executeCommand(plan.action, plan.flags);
        printChatFriendlyResult(plan.action, result);
      } catch (error: unknown) {
        const text = error instanceof Error ? error.message : String(error);
        if (text.startsWith('Missing required details:')) {
          console.log(`Assistant: ${text.replace('Missing required details:', 'I need these details:')}`);
        } else {
          console.log(`Assistant: ${text}`);
        }
      }
    }
  } finally {
    rl.close();
  }
}

async function run(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    await runChatMode();
    return;
  }

  const parsed = parseArgv(argv);
  const command = parsed.command ?? 'help';
  const result = await executeCommand(command, parsed.flags);
  if (command !== 'help') {
    console.log(JSON.stringify(result, null, 2));
  }
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`CLI error: ${message}`);
  process.exitCode = 1;
});
