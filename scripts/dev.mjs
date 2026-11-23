// Starts the server and the website together, in one terminal: `npm run dev`.
// Each line of output is tagged [server] or [client]. Press Ctrl+C once to stop both.
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline';

const isWindows = process.platform === 'win32';
const children = [];
let stopping = false;

function start(label, workspace, extraEnv = {}) {
  // Standard input is not connected. Vite shuts itself down when its terminal input ends, and some
  // terminals close it right after start, so the child must not depend on it.
  const child = spawn('npm', ['run', 'dev', '--workspace', workspace], {
    shell: isWindows,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0', ...extraEnv },
  });
  children.push(child);
  for (const stream of [child.stdout, child.stderr]) {
    readline.createInterface({ input: stream }).on('line', (line) => {
      if (line.trim() && !line.startsWith('> ')) console.log(`[${label}] ${line}`);
    });
  }
  child.on('exit', (code) => {
    if (stopping) return;
    console.error(`[${label}] stopped on its own (exit code ${code}). Stopping the other one too.`);
    shutdown(1);
  });
}

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.pid === undefined || child.exitCode !== null) continue;
    // On Windows the npm process has children of its own, so the whole tree is stopped.
    if (isWindows) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 300);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log('Starting Tajir AI: server on http://localhost:4000, website on http://localhost:5173 (Ctrl+C stops both)');
start('server', 'server');
start('client', 'client', { CI: 'true' });
