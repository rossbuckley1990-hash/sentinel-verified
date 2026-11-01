import { promises as fs } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { digest, safeRelative } from './store.js';
import { runCommand } from './process.js';
import type { Example, Json, Requirement } from './types.js';

export interface Evidence { path: string; line: number; excerpt: string; hash: string }
export interface ExportTarget { module: string; export: string; signature: string }
export interface ProposedRequirement {
  requirement: Requirement; evidence: Evidence[];
  confidence: 'direct-assertion' | 'explicit-objective' | 'documentation'; selected: boolean;
}
export interface DiscoveryUncertainty { kind: 'intent' | 'conflict' | 'coverage' | 'environment' | 'safety'; message: string; blocksObjectiveVerification: boolean }
export interface DiscoveryPlan {
  schemaVersion: 1; repo: string; objective: string;
  environment: { packageManager: string; testFramework: string; node?: string };
  files: { sources: string[]; tests: string[]; docs: string[] };
  exports: ExportTarget[]; proposed: ProposedRequirement[]; uncertainties: string[]; uncertaintyDetails: DiscoveryUncertainty[]; evidence: Evidence[]; limits: string[];
}
interface File { name: string; text: string; hash: string; ast?: ts.SourceFile }
interface Target extends ExportTarget { names: Set<string>; evidence: Evidence }
interface Binding { module: string; export: string | '*' }
interface AssertionBindings { expect: Set<string>; assert: Set<string>; equality: Set<string> }
const MAX_FILE = 512_000, MAX_TOTAL = 5_000_000, MAX_PATHS = 1000, MAX_PROPOSALS = 100;
const sourcePattern = /\.(?:[cm]?[jt]sx?)$/i;
const testPattern = /(?:^|\/)(?:__tests__\/|tests?\/|(?:test|spec)\.[cm]?[jt]sx?$|.*\.(?:test|spec)\.[cm]?[jt]sx?$)/i;
const docPattern = /(?:^|\/)(?:readme[^/]*|[^/]*\.mdx?)$/i;
const forbidden = new Set(['.git', 'node_modules', '.sentinel', '.aws', '.ssh', '.codex', '.agents', '.config', 'coverage']);
const privateName = /^(?:\.env(?:\..*)?|\.npmrc|\.yarnrc(?:\.yml)?|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|ed25519)|.*\.(?:pem|key|p12|pfx))$/i;
const lexical = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const jsonKey = (value: unknown): string => JSON.stringify(value);
const syntaxErrors=(source:ts.SourceFile)=>(source as ts.SourceFile&{parseDiagnostics:readonly ts.Diagnostic[]}).parseDiagnostics.length>0;
const isIdentifierName = (value: string) => /^[A-Za-z_$][\w$]*$/.test(value);

function permitted(name: string): boolean {
  return safeRelative(name) && !/[\x00-\x1f\x7f]/.test(name) && !name.split('/').some(part => forbidden.has(part) || privateName.test(part));
}
function unwrapped(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) node = node.expression;
  return node;
}
/** A literal reader, never eval, vm, require, imports, or a type checker. */
export function staticJson(node: ts.Expression, depth = 0): { ok: true; value: Json } | { ok: false } {
  if (depth > 20) return { ok: false };
  node = unwrapped(node);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return { ok: true, value: node.text };
  if (ts.isNumericLiteral(node)) { const value = Number(node.text); return Number.isFinite(value) ? { ok: true, value } : { ok: false }; }
  if (node.kind === ts.SyntaxKind.TrueKeyword) return { ok: true, value: true };
  if (node.kind === ts.SyntaxKind.FalseKeyword) return { ok: true, value: false };
  if (node.kind === ts.SyntaxKind.NullKeyword) return { ok: true, value: null };
  if (ts.isPrefixUnaryExpression(node) && [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken].includes(node.operator)) {
    const operand = staticJson(node.operand, depth + 1);
    if (operand.ok && typeof operand.value === 'number') return { ok: true, value: node.operator === ts.SyntaxKind.MinusToken ? -operand.value : operand.value };
    return { ok: false };
  }
  if (ts.isArrayLiteralExpression(node) && node.elements.length <= 1000) {
    const values: Json[] = [];
    for (const element of node.elements) { if (!ts.isExpression(element)) return { ok: false }; const value = staticJson(element, depth + 1); if (!value.ok) return { ok: false }; values.push(value.value); }
    return { ok: true, value: values };
  }
  if (ts.isObjectLiteralExpression(node) && node.properties.length <= 1000) {
    const result: Record<string, Json> = Object.create(null) as Record<string, Json>;
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property) || !property.name || ts.isComputedPropertyName(property.name)) return { ok: false };
      const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) || ts.isNumericLiteral(property.name) ? property.name.text : null;
      if (name === null || name === '__proto__' || Object.hasOwn(result, name)) return { ok: false };
      const value = staticJson(property.initializer, depth + 1); if (!value.ok) return { ok: false }; result[name] = value.value;
    }
    return { ok: true, value: result };
  }
  return { ok: false };
}
function literalArguments(call: ts.CallExpression): Json[] | null {
  if (call.arguments.length > 20) return null;
  const values: Json[] = [];
  for (const arg of call.arguments) { const parsed = staticJson(arg); if (!parsed.ok) return null; values.push(parsed.value); }
  return values;
}
function fileEvidence(file: File, nodeOrLine: ts.Node | number, excerpt?: string): Evidence {
  const line = typeof nodeOrLine === 'number' ? nodeOrLine : file.ast!.getLineAndCharacterOfPosition(nodeOrLine.getStart(file.ast)).line + 1;
  const text = excerpt ?? (typeof nodeOrLine === 'number' ? file.text.split(/\r?\n/)[line - 1] ?? '' : nodeOrLine.getText(file.ast!));
  return { path: file.name, line, excerpt: text.replace(/\s+/g, ' ').slice(0, 500), hash: file.hash };
}
function modifier(node: ts.Node, kind: ts.SyntaxKind): boolean { return ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some(m => m.kind === kind); }
function identifier(node: ts.Node | undefined): string | null { return node && (ts.isIdentifier(node) || ts.isStringLiteral(node)) ? node.text : null; }
function member(node: ts.Expression): { owner: string; property: string } | null {
  node = unwrapped(node);
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) return { owner: node.expression.text, property: node.name.text };
  if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && node.argumentExpression && ts.isStringLiteral(node.argumentExpression)) return { owner: node.expression.text, property: node.argumentExpression.text };
  return null;
}
function functionSignature(name: string, node: ts.Node): string {
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) {
    return `${name}(${node.parameters.map(p => p.getText()).join(', ')})${node.type ? `: ${node.type.getText()}` : ''}`.slice(0, 500);
  }
  return `${name}(…) — re-exported or assigned interface`;
}
function walk(node: ts.Node, fn: (node: ts.Node) => void): void { const pending=[node]; let count=0; while(pending.length){const current=pending.pop()!;if(++count>100000)throw new Error('Source syntax tree exceeds the discovery node limit');fn(current);ts.forEachChild(current,child=>{pending.push(child);});} }

function exportsIn(file: File): Target[] {
  const targets: Target[] = [], ast = file.ast!;
  const declarations = new Map<string, ts.Node>();
  for (const statement of ast.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) declarations.set(statement.name.text, statement);
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name) && declaration.initializer) declarations.set(declaration.name.text, declaration.initializer);
  }
  const add = (name: string, value: ts.Node, alias?: string) => {
    if (!isIdentifierName(name) || targets.some(t => t.export === name)) return;
    const resolved = ts.isIdentifier(value) ? declarations.get(value.text) ?? value : value;
    if (!ts.isIdentifier(resolved) && !ts.isFunctionDeclaration(resolved) && !ts.isFunctionExpression(resolved) && !ts.isArrowFunction(resolved) && !ts.isMethodDeclaration(resolved)) return;
    const names = new Set([name]); if (alias) names.add(alias);
    if ((ts.isFunctionDeclaration(resolved) || ts.isFunctionExpression(resolved)) && resolved.name) names.add(resolved.name.text);
    targets.push({ module: file.name, export: name, signature: functionSignature(name, resolved), names, evidence: fileEvidence(file, value, functionSignature(name, resolved)) });
  };
  for (const statement of ast.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.body && modifier(statement, ts.SyntaxKind.ExportKeyword)) add(modifier(statement, ts.SyntaxKind.DefaultKeyword) ? 'default' : statement.name?.text ?? 'default', statement, statement.name?.text);
    if (ts.isVariableStatement(statement) && modifier(statement, ts.SyntaxKind.ExportKeyword)) for (const d of statement.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(unwrapped(d.initializer)) || ts.isFunctionExpression(unwrapped(d.initializer)))) add(d.name.text, unwrapped(d.initializer));
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) add('default', statement.expression, ts.isIdentifier(statement.expression) ? statement.expression.text : undefined);
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) for (const e of statement.exportClause.elements) if (!e.isTypeOnly && !statement.isTypeOnly) add(e.name.text, e.propertyName ?? e.name, e.propertyName?.text);
    if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression) && statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const { left, right } = statement.expression; const target = member(left);
      if (target?.owner === 'module' && target.property === 'exports') {
        if (ts.isObjectLiteralExpression(right)) for (const p of right.properties) {
          if (ts.isPropertyAssignment(p) && p.name && !ts.isComputedPropertyName(p.name)) { const name = identifier(p.name); if (name) add(name, p.initializer); }
          if (ts.isShorthandPropertyAssignment(p)) add(p.name.text, p.name);
          if (ts.isMethodDeclaration(p) && p.name && !ts.isComputedPropertyName(p.name)) { const name = identifier(p.name); if (name) add(name, p); }
        } else add('default', right, ts.isIdentifier(right) ? right.text : undefined);
      }
      if (target?.owner === 'exports') add(target.property, right);
      if (ts.isPropertyAccessExpression(left) && ts.isPropertyAccessExpression(left.expression) && left.expression.expression.getText(ast) === 'module' && left.expression.name.text === 'exports') add(left.name.text, right);
    }
  }
  return targets;
}

function resolveImport(spec: string, from: string, files: Map<string, File>, packageFiles: Map<string, unknown>, depth = 0): string | null {
  if (depth > 5 || !spec.startsWith('.') || spec.includes('\\')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  if (base === '..' || base.startsWith('../') || path.posix.isAbsolute(base)) return null;
  const candidates = [base];
  if (/\.[cm]?jsx?$/.test(base)) candidates.push(base.replace(/\.[cm]?jsx?$/, '.ts'), base.replace(/\.[cm]?jsx?$/, '.mts'), base.replace(/\.[cm]?jsx?$/, '.cts'), base.replace(/\.[cm]?jsx?$/, '.tsx'));
  candidates.push(...['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.tsx', '.jsx'].map(ext => base + ext));
  for (const name of candidates) if (files.has(name) && sourcePattern.test(name)) return name;
  const pkg = packageFiles.get(path.posix.join(base, 'package.json'));
  if (pkg && typeof pkg === 'object' && 'main' in pkg && typeof pkg.main === 'string' && !path.posix.isAbsolute(pkg.main)) {
    const main = resolveImport('./' + pkg.main, path.posix.join(base, '_entry.js'), files, packageFiles, depth + 1); if (main) return main;
  }
  for (const ext of ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.tsx', '.jsx']) { const name = path.posix.join(base, 'index' + ext); if (files.has(name)) return name; }
  return null;
}
function bindingsIn(file: File, files: Map<string, File>, packages: Map<string, unknown>): { calls: Map<string, Binding>; assertion: AssertionBindings } {
  const calls = new Map<string, Binding>(), assertion: AssertionBindings = { expect: new Set(), assert: new Set(), equality: new Set() };
  const bind = (local: string, imported: string, spec: string) => {
    const mod = resolveImport(spec, file.name, files, packages);
    if (mod) { calls.set(local, { module: mod, export: imported }); return; }
    if (['vitest', '@jest/globals'].includes(spec) && imported === 'expect') assertion.expect.add(local);
    if (['assert', 'node:assert', 'assert/strict', 'node:assert/strict'].includes(spec)) {
      if (['default', '*', 'strict'].includes(imported)) assertion.assert.add(local);
      if (['strictEqual', 'deepStrictEqual'].includes(imported) || (spec.endsWith('/strict') && ['equal', 'deepEqual'].includes(imported))) assertion.equality.add(local);
    }
  };
  for (const statement of file.ast!.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.importClause && !statement.importClause.isTypeOnly) {
      const c = statement.importClause, spec = statement.moduleSpecifier.text;
      if (c.name) bind(c.name.text, 'default', spec);
      if (c.namedBindings && ts.isNamespaceImport(c.namedBindings)) bind(c.namedBindings.name.text, '*', spec);
      if (c.namedBindings && ts.isNamedImports(c.namedBindings)) for (const e of c.namedBindings.elements) if (!e.isTypeOnly) bind(e.name.text, e.propertyName?.text ?? e.name.text, spec);
    }
    if (ts.isVariableStatement(statement)) for (const d of statement.declarationList.declarations) {
      const init = d.initializer && unwrapped(d.initializer);
      if (init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === 'require' && init.arguments.length === 1 && init.arguments[0] && ts.isStringLiteral(init.arguments[0])) {
        const spec = init.arguments[0].text;
        if (ts.isIdentifier(d.name)) bind(d.name.text, 'default', spec);
        if (ts.isObjectBindingPattern(d.name)) for (const e of d.name.elements) if (ts.isIdentifier(e.name) && !e.dotDotDotToken && !e.initializer) bind(e.name.text, identifier(e.propertyName) ?? e.name.text, spec);
      }
    }
  }
  return { calls, assertion };
}
function shadowed(name: string, node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node.parent; current && !ts.isSourceFile(current); current = current.parent) {
    if (ts.isFunctionLike(current) && current.parameters.some(p => p.name.getText().split(/\W+/).includes(name))) return true;
    if (ts.isBlock(current)) {
      for (const s of current.statements) {
        if (ts.isVariableStatement(s) && s.declarationList.declarations.some(d => d.name.getText().split(/\W+/).includes(name))) return true;
        if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) && s.name?.text === name) return true;
      }
    }
  }
  return false;
}
function targetCall(node: ts.Expression, bindings: Map<string, Binding>, targets: Map<string, Target>): { target: Target; args: Json[] | null } | null {
  node = unwrapped(node); if (!ts.isCallExpression(node)) return null;
  const callee = unwrapped(node.expression); let binding: Binding | undefined, label: string | undefined;
  if (ts.isIdentifier(callee) && !shadowed(callee.text, node)) { binding = bindings.get(callee.text); label = callee.text; }
  const property = member(callee);
  if (property && !shadowed(property.owner, node)) { const namespace = bindings.get(property.owner); if (namespace?.export === '*' || namespace?.export === 'default') binding = { module: namespace.module, export: property.property }; label = `${property.owner}.${property.property}`; }
  if (!binding) return null;
  const target = targets.get(`${binding.module}#${binding.export}`); if (!target) return null;
  if (label) target.names.add(label);
  return { target, args: literalArguments(node) };
}
function skippedContext(node: ts.Node): boolean {
  for (let p: ts.Node | undefined = node.parent; p && !ts.isSourceFile(p); p = p.parent) {
    if (ts.isIfStatement(p) || ts.isConditionalExpression(p) || ts.isForStatement(p) || ts.isForOfStatement(p) || ts.isWhileStatement(p)) return true;
    if (ts.isCallExpression(p) && ts.isPropertyAccessExpression(p.expression) && ['skip', 'todo', 'each'].includes(p.expression.name.text)) return true;
  }
  return false;
}
// Stop at an explicit sentence/example boundary, outside strings and nested
// literals. Parsing only the first TS initializer would silently accept the
// first value in ambiguous prose such as "true or false".
function expectedSegment(text: string): string {
  let depth=0,quote='',escaped=false;
  for(let i=0;i<text.length;i++){
    const ch=text[i]!;
    if(quote){if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch===quote)quote='';continue;}
    if(ch==='"'||ch==="'"||ch==='`'){quote=ch;continue;}
    if(ch==='('||ch==='['||ch==='{')depth++;
    else if(ch===')'||ch===']'||ch==='}')depth--;
    else if(depth===0&&(ch===';'||(ch==='.'&&(i+1===text.length||/\s/.test(text[i+1]!)))))return text.slice(0,i);
  }
  return text;
}
function explicitExamples(text: string, unresolved?: (name:string,start:number)=>void): { name: string; args: Json[]; expected: Json; start: number; raw: string }[] {
  const result: { name: string; args: Json[]; expected: Json; start: number; raw: string }[] = [];
  const pattern = /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*\(/g;
  let coveredUntil=-1,attempts=0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index!;if(start<coveredUntil)continue;
    const open = start + match[0].lastIndexOf('('); let depth = 0, quote = '', escaped = false, close = -1;
    for (let i = open; i < Math.min(text.length, open + 20000); i++) {
      const ch = text[i]!;
      if (quote) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === quote) quote = ''; continue; }
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
      if (ch === '(') depth++; if (ch === ')' && --depth === 0) { close = i; break; }
    }
    if (close < 0) continue;
    const tail = text.slice(close + 1); const operator = /^\s*(?:(?:must|should)\s+return\b|returns?\b|===|=>|\/\/\s*(?:=>|returns?\b))\s*/i.exec(tail);
    if (!operator) continue;
    if(++attempts>100)break;coveredUntil=close+1;
    const reject=()=>unresolved?.(match[1]!,start);
    const expectedText = expectedSegment(tail.slice(operator[0].length).split(/\r?\n/,1)[0]!.slice(0, 20000));
    const expectedAst = ts.createSourceFile('value.ts', `const value = ${expectedText}`, ts.ScriptTarget.Latest, true);
    const s = expectedAst.statements[0]; const initializer = s && ts.isVariableStatement(s) ? s.declarationList.declarations[0]?.initializer : undefined;
    if (!initializer||syntaxErrors(expectedAst)||expectedAst.statements.length!==1) {reject();continue;}
    let typedExpression=false;walk(initializer,node=>{if(ts.isAsExpression(node)||ts.isSatisfiesExpression(node)||ts.isTypeAssertionExpression(node)||ts.isNonNullExpression(node))typedExpression=true;});
    const expected = staticJson(initializer); if (!expected.ok||typedExpression) {reject();continue;}
    const callText = text.slice(start, close + 1); const ast = ts.createSourceFile('call.ts', `const call = ${callText}`, ts.ScriptTarget.Latest, true);if(syntaxErrors(ast)){reject();continue;}
    const statement = ast.statements[0]; const call = statement && ts.isVariableStatement(statement) ? statement.declarationList.declarations[0]?.initializer : undefined;
    if (!call || !ts.isCallExpression(call)) {reject();continue;} const args = literalArguments(call); if (!args) {reject();continue;}
    const end = close + 1 + operator[0].length + expectedText.length;coveredUntil=end;
    result.push({ name: match[1]!, args, expected: expected.value, start, raw: text.slice(start, end) });
    if (result.length >= 100) break;
  }
  return result;
}

/** Static, bounded evidence discovery. The return value is always an unapproved proposal. */
export async function discoverProject(repository: string, objective: string): Promise<DiscoveryPlan> {
  if (!objective.trim() || objective.length > 5000) throw new Error('Objective must contain 1–5000 characters.');
  const input = await fs.realpath(repository);
  // Index reads can invoke a repository-configured fsmonitor executable. Explicit
  // -c values override repository and inherited GIT_CONFIG_* settings; discovery
  // must not execute that hook or take optional index-refresh locks.
  const gitOptions = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'];
  const rootResult = await runCommand(['git', ...gitOptions, '-C', input, 'rev-parse', '--show-toplevel'], input, { timeoutMs: 10000 });
  if (rootResult.exitCode !== 0 || rootResult.truncated) throw new Error('Contract discovery requires a readable Git repository.');
  const repo = await fs.realpath(rootResult.stdout.trim());
  const listing = await runCommand(['git', ...gitOptions, '-C', repo, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], repo, { timeoutMs: 10000 });
  if (listing.exitCode !== 0 || listing.truncated) throw new Error('Repository file listing failed or exceeds the bounded discovery limit.');
  const uncertainties: string[] = [], limits = [
    'Static discovery does not execute project code, tests, configuration, package scripts, or models.',
    'Proposals are not approved contracts. A developer must review all expected results before execution.',
    'Only direct, literal equality assertions and explicit call/return examples are translated; dynamic tests and natural-language intent may remain unresolved.',
    `At most ${MAX_PATHS} relevant paths, ${MAX_FILE} bytes per file and ${MAX_TOTAL} bytes total are read.`,
  ];
  const tokens = new Set((objective.match(/[A-Za-z][A-Za-z0-9_-]{2,}/g) ?? []).map(x => x.toLowerCase()).filter(x => !['the', 'and', 'with', 'without', 'must', 'should', 'return', 'fix', 'bug'].includes(x)));
  const score = (name: string) => [...tokens].reduce((sum, token) => sum + (name.toLowerCase().includes(token) ? 10 : 0), 0) + (name === 'package.json' ? 1000 : testPattern.test(name) ? 4 : docPattern.test(name) ? 1 : 2);
  const available = [...new Set(listing.stdout.split('\0').filter(Boolean))].filter(permitted);
  const relevant = available.filter(name => sourcePattern.test(name) || docPattern.test(name) || path.posix.basename(name) === 'package.json').sort((a, b) => score(b) - score(a) || lexical(a, b));
  if (relevant.length > MAX_PATHS) uncertainties.push(`Discovery was limited to ${MAX_PATHS} of ${relevant.length} relevant paths; omitted paths may contain requirements.`);
  const files = new Map<string, File>(), packages = new Map<string, unknown>(); let bytesRead = 0;
  for (const name of relevant.slice(0, MAX_PATHS)) {
    const absolute = path.join(repo, name); let info;
    try { info = await fs.lstat(absolute); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e; }
    if (!info.isFile() || info.isSymbolicLink()) { uncertainties.push(`Skipped non-regular or symbolic-link input: ${name}`); continue; }
    const real = await fs.realpath(absolute); if (!real.startsWith(repo + path.sep)) { uncertainties.push(`Skipped input outside the repository: ${name}`); continue; }
    if (info.size > MAX_FILE) { uncertainties.push(`Skipped oversized input: ${name}`); continue; }
    if (bytesRead + info.size > MAX_TOTAL) { uncertainties.push('The total read budget was reached; remaining files were not inspected.'); break; }
    const handle = await fs.open(absolute, 'r'); let bytes: Buffer;
    try { const data = Buffer.alloc(info.size + 1); const read = await handle.read(data, 0, data.length, 0); bytes = data.subarray(0, read.bytesRead); if (bytes.length > MAX_FILE || bytes.length !== info.size) { uncertainties.push(`Skipped input changed while reading: ${name}`); continue; } } finally { await handle.close(); }
    bytesRead += bytes.length; const text = bytes.toString('utf8'); const file: File = { name, text, hash: digest(bytes) };
    if (sourcePattern.test(name)) {
      try { file.ast = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, /x$/.test(name) ? ts.ScriptKind.TSX : /\.[cm]?js$/.test(name) ? ts.ScriptKind.JS : ts.ScriptKind.TS);if(syntaxErrors(file.ast)){uncertainties.push(`Could not statically parse ${name}; it was not executed.`);file.ast=undefined;} }
      catch { uncertainties.push(`Could not statically parse ${name}; it was not executed.`); }
    }
    files.set(name, file);
    if (path.posix.basename(name) === 'package.json') { try { packages.set(name, JSON.parse(text)); } catch { uncertainties.push(`Could not parse ${name}; it was not executed.`); } }
  }
  const pkg = packages.get('package.json') as { name?: unknown; packageManager?: unknown; scripts?: Record<string, unknown>; devDependencies?: Record<string, unknown>; dependencies?: Record<string, unknown>; engines?: { node?: unknown } } | undefined;
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const testScript = typeof pkg?.scripts?.test === 'string' ? pkg.scripts.test : '';
  const hasVitestAdapter=[...files.values()].some(file=>file.ast&&testPattern.test(file.name)&&file.ast.statements.some(statement=>ts.isImportDeclaration(statement)&&ts.isStringLiteral(statement.moduleSpecifier)&&statement.moduleSpecifier.text==='vitest'));
  const framework = hasVitestAdapter || 'vitest' in deps || /\bvitest\b/.test(testScript) || available.some(n => /(?:^|\/)vitest\.config\./.test(n)) ? 'vitest'
    : 'jest' in deps || /\bjest\b/.test(testScript) ? 'jest (test discovery only; execution uses SENTINEL Vitest)'
    : 'mocha' in deps || /\bmocha\b/.test(testScript) ? 'mocha (test discovery only; execution uses SENTINEL Vitest)'
    : /node\s+--test/.test(testScript) ? 'node:test (test discovery only; execution uses SENTINEL Vitest)' : 'not detected';
  const manager = typeof pkg?.packageManager === 'string' ? pkg.packageManager.split('@')[0]!
    : available.includes('pnpm-lock.yaml') ? 'pnpm' : available.includes('yarn.lock') ? 'yarn' : available.includes('bun.lock') || available.includes('bun.lockb') ? 'bun' : 'npm';
  if (hasVitestAdapter && !('vitest' in deps) && !/\bvitest\b/.test(testScript)) limits.push('A source test imports Vitest, so that adapter is executable through SENTINEL; upstream scripts and any other test framework are not automatically executed.');
  if (framework !== 'vitest') uncertainties.push(`Test framework ${framework}. Only the documented Vitest Node execution path is supported; discovery alone does not establish runner compatibility.`);
  const targets = new Map<string, Target>();
  for (const file of files.values()) if (file.ast && !testPattern.test(file.name)) for (const target of exportsIn(file)) targets.set(`${target.module}#${target.export}`, target);
  const proposals: ProposedRequirement[] = [];
  const add = (target: Target, example: Example, evidence: Evidence, confidence: ProposedRequirement['confidence'], selected: boolean, kind: Requirement['kind']) => {
    if (proposals.length >= MAX_PROPOSALS) {
      const message='The 100-proposal limit was reached; some examples were omitted.';if(!uncertainties.includes(message))uncertainties.push(message);
      const replace=confidence==='explicit-objective'?proposals.map(p=>p.confidence!=='explicit-objective').lastIndexOf(true):-1;
      if(replace<0)return;proposals.splice(replace,1);
    }
    const key = digest(jsonKey([target.module, target.export, example.args, example.expected, kind])).slice(0, 12);
    const existing = proposals.find(p => p.requirement.id === `discovered-${key}`);
    if (existing) { if (!existing.evidence.some(e => e.path === evidence.path && e.line === evidence.line)) existing.evidence.push(evidence); return; }
    proposals.push({ requirement: { id: `discovered-${key}`, kind, description: `${[...target.names].find(name=>name!=='default')??target.export}(${example.args.map(x => JSON.stringify(x)).join(', ')}) returns ${JSON.stringify(example.expected)}`.slice(0, 1800), module: target.module, export: target.export, cases: [example] }, evidence: [evidence], confidence, selected });
  };
  for (const file of files.values()) {
    if (!file.ast || !testPattern.test(file.name)) continue;
    const { calls, assertion } = bindingsIn(file, files, packages);
    let mocked=false;const reassigned=new Set<string>();
    walk(file.ast,node=>{
      if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&['mock','doMock','spyOn','unstable_mockModule'].includes(node.expression.name.text))mocked=true;
      if(ts.isBinaryExpression(node)&&node.operatorToken.kind>=ts.SyntaxKind.FirstAssignment&&node.operatorToken.kind<=ts.SyntaxKind.LastAssignment&&ts.isIdentifier(node.left))reassigned.add(node.left.text);
    });
    for(const name of reassigned)calls.delete(name);
    if(mocked)uncertainties.push(`${file.name}: mocking is present; translated assertions need review against the real implementation.`);
    // Register aliases even when the objective names a function whose current tests use dynamic cases.
    for (const [name, binding] of calls) if (binding.export !== '*') targets.get(`${binding.module}#${binding.export}`)?.names.add(name);
    walk(file.ast, node => {
      if (!ts.isCallExpression(node)) return;
      let actual: ts.Expression | undefined, expected: ts.Expression | undefined, apiName = '';
      if (ts.isPropertyAccessExpression(node.expression) && ['toBe', 'toEqual', 'toStrictEqual'].includes(node.expression.name.text) && node.arguments.length === 1) {
        const inner = node.expression.expression;
        if (ts.isCallExpression(inner) && ts.isIdentifier(inner.expression) && assertion.expect.has(inner.expression.text) && !shadowed(inner.expression.text, node) && inner.arguments.length === 1) { actual = inner.arguments[0]; expected = node.arguments[0]; apiName = inner.expression.text; }
      }
      const property = member(node.expression);
      if (property && assertion.assert.has(property.owner) && !shadowed(property.owner, node) && ['strictEqual', 'deepStrictEqual'].includes(property.property) && node.arguments.length >= 2) { actual = node.arguments[0]; expected = node.arguments[1]; apiName = property.owner; }
      if (ts.isIdentifier(node.expression) && assertion.equality.has(node.expression.text) && !shadowed(node.expression.text, node) && node.arguments.length >= 2) { actual = node.arguments[0]; expected = node.arguments[1]; apiName = node.expression.text; }
      if (!actual || !expected || !apiName) return;
      const call = targetCall(actual, calls, targets); if (!call) return;
      const value = staticJson(expected), evidence = fileEvidence(file, node);
      if (!call.args || !value.ok) { uncertainties.push(`${file.name}:${evidence.line}: dynamic assertion was not translated into an expected result.`); return; }
      const conditional = skippedContext(node)||mocked;
      if (conditional) uncertainties.push(`${file.name}:${evidence.line}: skipped, parameterised or conditional assertion requires explicit review.`);
      add(call.target, { args: call.args, expected: value.value }, evidence, 'direct-assertion', !conditional, 'must-preserve');
    });
  }
  const objectiveEvidence: Evidence = { path: '<objective>', line: 1, excerpt: objective.slice(0, 500), hash: digest(objective) };
  const matchTarget = (name: string, location: string): Target | null => {
    const matching = [...targets.values()].filter(t => t.names.has(name) || t.export === name);
    if (matching.length === 1) return matching[0]!;
    uncertainties.push(`${location}: ${name} could not be mapped to one supported exported function (${matching.length} matches).`); return null;
  };
  for (const example of explicitExamples(objective,(name,start)=>uncertainties.push(`Objective: ${name} at character ${start+1} has an ambiguous or unsupported call/return example. Supply one literal expected result, separated from other text by a semicolon, period or newline.`))) {
    const target = matchTarget(example.name, 'Objective'); if (!target) continue;
    add(target, { args: example.args, expected: example.expected }, { ...objectiveEvidence, excerpt: example.raw.slice(0, 500) }, 'explicit-objective', true, 'must-change');
  }
  for (const file of files.values()) if (docPattern.test(file.name)) for (const example of explicitExamples(file.text,(name,start)=>uncertainties.push(`${file.name}:${file.text.slice(0,start).split('\n').length}: ${name} has an ambiguous or unsupported documentation example; no expected result was inferred.`))) {
    const matching = [...targets.values()].filter(t => t.names.has(example.name) || t.export === example.name);
    if (matching.length !== 1) continue;
    const line = file.text.slice(0, example.start).split('\n').length;
    if(typeof example.expected==='string'&&/^(?:true|false|null|-?\d+(?:\.\d+)?)$/.test(example.expected)){uncertainties.push(`${file.name}:${line}: quoted primitive output in documentation is ambiguous and was not translated into a requirement.`);continue;}
    add(matching[0]!, { args: example.args, expected: example.expected }, fileEvidence(file, line, example.raw), 'documentation', false, 'must-preserve');
  }
  // Conflicting evidence must never hide behind a selected default or majority vote.
  const groups = new Map<string, ProposedRequirement[]>();
  for (const p of proposals) { const c = p.requirement.cases[0]!; const key = jsonKey([p.requirement.module, p.requirement.export, c.args]); groups.set(key, [...groups.get(key) ?? [], p]); }
  for (const group of groups.values()) if (new Set(group.map(p => jsonKey(p.requirement.cases[0]!.expected))).size > 1) {
    for (const p of group) p.selected = false;
    const p = group[0]!; uncertainties.push(`Conflicting expected results for ${p.requirement.module}#${p.requirement.export}(${JSON.stringify(p.requirement.cases[0]!.args)}). Edit or remove conflicting proposals before approval.`);
  }
  if (!proposals.some(p => p.requirement.kind === 'must-change')) uncertainties.push('The objective does not establish a literal must-change example. Add the intended input and expected result, or explicitly approve reduced-scope checks; existing tests do not establish that the requested bug was fixed.');
  if (!proposals.length) uncertainties.push('No independently checkable acceptance examples were found. Source signatures and baseline implementation are not evidence of correct expected behaviour.');
  const relevance = (p: ProposedRequirement) => score(p.requirement.module) + [...tokens].reduce((s, token) => s + (p.requirement.description.toLowerCase().includes(token) ? 3 : 0), 0) + (p.requirement.kind === 'must-change' ? 1000 : 0);
  proposals.sort((a, b) => relevance(b) - relevance(a) || lexical(a.requirement.id, b.requirement.id));
  const allTargets = [...targets.values()].sort((a, b) => score(b.module) - score(a.module) || lexical(`${a.module}#${a.export}`, `${b.module}#${b.export}`));
  const evidence = [...allTargets.map(t => t.evidence), ...proposals.flatMap(p => p.evidence)];
  const uniqueEvidence = [...new Map(evidence.map(e => [`${e.path}:${e.line}:${e.excerpt}`, e])).values()].slice(0, 500);
  const ambiguousDocs=new Map<string,number>();const conciseUncertainties:string[]=[];
  for(const message of uncertainties){const match=/^(.*):\d+: quoted primitive output in documentation/.exec(message);if(match)ambiguousDocs.set(match[1]!,1+(ambiguousDocs.get(match[1]!)??0));else conciseUncertainties.push(message);}
  for(const [file,count]of ambiguousDocs)conciseUncertainties.push(`${file}: ${count} quoted primitive outputs are ambiguous documentation examples; they were not translated into requirements.`);
  const details:DiscoveryUncertainty[]=[...new Set(conciseUncertainties)].map(message=>{
    const kind:DiscoveryUncertainty['kind']=/^Conflicting/.test(message)?'conflict':/^The objective|^Objective:|^No independently/.test(message)?'intent':/^Test framework|^Could not parse package/.test(message)?'environment':/symbolic-link|outside the repository/.test(message)?'safety':'coverage';
    return {kind,message,blocksObjectiveVerification:kind==='intent'||kind==='conflict'||kind==='environment'};
  });
  // Never let a noisy test suite truncate an unresolved task requirement. Keep
  // every blocking notice, then bound supplementary coverage notices.
  const blocking=details.filter(detail=>detail.blocksObjectiveVerification);
  const supplementary=details.filter(detail=>!detail.blocksObjectiveVerification);
  const uncertaintyDetails=[...blocking,...supplementary.slice(0,Math.max(0,100-blocking.length))];
  if(uncertaintyDetails.length<details.length)limits.push(`${details.length-uncertaintyDetails.length} additional coverage notices were omitted from the bounded display; discovery coverage is incomplete.`);
  return {
    schemaVersion: 1, repo, objective,
    environment: { packageManager: manager, testFramework: framework, ...(typeof pkg?.engines?.node === 'string' ? { node: pkg.engines.node } : {}) },
    files: { sources: [...files.keys()].filter(n => sourcePattern.test(n) && !testPattern.test(n)), tests: [...files.keys()].filter(n => sourcePattern.test(n) && testPattern.test(n)), docs: [...files.keys()].filter(n => docPattern.test(n)) },
    exports: allTargets.map(({ names: _names, evidence: _evidence, ...target }) => target), proposed: proposals,
    uncertainties: uncertaintyDetails.map(detail=>detail.message), uncertaintyDetails, evidence: uniqueEvidence, limits,
  };
}
