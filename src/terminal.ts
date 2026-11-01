import type { Receipt, Checkpoint } from './types.js';
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (text:string,code:string)=>color?`\x1b[${code}m${text}\x1b[0m`:text;
export function cleanTerminal(text:string):string{return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g,'');}
export function line(text=''){process.stdout.write(cleanTerminal(text)+'\n');}
export function banner(){process.stdout.write(paint('\n  SENTINEL','1;36')+'  /  verified progress survives\n\n');}
export function progress(message:string){line(`  · ${message}`);}
export function displayReceipt(receipt:Receipt,checkpoint?:Checkpoint){
 const incomplete=!!checkpoint&&(checkpoint.state!=='verified'||checkpoint.candidateHash!==receipt.candidateHash);
 const presentedStatus=incomplete?'UNVERIFIED':receipt.status;
 const requirements=[...(receipt.contract?.requirements??[]),...(receipt.contract?.scenarios??[])];
 const verified=(kind:string)=>requirements.filter(r=>r.kind===kind&&receipt.checks.some(c=>c.requirementId===r.id&&c.status==='VERIFIED')).length;
 line(`  IMPLEMENTATION · ${receipt.changes.length} changed files`);
 if(requirements.length)line(`  ACCEPTANCE · ${verified('must-change')}/${requirements.filter(r=>r.kind==='must-change').length} changes · ${verified('must-preserve')}/${requirements.filter(r=>r.kind==='must-preserve').length} preserved behaviours verified`);
 if(receipt.coverage)line(`  COVERAGE · ${receipt.coverage.verifiedAspects}/${receipt.coverage.approvedAspects} explicitly reviewed objective aspects verified`);
 line('  TASK → AGENT → CHANGES → VERIFICATION → EVIDENCE → CONTINUATION');line();
 line(`  ${receipt.objective}`);line();
 for(const c of receipt.checks.filter(c=>!c.id.startsWith('baseline:')&&!c.id.startsWith('probe-baseline:')&&!c.id.startsWith('mutation:'))){
  line(`  ${c.status==='VERIFIED'?'✓':c.status==='CONTRADICTED'?'✕':'!'} ${c.status.padEnd(20)} ${c.label}`);
  if(c.status!=='VERIFIED'||c.id==='candidate-tests')line(`    ${c.detail}`);
  if(c.status==='CONTRADICTED'&&c.args){line(`    Input     ${JSON.stringify(c.args)}`);line(`    Expected  ${JSON.stringify(c.expected)}`);line(`    Observed  ${JSON.stringify(c.observed)}`);}
  if(c.counterexample)line(`    Reduced   ${JSON.stringify(c.counterexample.original)} → ${JSON.stringify(c.counterexample.minimal)} (${c.counterexample.attempts} attempts)`);
 }
 for(const c of receipt.changes.filter(c=>c.classification!=='VERIFIED'))line(`  ! REVIEW REQUIRED      ${c.path}: ${c.reason}`);
 line();line(`  ${presentedStatus} · ${(receipt.durationMs/1000).toFixed(2)}s · ${receipt.runner==='container-isolated'?'container verification':'local advisory verification'}`);
 if(incomplete)line(`  Current session is incomplete. Recorded receipt: ${receipt.status}; it does not establish completion of this stage.`);
 line('  Results cover the executed checks. They do not prove arbitrary correctness.');
}
export function displayCheckpoint(cp:Checkpoint){line(`  Session     ${cp.id} · ${cp.state}`);line(`  Workspace   ${cp.workspace}`);line(`  Evidence    ${cp.receipts.at(-1)??'No completed verification yet'}`);if(cp.state!=='verified')for(const next of cp.nextActions.slice(0,4))line(`  Next        ${next}`);}

/** A compact view of one session, using ordinary readable lines in headless terminals. */
export class SessionView {
 private stage='DISCOVERY'; private passed=0; private contradicted=0; private unknown=0; private live=false;
 constructor(private verbose=false){}
 describe(task:string,repo:string,agent:string){line(`  Task        ${task}`);line(`  Agent       ${agent}`);line(`  Repository  ${repo}`);line();}
 progress=(message:string)=>{
  const stage=/^(Checking clean|Running candidate|Re-running|Comparing|Challenging|Verification is isolated|Agent finished)/i.test(message)?'VERIFICATION':/agent|editing|working|fixture/i.test(message)?'IMPLEMENTATION':this.stage;
  if(stage!==this.stage){this.clear();this.stage=stage;line(`  ${stage} · Running`);}
  if(this.verbose){this.clear();progress(message);}
  else if(!process.stdout.isTTY||process.env.NO_COLOR){progress(message);}
  else if(process.stdout.isTTY&&!process.env.NO_COLOR){this.clear();process.stdout.write(`\r  ${this.stage} · ${cleanTerminal(message).slice(0,Math.max(35,(process.stdout.columns??100)-25))}`);this.live=true;}
 };
 check=(check:import('./types.js').Check)=>{
  if(check.id.startsWith('baseline:')||check.id.startsWith('probe-baseline:')||check.id.startsWith('mutation:'))return;
  if(check.status==='VERIFIED')this.passed++;else if(check.status==='CONTRADICTED')this.contradicted++;else this.unknown++;
  this.clear();const counts=`${this.passed} passed · ${this.contradicted} contradicted · ${this.unknown} unresolved`;
  if(check.status!=='VERIFIED'||this.verbose)line(`  ${check.status} · ${check.label}`);
  if(process.stdout.isTTY&&!process.env.NO_COLOR){process.stdout.write(`\r  VERIFICATION · ${counts}`);this.live=true;}
 };
 clear(){if(this.live){process.stdout.write('\r\x1b[2K');this.live=false;}}
 finish(){this.clear();line('  EVIDENCE · Saved · CONTINUATION · Ready');}
}
