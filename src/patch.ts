import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { link, mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { acquireSessionLock, loadCheckpoint } from './session.js';
import { captureSnapshot, digest, getObject, materializeSnapshot, readSnapshot } from './store.js';
import { executionEnvironment, runCommand } from './process.js';
import type { Receipt, Snapshot, Status } from './types.js';

const exec = promisify(execFile);
const MAX_PATCH_BYTES = 20_000_000;
const gitEnvironment = (): NodeJS.ProcessEnv => ({
  ...executionEnvironment(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null', GIT_ATTR_NOSYSTEM: '1', GIT_NO_LAZY_FETCH: '1',
  GIT_ALLOW_PROTOCOL: '', GIT_TERMINAL_PROMPT: '0',
});
const gitFlags = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null',
  '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', '-c', 'core.quotePath=true'];
async function git(cwd: string, args: string[]): Promise<string> {
  const result = await exec('git', [...gitFlags, ...args], { cwd, env: gitEnvironment(), timeout: 30000, maxBuffer: MAX_PATCH_BYTES });
  return result.stdout;
}

/** Construct raw trees without ever running clean filters, hooks or user Git configuration. */
async function treeFor(store: string, snapshot: Snapshot, gitRoot: string, sourceRoot: string): Promise<string> {
  await materializeSnapshot(store, snapshot, sourceRoot);
  await git(gitRoot, ['read-tree', '--empty']);
  const entries: string[] = [];
  for (const [name, file] of Object.entries(snapshot.files)) {
    const object = (await git(gitRoot, ['hash-object', '-w', '--no-filters', '--', join(sourceRoot, name)])).trim();
    if (!/^[a-f0-9]{40,64}$/.test(object)) throw new Error('Git did not return a source object identity.');
    entries.push(`${file.mode & 0o111 ? '100755' : '100644'} ${object}\t${name}\0`);
  }
  const record = await runCommand(['git', ...gitFlags, 'update-index', '-z', '--index-info'], gitRoot,
    { input: entries.join(''), timeoutMs: 30000, env: gitEnvironment() });
  if (record.exitCode !== 0 || record.timedOut || record.truncated) throw new Error(`Patch index construction failed: ${record.stderr}`);
  return (await git(gitRoot, ['write-tree'])).trim();
}

async function canonicalDestination(file: string): Promise<string> {
  const tail = [basename(file)];
  let directory = dirname(file);
  for (;;) {
    try { return join(await realpath(directory), ...tail); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(directory);
      if (parent === directory) throw error;
      tail.unshift(basename(directory)); directory = parent;
    }
  }
}

export interface PatchExport {
  path: string; hash: string; bytes: number; baselineHash: string; candidateHash: string;
  files: string[]; targetMatchesBaseline: boolean; applyCheck: 'passed'; verificationStatus: Status;
  instructions: string[];
}

/** Export exact captured changes for review. No command here changes the input repository. */
export async function exportSessionPatch(store: string, id: string | undefined, outFile: string): Promise<PatchExport> {
  store = await realpath(resolve(store));
  const selected = await loadCheckpoint(store, id);
  const release = await acquireSessionLock(store, selected.id);
  let scratch: string | undefined;
  try {
    const checkpoint = await loadCheckpoint(store, selected.id);
    if (checkpoint.state === 'running') throw new Error('Finish or recover the running session before exporting changes.');
    const current = await captureSnapshot(checkpoint.workspace, store);
    if (current.hash !== checkpoint.candidateHash) throw new Error('Workspace changed since its checkpoint. Continue with --adopt-changes before exporting a patch.');
    const baseline = await readSnapshot(store, checkpoint.baselineHash);
    const candidate = await readSnapshot(store, checkpoint.candidateHash);
    const files = [...new Set([...Object.keys(baseline.files), ...Object.keys(candidate.files)])].filter(name => !isDeepStrictEqual(baseline.files[name], candidate.files[name])).sort();
    if (!files.length) throw new Error('There are no captured source changes to export.');
    const output = await canonicalDestination(resolve(outFile));
    if (output.split(/[\\/]/).includes('.git') || output === store || output.startsWith(store + sep)) throw new Error('Choose a patch destination outside Git metadata and the evidence store.');
    scratch = await mkdtemp(join(tmpdir(), 'sentinel-patch-'));
    const gitRoot = join(scratch, 'git');
    await mkdir(gitRoot);
    await git(gitRoot, ['init', '--template=', '-b', 'sentinel-patch']);
    const before = await treeFor(store, baseline, gitRoot, join(scratch, 'before'));
    const after = await treeFor(store, candidate, gitRoot, join(scratch, 'after'));
    const { stdout: patch } = await exec('git', [...gitFlags, 'diff', '--binary', '--full-index', '--no-renames', '--no-ext-diff', '--no-textconv', before, after, '--'],
      { cwd: gitRoot, env: gitEnvironment(), timeout: 30000, maxBuffer: MAX_PATCH_BYTES, encoding: 'buffer' });
    if (!patch.length || patch.length > MAX_PATCH_BYTES) throw new Error('Patch is empty or exceeds the 20 MB export bound.');
    const patchFile = join(scratch, 'change.patch');
    const patchHandle = await open(patchFile, 'wx', 0o600);
    try { await patchHandle.writeFile(patch); } finally { await patchHandle.close(); }
    // Check in a disposable copy of the exact approved baseline, never in a developer's checkout.
    await git(join(scratch, 'before'), ['apply', '--check', '--', patchFile]);
    let targetMatchesBaseline = false;
    try {
      const target = await captureSnapshot(checkpoint.repo, store);
      targetMatchesBaseline = target.git.head === baseline.git.head && isDeepStrictEqual(target.files, baseline.files);
    } catch { /* The original checkout can move/disappear; the exact historical patch is still useful. */ }
    const last = checkpoint.receipts.at(-1);
    const receipt: Receipt | undefined = last ? JSON.parse((await getObject(store, last)).toString()) as Receipt : undefined;
    const verificationStatus: Status = checkpoint.state === 'verified' && receipt?.candidateHash === candidate.hash ? receipt.status : 'UNVERIFIED';
    await mkdir(dirname(output), { recursive: true });
    const temporary = `${output}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(patch); await handle.sync(); } finally { await handle.close(); }
    try { await link(temporary, output); } finally { await rm(temporary, { force: true }); }
    return { path: output, hash: digest(patch), bytes: Buffer.byteLength(patch), baselineHash: baseline.hash, candidateHash: candidate.hash,
      files, targetMatchesBaseline, applyCheck: 'passed', verificationStatus,
      instructions: [
        'Review the patch and its independently checked scope before applying it.',
        targetMatchesBaseline ? 'The original checkout matched the captured baseline when exported. Check again before applying.' : 'The original checkout differs from the baseline or is unavailable. Apply on the recorded baseline, or resolve the differences manually.',
        'Run git apply --check PATCH in the intended checkout, then git apply PATCH only when you approve those changes.',
        'Patch export did not modify or merge into the original project.',
      ] };
  } finally { if (scratch) await rm(scratch, { recursive: true, force: true }); await release(); }
}
