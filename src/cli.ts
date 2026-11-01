#!/usr/bin/env node
// Keep help/version independent of the parser, browser and verification runtime.
import { VERSION } from './version.js';
import { help } from './help.js';
const args=process.argv.slice(2);
if(args.length===1&&['--version','-v'].includes(args[0]!))process.stdout.write(`SENTINEL ${VERSION}\n`);
else if(args.length===0||args.length===1&&['--help','-h'].includes(args[0]!))process.stdout.write(help+'\n');
else await import('./commands.js');
