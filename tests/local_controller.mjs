// Runs the actual app's keyboard handlers and local save controller against the
// actual HTTP backend. DOM/layout checks remain in local_ui_smoke.mjs.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import * as core from '../public/core.mjs';

const nodes=new Map(),listeners=new Map();
const node=()=>({textContent:'',innerHTML:'',value:'',classList:{add(){},remove(){},toggle(){}},addEventListener(){},showModal(){},close(){},querySelector(){return null;},style:{setProperty(){}},append(){},prepend(){},remove(){},removeAttribute(){},setAttribute(){}});
globalThis.document={querySelector:s=>s==='dialog[open]'?null:(nodes.has(s)?nodes.get(s):(nodes.set(s,node()),nodes.get(s))),querySelectorAll:()=>[],addEventListener:(name,fn)=>listeners.set(name,fn)};
globalThis.window={addEventListener(){}};globalThis.IntersectionObserver=class{observe(){}disconnect(){}unobserve(){}};
const {LocalWorkspace}=await import('../public/local-workspace.mjs');
const source=await fs.readFile('public/app.js','utf8');
const code=source.replace(/^import .*;\r?\n/gm,'').replace('renderWelcome();await initStorage();','').replace('decorateGrid();hydrateImages();','hydrateImages();');
const app=new Function('LocalWorkspace','core',`const {${Object.keys(core).join(',')}}=core;\n${code}\nreturn {local,load:s=>{state=s;undoStack=[];normalizeSelection();render();},state:()=>state,flush:()=>local.flush(),confirmRound,regroup};`)(LocalWorkspace,core);
app.local.decorateWelcome=()=>{};app.local.decorateWorkspace=()=>{};

const temp=await fs.mkdtemp(path.join(os.tmpdir(),'framekeep-controller-'));const folder=path.join(temp,'photos');await fs.mkdir(folder);
const create=spawn(process.env.FRAMEKEEP_PYTHON||'python',['-c',`from PIL import Image; from pathlib import Path; import sys; d=Path(sys.argv[1]); [(Image.new('RGB',(200,300),(90+i*8,100,140)).save(d/f'DSC{i:04}.jpg')) for i in range(8)]`,folder]);await new Promise((resolve,reject)=>create.on('exit',c=>c?reject(Error('fixtures failed')):resolve()));
const server=spawn(process.env.FRAMEKEEP_PYTHON||'python',['local/server.py','--no-browser','--data-dir',path.join(temp,'data')]);
let output='';const url=await new Promise((resolve,reject)=>{server.stdout.on('data',chunk=>{output+=chunk;const m=/FRAMEKEEP_URL=(http:\/\/127\.0\.0\.1:\d+)/.exec(output);if(m)resolve(m[1]);});server.once('exit',()=>reject(Error('server startup failed')));});
const originalFetch=globalThis.fetch;globalThis.fetch=(route,options={})=>originalFetch(new URL(route,url),{...options,headers:{...options.headers,Cookie:`framekeep=${app.local.token}`}});
const press=key=>listeners.get('keydown')({key,target:{tagName:'BODY'},preventDefault(){},ctrlKey:false});
try{
  const bootstrap=await app.local.request('/api/bootstrap');app.local.token=bootstrap.token;
  nodes.get('#folder-path') || document.querySelector('#folder-path');nodes.get('#folder-path').value=folder;document.querySelector('#recursive').checked=true;
  await app.local.scan();assert(app.local.project,nodes.get('#folder-error')?.textContent+' | '+nodes.get('#task-file')?.textContent);assert.equal(app.state().photos.length,8);assert.equal(app.state().groups.length,1);
  app.state().grid={view:'arena',size:4,sessions:{}};
  let job={projectId:app.local.project.id};
  const first=app.state().challengerId;press('1');assert.equal(app.state().candidateId,first);const second=app.state().challengerId;
  press('w');assert.equal(app.state().candidateId,second);assert.equal(app.state().photos.find(p=>p.id===first).status,'reject');
  listeners.get('keydown')({key:'z',ctrlKey:true,target:{tagName:'BODY'},preventDefault(){}});assert.equal(app.state().candidateId,first);assert.equal(app.state().photos.find(p=>p.id===first).status,'keep');
  press('b');assert.equal(app.state().candidates[app.state().groupId].length,2);press('3');press('2');
  await app.flush();let restored=await app.local.request('/api/projects/'+job.projectId);assert.deepEqual(restored.state,app.state());
  app.confirmRound();assert.equal(app.state().round,2);assert.equal(app.state().history.length,1);assert.equal(app.state().roundIds.length,7);press('q');press('1');await app.flush();
  restored=await app.local.request('/api/projects/'+job.projectId);assert.equal(restored.state.round,2);assert.equal(restored.state.photos.filter(p=>p.status==='keep').length,1);
  const target=path.join(temp,'export');app.local.showExport();document.querySelector('#target-path').value=target;document.querySelector('#preserve-paths').checked=true;
  await app.local.copy();assert.equal((await fs.readdir(target)).filter(f=>f.endsWith('.jpg')).length,1);
  app.local.showFolder(true);await app.local.scan();assert.equal(app.state().round,2);assert.equal(app.state().history.length,1);
  // A stale page cannot silently overwrite changes from another page.
  await app.local.request(`/api/projects/${app.local.project.id}/state`,{state:app.state(),revision:app.local.project.revision});
  await assert.rejects(app.flush(),/另一页面/);assert.equal(app.local.conflict,true);
  console.log('Controller integration passed: folder scan controller, actual keyboard handlers, candidate replacement, undo, two candidates, unsure/reject, SQLite reload, new round, source copy and stale-page conflict.');
}finally{globalThis.fetch=originalFetch;const stopped=new Promise(resolve=>server.once('exit',resolve));server.kill();await stopped;await fs.rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
