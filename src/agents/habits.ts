import { GoogleGenAI } from '@google/genai';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';

import {
  countUserChatMessages,
  getRecentActionHistory,
  getRecentUserMessagesDetailed,
} from '../layers/memory/chat-logs.js';

export interface Habit {
  id: string;
  label: string;
  commandText: string;
  matchedAims: string[];
  occurrences: number;
  confidence: number;
  updatedAt: string;
}

interface HabitsState {
  habits: Habit[];
  lastAnalyzedUserMessageCount: number;
  lastAnalyzedAt?: string;
  thresholdInputs: number;
}

export interface StartHabitsAgentInput {
  getUserProfile: () => Promise<string | undefined>;
  onHabitsUpdated: (habits: Habit[], isFirstDetection: boolean) => Promise<void>;
  onNotice: (lines: string[]) => Promise<void>;
  thresholdInputs?: number;
  checkIntervalMs?: number;
}

const HABITS_DIRECTORY = path.join(process.cwd(), '.noncesense');
const HABITS_FILE_PATH = path.join(HABITS_DIRECTORY, 'habits.json');
const DEFAULT_CHECK_INTERVAL_MS = 20 * 1000;
const DEFAULT_THRESHOLD_INPUTS = 10;
const MAX_MESSAGES_FOR_ANALYSIS = 60;
const MAX_ACTIONS_FOR_ANALYSIS = 60;
const STALE_HABIT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_HABITS = 5;

export function getHabitsFilePath(): string {
  return HABITS_FILE_PATH;
}

async function ensureHabitsFileExists(initialThreshold: number, initialCount: number): Promise<void> {
  await mkdir(HABITS_DIRECTORY, { recursive: true });
  try {
    await access(HABITS_FILE_PATH, fsConstants.F_OK);
  } catch {
    const initial: HabitsState = {
      habits: [],
      lastAnalyzedUserMessageCount: initialCount,
      thresholdInputs: initialThreshold,
    };
    await writeFile(HABITS_FILE_PATH, JSON.stringify(initial, null, 2), 'utf8');
  }
}

async function loadHabitsState(
  fallbackThreshold: number,
  fallbackCount: number,
): Promise<HabitsState> {
  try {
    const raw = await readFile(HABITS_FILE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<HabitsState>;
    return {
      habits: Array.isArray(parsed.habits) ? parsed.habits : [],
      lastAnalyzedUserMessageCount:
        typeof parsed.lastAnalyzedUserMessageCount === 'number'
          ? parsed.lastAnalyzedUserMessageCount
          : fallbackCount,
      lastAnalyzedAt: parsed.lastAnalyzedAt,
      thresholdInputs:
        typeof parsed.thresholdInputs === 'number' && parsed.thresholdInputs > 0
          ? parsed.thresholdInputs
          : fallbackThreshold,
    };
  } catch {
    return {
      habits: [],
      lastAnalyzedUserMessageCount: fallbackCount,
      thresholdInputs: fallbackThreshold,
    };
  }
}

async function saveHabitsState(state: HabitsState): Promise<void> {
  await mkdir(HABITS_DIRECTORY, { recursive: true });
  await writeFile(HABITS_FILE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

export async function readHabits(): Promise<Habit[]> {
  try {
    const raw = await readFile(HABITS_FILE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<HabitsState>;
    return Array.isArray(parsed.habits) ? parsed.habits : [];
  } catch {
    return [];
  }
}

function extractJsonObject(text: string): string {
  const fenceMatch = text.match(/```json\s*([\s\S]*?)```/i);
  if (fenceMatch && fenceMatch[1]) {
    return fenceMatch[1].trim();
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return text.slice(start, end + 1);
  }
  throw new Error('No JSON object found in model response.');
}

function normalizeCommandText(commandText: string): string {
  return commandText.trim().toLowerCase().replace(/\s+/g, ' ');
}

interface GeminiHabit {
  label?: unknown;
  commandText?: unknown;
  matchedAims?: unknown;
  occurrences?: unknown;
  confidence?: unknown;
}

function coerceHabit(raw: GeminiHabit): Omit<Habit, 'id' | 'updatedAt'> | undefined {
  const label = typeof raw.label === 'string' ? raw.label.trim() : '';
  const commandText = typeof raw.commandText === 'string' ? raw.commandText.trim() : '';
  if (!label || !commandText) {
    return undefined;
  }
  const matchedAims = Array.isArray(raw.matchedAims)
    ? raw.matchedAims.filter((item): item is string => typeof item === 'string')
    : [];
  const occurrences =
    typeof raw.occurrences === 'number' && Number.isFinite(raw.occurrences)
      ? Math.max(1, Math.floor(raw.occurrences))
      : 2;
  const confidenceRaw =
    typeof raw.confidence === 'number' && Number.isFinite(raw.confidence) ? raw.confidence : 0.5;
  const confidence = Math.min(1, Math.max(0, confidenceRaw));
  return { label, commandText, matchedAims, occurrences, confidence };
}

function mergeHabits(existing: Habit[], detected: Array<Omit<Habit, 'id' | 'updatedAt'>>): Habit[] {
  const now = new Date().toISOString();
  const byKey = new Map<string, Habit>();
  for (const habit of existing) {
    byKey.set(normalizeCommandText(habit.commandText), habit);
  }
  for (const item of detected) {
    const key = normalizeCommandText(item.commandText);
    const prior = byKey.get(key);
    if (prior) {
      byKey.set(key, {
        ...prior,
        label: item.label || prior.label,
        commandText: item.commandText,
        matchedAims: item.matchedAims.length > 0 ? item.matchedAims : prior.matchedAims,
        occurrences: Math.max(prior.occurrences, item.occurrences),
        confidence: Math.max(prior.confidence, item.confidence),
        updatedAt: now,
      });
    } else {
      byKey.set(key, {
        id: crypto.randomUUID(),
        label: item.label,
        commandText: item.commandText,
        matchedAims: item.matchedAims,
        occurrences: item.occurrences,
        confidence: item.confidence,
        updatedAt: now,
      });
    }
  }

  const nowMs = Date.now();
  const kept: Habit[] = [];
  for (const habit of byKey.values()) {
    const updatedMs = Date.parse(habit.updatedAt);
    if (Number.isFinite(updatedMs) && nowMs - updatedMs > STALE_HABIT_MAX_AGE_MS) {
      continue;
    }
    kept.push(habit);
  }

  kept.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return b.occurrences - a.occurrences;
  });
  return kept.slice(0, MAX_HABITS);
}

function habitsEqual(a: Habit[], b: Habit[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (
      normalizeCommandText(left.commandText) !== normalizeCommandText(right.commandText) ||
      left.label !== right.label
    ) {
      return false;
    }
  }
  return true;
}

async function analyzeHabits(
  profileText: string | undefined,
  apiKey: string,
): Promise<Array<Omit<Habit, 'id' | 'updatedAt'>>> {
  const [recentMessages, recentActions] = await Promise.all([
    getRecentUserMessagesDetailed(MAX_MESSAGES_FOR_ANALYSIS),
    getRecentActionHistory(MAX_ACTIONS_FOR_ANALYSIS),
  ]);

  if (recentMessages.length === 0) {
    return [];
  }

  const ai = new GoogleGenAI({ apiKey });
  const model = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
  const profileBlock = profileText?.trim()
    ? `User profile (verbatim, use as context for what the user cares about):\n${profileText.trim()}`
    : 'User profile: (not provided yet — rely on message patterns alone.)';

  const prompt = `You are a habits miner for a chat-first crypto assistant.

Task:
- Look at the user's profile and recent activity.
- Detect up to ${MAX_HABITS} REPEATING patterns (something the user has done 2+ times).
- Prefer patterns that align with the user's stated aims/preferences.
- Each habit must be something the user can replay by typing a natural-language command into the same chat.

${profileBlock}

Recent user chat messages (newest last):
${JSON.stringify(recentMessages, null, 2)}

Recent action events (newest last):
${JSON.stringify(recentActions, null, 2)}

Return STRICT JSON only, no prose, no markdown fences:
{
  "habits": [
    {
      "label": "short human title (<= 60 chars)",
      "commandText": "the exact natural-language input the user should type to run this again",
      "matchedAims": ["short phrase(s) from the profile this ties to"],
      "occurrences": <integer >= 2>,
      "confidence": <number between 0 and 1>
    }
  ]
}

Rules:
- commandText must be a ready-to-send chat message (e.g. "check my balance on sepolia", "quote 0.01 eth to usdc on sepolia").
- Never invent addresses, amounts, or tokens the user has not mentioned.
- If nothing repeats at least twice, return {"habits": []}.
- Do not include greetings or one-off questions.`;

  const response = await ai.models.generateContent({
    model,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
  });
  const raw = response.text ?? '';
  const parsed = JSON.parse(extractJsonObject(raw)) as { habits?: GeminiHabit[] };
  const rawHabits = Array.isArray(parsed.habits) ? parsed.habits : [];
  const coerced: Array<Omit<Habit, 'id' | 'updatedAt'>> = [];
  for (const item of rawHabits) {
    const habit = coerceHabit(item);
    if (habit && habit.occurrences >= 2) {
      coerced.push(habit);
    }
  }
  return coerced;
}

export function startHabitsAgent(input: StartHabitsAgentInput): () => void {
  const checkIntervalMs = input.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
  const fallbackThreshold = input.thresholdInputs ?? DEFAULT_THRESHOLD_INPUTS;
  let stopped = false;
  let running = false;
  let firstDetectionEmitted = false;

  const tick = async (): Promise<void> => {
    if (stopped || running) {
      return;
    }
    running = true;
    try {
      const currentCount = await countUserChatMessages();
      await ensureHabitsFileExists(fallbackThreshold, currentCount);
      const state = await loadHabitsState(fallbackThreshold, currentCount);
      const threshold = state.thresholdInputs > 0 ? state.thresholdInputs : fallbackThreshold;
      if (state.habits.length > 0) {
        firstDetectionEmitted = true;
      }
      const delta = currentCount - state.lastAnalyzedUserMessageCount;
      if (delta < threshold) {
        return;
      }

      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        state.lastAnalyzedUserMessageCount = currentCount;
        state.lastAnalyzedAt = new Date().toISOString();
        await saveHabitsState(state);
        await input.onNotice([
          '[Habits Agent] Skipping analysis — GEMINI_API_KEY is not set.',
        ]);
        return;
      }

      const profileText = await input.getUserProfile();
      let detected: Array<Omit<Habit, 'id' | 'updatedAt'>> = [];
      try {
        detected = await analyzeHabits(profileText, apiKey);
      } catch (error: unknown) {
        const text = error instanceof Error ? error.message : String(error);
        await input.onNotice([`[Habits Agent] Analysis error: ${text}`]);
      }

      const merged = mergeHabits(state.habits, detected);
      const changed = !habitsEqual(state.habits, merged);
      state.habits = merged;
      state.lastAnalyzedUserMessageCount = currentCount;
      state.lastAnalyzedAt = new Date().toISOString();
      await saveHabitsState(state);

      if (changed && merged.length > 0) {
        const isFirst = !firstDetectionEmitted;
        firstDetectionEmitted = true;
        await input.onHabitsUpdated(merged, isFirst);
      }
    } catch (error: unknown) {
      const text = error instanceof Error ? error.message : String(error);
      await input.onNotice([`[Habits Agent] Tick error: ${text}`]);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, checkIntervalMs);
  void tick();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
