import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { dockerVerificationCommand, executeVerification, inspectDocker } from '../src/isolation.js';
import { captureSnapshot, putObject } from '../src/store.js';
import { startSession } from '../src/session.js';
import type { Contract, VerificationOptions } from '../src/types.js';
const allocated:string[]=[];
afterEach(async()=>{await Promise.all(allocated.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
async function directory(){const p=await mkdtemp(join(tmpdir(),'sentinel-isolation-test-'));allocated.push(p);return p;}

describe('explicit isolated verification',()=>{
 it('constructs a bounded container command with no writable host mount or inherited credentials',()=>{
  const args=dockerVerificationCommand('sha256:'+'a'.repeat(64),'/tmp/selected-inputs','sentinel-verify-abcd');
  for(const item of ['--read-only','--init','--rm','--cap-drop','ALL','no-new-privileges=true','--pids-limit','128','--memory','1g','--cpus','2'])expect(args).toContain(item);
  expect(args[args.indexOf('--network')+1]).toBe('none');
  expect(args[args.indexOf('--user')+1]).toBe('1000:1000');
  expect(args[args.indexOf('--mount')+1]).toBe('type=bind,source=/tmp/selected-inputs,target=/input,readonly');
  expect(args.filter(a=>a==='--mount')).toHaveLength(1);
  expect(args.join(' ')).not.toMatch(/docker\.sock|\.ssh|ANTHROPIC|OPENAI|--privileged|--use-api-socket/);
  expect(()=>dockerVerificationCommand('latest','/tmp/input','sentinel-verify-abcd')).toThrow('immutable');
  expect(()=>dockerVerificationCommand('sha256:'+'a'.repeat(64),'/tmp/a,readonly=false','sentinel-verify-abcd')).toThrow('unsupported');
 });
 it('rejects a remote Docker context without running any container or falling back locally',async()=>{
  const root=await directory(),bin=join(root,'bin');await mkdir(bin);
  await writeFile(join(bin,'docker'),'#!/usr/bin/env node\nconsole.log("ssh://remote.example");\n',{mode:0o755});
  const old=process.env.PATH;process.env.PATH=bin+':'+old;
  try{const status=await inspectDocker();expect(status.available).toBe(false);expect(status.reason).toContain('local Unix-socket');await expect(executeVerification({} as VerificationOptions,{kind:'docker',image:'sentinel-runner:0.2.0'})).rejects.toThrow('No local fallback');}finally{process.env.PATH=old;}
 });
 it('rejects missing isolation consent before launching an agent',async()=>{
  await expect(startSession({repo:'/does-not-exist',store:'/does-not-exist',objective:'test',agent:'codex',localConsent:true,runner:{kind:'docker',image:'sentinel-runner:0.2.0'}})).rejects.toThrow('--allow-container');
 });
});

it.skipIf(process.env.SENTINEL_TEST_DOCKER!=='1')('executes real Docker schema-2 checks with protected approval, network, input writes, root writes and secret inheritance blocked',async()=>{
 const root=await directory(),repo=join(root,'repo'),store=join(root,'store');await mkdir(repo);await mkdir(store);
 await writeFile(join(repo,'package.json'),' {"type":"module"}');
 const probeSource=`import {writeFileSync,readdirSync} from 'node:fs';
export async function boundary(){
const writable=p=>{try{writeFileSync(p,'unexpected');return true}catch{return false}};
let network=false;try{await fetch('http://1.1.1.1',{signal:AbortSignal.timeout(300)});network=true}catch{}
return {rootWritable:writable('/app/unexpected'),inputWritable:writable('/input/objects/'+readdirSync('/input/objects')[0]),secret:process.env.SENTINEL_ISOLATION_SECRET??null,network};
}`;
 await writeFile(join(repo,'boundary.js'),'export async function boundary(){return null;}\n');
 await writeFile(join(repo,'boundary.test.js'),"import {test,expect} from 'vitest';test('ordinary smoke',()=>expect(2+2).toBe(4));");
 execFileSync('git',['init','-b','main'],{cwd:repo,stdio:'pipe'});execFileSync('git',['add','.'],{cwd:repo});execFileSync('git',['-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','-m','fixture'],{cwd:repo,stdio:'pipe'});
 const baseline=await captureSnapshot(repo,store);
 // Controlled approval fixture, not a claim of live human review. The full
 // approved proposal must survive the read-only transfer into the container.
 const objective='Replace the empty boundary function with actual isolation observations';
 const requirements:Contract['requirements']=[{id:'boundary',kind:'must-change',description:'Isolation settings prevent these observed operations',module:'boundary.js',export:'boundary',cases:[{args:[],expected:{rootWritable:false,inputWritable:false,secret:null,network:false}}]}];
 const proposalHash=await putObject(store,JSON.stringify({schemaVersion:1,objective,proposed:requirements.map(requirement=>({selected:true,requirement})),uncertainties:[],resolvedQuestions:[]}));
 const contract:Contract={schemaVersion:2,objective,approvedBy:'controlled isolation approval fixture',requirements,allowedPaths:['boundary.js'],unresolved:[],approval:{method:'interactive',approvedAt:new Date().toISOString(),proposalHash,baselineHash:baseline.hash,requirementIds:['boundary'],resolvedQuestions:[]}};
 const contractHash=await putObject(store,JSON.stringify(contract));
 await writeFile(join(repo,'boundary.js'),probeSource);const candidate=await captureSnapshot(repo,store);
 const previous=process.env.SENTINEL_ISOLATION_SECRET;process.env.SENTINEL_ISOLATION_SECRET='must-not-enter-container';
 try{const receipt=await executeVerification({store,baseline,candidate,contract,contractHash},{kind:'docker',image:process.env.SENTINEL_DOCKER_IMAGE??'sentinel-runner:0.2.0'});expect(receipt.status,JSON.stringify(receipt.checks.map(({id,status,detail})=>({id,status,detail})))).toBe('VERIFIED');expect(receipt.runner).toBe('container-isolated');expect(receipt.runtime?.containerImageId).toMatch(/^sha256:/);expect(receipt.contract?.schemaVersion).toBe(2);expect(receipt.contract?.approval?.proposalHash).toBe(proposalHash);expect(receipt.contractHash).toBe(contractHash);expect(receipt.checks.find(c=>c.id==='req:boundary')?.observed).toEqual({rootWritable:false,inputWritable:false,secret:null,network:false});expect(receipt.checks.find(c=>c.id==='req:boundary')?.baseline).toBe(null);}finally{if(previous===undefined)delete process.env.SENTINEL_ISOLATION_SECRET;else process.env.SENTINEL_ISOLATION_SECRET=previous;}
},180000);
