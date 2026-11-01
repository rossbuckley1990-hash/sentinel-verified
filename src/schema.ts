import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { safeRelative } from './store.js';
import type { Contract, Json } from './types.js';
const json: z.ZodType<Json> = z.lazy(()=>z.union([z.null(),z.boolean(),z.number().finite(),z.string().max(100000),z.array(json).max(1000),z.record(z.string(), json)]));
const modulePath=z.string().max(500).refine(safeRelative,'must be a safe relative module path');
const example=z.object({args:z.array(json).max(20),expected:json}).strict();
const invariant=z.object({argument:z.number().int().min(0).max(19),domain:z.enum(['string','number','array']),seeds:z.array(json).min(1).max(30),args:z.array(json).max(20),expected:json}).strict().superRefine((x,ctx)=>{
  if(x.argument>=x.args.length) ctx.addIssue({code:'custom',message:'invariant argument must index args'});
  if(x.seeds.some(s=>x.domain==='array'?!Array.isArray(s):typeof s!==x.domain))ctx.addIssue({code:'custom',message:'invariant seeds must belong to the approved domain'});
});
export const contractSchema=z.object({schemaVersion:z.union([z.literal(1),z.literal(2)]),objective:z.string().min(1).max(5000),approvedBy:z.string().min(1).max(200),requirements:z.array(z.object({id:z.string().min(1).max(100),kind:z.enum(['must-change','must-preserve']),description:z.string().min(1).max(2000),module:modulePath,export:z.string().regex(/^[a-zA-Z_$][\w$]*$/),cases:z.array(example).max(100),invariant:invariant.optional()}).strict().refine(r=>r.cases.length>0||r.invariant,'requirement must have cases or an invariant')).max(100),probes:z.array(z.object({id:z.string().min(1),module:modulePath,export:z.string().regex(/^[a-zA-Z_$][\w$]*$/),inputs:z.array(z.array(json).max(20)).min(1).max(100)}).strict()).max(50).optional(),allowedPaths:z.array(modulePath).max(500).optional(),discoveryLimits:z.array(z.string().max(2000)).max(150).optional(),unresolved:z.array(z.string().max(2000)).max(100).optional(),approval:z.object({method:z.literal('interactive'),approvedAt:z.string().datetime(),proposalHash:z.string().regex(/^[a-f0-9]{64}$/),baselineHash:z.string().regex(/^[a-f0-9]{64}$/),requirementIds:z.array(z.string().min(1).max(100)).max(100),resolvedQuestions:z.array(z.object({question:z.string().max(2000),reason:z.string().min(1).max(2000)}).strict()).max(100)}).strict().optional()}).strict().superRefine((x,ctx)=>{
  if(x.schemaVersion===1&&(x.approval||x.unresolved||x.discoveryLimits))ctx.addIssue({code:'custom',message:'Discovery metadata requires contract schema version 2'});
  if(x.schemaVersion===2&&!x.approval)ctx.addIssue({code:'custom',message:'Version 2 requires explicit interactive approval metadata'});
  if(x.approval&&JSON.stringify([...x.approval.requirementIds].sort())!==JSON.stringify(x.requirements.map(r=>r.id).sort()))ctx.addIssue({code:'custom',message:'Approval must identify exactly the approved requirements'});
  const ids=x.requirements.map(r=>r.id);if(new Set(ids).size!==ids.length)ctx.addIssue({code:'custom',message:'Requirement IDs must be unique'});
});
export function parseContract(value: unknown): Contract {return contractSchema.parse(value) as Contract;}


/** Detect single-file contract drift without pretending the whole local store is authenticated. */
export function validateApprovalProposal(contract:Contract,proposal:unknown):void {
 if(contract.schemaVersion!==2)return;
 if(!proposal||typeof proposal!=='object')throw new Error('Approved proposal is malformed; review a fresh plan.');
 const p=proposal as {schemaVersion?:number;objective?:unknown;proposed?:{selected?:unknown;requirement?:unknown}[];uncertainties?:unknown;resolvedQuestions?:unknown};
 if(p.schemaVersion!==1||!Array.isArray(p.proposed)||p.proposed.some(item=>!item||typeof item.selected!=='boolean'))throw new Error('Approved proposal is malformed; review a fresh plan.');
 const requirements=p.proposed.filter(item=>item.selected).map(item=>item.requirement);
 if(p.objective!==contract.objective||!isDeepStrictEqual(requirements,contract.requirements)||!isDeepStrictEqual(p.uncertainties,contract.unresolved??[])||!isDeepStrictEqual(p.resolvedQuestions,contract.approval?.resolvedQuestions)||!isDeepStrictEqual([...new Set(contract.requirements.map(r=>r.module))],contract.allowedPaths)||contract.probes?.length)throw new Error('Contract differs from the reviewed proposal. Review and approve a fresh plan.');
}
