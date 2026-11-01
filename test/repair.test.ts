import { afterEach, describe, expect, it } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { startSession, loadCheckpoint, continuationContext, repairableReceipt } from '../src/session.js';
import { getObject } from '../src/store.js';
import type { Checkpoint, Receipt, Status } from '../src/types.js';
const temporary:string[]=[];
afterEach(async()=>{await Promise.all(temporary.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
async function project(){
 const root=await mkdtemp(join(tmpdir(),'sentinel-repair-test-'));temporary.push(root);
 const repo=join(root,'repo'),store=join(root,'store'),contractPath=join(root,'contract.json');
 await cp(resolve('fixtures/demo'),repo,{recursive:true});await cp(join(repo,'contract.json'),contractPath);await rm(join(repo,'contract.json'));
 const contract=JSON.parse(await readFile(contractPath,'utf8'));contract.requirements=contract.requirements.slice(0,1);delete contract.probes;
 await writeFile(contractPath,JSON.stringify(contract));
 for(const args of [['init','-b','main'],['add','.'],['-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','-m','baseline']])execFileSync('git',args,{cwd:repo,stdio:'pipe'});
 return {repo,store,contractPath,objective:contract.objective};
}
describe('bounded evidence-driven repairs',()=>{
 it('retains the original contradiction and verifies a specifically selected deterministic repair',async()=>{
  const p=await project(),messages:string[]=[];
  const result=await startSession({...p,agent:'fixture-broken',fixtureRepairAgent:'fixture-fix',repairAttempts:1,localConsent:true,onProgress:m=>messages.push(m)});
  expect(result.state).toBe('verified');expect(result.agents.map(a=>a.agent)).toEqual(['fixture-broken','fixture-fix']);expect(result.receipts).toHaveLength(2);
  const [bad,good]=await Promise.all(result.receipts.map(async h=>JSON.parse((await getObject(p.store,h)).toString()) as Receipt));
  expect(bad?.status).toBe('CONTRADICTED');expect(good?.status).toBe('VERIFIED');expect(bad?.contractHash).toBe(good?.contractHash);
  expect(bad?.checks.some(c=>c.requirementId&&c.status==='CONTRADICTED'&&c.expected!==undefined&&c.observed!==undefined)).toBe(true);
  expect(messages.some(m=>m.includes('Repair 1/1'))).toBe(true);expect(await loadCheckpoint(p.store)).toEqual(result);
  const context=await continuationContext(p.store,result);expect(context).toContain('SOURCE CHANGES');expect(context).toContain('ENVIRONMENT AND DEPENDENCIES');expect(context).toContain('Complete read-only contract');
 },60000);
 it('stops without another verification cycle when interrupted and rejects invalid budgets before execution',async()=>{
  const p=await project();
  const stopped=await startSession({...p,agent:'fixture-interrupt',fixtureRepairAgent:'fixture-fix',repairAttempts:3,localConsent:true});
  expect(stopped.agents).toHaveLength(1);expect(stopped.receipts).toEqual([]);expect(stopped.state).toBe('interrupted');
  for(const repairAttempts of [-1,4,1.5])await expect(startSession({...p,agent:'fixture-broken',repairAttempts,localConsent:true})).rejects.toThrow('0 to 3');
 });
 it('stops at the requested bound and leaves unresolved code inspectable',async()=>{
  const p=await project();
  const result=await startSession({...p,agent:'fixture-broken',repairAttempts:1,localConsent:true});
  expect(result.state).toBe('needs-work');expect(result.agents).toHaveLength(2);expect(result.receipts).toHaveLength(2);
  expect(result.nextActions[0]).toContain('no source changes');
 },60000);
 it('does not count an empty Git commit as implementation progress',async()=>{
  const p=await project(),bin=join(temporary.at(-1)!,'protocol-bin');await mkdir(bin);
  const stub=`#!/usr/bin/env node
const fs=require('node:fs'),{execFileSync}=require('node:child_process');
const args=process.argv.slice(2);
if(args.includes('--version')){console.log('controlled repair protocol fixture');process.exit(0)}
if(args.includes('--help')){console.log('--sandbox --cd --json workspace-write');process.exit(0)}
let input='';process.stdin.on('data',bytes=>input+=bytes);process.stdin.on('end',()=>{
 fs.writeFileSync('src/access.ts','export function isAdult(age) { return age >= 18; }\\nexport function greeting(name) { return "Hello, " + name + "!"; }\\n');
 execFileSync('git',['-c','core.hooksPath=/dev/null','add','src/access.ts']);
 execFileSync('git',['-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','--allow-empty','-m','No new source progress'],{stdio:'pipe'});
 const acknowledgement=input.match(/SENTINEL_ACK [a-f0-9]{64} [a-f0-9]{64}/)?.[0]??'No acknowledgement';
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:acknowledgement}}));
});
`;
  await writeFile(join(bin,'codex'),stub,{mode:0o755});await writeFile(join(bin,'claude'),'#!/usr/bin/env node\nprocess.exit(1);\n',{mode:0o755});
  const old=process.env.PATH;process.env.PATH=bin+':'+old;
  try{
   const result=await startSession({...p,agent:'codex',repairAttempts:3,localConsent:true});
   expect(result.state).toBe('needs-work');expect(result.agents).toHaveLength(2);expect(result.receipts).toHaveLength(2);
   expect(result.nextActions.join(' ')).toContain('no source changes');
   expect(result.agents.every(a=>a.handoff?.acknowledged)).toBe(true);
  }finally{process.env.PATH=old;}
 },90000);
 it('refuses repair for incomplete, historical, unauthorised or unreliable observations',()=>{
  const cp={state:'needs-work',agents:[{outcome:'completed'}],candidateHash:'candidate',baselineHash:'base',contractHash:'contract'} as Checkpoint;
  const base={candidateHash:'candidate',baselineHash:'base',contractHash:'contract',status:'CONTRADICTED',checks:[{id:'req:r',requirementId:'r',status:'CONTRADICTED'}],changes:[]} as unknown as Receipt;
  expect(repairableReceipt(base,cp)).toBe(true);
  for(const status of ['ENVIRONMENT FAILURE','REVIEW REQUIRED','UNVERIFIED'] as Status[])expect(repairableReceipt({...base,checks:[...base.checks,{id:'blocked',label:'blocked',status,detail:''}]},cp)).toBe(false);
  expect(repairableReceipt({...base,candidateHash:'old'},cp)).toBe(false);
  expect(repairableReceipt(base,{...cp,contractHash:null})).toBe(false);
  expect(repairableReceipt(base,{...cp,state:'interrupted'})).toBe(false);
  expect(repairableReceipt({...base,checks:[{id:'ordinary-tests',label:'tests',status:'CONTRADICTED',detail:''}]},cp)).toBe(false);
 });
});
