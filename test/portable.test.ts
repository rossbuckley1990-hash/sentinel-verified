import { afterEach, describe, expect, it } from 'vitest';
import { cp, mkdtemp, readFile, rm, writeFile, stat, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { exportSession, importSession } from '../src/portable.js';
import { continuationContext, continueSession, loadCheckpoint, startSession } from '../src/session.js';
import { digest, getObject, readSnapshot } from '../src/store.js';
import type { Checkpoint, Receipt } from '../src/types.js';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function project(agent: 'fixture-interrupt' | 'fixture-fix' = 'fixture-interrupt') {
  const directory = await mkdtemp(join(tmpdir(), 'sentinel-portable-test-'));
  temporary.push(directory);
  const repo = join(directory, 'repo');
  const store = join(directory, 'source-store');
  await cp(resolve('fixtures/demo'), repo, { recursive: true });
  const contractPath = join(directory, 'approved.json');
  await cp(join(repo, 'contract.json'), contractPath);
  await rm(join(repo, 'contract.json'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'pipe' });
  execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'pipe' });
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'baseline'], { cwd: repo, stdio: 'pipe' });
  const objective = (JSON.parse(await readFile(contractPath, 'utf8')) as { objective: string }).objective;
  const checkpoint = await startSession({ repo, store, objective, contractPath, agent, localConsent: true });
  const bundle = join(directory, 'task.sentinel.json');
  return { directory, repo, store, checkpoint, bundle, contractPath, objective };
}
interface TestBundle { format: string; schemaVersion: number; checkpointHash: string; checkpoint: Checkpoint; objects: Record<string, string> }
async function readBundle(file: string): Promise<TestBundle> { return JSON.parse(await readFile(file, 'utf8')) as TestBundle; }
function replaceCheckpoint(bundle: TestBundle): void {
  delete bundle.objects[bundle.checkpointHash];
  const bytes = Buffer.from(JSON.stringify(bundle.checkpoint));
  bundle.checkpointHash = digest(bytes);
  bundle.objects[bundle.checkpointHash] = bytes.toString('base64');
}

describe('portable evidence checkpoints', () => {
  it('relocates exact source and historical evidence, then re-verifies in a new store', async () => {
    const p = await project('fixture-fix');
    expect(p.checkpoint.state).toBe('verified');
    const originalEnvelope = await readFile(join(p.store, 'sessions', p.checkpoint.id, 'checkpoint.json'), 'utf8');
    const exported = await exportSession(p.store, undefined, p.bundle);
    expect(exported.hash).toBe(digest(await readFile(p.bundle)));
    const otherStore = join(p.directory, 'receiving-machine', 'store');
    const imported = await importSession(otherStore, p.bundle);
    expect(imported.id).not.toBe(p.checkpoint.id);
    expect(imported.workspace).not.toBe(p.checkpoint.workspace);
    expect(imported.state).toBe('interrupted');
    expect(imported.localConsent).toBe(false);
    expect(imported.receipts).toEqual(p.checkpoint.receipts);
    expect(imported.baselineHash).toBe(p.checkpoint.baselineHash);
    expect(imported.contractHash).toBe(p.checkpoint.contractHash);
    expect((await readSnapshot(otherStore, imported.candidateHash)).files).toEqual((await readSnapshot(p.store, p.checkpoint.candidateHash)).files);
    expect(await readFile(join(imported.workspace, 'src/access.ts'), 'utf8')).toBe(await readFile(join(p.checkpoint.workspace, 'src/access.ts'), 'utf8'));
    expect(await readFile(join(p.store, 'sessions', p.checkpoint.id, 'checkpoint.json'), 'utf8')).toBe(originalEnvelope);
    expect(await continuationContext(otherStore, imported)).toContain('Historical evidence only');
    // Prove that continuation does not depend on the exporting machine's paths.
    await rm(p.repo, { recursive: true, force: true });
    await rm(p.store, { recursive: true, force: true });
    await expect(continueSession({ store: otherStore, agent: 'fixture-fix' })).rejects.toThrow('--allow-local');
    const resumed = await continueSession({ store: otherStore, agent: 'fixture-fix', localConsent: true });
    expect(resumed.state).toBe('verified');
    expect(resumed.localConsent).toBe(true);
    expect(resumed.receipts).toHaveLength(2);
    const newReceipt = JSON.parse((await getObject(otherStore, resumed.receipts.at(-1)!)).toString()) as Receipt;
    expect(newReceipt.candidateHash).toBe(resumed.candidateHash);
    expect(await loadCheckpoint(otherStore)).toEqual(resumed);
  });

  it('rejects corrupted and missing objects before writing a receiving session', async () => {
    const p = await project();
    await exportSession(p.store, p.checkpoint.id, p.bundle);
    const corrupt = await readBundle(p.bundle);
    corrupt.objects[p.checkpoint.contractHash!] = Buffer.from('{}').toString('base64');
    const corruptPath = join(p.directory, 'corrupt.sentinel.json');
    await writeFile(corruptPath, JSON.stringify(corrupt));
    const rejectedStore = join(p.directory, 'rejected');
    await expect(importSession(rejectedStore, corruptPath)).rejects.toThrow('integrity failure');
    await expect(access(rejectedStore)).rejects.toThrow();
    const missing = await readBundle(p.bundle);
    const source = await readSnapshot(p.store, p.checkpoint.candidateHash);
    delete missing.objects[source.files['src/access.ts']!.hash];
    const missingPath = join(p.directory, 'missing.sentinel.json');
    await writeFile(missingPath, JSON.stringify(missing));
    await expect(importSession(rejectedStore, missingPath)).rejects.toThrow('missing required object');
    await expect(access(rejectedStore)).rejects.toThrow();
  });

  it('rejects traversal and Git metadata source paths even when their hashes are recomputed', async () => {
    const p = await project();
    await exportSession(p.store, p.checkpoint.id, p.bundle);
    for (const unsafe of ['../escaped.ts', '.GIT/config', 'safe/../../escaped.ts']) {
      const bundle = await readBundle(p.bundle);
      const snapshotHash = bundle.checkpoint.candidateHash;
      const snapshot = JSON.parse(Buffer.from(bundle.objects[snapshotHash]!, 'base64').toString());
      snapshot.files[unsafe] = snapshot.files['src/access.ts'];
      delete snapshot.files['src/access.ts'];
      delete bundle.objects[snapshotHash];
      const bytes = Buffer.from(JSON.stringify(snapshot));
      const newHash = digest(bytes);
      bundle.objects[newHash] = bytes.toString('base64');
      bundle.checkpoint.candidateHash = newHash;
      replaceCheckpoint(bundle);
      const file = join(p.directory, `unsafe-${newHash.slice(0,8)}.json`);
      await writeFile(file, JSON.stringify(bundle));
      await expect(importSession(join(p.directory, 'rejected'), file)).rejects.toThrow('Unsafe portable source path');
    }
    await expect(access(join(p.directory, 'escaped.ts'))).rejects.toThrow();
  });

  it('refuses export of source drift and does not overwrite an existing bundle', async () => {
    const p = await project();
    await exportSession(p.store, p.checkpoint.id, p.bundle);
    const original = await readFile(p.bundle);
    await expect(exportSession(p.store, p.checkpoint.id, p.bundle)).rejects.toThrow();
    expect(await readFile(p.bundle)).toEqual(original);
    await writeFile(join(p.checkpoint.workspace, 'unrecorded.txt'), 'uncheckpointed');
    await expect(exportSession(p.store, p.checkpoint.id, join(p.directory, 'drift.json'))).rejects.toThrow('changed since');
  });

  it('rejects oversized contracts before parsing them', async () => {
    const p = await project();
    await writeFile(p.contractPath, ' '.repeat(1000001));
    await expect(startSession({ repo: p.repo, store: p.store, objective: p.objective, contractPath: p.contractPath, agent: 'fixture-interrupt', localConsent: true })).rejects.toThrow('at most 1000000 bytes');
    expect((await stat(p.contractPath)).size).toBe(1000001);
  });
});
