import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { ethers } from 'ethers';

import type { AppConfig, UserMode } from '../types/index.js';

const CONFIG_DIRECTORY = path.join(process.cwd(), '.noncesense');
const CONFIG_FILE_PATH = path.join(CONFIG_DIRECTORY, 'config.json');
const SECRETS_FILE_PATH = path.join(CONFIG_DIRECTORY, 'secrets.json');
const DEFAULT_USER_ID = 'default-user';

interface SecretsStore {
  userPrivateKeys: Record<string, string>;
}

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
          maxAutoApproveEth: 0,
        },
      },
    ],
    triggers: [],
    newsIntervalMs: 5 * 60 * 1000,
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

function getDefaultSecrets(): SecretsStore {
  return {
    userPrivateKeys: {},
  };
}

async function ensureSecretsExists(): Promise<void> {
  await mkdir(CONFIG_DIRECTORY, { recursive: true });
  try {
    await access(SECRETS_FILE_PATH, fsConstants.F_OK);
  } catch {
    await writeFile(SECRETS_FILE_PATH, JSON.stringify(getDefaultSecrets(), null, 2), 'utf8');
  }
}

async function loadSecrets(): Promise<SecretsStore> {
  await ensureSecretsExists();
  const raw = await readFile(SECRETS_FILE_PATH, 'utf8');
  return JSON.parse(raw) as SecretsStore;
}

async function saveSecrets(secrets: SecretsStore): Promise<void> {
  await mkdir(CONFIG_DIRECTORY, { recursive: true });
  await writeFile(SECRETS_FILE_PATH, JSON.stringify(secrets, null, 2), 'utf8');
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

export interface WalletInitializationResult {
  config: AppConfig;
  created: boolean;
  privateKey?: string;
}

export async function ensureActiveUserWallet(defaultRpcUrl: string, defaultChainId = 11155111): Promise<WalletInitializationResult> {
  const config = await loadConfig();
  const secrets = await loadSecrets();
  const activeUser = getOrCreateActiveUser(config);
  const savedKey = secrets.userPrivateKeys[activeUser.id];

  if (activeUser.wallet.address && activeUser.wallet.rpcUrl) {
    return {
      config,
      created: false,
      privateKey: savedKey,
    };
  }

  const wallet = ethers.Wallet.createRandom();
  activeUser.wallet.address = wallet.address;
  activeUser.wallet.rpcUrl = defaultRpcUrl;
  activeUser.wallet.chainId = defaultChainId;
  secrets.userPrivateKeys[activeUser.id] = wallet.privateKey;

  await saveConfig(config);
  await saveSecrets(secrets);

  return {
    config,
    created: true,
    privateKey: wallet.privateKey,
  };
}

export async function getActiveUserPrivateKey(): Promise<string | undefined> {
  const config = await loadConfig();
  const secrets = await loadSecrets();
  const activeUser = getOrCreateActiveUser(config);
  return secrets.userPrivateKeys[activeUser.id];
}

export async function saveNewsInterval(intervalMs: number): Promise<void> {
  const config = await loadConfig();
  config.newsIntervalMs = intervalMs;
  await saveConfig(config);
}

export async function saveSpendingLimit(maxAutoApproveEth: number): Promise<void> {
  const config = await loadConfig();
  const activeUser = getOrCreateActiveUser(config);
  activeUser.policy.maxAutoApproveEth = maxAutoApproveEth;
  await saveConfig(config);
}

export function getConfigPath(): string {
  return CONFIG_FILE_PATH;
}
