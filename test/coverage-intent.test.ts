import { afterEach, describe, expect, it } from 'vitest';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { captureSnapshot, putObject } from '../src/store.js';
import { parseContract } from '../src/schema.js';
import { verify } from '../src/verifier.js';
const temporary:string[]=[];
afterEach(async()=>{await Promise.all(temporary.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
async function observed(intent?:'change'|'preserve'){
 const root=await mkdtemp(join(tmpdir(),'sentinel-coverage-intent-'));temporary.push(root);
 const repo=join(root,'repo'),store=join(root,'store');await cp(resolve('fixtures/demo'),repo,{recursive:true});await rm(join(repo,'contract.json'));
 for(const args of [['init','-b','main'],['add','.'],['-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','-m','baseline']])execFileSync('git',args,{cwd:repo,stdio:'pipe'});
 const source=await captureSnapshot(repo,store);
 const contract=parseContract({schemaVersion:3,objective:'Review the greeting behaviour',approvedBy:'Independent test criterion',requirements:[{id:'greeting',kind:'must-preserve',description:'Keep personalised greetings',module:'src/access.ts',export:'greeting',cases:[{args:['Ada'],expected:'Hello, Ada!'}]}],allowedPaths:['src/access.ts'],coverage:{confirmed:true,...(intent?{intent}:{}),aspects:[{id:'greeting-aspect',description:'Personalised greeting',requirementIds:['greeting']}]}});
 const contractHash=await putObject(store,JSON.stringify(contract));
 return verify({store,baseline:source,candidate:source,contract,contractHash,timeoutMs:30000});
}
describe('schema-3 explicit change versus preservation intent',()=>{
 it('does not infer completion of a change task from preservation checks alone',async()=>{
  const receipt=await observed();
  expect(receipt.checks.find(check=>check.requirementId==='greeting')?.status).toBe('VERIFIED');
  expect(receipt.status).toBe('UNVERIFIED');
  expect(receipt.checks.some(check=>check.status==='UNVERIFIED'&&/must-change|change outcome|change requirement/i.test(check.detail))).toBe(true);
 },90000);
 it('accepts a deliberately approved preservation-only objective with the same finite evidence',async()=>{
  const receipt=await observed('preserve');
  expect(receipt.status).toBe('VERIFIED');
  expect(receipt.coverage?.verifiedAspects).toBe(1);
  expect(receipt.contract?.coverage?.intent).toBe('preserve');
 },90000);
});
