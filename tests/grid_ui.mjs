import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const require=createRequire(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES?process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES+'/runtime.cjs':import.meta.url);
const {chromium}=require('playwright');
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'framekeep-grid-'));
const source=path.join(temp,'照片'),output=path.join(temp,'导出');await fs.mkdir(source);
const python=process.env.FRAMEKEEP_PYTHON||'python';
const create=spawn(python,['-c',`from PIL import Image, ImageDraw; from pathlib import Path; import sys; d=Path(sys.argv[1]);
for i in range(20):
 im=Image.new('RGB',(600,900),(45+i*6,65+i*3,100+i*4)); draw=ImageDraw.Draw(im); draw.ellipse((140,90,460,410),fill=(220,180,160)); draw.polygon([(160,400),(440,400),(560,900),(40,900)],fill=(80+i*4,60,95)); draw.text((30,30),f'FRAME {i+1:02}',fill='white',font_size=36); im.save(d/f'DSC{i:04}.jpg')
`,source]);await new Promise((res,rej)=>create.on('exit',c=>c?rej(Error('fixtures failed')):res()));
const server=spawn(python,['local/server.py','--no-browser','--data-dir',path.join(temp,'data')]);
let log='';server.stderr.on('data',c=>log+=c);
const url=await new Promise((res,rej)=>{server.stdout.on('data',c=>{log+=c;const m=/FRAMEKEEP_URL=(http:\/\/127\.0\.0\.1:\d+)/.exec(log);if(m)res(m[1]);});server.once('exit',()=>rej(Error(log)));});
let browser;
try {
  browser=await chromium.launch({headless:true,...(process.env.FRAMEKEEP_CHROME_PATH?{executablePath:process.env.FRAMEKEEP_CHROME_PATH}: {})});
  const page=await browser.newPage({viewport:{width:1600,height:1080}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url);await page.locator('#import-button').click();
  await page.getByText(/自动建议 .* 并行/).waitFor();await page.selectOption('#import-workers','4');
  await fs.mkdir('artifacts',{recursive:true});await page.screenshot({path:'artifacts/import-performance.png'});
  // Exercise waiting, cancellation and failure without blocking on native OS UI.
  await page.route('**/api/choose-folder',async route=>{await new Promise(r=>setTimeout(r,150));await route.fulfill({json:{path:''}});});
  await page.locator('#browse-source').click();assert.equal(await page.locator('#browse-source').textContent(),'选择中…');await page.getByText('已取消选择，可重新浏览或直接粘贴路径。').waitFor();
  await page.unroute('**/api/choose-folder');await page.route('**/api/choose-folder',route=>route.fulfill({status:400,json:{error:'Windows 文件夹选择器启动失败，请粘贴文件夹完整路径'}}));
  await page.locator('#browse-source').click();await page.getByText('Windows 文件夹选择器启动失败，请粘贴文件夹完整路径').waitFor();await page.unroute('**/api/choose-folder');
  await page.locator('#folder-path').fill(source);await page.locator('#scan-folder').click();await page.locator('#close-task:not([hidden])').waitFor();await page.locator('#close-task').click();
  await page.locator('.photo-grid').waitFor();assert.equal(await page.locator('.grid-card').count(),4);
  await page.selectOption('#grid-size','6');assert.equal(await page.locator('.grid-card').count(),6);
  await page.selectOption('#grid-size','8');assert.equal(await page.locator('.grid-card').count(),8);
  await page.waitForFunction(()=>[...document.querySelectorAll('.grid-photo img')].every(i=>i.complete&&i.naturalWidth>0));
  await fs.mkdir('artifacts',{recursive:true});await page.screenshot({path:'artifacts/grid-eight.png'});
  await page.selectOption('#grid-size','4');
  const ids=()=>page.locator('.grid-card').evaluateAll(cards=>cards.map(c=>c.dataset.gridId));
  const state=()=>page.evaluate(async()=>{const b=await(await fetch('/api/bootstrap')).json();return (await(await fetch('/api/projects/'+b.projects[0].id)).json()).state;});
  const saved=async()=>{await page.waitForFunction(()=>document.querySelector('#save-state').textContent.includes('✓'));return state();};
  assert.equal(String((await state()).importWorkers),'4');
  await page.locator('.grid-photo img').first().evaluate(img=>img.removeAttribute('src'));
  await page.locator('[data-grid-action="confirm"]').click();await page.getByText('本页预览尚未全部显示，请加载完成后确认；无法读取的照片可先标为待定。').waitFor();
  assert((await state()).photos.every(p=>p.status==='pending'),'A missing preview must not be rejected without being displayed');
  await page.selectOption('#grid-size','6');await page.selectOption('#grid-size','4');
  const ready=()=>page.waitForFunction(()=>[...document.querySelectorAll('.grid-photo img')].every(i=>i.complete&&i.naturalWidth>0));
  const first=await ids();await page.keyboard.press('1');await page.locator(`.grid-card[data-grid-id="${first[1]}"] [data-grid-defer]`).click();await ready();await page.locator('[data-grid-action="confirm"]').click();
  let s=await saved();assert.equal(s.photos.filter(p=>p.status==='keep').length,1);assert.equal(s.photos.filter(p=>p.status==='unsure').length,1);assert.equal(s.photos.filter(p=>p.status==='reject').length,2);assert.equal(s.photos.filter(p=>p.status==='pending').length,16);
  const second=await ids();assert(!second.some(id=>first.includes(id)));assert.equal(await page.locator('.candidate-chip').count(),1);
  // A held Enter key must not confirm a new page through a focused button.
  await page.locator('[data-grid-action="confirm"]').focus();await page.locator('[data-grid-action="confirm"]').dispatchEvent('keydown',{key:'Enter',repeat:true});assert.deepEqual(await ids(),second);
  await page.keyboard.press('Control+z');s=await saved();assert.deepEqual(await ids(),first);assert.equal(s.photos.filter(p=>p.status==='reject').length,0);assert.equal(await page.locator('.grid-card.picked').count(),1);
  await ready();await page.keyboard.press('Enter');await saved();assert.deepEqual(await ids(),second);
  // Select earlier candidate + later photo and exercise all compare paths.
  await page.locator('.candidate-chip>button:first-child').click();await page.keyboard.press('2');await page.keyboard.press('c');await page.locator('#multi-compare').waitFor();
  await page.waitForFunction(()=>[...document.querySelectorAll('#multi-compare img')].every(i=>i.naturalWidth>0));
  await page.locator('#multi-compare input').fill('3');const transforms=await page.locator('#multi-compare img').evaluateAll(a=>a.map(i=>i.style.transform));assert.equal(transforms[0],transforms[1]);
  const rect=await page.locator('.compare-viewport').first().boundingBox();await page.mouse.move(rect.x+rect.width*.6,rect.y+rect.height*.6);await page.mouse.down();await page.mouse.move(rect.x+rect.width*.4,rect.y+rect.height*.4);await page.mouse.up();
  const positions=await page.locator('#multi-compare img').evaluateAll(a=>a.map(i=>i.style.transform));assert.equal(positions[0],positions[1]);assert.notEqual(positions[0],transforms[0]);
  await page.locator('[data-detail]').click();await page.waitForFunction(()=>[...document.querySelectorAll('.compare-load')].every(e=>e.textContent.startsWith('原尺寸')));await page.locator('[data-actual]').click();
  assert(await page.locator('.compare-cell').first().evaluate(cell=>Math.abs(new DOMMatrix(getComputedStyle(cell.querySelector('img')).transform).a-1)<.001),'100% must use native pixel size, including small images');
  await page.locator('.compare-cell').first().locator('[data-decision="reject"]').click();await page.locator('.compare-cell').nth(1).locator('[data-decision="keep"]').click();
  await fs.mkdir('artifacts',{recursive:true});await page.screenshot({path:'artifacts/grid-compare.png',fullPage:true});
  await page.locator('[data-exit]').click();s=await saved();assert.equal(s.photos.find(p=>p.id===first[0]).status,'reject');assert.equal(s.photos.find(p=>p.id===second[1]).status,'keep');
  // Confirm all remaining batches, retaining one each; review appears automatically.
  assert.equal(await page.locator('.grid-card.picked').count(),1);await ready();await page.keyboard.press('Enter');
  for(let i=0;i<3;i++){await page.keyboard.press('1');await ready();await page.keyboard.press('Enter');}
  await page.locator('.review-banner').waitFor();s=await saved();assert.equal(s.photos.filter(p=>p.status==='pending').length,0);assert.equal(s.photos.filter(p=>p.status==='keep').length,4);assert.equal(s.photos.filter(p=>p.status==='unsure').length,1);
  await page.reload();await page.locator('.review-banner').waitFor();assert.equal(await page.locator('.candidate-chip').count(),4);
  await page.selectOption('#grid-size','6');assert.equal(await page.locator('.grid-card').count(),5);await page.selectOption('#grid-size','8');assert.equal(await page.locator('.grid-card').count(),5);
  // 4-way comparison + all keep in a single undoable action.
  for(const n of ['1','2','3','4'])await page.keyboard.press(n);await page.keyboard.press('c');assert.equal(await page.locator('.compare-cell').count(),4);await page.locator('[data-keep]').click();await page.locator('[data-undo]').click();await page.locator('[data-exit]').click();await saved();
  await page.locator('[data-grid-action="clear"]').click();await page.selectOption('#grid-size','4');await page.screenshot({path:'artifacts/grid-review.png',fullPage:true});
  // Export uses existing source-copy pipeline.
  await page.locator('[data-action="export"]').click();await page.locator('#copy-originals').click();await page.locator('#target-path').fill(output);await page.locator('#start-copy').click();await page.locator('#close-task:not([hidden])').waitFor();await page.locator('#close-task').click();assert.equal((await fs.readdir(output)).filter(f=>f.endsWith('.jpg')).length,4);assert.equal((await fs.readdir(source)).length,20);
  await page.locator('[data-action="round"]').click();await page.locator('#confirm-round').click();s=await saved();assert.equal(s.round,2);assert.equal(s.roundIds.length,5);assert.equal(await page.locator('.review-banner').count(),0);
  await page.locator('[data-grid-action="arena"]').click();await page.locator('.arena').waitFor();await page.keyboard.press('1');await saved();await page.locator('[data-grid-action="grid"]').click();await page.locator('.photo-grid').waitFor();
  await page.setViewportSize({width:1280,height:800});await saved();await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:'artifacts/grid-1280.png'});
  const confirmBounds=await page.locator('[data-grid-action="confirm"]').boundingBox();assert(confirmBounds.y+confirmBounds.height<=800,'Page confirmation must remain visible on a laptop');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);
  console.log('PASS: grid pagination, page-only decisions, defer, atomic undo, persistent candidates, 2/4-way compare, synchronized zoom/pan, detail, review, reload, 4/6/8, copy, round, arena, picker feedback, layout.');
} finally {await browser?.close();server.kill();await new Promise(r=>server.once('exit',r));await fs.rm(temp,{recursive:true,force:true});}
