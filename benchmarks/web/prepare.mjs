// Deterministic, documented adapters for pinned upstream applications. No model or network.
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
export const runtime=path.join(root,'runtime','node_modules');
export const projectRoot=path.join(root,'projects');
const expressServer=`const http=require('node:http');const app=require('./app.cjs');http.createServer((req,res)=>{if(req.url==='/health'){res.writeHead(200).end('ready');return;}app(req,res);}).listen(Number(process.env.PORT),'127.0.0.1');\n`;
const reactServer=`import {createServer} from 'node:http';import {build} from 'esbuild';import path from 'node:path';const built=await build({entryPoints:['src/index.js'],bundle:true,write:false,outdir:'out',loader:{'.js':'jsx'},jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'}});const js=built.outputFiles.find(f=>f.path.endsWith('.js')).contents;const css=built.outputFiles.find(f=>f.path.endsWith('.css'))?.contents??'';createServer((req,res)=>{if(req.url==='/health'){res.end('ready');return;}if(req.url==='/app.js'){res.writeHead(200,{'content-type':'text/javascript'}).end(js);return;}if(req.url==='/app.css'){res.writeHead(200,{'content-type':'text/css'}).end(css);return;}res.writeHead(200,{'content-type':'text/html'}).end('<!doctype html><html lang="en"><title>Upstream React TodoMVC evaluation</title><link rel="stylesheet" href="/app.css"><body><section class="todoapp" id="root"></section><script src="/app.js"></script></body></html>');}).listen(Number(process.env.PORT),'127.0.0.1');\n`;
function replaceOnce(source,from,to){if(!source.includes(from))throw Error('Pinned source adapter drift: '+from);return source.replace(from,to);}
export async function prepareProject(project,directory,variant){
 await fs.mkdir(directory,{recursive:true});
 await fs.writeFile(path.join(directory,'.gitignore'),'node_modules/\n');
 if(project==='express'){
  const upstream=path.join(projectRoot,'express','upstream');
  await fs.copyFile(path.join(upstream,'LICENSE'),path.join(directory,'LICENSE'));
  let source=await fs.readFile(path.join(upstream,'examples/web-service/index.js'),'utf8');
  source=replaceOnce(source,"require('../../')","require('express')");
  if(variant==='wrong-error')source=replaceOnce(source,"error(401, 'invalid api key')","error(401, 'permission granted')");
  else if(variant==='accept-any-key')source=replaceOnce(source,'apiKeys.indexOf(key) === -1','false');
  else if(variant==='rename-local')source=source.replace('var key =','var providedKey =').replace('if (!key)', 'if (!providedKey)').replace('apiKeys.indexOf(key)', 'apiKeys.indexOf(providedKey)').replace('req.key = key;', 'req.key = providedKey;');
  await fs.writeFile(path.join(directory,'app.cjs'),source);
  await fs.writeFile(path.join(directory,'server.cjs'),expressServer);
  let original=await fs.readFile(path.join(upstream,'test/acceptance/web-service.js'),'utf8');
  original=replaceOnce(original,"require('../../examples/web-service')","require('./app.cjs')");
  await fs.writeFile(path.join(directory,'upstream-mocha.cjs'),original);
  const registration=`import {describe,it as vitestIt} from 'vitest';import {createRequire} from 'node:module';const require=createRequire(import.meta.url);const it=(label,fn)=>vitestIt(label,()=>new Promise((resolve,reject)=>fn(error=>error?reject(error):resolve())));\n`;
  await fs.writeFile(path.join(directory,'api.test.js'),registration+original);
  await fs.writeFile(path.join(directory,'package.json'),JSON.stringify({name:'sentinel-express-public-evaluation',private:true,type:'module'}));
 }else{
  const upstream=path.join(projectRoot,'todomvc','upstream');
  await fs.copyFile(path.join(upstream,'license.md'),path.join(directory,'LICENSE'));
  await fs.copyFile(path.join(upstream,'app-spec.md'),path.join(directory,'APP-SPEC.md'));
  await fs.cp(path.join(upstream,'examples/react/src'),path.join(directory,'src'),{recursive:true});
  const file=path.join(directory,'src/todo/components/input.jsx');let input=await fs.readFile(file,'utf8');
  if(variant==='no-trim')input=input.replaceAll('e.target.value.trim()','e.target.value');
  else if(variant==='spaces-only')input=input.replaceAll('e.target.value.trim()',"e.target.value.replace(/^ +| +$/g, '')");
  else if(variant==='rename-handler')input=input.replaceAll('handleBlur','handleInputBlur');
  await fs.writeFile(file,input);
  await fs.writeFile(path.join(directory,'server.mjs'),reactServer);
  await fs.writeFile(path.join(directory,'package.json'),JSON.stringify({name:'sentinel-todomvc-public-evaluation',private:true,type:'module'}));
  await fs.writeFile(path.join(directory,'reducer.test.js'),`// SENTINEL-authored smoke tests, NOT the upstream Cypress suite.\nimport {test,expect} from 'vitest';import {todoReducer} from './src/todo/reducer';import {ADD_ITEM,TOGGLE_ITEM,REMOVE_COMPLETED_ITEMS} from './src/todo/constants';test('add a nonempty todo',()=>{const state=todoReducer([],{type:ADD_ITEM,payload:{title:'Buy milk'}});expect(state).toHaveLength(1);expect(state[0].title).toBe('Buy milk');expect(state[0].completed).toBe(false);});test('toggle then clear a completed todo',()=>{const state=[{id:'one',title:'Buy milk',completed:false}];const toggled=todoReducer(state,{type:TOGGLE_ITEM,payload:{id:'one'}});expect(toggled[0].completed).toBe(true);expect(todoReducer(toggled,{type:REMOVE_COMPLETED_ITEMS})).toEqual([]);});\n`);
 }
 await fs.symlink(runtime,path.join(directory,'node_modules'),'dir');
}
const http=(id,kind,description,path,status,body)=>({id,kind,description,type:'http',method:'GET',path,expected:{status,bodyType:'json',body}});
const browser=(id,kind,description,title)=>({id,kind,description,type:'browser',path:'/',steps:[{action:'fill',selector:'.new-todo',value:title},{action:'press',selector:'.new-todo',key:'Enter'}],assertions:[{selector:'[data-testid=todo-item-label]',property:'text',expected:title.trim()},{selector:'.new-todo',property:'value',expected:''}]});
export function contractFor(item){
 let scenarios,application,allowedPaths;
 if(item.project==='express'){
  scenarios=[http('invalid-key',item.oracle==='api-preserve'?'must-preserve':'must-change','Invalid API keys receive401 and the documented error','/api/users?api-key=wrong',401,{error:'invalid api key'}),http('missing-key','must-preserve','A missing API key remains a400 response','/api/users',400,{error:'api key required'}),http('valid-users','must-preserve','A valid example key preserves the upstream user list','/api/users?api-key=foo',200,[{name:'tobi'},{name:'loki'},{name:'jane'}])];
  application={command:['node',item.oracle==='missing-server'?'does-not-exist.cjs':'server.cjs'],readyPath:'/health',startupTimeoutMs:10000};allowedPaths=['app.cjs'];
 }else{
  scenarios=[browser('trim-input',item.oracle==='trim-preserve'?'must-preserve':'must-change','Trim leading and trailing whitespace on new todos as required by app-spec','\t Buy milk \t'),browser('plain-input','must-preserve','Preserve adding a plain todo and clearing the input','Buy milk')];
  if(item.oracle==='narrow'||item.oracle==='unconfirmed')scenarios=[{id:'heading-only',kind:'must-change',description:'The todo heading is visible; this does not establish trimming',type:'browser',path:'/',steps:[],assertions:[{selector:'h1',property:'text',expected:'todos'}]}];
  application={command:['node','server.mjs'],readyPath:'/health',startupTimeoutMs:15000};allowedPaths=['src/todo/components/input.jsx'];
 }
 const description=item.project==='express'?'Preserve the documented API key responses and user list':'Trim newly entered todo text and preserve ordinary creation';
 return {schemaVersion:3,objective:description,approvedBy:'Predeclared public evaluation oracle; not a live developer approval',requirements:[],allowedPaths,application,scenarios,coverage:{confirmed:item.oracle!=='unconfirmed',...(item.oracle.endsWith('-preserve')?{intent:'preserve'}:{}),aspects:[{id:'objective',description,requirementIds:scenarios.map(s=>s.id)}]}};
}
