import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';

import type { AppConfig, UserMode } from '../types/index.js';

const CONFIG_DIRECTORY = path.join(process.cwd(), '.noncesense');
const CONFIG_FILE_PATH = path.join(CONFIG_DIRECTORY, 'config.json');
const DEFAULT_USER_ID = 'default-user';

function getDefaultConfig(): AppConfig {
  return {
    activeUserId: DEFAULT_USER_ID,
    users: [
      {
        id: DEFAULT_USER_ID,
        label: 'Default User',
        mode: 'recommendation-only',
        wallet: {
          address: '',
          rpcUrl: '',
          chainId: 1,
        },
        policy: {
          maxSingleSwapUsd: 1000,
          maxDailySwapUsd: 2500,
          blockedTokens: [],
          allowedProtocols: ['uniswap'],
          requireUserConfirmationAboveUsd: 100,
        },
      },
    ],
    triggers: [],
  };
}

async function ensureConfigExists(): Promise<void> {
  await mkdir(CONFIG_DIRECTORY, { recursive: true });

  try {
    await access(CONFIG_FILE_PATH, fsConstants.F_OK);
  } catch {
    const defaultConfig = getDefaultConfig();
    await writeFile(CONFIG_FILE_PATH, JSON.stringify(defaultConfig, null, 2), 'utf8');
  }
}

export async function loadConfig(): Promise<AppConfig> {
  await ensureConfigExists();
  const raw = await readFile(CONFIG_FILE_PATH, 'utf8');
  return JSON.parse(raw) as AppConfig;
}

export async function saveConfig(config: AppConfig): Promise<void> {
  await mkdir(CONFIG_DIRECTORY, { recursive: true });
  await writeFile(CONFIG_FILE_PATH, JSON.stringify(config, null, 2), 'utf8');
}

function getOrCreateActiveUser(config: AppConfig): AppConfig['users'][number] {
  const active = config.users.find((user) => user.id === config.activeUserId);
  if (active) {
    return active;
  }
  const fallback = getDefaultConfig().users[0];
  config.activeUserId = fallback.id;
  config.users.push(fallback);
  return fallback;
}

export async function setActiveUserWallet(walletAddress: string, rpcUrl: string, chainId: number): Promise<AppConfig> {
  const config = await loadConfig();
  const activeUser = getOrCreateActiveUser(config);
  activeUser.wallet.address = walletAddress;
  activeUser.wallet.rpcUrl = rpcUrl;
  activeUser.wallet.chainId = chainId;
  await saveConfig(config);
  return config;
}

export async function setActiveUserMode(mode: UserMode): Promise<AppConfig> {
  const config = await loadConfig();
  const activeUser = getOrCreateActiveUser(config);
  activeUser.mode = mode;
  await saveConfig(config);
  return config;
}

export function getConfigPath(): string {
  return CONFIG_FILE_PATH;
}
