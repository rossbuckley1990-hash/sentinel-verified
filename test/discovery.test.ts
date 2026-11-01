import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { discoverProject } from '../src/discovery.js';
import { runCommand } from '../src/process.js';
import { digest } from '../src/store.js';
const roots:string[]=[];
async function fixture(files:Record<string,string>){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'sentinel-discovery-'));roots.push(root);
 await fs.writeFile(path.join(root,'package.json'),JSON.stringify({name:'discovery-test',type:'module',devDependencies:{vitest:'5.0.5'},engines:{node:'>=22'},scripts:{test:'vitest run'}}));
 for(const [name,text] of Object.entries(files)){await fs.mkdir(path.dirname(path.join(root,name)),{recursive:true});await fs.writeFile(path.join(root,name),text);}
 const result=await runCommand(['git','init','-b','main'],root);if(result.exitCode!==0)throw new Error(result.stderr);
 return root;
}
afterEach(async()=>{vi.unstubAllEnvs();await Promise.all(roots.splice(0).map(root=>fs.rm(root,{recursive:true,force:true})));});

describe('static contract discovery',()=>{
 it('maps imported aliases and namespace exports to preserved literal expectations with source hashes',async()=>{
  const source='export function valid(value: unknown): boolean { return value === "ok"; }\n';
  const test=`import {expect as check,test} from 'vitest';\nimport {valid as verify} from './valid.js';\nimport * as api from './valid.js';\ntest('valid',()=>{check(verify('ok')).toBe(true);check(api.valid('no')).toEqual(false);});`;
  const root=await fixture({'src/valid.ts':source,'src/valid.test.ts':test});
  const plan=await discoverProject(path.join(root,'src'),'Fix validation');
  expect(plan.repo).toBe(await fs.realpath(root));expect(plan.environment.testFramework).toBe('vitest');
  expect(plan.exports).toContainEqual({module:'src/valid.ts',export:'valid',signature:'valid(value: unknown): boolean'});
  expect(plan.proposed.map(p=>p.requirement.cases[0]?.expected).sort()).toEqual([false,true]);
  expect(plan.proposed.every(p=>p.requirement.kind==='must-preserve'&&p.confidence==='direct-assertion')).toBe(true);
  expect(plan.proposed[0]?.evidence[0]?.hash).toBe(digest(test));
  expect(plan.uncertaintyDetails.some(u=>u.kind==='intent'&&u.blocksObjectiveVerification)).toBe(true);
 });
 it('discovers CJS default exports and explicit escaped objective cases without executing the source',async()=>{
  const root=await fixture({'package.json':JSON.stringify({name:'is-number',main:'index.js',devDependencies:{vitest:'5.0.5'}}),'index.js':'module.exports = function(num) { throw new Error("do not execute source during discovery"); };','index.test.js':`import {expect,test} from 'vitest';import isNumber from './index.js';test('number',()=>expect(isNumber('42')).toBe(true));`});
  const objective='Fix whitespace-only strings being accepted as numbers without rejecting numeric strings or numeric values; isNumber("   ") must return false; isNumber("\\r\\n\\t") must return false.';
  const plan=await discoverProject(root,objective);
  expect(plan.proposed.filter(p=>p.requirement.kind==='must-change').map(p=>p.requirement.cases[0]?.args)).toEqual(expect.arrayContaining([['   '],['\r\n\t']]));
  expect(plan.proposed.every(p=>p.requirement.module==='index.js'&&p.requirement.export==='default')).toBe(true);
  expect(plan.proposed.filter(p=>p.requirement.kind==='must-change').every(p=>p.confidence==='explicit-objective'&&p.selected)).toBe(true);
 });
 it('reads strict Node assertions and CommonJS aliases from root test.js',async()=>{
  const root=await fixture({'index.js':'exports.f = function f(value) { return value; };','test.js':`const assert=require('node:assert');const {f: fn}=require('./');assert.strictEqual(fn(-2),-2);assert.deepStrictEqual(fn({x:[null,true]}),{x:[null,true]});`});
  const plan=await discoverProject(root,'Preserve f');
  expect(plan.proposed).toHaveLength(2);expect(plan.files.tests).toContain('test.js');
  expect(plan.proposed.every(p=>p.requirement.export==='f')).toBe(true);
 });
 it('leaves dynamic, shadowed, weak, skipped and mocked assertions unresolved instead of inventing evidence',async()=>{
  const root=await fixture({'index.ts':'export function f(value:unknown){return value;}','index.test.ts':`import {expect,test,vi} from 'vitest';import {f} from './index';const x=1;test('dynamic',()=>expect(f(x)).toBe(1));test('weak',()=>expect(f('yes')).toContain('y'));test.skip('skip',()=>expect(f('skip')).toBe('skip'));test('shadow',()=>{const f=(x)=>x;expect(f('fake')).toBe('fake')});vi.mock('./index',()=>({f:()=>true}));test('mock',()=>expect(f('ok')).toBe(true));`});
  const plan=await discoverProject(root,'Fix f');
  expect(plan.proposed.map(p=>p.requirement.cases[0]?.args[0])).toEqual(expect.arrayContaining(['skip','ok']));
  expect(plan.proposed.some(p=>p.requirement.cases[0]?.args[0]==='fake')).toBe(false);
  expect(plan.proposed.every(p=>!p.selected)).toBe(true);
  expect(plan.uncertainties.join('\n')).toMatch(/dynamic assertion/);expect(plan.uncertainties.join('\n')).toMatch(/mocking/);
 });
 it('requires explicit resolution of conflicting expected values and treats documentation as unapproved',async()=>{
  const root=await fixture({'index.ts':'export function f(value:number){return value;}','index.test.ts':`import {expect,test} from 'vitest';import {f} from './index';test('one',()=>expect(f(1)).toBe(1));test('two',()=>expect(f(1)).toBe(2));`,'README.md':'Example:\n```js\nf(2) // => 2\n```\n'});
  const plan=await discoverProject(root,'Fix f; f(1) should return 3');
  expect(plan.proposed.filter(p=>p.requirement.cases[0]?.args[0]===1).every(p=>!p.selected)).toBe(true);
  expect(plan.uncertaintyDetails.some(u=>u.kind==='conflict')).toBe(true);
  expect(plan.proposed.find(p=>p.confidence==='documentation')?.selected).toBe(false);
 });
 it('does not derive expected results from implementation or run package scripts/configuration',async()=>{
  const root=await fixture({'index.ts':'export function answer(){return 42;}','vitest.config.js':`throw new Error('configuration must not execute');`,'package.json':JSON.stringify({scripts:{postinstall:'touch SHOULD_NOT_EXIST',test:'vitest run'},devDependencies:{vitest:'5.0.5'}})});
  const plan=await discoverProject(root,'Fix the answer');expect(plan.proposed).toHaveLength(0);expect(plan.exports.some(t=>t.export==='answer')).toBe(true);expect(plan.uncertainties.join('\n')).toMatch(/not evidence of correct expected behaviour/);await expect(fs.access(path.join(root,'SHOULD_NOT_EXIST'))).rejects.toThrow();
 });
 it('ignores private, git-ignored and symlinked inputs and bounds file reads',async()=>{
  const root=await fixture({'.gitignore':'ignored.test.ts\n','.env.ts':'PRIVATE_SECRET','ignored.test.ts':'PRIVATE_IGNORED','index.ts':'export function f(){return true;}','oversized.test.ts':'x'.repeat(512001),'pnpm-lock.yaml':'lockfileVersion: 9'});
  await fs.symlink('/etc/passwd',path.join(root,'external.ts'));
  const plan=await discoverProject(root,'Fix f');expect(plan.environment.packageManager).toBe('pnpm');expect(plan.files.sources).not.toContain('.env.ts');expect(plan.files.tests).not.toContain('ignored.test.ts');expect(plan.files.sources).not.toContain('external.ts');expect(plan.uncertainties.join('\n')).toContain('oversized');expect(JSON.stringify(plan)).not.toContain('PRIVATE_SECRET');
 });
 it('refuses ambiguous function identity and non-JSON expected values',async()=>{
  const root=await fixture({'a.ts':'export function f(x:number){return x;}','b.ts':'export function f(x:number){return x;}', 'a.test.ts':`import {expect,test} from 'vitest';import {f} from './a';test('dynamic',()=>expect(f(undefined)).toBe(NaN));`});
  const plan=await discoverProject(root,'Fix f; f(1) must return 2');expect(plan.proposed).toHaveLength(0);expect(plan.uncertainties.join('\n')).toContain('2 matches');
 });
 it('does not turn malformed objectives or quoted documentation booleans into requirements',async()=>{
  const root=await fixture({'index.ts':'export function f(x: unknown){return true;}','index.test.ts':`import {expect,test} from 'vitest';import {f} from './index';test('valid',()=>expect(f(1)).toBe(true));`,'README.md':`f(1) //=> 'true'\n`});
  const plan=await discoverProject(root,'Fix f; f(2) must return {');
  expect(plan.proposed).toHaveLength(1);expect(plan.proposed[0]?.selected).toBe(true);expect(plan.proposed[0]?.requirement.cases[0]?.expected).toBe(true);
  expect(plan.uncertainties.join('\n')).toContain('quoted primitive');expect(plan.uncertainties.join('\n')).toContain('must-change example');
 });
 it.skipIf(process.platform==='win32')('disables executable Git filesystem monitors including inherited config overrides',async()=>{
  const root=await fixture({'index.ts':'export function f(){return true;}'});const marker=path.join(root,'EXECUTED');const script=path.join(root,'monitor.sh');
  expect((await runCommand(['git','add','index.ts'],root)).exitCode).toBe(0);
  await fs.writeFile(script,`#!/bin/sh\ntouch '${marker.replaceAll("'","'\\''")}'\nprintf 'TOKEN\\0'\n`,{mode:0o755});
  expect((await runCommand(['git','config','core.fsmonitor',script],root)).exitCode).toBe(0);
  vi.stubEnv('GIT_CONFIG_COUNT','1');vi.stubEnv('GIT_CONFIG_KEY_0','core.fsmonitor');vi.stubEnv('GIT_CONFIG_VALUE_0',script);
  vi.stubEnv('GIT_CONFIG_PARAMETERS',`'core.fsmonitor'='${script.replaceAll("'","'\\''")}'`);
  // A staged index makes this a positive control: the same unprotected read
  // actually invokes the executable, so a missing marker is meaningful.
  expect((await runCommand(['git','ls-files','--cached','--others','--exclude-standard','-z'],root)).exitCode).toBe(0);
  await expect(fs.access(marker)).resolves.toBeUndefined();await fs.rm(marker);
  await discoverProject(root,'Fix f');await expect(fs.access(marker)).rejects.toThrow();
 });

 it('retains blocking intent and conflict notices when dynamic tests exceed the coverage display budget',async()=>{
  const dynamic=Array.from({length:110},(_,i)=>`test('dynamic${i}',()=>expect(f(value)).toBe(${i}));`).join('\n');
  const root=await fixture({'index.ts':'export function f(x:number){return x;}','index.test.ts':`import {expect,test} from 'vitest';import {f} from './index';const value=1;\n${dynamic}\nexpect(f(1)).toBe(1);expect(f(1)).toBe(2);`});
  const plan=await discoverProject(root,'Fix f');
  expect(plan.uncertaintyDetails.some(u=>u.kind==='intent'&&u.blocksObjectiveVerification)).toBe(true);
  expect(plan.uncertaintyDetails.some(u=>u.kind==='conflict'&&u.blocksObjectiveVerification)).toBe(true);
  expect(plan.proposed.every(p=>!p.selected)).toBe(true);expect(plan.limits.join('\n')).toContain('additional coverage notices');
 });

 it('reserves proposal budget for explicit task changes rather than dropping them behind a large suite',async()=>{
  const tests=Array.from({length:101},(_,i)=>`test('case${i}',()=>expect(f(${i})).toBe(${i}));`).join('\n');
  const root=await fixture({'index.ts':'export function f(x:number){return x;}','index.test.ts':`import {expect,test} from 'vitest';import {f} from './index';\n${tests}`});
  const plan=await discoverProject(root,'Fix f; f(1000) must return 5');expect(plan.proposed).toHaveLength(100);expect(plan.proposed.some(p=>p.requirement.kind==='must-change'&&p.requirement.cases[0]?.args[0]===1000)).toBe(true);expect(plan.uncertainties.join('\n')).toContain('100-proposal limit');
 });

});
