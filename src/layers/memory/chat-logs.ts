import { appendFile, mkdir } from 'node:fs/promises';
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

export function getLogsPath(): string {
  return LOG_FILE_PATH;
}
