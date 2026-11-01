import { z } from 'zod';
import type { Json } from './types.js';

const json: z.ZodType<Json> = z.lazy(() => z.union([z.null(), z.boolean(), z.number().finite(), z.string().max(100_000), z.array(json).max(1000), z.record(z.string().max(1000), json)]));
/** Paths are resolved only against the newly started loopback origin. */
export const applicationPathSchema = z.string().min(1).max(2000).refine(value => {
  if (!value.startsWith('/') || value.startsWith('//') || /[\\\x00-\x20\x7f#]/.test(value)) return false;
  try { return new URL(value, 'http://127.0.0.1:12345').origin === 'http://127.0.0.1:12345'; } catch { return false; }
}, 'must be a loopback-relative path beginning with one /, without fragments or control characters');

export const applicationConfigSchema = z.object({
  command: z.array(z.string().min(1).max(2000).refine(value => !/[\x00-\x1f\x7f]/.test(value), 'command arguments cannot contain control characters')).min(1).max(40),
  readyPath: applicationPathSchema.optional(),
  startupTimeoutMs: z.number().int().min(100).max(60_000).optional(),
}).strict();
const common = {
  id: z.string().min(1).max(100), kind: z.enum(['must-change', 'must-preserve']), description: z.string().min(1).max(2000),
};
const selector = z.string().min(1).max(500).refine(value => !/[\x00-\x1f\x7f]/.test(value), 'selector contains control characters');
export const browserStepSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('click'), selector }).strict(),
  z.object({ action: z.literal('press'), selector, key: z.enum(['Enter', 'Escape', 'Tab']) }).strict(),
  z.object({ action: z.literal('fill'), selector, value: z.string().max(10_000) }).strict(),
  z.object({ action: z.literal('select'), selector, value: z.string().max(1000) }).strict(),
  z.object({ action: z.literal('check'), selector, checked: z.boolean() }).strict(),
]);
export const browserAssertionSchema = z.discriminatedUnion('property', [
  z.object({ selector, property: z.literal('text'), expected: z.string().max(10_000) }).strict(),
  z.object({ selector, property: z.literal('value'), expected: z.string().max(10_000) }).strict(),
  z.object({ selector, property: z.literal('visible'), expected: z.boolean() }).strict(),
]);
export const applicationScenarioSchema = z.discriminatedUnion('type', [
  z.object({ ...common, type: z.literal('http'), method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']), path: applicationPathSchema, body: json.optional(),
    expected: z.object({ status: z.number().int().min(100).max(599), bodyType: z.enum(['json', 'text']), body: json }).strict(),
  }).strict().superRefine((value, context) => {
    if (value.method === 'GET' && value.body !== undefined) context.addIssue({ code: 'custom', message: 'GET requests cannot have a body' });
    if (value.expected.bodyType === 'text' && typeof value.expected.body !== 'string') context.addIssue({ code: 'custom', message: 'Text expectations must be strings' });
  }),
  z.object({ ...common, type: z.literal('browser'), path: applicationPathSchema, steps: z.array(browserStepSchema).max(20), assertions: z.array(browserAssertionSchema).min(1).max(20) }).strict(),
]);
export type ApplicationConfig = z.infer<typeof applicationConfigSchema>;
export type ApplicationScenario = z.infer<typeof applicationScenarioSchema>;
export type HttpScenario = Extract<ApplicationScenario, { type: 'http' }>;
export type BrowserScenario = Extract<ApplicationScenario, { type: 'browser' }>;
export interface EvidenceArtifact {
  hash: string; mediaType: 'image/png' | 'application/json'; label: string;
  phase: 'baseline' | 'candidate'; scenarioId: string; bytes: number;
}
