import { afterEach, describe, expect, it } from 'vitest';
import { chmod, cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { startSession, saveCheckpoint } from '../src/session.js';
import { captureSnapshot, digest } from '../src/store.js';
import { exportSessionPatch } from '../src/patch.js';
const temporary:string[]=[];
afterEach(async()=>{await Promise.all(temporary.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
async function project(){
 const root=await mkdtemp(join(tmpdir(),'sentinel-patch-test-'));temporary.push(root);
 const repo=join(root,'repo'),store=join(root,'store'),contractPath=join(root,'contract.json');
 await cp(resolve('fixtures/demo'),repo,{recursive:true});await cp(join(repo,'contract.json'),contractPath);await rm(join(repo,'contract.json'));
 await writeFile(join(repo,'binary.bin'),Buffer.from([0,255,45,128,6]));await writeFile(join(repo,'non-utf8.txt'),Buffer.from([255,254,65,10]));await writeFile(join(repo,'removed.txt'),'remove this\n');await writeFile(join(repo,'mode.sh'),'#!/bin/sh\nexit 0\n',{mode:0o644});
 for(const args of [['init','-b','main'],['add','.'],['-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','-m','baseline']])execFileSync('git',args,{cwd:repo,stdio:'pipe'});
 const contract=JSON.parse(await readFile(contractPath,'utf8'));
 const checkpoint=await startSession({repo,store,contractPath,objective:contract.objective,agent:'fixture-interrupt',localConsent:true});
 return {root,repo,store,checkpoint};
}
describe('reviewable source patch export',()=>{
 it('round-trips binary changes, additions, deletion, unusual names and executable modes without changing the original',async()=>{
  const p=await project();
  await writeFile(join(p.checkpoint.workspace,'binary.bin'),Buffer.from([0,2,3,0,255,79,128]));
  await writeFile(join(p.checkpoint.workspace,'non-utf8.txt'),Buffer.from([255,254,67,68,10]));
  await writeFile(join(p.checkpoint.workspace,'new file.txt'),'new file\n');await writeFile(join(p.checkpoint.workspace,'tab\tname.txt'),'tab path\n');
  await rm(join(p.checkpoint.workspace,'removed.txt'));await chmod(join(p.checkpoint.workspace,'mode.sh'),0o755);
  p.checkpoint.candidateHash=(await captureSnapshot(p.checkpoint.workspace,p.store)).hash;await saveCheckpoint(p.store,p.checkpoint);
  const original=await captureSnapshot(p.repo,p.store),out=join(p.root,'review.patch');
  const result=await exportSessionPatch(p.store,p.checkpoint.id,out);
  expect(result.targetMatchesBaseline).toBe(true);expect(result.applyCheck).toBe('passed');expect(result.verificationStatus).toBe('UNVERIFIED');
  expect(result.hash).toBe(digest(await readFile(out)));expect(result.files).toContain('binary.bin');
  expect((await captureSnapshot(p.repo,p.store)).files).toEqual(original.files);
  // The explicit test action below models a developer choosing to accept the exported patch.
  execFileSync('git',['apply','--check',out],{cwd:p.repo,stdio:'pipe'});execFileSync('git',['apply',out],{cwd:p.repo,stdio:'pipe'});
  expect((await captureSnapshot(p.repo,p.store)).files).toEqual((await captureSnapshot(p.checkpoint.workspace,p.store)).files);
  expect((await stat(join(p.repo,'mode.sh'))).mode&0o111).toBeTruthy();
  await expect(exportSessionPatch(p.store,p.checkpoint.id,out)).rejects.toThrow();
 });
 it('preserves a historical patch but clearly reports a changed original checkout',async()=>{
  const p=await project();await writeFile(join(p.repo,'unrelated.txt'),'developer work');
  const result=await exportSessionPatch(p.store,p.checkpoint.id,join(p.root,'historical.patch'));
  expect(result.targetMatchesBaseline).toBe(false);expect(result.instructions.join(' ')).toContain('differs from the baseline');
  expect(await readFile(join(p.repo,'unrelated.txt'),'utf8')).toBe('developer work');
 });
 it('does not invoke repository filters or external diff tools while exporting raw source',async()=>{
  const p=await project(),marker=join(p.root,'FILTER_EXECUTED');
  const hook=`touch '${marker}'`;
  execFileSync('git',['config','filter.evil.clean',hook],{cwd:p.repo});execFileSync('git',['config','diff.evil.command',hook],{cwd:p.repo});
  await writeFile(join(p.repo,'.gitattributes'),'* filter=evil diff=evil\n');
  await writeFile(join(p.checkpoint.workspace,'.gitattributes'),'* filter=evil diff=evil\n');
  p.checkpoint.candidateHash=(await captureSnapshot(p.checkpoint.workspace,p.store)).hash;await saveCheckpoint(p.store,p.checkpoint);
  const result=await exportSessionPatch(p.store,p.checkpoint.id,join(p.root,'raw.patch'));
  expect(result.files).toContain('.gitattributes');await expect(readFile(marker)).rejects.toThrow();
 });
 it('rejects uncaptured source drift, running sessions and protected output paths',async()=>{
  const p=await project();
  await expect(exportSessionPatch(p.store,p.checkpoint.id,join(p.store,'objects','bad'))).rejects.toThrow('outside Git metadata');
  await writeFile(join(p.checkpoint.workspace,'uncaptured.txt'),'not in checkpoint');
  await expect(exportSessionPatch(p.store,p.checkpoint.id,join(p.root,'bad.patch'))).rejects.toThrow('changed since');
  p.checkpoint.state='running';await saveCheckpoint(p.store,p.checkpoint);
  await expect(exportSessionPatch(p.store,p.checkpoint.id,join(p.root,'running.patch'))).rejects.toThrow('running session');
 });
});
