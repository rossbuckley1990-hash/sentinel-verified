import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { captureSnapshot, captureRevision, materializeSnapshot, putObject } from '../src/store.js';
import { verify } from '../src/verifier.js';
import type { Contract } from '../src/types.js';

const exec = promisify(execFile);
const allocated: string[] = [];
const dependencies = resolve('node_modules');
const contract: Contract = {
  schemaVersion: 1, objective: 'Reject string ages', approvedBy: 'controlled security regression', allowedPaths: ['src/access.js'],
  requirements: [{ id: 'reject-string', kind: 'must-change', description: 'String ages are invalid', module: 'src/access.js', export: 'isAdult', cases: [{ args: ['18'], expected: false }] }],
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sentinel-security-'));
  allocated.push(root);
  const repo = join(root, 'repo');
  const store = join(root, 'store');
  await mkdir(join(repo, 'src'), { recursive: true });
  await mkdir(store);
  await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'sentinel-security-regression', private: true, type: 'module' }));
  await writeFile(join(repo, 'src/access.js'), 'export function isAdult(age) { return age >= 18; }\n');
  await writeFile(join(repo, 'src/access.test.js'), 'import { test, expect } from "vitest";\nimport { isAdult } from "./access.js";\ntest("ordinary ages", () => { expect(isAdult(18)).toBe(true); expect(isAdult(17)).toBe(false); });\n');
  await exec('git', ['init', '-b', 'main'], { cwd: repo });
  await exec('git', ['add', '--all'], { cwd: repo });
  await exec('git', ['-c', 'user.name=SENTINEL', '-c', 'user.email=sentinel@localhost', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'Controlled regression fixture'], { cwd: repo });
  return { root, repo, store };
}

afterEach(async () => { await Promise.all(allocated.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe('source and verification evidence boundaries', () => {
  it('rejects a caller-mutated snapshot manifest instead of executing bytes under an old hash', async () => {
    const { root, repo, store } = await fixture();
    const baseline = await captureSnapshot(repo, store);
    const candidate = structuredClone(baseline);
    const replacement = 'export function isAdult(age) { return typeof age === "number" && age >= 18; }\n';
    candidate.files['src/access.js'] = { hash: await putObject(store, replacement), size: Buffer.byteLength(replacement), mode: 0o644 };
    await expect(materializeSnapshot(store, candidate, join(root, 'output'))).rejects.toThrow(/manifest|hash|integrity/i);
    const contractHash = await putObject(store, JSON.stringify(contract));
    await expect(verify({ store, baseline, candidate, contract, contractHash, dependencies })).rejects.toThrow(/manifest|hash|integrity/i);
  });

  it('does not verify a source file secretly repaired by an ordinary test', async () => {
    const { repo, store } = await fixture();
    const baseline = await captureSnapshot(repo, store);
    const repaired = 'export function isAdult(age) { return typeof age === "number" && Number.isInteger(age) && age >= 18; }\n';
    await writeFile(join(repo, 'src/access.test.js'), `import { test, expect } from 'vitest';\nimport { writeFileSync } from 'node:fs';\nimport { resolve } from 'node:path';\ntest('claims green while repairing the execution copy', () => { writeFileSync(resolve('src/access.js'), ${JSON.stringify(repaired)}); expect(true).toBe(true); });\n`);
    const candidate = await captureSnapshot(repo, store);
    const contractHash = await putObject(store, JSON.stringify(contract));
    const receipt = await verify({ store, baseline, candidate, contract, contractHash, dependencies });
    expect(receipt.checks.find(check => check.id === 'candidate-tests')?.status).toBe('VERIFIED');
    expect(receipt.checks.find(check => check.id === 'execution-integrity:candidate')?.status).toBe('ENVIRONMENT FAILURE');
    expect(receipt.checks.find(check => check.requirementId === 'reject-string')?.status).toBe('CONTRADICTED');
    expect(receipt.status).toBe('ENVIRONMENT FAILURE');
    // The test repaired only the expendable execution copy, not the recorded source.
    expect(await readFile(join(repo, 'src/access.js'), 'utf8')).toContain('return age >= 18');
  });

  it('preserves a literal __proto__ filename in working-tree and revision snapshots', async () => {
    const { root, repo, store } = await fixture();
    const source = 'A file name is data, not an object prototype.\n';
    await writeFile(join(repo, '__proto__'), source);
    await exec('git', ['add', '__proto__'], { cwd: repo });
    await exec('git', ['-c', 'user.name=SENTINEL', '-c', 'user.email=sentinel@localhost', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'Track prototype-like filename'], { cwd: repo });
    const working = await captureSnapshot(repo, store);
    const revision = await captureRevision(repo, 'HEAD', store);
    expect(Object.hasOwn(working.files, '__proto__')).toBe(true);
    expect(Object.hasOwn(revision.files, '__proto__')).toBe(true);
    expect(working.files['__proto__']?.hash).toBe(revision.files['__proto__']?.hash);
    await materializeSnapshot(store, revision, join(root, 'reproduced'));
    expect(await readFile(join(root, 'reproduced/__proto__'), 'utf8')).toBe(source);
  });
});
