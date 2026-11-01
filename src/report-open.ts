import { realpath, stat } from 'node:fs/promises';
import { runCommand } from './process.js';
export function reportOpenCommand(file:string,platform=process.platform):string[]{
 if(platform==='darwin')return ['open',file];if(platform==='linux')return ['xdg-open',file];
 throw new Error('Automatic report opening is supported on macOS and Linux. Open the displayed HTML path manually.');
}
export async function openReport(file:string):Promise<void>{
 const real=await realpath(file);if(!(await stat(real)).isFile())throw new Error('Report is not a regular file.');
 if(process.platform==='linux'&&!process.env.DISPLAY&&!process.env.WAYLAND_DISPLAY)throw new Error(`Report generated at ${real}. No graphical display is available; open it on a desktop browser.`);
 const record=await runCommand(reportOpenCommand(real),process.cwd(),{timeoutMs:10000});
 if(record.exitCode!==0)throw new Error(`Report generated at ${real}, but the desktop opener failed: ${record.stderr.slice(0,300)}`);
}
