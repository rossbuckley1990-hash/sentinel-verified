import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Snapshot, GitIdentity, FileEntry } from './types.js';
const exec = promisify(execFile);
const hashPattern = /^[a-f0-9]{64}$/;
export const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export function safeRelative(value: string): boolean { return value.length > 0 && !path.isAbsolute(value) && !value.includes('\\') && !value.split('/').some(x => x === '..' || x === '.' || x === '' || x === '.git'); }
export async function atomicJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temp, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(temp, file);
}
export async function putObject(store: string, value: string | Buffer): Promise<string> {
  const hash = digest(value); const dir = path.join(store, 'objects'); await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, hash);
  try { await fs.writeFile(file, value, { flag: 'wx', mode: 0o444 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; await getObject(store, hash); }
  return hash;
}
export async function getObject(store: string, hash: string): Promise<Buffer> {
  if (!hashPattern.test(hash)) throw new Error('Invalid object hash');
  const bytes = await fs.readFile(path.join(store, 'objects', hash));
  if (digest(bytes) !== hash) throw new Error(`Evidence integrity failure: ${hash}`); return bytes;
}
async function git(root: string, args: string[]): Promise<string> { return (await exec('git', ['-C',root,...args], { maxBuffer: 32 * 1024 * 1024 })).stdout.trimEnd(); }
export async function gitIdentity(root: string): Promise<GitIdentity> {
  return { root: await fs.realpath(root), head: await git(root,['rev-parse','HEAD']), branch: await git(root,['branch','--show-current']), dirty: !!(await git(root,['status','--porcelain'])) };
}
async function saveSnapshot(store: string, files: Record<string,FileEntry>, identity: GitIdentity): Promise<Snapshot> {
  const payload = { schemaVersion: 1 as const, files: Object.fromEntries(Object.entries(files).sort(([a],[b])=>a.localeCompare(b))), git: identity };
  const hash = await putObject(store, JSON.stringify(payload));
  const snapshot: Snapshot = { ...payload, hash }; return snapshot;
}
export async function readSnapshot(store: string, hash: string): Promise<Snapshot> {
  const s = JSON.parse((await getObject(store, hash)).toString()) as Omit<Snapshot,'hash'>;
  if (s.schemaVersion !== 1 || !s.files || !s.git || typeof s.git.head !== 'string') throw new Error('Unsupported or corrupted snapshot schema');
  for (const [name,entry] of Object.entries(s.files)) { if (!safeRelative(name) || !hashPattern.test(entry.hash) || !Number.isInteger(entry.mode)) throw new Error('Invalid snapshot file'); await getObject(store,entry.hash); }
  return { ...s, hash };
}
export async function captureSnapshot(root: string, store: string): Promise<Snapshot> {
  const identity = await gitIdentity(root);
  const listing = (await exec('git',['-C',root,'ls-files','--cached','--others','--exclude-standard','-z'],{maxBuffer:32*1024*1024})).stdout;
  const files: Record<string,FileEntry> = {}; let total = 0;
  for (const name of [...new Set(listing.split('\0').filter(Boolean))].sort()) {
    if (!safeRelative(name)) throw new Error(`Unsafe path: ${name}`);
    if (name.split('/').some(x=>x==='node_modules'||x==='.sentinel')) continue;
    const file = path.join(root,name); let stat;
    try { stat = await fs.lstat(file); } catch(e) { if((e as NodeJS.ErrnoException).code==='ENOENT') continue; throw e; }
    if (!stat.isFile()) throw new Error(`Unsupported symlink, submodule, or special file: ${name}`);
    const real = await fs.realpath(file); if (!real.startsWith(identity.root + path.sep)) throw new Error(`Path escapes repository: ${name}`);
    total += stat.size; if (stat.size > 20_000_000 || total > 100_000_000) throw new Error('Snapshot exceeds 20 MB/file or 100 MB total limit');
    const bytes = await fs.readFile(file); files[name] = { hash: await putObject(store,bytes), size: bytes.length, mode: stat.mode & 0o777 };
  }
  return saveSnapshot(store, files, identity);
}
export async function captureRevision(root: string, ref: string, store: string): Promise<Snapshot> {
  const commit = await git(root,['rev-parse','--verify',`${ref}^{commit}`]);
  const identity = { ...(await gitIdentity(root)), head: commit, dirty: false };
  const listing = (await exec('git',['-C',root,'ls-tree','-rz','--full-tree',commit],{maxBuffer:32*1024*1024})).stdout;
  const files: Record<string,FileEntry> = {}; let total=0;
  for(const item of listing.split('\0').filter(Boolean)) {
    const tab=item.indexOf('\t'); const name=item.slice(tab+1); const [mode,type,oid]=item.slice(0,tab).split(' ');
    if(!safeRelative(name) || type!=='blob' || mode==='120000') throw new Error(`Unsupported baseline file: ${name}`);
    if(name.split('/').some(x=>x==='node_modules'||x==='.sentinel')) continue;
    const {stdout: bytes} = await exec('git',['-C',root,'cat-file','blob',oid!],{encoding:'buffer',maxBuffer:20_000_001});
    total+=bytes.length; if(bytes.length>20_000_000||total>100_000_000) throw new Error('Snapshot size limit exceeded');
    files[name]={hash:await putObject(store,bytes),size:bytes.length,mode:parseInt(mode!,8)&0o777};
  }
  return saveSnapshot(store, files, identity);
}
export async function materializeSnapshot(store: string, snapshot: Snapshot, dest: string): Promise<void> {
  await readSnapshot(store,snapshot.hash);
  await fs.mkdir(dest,{recursive:true});
  if ((await fs.readdir(dest)).length) throw new Error('Snapshot destination must be empty');
  for(const [name,entry] of Object.entries(snapshot.files)) { if(!safeRelative(name)) throw new Error('Invalid path'); const target=path.join(dest,name); await fs.mkdir(path.dirname(target),{recursive:true}); await fs.writeFile(target,await getObject(store,entry.hash),{mode:entry.mode}); }
}
export async function sameFiles(a: Snapshot,b: Snapshot): Promise<boolean> { return JSON.stringify(a.files)===JSON.stringify(b.files); }
