#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const command = args[0];

function printUsage() {
  console.log('NonceSense CLI');
  console.log('');
  console.log('Usage:');
  console.log('  ns start');
}

if (!command || command === 'help' || command === '--help' || command === '-h') {
  printUsage();
  process.exit(0);
}

if (command !== 'start') {
  console.error(`Unknown command: ${command}`);
  printUsage();
  process.exit(1);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const launcher = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const child = spawn(launcher, ['tsx', 'src/cli.ts'], {
  cwd: repoRoot,
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
