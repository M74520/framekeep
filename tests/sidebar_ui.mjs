import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const require=createRequire(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES?process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES+'/runtime.cjs':import.meta.url);
const {chromium}=require('playwright');
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'framekeep-sidebar-')),source=path.join(temp,'photos'),other=path.join(temp,'other-project');
const python=process.env.FRAMEKEEP_PYTHON||'python';
const create=spawn(python,['-c',`from PIL import Image,ImageDraw; from pathlib import Path; import datetime,sys
d=Path(sys.argv[1]);d.mkdir()
for group in range(30):
 for i in range(3):
  im=Image.new('RGB',(240,360),(40+group*5,70+i*30,110));draw=ImageDraw.Draw(im);draw.text((20,40),f'GROUP {group+1:02} / {i+1}',fill='white',font_size=18);exif=Image.Exif();exif[306]=(datetime.datetime(2026,10,13,10)+datetime.timedelta(minutes=group*3,seconds=i)).strftime('%Y:%m:%d %H:%M:%S');im.save(d/f'{group+1:02}_{i+1}.jpg',exif=exif)
other=Path(sys.argv[2]);other.mkdir();Image.new('RGB',(240,360),'blue').save(other/'one.jpg')
`,source,other]);await new Promise((resolve,reject)=>create.on('exit',c=>c?reject(Error('Fixtures failed')):resolve()));
const server=spawn(python,['local/server.py','--no-browser','--data-dir',path.join(temp,'data')]);let log='';server.stderr.on('data',c=>log+=c);
const url=await new Promise((resolve,reject)=>{server.stdout.on('data',c=>{log+=c;const m=/FRAMEKEEP_URL=(http:\/\/127\.0\.0\.1:\d+)/.exec(log);if(m)resolve(m[1]);});server.once('exit',()=>reject(Error(log)));});
let browser;
try{
  browser=await chromium.launch({headless:true,executablePath:process.env.FRAMEKEEP_CHROME_PATH});const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url);await page.locator('#import-button').click();await page.locator('#folder-path').fill(source);await page.locator('#scan-folder').click();await page.locator('#close-task:not([hidden])').waitFor();await page.locator('#close-task').click();
  await page.locator('.group-item').nth(29).waitFor();assert.equal(await page.locator('.group-item[data-progress="untouched"]').count(),30);
  const ready=()=>page.waitForFunction(()=>[...document.querySelectorAll('.grid-photo img')].length>0&&[...document.querySelectorAll('.grid-photo img')].every(i=>i.complete&&i.naturalWidth));
  const saved=()=>page.waitForFunction(()=>document.querySelector('#save-state').textContent.includes('✓'));
  const group=number=>page.locator('.group-item').nth(number-1);
  await page.keyboard.press('1');await ready();await page.locator('[data-grid-action="confirm"]').click();assert.equal(await group(1).getAttribute('data-progress'),'complete');
  await group(2).click();await page.locator('.grid-card').nth(1).locator('[data-grid-defer]').click();await page.keyboard.press('1');await ready();await page.keyboard.press('Enter');assert.equal(await group(2).getAttribute('data-progress'),'review');
  await group(3).click();await page.locator('.grid-card').first().locator('[data-grid-defer]').click();assert.equal(await group(3).getAttribute('data-progress'),'progress');
  await fs.mkdir('artifacts',{recursive:true});await page.screenshot({path:'artifacts/sidebar-progress.png'});
  await group(25).scrollIntoViewIfNeeded();const scroll=await page.locator('.group-list').evaluate(el=>el.scrollTop);assert(scroll>500);
  await group(25).click();assert.equal(await group(25).getAttribute('class').then(c=>c.includes('active')),true);assert(Math.abs(await page.locator('.group-list').evaluate(el=>el.scrollTop)-scroll)<2);
  await page.keyboard.press('1');await ready();assert(Math.abs(await page.locator('.group-list').evaluate(el=>el.scrollTop)-scroll)<2);
  await page.keyboard.press('Enter');assert.equal(await group(25).getAttribute('data-progress'),'complete');assert(Math.abs(await page.locator('.group-list').evaluate(el=>el.scrollTop)-scroll)<2);
  await page.keyboard.press('Control+z');await saved();assert.equal(await group(25).getAttribute('data-progress'),'untouched');
  await page.reload();await page.locator('.group-item.active').waitFor();assert.equal(await group(25).getAttribute('class').then(c=>c.includes('active')),true);assert(Math.abs(await page.locator('.group-list').evaluate(el=>el.scrollTop)-scroll)<2);
  await page.screenshot({path:'artifacts/sidebar-scroll.png'});
  await page.locator('#import-button').click();await page.locator('#folder-path').fill(other);await page.locator('#scan-folder').click();await page.locator('#close-task:not([hidden])').waitFor();await page.locator('#close-task').click();
  assert.equal(await page.locator('.group-item').count(),1);assert.equal(await page.locator('.group-list').evaluate(el=>el.scrollTop),0);
  await page.locator('#projects-button').click();await page.locator('.project-option').filter({hasText:'photos'}).click();await page.waitForFunction(()=>document.querySelectorAll('.group-item').length===30&&!document.querySelector('#projects-dialog').open);await saved();
  const restored=await page.locator('.group-list').evaluate(el=>el.scrollTop);
  if(Math.abs(restored-scroll)>=2)console.log(await page.evaluate(async()=>{const b=await(await fetch('/api/bootstrap')).json();return Promise.all(b.projects.map(async p=>{const project=await(await fetch('/api/projects/'+p.id)).json();return {name:p.name,scroll:project.state.sidebarScroll};}));}));
  assert(Math.abs(restored-scroll)<2,`Project scroll restored ${restored}, expected ${scroll}`);
  await page.locator('[data-action="round"]').click();await page.locator('#confirm-round').click();await saved();assert.equal(await group(1).getAttribute('data-progress'),'untouched');assert.equal(await group(2).getAttribute('data-progress'),'untouched');assert.equal(await page.locator('.group-item[data-progress="complete"]').count(),0);
  await page.setViewportSize({width:760,height:1000});await group(25).scrollIntoViewIfNeeded();const left=await page.locator('.group-list').evaluate(el=>el.scrollLeft);assert(left>200);
  await group(25).click();await page.keyboard.press('1');await saved();assert(Math.abs(await page.locator('.group-list').evaluate(el=>el.scrollLeft)-left)<2);
  await page.reload();await page.locator('.group-item.active').waitFor();assert(Math.abs(await page.locator('.group-list').evaluate(el=>el.scrollLeft)-left)<2);
  assert.deepEqual(errors,[]);console.log('PASS: 30 groups, completion/review/progress labels, lower-group selection, scroll preserved through selection/judgment/undo/reload, new-round reset.');
}finally{await browser?.close();const stopped=new Promise(resolve=>server.once('exit',resolve));server.kill();await stopped;await fs.rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
