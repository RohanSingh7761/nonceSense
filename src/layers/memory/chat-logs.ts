import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

type LogType = 'chat' | 'action' | 'error' | 'system';

interface BaseLogEntry {
  timestamp: string;
  type: LogType;
}

interface ChatLogEntry extends BaseLogEntry {
  type: 'chat';
  role: 'user' | 'assistant';
  message: string;
}

interface ActionLogEntry extends BaseLogEntry {
  type: 'action';
  action: string;
  phase: 'planned' | 'started' | 'succeeded' | 'failed';
  metadata?: Record<string, string>;
}

interface ErrorLogEntry extends BaseLogEntry {
  type: 'error';
  message: string;
  context?: Record<string, string>;
}

interface SystemLogEntry extends BaseLogEntry {
  type: 'system';
  message: string;
  metadata?: Record<string, string>;
}

type LogEntry = ChatLogEntry | ActionLogEntry | ErrorLogEntry | SystemLogEntry;

const LOG_DIRECTORY = path.join(process.cwd(), '.noncesense', 'logs');
const LOG_FILE_PATH = path.join(LOG_DIRECTORY, 'events.jsonl');

async function appendLog(entry: LogEntry): Promise<void> {
  await mkdir(LOG_DIRECTORY, { recursive: true });
  await appendFile(LOG_FILE_PATH, `${JSON.stringify(entry)}\n`, 'utf8');
}

async function readLogs(): Promise<LogEntry[]> {
  try {
    const raw = await readFile(LOG_FILE_PATH, 'utf8');
    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    const parsed: LogEntry[] = [];
    for (const line of lines) {
      try {
        const item = JSON.parse(line) as LogEntry;
        if (item && typeof item === 'object' && typeof item.type === 'string') {
          parsed.push(item);
        }
      } catch {
        // Skip malformed lines and continue parsing valid entries.
      }
    }

    return parsed;
  } catch {
    return [];
  }
}

export async function logChatMessage(role: 'user' | 'assistant', message: string): Promise<void> {
  await appendLog({
    timestamp: new Date().toISOString(),
    type: 'chat',
    role,
    message,
  });
}

export async function logActionEvent(
  action: string,
  phase: 'planned' | 'started' | 'succeeded' | 'failed',
  metadata?: Record<string, string>,
): Promise<void> {
  await appendLog({
    timestamp: new Date().toISOString(),
    type: 'action',
    action,
    phase,
    metadata,
  });
}

export async function logErrorEvent(message: string, context?: Record<string, string>): Promise<void> {
  await appendLog({
    timestamp: new Date().toISOString(),
    type: 'error',
    message,
    context,
  });
}

export async function logSystemEvent(message: string, metadata?: Record<string, string>): Promise<void> {
  await appendLog({
    timestamp: new Date().toISOString(),
    type: 'system',
    message,
    metadata,
  });
}

export async function getRecentUserMessages(limit = 5): Promise<string[]> {
  const entries = await readLogs();
  return entries
    .filter((entry): entry is ChatLogEntry => entry.type === 'chat' && entry.role === 'user')
    .slice(-limit)
    .reverse()
    .map((entry) => entry.message);
}

export interface ActionHistoryItem {
  timestamp: string;
  action: string;
  phase: 'planned' | 'started' | 'succeeded' | 'failed';
  metadata?: Record<string, string>;
}

export async function getRecentActionHistory(limit = 5): Promise<ActionHistoryItem[]> {
  const entries = await readLogs();
  return entries
    .filter((entry): entry is ActionLogEntry => entry.type === 'action')
    .slice(-limit)
    .reverse()
    .map((entry) => ({
      timestamp: entry.timestamp,
      action: entry.action,
      phase: entry.phase,
      metadata: entry.metadata,
    }));
}

export function getLogsPath(): string {
  return LOG_FILE_PATH;
}
