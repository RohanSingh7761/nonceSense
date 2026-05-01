import { ethers } from 'ethers';

import type { WalletConfig } from '../../types/index.js';

export interface NativeBalanceResult {
  wei: string;
  ether: string;
}

export interface NativeTransferResult {
  transactionHash: string;
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
