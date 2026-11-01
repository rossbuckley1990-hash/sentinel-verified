import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { startSession, continueSession, loadCheckpoint, saveCheckpoint, continuationContext } from '../src/session.js';
import { getObject } from '../src/store.js';
import { runAgent } from '../src/agents.js';
import type { Receipt } from '../src/types.js';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function project() {
  const directory = await mkdtemp(join(tmpdir(), 'sentinel-session-test-'));
  temporary.push(directory);
  const repo = join(directory, 'repo');
  const store = join(directory, 'store');
  await cp(resolve('fixtures/demo'), repo, { recursive: true });
  const contractPath = join(directory, 'approved.json');
  await cp(join(repo, 'contract.json'), contractPath);
  // Contracts should remain external to the managed source from the outset.
  await rm(join(repo, 'contract.json'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'pipe' });
  execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'pipe' });
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'baseline'], { cwd: repo, stdio: 'pipe' });
  const objective = (JSON.parse(await readFile(contractPath, 'utf8')) as { objective: string }).objective;
  return { repo, store, contractPath, objective };
}

describe('durable sessions and handoffs', () => {
  it('requires explicit local-execution consent and keeps approved contracts external', async () => {
    const p = await project();
    await expect(startSession({ ...p, agent: 'fixture-interrupt', localConsent: false })).rejects.toThrow('--allow-local');
    await cp(p.contractPath, join(p.repo, 'contract.json'));
    await expect(startSession({ ...p, contractPath: join(p.repo, 'contract.json'), agent: 'fixture-interrupt', localConsent: true })).rejects.toThrow('outside');
  });

  it('preserves a partial implementation and resumes through a different deterministic adapter', async () => {
    const p = await project();
    const original = await readFile(join(p.repo, 'src/access.ts'), 'utf8');
    const stopped = await startSession({ ...p, agent: 'fixture-interrupt', localConsent: true });
    expect(stopped.state).toBe('interrupted');
    expect(stopped.receipts).toEqual([]);
    expect(stopped.agents[0]?.outcome).toBe('interrupted');
    expect(await readFile(join(p.repo, 'src/access.ts'), 'utf8')).toBe(original);
    expect(await loadCheckpoint(p.store)).toEqual(stopped);
    const finished = await continueSession({ store: p.store, agent: 'fixture-fix' });
    expect(finished.state, finished.receipts[0] ? (await getObject(p.store, finished.receipts[0])).toString() : JSON.stringify(finished)).toBe('verified');
    expect(finished.agents.map(a => a.agent)).toEqual(['fixture-interrupt', 'fixture-fix']);
    expect(finished.baselineHash).toBe(stopped.baselineHash);
    expect(finished.contractHash).toBe(stopped.contractHash);
    expect(finished.candidateHash).not.toBe(stopped.candidateHash);
    const receipt = JSON.parse((await getObject(p.store, finished.receipts[0]!)).toString()) as Receipt;
    expect(receipt.candidateHash).toBe(finished.candidateHash);
    expect(receipt.status).toBe('VERIFIED');
    expect(await continuationContext(p.store, finished)).toContain('UNVERIFIED');
    expect(await readFile(join(p.repo, 'src/access.ts'), 'utf8')).toBe(original);
  });

  it('rejects source drift until explicitly adopted', async () => {
    const p = await project();
    const checkpoint = await startSession({ ...p, agent: 'fixture-interrupt', localConsent: true });
    await writeFile(join(checkpoint.workspace, 'notes.txt'), 'unexpected edit');
    await expect(continueSession({ store: p.store, agent: 'fixture-fix' })).rejects.toThrow('changed since');
    const adopted = await continueSession({ store: p.store, agent: 'fixture-interrupt', adoptChanges: true });
    expect(adopted.openQuestions.some(q => q.includes('adopted edits'))).toBe(true);
    expect(await readFile(join(adopted.workspace, 'notes.txt'), 'utf8')).toBe('unexpected edit');
  });

  it('recovers a killed running state without trusting unverified edits', async () => {
    const p = await project();
    const checkpoint = await startSession({ ...p, agent: 'fixture-interrupt', localConsent: true });
    checkpoint.state = 'running';
    await saveCheckpoint(p.store, checkpoint);
    await writeFile(join(checkpoint.workspace, 'partial.txt'), 'work before process death');
    const recovered = await continueSession({ store: p.store, agent: 'fixture-interrupt' });
    expect(recovered.openQuestions.some(q => q.includes('stopped process'))).toBe(true);
    expect(recovered.receipts).toEqual([]);
  });

  it('rejects missing and corrupted checkpoints without reconstructing trusted state', async () => {
    const p = await project();
    const checkpoint = await startSession({ ...p, agent: 'fixture-interrupt', localConsent: true });
    const file = join(p.store, 'sessions', checkpoint.id, 'checkpoint.json');
    const envelope = JSON.parse(await readFile(file, 'utf8'));
    envelope.checkpoint.objective = 'silently altered objective';
    await writeFile(file, JSON.stringify(envelope));
    await expect(loadCheckpoint(p.store)).rejects.toThrow('integrity failure');
    await rm(file);
    await expect(loadCheckpoint(p.store)).rejects.toThrow('missing or unreadable');
  });

  it('detects protected contract object modification', async () => {
    const p = await project();
    const checkpoint = await startSession({ ...p, agent: 'fixture-interrupt', localConsent: true });
    const contractObject = join(p.store, 'objects', checkpoint.contractHash!);
    await chmod(contractObject, 0o600);
    await writeFile(contractObject, '{}');
    await expect(loadCheckpoint(p.store)).rejects.toThrow('integrity failure');
  });

  it('blocks concurrent writers and validates checkpoint workspace ownership', async () => {
    const p = await project();
    const checkpoint = await startSession({ ...p, agent: 'fixture-interrupt', localConsent: true });
    const lock = join(p.store, 'sessions', checkpoint.id, 'writer.lock');
    await writeFile(lock, JSON.stringify({ pid: process.pid, nonce: 'another-writer' }));
    await expect(continueSession({ store: p.store, agent: 'fixture-interrupt' })).rejects.toThrow('already running');
    await rm(lock);
    checkpoint.workspace = p.repo;
    await saveCheckpoint(p.store, checkpoint);
    await expect(loadCheckpoint(p.store)).rejects.toThrow('outside its managed');
  });

  it('refuses fixture adapters for an unlabelled project', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sentinel-adapter-test-'));
    temporary.push(directory);
    await writeFile(join(directory, 'package.json'), '{}');
    await expect(runAgent('fixture-fix', { workspace: directory, prompt: '' })).rejects.toThrow('labelled controlled');
  });
});

describe('bounded continuation context', () => {
  it('retains a bounded evidence package and the previous actionable guidance', async () => {
    const p = await project();
    const checkpoint = await startSession({ ...p, agent: 'fixture-interrupt', localConsent: true });
    checkpoint.objective = 'Large task '.repeat(10000);
    checkpoint.nextActions = ['Repair numeric-string validation before claiming completion.'];
    checkpoint.unverifiedStatements = ['Agent narrative '.repeat(10000)];
    const context = await continuationContext(p.store, checkpoint);
    expect(context.length).toBeLessThanOrEqual(16000);
    expect(context).toContain('Repair numeric-string validation');
    expect(context).toContain('No completed verification yet');
    expect(context).toContain('UNVERIFIED PREVIOUS AGENT STATEMENTS');
  });
});

describe('documented CLI adapter protocols using fake executables', () => {
  it('uses documented argv and stdin for both providers without claiming a live model test', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sentinel-cli-protocol-'));
    temporary.push(directory);
    const bin = join(directory, 'bin');
    await mkdir(bin);
    const stub = `#!/usr/bin/env node
const args = process.argv.slice(2);
if(args.includes('--version')) { console.log('controlled CLI protocol fixture 1'); process.exit(0); }
if(args.includes('--help')) { console.log('--sandbox --cd --json workspace-write --print --output-format stream-json --verbose --permission-mode acceptEdits --allowedTools --tools'); process.exit(0); }
let input = ''; process.stdin.on('data', chunk => input += chunk); process.stdin.on('end', () => console.log(JSON.stringify({args,input,cwd:process.cwd()})));
`;
    for (const name of ['codex', 'claude']) { await writeFile(join(bin, name), stub, { mode: 0o755 }); }
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath}`;
    try {
      const codex = await runAgent('codex', { workspace: directory, prompt: 'approved evidence package' });
      expect(codex.outcome).toBe('completed');
      expect(codex.command?.command).toEqual(['codex', 'exec', '--sandbox', 'workspace-write', '--cd', directory, '--json', '-']);
      expect(JSON.parse(codex.command!.stdout).input).toBe('approved evidence package');
      const claude = await runAgent('claude', { workspace: directory, prompt: 'second agent, same evidence' });
      expect(claude.outcome).toBe('completed');
      expect(claude.command?.command).toContain('--permission-mode');
      expect(claude.command?.command).not.toContain('--dangerously-skip-permissions');
      expect(JSON.parse(claude.command!.stdout).input).toBe('second agent, same evidence');
    } finally { process.env.PATH = oldPath; }
  });
});
