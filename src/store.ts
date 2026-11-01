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
  if(Buffer.byteLength(value)>32_000_000)throw new Error('Evidence object exceeds the 32 MB limit');
  const hash = digest(value); const dir = path.join(store, 'objects'); await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, hash);
  const temp=path.join(dir,`.${hash}.${randomUUID()}.tmp`);
  try {
    const handle=await fs.open(temp,'wx',0o444);try{await handle.writeFile(value);await handle.sync();}finally{await handle.close();}
    try{await fs.link(temp,file);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;await getObject(store,hash);}
  }finally{await fs.rm(temp,{force:true});}
  return hash;
}
export async function getObject(store: string, hash: string): Promise<Buffer> {
  if (!hashPattern.test(hash)) throw new Error('Invalid object hash');
  const file=path.join(store,'objects',hash);const stat=await fs.lstat(file);if(!stat.isFile()||stat.size>32_000_000)throw new Error('Evidence object must be a regular file of at most 32 MB');
  const bytes = await fs.readFile(file);if(bytes.length>32_000_000)throw new Error('Evidence object exceeds the 32 MB limit');
  if (digest(bytes) !== hash) throw new Error(`Evidence integrity failure: ${hash}`); return bytes;
}
// Missing objects must fail locally, never launch a promisor remote helper or
// credentials/network operation while reading untrusted repository metadata.
const gitReadEnvironment=():NodeJS.ProcessEnv=>({...process.env,GIT_NO_LAZY_FETCH:'1',GIT_ALLOW_PROTOCOL:'',GIT_TERMINAL_PROMPT:'0'});
async function git(root: string, args: string[]): Promise<string> { return (await exec('git', ['--no-optional-locks','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-C',root,...args], { maxBuffer: 32 * 1024 * 1024, timeout:30000, env:gitReadEnvironment() })).stdout.trimEnd(); }
interface RawIndexEntry { mode: string; oid: string }
/** git status/diff can execute repository clean/process filters while hashing.
 * Compare raw Git objects and filesystem bytes without asking Git to convert
 * worktree content. EOL/filter-normalised checkouts may conservatively be dirty.
 */
async function rawWorktreeDirty(root: string, head: string): Promise<boolean> {
  const [tree, index, untracked] = await Promise.all([
    git(root,['ls-tree','-rz','--full-tree',head]),
    git(root,['ls-files','--stage','-z']),
    git(root,['ls-files','--others','--exclude-standard','-z']),
  ]);
  if(untracked.length)return true;
  const committed=new Map<string,RawIndexEntry>();
  for(const item of tree.split('\0').filter(Boolean)){
    const tab=item.indexOf('\t'),name=item.slice(tab+1);const [mode,,oid]=item.slice(0,tab).split(' ');
    if(tab<0||!safeRelative(name)||!mode||!oid)throw new Error('Invalid raw Git tree entry');
    committed.set(name,{mode,oid});
  }
  const staged=new Map<string,RawIndexEntry>();
  for(const item of index.split('\0').filter(Boolean)){
    const tab=item.indexOf('\t'),name=item.slice(tab+1);const [mode,oid,stage]=item.slice(0,tab).split(' ');
    if(tab<0||!safeRelative(name)||!mode||!oid)throw new Error('Invalid raw Git index entry');
    if(stage!=='0')return true;
    staged.set(name,{mode,oid});
  }
  if(staged.size!==committed.size)return true;
  for(const [name,entry] of staged){const before=committed.get(name);if(!before||before.mode!==entry.mode||before.oid!==entry.oid)return true;}
  const algorithm=head.length===40?'sha1':head.length===64?'sha256':null;
  if(!algorithm)throw new Error('Unsupported Git object format');
  let total=0;
  for(const [name,entry] of staged){
    const file=path.join(root,name);let stat;
    try{stat=await fs.lstat(file);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return true;throw error;}
    if(!stat.isFile())return true;
    const real=await fs.realpath(file);if(!real.startsWith(root+path.sep))throw new Error(`Path escapes repository: ${name}`);
    if(stat.size>20_000_000||total+stat.size>100_000_000)throw new Error('Snapshot exceeds 20 MB/file or 100 MB total limit');
    const bytes=await fs.readFile(file);total+=bytes.length;
    if(bytes.length>20_000_000||total>100_000_000)throw new Error('Snapshot exceeds 20 MB/file or 100 MB total limit');
    const mode=(stat.mode&0o111)?'100755':'100644';
    const oid=createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if(mode!==entry.mode||oid!==entry.oid)return true;
  }
  return false;
}
export async function gitIdentity(root: string): Promise<GitIdentity> {
  const [canonical,head,branch]=await Promise.all([fs.realpath(root),git(root,['rev-parse','HEAD']),git(root,['branch','--show-current'])]);
  return { root: canonical, head, branch, dirty: await rawWorktreeDirty(canonical,head) };
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
  const listing = (await exec('git',['--no-optional-locks','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-C',root,'ls-files','--cached','--others','--exclude-standard','-z'],{maxBuffer:32*1024*1024,timeout:30000,env:gitReadEnvironment()})).stdout;
  const files: Record<string,FileEntry> = Object.create(null); let total = 0;
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
  const [canonical,branch]=await Promise.all([fs.realpath(root),git(root,['branch','--show-current'])]);
  const identity = { root:canonical, branch, head: commit, dirty: false };
  const listing = (await exec('git',['--no-optional-locks','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-C',root,'ls-tree','-rz','--full-tree',commit],{maxBuffer:32*1024*1024,timeout:30000,env:gitReadEnvironment()})).stdout;
  const files: Record<string,FileEntry> = Object.create(null); let total=0;
  for(const item of listing.split('\0').filter(Boolean)) {
    const tab=item.indexOf('\t'); const name=item.slice(tab+1); const [mode,type,oid]=item.slice(0,tab).split(' ');
    if(!safeRelative(name) || type!=='blob' || mode==='120000') throw new Error(`Unsupported baseline file: ${name}`);
    if(name.split('/').some(x=>x==='node_modules'||x==='.sentinel')) continue;
    const {stdout: bytes} = await exec('git',['--no-optional-locks','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-C',root,'cat-file','blob',oid!],{encoding:'buffer',maxBuffer:20_000_001,timeout:30000,env:gitReadEnvironment()});
    total+=bytes.length; if(bytes.length>20_000_000||total>100_000_000) throw new Error('Snapshot size limit exceeded');
    files[name]={hash:await putObject(store,bytes),size:bytes.length,mode:parseInt(mode!,8)&0o777};
  }
  return saveSnapshot(store, files, identity);
}
export async function materializeSnapshot(store: string, snapshot: Snapshot, dest: string): Promise<void> {
  const canonical=await readSnapshot(store,snapshot.hash);
  if(JSON.stringify(canonical)!==JSON.stringify(snapshot))throw new Error('Snapshot manifest does not match its content hash');
  await fs.mkdir(dest,{recursive:true});
  if ((await fs.readdir(dest)).length) throw new Error('Snapshot destination must be empty');
  for(const [name,entry] of Object.entries(snapshot.files)) { if(!safeRelative(name)) throw new Error('Invalid path'); const target=path.join(dest,name); await fs.mkdir(path.dirname(target),{recursive:true}); await fs.writeFile(target,await getObject(store,entry.hash),{mode:entry.mode});await fs.chmod(target,entry.mode); }
}
export async function sameFiles(a: Snapshot,b: Snapshot): Promise<boolean> { return JSON.stringify(a.files)===JSON.stringify(b.files); }
