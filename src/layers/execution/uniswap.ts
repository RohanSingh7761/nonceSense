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

const POOL_ABI = [
  'function liquidity() external view returns (uint128)',
];

const ERC20_ABI = [
  'function approve(address spender,uint256 value) returns (bool)',
  'function allowance(address owner,address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
];

const WETH_ABI = [
  'function deposit() payable',
  ...ERC20_ABI,
];

const DEFAULT_ROUTER = '0xE592427A0AEce92De3Edee1F18E0157C05861564';
const DEFAULT_QUOTER = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e';

const SEPOLIA_ROUTER = '0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E';
const SEPOLIA_QUOTER = '0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3';
const SEPOLIA_FACTORY = '0x0227628f3F023bb0B980b67D528571c95c6DaC1c';

const MAINNET_FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984';

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

function resolveAddresses(chainId: number): {
  quoter: string;
  router: string;
  factory: string;
} {
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

async function getPoolAddress(
  provider: ethers.JsonRpcProvider,
  chainId: number,
  tokenIn: string,
  tokenOut: string,
  fee: number,
): Promise<string> {
  const { factory } = resolveAddresses(chainId);
  const factoryContract = new ethers.Contract(factory, FACTORY_ABI, provider);

  const poolAddress = await factoryContract.getPool(tokenIn, tokenOut, fee);
  if (!poolAddress || poolAddress === ethers.ZeroAddress) {
    throw new Error(
      `No Uniswap V3 pool found for this pair/fee on chain ${chainId}. Try fee tiers 500, 3000, 10000.`,
    );
  }

  return poolAddress;
}

async function assertPoolHasLiquidity(
  provider: ethers.JsonRpcProvider,
  poolAddress: string,
): Promise<void> {
  const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
  const liquidity = (await pool.liquidity()) as bigint;

  if (liquidity === 0n) {
    throw new Error('Pool exists but has zero liquidity.');
  }
}

async function ensureApproved(
  tokenAddress: string,
  owner: string,
  spender: string,
  amount: bigint,
  signer: ethers.Wallet,
): Promise<void> {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
  const allowance = (await token.allowance(owner, spender)) as bigint;

  if (allowance < amount) {
    const approveTx = await token.approve(spender, ethers.MaxUint256);
    await approveTx.wait();
  }
}

async function ensureWrappedIfNeeded(
  tokenAddress: string,
  owner: string,
  amount: bigint,
  signer: ethers.Wallet,
): Promise<void> {
  const weth = new ethers.Contract(tokenAddress, WETH_ABI, signer);
  const balance = (await weth.balanceOf(owner)) as bigint;

  if (balance < amount) {
    const wrapAmount = amount - balance;
    const wrapTx = await weth.deposit({ value: wrapAmount });
    await wrapTx.wait();
  }
}

export async function quoteExactInputSingle(
  input: UniswapQuoteInput,
): Promise<UniswapQuoteResult> {
  const provider = getProvider(input.wallet.rpcUrl);

  const poolAddress = await getPoolAddress(
    provider,
    input.wallet.chainId,
    input.tokenIn,
    input.tokenOut,
    input.fee,
  );

  await assertPoolHasLiquidity(provider, poolAddress);

  const { quoter } = resolveAddresses(input.wallet.chainId);
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

    if (
      message.includes('could not decode result data') ||
      message.includes('BAD_DATA')
    ) {
      throw new Error(
        `Quote failed from quoter on chain ${input.wallet.chainId}. Wrong quoter, stale RPC, or unusable route.`,
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

export async function swapExactInputSingle(
  input: UniswapSwapInput,
): Promise<UniswapSwapResult> {
  if (!input.privateKey) {
    throw new Error('PRIVATE_KEY is missing in environment.');
  }

  if (!input.wallet.address) {
    throw new Error('Wallet address is missing. Run setup first.');
  }

  const provider = getProvider(input.wallet.rpcUrl);
  const signer = new ethers.Wallet(input.privateKey, provider);
  const owner = await signer.getAddress();

  const { router } = resolveAddresses(input.wallet.chainId);
  const amountIn = BigInt(input.amountIn);

  const poolAddress = await getPoolAddress(
    provider,
    input.wallet.chainId,
    input.tokenIn,
    input.tokenOut,
    input.fee,
  );

  await assertPoolHasLiquidity(provider, poolAddress);

  const quote = await quoteExactInputSingle(input);
  const quoteOut = BigInt(quote.amountOut);

  // For Sepolia debugging, allow turning this off if liquidity is unstable.
  const amountOutMinimum =
    input.wallet.chainId === 11155111
      ? 0n
      : (quoteOut * (10_000n - BigInt(input.slippageBps))) / 10_000n;

  if (input.useNativeIn) {
    await ensureWrappedIfNeeded(input.tokenIn, owner, amountIn, signer);
  }

  await ensureApproved(input.tokenIn, owner, router, amountIn, signer);

  const contract = new ethers.Contract(router, SWAP_ROUTER_ABI, signer);

  const params = {
    tokenIn: input.tokenIn,
    tokenOut: input.tokenOut,
    fee: input.fee,
    recipient: input.wallet.address,
    deadline: Math.floor(Date.now() / 1000) + 60 * 10,
    amountIn,
    amountOutMinimum,
    sqrtPriceLimitX96: 0,
  };

  // Simulate before sending. If this fails, route exists but execution is invalid.
  try {
    await contract.exactInputSingle.staticCall(params);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Swap simulation failed before execution: ${message}`);
  }

  const tx = await contract.exactInputSingle(params);
  await tx.wait();

  return { transactionHash: tx.hash as string };
}