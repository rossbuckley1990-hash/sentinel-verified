import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { applicationConfigSchema, applicationScenarioSchema, type ApplicationConfig, type ApplicationScenario } from './application-schema.js';
import type { DiscoveryPlan } from './discovery.js';
import type { Contract, Snapshot } from './types.js';
import type { PromptIO } from './onboarding.js';
import { atomicJson, captureSnapshot, getObject, putObject, safeRelative } from './store.js';
import { parseContract } from './schema.js';
import { proposeApplication } from './model-proposal.js';

export interface ApplicationDiscovery { category:string; command:string[]; routes:string[]; selectors:string[]; evidence:string[] }
/** Source hints describe possible targets, never the expected outcome of the task. */
export async function discoverApplication(plan:DiscoveryPlan,baseline:Snapshot,store:string):Promise<ApplicationDiscovery|null>{
 let pkg:{scripts?:Record<string,string>;dependencies?:Record<string,string>;devDependencies?:Record<string,string>}={};
 if(baseline.files['package.json'])try{pkg=JSON.parse((await getObject(store,baseline.files['package.json'].hash)).toString());}catch{/* malformed package is reported by existing discovery */}
 const deps={...pkg.dependencies,...pkg.devDependencies};const files=Object.keys(baseline.files);
 const server=files.find(f=>/^(?:src\/)?(?:server|app|index)\.[cm]?[jt]s$/.test(f));
 const scripts=pkg.scripts??{};const vite=!!deps.vite&&Object.values(scripts).some(s=>/^vite(?:\s|$)/.test(s));
 const framework=!!deps.react||!!deps.express||!!deps.fastify||vite;
 let nodeServer=false;const routes=new Set<string>(),selectors=new Set<string>();const evidence:string[]=[];
 for(const name of plan.files.sources.slice(0,80)){
  const entry=baseline.files[name];if(!entry||entry.size>200000)continue;const text=(await getObject(store,entry.hash)).toString();
  if(/createServer\s*\(|(?:express|fastify)\s*\(/.test(text)){nodeServer=true;evidence.push(name);}
  for(const match of text.matchAll(/(?:\.(?:get|post|put|delete|patch)\s*\(|(?:pathname|url)\s*===?\s*)['"](\/[^'"\n ]*)['"]/g))routes.add(match[1]!);
  for(const match of text.matchAll(/data-testid\s*=\s*["']([\w-]+)["']/g))selectors.add(`[data-testid="${match[1]}"]`);
 }
 if(!framework&&!nodeServer)return null;
 let command:string[]=[];
 if(vite)command=['node','node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','{port}','--strictPort'];
 else if(server)command=/\.[cm]?ts$/.test(server)?['node','--import','tsx',server]:['node',server];
 else if(scripts.start&&/^node\s+[\w./-]+$/.test(scripts.start))command=scripts.start.split(/\s+/);
 return {category:deps.react?'React web application':vite?'Vite web application':'Node HTTP application',command,routes:[...routes].slice(0,20),selectors:[...selectors].slice(0,30),evidence:[...new Set(evidence)].slice(0,20)};
}
/** Small argv reader: quote grouping only; no shell expansion, pipes or evaluation. */
export function parseArgv(text:string):string[]{
 const result:string[]=[];let token='',quote='',active=false;
 for(const c of text){if(quote){if(c===quote)quote='';else token+=c;active=true;}else if(c==='"'||c==="'"){quote=c;active=true;}else if(/\s/.test(c)){if(active){result.push(token);token='';active=false;}}else{token+=c;active=true;}}
 if(quote)throw new Error('Close the quoted argument. Shell operators and substitutions are not evaluated.');if(active)result.push(token);return result;
}
async function addScenario(io:PromptIO,discovery:ApplicationDiscovery,existing?:ApplicationScenario):Promise<ApplicationScenario>{
 const answer=(await io.ask(`  Check HTTP response or browser interaction [${existing?.type??'http'}]: `)||existing?.type||'http').toLowerCase();if(!['http','browser'].includes(answer))throw new Error('Choose http or browser.');
 const kindAnswer=(await io.ask(`  Must change or preserve [${existing?.kind==='must-preserve'?'preserve':'change'}]: `)|| (existing?.kind==='must-preserve'?'preserve':'change')).toLowerCase();if(!['change','preserve'].includes(kindAnswer))throw new Error('Choose change or preserve.');
 const description=await io.ask(`  Expected behaviour${existing?' [keep current]':''}: `)||existing?.description;if(!description)throw new Error('Describe the expected behaviour.');
 const pathname=await io.ask(`  Local URL path [${existing?.path??discovery.routes[0]??'/'}]: `)||existing?.path||discovery.routes[0]||'/';
 const common={id:existing?.id??`application-${randomUUID().slice(0,8)}`,kind:kindAnswer==='change'?'must-change':'must-preserve',description,path:pathname};
 if(answer==='http'){
  const method=(await io.ask(`  HTTP method [${existing?.type==='http'?existing.method:'GET'}]: `)|| (existing?.type==='http'?existing.method:'GET')).toUpperCase();
  let body:unknown;if(!['GET','HEAD'].includes(method)){const value=await io.ask('  Request JSON body [none]: ');if(value)body=JSON.parse(value);}
  const status=Number(await io.ask('  Expected status [200]: ')||200);const bodyType=(await io.ask('  Response body: json or text [json]: ')||'json').toLowerCase();const value=await io.ask('  Exact expected response body: ');
  return applicationScenarioSchema.parse({...common,type:'http',method,...(body===undefined?{}:{body}),expected:{status,bodyType,body:bodyType==='json'?JSON.parse(value):value}});
 }
 io.write(`  Source selector hints: ${discovery.selectors.join(', ')||'none found; use a stable CSS selector'}`);
 const steps:unknown[]=[];for(let i=0;i<20;i++){
  const action=(await io.ask('  Interaction: click, fill, select, press, check, or Enter to assert: ')).toLowerCase();if(!action)break;
  const selector=await io.ask('  CSS selector: ');
  if(action==='click')steps.push({action,selector});else if(action==='check')steps.push({action,selector,checked:(await io.ask('  Checked? yes/no [yes]: ')||'yes')==='yes'});else if(action==='press')steps.push({action,selector,key:await io.ask('  Key: Enter, Escape or Tab: ')});else steps.push({action,selector,value:await io.ask('  Value: ')});
 }
 const selector=await io.ask('  Element to check (CSS selector): ');const property=(await io.ask('  Check text, value, or visible [text]: ')||'text').toLowerCase();const value=await io.ask('  Exact expected value: ');
 return applicationScenarioSchema.parse({...common,type:'browser',steps,assertions:[{selector,property,expected:property==='visible'?value==='true'||value==='yes':value}]});
}
export async function approveApplicationPlan(plan:DiscoveryPlan,baseline:Snapshot,store:string,io:PromptIO,discovery:ApplicationDiscovery,model?:'codex'){
 if(!io.interactive)throw new Error('Application acceptance requires interactive review or a reviewed --contract file. No project code ran.');
 io.write(`\n  APPLICATION · ${discovery.category}`);io.write('  Acceptance scenarios run against a fresh local server. Expected results must come from your objective, not the current implementation.');
 let application:ApplicationConfig=applicationConfigSchema.parse({command:discovery.command.length?discovery.command:['node','server.js'],readyPath:'/'});
 const start=await io.ask(`  Server command [${discovery.command.join(' ')||'enter argv'}]: `);if(start)application={...application,command:parseArgv(start)};else if(!discovery.command.length)throw new Error('A reviewed server command is required.');
 application=applicationConfigSchema.parse({...application,readyPath:await io.ask('  Readiness path [/]: ')||'/'});
 io.write('  Server must bind 127.0.0.1 and use PORT, or the {port} argv placeholder. No shell syntax is evaluated.');
 const scenarios:ApplicationScenario[]=[];const unresolved:string[]=[];const resolutions:{question:string;reason:string}[]=[];
 if(model){const proposed=await proposeApplication(plan,baseline,store,application);scenarios.push(...proposed.scenarios);unresolved.push(...proposed.questions);io.write('  MODEL PROPOSAL · Unapproved suggestions. Inspect every expected value before approval.');}
 if(!scenarios.length)scenarios.push(await addScenario(io,discovery));
 const defaultPaths=plan.files.sources.filter(f=>!/\.(?:test|spec)\./.test(f)).slice(0,100);
 let allowedPaths=defaultPaths;
 let confirmed=false;
 for(;;){
  io.write(`\n  TASK · ${plan.objective}\n  SERVER · ${JSON.stringify(application.command)} · ready ${application.readyPath??'/'}`);
  scenarios.forEach((s,i)=>{io.write(`  ${i+1}. ${s.kind.toUpperCase()} · ${s.description}`);io.write(`     ${JSON.stringify(s)}`);});
  io.write(`  Allowed changed paths: ${allowedPaths.join(', ')||'(none)'}`);unresolved.forEach((q,i)=>io.write(`  Unresolved ${i+1}: ${q}`));
  const action=(await io.ask('  [Approve] [Add] [Edit] [Remove] [Paths] [Question] [Resolve] [Quit]: ')).toLowerCase();
  if(action==='quit'||action==='q')throw new Error('Plan rejected. No agent or application ran.');
  try{
   if(action==='add'){scenarios.push(await addScenario(io,discovery));continue;}
   if(action==='edit'||action==='remove'){const index=Number(await io.ask('  Scenario number: '))-1;if(!scenarios[index])throw new Error('Choose a listed scenario.');if(action==='remove')scenarios.splice(index,1);else scenarios[index]=await addScenario(io,discovery,scenarios[index]);continue;}
   if(action==='paths'){allowedPaths=(await io.ask('  Comma-separated authorised file paths: ')).split(',').map(x=>x.trim()).filter(Boolean);if(allowedPaths.some(p=>!safeRelative(p)))throw new Error('Use safe relative file paths.');continue;}
   if(action==='question'){const q=await io.ask('  Unspecified or ambiguous behaviour: ');if(q)unresolved.push(q);continue;}
   if(action==='resolve'){const index=Number(await io.ask('  Question number: '))-1;if(!unresolved[index])throw new Error('Choose a listed question.');io.write('  Add/edit the corresponding acceptance scenario before removing the question.');const decision=await io.ask('  Resolution and scenario ID (recorded): ');if(decision){resolutions.push({question:unresolved[index]!,reason:decision});unresolved.splice(index,1);}continue;}
   if(action!=='approve'&&action!=='a')continue;
   const coverageAnswer=(await io.ask('  Do these examples cover all outcomes you intend for this task? yes or limited: ')).toLowerCase();if(!['yes','limited'].includes(coverageAnswer)){io.write('  Enter yes or limited. Approval has not been recorded.');continue;}confirmed=coverageAnswer==='yes';
   if(!confirmed)unresolved.push('Developer approved limited coverage of the objective; full-task completion remains unverified.');
   let intent:'change'|'preserve'='change';
   if(!scenarios.some(s=>s.kind==='must-change')){if((await io.ask('  Is this solely a preservation/refactor task with no intended behaviour change? yes/no: ')).toLowerCase()==='yes')intent='preserve';else unresolved.push('No must-change application example was approved.');}
   const current=await captureSnapshot(plan.repo,store);if(current.hash!==baseline.hash)throw new Error('Source changed during review. Restart to approve a fresh baseline.');
   const contractWithoutApproval={schemaVersion:3,objective:plan.objective,approvedBy:'Developer via interactive terminal approval',requirements:[],application,scenarios,allowedPaths,unresolved,discoveryLimits:['Application results cover only the approved examples. Source route and selector hints are not expected-value evidence.'],coverage:{intent,confirmed,aspects:[{id:'objective',description:plan.objective,requirementIds:scenarios.map(s=>s.id)}]}};
   const proposalHash=await putObject(store,JSON.stringify({schemaVersion:2,contract:contractWithoutApproval,resolvedQuestions:resolutions}));
   const contract:Contract=parseContract({...contractWithoutApproval,approval:{method:'interactive',approvedAt:new Date().toISOString(),proposalHash,baselineHash:baseline.hash,requirementIds:scenarios.map(s=>s.id),resolvedQuestions:resolutions}});
   const hash=await putObject(store,JSON.stringify(contract));const contractPath=path.join(store,'contracts',hash+'.json');await atomicJson(contractPath,contract);io.write(`  CONTRACT · Approved ${scenarios.length} application scenarios. Protected outside the agent workspace.`);return {contract,contractPath,proposalHash};
  }catch(error){if(String(error).includes('Source changed'))throw error;io.write(`  ${String(error)}`);}
 }
}
