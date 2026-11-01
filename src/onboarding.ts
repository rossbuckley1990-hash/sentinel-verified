import { createInterface } from 'node:readline/promises';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { discoverProject, type DiscoveryPlan, type ProposedRequirement } from './discovery.js';
import { detectAgents } from './agents.js';
import { atomicJson, captureSnapshot, digest, putObject, getObject } from './store.js';
import { parseContract } from './schema.js';
import { loadCheckpoint, readLimitedText } from './session.js';
import { cleanTerminal } from './terminal.js';
import { DEFAULT_RUNNER_IMAGE, inspectDocker, type RunnerChoice } from './isolation.js';
import type { AgentName, Checkpoint, Contract, Json, Requirement, Snapshot } from './types.js';

export interface PromptIO { interactive: boolean; write(message: string): void; ask(message: string): Promise<string>; close(): void }
export function terminalPrompt(): PromptIO {
  const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY;
  const rl = interactive ? createInterface({input:process.stdin,output:process.stdout}) : null;
  return {interactive,write:message=>process.stdout.write(cleanTerminal(message)+'\n'),ask:async message=>{if(!rl)throw new Error('Interactive approval requires a terminal. For automation, supply an externally reviewed --contract and explicit execution consent.');return (await rl.question(cleanTerminal(message))).trim();},close:()=>rl?.close()};
}
interface Preferences { schemaVersion:1; preferredAgent?: 'codex'|'claude' }
export async function readPreferences(store:string):Promise<Preferences>{
  try {const config=JSON.parse(await readLimitedText(path.join(store,'config.json'),10000)) as Preferences;if(config.schemaVersion!==1||config.preferredAgent&&!['codex','claude'].includes(config.preferredAgent))throw new Error('Unsupported preferences');return config;}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {schemaVersion:1};throw new Error(`Cannot read SENTINEL preferences: ${String(error)}`);}
}
export async function rememberAgent(store:string,agent:AgentName){if(agent==='codex'||agent==='claude')await atomicJson(path.join(store,'config.json'),{schemaVersion:1,preferredAgent:agent});}
export async function rememberSession(store:string,cp:Checkpoint){await atomicJson(path.join(store,'repositories',digest(cp.repo),'latest.json'),{schemaVersion:1,id:cp.id});}
export async function repositorySession(store:string,repo:string):Promise<string|undefined>{
  try{const file=path.join(store,'repositories',digest(await fs.realpath(repo)),'latest.json');const pointer=JSON.parse(await readLimitedText(file,10000)) as {schemaVersion?:number;id?:unknown};if(pointer.schemaVersion!==1||typeof pointer.id!=='string'||!/^s-[a-z0-9]+-[a-f0-9]{8}$/.test(pointer.id))throw new Error('Malformed repository session pointer. Select an explicit --session after inspecting the store.');return pointer.id;}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
}
export function displayPlan(io:PromptIO,plan:DiscoveryPlan,proposals=plan.proposed,unresolved=plan.uncertaintyDetails.filter(q=>q.blocksObjectiveVerification).map(q=>q.message)){
 io.write('\n  SENTINEL · Verification plan · PROPOSED, not approved');
 io.write(`  Task: ${plan.objective}`);io.write(`  Repository: ${plan.repo}`);io.write(`  Environment: ${plan.environment.packageManager} · ${plan.environment.testFramework}`);
 for(const kind of ['must-change','must-preserve'] as const){io.write(`\n  ${kind.toUpperCase()}`);const selected=proposals.map((p,i)=>({p,i})).filter(({p})=>p.requirement.kind===kind);
  if(!selected.length)io.write('  ? No independently checkable requirement has been established.');
  for(const {p,i} of selected){io.write(`  ${i+1}. [${p.selected?'included':'excluded'}] ${p.requirement.description}`);io.write(`     ${p.requirement.module} → ${p.requirement.export}`);for(const c of p.requirement.cases.slice(0,6))io.write(`     ${JSON.stringify(c.args)} → ${JSON.stringify(c.expected)}`);if(p.requirement.cases.length>6)io.write(`     ... ${p.requirement.cases.length-6} more examples`);for(const e of p.evidence.slice(0,2))io.write(`     Source: ${e.path}:${e.line} · ${e.excerpt}`);}
 }
 io.write('\n  UNCERTAIN');if(unresolved.length)unresolved.forEach((q,i)=>io.write(`  ? ${i+1}. ${q}`));else io.write('  No unresolved objective questions recorded. Coverage remains bounded.');
 const coverage=plan.uncertaintyDetails.filter(q=>!q.blocksObjectiveVerification).map(q=>q.message);
 for(const q of coverage.slice(0,5))io.write(`  Scope: ${q}`);
 io.write('  Proposal generation reads source text; no project code has run. Approval is your decision.');
}
function parseJsonInput(text:string):Json{const value:unknown=JSON.parse(text);const wrapper:Contract={schemaVersion:1,objective:'Validate an explicit example',approvedBy:'input validation',requirements:[{id:'input',kind:'must-change',description:'input',module:'input.js',export:'input',cases:[{args:[],expected:value as Json}]}]};return parseContract(wrapper).requirements[0]!.cases[0]!.expected;}
async function editRequirement(io:PromptIO,plan:DiscoveryPlan,existing?:ProposedRequirement):Promise<ProposedRequirement>{
 if(!plan.exports.length)throw new Error('No supported exported function found. Use a manual contract for an explicitly supported module, or reduced-scope tests.');
 io.write('\n  Select an exported function:');plan.exports.forEach((e,i)=>io.write(`  ${i+1}. ${e.module} → ${e.signature}`));
 const fallback=existing?plan.exports.findIndex(e=>e.module===existing.requirement.module&&e.export===existing.requirement.export)+1:1;
 const choice=Number(await io.ask(`  Function [${Math.max(1,fallback)}]: `)||Math.max(1,fallback));const target=plan.exports[choice-1];if(!target)throw new Error('Choose a listed function number.');
 const kindText=await io.ask(`  Behaviour: change or preserve [${existing?.requirement.kind==='must-preserve'?'preserve':'change'}]: `);
 const kind=kindText?kindText==='change'?'must-change':kindText==='preserve'?'must-preserve':null:existing?.requirement.kind??'must-change';if(!kind)throw new Error('Enter change or preserve.');
 const description=await io.ask(`  Requirement description${existing?' [keep current]':''}: `)||existing?.requirement.description;if(!description)throw new Error('A description is required.');
 io.write('  Examples use JSON values, not executable code. Example arguments: ["text", 3]');
 const argsText=await io.ask(`  Arguments${existing?' [keep first example]':''}: `);const args=argsText?parseJsonInput(argsText):existing?.requirement.cases[0]?.args;if(!Array.isArray(args))throw new Error('Arguments must be a JSON array.');
 const expectedText=await io.ask(`  Expected result${existing?' [keep first example]':''}: `);const expected=expectedText?parseJsonInput(expectedText):existing?.requirement.cases[0]?.expected;if(expected===undefined)throw new Error('An expected JSON result is required.');
 const requirement:Requirement={id:existing?.requirement.id??`developer-${randomUUID().slice(0,8)}`,kind,description,module:target.module,export:target.export,cases:[{args,expected}]};
 return {requirement,selected:true,confidence:'explicit-objective',evidence:[{path:'<developer approval interface>',line:1,excerpt:description,hash:digest(JSON.stringify(requirement))}]};
}
export async function approvePlan(plan:DiscoveryPlan,store:string,baseline:Snapshot,io:PromptIO):Promise<{contract:Contract;contractPath:string;proposalHash:string}>{
 if(!io.interactive)throw new Error('No contract supplied. Run in an interactive terminal to review a proposed plan, or supply a reviewed --contract file. No agent or project code was executed.');
 for(const e of [...plan.evidence,...plan.proposed.flatMap(p=>p.evidence)])if(!e.path.startsWith('<')&&baseline.files[e.path]?.hash!==e.hash)throw new Error('Repository evidence changed during discovery. Generate a fresh plan before approval.');
 const proposals=structuredClone(plan.proposed);let unresolved=plan.uncertaintyDetails.filter(q=>q.blocksObjectiveVerification).map(q=>q.message);
 const resolvedQuestions:{question:string;reason:string}[]=[];
 for(;;){
  displayPlan(io,plan,proposals,unresolved);
  const action=(await io.ask('\n  [Approve] [Edit] [Remove/restore] [Add] [Resolve question] [Quit]: ')).toLowerCase();
  if(action==='quit'||action==='q'||action==='reject')throw new Error('Verification plan rejected. No agent or project code was executed.');
  if(action==='edit'||action==='e'||action==='remove'||action==='r'||action==='restore'){
   const index=Number(await io.ask('  Requirement number: '))-1;if(!Number.isInteger(index)||!proposals[index]){io.write('  Choose a listed requirement.');continue;}
   try{if(action==='edit'||action==='e')proposals[index]=await editRequirement(io,plan,proposals[index]);else proposals[index]!.selected=!proposals[index]!.selected;}catch(error){io.write(`  ${String(error)}`);}continue;
  }
  if(action==='add'||action==='n'){try{proposals.push(await editRequirement(io,plan));const intent=plan.uncertaintyDetails.filter(q=>q.kind==='intent'&&(q.message.startsWith('The objective does not establish a literal must-change example.')||q.message.startsWith('No independently checkable acceptance examples were found'))).map(q=>q.message);if(proposals.some(p=>p.selected&&p.requirement.kind==='must-change')){for(const q of unresolved.filter(q=>intent.includes(q)))resolvedQuestions.push({question:q,reason:'Developer supplied an explicit must-change example through the approval interface.'});unresolved=unresolved.filter(q=>!intent.includes(q));}}catch(error){io.write(`  ${String(error)}`);}continue;}
  if(action==='resolve question'||action==='resolve'||action==='u'){
   if(!unresolved.length){io.write('  There are no unresolved questions.');continue;}const index=Number(await io.ask('  Question number: '))-1;if(!unresolved[index]){io.write('  Choose a listed question.');continue;}
   const reason=await io.ask('  Decision and evidence (recorded with your approval): ');if(!reason){io.write('  A recorded decision is required; the question remains unresolved.');continue;}resolvedQuestions.push({question:unresolved[index]!,reason});unresolved.splice(index,1);continue;
  }
  if(action!=='approve'&&action!=='a'){io.write('  Enter an action name.');continue;}
  const requirements=proposals.filter(p=>p.selected).map(p=>p.requirement);
  const reduced=unresolved.length>0||!requirements.some(r=>r.kind==='must-change');
  if(reduced){io.write('  This plan has unresolved intent. Results will remain UNVERIFIED for the task; available checks can still be useful.');if((await io.ask('  Type limited to approve this reduced scope, or Enter to keep editing: ')).toLowerCase()!=='limited')continue;}
  const current=await captureSnapshot(plan.repo,store);if(current.hash!==baseline.hash)throw new Error('Repository changed while reviewing the plan. Run again to review fresh evidence.');
  const approvedPlan={...plan,proposed:proposals,uncertainties:unresolved,resolvedQuestions,reviewedAt:new Date().toISOString()};
  const proposalHash=await putObject(store,JSON.stringify(approvedPlan));
  const contract=parseContract({schemaVersion:2,objective:plan.objective,approvedBy:'Developer via interactive terminal approval',requirements,discoveryLimits:[...plan.limits,...plan.uncertaintyDetails.filter(q=>!q.blocksObjectiveVerification).map(q=>q.message)].slice(0,150),allowedPaths:[...new Set(requirements.map(r=>r.module))],unresolved,approval:{method:'interactive',approvedAt:new Date().toISOString(),proposalHash,baselineHash:baseline.hash,requirementIds:requirements.map(r=>r.id),resolvedQuestions}});
  const contractHash=await putObject(store,JSON.stringify(contract));const contractPath=path.join(store,'contracts',`${contractHash}.json`);await atomicJson(contractPath,contract);
  io.write(`\n  CONTRACT · Approved ${requirements.length} requirements${reduced?' with explicit reduced scope':''}.`);io.write(`  Protected contract: ${contractPath}`);
  return {contract,contractPath,proposalHash};
 }
}
export async function chooseAgent(store:string,repo:string,io:PromptIO,explicit?:AgentName):Promise<AgentName>{
 if(explicit)return explicit;
 const available=(await detectAgents(repo)).filter(a=>a.supported);const config=await readPreferences(store);
 if(config.preferredAgent&&available.some(a=>a.name===config.preferredAgent)){io.write(`  AGENT · ${config.preferredAgent} (remembered preference)`);return config.preferredAgent;}
 if(!available.length)throw new Error('No supported coding agent found. Install and authenticate Codex or Claude Code, then rerun. The approved plan remains in the store.');
 if(available.length===1){const chosen=available[0]!.name;await rememberAgent(store,chosen);return chosen;}
 if(!io.interactive)throw new Error('Multiple agents found. Supply --agent codex or --agent claude in noninteractive use.');
 available.forEach((a,i)=>io.write(`  ${i+1}. ${a.name} · ${a.version} (authentication checked on launch)`));const answer=await io.ask('  Agent [1]: ');const chosen=available[Number(answer||1)-1]?.name??available.find(a=>a.name===answer)?.name;if(!chosen)throw new Error('Choose an installed agent.');await rememberAgent(store,chosen);return chosen;
}
export async function consentToExecution(io:PromptIO,runner:RunnerChoice,localConsent:boolean,isolatedConsent:boolean,agentWillRun=true){
 if(runner.kind==='docker'){
  if(isolatedConsent)return;
  const readiness=await inspectDocker(runner.image);if(!readiness.available)throw new Error(readiness.reason+' No local fallback was attempted.');
  io.write('  Verification will run in Docker with network disabled and read-only input mounts.');
  if(agentWillRun)io.write('  The coding agent still runs on the host under its own permissions; its commands are not isolated by this verifier.');
  if(!io.interactive||(await io.ask('  Allow this container verification'+(agentWillRun?' and host coding-agent session':'')+'? Type allow: ')).toLowerCase()!=='allow')throw new Error('Execution not authorised. Use --allow-container only after reviewing this boundary.');return;
 }
 if(localConsent)return;
 io.write('  EXECUTION · Source and tests will run locally under your OS account. This is not a sandbox.');
 if(!io.interactive||(await io.ask('  Allow local execution for this session? Type allow: ')).toLowerCase()!=='allow')throw new Error('Local execution not authorised. Review the source and use --allow-local, or configure Docker for verification.');
}
export interface PrepareOptions {repo:string;objective:string;store:string;contractPath?:string;agent?:AgentName;localConsent:boolean;isolatedConsent:boolean;runner:RunnerChoice;io:PromptIO}
export async function prepareRun(options:PrepareOptions){
 const {io,store}=options;await fs.mkdir(store,{recursive:true,mode:0o700});
 io.write('  DISCOVERY · Reading repository evidence (no project code execution)');
 const plan=await discoverProject(options.repo,options.objective);
 const realStore=await fs.realpath(store);if(realStore===plan.repo||realStore.startsWith(plan.repo+path.sep)||plan.repo.startsWith(realStore+path.sep))throw new Error('Evidence store and repository must be separate, non-nested directories.');
 io.write(`  DISCOVERY · ${plan.files.sources.length} source files · ${plan.files.tests.length} test files · ${plan.environment.packageManager} / ${plan.environment.testFramework}`);
 const existing=await repositorySession(store,plan.repo);if(existing)io.write(`  Existing session ${existing}; sentinel continue resumes it. This command starts a new task.`);
 let contractPath=options.contractPath;
 if(!contractPath){const baseline=await captureSnapshot(plan.repo,store);contractPath=(await approvePlan(plan,store,baseline,io)).contractPath;}
 else {const contract=parseContract(JSON.parse(await readLimitedText(path.resolve(contractPath),1000000)));if(contract.objective!==options.objective)throw new Error('Task objective differs from the supplied reviewed contract.');io.write(`  CONTRACT · Using supplied reviewed contract (${contract.requirements.length} requirements).`);}
 const agent=await chooseAgent(store,plan.repo,io,options.agent);
 await consentToExecution(io,options.runner,options.localConsent,options.isolatedConsent);
 return {repo:plan.repo,objective:options.objective,contractPath,agent,store,localConsent:options.runner.kind==='local',isolatedConsent:options.runner.kind==='docker',runner:options.runner};
}
