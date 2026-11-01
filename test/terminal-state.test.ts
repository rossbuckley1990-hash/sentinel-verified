import {it,expect,vi} from 'vitest';
import {displayReceipt} from '../src/terminal.js';
import type {Receipt,Checkpoint} from '../src/types.js';
it('presents an interrupted current stage as unverified while preserving an earlier passing receipt',()=>{
 const receipt:Receipt={schemaVersion:1,id:'earlier',createdAt:'2026-11-01T00:00:00Z',objective:'Fix response',baselineHash:'a'.repeat(64),candidateHash:'b'.repeat(64),contractHash:null,git:{root:'/example',head:'c'.repeat(40),branch:'main',dirty:true},runner:'local-advisory',checks:[],changes:[],status:'VERIFIED',durationMs:1,limitations:[],nextActions:[]};
 const cp:Checkpoint={schemaVersion:1,id:'s-interrupted',objective:receipt.objective,createdAt:receipt.createdAt,updatedAt:receipt.createdAt,repo:'/example',workspace:'/store/workspaces/s-interrupted',baselineHash:receipt.baselineHash,candidateHash:receipt.candidateHash,contractHash:null,state:'interrupted',receipts:['d'.repeat(64)],agents:[],nextActions:[],openQuestions:[],unverifiedStatements:[],localConsent:true};
 let output='';const spy=vi.spyOn(process.stdout,'write').mockImplementation((chunk:any)=>{output+=String(chunk);return true;});
 try{displayReceipt(receipt,cp);}finally{spy.mockRestore();}
 expect(output).toContain('UNVERIFIED ·');expect(output).toContain('does not establish completion of this stage');expect(output).not.toMatch(/^  VERIFIED ·/m);expect(receipt.status).toBe('VERIFIED');
});
