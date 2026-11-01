import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { putObject, getObject, safeRelative, captureSnapshot, materializeSnapshot } from '../src/store.js';
import { parseContract } from '../src/schema.js';
import { runCommand } from '../src/process.js';
const contract={schemaVersion:1,objective:'validate',approvedBy:'test owner',requirements:[{id:'a',kind:'must-change',description:'validate',module:'src/a.ts',export:'f',cases:[{args:[1],expected:true}]}]};
describe('trust and storage boundaries',()=>{
 it('rejects malformed, duplicate, traversal and unapproved schema contracts',()=>{
  for(const bad of [{...contract,schemaVersion:2},{...contract,approvedBy:''},{...contract,requirements:[...contract.requirements,...contract.requirements]},{...contract,requirements:[{...contract.requirements[0],module:'../outside.ts'}]},{...contract,extra:'silently ignored'}])expect(()=>parseContract(bad)).toThrow();
 });
 it('only shrinks inputs under an explicitly approved domain',()=>{
  expect(()=>parseContract({...contract,requirements:[{...contract.requirements[0],invariant:{argument:0,domain:'number',args:[0],seeds:['18'],expected:false}}]})).toThrow();
 });
 it('detects corruption rather than replacing an existing evidence object',async()=>{
  const store=await fs.mkdtemp(path.join(os.tmpdir(),'sentinel-integrity-'));
  try{const hash=await putObject(store,'evidence');await fs.chmod(path.join(store,'objects',hash),0o600);await fs.writeFile(path.join(store,'objects',hash),'tampered');await expect(getObject(store,hash)).rejects.toThrow('integrity');await expect(putObject(store,'evidence')).rejects.toThrow('integrity');}finally{await fs.rm(store,{recursive:true,force:true});}
 });
 it('rejects unsafe paths including Windows traversal',()=>{for(const p of ['../secret','x/../../s','/etc/passwd','.git/config','a\\..\\b','x//y'])expect(safeRelative(p)).toBe(false);});
 it('rejects repository symlinks instead of copying outside files',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'sentinel-symlink-'));const repo=path.join(root,'repo');await fs.mkdir(repo);
  try{await runCommand(['git','init'],repo);await runCommand(['git','-c','user.name=Test','-c','user.email=test@localhost','-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','commit','--allow-empty','-m','test'],repo);await fs.symlink('/etc/passwd',path.join(repo,'outside'));await expect(captureSnapshot(repo,path.join(root,'store'))).rejects.toThrow('symlink');}finally{await fs.rm(root,{recursive:true,force:true});}
 });
});
describe('controlled subprocesses',()=>{
 it('does not treat a missing executable as success',async()=>{const r=await runCommand(['sentinel-no-such-executable'],os.tmpdir());expect(r.exitCode).toBeNull();expect(r.stderr).toContain('ENOENT');});
 it('times out synchronous hangs',async()=>{const r=await runCommand([process.execPath,'-e','while(true){}'],os.tmpdir(),{timeoutMs:100});expect(r.timedOut).toBe(true);expect(r.exitCode).not.toBe(0);expect(r.durationMs).toBeLessThan(3000);});
 it('caps runaway output',async()=>{const r=await runCommand([process.execPath,'-e','while(true)process.stdout.write("x".repeat(100000))'],os.tmpdir(),{timeoutMs:5000});expect(r.truncated).toBe(true);expect(r.stdout.length).toBeLessThanOrEqual(1000000);});
 it('records actual command, stdin and exit code',async()=>{const r=await runCommand([process.execPath,'-e','process.stdin.pipe(process.stdout)'],os.tmpdir(),{input:'literal $(no shell)'});expect(r.exitCode).toBe(0);expect(r.input).toBe(r.stdout);});
});
