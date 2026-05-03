# 🪙 NonceSense: Your On-Chain AI Twin

[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)
[![Powered by 0G](https://img.shields.io/badge/Powered%20by-0G%20Network-green.svg)](https://0g.ai)
[![Built with Gemini](https://img.shields.io/badge/Built%20with-Gemini-orange.svg)](https://deepmind.google/technologies/gemini/)

**NonceSense** is a chat-first, on-chain AI agent designed to be your decentralized "twin." It doesn't just execute commands; it learns your habits, monitors the pulse of the market, and lives on the decentralized web via 0G storage.

---

## 🚀 The Nitty-Gritty: How We Built It

NonceSense was born out of a desire to bridge the gap between "dumb" CLI wallets and "black-box" AI agents. We wanted something that felt like a conversation but acted with the precision of a smart contract.

### 🛠️ The Tech Stack
*   **Intelligence Engine:** [Google Gemini](https://deepmind.google/technologies/gemini/) (Gemini 2.5 Flash) drives our reasoning, habit mining, and natural language command parsing.
*   **Blockchain Backbone:** [Ethers.js v6](https://docs.ethers.org/v6/) handles the heavy lifting for on-chain interactions, from ENS resolution to complex Uniswap swaps.
*   **Runtime:** Node.js with TypeScript, using `tsx` for high-performance development and execution.
*   **Infrastructure:** Alchemy for high-reliability RPC endpoints and Uniswap's decentralized token lists for real-time asset resolution.

### 🧩 How It's Pieced Together
The architecture is strictly layered to ensure "Trust but Verify" logic:
1.  **The Memory Layer:** Every message and action is logged. The AI uses this history to maintain a 12-turn context window, making conversations feel fluid.
2.  **The Habits Agent:** A background worker that "mines" your chat logs using Gemini. If you check your Sepolia balance every morning, it learns that pattern and suggests it as a one-click habit.
3.  **The Policy Engine:** Before any transaction hits the wire, it passes through a policy check (spending limits, network verification) and requires a manual OS-level signing via a locally encrypted wallet.
4.  **The 0G Bridge:** A custom synchronization layer that periodically pushes local state (habits, profile) to 0G KV store, ensuring your twin's "brain" is decentralized.

---

## 🤝 Partner Technologies & Benefits

### **0G Foundation (The Decentralized Soul)**
Using 0G wasn't just a hackathon choice; it's the core of the "Twin" concept. By leveraging **0G's KV Store**, we moved user preferences from a fragile `config.json` to a decentralized state. This means if you move to a new machine, your NonceSense agent knows you the moment you connect your wallet. **0G Storage** allows us to store massive action logs for long-term "life-logging" without bloating a local database.

### **Google Gemini (The Thinking Brain)**
Gemini allows NonceSense to understand intent, not just commands. We use it for **Habit Mining**, where it looks at raw logs and identifies repeating behaviors. It also powers our "Fuzzy Network Matching"—if you type "sepolua," NonceSense knows you meant "Sepolia."

---

## 🏴‍☠️ Hacky & Notable Bits

*   **Regex + LLM Hybrid:** Instead of sending every message to the AI (which is slow and expensive), we built a "Heuristic Planner." It uses complex regex patterns to catch obvious commands (like `send 0.1 eth to vitalik.eth`) instantly. If the regex fails, it falls back to Gemini for deep reasoning.
*   **The "ENS-First" Intelligence:** Most bots treat ENS as just an address. NonceSense treats it as a profile. When you mention an `.eth` name, it doesn't just resolve the address; it pulls text records (Twitter, GitHub, Avatars) to give the AI context about who you're talking to.
*   **Misspelling Resilience:** We implemented a "fuzzy match" system for networks. "mainnnet", "mainnet", and "ethereum" all map to Chain ID 1. It’s a small detail that makes the CLI feel 10x more premium.

---

## 📦 Installation

Get NonceSense up and running in seconds:

```bash
# Clone the repository
git clone https://github.com/RohanSingh7761/noncesense.git
cd noncesense

# Install dependencies
npm install

# Set up your environment
cp .env.example .env
# Fill in your GEMINI_API_KEY, ALCHEMY_KEY, and 0G_RPC
```

## 🎮 Usage

Start the chat interface:
```bash
npm run dev
```

**Try these commands:**
*   *"What is my balance on Sepolia?"*
*   *"Send 0.001 ETH to rschauhan.eth"*
*   *"Give me a quote for swapping 0.01 ETH to USDC"*
*   *"What if I swap my ETH for DAI right now?"*

---

## 🛡️ Security
*   Private keys are **AES-256 encrypted** locally with a passphrase.
*   NonceSense never stores your raw private key in memory or on 0G.
*   High-value transactions require manual confirmation.

---

*Built with ❤️ for the Hackathon.*
