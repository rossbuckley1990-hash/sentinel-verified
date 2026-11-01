#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { demo } from './demo.js';
import { exportSession, importSession } from './portable.js';
import { startSession,continueSession,loadCheckpoint } from './session.js';
import { detectAgents } from './agents.js';
import { captureSnapshot,captureRevision,readSnapshot,putObject,getObject,atomicJson } from './store.js';
import { parseContract } from './schema.js';
import { verify } from './verifier.js';
import { writeReport } from './report.js';
import { banner,line,progress,displayReceipt,displayCheckpoint } from './terminal.js';
import type { AgentName,Checkpoint,Receipt } from './types.js';
const help=`SENTINEL · evidence-backed verification and continuity

  sentinel demo                         Run the controlled offline experiment
  sentinel run "objective"               Start an agent in a managed workspace
  sentinel continue --agent claude       Continue the latest evidence checkpoint
  sentinel verify --baseline HEAD        Verify current repository changes
  sentinel inspect                       Inspect the current checkpoint
  sentinel report                        Write the current local HTML report
  sentinel replay RECEIPT_HASH           Re-run a stored verification snapshot
  sentinel export --out task.sentinel.json  Export portable source + evidence
  sentinel import task.sentinel.json     Restore a checkpoint into a new store
  sentinel doctor                        Detect installed agent CLI capabilities

  --repo PATH          Input Git repository (default: current directory)
  --contract FILE      Reviewed JSON contract outside the input repository
  --agent NAME         codex or claude (run auto-detects if omitted)
  --allow-local        Consent to running project code locally without isolation
  --store PATH         Evidence store (default: ~/.sentinel or SENTINEL_HOME)
  --session ID         Select a checkpoint instead of the latest session
  --adopt-changes       Explicitly accept manual workspace edits as unverified
  --timeout MS         Agent timeout (default: 600000)

Local checks are advisory. Use a disposable isolated machine for untrusted code.
Exit: 0 scoped checks passed; 1 contradiction/review/unknown; 2 usage/infrastructure error.
`;
async function main(){
 const {positionals,values}=parseArgs({allowPositionals:true,strict:true,options:{repo:{type:'string'},contract:{type:'string'},agent:{type:'string'},store:{type:'string'},session:{type:'string'},baseline:{type:'string'},'allow-local':{type:'boolean'},'adopt-changes':{type:'boolean'},timeout:{type:'string'},out:{type:'string'},help:{type:'boolean',short:'h'},version:{type:'boolean',short:'v'}}});
 if(values.version){line('SENTINEL 0.1.0');return;}
 const command=positionals[0];if(values.help||!command){line(help);return;}
 const store=path.resolve(values.store??process.env.SENTINEL_HOME??path.join(os.homedir(),'.sentinel'));
 const repo=path.resolve(values.repo??process.cwd());
 const consent=values['allow-local']===true;
 const timeout=values.timeout?Number(values.timeout):undefined;if(timeout!==undefined&&(!Number.isSafeInteger(timeout)||timeout<100||timeout>3600000))throw new Error('--timeout must be an integer from 100 to 3600000 ms');
 const agent=values.agent as AgentName|undefined;
 if(agent&&!['codex','claude','fixture-broken','fixture-fix','fixture-interrupt'].includes(agent))throw new Error('Unknown adapter. Use codex or claude.');
 const abort=new AbortController();const interrupt=()=>{progress('Interrupt requested; preserving the checkpoint');abort.abort();};
 const sessionReport=async(cp:Checkpoint)=>{if(cp.receipts.at(-1)){const receipt=JSON.parse((await getObject(store,cp.receipts.at(-1)!)).toString()) as Receipt;if(receipt.candidateHash!==cp.candidateHash)line('  HISTORICAL EVIDENCE: this receipt covers an earlier source snapshot. Current code is UNVERIFIED.');displayReceipt(receipt);const file=path.join(store,'sessions',cp.id,'report.html');await writeReport(file,receipt,cp);line(`  Report      ${file}`);}displayCheckpoint(cp);if(cp.state!=='verified')process.exitCode=1;};
 const requireConsent=()=>{if(!consent)throw new Error('Project code runs under your OS account without isolation. Review it, then pass --allow-local to consent. For untrusted code run SENTINEL inside a disposable isolated machine.');};
 switch(command){
  case 'demo':await demo(store);break;
  case 'doctor':banner();for(const a of await detectAgents())line(`  ${a.name.padEnd(8)} ${a.version||'not installed'} · ${a.reason}`);line('  Runner: local advisory only; --allow-local is required for project execution.');break;
  case 'run':{
   if(!positionals[1])throw new Error('Supply the task objective in quotes');banner();process.on('SIGINT',interrupt);process.on('SIGTERM',interrupt);
   try{await sessionReport(await startSession({repo,objective:positionals[1],contractPath:values.contract,agent,store,localConsent:consent,onProgress:progress,agentTimeoutMs:timeout,signal:abort.signal}));}finally{process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt);}break;
  }
  case 'continue':{
   if(!agent)throw new Error('Select the receiving adapter with --agent codex or --agent claude');banner();process.on('SIGINT',interrupt);process.on('SIGTERM',interrupt);
   try{await sessionReport(await continueSession({id:values.session,store,agent,localConsent:consent?true:undefined,adoptChanges:values['adopt-changes'],onProgress:progress,agentTimeoutMs:timeout,signal:abort.signal}));}finally{process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt);}break;
  }
  case 'export':{if(!values.out)throw new Error('Supply --out FILE.sentinel.json');const result=await exportSession(store,values.session,values.out);line(`  Exported ${result.path}\n  SHA-256  ${result.hash}\n  Contains source and logs. Review before sharing.`);break;}
  case 'import':{if(!positionals[1])throw new Error('Supply a checkpoint bundle file');const cp=await importSession(store,positionals[1]);displayCheckpoint(cp);line('  Imported evidence is historical. Continue with --allow-local to verify this environment.');break;}
  case 'inspect':{const cp=await loadCheckpoint(store,values.session);line(JSON.stringify(cp,null,2));break;}
  case 'report':{banner();await sessionReport(await loadCheckpoint(store,values.session));break;}
  case 'verify':{
   requireConsent();banner();await fs.mkdir(store,{recursive:true});
   const realRepo=await fs.realpath(repo),realStore=await fs.realpath(store);
   if(realStore===realRepo||realStore.startsWith(realRepo+path.sep)||realRepo.startsWith(realStore+path.sep))throw new Error('Evidence store and repository must be separate, non-nested paths');
   let contract=null;
   if(values.contract){const file=await fs.realpath(path.resolve(values.contract));if(file===realRepo||file.startsWith(realRepo+path.sep))throw new Error('Approved contract must be outside the repository');const bytes=await fs.readFile(file);if(bytes.length>1_000_000)throw new Error('Contract exceeds 1 MB');contract=parseContract(JSON.parse(bytes.toString()));}
   const contractHash=contract?await putObject(store,JSON.stringify(contract)):null;
   const baseline=await captureRevision(repo,values.baseline??'HEAD',store),candidate=await captureSnapshot(repo,store);
   const receipt=await verify({store,baseline,candidate,contract,contractHash,dependencies:path.join(repo,'node_modules'),onProgress:progress});
   const hash=await putObject(store,JSON.stringify(receipt));const report=path.join(store,'reports',hash+'.html');await writeReport(report,receipt);await atomicJson(path.join(store,'latest-verification.json'),{schemaVersion:1,receipt:hash,report});displayReceipt(receipt);line(`  Receipt ${hash}`);line(`  Report  ${report}`);if(receipt.status!=='VERIFIED')process.exitCode=receipt.status==='ENVIRONMENT FAILURE'?2:1;break;
  }
  case 'replay':{
   requireConsent();const hash=positionals[1];if(!hash)throw new Error('Supply a receipt hash');const original=JSON.parse((await getObject(store,hash)).toString()) as Receipt;if(original.schemaVersion!==1)throw new Error('Unsupported receipt schema');
   const baseline=await readSnapshot(store,original.baselineHash),candidate=await readSnapshot(store,original.candidateHash);const contract=original.contractHash?parseContract(JSON.parse((await getObject(store,original.contractHash)).toString())):null;
   const receipt=await verify({store,baseline,candidate,contract,contractHash:original.contractHash,dependencies:path.join(values.repo??original.git.root,'node_modules'),onProgress:progress});
   const newHash=await putObject(store,JSON.stringify(receipt));await writeReport(path.join(store,'reports',newHash+'.html'),receipt);displayReceipt(receipt);line(`  Replayed receipt ${newHash}`);if(receipt.status!=='VERIFIED')process.exitCode=1;break;
  }
  default:throw new Error(`Unknown command: ${command}\n${help}`);
 }
}
main().catch(error=>{process.stderr.write(`SENTINEL: ${error instanceof Error?error.message:String(error)}\n`);process.exitCode=2;});
