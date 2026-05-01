import { ethers } from 'ethers';

import type { WalletConfig } from '../../types/index.js';

const QUOTER_V2_ABI = [
  'function quoteExactInputSingle(tuple(address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
];

const SWAP_ROUTER_ABI = [
  'function exactInputSingle(tuple(address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
];

const FACTORY_ABI = [
  'function getPool(address tokenA,address tokenB,uint24 fee) external view returns (address)',
];

const WETH_ABI = [
  'function deposit() payable',
  'function approve(address spender,uint256 value) returns (bool)',
  'function allowance(address owner,address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
];

const DEFAULT_ROUTER = '0xE592427A0AEce92De3Edee1F18E0157C05861564';
const DEFAULT_QUOTER = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e';
const SEPOLIA_ROUTER = '0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E';
const SEPOLIA_QUOTER = '0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3';
const MAINNET_FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
const SEPOLIA_FACTORY = '0x0227628f3F023bb0B980b67D528571c95c6DaC1c';

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
  useNativeIn?: boolean;
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

function resolveAddresses(chainId: number): { quoter: string; router: string; factory: string } {
  const defaultByChain =
    chainId === 11155111
      ? {
          quoter: SEPOLIA_QUOTER,
          router: SEPOLIA_ROUTER,
          factory: SEPOLIA_FACTORY,
        }
      : {
          quoter: DEFAULT_QUOTER,
          router: DEFAULT_ROUTER,
          factory: MAINNET_FACTORY,
        };

  return {
    quoter: process.env.UNISWAP_QUOTER_V2_ADDRESS ?? defaultByChain.quoter,
    router: process.env.UNISWAP_SWAP_ROUTER_ADDRESS ?? defaultByChain.router,
    factory: process.env.UNISWAP_V3_FACTORY_ADDRESS ?? defaultByChain.factory,
  };
}

export async function quoteExactInputSingle(input: UniswapQuoteInput): Promise<UniswapQuoteResult> {
  const provider = getProvider(input.wallet.rpcUrl);
  const { quoter, factory } = resolveAddresses(input.wallet.chainId);

  const factoryContract = new ethers.Contract(factory, FACTORY_ABI, provider);
  const poolAddress = await factoryContract.getPool(input.tokenIn, input.tokenOut, input.fee);
  if (!poolAddress || poolAddress === ethers.ZeroAddress) {
    throw new Error(
      `No Uniswap V3 pool found for this pair/fee on chain ${input.wallet.chainId}. Try another fee tier (500, 3000, 10000) or another token pair.`,
    );
  }

  const contract = new ethers.Contract(quoter, QUOTER_V2_ABI, provider);
  let response: unknown;
  try {
    response = await contract.quoteExactInputSingle.staticCall({
      tokenIn: input.tokenIn,
      tokenOut: input.tokenOut,
      amountIn: BigInt(input.amountIn),
      fee: input.fee,
      sqrtPriceLimitX96: 0n,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('could not decode result data') || message.includes('BAD_DATA')) {
      throw new Error(
        `Quote failed from quoter contract on chain ${input.wallet.chainId}. This usually means wrong quoter address for network, no route at this fee, or stale RPC data.`,
      );
    }
    throw error;
  }

  const amountOut =
    Array.isArray(response) && response.length > 0
      ? response[0]
      : (response as { amountOut?: bigint }).amountOut;

  if (amountOut === undefined || amountOut === null) {
    throw new Error('Quote returned empty result.');
  }

  return { amountOut: amountOut.toString() };
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
  const { router } = resolveAddresses(input.wallet.chainId);
  const quote = await quoteExactInputSingle(input);

  const quoteOut = BigInt(quote.amountOut);
  const slippage = BigInt(input.slippageBps);
  const amountOutMinimum = (quoteOut * (10_000n - slippage)) / 10_000n;

  if (input.useNativeIn) {
    const weth = new ethers.Contract(input.tokenIn, WETH_ABI, signer);
    const owner = await signer.getAddress();
    const amountIn = BigInt(input.amountIn);

    const wethBalance = (await weth.balanceOf(owner)) as bigint;
    if (wethBalance < amountIn) {
      const wrapValue = amountIn - wethBalance;
      const wrapTx = await weth.deposit({ value: wrapValue });
      await wrapTx.wait();
    }

    const allowance = (await weth.allowance(owner, router)) as bigint;
    if (allowance < amountIn) {
      const approveTx = await weth.approve(router, ethers.MaxUint256);
      await approveTx.wait();
    }
  }

  const contract = new ethers.Contract(router, SWAP_ROUTER_ABI, signer);
  const params = {
    tokenIn: input.tokenIn,
    tokenOut: input.tokenOut,
    fee: input.fee,
    recipient: input.wallet.address,
    deadline: Math.floor(Date.now() / 1000) + 60 * 10,
    amountIn: BigInt(input.amountIn),
    amountOutMinimum,
    sqrtPriceLimitX96: 0,
  };

  const tx = await contract.exactInputSingle(params);

  return { transactionHash: tx.hash as string };
}
