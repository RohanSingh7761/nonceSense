import { ethers } from 'ethers';

import type { WalletConfig } from '../../types/index.js';

const QUOTER_V2_ABI = [
  'function quoteExactInputSingle(tuple(address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
];

const SWAP_ROUTER_ABI = [
  'function exactInputSingle(tuple(address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
];

const DEFAULT_ROUTER = '0xE592427A0AEce92De3Edee1F18E0157C05861564';
const DEFAULT_QUOTER = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e';

export interface UniswapQuoteInput {
  wallet: WalletConfig;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  fee: number;
}

export interface UniswapQuoteResult {
  amountOut: string;
}

export interface UniswapSwapInput extends UniswapQuoteInput {
  privateKey: string;
  slippageBps: number;
}

export interface UniswapSwapResult {
  transactionHash: string;
}

function getProvider(rpcUrl: string): ethers.JsonRpcProvider {
  if (!rpcUrl) {
    throw new Error('Wallet RPC URL is missing. Run setup first.');
  }
  return new ethers.JsonRpcProvider(rpcUrl);
}

function resolveAddresses(): { quoter: string; router: string } {
  return {
    quoter: process.env.UNISWAP_QUOTER_V2_ADDRESS ?? DEFAULT_QUOTER,
    router: process.env.UNISWAP_SWAP_ROUTER_ADDRESS ?? DEFAULT_ROUTER,
  };
}

export async function quoteExactInputSingle(input: UniswapQuoteInput): Promise<UniswapQuoteResult> {
  const provider = getProvider(input.wallet.rpcUrl);
  const { quoter } = resolveAddresses();

  const contract = new ethers.Contract(quoter, QUOTER_V2_ABI, provider);
  const response = await contract.quoteExactInputSingle.staticCall({
    tokenIn: input.tokenIn,
    tokenOut: input.tokenOut,
    amountIn: BigInt(input.amountIn),
    fee: input.fee,
    sqrtPriceLimitX96: 0n,
  });

  return { amountOut: response[0].toString() };
}

export async function swapExactInputSingle(input: UniswapSwapInput): Promise<UniswapSwapResult> {
  if (!input.privateKey) {
    throw new Error('PRIVATE_KEY is missing in environment.');
  }
  if (!input.wallet.address) {
    throw new Error('Wallet address is missing. Run setup first.');
  }

  const provider = getProvider(input.wallet.rpcUrl);
  const signer = new ethers.Wallet(input.privateKey, provider);
  const { router } = resolveAddresses();
  const quote = await quoteExactInputSingle(input);

  const quoteOut = BigInt(quote.amountOut);
  const slippage = BigInt(input.slippageBps);
  const amountOutMinimum = (quoteOut * (10_000n - slippage)) / 10_000n;

  const contract = new ethers.Contract(router, SWAP_ROUTER_ABI, signer);
  const tx = await contract.exactInputSingle({
    tokenIn: input.tokenIn,
    tokenOut: input.tokenOut,
    fee: input.fee,
    recipient: input.wallet.address,
    deadline: Math.floor(Date.now() / 1000) + 60 * 10,
    amountIn: BigInt(input.amountIn),
    amountOutMinimum,
    sqrtPriceLimitX96: 0,
  });

  return { transactionHash: tx.hash as string };
}
