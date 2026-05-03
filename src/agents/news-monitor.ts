import { GoogleGenAI } from '@google/genai';

export interface WalletTokenSnapshot {
  symbol: string;
  balance: string;
}

export interface WalletNetworkSnapshot {
  chainId: number;
  network: string;
  nativeEth: string;
  tokens: WalletTokenSnapshot[];
}

export interface WalletSnapshot {
  address: string;
  networks: WalletNetworkSnapshot[];
}

interface NewsArticle {
  title?: string;
  description?: string;
  url?: string;
  publishedAt?: string;
  source?: {
    name?: string;
  };
}

interface NewsApiResponse {
  status?: string;
  articles?: NewsArticle[];
}

export interface StartNewsMonitorInput {
  getWalletSnapshot: () => Promise<WalletSnapshot>;
  onRecommendation: (lines: string[]) => Promise<void>;
  onRecommendationLogged?: (lines: string[]) => Promise<void>;
  intervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const BALANCE_CHECK_INTERVAL_MS = 30 * 1000;
const MAX_ARTICLES_FOR_ANALYSIS = 12;

function getNewsUrl(apiKey: string): string {
  return `https://newsapi.org/v2/everything?q=ethereum&apiKey=${encodeURIComponent(apiKey)}`;
}

function normalizeLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function fetchEthereumNews(apiKey: string): Promise<NewsArticle[]> {
  const response = await fetch(getNewsUrl(apiKey));
  if (!response.ok) {
    throw new Error(`News API request failed (${response.status})`);
  }

  const data = (await response.json()) as NewsApiResponse;
  return data.articles ?? [];
}

function articleKey(article: NewsArticle): string {
  return `${article.url ?? ''}|${article.publishedAt ?? ''}|${article.title ?? ''}`;
}

function hasPositiveWalletBalance(wallet: WalletSnapshot): boolean {
  for (const network of wallet.networks) {
    const native = Number(network.nativeEth);
    if (Number.isFinite(native) && native > 0) {
      return true;
    }
    for (const token of network.tokens) {
      const amount = Number(token.balance);
      if (Number.isFinite(amount) && amount > 0) {
        return true;
      }
    }
  }
  return false;
}

async function generateRecommendation(
  wallet: WalletSnapshot,
  articles: NewsArticle[],
  apiKey: string | undefined,
): Promise<string[]> {
  if (!apiKey) {
    return [
      'I found fresh Ethereum-related news, but GEMINI_API_KEY is missing for deep analysis.',
      'Set GEMINI_API_KEY to enable detailed buy/hold/sell style recommendations.',
    ];
  }
  const ai = new GoogleGenAI({ apiKey });
  const model = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
  const prompt = `You are a crypto market monitoring copilot.

Task:
1) Read the Ethereum-related news.
2) Read wallet snapshot across networks.
3) Give a practical recommendation in human tone.

Output style:
- 4 to 8 concise lines.
- Include: overall sentiment, suggested action (hold/buy/sell/reduce risk/watch), and WHY.
- Do NOT include generic boilerplate disclaimers (such as "crypto markets are highly volatile" or "this is not financial advice").
- If there is a real specific risk from the news, mention it specifically.
- Use only info from the provided data.

Wallet snapshot:
${JSON.stringify(wallet, null, 2)}

News batch:
${JSON.stringify(articles, null, 2)}`;

  const response = await ai.models.generateContent({
    model,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
  });
  const text = (response.text ?? '').trim();
  if (!text) {
    return ['No recommendation generated from this news batch.'];
  }
  // Strip any generic disclaimer lines the model might still insert
  const lines = normalizeLines(text).filter(
    (line) =>
      !/crypto\s+markets?\s+are\s+highly\s+volatile/i.test(line) &&
      !/this\s+is\s+not\s+financial\s+advice/i.test(line) &&
      !/not\s+financial\s+advice/i.test(line),
  );
  return lines.length > 0 ? lines : ['No recommendation generated from this news batch.'];
}

export function startNewsMonitor(input: StartNewsMonitorInput): () => void {
  const apiKey = process.env.NEWS_API_KEY;
  if (!apiKey) {
    void input.onRecommendation(['[Market Agent] NEWS_API_KEY is missing. News monitor is disabled.']);
    return () => undefined;
  }

  const intervalMs = input.intervalMs ?? DEFAULT_INTERVAL_MS;
  const seen = new Set<string>();
  let stopped = false;
  let running = false;
  let hasFunds = false;
  let waitingAnnounced = false;
  let nextAnalysisAt: number | undefined;

  const tick = async (): Promise<void> => {
    if (stopped || running) {
      return;
    }
    running = true;
    try {
      const wallet = await input.getWalletSnapshot();
      const funded = hasPositiveWalletBalance(wallet);

      if (!funded) {
        hasFunds = false;
        nextAnalysisAt = undefined;
        if (!waitingAnnounced) {
          waitingAnnounced = true;
          await input.onRecommendation([
            '[Market Agent] Waiting for wallet balance > 0 before starting news analysis.',
          ]);
        }
        return;
      }

      if (!hasFunds) {
        hasFunds = true;
        waitingAnnounced = false;
        nextAnalysisAt = Date.now() + intervalMs;
        await input.onRecommendation([
          '[Market Agent] Balance detected. First news analysis will run shortly.',
        ]);
        return;
      }

      if (!nextAnalysisAt) {
        nextAnalysisAt = Date.now() + intervalMs;
        return;
      }

      if (Date.now() < nextAnalysisAt) {
        return;
      }

      const allArticles = await fetchEthereumNews(apiKey);
      const newest = allArticles
        .slice(0, MAX_ARTICLES_FOR_ANALYSIS)
        .filter((article) => {
          const key = articleKey(article);
          if (seen.has(key)) {
            return false;
          }
          seen.add(key);
          return true;
        });

      if (newest.length === 0) {
        nextAnalysisAt = Date.now() + intervalMs;
        return;
      }

      const recommendation = await generateRecommendation(wallet, newest, process.env.GEMINI_API_KEY);
      const displayLines = [
        '[Market Agent] New Ethereum news signal:',
        ...recommendation,
      ];
      await input.onRecommendation(displayLines);
      // Write to separate recommendations log if callback provided
      if (input.onRecommendationLogged) {
        await input.onRecommendationLogged(displayLines);
      }
      nextAnalysisAt = Date.now() + intervalMs;
    } catch (error: unknown) {
      const text = error instanceof Error ? error.message : String(error);
      await input.onRecommendation([`[Market Agent] News monitor error: ${text}`]);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, BALANCE_CHECK_INTERVAL_MS);
  void tick();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
