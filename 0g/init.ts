import { Indexer } from '@0gfoundation/0g-ts-sdk'
import { ethers } from 'ethers'

const RPC_URL = 'https://evmrpc-testnet.0g.ai'
const INDEXER_RPC = 'https://indexer-storage-testnet-turbo.0g.ai'

const provider = new ethers.JsonRpcProvider(RPC_URL)
const signer = new ethers.Wallet(process.env.PRIVATE_KEY!, provider)
const indexer = new Indexer(INDEXER_RPC)