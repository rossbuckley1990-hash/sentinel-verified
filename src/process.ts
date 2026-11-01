import { spawn } from 'node:child_process';
import type { CommandRecord } from './types.js';
export interface RunOptions { timeoutMs?: number; input?: string; onOutput?: (text: string) => void; signal?: AbortSignal; env?: NodeJS.ProcessEnv }
export async function runCommand(command: string[], cwd: string, options: RunOptions = {}): Promise<CommandRecord> {
  if (!command[0]) throw new Error('Empty command');
  const started = performance.now();
  return new Promise(resolve => {
    const record: CommandRecord = { command, input: options.input, cwd, exitCode: null, signal: null, stdout: '', stderr: '', durationMs: 0, timedOut: false, truncated: false };
    const child = spawn(command[0]!, command.slice(1), { cwd, shell: false, detached: process.platform !== 'win32', env: options.env ?? process.env, stdio: ['pipe','pipe','pipe'] });
    let ended = false;
    let killTimer: NodeJS.Timeout | undefined;
    const kill = (signal: NodeJS.Signals) => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* process already exited */ } };
    const stop = () => { kill('SIGTERM'); killTimer = setTimeout(() => kill('SIGKILL'), 300); killTimer.unref(); };
    const timer = setTimeout(() => { record.timedOut = true; stop(); }, options.timeoutMs ?? 30000);
    const abort = () => { record.signal = 'SIGINT'; stop(); };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const append = (key: 'stdout' | 'stderr', bytes: Buffer) => {
      const text = bytes.toString('utf8');
      const remaining = 1_000_000 - Buffer.byteLength(record.stdout) - Buffer.byteLength(record.stderr);
      if (remaining <= 0) { record.truncated = true; stop(); return; }
      record[key] += text.slice(0, remaining);
      try { options.onOutput?.(text.slice(0, remaining)); } catch { /* UI must not lose evidence */ }
    };
    child.stdout.on('data', data => append('stdout', data)); child.stderr.on('data', data => append('stderr', data));
    child.stdin.on('error', () => {});
    child.stdin.end(options.input ?? '');
    const finish = () => { if (ended) return; ended = true; clearTimeout(timer); if(killTimer) clearTimeout(killTimer); options.signal?.removeEventListener('abort', abort); record.durationMs = Math.round(performance.now() - started); resolve(record); };
    child.on('error', error => { record.stderr += error.message; finish(); });
    child.on('close', (code, signal) => { record.exitCode = code; record.signal = record.signal ?? signal; if (record.timedOut || record.truncated || record.signal) kill('SIGKILL'); finish(); });
  });
}
export function executionEnvironment(): NodeJS.ProcessEnv {
  // Repository code does not receive cloud tokens, NODE_OPTIONS, or the parent's secret environment.
  return { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, SystemRoot: process.env.SystemRoot, CI: '1', NO_COLOR: '1', TZ: 'UTC', LANG: 'C.UTF-8' };
}
