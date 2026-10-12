import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
const require=createRequire(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES+'/runtime.cjs');
const {chromium}=require('playwright');
const server=http.createServer(async(req,res)=>{try{const pathname=new URL(req.url,'http://local').pathname;const file=path.resolve('public','.'+(pathname==='/'?'/index.html':pathname));if(!file.startsWith(path.resolve('public')+'/'))throw new Error('path');res.setHeader('Content-Type',({'.html':'text/html','.js':'application/javascript','.mjs':'application/javascript','.css':'text/css','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream');res.end(await fs.readFile(file));}catch{res.statusCode=404;res.end('Not found');}});await new Promise(resolve=>server.listen(4173,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true,executablePath:process.env.FRAMEKEEP_CHROME_PATH||'/tmp/framekeep-headless/chrome-headless-shell-linux64/chrome-headless-shell',args:['--no-sandbox','--single-process','--no-zygote']});
const context=await browser.newContext({viewport:{width:1440,height:1060},acceptDownloads:true});
const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
const readState=async()=>{await page.waitForTimeout(300);return page.evaluate(()=>new Promise((resolve,reject)=>{const r=indexedDB.open('framekeep-private-v1');r.onsuccess=()=>{const db=r.result,q=db.transaction('project').objectStore('project').get('current');q.onsuccess=()=>{resolve(q.result);db.close();};q.onerror=()=>reject(q.error);};}));};
await fs.mkdir('artifacts',{recursive:true});
try{
  await page.goto('http://127.0.0.1:4173');await page.getByRole('heading',{name:'好照片，值得再比一次。'}).waitFor();await page.screenshot({path:'artifacts/welcome.png',fullPage:true});
  await page.getByRole('button',{name:'试试演示 →'}).click();await page.locator('.photo-panel').first().waitFor();await page.waitForFunction(()=>document.querySelectorAll('.group-item').length===3);await page.locator('.photo-frame img').first().waitFor();
  let s=await readState();assert.equal(s.photos.length,18);assert.equal(s.groups.length,3);const first=s.challengerId;
  await page.keyboard.press('1');s=await readState();assert.equal(s.candidateId,first);assert.equal(s.photos.find(p=>p.id===first).status,'keep');const second=s.challengerId;assert.notEqual(first,second);
  await page.keyboard.press('w');s=await readState();assert.equal(s.candidateId,second);assert.equal(s.photos.find(p=>p.id===first).status,'reject');
  await page.keyboard.press('Control+z');s=await readState();assert.equal(s.candidateId,first);assert.equal(s.challengerId,second);assert.equal(s.photos.find(p=>p.id===first).status,'keep');
  await page.keyboard.press('b');s=await readState();assert.equal(s.candidates[s.groupId].length,2);assert.equal(s.photos.filter(p=>p.status==='keep').length,2);
  await page.keyboard.press('3');s=await readState();assert.equal(s.photos.filter(p=>p.status==='unsure').length,1);
  await page.keyboard.press('2');s=await readState();assert.equal(s.photos.filter(p=>p.status==='reject').length,1);
  await page.screenshot({path:'artifacts/arena-desktop.png',fullPage:true});
  await page.getByRole('button',{name:'下一轮 →',exact:true}).click();await page.getByRole('button',{name:'开启下一轮 →'}).click();s=await readState();assert.equal(s.round,2);assert.equal(s.roundIds.length,17);assert.equal(s.history.length,1);assert.equal(s.photos.filter(p=>s.roundIds.includes(p.id)&&p.status!=='pending').length,0);
  await page.keyboard.press('q');await page.keyboard.press('1');s=await readState();assert.equal(s.photos.find(p=>p.id===s.candidateId).status,'keep');
  await page.reload();await page.locator('.arena').waitFor();s=await readState();assert.equal(s.round,2);assert.equal(s.history.length,1);assert.equal(s.candidates[s.groupId].length,2);
  // Recovered rejected images rejoin the active round, rather than remaining excluded forever.
  await page.locator('[data-filter="reject"]').click();await page.locator('.thumb-item').first().click();await page.keyboard.press('1');s=await readState();const recovered=s.photos.find(p=>p.id===s.history[0].decisions.find(d=>d.status==='reject').id);assert.equal(recovered.status,'keep');assert.equal(recovered.roundIncluded,true);assert(s.roundIds.includes(recovered.id));
  await page.locator('[data-filter="round"]').click();await page.locator('[data-action="export"]').click();const downloadPromise=page.waitForEvent('download');await page.locator('[data-export="progress"]').click();const download=await downloadPromise;await download.saveAs('artifacts/progress.json');const backup=JSON.parse(await fs.readFile('artifacts/progress.json','utf8'));assert.equal(backup.project.round,2);
  await page.keyboard.press('2');await page.locator('#progress-input').setInputFiles('artifacts/progress.json');s=await readState();assert.equal(s.photos.filter(p=>p.status==='reject').length,backup.project.photos.filter(p=>p.status==='reject').length);
  await page.locator('[data-mode="visual"]').click();s=await readState();assert.equal(s.mode,'visual');assert.equal(s.photos.length,18);assert.equal(s.groups.flatMap(g=>g.ids).length,18);
  await page.locator('#move-group').selectOption('new');s=await readState();assert(s.groups.some(g=>g.name.startsWith('手动分组')));assert.equal(s.groups.flatMap(g=>g.ids).length,18);
  // Keyboard handlers must not trigger while editing numeric grouping thresholds.
  await page.locator('#group-threshold').fill('12');await page.locator('#group-threshold').press('1');let before=s.photos.map(p=>p.status);s=await readState();assert.deepEqual(s.photos.map(p=>p.status),before);
  await page.locator('.topbar').click();await page.locator('[data-mode="time"]').click();
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:'artifacts/arena-mobile.png',fullPage:true});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
  await page.setViewportSize({width:1440,height:1060});
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({result:'passed',verified:['demo import','time grouping','keyboard keep/reject/unsure','candidate replacement','undo','multiple candidates','new round snapshots','refresh recovery','revive rejected photo','progress export/import','visual grouping','manual grouping','input keyboard isolation','mobile no overflow'],pageErrors:errors},null,2));
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
