// This worker is an execution boundary for errors/timeouts, NOT a security sandbox.
import { pathToFileURL } from 'node:url';
import { isAbsolute, resolve, sep } from 'node:path';
interface Call { module: string; export: string; args: unknown[] }
const chunks: Buffer[]=[];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const input = JSON.parse(Buffer.concat(chunks).toString()) as { root: string; nonce: string; calls: Call[] };
const output: unknown[]=[];
for(const call of input.calls) {
  const file=resolve(input.root,call.module);
  if(isAbsolute(call.module)||!file.startsWith(resolve(input.root)+sep)) throw new Error('Unsafe module path');
  let mod: Record<string, unknown>;
  try { mod=await import(pathToFileURL(file).href); } catch(error) {output.push({ok:false,kind:'import',error:String(error)});continue;}
  const fn=mod[call.export];
  if(typeof fn!=='function'){output.push({ok:false,kind:'import',error:`Export ${call.export} is not a function`});continue;}
  try {
    const value=await fn(...call.args);
    function valid(v: unknown, seen = new Set<unknown>()): boolean {
      if(v===null||typeof v==='string'||typeof v==='boolean')return true;
      if(typeof v==='number')return Number.isFinite(v);
      if(typeof v!=='object'||seen.has(v))return false; seen.add(v);
      const ok=(Array.isArray(v)||Object.getPrototypeOf(v)===Object.prototype)&&Object.values(v).every(x=>valid(x,seen));seen.delete(v);return ok;
    }
    if(!valid(value))output.push({ok:false,kind:'serialization',error:'Only finite JSON return values are supported'});
    else output.push({ok:true,value});
  }catch(error){output.push({ok:false,kind:'execution',error:String(error)});}
}
process.stdout.write(`\nSENTINEL_RESULT_${input.nonce}:`+JSON.stringify(output)+'\n');
