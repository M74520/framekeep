// Run after `npx playwright install chromium` in an environment with a browser.
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const require=createRequire(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES?process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES+'/runtime.cjs':import.meta.url);
const {chromium}=require('playwright');
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'framekeep-ui-'));
const source=path.join(temp,'照片'),output=path.join(temp,'导出');await fs.mkdir(source);
const create=spawn(process.env.FRAMEKEEP_PYTHON||'python',['-c',`from PIL import Image; from pathlib import Path; import sys; d=Path(sys.argv[1]); [(Image.new('RGB',(600,900),(90+i*8,100,140)).save(d/f'DSC{i:04}.jpg')) for i in range(8)]`,source]);await new Promise((resolve,reject)=>create.on('exit',c=>c?reject(new Error('fixtures failed')):resolve()));
const server=spawn(process.env.FRAMEKEEP_PYTHON||'python',['local/server.py','--no-browser','--data-dir',path.join(temp,'data')]);
let serverOutput='';const url=await new Promise((resolve,reject)=>{server.stdout.on('data',chunk=>{serverOutput+=chunk;const match=/FRAMEKEEP_URL=(http:\/\/127\.0\.0\.1:\d+)/.exec(serverOutput);if(match)resolve(match[1]);});server.once('exit',()=>reject(new Error('server startup failed')));});
let browser;
try{
  browser=await chromium.launch({headless:true,...(process.env.FRAMEKEEP_CHROME_PATH?{executablePath:process.env.FRAMEKEEP_CHROME_PATH,args:['--no-sandbox','--single-process','--no-zygote']}: {})});
  const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(url);
  await page.getByRole('button',{name:'选择照片文件夹 →',exact:true}).click();await page.locator('#folder-path').fill(source);await page.locator('#scan-folder').click();await page.locator('#close-task:not([hidden])').waitFor();await page.locator('#close-task').click();
  await page.locator('[data-grid-action="arena"]').click();await page.locator('.arena').waitFor();await page.waitForFunction(()=>[...document.querySelectorAll('.photo-frame img')].every(i=>i.complete&&i.naturalWidth));
  const state=async()=>page.evaluate(async()=>{const bootstrap=await (await fetch('/api/bootstrap')).json();const id=bootstrap.projects[0].id;return (await (await fetch('/api/projects/'+id)).json()).state;});
  const saved=async(fn)=>{await page.waitForFunction(()=>document.querySelector('#save-state').textContent.includes('✓'));const s=await state();assert(fn(s));return s;};
  let s=await state();assert.equal(s.photos.length,8);assert.equal(s.groups.length,1);const first=s.challengerId;
  await page.keyboard.press('1');await page.waitForTimeout(350);s=await saved(s=>s.candidateId===first);const second=s.challengerId;
  await page.keyboard.press('w');await page.waitForTimeout(350);await saved(s=>s.candidateId===second&&s.photos.find(p=>p.id===first).status==='reject');
  await page.keyboard.press('Control+z');await page.waitForTimeout(350);await saved(s=>s.candidateId===first&&s.photos.find(p=>p.id===first).status==='keep');
  await page.keyboard.press('b');await page.waitForTimeout(350);await saved(s=>s.photos.filter(p=>p.status==='keep').length===2);
  await page.locator('[data-action="original"]').click();await page.waitForFunction(()=>document.querySelector('#detail-image').naturalWidth===600);await page.locator('#detail-100').click();assert(await page.locator('#detail-image').evaluate(i=>i.classList.contains('actual-size')));await page.locator('#detail-dialog [data-close]').click();
  await page.reload();await page.locator('.arena').waitFor();assert.equal((await state()).photos.filter(p=>p.status==='keep').length,2);
  await page.locator('[data-action="export"]').click();await page.locator('#copy-originals').click();await page.locator('#target-path').fill(output);await page.locator('#start-copy').click();await page.locator('#close-task:not([hidden])').waitFor();await page.locator('#close-task').click();assert.equal((await fs.readdir(output)).filter(f=>f.endsWith('.jpg')).length,2);
  await page.locator('[data-action="round"]').click();await page.locator('#confirm-round').click();await page.waitForTimeout(350);await saved(s=>s.round===2&&s.history.length===1);
  await page.locator('[data-action="rescan"]').click();await page.locator('#scan-folder').click();await page.locator('#close-task:not([hidden])').waitFor();await page.locator('#close-task').click();assert.equal((await state()).round,2);
  await fs.mkdir('artifacts',{recursive:true});await page.screenshot({path:'artifacts/local-arena.png',fullPage:true});assert.deepEqual(errors,[]);console.log('Local UI integration passed: folder import, keyboard arena, undo, two candidates, detail, reload, copy, round and rescan.');
}finally{await browser?.close();const stopped=new Promise(resolve=>server.once('exit',resolve));server.kill();await stopped;await fs.rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
