import { getConfigPath, loadConfig, setActiveUserMode, setActiveUserWallet } from './config/store.js';
import {
  getNativeBalance,
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
  positionals: string[];
}

const VALID_MODES: UserMode[] = [
  'recommendation-only',
  'assisted-execution',
  'limited-auto-execution',
];

function parseArgv(argv: string[]): ParsedArgs {
  const [candidateCommand, ...rest] = argv;
  const command = isCommand(candidateCommand) ? candidateCommand : undefined;
  const source = command ? rest : argv;
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  for (let index = 0; index < source.length; index += 1) {
    const token = source[index];

    if (!token.startsWith('--')) {
      positionals.push(token);
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

  return { command, flags, positionals };
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
): { ok: true; values: Record<string, string> } | { ok: false; missing: string[] } {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const key of keys) {
    const value = asStringFlag(flags, key);
    if (!value) {
      missing.push(`--${key}`);
      continue;
    }
    values[key] = value;
  }
  if (missing.length > 0) {
    return { ok: false, missing };
  }
  return { ok: true, values };
}

function printHelp(): void {
  console.log(`NonceSense CLI

Usage:
  npm run dev -- <command> [--flags]

Commands:
  help
  version
  setup --wallet <address> --rpc <url> [--chainId <number>]
  wallet-balance
  wallet-transfer --to <address> --amountEth <amount>
  swap-quote --tokenIn <address> --tokenOut <address> --amountIn <raw> [--fee <500|3000|10000>]
  swap-execute --tokenIn <address> --tokenOut <address> --amountIn <raw> [--fee <500|3000|10000>] [--slippageBps <number>]
  recommend --tokenIn <symbol> --tokenOut <symbol> --amount <rawAmount>
  execute --recommendationId <id> [--confirm true] [--amountUsd <number>]
  recent-recommendations [--limit <number>]
  trigger-eval --targetPrice <number> --currentPrice <number> --direction <above|below> --tokenIn <symbol> --tokenOut <symbol>
  workflow-smoke --tokenIn <symbol> --tokenOut <symbol> --amount <rawAmount> --targetPrice <number> --currentPrice <number>
  mode --set <recommendation-only|assisted-execution|limited-auto-execution>
`);
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

async function run(): Promise<void> {
  const parsed = parseArgv(process.argv.slice(2));
  const command = parsed.command ?? 'help';

  switch (command) {
    case 'help': {
      printHelp();
      return;
    }
    case 'version': {
      console.log('NonceSense CLI v0.1.0');
      return;
    }
    case 'setup': {
      const required = requireStringFlags(parsed.flags, ['wallet', 'rpc']);
      if (!required.ok) {
        console.error(`Missing required flags: ${required.missing.join(', ')}`);
        process.exitCode = 1;
        return;
      }
      const chainIdRaw = asStringFlag(parsed.flags, 'chainId') ?? '1';
      const chainId = Number(chainIdRaw);
      if (!Number.isInteger(chainId) || chainId <= 0) {
        console.error(`Invalid chainId: ${chainIdRaw}`);
        process.exitCode = 1;
        return;
      }
      const config = await setActiveUserWallet(required.values.wallet, required.values.rpc, chainId);
      const activeUser = config.users.find((user) => user.id === config.activeUserId);
      console.log(
        JSON.stringify(
          {
            command: 'setup',
            saved: true,
            configPath: getConfigPath(),
            activeUser,
          },
          null,
          2,
        ),
      );
      return;
    }
    case 'recommend': {
      const required = requireStringFlags(parsed.flags, ['tokenIn', 'tokenOut', 'amount']);
      if (!required.ok) {
        console.error(`Missing required flags: ${required.missing.join(', ')}`);
        process.exitCode = 1;
        return;
      }
      const config = await loadConfig();
      const activeUser = config.users.find((user) => user.id === config.activeUserId);
      const recommendation: Recommendation = {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        request: {
          tokenIn: {
            chainId: activeUser?.wallet.chainId ?? 1,
            symbol: required.values.tokenIn,
            address: asStringFlag(parsed.flags, 'tokenInAddress') ?? '',
            decimals: parseInt(asStringFlag(parsed.flags, 'tokenInDecimals') ?? '18', 10),
          },
          tokenOut: {
            chainId: activeUser?.wallet.chainId ?? 1,
            symbol: required.values.tokenOut,
            address: asStringFlag(parsed.flags, 'tokenOutAddress') ?? '',
            decimals: parseInt(asStringFlag(parsed.flags, 'tokenOutDecimals') ?? '18', 10),
          },
          amountIn: required.values.amount,
          slippageBps: parseInt(asStringFlag(parsed.flags, 'slippageBps') ?? '100', 10),
        },
        rationale: `Mode=${activeUser?.mode ?? 'recommendation-only'}; based on CLI request`,
        estimatedAmountOut: asStringFlag(parsed.flags, 'estimatedAmountOut') ?? '0',
        routeLabel: 'uniswap-v3',
        validUntil: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      };

      await addRecommendation(recommendation);
      console.log(
        JSON.stringify(
          {
            command: 'recommend',
            mode: activeUser?.mode ?? 'recommendation-only',
            memoryPath: getMemoryPath(),
            recommendation,
          },
          null,
          2,
        ),
      );
      return;
    }
    case 'execute': {
      const required = requireStringFlags(parsed.flags, ['recommendationId']);
      if (!required.ok) {
        console.error(`Missing required flags: ${required.missing.join(', ')}`);
        process.exitCode = 1;
        return;
      }
      const recommendation = await getRecommendationById(required.values.recommendationId);
      if (!recommendation) {
        console.error(`Recommendation not found: ${required.values.recommendationId}`);
        process.exitCode = 1;
        return;
      }

      const config = await loadConfig();
      const activeUser = config.users.find((user) => user.id === config.activeUserId);
      if (!activeUser) {
        console.error('Active user not found.');
        process.exitCode = 1;
        return;
      }

      await logExecutionRequested(recommendation.id);

      const amountUsdRaw = asStringFlag(parsed.flags, 'amountUsd');
      const amountUsd = amountUsdRaw ? parseNumber(amountUsdRaw, 'amountUsd') : undefined;
      const decision = evaluateExecutionPolicy({
        mode: activeUser.mode,
        policy: activeUser.policy,
        tokenInSymbol: recommendation.request.tokenIn.symbol,
        amountUsd,
        explicitConfirmation: parseBoolean(asStringFlag(parsed.flags, 'confirm')),
      });

      if (!decision.allowed) {
        await logExecutionFailed(recommendation.id, decision.reason);
        console.error(decision.reason);
        process.exitCode = 1;
        return;
      }

      const privateKey = process.env.PRIVATE_KEY ?? '';
      const fee = parsePositiveInteger(asStringFlag(parsed.flags, 'fee') ?? '3000', 'fee');
      const slippageBps = parsePositiveInteger(
        asStringFlag(parsed.flags, 'slippageBps') ?? `${recommendation.request.slippageBps}`,
        'slippageBps',
      );

      if (!recommendation.request.tokenIn.address || !recommendation.request.tokenOut.address) {
        const message =
          'Recommendation missing token addresses. Re-run recommend with --tokenInAddress and --tokenOutAddress.';
        await logExecutionFailed(recommendation.id, message);
        console.error(message);
        process.exitCode = 1;
        return;
      }

      try {
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
        console.log(
          JSON.stringify(
            {
              command: 'execute',
              recommendationId: recommendation.id,
              mode: activeUser.mode,
              policyDecision: decision,
              transactionHash: tx.transactionHash,
            },
            null,
            2,
          ),
        );
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        await logExecutionFailed(recommendation.id, message);
        console.error(message);
        process.exitCode = 1;
      }
      return;
    }
    case 'mode': {
      const mode = asStringFlag(parsed.flags, 'set');
      if (!mode) {
        console.error('Missing required flag: --set');
        process.exitCode = 1;
        return;
      }
      if (!VALID_MODES.includes(mode as UserMode)) {
        console.error(`Invalid mode: ${mode}`);
        console.error(`Valid modes: ${VALID_MODES.join(', ')}`);
        process.exitCode = 1;
        return;
      }
      const config = await setActiveUserMode(mode as UserMode);
      const activeUser = config.users.find((user) => user.id === config.activeUserId);
      console.log(
        JSON.stringify(
          {
            command: 'mode',
            saved: true,
            configPath: getConfigPath(),
            mode: activeUser?.mode,
          },
          null,
          2,
        ),
      );
      return;
    }
    case 'wallet-balance': {
      const config = await loadConfig();
      const activeUser = config.users.find((user) => user.id === config.activeUserId);
      if (!activeUser) {
        console.error('Active user not found.');
        process.exitCode = 1;
        return;
      }
      const balance = await getNativeBalance(activeUser.wallet);
      console.log(
        JSON.stringify(
          {
            command: 'wallet-balance',
            wallet: activeUser.wallet.address,
            chainId: activeUser.wallet.chainId,
            balance,
          },
          null,
          2,
        ),
      );
      return;
    }
    case 'wallet-transfer': {
      const required = requireStringFlags(parsed.flags, ['to', 'amountEth']);
      if (!required.ok) {
        console.error(`Missing required flags: ${required.missing.join(', ')}`);
        process.exitCode = 1;
        return;
      }
      const config = await loadConfig();
      const activeUser = config.users.find((user) => user.id === config.activeUserId);
      if (!activeUser) {
        console.error('Active user not found.');
        process.exitCode = 1;
        return;
      }
      const privateKey = process.env.PRIVATE_KEY ?? '';
      const tx = await transferNative(
        activeUser.wallet,
        privateKey,
        required.values.to,
        required.values.amountEth,
      );
      console.log(
        JSON.stringify(
          {
            command: 'wallet-transfer',
            from: activeUser.wallet.address,
            to: required.values.to,
            amountEth: required.values.amountEth,
            transactionHash: tx.transactionHash,
          },
          null,
          2,
        ),
      );
      return;
    }
    case 'swap-quote': {
      const required = requireStringFlags(parsed.flags, ['tokenIn', 'tokenOut', 'amountIn']);
      if (!required.ok) {
        console.error(`Missing required flags: ${required.missing.join(', ')}`);
        process.exitCode = 1;
        return;
      }
      const config = await loadConfig();
      const activeUser = config.users.find((user) => user.id === config.activeUserId);
      if (!activeUser) {
        console.error('Active user not found.');
        process.exitCode = 1;
        return;
      }
      const fee = parsePositiveInteger(asStringFlag(parsed.flags, 'fee') ?? '3000', 'fee');
      const quote = await quoteExactInputSingle({
        wallet: activeUser.wallet,
        tokenIn: required.values.tokenIn,
        tokenOut: required.values.tokenOut,
        amountIn: required.values.amountIn,
        fee,
      });
      console.log(
        JSON.stringify(
          {
            command: 'swap-quote',
            quote,
          },
          null,
          2,
        ),
      );
      return;
    }
    case 'swap-execute': {
      const required = requireStringFlags(parsed.flags, ['tokenIn', 'tokenOut', 'amountIn']);
      if (!required.ok) {
        console.error(`Missing required flags: ${required.missing.join(', ')}`);
        process.exitCode = 1;
        return;
      }
      const config = await loadConfig();
      const activeUser = config.users.find((user) => user.id === config.activeUserId);
      if (!activeUser) {
        console.error('Active user not found.');
        process.exitCode = 1;
        return;
      }
      const privateKey = process.env.PRIVATE_KEY ?? '';
      const fee = parsePositiveInteger(asStringFlag(parsed.flags, 'fee') ?? '3000', 'fee');
      const slippageBps = parsePositiveInteger(
        asStringFlag(parsed.flags, 'slippageBps') ?? '100',
        'slippageBps',
      );
      const tx = await swapExactInputSingle({
        wallet: activeUser.wallet,
        privateKey,
        tokenIn: required.values.tokenIn,
        tokenOut: required.values.tokenOut,
        amountIn: required.values.amountIn,
        fee,
        slippageBps,
      });
      console.log(
        JSON.stringify(
          {
            command: 'swap-execute',
            transactionHash: tx.transactionHash,
          },
          null,
          2,
        ),
      );
      return;
    }
    case 'recent-recommendations': {
      const limitRaw = asStringFlag(parsed.flags, 'limit') ?? '5';
      const limit = parsePositiveInteger(limitRaw, 'limit');
      const recommendations = await listRecentRecommendations(limit);
      console.log(
        JSON.stringify(
          {
            command: 'recent-recommendations',
            memoryPath: getMemoryPath(),
            recommendations,
          },
          null,
          2,
        ),
      );
      return;
    }
    case 'trigger-eval': {
      const required = requireStringFlags(parsed.flags, [
        'targetPrice',
        'currentPrice',
        'direction',
        'tokenIn',
        'tokenOut',
      ]);
      if (!required.ok) {
        console.error(`Missing required flags: ${required.missing.join(', ')}`);
        process.exitCode = 1;
        return;
      }
      const direction = required.values.direction;
      if (direction !== 'above' && direction !== 'below') {
        console.error('Invalid --direction, use above|below');
        process.exitCode = 1;
        return;
      }
      const result = evaluateTrigger({
        condition: {
          id: 'adhoc',
          label: 'ad-hoc trigger',
          enabled: true,
          tokenInSymbol: required.values.tokenIn,
          tokenOutSymbol: required.values.tokenOut,
          targetPrice: required.values.targetPrice,
          direction,
        },
        currentPrice: required.values.currentPrice,
      });
      console.log(
        JSON.stringify(
          {
            command: 'trigger-eval',
            result,
          },
          null,
          2,
        ),
      );
      return;
    }
    case 'workflow-smoke': {
      const required = requireStringFlags(parsed.flags, [
        'tokenIn',
        'tokenOut',
        'amount',
        'targetPrice',
        'currentPrice',
      ]);
      if (!required.ok) {
        console.error(`Missing required flags: ${required.missing.join(', ')}`);
        process.exitCode = 1;
        return;
      }

      const config = await loadConfig();
      const activeUser = config.users.find((user) => user.id === config.activeUserId);
      if (!activeUser) {
        console.error('Active user not found.');
        process.exitCode = 1;
        return;
      }

      const recommendation: Recommendation = {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        request: {
          tokenIn: {
            chainId: activeUser.wallet.chainId,
            symbol: required.values.tokenIn,
            address: '',
            decimals: 18,
          },
          tokenOut: {
            chainId: activeUser.wallet.chainId,
            symbol: required.values.tokenOut,
            address: '',
            decimals: 18,
          },
          amountIn: required.values.amount,
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
          tokenInSymbol: required.values.tokenIn,
          tokenOutSymbol: required.values.tokenOut,
          targetPrice: required.values.targetPrice,
          direction: 'below',
        },
        currentPrice: required.values.currentPrice,
      });

      const policyDecision = evaluateExecutionPolicy({
        mode: activeUser.mode,
        policy: activeUser.policy,
        tokenInSymbol: required.values.tokenIn,
        amountUsd: undefined,
        explicitConfirmation: true,
      });

      console.log(
        JSON.stringify(
          {
            command: 'workflow-smoke',
            mode: activeUser.mode,
            recommendationId: recommendation.id,
            triggerResult,
            policyDecision,
            memoryPath: getMemoryPath(),
          },
          null,
          2,
        ),
      );
      return;
    }
    default: {
      printHelp();
      return;
    }
  }
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`CLI error: ${message}`);
  process.exitCode = 1;
});
