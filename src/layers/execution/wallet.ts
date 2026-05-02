import { ethers } from 'ethers';

import type { WalletConfig } from '../../types/index.js';

export interface NativeBalanceResult {
  wei: string;
  ether: string;
}

export interface NativeTransferResult {
  transactionHash: string;
}

export interface TokenBalanceItem {
  symbol: string;
  name: string;
  contractAddress: string;
  balanceRaw: string;
  balanceFormatted: string;
  decimals: number;
}

export interface WalletPortfolio {
  native: NativeBalanceResult;
  tokens: TokenBalanceItem[];
}

function createProvider(walletConfig: WalletConfig): ethers.JsonRpcProvider {
  if (!walletConfig.rpcUrl) {
    throw new Error('Wallet RPC URL is missing. Run setup first.');
  }
  return new ethers.JsonRpcProvider(walletConfig.rpcUrl);
}

export async function getNativeBalance(walletConfig: WalletConfig): Promise<NativeBalanceResult> {
  if (!walletConfig.address) {
    throw new Error('Wallet address is missing. Run setup first.');
  }

  const provider = createProvider(walletConfig);
  const balance = await provider.getBalance(walletConfig.address);
  return {
    wei: balance.toString(),
    ether: ethers.formatEther(balance),
  };
}

export async function transferNative(
  walletConfig: WalletConfig,
  privateKey: string,
  toAddress: string,
  amountEth: string,
): Promise<NativeTransferResult> {
  if (!privateKey) {
    throw new Error('PRIVATE_KEY is missing in environment.');
  }

  const provider = createProvider(walletConfig);
  const signer = new ethers.Wallet(privateKey, provider);
  const value = ethers.parseEther(amountEth);

  const tx = await signer.sendTransaction({
    to: toAddress,
    value,
  });

  return { transactionHash: tx.hash };
}

interface AlchemyTokenBalancesResponse {
  result?: {
    tokenBalances?: Array<{
      contractAddress: string;
      tokenBalance: string;
      error?: string;
    }>;
  };
}

interface AlchemyTokenMetadataResponse {
  result?: {
    symbol?: string;
    name?: string;
    decimals?: number;
  };
}

async function callJsonRpc<TResponse>(
  endpoint: string,
  method: string,
  params: unknown[],
): Promise<TResponse> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params,
    }),
  });

  if (!response.ok) {
    throw new Error(`RPC request failed: ${response.status}`);
  }

  return (await response.json()) as TResponse;
}

export async function getWalletPortfolio(walletConfig: WalletConfig): Promise<WalletPortfolio> {
  const native = await getNativeBalance(walletConfig);
  const endpoint =
    walletConfig.chainId === 1
      ? process.env.ALCHEMY_MAINNET_ENDPOINT
      : walletConfig.chainId === 11155111
        ? process.env.ALCHEMY_SEPOLIA_ENDPOINT
        : undefined;

  if (!endpoint) {
    return { native, tokens: [] };
  }

  const tokenBalancesResponse = await callJsonRpc<AlchemyTokenBalancesResponse>(
    endpoint,
    'alchemy_getTokenBalances',
    [walletConfig.address],
  );

  const tokenBalances = tokenBalancesResponse.result?.tokenBalances ?? [];
  const nonZeroBalances = tokenBalances.filter(
    (item) => item.tokenBalance && item.tokenBalance !== '0x0' && item.tokenBalance !== '0x',
  );

  const tokens = await Promise.all(
    nonZeroBalances.map(async (item) => {
      const metadataResponse = await callJsonRpc<AlchemyTokenMetadataResponse>(
        endpoint,
        'alchemy_getTokenMetadata',
        [item.contractAddress],
      );
      const decimals = metadataResponse.result?.decimals ?? 18;
      const raw = BigInt(item.tokenBalance).toString();
      return {
        symbol: metadataResponse.result?.symbol ?? 'UNKNOWN',
        name: metadataResponse.result?.name ?? 'Unknown Token',
        contractAddress: item.contractAddress,
        balanceRaw: raw,
        balanceFormatted: ethers.formatUnits(raw, decimals),
        decimals,
      };
    }),
  );

  return { native, tokens };
}
