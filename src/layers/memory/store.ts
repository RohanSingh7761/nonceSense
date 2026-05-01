import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';

import type { HabitLogEntry, Recommendation } from '../../types/index.js';

interface MemoryState {
  recommendations: Recommendation[];
  habitLogs: HabitLogEntry[];
}

const MEMORY_DIRECTORY = path.join(process.cwd(), '.noncesense');
const MEMORY_FILE_PATH = path.join(MEMORY_DIRECTORY, 'memory.json');

function getDefaultMemoryState(): MemoryState {
  return {
    recommendations: [],
    habitLogs: [],
  };
}

async function ensureMemoryExists(): Promise<void> {
  await mkdir(MEMORY_DIRECTORY, { recursive: true });
  try {
    await access(MEMORY_FILE_PATH, fsConstants.F_OK);
  } catch {
    await writeFile(MEMORY_FILE_PATH, JSON.stringify(getDefaultMemoryState(), null, 2), 'utf8');
  }
}

async function loadMemoryState(): Promise<MemoryState> {
  await ensureMemoryExists();
  const raw = await readFile(MEMORY_FILE_PATH, 'utf8');
  return JSON.parse(raw) as MemoryState;
}

async function saveMemoryState(state: MemoryState): Promise<void> {
  await mkdir(MEMORY_DIRECTORY, { recursive: true });
  await writeFile(MEMORY_FILE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

function createLog(event: HabitLogEntry['event'], note: string, metadata?: Record<string, string>): HabitLogEntry {
  return {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    event,
    note,
    metadata,
  };
}

export async function addRecommendation(recommendation: Recommendation): Promise<void> {
  const state = await loadMemoryState();
  state.recommendations.unshift(recommendation);
  state.habitLogs.unshift(
    createLog('recommendation-generated', `Generated recommendation ${recommendation.id}`, {
      recommendationId: recommendation.id,
      tokenIn: recommendation.request.tokenIn.symbol,
      tokenOut: recommendation.request.tokenOut.symbol,
      amountIn: recommendation.request.amountIn,
    }),
  );
  await saveMemoryState(state);
}

export async function getRecommendationById(id: string): Promise<Recommendation | undefined> {
  const state = await loadMemoryState();
  return state.recommendations.find((item) => item.id === id);
}

export async function logExecutionRequested(recommendationId: string): Promise<void> {
  const state = await loadMemoryState();
  state.habitLogs.unshift(
    createLog('execution-requested', `Execution requested for recommendation ${recommendationId}`, {
      recommendationId,
    }),
  );
  await saveMemoryState(state);
}

export async function logExecutionSubmitted(recommendationId: string, transactionHash: string): Promise<void> {
  const state = await loadMemoryState();
  state.habitLogs.unshift(
    createLog('execution-submitted', `Execution submitted for recommendation ${recommendationId}`, {
      recommendationId,
      transactionHash,
    }),
  );
  await saveMemoryState(state);
}

export async function logExecutionFailed(recommendationId: string, errorMessage: string): Promise<void> {
  const state = await loadMemoryState();
  state.habitLogs.unshift(
    createLog('execution-failed', `Execution failed for recommendation ${recommendationId}`, {
      recommendationId,
      errorMessage,
    }),
  );
  await saveMemoryState(state);
}

export async function listRecentRecommendations(limit = 5): Promise<Recommendation[]> {
  const state = await loadMemoryState();
  return state.recommendations.slice(0, limit);
}

export function getMemoryPath(): string {
  return MEMORY_FILE_PATH;
}
