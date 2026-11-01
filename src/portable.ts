import { chmod, link, lstat, mkdir, open, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { acquireSessionLock, loadCheckpoint, parseCheckpoint, readLimitedText, saveCheckpoint } from './session.js';
import { atomicJson, captureSnapshot, digest, getObject, materializeSnapshot, putObject, readSnapshot, safeRelative } from './store.js';
import { parseContract, validateApprovalProposal } from './schema.js';
import { executionEnvironment, runCommand } from './process.js';
import type { Checkpoint, Receipt, Snapshot } from './types.js';

const MAX_BUNDLE_BYTES = 300_000_000;
const MAX_OBJECT_BYTES = 100_000_000;
const MAX_OBJECTS = 50000;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const short = z.string().max(10000);
const status = z.enum(['VERIFIED', 'CONTRADICTED', 'UNVERIFIED', 'REVIEW REQUIRED', 'ENVIRONMENT FAILURE']);
const gitIdentity = z.object({ root: z.string().max(8192), head: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/), branch: short, dirty: z.boolean() }).strict();
const command = z.object({
  command: z.array(z.string().max(100000)).min(1).max(200), input: z.string().max(30000000).optional(),
  outputFiles: z.record(z.string().max(1000), z.string().max(5000000)).optional(), cwd: z.string().max(8192),
  exitCode: z.number().int().nullable(), signal: z.string().max(100).nullable(), stdout: z.string().max(2000000), stderr: z.string().max(2000000),
  durationMs: z.number().finite().nonnegative(), timedOut: z.boolean(), truncated: z.boolean(),
}).strict();
const check = z.object({
  id: short, label: short, status, detail: short, requirementId: short.optional(), args: z.array(z.unknown()).max(20).optional(),
  expected: z.unknown().optional(), observed: z.unknown().optional(), baseline: z.unknown().optional(), command: command.optional(),
  counterexample: z.object({ original: z.array(z.unknown()).max(20), minimal: z.array(z.unknown()).max(20), attempts: z.number().int().nonnegative(), guarantee: short }).strict().optional(),
}).strict();
const receiptSchema = z.object({
  schemaVersion: z.literal(1), id: short, createdAt: z.string().max(100), objective: short,
  baselineHash: hash, candidateHash: hash, contractHash: hash.nullable(), git: gitIdentity, runner: z.enum(['local-advisory','container-isolated']), contract:z.unknown().optional(),
  checks: z.array(check).max(10000), changes: z.array(z.object({ path: z.string().max(8192), kind: z.enum(['added', 'modified', 'deleted']), classification: status, reason: short }).strict()).max(20000),
  status, durationMs: z.number().finite().nonnegative(), runtime: z.record(z.string().max(200), z.string().max(10000)).optional(), limitations: z.array(short).max(1000), nextActions: z.array(short).max(10000),
}).strict();
const snapshotSchema = z.object({
  schemaVersion: z.literal(1), git: gitIdentity,
  files: z.record(z.string().max(1024), z.object({ hash, size: z.number().int().nonnegative().max(20000000), mode: z.number().int().min(0).max(0o777) }).strict()),
}).strict();
interface Bundle {
  format: 'sentinel-checkpoint'; schemaVersion: 1; checkpointHash: string; checkpoint: Checkpoint; objects: Record<string, string>;
}

/** Reject excessive JSON nesting or graph size before traversing schemas recursively. */
function boundJson(value: unknown): void {
  const queue: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let nodes = 0;
  while (queue.length) {
    const entry = queue.pop()!;
    if (++nodes > 500000 || entry.depth > 64) throw new Error('Bundle JSON exceeds the supported structural limits.');
    if (typeof entry.value === 'number' && !Number.isFinite(entry.value)) throw new Error('Bundle contains a non-finite JSON number.');
    if (entry.value && typeof entry.value === 'object') {
      const values = Object.values(entry.value);
      if (values.length > MAX_OBJECTS) throw new Error('Bundle has too many entries in one object.');
      for (const child of values) queue.push({ value: child, depth: entry.depth + 1 });
    }
  }
}
function parseJson(bytes: Buffer): unknown { const value: unknown = JSON.parse(bytes.toString('utf8')); boundJson(value); return value; }
function safeSourcePath(name: string): boolean {
  if (!safeRelative(name) || name.length > 1024 || /[\x00-\x1f\x7f:]/.test(name)) return false;
  return !name.split('/').some(part => {
    const normalized = part.normalize('NFC').toLowerCase().replace(/[. ]+$/, '');
    return normalized === '.git' || normalized === 'node_modules' || normalized === '.sentinel';
  });
}
function validatePaths(files: Snapshot['files']): void {
  const names = Object.keys(files);
  if (names.length > 20000) throw new Error('Snapshot exceeds 20000 files.');
  const all = new Set(names);
  const spelling = new Map<string, string>();
  for (const name of names) {
    if (!safeSourcePath(name)) throw new Error(`Unsafe portable source path: ${JSON.stringify(name)}`);
    const parts = name.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join('/');
      if (i < parts.length && all.has(prefix)) throw new Error('Snapshot contains a file/directory path conflict.');
      const normalized = prefix.normalize('NFC').toLowerCase();
      const previous = spelling.get(normalized);
      if (previous && previous !== prefix) throw new Error('Snapshot contains case or Unicode-colliding paths, which cannot be restored portably.');
      spelling.set(normalized, prefix);
    }
  }
}

/** All validation finishes before publishing files or a latest-session pointer. */
function validateBundle(value: unknown): { bundle: Bundle; checkpoint: Checkpoint; objects: Map<string, Buffer> } {
  boundJson(value);
  const envelope = z.object({ format: z.literal('sentinel-checkpoint'), schemaVersion: z.literal(1), checkpointHash: hash, checkpoint: z.unknown(), objects: z.record(hash, z.string()) }).strict().parse(value);
  const checkpoint = parseCheckpoint(envelope.checkpoint);
  const encoded = Object.entries(envelope.objects);
  if (encoded.length > MAX_OBJECTS) throw new Error('Bundle contains too many content objects.');
  const objects = new Map<string, Buffer>();
  let total = 0;
  for (const [key, content] of encoded) {
    if (content.length > Math.ceil(MAX_OBJECT_BYTES / 3) * 4) throw new Error('Bundle content object exceeds 100 MB.');
    const bytes = Buffer.from(content, 'base64');
    if (bytes.length > MAX_OBJECT_BYTES || bytes.toString('base64') !== content) throw new Error('Bundle content must use canonical, bounded base64.');
    total += bytes.length;
    if (total > MAX_BUNDLE_BYTES) throw new Error('Bundle decoded content exceeds 300 MB.');
    if (digest(bytes) !== key) throw new Error(`Bundle object integrity failure: ${key}`);
    objects.set(key, bytes);
  }
  const used = new Set<string>();
  const get = (key: string): Buffer => {
    hash.parse(key);
    const bytes = objects.get(key);
    if (!bytes) throw new Error(`Bundle is missing required object ${key}`);
    used.add(key);
    return bytes;
  };
  if (get(envelope.checkpointHash).toString() !== JSON.stringify(envelope.checkpoint)) throw new Error('Bundle checkpoint does not match its content object.');
  for (const run of checkpoint.agents) {
    if(run.command) command.parse(run.command);
    if(run.handoff){const context=get(run.handoff.contextHash).toString();if(run.command?.input!==context)throw new Error('Handoff context differs from the recorded agent input.');if(run.handoff.contractHash!==checkpoint.contractHash)throw new Error('Handoff uses a different approved contract.');}
  }
  if (checkpoint.contractHash) {
    const bytes = get(checkpoint.contractHash);
    if (bytes.length > 1000000) throw new Error('Approved contract exceeds 1 MB.');
    const contract = parseContract(parseJson(bytes));
    if(contract.approval){validateApprovalProposal(contract,parseJson(get(contract.approval.proposalHash)));if(contract.approval.baselineHash!==checkpoint.baselineHash)throw new Error('Approved baseline differs from checkpoint baseline.');}
    if (contract.objective !== checkpoint.objective) throw new Error('Bundle objective differs from its approved contract.');
  }
  const snapshots = new Map<string, Omit<Snapshot, 'hash'>>();
  const visitSnapshot = (key: string): Omit<Snapshot, 'hash'> => {
    const previous = snapshots.get(key);
    if (previous) return previous;
    const bytes = get(key);
    if (bytes.length > 10000000) throw new Error('Snapshot manifest exceeds 10 MB.');
    const snapshot = snapshotSchema.parse(parseJson(bytes));
    validatePaths(snapshot.files);
    let size = 0;
    for (const file of Object.values(snapshot.files)) {
      const source = get(file.hash);
      if (source.length !== file.size) throw new Error('Snapshot file size does not match its content object.');
      size += source.length;
    }
    if (size > 100000000) throw new Error('Snapshot source exceeds 100 MB.');
    snapshots.set(key, snapshot);
    return snapshot;
  };
  visitSnapshot(checkpoint.baselineHash);
  visitSnapshot(checkpoint.candidateHash);
  for(const run of checkpoint.agents)if(run.handoff)visitSnapshot(run.handoff.sourceHash);
  for (const receiptHash of checkpoint.receipts) {
    const receipt = receiptSchema.parse(parseJson(get(receiptHash)));
    if (receipt.baselineHash !== checkpoint.baselineHash || receipt.contractHash !== checkpoint.contractHash) throw new Error('Receipt does not belong to the checkpoint baseline and contract.');
    if(receipt.contract){const embedded=parseContract(receipt.contract);if(!receipt.contractHash||JSON.stringify(embedded)!==JSON.stringify(parseContract(parseJson(get(receipt.contractHash)))))throw new Error('Receipt approved contract differs from its content identity.');}
    visitSnapshot(receipt.baselineHash);
    const candidate = visitSnapshot(receipt.candidateHash);
    if (JSON.stringify(candidate.git) !== JSON.stringify(receipt.git)) throw new Error('Receipt source identity differs from its candidate snapshot.');
  }
  if (used.size !== objects.size) throw new Error('Bundle contains objects outside the selected checkpoint evidence chain.');
  return { bundle: envelope as Bundle, checkpoint, objects };
}

export async function exportSession(store: string, id: string | undefined, outFile: string): Promise<{ path: string; hash: string }> {
  store = await realpath(resolve(store));
  const selected = await loadCheckpoint(store, id);
  const release = await acquireSessionLock(store, selected.id);
  try {
    const checkpoint = await loadCheckpoint(store, selected.id);
    if (checkpoint.state === 'running') throw new Error('The session is marked running. Recover or finish it before exporting its checkpoint.');
    const current = await captureSnapshot(checkpoint.workspace, store);
    if (current.hash !== checkpoint.candidateHash) throw new Error('Workspace changed since its checkpoint. Continue with --adopt-changes before exporting.');
    const objects: Record<string, string> = Object.create(null) as Record<string, string>;
    let encodedBytes = 0;
    const addBytes = (key: string, bytes: Buffer): void => {
      if (Object.hasOwn(objects, key)) return;
      const encoded = bytes.toString('base64');
      encodedBytes += encoded.length;
      if (encodedBytes > MAX_BUNDLE_BYTES) throw new Error('Portable bundle exceeds 300 MB.');
      objects[key] = encoded;
    };
    const add = async (key: string): Promise<Buffer> => { const bytes = await getObject(store, key); addBytes(key, bytes); return bytes; };
    const addSnapshot = async (key: string): Promise<void> => {
      if (Object.hasOwn(objects, key)) return;
      const snapshot = await readSnapshot(store, key);
      await add(key);
      for (const file of Object.values(snapshot.files)) await add(file.hash);
    };
    const checkpointBytes = Buffer.from(JSON.stringify(checkpoint));
    const checkpointHash = digest(checkpointBytes);
    addBytes(checkpointHash, checkpointBytes);
    await addSnapshot(checkpoint.baselineHash);
    await addSnapshot(checkpoint.candidateHash);
    for(const run of checkpoint.agents)if(run.handoff){await add(run.handoff.contextHash);await addSnapshot(run.handoff.sourceHash);}
    if (checkpoint.contractHash) {const contract=parseContract(JSON.parse((await add(checkpoint.contractHash)).toString()));if(contract.approval){await add(contract.approval.proposalHash);await addSnapshot(contract.approval.baselineHash);}}
    for (const key of checkpoint.receipts) {
      const receipt = JSON.parse((await add(key)).toString()) as Receipt;
      await addSnapshot(receipt.baselineHash);
      await addSnapshot(receipt.candidateHash);
    }
    const bundle: Bundle = { format: 'sentinel-checkpoint', schemaVersion: 1, checkpointHash, checkpoint, objects };
    validateBundle(bundle);
    const text = JSON.stringify(bundle);
    if (Buffer.byteLength(text) > MAX_BUNDLE_BYTES) throw new Error('Portable bundle exceeds 300 MB including metadata.');
    const path = resolve(outFile);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally { await handle.close(); }
    try { await link(temporary, path); } finally { await rm(temporary, { force: true }); }
    return { path, hash: digest(text) };
  } finally { await release(); }
}

async function safeStoreDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Session store subdirectories must be real directories, not symbolic links.');
}
async function importedGit(args: string[], cwd: string): Promise<void> {
  const result = await runCommand(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'core.attributesFile=/dev/null', '-c', 'core.autocrlf=false', ...args], cwd, {
    timeoutMs: 30000,
    env: { ...executionEnvironment(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_ATTR_NOSYSTEM: '1' },
  });
  if (result.exitCode !== 0) throw new Error(`Imported workspace Git setup failed: ${result.stderr}`);
}

export async function importSession(store: string, file: string): Promise<Checkpoint> {
  const source = await readLimitedText(resolve(file), MAX_BUNDLE_BYTES);
  const { checkpoint: original, objects } = validateBundle(JSON.parse(source));
  await safeStoreDirectory(resolve(store));
  store = await realpath(resolve(store));
  for (const name of ['objects', 'sessions', 'workspaces']) await safeStoreDirectory(join(store, name));
  const id = `s-import-${Date.now().toString(36)}-${randomUUID()}`;
  const workspace = join(store, 'workspaces', id);
  // A fresh, locally generated ID determines every destination; imported paths are metadata only.
  await mkdir(workspace, { mode: 0o700 });
  let published = false;
  try {
    for (const [key, bytes] of objects) if (await putObject(store, bytes) !== key) throw new Error('Import object hash mismatch.');
    const previousSource = await readSnapshot(store, original.candidateHash);
    await materializeSnapshot(store, previousSource, workspace);
    for (const [name, entry] of Object.entries(previousSource.files)) await chmod(join(workspace, name), entry.mode);
    await importedGit(['init', '--template=', '-b', 'sentinel-import'], workspace);
    await importedGit(['config', 'core.fsmonitor', 'false'], workspace);
    await importedGit(['config', 'core.hooksPath', '/dev/null'], workspace);
    await importedGit(['add', '--force', '--all'], workspace);
    await importedGit(['-c', 'user.name=SENTINEL', '-c', 'user.email=sentinel@localhost', 'commit', '--allow-empty', '-m', 'Imported SENTINEL checkpoint'], workspace);
    await mkdir(join(workspace, '.git', 'info'), { recursive: true });
    await writeFile(join(workspace, '.git', 'info', 'exclude'), '\nnode_modules/\n');
    const candidate = await captureSnapshot(workspace, store);
    if (JSON.stringify(candidate.files) !== JSON.stringify(previousSource.files)) throw new Error('Imported source differs from the checkpoint snapshot.');
    const checkpoint: Checkpoint = {
      ...original, id, repo: workspace, workspace, candidateHash: candidate.hash, state: 'interrupted', localConsent: false, isolatedConsent:false,
      updatedAt: new Date().toISOString(),
      nextActions: ['Review the imported source and any dependency installation commands.', 'Continue with an available agent and --allow-local to rerun independent checks in this environment.'],
      openQuestions: [...original.openQuestions, `Imported from session ${original.id}. Prior receipts retain their original source identities; this environment has not been verified.`, 'Dependencies are not included. Install reviewed dependencies in the imported workspace if needed; never treat a bundle as trusted executable code.'],
    };
    await saveCheckpoint(store, checkpoint);
    published = true;
    await atomicJson(join(store, 'latest.json'), { schemaVersion: 1, id });
    return checkpoint;
  } finally {
    if (!published) { await rm(workspace, { recursive: true, force: true }); await rm(join(store, 'sessions', id), { recursive: true, force: true }); }
  }
}
