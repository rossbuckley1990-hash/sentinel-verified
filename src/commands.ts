import { VERSION } from './version.js';
import { help } from './help.js';
import { parseArgs } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { exportSessionPatch } from './patch.js';
import { demo } from './demo.js';
import { exportSession, importSession } from './portable.js';
import { startSession,continueSession,loadCheckpoint } from './session.js';
import { detectAgents } from './agents.js';
import { captureSnapshot,captureRevision,readSnapshot,putObject,getObject,atomicJson } from './store.js';
import { parseContract } from './schema.js';
import { executeVerification, DEFAULT_RUNNER_IMAGE, inspectDocker, type RunnerChoice } from './isolation.js';
import { prepareRun, terminalPrompt, chooseAgent, consentToExecution, rememberSession, repositorySession, selectRepositorySession } from './onboarding.js';
import { openReport } from './report-open.js';
import { writeReport, writePendingReport } from './report.js';
import { banner,line,progress,displayReceipt,displayCheckpoint,SessionView,cleanTerminal } from './terminal.js';
import type { AgentName,Checkpoint,Receipt } from './types.js';

async function main(){
 const {positionals,values}=parseArgs({allowPositionals:true,strict:true,options:{functions:{type:'boolean'},patch:{type:'boolean'},repairs:{type:'string'},'propose-with':{type:'string'},repo:{type:'string'},contract:{type:'string'},agent:{type:'string'},store:{type:'string'},session:{type:'string'},baseline:{type:'string'},'allow-local':{type:'boolean'},'adopt-changes':{type:'boolean'},timeout:{type:'string'},'check-timeout':{type:'string'},out:{type:'string'},runner:{type:'string'},image:{type:'string'},'allow-container':{type:'boolean'},open:{type:'boolean'},verbose:{type:'boolean'},help:{type:'boolean',short:'h'},version:{type:'boolean',short:'v'}}});
 if(values.version){line(`SENTINEL ${VERSION}`);return;}
 const command=positionals[0];if(values.help||!command){line(help);return;}
 const store=path.resolve(values.store??process.env.SENTINEL_HOME??path.join(os.homedir(),'.sentinel'));
 const repo=path.resolve(values.repo??process.cwd());
 const consent=values['allow-local']===true;const isolatedConsent=values['allow-container']===true;
 if(values.runner&&!['local','docker'].includes(values.runner))throw new Error('Runner must be local or docker');
 if(values.image&&values.runner!=='docker')throw new Error('--image requires --runner docker');
 const requestedRunner:RunnerChoice|undefined=values.runner==='docker'?{kind:'docker',image:values.image??DEFAULT_RUNNER_IMAGE}:values.runner==='local'?{kind:'local'}:undefined;
 const view=new SessionView(!!values.verbose);
 const timeout=values.timeout?Number(values.timeout):undefined;if(timeout!==undefined&&(!Number.isSafeInteger(timeout)||timeout<100||timeout>3600000))throw new Error('--timeout must be an integer from 100 to 3600000 ms');
 const checkTimeout=values['check-timeout']?Number(values['check-timeout']):undefined;if(checkTimeout!==undefined&&(!Number.isSafeInteger(checkTimeout)||checkTimeout<100||checkTimeout>300000))throw new Error('--check-timeout must be an integer from 100 to 300000 ms');
 const repairAttempts=values.repairs===undefined?undefined:Number(values.repairs);if(repairAttempts!==undefined&&(!Number.isInteger(repairAttempts)||repairAttempts<0||repairAttempts>3))throw new Error('--repairs must be an integer from 0 to 3');
 if(values['propose-with']&&values['propose-with']!=='codex')throw new Error('Only --propose-with codex is supported');
 const agent=values.agent as AgentName|undefined;
 if(agent&&!['codex','claude','fixture-broken','fixture-fix','fixture-interrupt'].includes(agent))throw new Error('Unknown adapter. Use codex or claude.');
 const abort=new AbortController();const interrupt=()=>{progress('Interrupt requested; preserving the checkpoint');abort.abort();};
 const sessionReport=async(cp:Checkpoint)=>{view.finish();await rememberSession(store,cp);if(cp.receipts.at(-1)){const receipt=JSON.parse((await getObject(store,cp.receipts.at(-1)!)).toString()) as Receipt;if(receipt.candidateHash!==cp.candidateHash)line('  HISTORICAL EVIDENCE: this receipt covers an earlier source snapshot. Current code is UNVERIFIED.');if(cp.state!=='verified'&&receipt.status==='VERIFIED')line('  SESSION INCOMPLETE: earlier scoped checks passed; this continuation has not been accepted.');displayReceipt(receipt,cp);const file=path.join(store,'sessions',cp.id,'report.html');await writeReport(file,receipt,cp,store);line(`  Report      ${file}`);if(values.open)await openReport(file);}else{const file=path.join(store,'sessions',cp.id,'report.html');await writePendingReport(file,cp);line(`  Report      ${file}`);if(values.open)await openReport(file);}displayCheckpoint(cp);if(cp.state!=='verified')process.exitCode=1;};

 switch(command){
  case 'demo':{const result=await demo(store,{application:!values.functions});if(values.open)await openReport(path.join(store,'sessions',result.checkpoint.id,'report.html'));break;}
  case 'doctor':banner();for(const a of await detectAgents())line(`  ${a.name.padEnd(8)} ${a.version||'not installed'} · ${a.reason}`);line('  Local verification requires explicit consent; installed-agent discovery does not establish authentication.');if(requestedRunner?.kind==='docker'){const d=await inspectDocker(requestedRunner.image);line(`  Docker: ${d.reason}`);if(!d.available)process.exitCode=2;}break;
  case 'run':{
   if(!positionals[1])throw new Error('Supply the task objective in quotes');banner();const io=terminalPrompt();
   let prepared;try{prepared=await prepareRun({repo,objective:positionals[1],store,contractPath:values.contract,agent,localConsent:consent,isolatedConsent,runner:requestedRunner??{kind:'local'},io,proposeWith:values['propose-with'] as 'codex'|undefined});}finally{io.close();}
   view.describe(prepared.objective,prepared.repo,prepared.agent);process.on('SIGINT',interrupt);process.on('SIGTERM',interrupt);
   try{await sessionReport(await startSession({...prepared,repairAttempts,onProgress:view.progress,onCheck:view.check,agentTimeoutMs:timeout,verificationTimeoutMs:checkTimeout,signal:abort.signal}));}finally{view.clear();process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt);}break;
  }
  case 'continue':{
   banner();const id=await selectRepositorySession(store,repo,values.session);const previous=await loadCheckpoint(store,id);const io=terminalPrompt();
   let receiving:AgentName;const runner=requestedRunner??previous.runner??{kind:'local'};
   const sameRunner=JSON.stringify(runner)===JSON.stringify(previous.runner??{kind:'local'});
   try{receiving=agent??previous.agents.at(-1)?.agent??await chooseAgent(store,previous.workspace,io);await consentToExecution(io,runner,consent||(sameRunner&&previous.localConsent),isolatedConsent||(sameRunner&&previous.isolatedConsent===true));}finally{io.close();}
   view.describe(previous.objective,previous.workspace,receiving);process.on('SIGINT',interrupt);process.on('SIGTERM',interrupt);
   try{await sessionReport(await continueSession({id:previous.id,store,agent:receiving,localConsent:runner.kind==='local',isolatedConsent:runner.kind==='docker',runner,adoptChanges:values['adopt-changes'],repairAttempts,onProgress:view.progress,onCheck:view.check,agentTimeoutMs:timeout,verificationTimeoutMs:checkTimeout,signal:abort.signal}));}finally{view.clear();process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt);}break;
  }
  case 'export':{if(values.patch){if(!values.out)throw new Error('Supply --out changes.patch');const patch=await exportSessionPatch(store,await selectRepositorySession(store,repo,values.session),values.out);line(JSON.stringify(patch,null,2));line('  Review the patch, then apply it in your own Git workflow. The input repository was not changed.');break;}if(!values.out)throw new Error('Supply --out FILE.sentinel.json');const result=await exportSession(store,await selectRepositorySession(store,repo,values.session),values.out);line(`  Exported ${result.path}\n  SHA-256  ${result.hash}\n  Contains source and logs. Review before sharing.`);break;}
  case 'import':{if(!positionals[1])throw new Error('Supply a checkpoint bundle file');const cp=await importSession(store,positionals[1]);await rememberSession(store,cp);displayCheckpoint(cp);line('  Imported evidence is historical. Continue with --allow-local to verify this environment.');break;}
  case 'inspect':{const cp=await loadCheckpoint(store,await selectRepositorySession(store,repo,values.session));line(JSON.stringify(cp,null,2));break;}
  case 'report':{banner();await sessionReport(await loadCheckpoint(store,await selectRepositorySession(store,repo,values.session)));break;}
  case 'verify':{
   {const io=terminalPrompt();try{await consentToExecution(io,requestedRunner??{kind:'local'},consent,isolatedConsent,false);}finally{io.close();}}banner();await fs.mkdir(store,{recursive:true});
   const realRepo=await fs.realpath(repo),realStore=await fs.realpath(store);
   if(realStore===realRepo||realStore.startsWith(realRepo+path.sep)||realRepo.startsWith(realStore+path.sep))throw new Error('Evidence store and repository must be separate, non-nested paths');
   let contract=null;
   if(values.contract){const file=await fs.realpath(path.resolve(values.contract));if(file===realRepo||file.startsWith(realRepo+path.sep))throw new Error('Approved contract must be outside the repository');const bytes=await fs.readFile(file);if(bytes.length>1_000_000)throw new Error('Contract exceeds 1 MB');contract=parseContract(JSON.parse(bytes.toString()));}
   const contractHash=contract?await putObject(store,JSON.stringify(contract)):null;
   const baseline=await captureRevision(repo,values.baseline??'HEAD',store),candidate=await captureSnapshot(repo,store);
   const receipt=await executeVerification({store,baseline,candidate,contract,contractHash,timeoutMs:checkTimeout,dependencies:path.join(repo,'node_modules'),onProgress:view.progress,onCheck:view.check},requestedRunner??{kind:'local'});
   const hash=await putObject(store,JSON.stringify(receipt));const report=path.join(store,'reports',hash+'.html');await writeReport(report,receipt,undefined,store);await atomicJson(path.join(store,'latest-verification.json'),{schemaVersion:1,receipt:hash,report});view.clear();displayReceipt(receipt);if(values.open)await openReport(report);line(`  Receipt ${hash}`);line(`  Report  ${report}`);if(receipt.status!=='VERIFIED')process.exitCode=receipt.status==='ENVIRONMENT FAILURE'?2:1;break;
  }
  case 'replay':{
   const hash=positionals[1];if(!hash)throw new Error('Supply a receipt hash');const original=JSON.parse((await getObject(store,hash)).toString()) as Receipt;if(![1,2].includes(original.schemaVersion))throw new Error('Unsupported receipt schema');
   const replayRunner=requestedRunner??(original.runner==='container-isolated'?{kind:'docker' as const,image:original.runtime?.containerImageId??DEFAULT_RUNNER_IMAGE}:{kind:'local' as const});
   {const io=terminalPrompt();try{await consentToExecution(io,replayRunner,consent,isolatedConsent,false);}finally{io.close();}}
   const baseline=await readSnapshot(store,original.baselineHash),candidate=await readSnapshot(store,original.candidateHash);const contract=original.contractHash?parseContract(JSON.parse((await getObject(store,original.contractHash)).toString())):null;
   const receipt=await executeVerification({store,baseline,candidate,contract,contractHash:original.contractHash,timeoutMs:checkTimeout,dependencies:path.join(values.repo??original.git.root,'node_modules'),onProgress:view.progress,onCheck:view.check},replayRunner);
   const newHash=await putObject(store,JSON.stringify(receipt));await writeReport(path.join(store,'reports',newHash+'.html'),receipt,undefined,store);view.clear();displayReceipt(receipt);line(`  Replayed receipt ${newHash}`);if(receipt.status!=='VERIFIED')process.exitCode=1;break;
  }
  default:throw new Error(`Unknown command: ${command}\n${help}`);
 }
}
main().catch(error=>{process.stderr.write(cleanTerminal(`SENTINEL: ${error instanceof Error?error.message:String(error)}\n`));process.exitCode=2;});
