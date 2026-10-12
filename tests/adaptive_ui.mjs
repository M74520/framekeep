import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const require=createRequire(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES?process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES+'/runtime.cjs':import.meta.url);
const {chromium}=require('playwright');
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'framekeep-layout-')),portrait=path.join(temp,'portrait-4'),mixed=path.join(temp,'mixed-8');
const python=process.env.FRAMEKEEP_PYTHON||'python';
const create=spawn(python,['-c',`from PIL import Image,ImageDraw; from pathlib import Path; import sys
for folder,sizes in [(Path(sys.argv[1]),[(600,900)]*4),(Path(sys.argv[2]),[(600,900),(1200,800),(900,900),(600,1200),(1600,900),(800,1200),(900,600),(700,1000)])]:
 folder.mkdir()
 for i,(w,h) in enumerate(sizes):
  im=Image.new('RGB',(w,h),(35+i*13,65+i*7,95+i*5)); d=ImageDraw.Draw(im); d.rectangle((4,4,w-5,h-5),outline=(245,200,90),width=8); d.ellipse((w*.28,h*.14,w*.72,h*.43),fill=(225,180,150)); d.polygon([(w*.27,h*.45),(w*.73,h*.45),(w*.9,h*.95),(w*.1,h*.95)],fill=(120+i*10,80,130)); d.text((w*.08,h*.05),f'{i+1:02} | {w} x {h}',fill='white',font_size=28)
  exif=Image.Exif()
  if folder.name=='mixed-8' and i==6: exif[274]=6
  im.save(folder/f'TEST_{i+1:02}.jpg',exif=exif)
`,portrait,mixed]);await new Promise((resolve,reject)=>create.on('exit',c=>c?reject(Error('Fixture generation failed')):resolve()));
const server=spawn(python,['local/server.py','--no-browser','--data-dir',path.join(temp,'data')]);let log='';server.stderr.on('data',c=>log+=c);
const url=await new Promise((resolve,reject)=>{server.stdout.on('data',c=>{log+=c;const m=/FRAMEKEEP_URL=(http:\/\/127\.0\.0\.1:\d+)/.exec(log);if(m)resolve(m[1]);});server.once('exit',()=>reject(Error(log)));});
let browser;
try {
  browser=await chromium.launch({headless:true,executablePath:process.env.FRAMEKEEP_CHROME_PATH});
  const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url);
  const state=()=>page.evaluate(async()=>{const bootstrap=await(await fetch('/api/bootstrap')).json();return (await(await fetch('/api/projects/'+bootstrap.projects[0].id)).json()).state;});
  const ready=()=>page.waitForFunction(()=>[...document.querySelectorAll('.grid-photo img')].length>0&&[...document.querySelectorAll('.grid-photo img')].every(i=>i.complete&&i.naturalWidth));
  const saved=()=>page.waitForFunction(()=>document.querySelector('#save-state').textContent.includes('✓'));
  async function scan(folder){await page.locator('#import-button').click();await page.locator('#folder-path').fill(folder);await page.locator('#scan-folder').click();await page.locator('#close-task:not([hidden])').waitFor();await page.locator('#close-task').click();await ready();}
  async function verify(){
    await ready();
    try{await page.waitForFunction(()=>document.documentElement.scrollWidth<=innerWidth,{},{timeout:4000});}
    catch(e){await page.screenshot({path:'artifacts/adaptive-failure.png',fullPage:true});console.log(await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,overflow:[...document.querySelectorAll('body *')].filter(el=>el.getBoundingClientRect().right>innerWidth+1).slice(0,12).map(el=>({tag:el.tagName,class:el.className,right:el.getBoundingClientRect().right}))})));throw e;}
    const measurements=await page.locator('.grid-card').evaluateAll(cards=>cards.map(card=>{const frame=card.querySelector('.grid-photo').getBoundingClientRect(),img=card.querySelector('img'),paint=img.getBoundingClientRect();return {id:card.dataset.gridId,number:Number(card.querySelector('kbd').textContent),frameWidth:frame.width,frameHeight:frame.height,paintWidth:paint.width,paintHeight:paint.height};}));
    assert.deepEqual(measurements.map(m=>m.number),measurements.map((_,i)=>i+1),'Automatic row breaks must preserve keyboard order');
    for(const m of measurements){assert(Math.abs(m.frameWidth-m.paintWidth)<3&&Math.abs(m.frameHeight-m.paintHeight)<3,'The image must fill its frame without cropping or artificial letterboxing: '+JSON.stringify(m));}
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    return measurements;
  }
  await scan(portrait);await page.selectOption('#grid-size','6');let measurements=await verify();assert.equal(measurements.length,4);assert.equal(await page.locator('.grid-row').count(),1);assert(measurements[0].frameHeight>300,'Four portraits should use the available vertical space');
  await fs.mkdir('artifacts',{recursive:true});await page.screenshot({path:'artifacts/adaptive-portrait.png'});
  const id=measurements[0].id;await page.locator(`[data-grid-rotate="${id}"]`).click();await verify();await saved();assert.equal((await state()).grid.rotations[id],90);
  const turned=await page.locator(`[data-grid-id="${id}"] .grid-photo`).boundingBox();assert(turned.width>turned.height);
  await page.keyboard.press('Control+z');await verify();await saved();assert.equal((await state()).grid.rotations[id]||0,0);
  await page.locator(`[data-grid-rotate="${id}"]`).click();await saved();await page.reload();await verify();assert.equal((await state()).grid.rotations[id],90);
  await page.keyboard.press('1');await page.keyboard.press('2');await page.keyboard.press('c');await page.waitForFunction(()=>[...document.querySelectorAll('#multi-compare img')].every(i=>i.naturalWidth));
  const angle=await page.locator('.compare-cell img').first().evaluate(i=>{const m=new DOMMatrix(getComputedStyle(i).transform);return Math.round(Math.atan2(m.b,m.a)*180/Math.PI);});assert.equal(angle,90);await page.locator('[data-exit]').click();
  await scan(mixed);await page.selectOption('#grid-size','8');await verify();const s=await state();assert.equal(s.photos.find(p=>p.name==='TEST_07.jpg').width,600);assert.equal(s.photos.find(p=>p.name==='TEST_07.jpg').height,900);
  await page.screenshot({path:'artifacts/adaptive-mixed.png'});
  for(const viewport of [{width:1280,height:800},{width:1920,height:1080},{width:760,height:900}]){await page.setViewportSize(viewport);await verify();const button=await page.locator('[data-grid-action="confirm"]').boundingBox();assert(button.y+button.height<=viewport.height+1,'Page action stays visible');}
  assert.deepEqual(errors,[]);
  console.log('PASS: 4 portraits on a 6-photo page, mixed 8 images, EXIF orientation, no artificial letterbox/crop, stable keyboard order, rotation/undo/reload, compare rotation, responsive viewport.');
}finally{await browser?.close();const stopped=new Promise(resolve=>server.once('exit',resolve));server.kill();await stopped;await fs.rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
