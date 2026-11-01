import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentName, AgentRun } from './types.js';
import { runCommand } from './process.js';
import { digest } from './store.js';

export interface AgentCapability {
  name: 'codex' | 'claude'; installed: boolean; supported: boolean; version: string; reason: string;
}
export interface AgentOptions {
  workspace: string; prompt: string; timeoutMs?: number; signal?: AbortSignal;
  onProgress?: (message: string) => void;
  onSpawn?: (pid: number) => void;
  acknowledgement?: { sourceHash: string; contractHash: string | null };
}

/** Discover only documented flags in the installed executable, without starting a model. */
export async function detectAgents(cwd = process.cwd()): Promise<AgentCapability[]> {
  return Promise.all((['codex', 'claude'] as const).map(async name => {
    const version = await runCommand([name, '--version'], cwd, { timeoutMs: 10000 });
    if (version.exitCode !== 0) return { name, installed: false, supported: false, version: '', reason: 'Executable unavailable or --version failed.' };
    const help = await runCommand(name === 'codex' ? [name, 'exec', '--help'] : [name, '--help'], cwd, { timeoutMs: 10000 });
    const required = name === 'codex' ? ['--sandbox', '--cd', '--json', 'workspace-write'] : ['--print', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--allowedTools', '--tools'];
    const missing = required.filter(flag => !help.stdout.includes(flag));
    return { name, installed: true, supported: help.exitCode === 0 && missing.length === 0, version: version.stdout.trim().split('\n')[0] ?? '', reason: missing.length ? `Installed CLI lacks required capabilities: ${missing.join(', ')}` : 'Required CLI capabilities found; authentication is checked when the agent runs.' };
  }));
}

/** Only visible assistant messages count; echoed input, tools and reasoning events do not. */
export function acknowledgedCheckpoint(name: 'codex' | 'claude', stdout: string, sourceHash: string, contractHash: string | null): boolean {
  const expected = `SENTINEL_ACK ${sourceHash} ${contractHash ?? 'none'}`;
  const texts: string[] = [];
  for (const line of stdout.split('\n')) {
    let event: unknown;
    try { event = JSON.parse(line); } catch { continue; }
    if (!event || typeof event !== 'object') continue;
    const value = event as Record<string, unknown>;
    if (name === 'codex' && value.type === 'item.completed' && value.item && typeof value.item === 'object') {
      const item = value.item as Record<string, unknown>;
      if (item.type === 'agent_message' && typeof item.text === 'string') texts.push(item.text);
    }
    if (name === 'claude' && value.type === 'assistant' && value.message && typeof value.message === 'object') {
      const content = (value.message as Record<string, unknown>).content;
      if (Array.isArray(content)) for (const block of content) if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    }
    if (name === 'claude' && value.type === 'result' && value.is_error !== true && typeof value.result === 'string') texts.push(value.result);
  }
  return texts.some(text => text.split('\n').some(line => line.trim() === expected));
}

const faulty = 'export function isAdult(age: unknown): boolean { return (age as number) >= 18; }\nexport function greeting(name: string): string { return `Hello, ${name}!`; }\n';
const corrected = 'export function isAdult(age: unknown): boolean { return typeof age === "number" && Number.isFinite(age) && Number.isInteger(age) && age >= 18; }\nexport function greeting(name: string): string { return `Hello, ${name}!`; }\n';

/** Fixture adapters are explicitly synthetic, local and restricted to the bundled fixture marker. */
export async function runAgent(name: AgentName, options: AgentOptions): Promise<AgentRun> {
  const startedAt = new Date().toISOString();
  if (name.startsWith('fixture-')) {
    const pkg = JSON.parse(await readFile(join(options.workspace, 'package.json'), 'utf8')) as { sentinelFixture?: string };
    if (pkg.sentinelFixture !== 'controlled-demo-v1') throw new Error('Fixture adapters only operate on the labelled controlled demonstration.');
    await mkdir(join(options.workspace, 'src'), { recursive: true });
    if (!options.signal?.aborted) await writeFile(join(options.workspace, 'src/access.ts'), name === 'fixture-fix' ? corrected : faulty);
    const interrupted = name === 'fixture-interrupt' || options.signal?.aborted;
    options.onProgress?.(interrupted ? 'Controlled fixture agent interrupted; source changes preserved.' : `Controlled fixture adapter ${name} completed.`);
    return { agent: name, startedAt, completedAt: new Date().toISOString(), outcome: interrupted ? 'interrupted' : 'completed', statement: name === 'fixture-fix' ? 'SIMULATED AGENT STATEMENT: added strict numeric validation; independent verification still required.' : 'SIMULATED AGENT STATEMENT: the visible tests pass, so the task is complete. This claim is not verification evidence.' };
  }
  const capabilities = await detectAgents(options.workspace);
  const capability = capabilities.find(c => c.name === name);
  if (!capability?.supported) throw new Error(`${name} is unavailable or unsupported: ${capability?.reason ?? 'unknown agent'}`);
  const command = name === 'codex'
    ? ['codex', 'exec', '--sandbox', 'workspace-write', '--cd', options.workspace, '--json', '-']
    : ['claude', '--print', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Edit,Write,Glob,Grep', '--tools', 'Read,Edit,Write,Glob,Grep'];
  options.onProgress?.(`${name} ${capability.version}: editing the managed workspace.`);
  const runningSince = performance.now();
  let eventCount = 0;
  let pendingLine = '';
  const progress = setInterval(() => { try { options.onProgress?.(`${name} is working (${Math.round((performance.now() - runningSince) / 1000)}s; ${eventCount} output events received).`); } catch { /* A presentation callback must not interrupt the agent. */ } }, 10000);
  progress.unref();
  let record;
  try {
    record = await runCommand(command, options.workspace, {
      timeoutMs: options.timeoutMs ?? 600000, input: options.prompt, signal: options.signal, onSpawn: options.onSpawn,
      onOutput: chunk => {
        pendingLine = (pendingLine + chunk).slice(-64000);
        const lines = pendingLine.split('\n');
        pendingLine = lines.pop() ?? '';
        eventCount += lines.filter(line => line.trim().length > 0).length;
      },
    });
  } finally { clearInterval(progress); }

  const outcome = record.timedOut || options.signal?.aborted || record.signal ? 'interrupted' : record.exitCode === 0 ? 'completed' : 'failed';
  // Only the visible CLI transcript is recorded. Never imply access to private model reasoning.
  return { agent: name, startedAt, completedAt: new Date().toISOString(), outcome, command: record, ...(options.acknowledgement ? { handoff: { contextHash: digest(options.prompt), acknowledged: acknowledgedCheckpoint(name as 'codex' | 'claude', record.stdout, options.acknowledgement.sourceHash, options.acknowledgement.contractHash), sourceHash: options.acknowledgement.sourceHash, contractHash: options.acknowledgement.contractHash } } : {}), statement: `UNVERIFIED ${name} CLI output:\n${record.stdout.slice(-12000)}${record.stderr ? `\nCLI diagnostics:\n${record.stderr.slice(-2000)}` : ''}` };
}
