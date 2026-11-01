import type { Receipt, Checkpoint } from './types.js';
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (text:string,code:string)=>color?`\x1b[${code}m${text}\x1b[0m`:text;
export function cleanTerminal(text:string):string{return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g,'');}
export function line(text=''){process.stdout.write(cleanTerminal(text)+'\n');}
export function banner(){process.stdout.write(paint('\n  SENTINEL','1;36')+'  /  verified progress survives\n\n');}
export function progress(message:string){line(`  · ${message}`);}
export function displayReceipt(receipt:Receipt){
 line('  TASK → AGENT → CHANGES → VERIFICATION → EVIDENCE → CONTINUATION');line();
 line(`  ${receipt.objective}`);line();
 for(const c of receipt.checks.filter(c=>!c.id.startsWith('baseline:')&&!c.id.startsWith('probe-baseline:')&&!c.id.startsWith('mutation:'))){
  line(`  ${c.status==='VERIFIED'?'✓':c.status==='CONTRADICTED'?'✕':'!'} ${c.status.padEnd(20)} ${c.label}`);
  if(c.status!=='VERIFIED'||c.id==='candidate-tests')line(`    ${c.detail}`);
  if(c.status==='CONTRADICTED'&&c.args){line(`    Input     ${JSON.stringify(c.args)}`);line(`    Expected  ${JSON.stringify(c.expected)}`);line(`    Observed  ${JSON.stringify(c.observed)}`);}
  if(c.counterexample)line(`    Reduced   ${JSON.stringify(c.counterexample.original)} → ${JSON.stringify(c.counterexample.minimal)} (${c.counterexample.attempts} attempts)`);
 }
 for(const c of receipt.changes.filter(c=>c.classification!=='VERIFIED'))line(`  ! REVIEW REQUIRED      ${c.path}: ${c.reason}`);
 line();line(`  ${receipt.status} · ${(receipt.durationMs/1000).toFixed(2)}s · local advisory verification`);
 line('  Results cover the executed checks. They do not prove arbitrary correctness.');
}
export function displayCheckpoint(cp:Checkpoint){line(`  Session     ${cp.id} · ${cp.state}`);line(`  Workspace   ${cp.workspace}`);line(`  Evidence    ${cp.receipts.at(-1)??'No completed verification yet'}`);if(cp.state!=='verified')for(const next of cp.nextActions.slice(0,4))line(`  Next        ${next}`);}
