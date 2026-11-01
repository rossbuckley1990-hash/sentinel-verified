import { z } from 'zod';
import { safeRelative } from './store.js';
import type { Contract, Json } from './types.js';
const json: z.ZodType<Json> = z.lazy(()=>z.union([z.null(),z.boolean(),z.number().finite(),z.string().max(100000),z.array(json).max(1000),z.record(z.string(), json)]));
const modulePath=z.string().max(500).refine(safeRelative,'must be a safe relative module path');
const example=z.object({args:z.array(json).max(20),expected:json}).strict();
const invariant=z.object({argument:z.number().int().min(0).max(19),domain:z.enum(['string','number','array']),seeds:z.array(json).min(1).max(30),args:z.array(json).max(20),expected:json}).strict().superRefine((x,ctx)=>{
  if(x.argument>=x.args.length) ctx.addIssue({code:'custom',message:'invariant argument must index args'});
  if(x.seeds.some(s=>x.domain==='array'?!Array.isArray(s):typeof s!==x.domain))ctx.addIssue({code:'custom',message:'invariant seeds must belong to the approved domain'});
});
export const contractSchema=z.object({schemaVersion:z.literal(1),objective:z.string().min(1).max(5000),approvedBy:z.string().min(1).max(200),requirements:z.array(z.object({id:z.string().min(1).max(100),kind:z.enum(['must-change','must-preserve']),description:z.string().min(1).max(2000),module:modulePath,export:z.string().regex(/^[a-zA-Z_$][\w$]*$/),cases:z.array(example).max(100),invariant:invariant.optional()}).strict().refine(r=>r.cases.length>0||r.invariant,'requirement must have cases or an invariant')).max(100),probes:z.array(z.object({id:z.string().min(1),module:modulePath,export:z.string().regex(/^[a-zA-Z_$][\w$]*$/),inputs:z.array(z.array(json).max(20)).min(1).max(100)}).strict()).max(50).optional(),allowedPaths:z.array(modulePath).max(500).optional()}).strict().superRefine((x,ctx)=>{
  const ids=x.requirements.map(r=>r.id);if(new Set(ids).size!==ids.length)ctx.addIssue({code:'custom',message:'Requirement IDs must be unique'});
});
export function parseContract(value: unknown): Contract {return contractSchema.parse(value) as Contract;}
