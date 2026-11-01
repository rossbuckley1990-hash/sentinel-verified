import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { quote } from './src/quote.js';
const root = fileURLToPath(new URL('.', import.meta.url));
const built = await build({entryPoints:[root+'src/App.jsx'],bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'}});
const javascript = built.outputFiles[0].contents;
const html = await readFile(new URL('index.html',import.meta.url));
const style = await readFile(new URL('style.css',import.meta.url));
const server=createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  if(req.method==='GET'&&req.url==='/health'){res.writeHead(200,{'Content-Type':'text/plain'}).end('ready');return;}
  if(req.method==='GET'&&req.url==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}).end(html);return;}
  if(req.method==='GET'&&req.url==='/app.js'){res.writeHead(200,{'Content-Type':'text/javascript'}).end(javascript);return;}
  if(req.method==='GET'&&req.url==='/style.css'){res.writeHead(200,{'Content-Type':'text/css'}).end(style);return;}
  if(req.method==='POST'&&req.url==='/api/quote'){
    let body='';
    try{
      for await(const chunk of req){body+=chunk;if(body.length>4096)throw new Error('Request too large');}
      const result=quote(JSON.parse(body));res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(result));
    }catch{res.writeHead(400,{'Content-Type':'application/json'}).end(JSON.stringify({error:'Invalid checkout input'}));}
    return;
  }
  res.writeHead(404,{'Content-Type':'application/json'}).end(JSON.stringify({error:'Not found'}));
});
server.listen(Number(process.env.PORT||4173),'127.0.0.1',()=>console.log('SENTINEL checkout ready'));
