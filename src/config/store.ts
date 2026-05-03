import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ethers } from 'ethers';

import type { AppConfig, UserMode } from '../types/index.js';

const CONFIG_DIRECTORY = path.join(process.cwd(), '.noncesense');
const CONFIG_FILE_PATH = path.join(CONFIG_DIRECTORY, 'config.json');
const SECRETS_FILE_PATH = path.join(CONFIG_DIRECTORY, 'secrets.json');
const USER_PROFILE_FILE_PATH = path.join(CONFIG_DIRECTORY, 'user-profile.txt');
const DEFAULT_USER_ID = 'default-user';

interface SecretsStore {
  userPrivateKeys: Record<string, string | EncryptedSecret>;
}

interface EncryptedSecret {
  kdf: 'scrypt';
  cipher: 'aes-256-gcm';
  saltB64: string;
  ivB64: string;
  tagB64: string;
  ciphertextB64: string;
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

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.scryptSync(passphrase, salt, 32);
}

function encryptSecret(plaintext: string, passphrase: string): EncryptedSecret {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    kdf: 'scrypt',
    cipher: 'aes-256-gcm',
    saltB64: salt.toString('base64'),
    ivB64: iv.toString('base64'),
    tagB64: tag.toString('base64'),
    ciphertextB64: ciphertext.toString('base64'),
  };
}

function decryptSecret(secret: EncryptedSecret, passphrase: string): string {
  const salt = Buffer.from(secret.saltB64, 'base64');
  const iv = Buffer.from(secret.ivB64, 'base64');
  const tag = Buffer.from(secret.tagB64, 'base64');
  const ciphertext = Buffer.from(secret.ciphertextB64, 'base64');
  const key = deriveKey(passphrase, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
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
  mnemonicPhrase?: string;
}

export async function ensureActiveUserWallet(
  defaultRpcUrl: string,
  defaultChainId = 11155111,
  opts?: { encryptWithPassphrase?: string },
): Promise<WalletInitializationResult> {
  const config = await loadConfig();
  const secrets = await loadSecrets();
  const activeUser = getOrCreateActiveUser(config);
  const savedKey = secrets.userPrivateKeys[activeUser.id];

  if (activeUser.wallet.address && activeUser.wallet.rpcUrl) {
    return {
      config,
      created: false,
      privateKey: typeof savedKey === 'string' ? savedKey : undefined,
    };
  }

  if (!opts?.encryptWithPassphrase) {
    throw new Error(
      'Wallet creation requires an encryption passphrase (missing encryptWithPassphrase).',
    );
  }

  const wallet = ethers.Wallet.createRandom();
  activeUser.wallet.address = wallet.address;
  activeUser.wallet.rpcUrl = defaultRpcUrl;
  activeUser.wallet.chainId = defaultChainId;
  secrets.userPrivateKeys[activeUser.id] = encryptSecret(wallet.privateKey, opts.encryptWithPassphrase);

  await saveConfig(config);
  await saveSecrets(secrets);

  return {
    config,
    created: true,
    privateKey: wallet.privateKey,
    mnemonicPhrase: wallet.mnemonic?.phrase,
  };
}

export async function getActiveUserPrivateKey(): Promise<string | undefined> {
  const config = await loadConfig();
  const secrets = await loadSecrets();
  const activeUser = getOrCreateActiveUser(config);
  const stored = secrets.userPrivateKeys[activeUser.id];
  return typeof stored === 'string' ? stored : undefined;
}

export async function isActiveUserPrivateKeyEncrypted(): Promise<boolean> {
  const config = await loadConfig();
  const secrets = await loadSecrets();
  const activeUser = getOrCreateActiveUser(config);
  const stored = secrets.userPrivateKeys[activeUser.id];
  return typeof stored === 'object' && stored !== null;
}

export async function migrateActiveUserPrivateKeyToEncrypted(passphrase: string): Promise<boolean> {
  const config = await loadConfig();
  const secrets = await loadSecrets();
  const activeUser = getOrCreateActiveUser(config);
  const stored = secrets.userPrivateKeys[activeUser.id];
  if (!stored || typeof stored !== 'string') {
    return false;
  }
  secrets.userPrivateKeys[activeUser.id] = encryptSecret(stored, passphrase);
  await saveSecrets(secrets);
  return true;
}

export async function decryptActiveUserPrivateKey(passphrase: string): Promise<string> {
  const config = await loadConfig();
  const secrets = await loadSecrets();
  const activeUser = getOrCreateActiveUser(config);
  const stored = secrets.userPrivateKeys[activeUser.id];
  if (!stored) {
    throw new Error('No private key found for active user.');
  }
  if (typeof stored === 'string') {
    // Legacy plaintext or external override.
    return stored;
  }
  if (stored.kdf !== 'scrypt' || stored.cipher !== 'aes-256-gcm') {
    throw new Error('Unsupported secret format.');
  }
  return decryptSecret(stored, passphrase);
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

export async function saveHabitsThreshold(thresholdInputs: number): Promise<void> {
  const config = await loadConfig();
  config.habitsThresholdInputs = thresholdInputs;
  await saveConfig(config);
}

export async function saveUserProfile(text: string): Promise<void> {
  await mkdir(CONFIG_DIRECTORY, { recursive: true });
  await writeFile(USER_PROFILE_FILE_PATH, text, 'utf8');
}

export async function loadUserProfile(): Promise<string | undefined> {
  try {
    const raw = await readFile(USER_PROFILE_FILE_PATH, 'utf8');
    const trimmed = raw.trim();
    return trimmed.length > 0 ? raw : undefined;
  } catch {
    return undefined;
  }
}

export async function hasUserProfile(): Promise<boolean> {
  try {
    await access(USER_PROFILE_FILE_PATH, fsConstants.F_OK);
    const raw = await readFile(USER_PROFILE_FILE_PATH, 'utf8');
    return raw.trim().length > 0;
  } catch {
    return false;
  }
}

export function getUserProfilePath(): string {
  return USER_PROFILE_FILE_PATH;
}

export function getConfigPath(): string {
  return CONFIG_FILE_PATH;
}
