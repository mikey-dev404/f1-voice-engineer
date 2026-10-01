// Launches Electron with a clean environment.
//
// Editor terminals (VS Code, Cursor) export ELECTRON_RUN_AS_NODE=1, which makes
// the electron binary behave like plain Node. The app then starts with no
// `app` object and dies immediately, so strip it before spawning.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

let electronPath;
try {
  electronPath = require('electron');
} catch {
  console.error('Electron is not installed. Run "npm install" first.');
  process.exit(1);
}

if (typeof electronPath !== 'string') {
  console.error('Could not resolve the Electron binary.');
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, [root, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
});

child.on('close', (code) => process.exit(code ?? 0));
