import {LocalWorkspace} from './local-workspace.mjs';
import {gridState, gridPool, applyPage, groupProgress} from './grid.mjs';
import {showCompare} from './compare.mjs';
import {rotationFor, photoRatio, layoutRows, fitRotatedImage} from './layout.mjs';
import { fileKey, makeGroups, nextRound, chooseWinner, STATUSES, csvCell, exifTime, signature } from './core.mjs';

const $=s=>document.querySelector(s);
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={pending:'未评',keep:'保留',reject:'淘汰',unsure:'待定'};
const marks={pending:'·',keep:'✓',reject:'×',unsure:'?'};
const originalFiles=new Map(), thumbUrls=new Map(), previewUrls=new Map(), inFlight=new Map();
const measuredDimensions=new Map();let gridResizeObserver,gridLayoutFrame;
let state={schema:1,photos:[],groups:[],candidates:{},round:1,history:[],roundIds:[],mode:'time',threshold:90,groupId:null,challengerId:null,selectedSide:'right',filter:'round',demo:false};
let undoStack=[], db=null, memoryAssets=new Map(), saveTimer, toastTimer, observer, busy=false, cancelImport=false, renderSerial=0, storageWarning='', importProgress=null;
let worker=null, jobCounter=0;const jobs=new Map();
const local=new LocalWorkspace({state:()=>state,selected:selectedPhoto,replace:s=>{state={...s};undoStack=[];normalizeSelection();render();},render,toast,warning:message=>{storageWarning=message;render();toast(message);},busy:value=>busy=value,regroup:rebuildGroups,clearSaveTimer:()=>clearTimeout(saveTimer),clear:clearProject,demo:loadDemo});
try {worker=new Worker('/image-worker.js',{type:'module'});worker.onmessage=({data})=>{const job=jobs.get(data.requestId);if(job){clearTimeout(job.timer);jobs.delete(data.requestId);data.error?job.reject(new Error(data.error)):job.resolve(data);}};worker.onerror=()=>{for(const job of jobs.values()){clearTimeout(job.timer);job.reject(new Error('图片处理器不可用'));}jobs.clear();worker.terminate();worker=null;};} catch {}

function toast(message) {clearTimeout(toastTimer);$('#toast').textContent=message;$('#toast').classList.add('visible');toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),4000);}
function formatTime(time,short=false){return new Intl.DateTimeFormat('zh-CN',short?{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}:{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(time));}
function activeGroup(){return state.groups.find(g=>g.id===state.groupId)||state.groups[0];}
function photoById(id){return state.photos.find(p=>p.id===id);}
function groupPhotos(){const ids=new Set(activeGroup()?.ids||[]);return state.photos.filter(p=>ids.has(p.id));}
function visiblePhotos(){return groupPhotos().filter(p=>state.filter==='all'||(state.filter==='round'?(state.roundIds.includes(p.id)&&p.status!=='reject'):p.status===state.filter));}
function candidateIds(){return (state.candidates[activeGroup()?.id]||[]).filter(id=>photoById(id)&&photoById(id).status!=='reject');}
function activeCandidate(){const ids=candidateIds();return ids.includes(state.candidateId)?state.candidateId:ids[0]||null;}
function challengerPhotos(){const cand=activeCandidate();return visiblePhotos().filter(p=>p.id!==cand);}
function normalizeSelection(){
  const group=activeGroup();state.groupId=group?.id||null;state.candidateId=activeCandidate();
  const pool=challengerPhotos();if(!pool.some(p=>p.id===state.challengerId)) state.challengerId=pool.find(p=>p.status==='pending')?.id||pool[0]?.id||null;
  if(state.selectedSide==='left'&&!state.candidateId)state.selectedSide='right';
}
function selectedPhoto(){return photoById(state.selectedSide==='left'?activeCandidate():state.challengerId);}
function snapshot(){return JSON.parse(JSON.stringify(state));}
function remember(){undoStack.push(snapshot());if(undoStack.length>80)undoStack.shift();}
function undo(){if(!undoStack.length)return;state=undoStack.pop();normalizeSelection();render();scheduleSave();toast('已撤销，候选和判断已恢复');}
function scheduleSave(){clearTimeout(saveTimer);$('#save-state').textContent='保存中…';saveTimer=setTimeout(save,180);}
async function save(){
  if(local.enabled){try{await local.save(snapshot());}catch(e){toast(e.message);}return;}
  if(!db){$('#save-state').textContent='仅当前页面 · 请导出备份';return;}
  try {await transaction('project','readwrite',store=>store.put(state,'current'));$('#save-state').textContent='✓ 已保存到本机';}catch(error){storageWarning='本地保存失败：可能存储空间不足。当前页仍可筛选，请先导出进度备份。';$('#save-state').textContent='保存失败 · 请导出备份';toast(storageWarning);}
}
function transaction(name,mode,fn){return new Promise((resolve,reject)=>{const tx=db.transaction(name,mode),store=tx.objectStore(name);let result;try{result=fn(store);}catch(e){reject(e);return;}tx.oncomplete=()=>resolve(result?.result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('存储已中断'));});}
async function initStorage(){
  if(local.enabled){await local.init();return;}
  try {db=await new Promise((resolve,reject)=>{const req=indexedDB.open('framekeep-private-v1',1);req.onupgradeneeded=()=>{req.result.createObjectStore('project');req.result.createObjectStore('assets');};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
    const saved=await transaction('project','readonly',s=>s.get('current'));if(saved&&saved.schema===1&&Array.isArray(saved.photos)){state={...state,...saved};normalizeSelection();}
  }catch{storageWarning='此浏览器无法保存本地进度。当前页仍可筛选，关闭前请导出进度备份。';db=null;}
  render();if(state.photos.length)$('#save-state').textContent=db?'✓ 已恢复本地进度':'仅当前页面 · 请导出备份';
}
async function putAsset(id,asset){
  if(db) {try{await transaction('assets','readwrite',s=>s.put(asset,id));return;}catch(e){if(e.name==='QuotaExceededError'){storageWarning='本地空间不足，后续预览仅在当前页面保留，请导出进度备份。';}else storageWarning='部分预览无法保存；关闭前请导出进度备份。';}}
  memoryAssets.set(id,asset);
}
async function getAsset(id){if(memoryAssets.has(id))return memoryAssets.get(id);if(db)return transaction('assets','readonly',s=>s.get(id));}
async function imageUrl(id,kind='thumb'){
  const localUrl=local.enabled&&local.asset(id,kind);if(localUrl)return localUrl;
  const cache=kind==='thumb'?thumbUrls:previewUrls,key=`${kind}:${id}`;
  if(cache.has(id))return cache.get(id);
  if(inFlight.has(key))return inFlight.get(key);
  const promise=(async()=>{const asset=await getAsset(id);if(!asset)return '';const url=URL.createObjectURL(asset[kind]);cache.set(id,url);
    const limit=kind==='thumb'?180:6; if(cache.size>limit){for(const [oldId,oldUrl] of cache){if(oldId!==id&&!document.querySelector(`img[data-image="${oldId}"][data-kind="${kind}"]`)){URL.revokeObjectURL(oldUrl);cache.delete(oldId);if(cache.size<=limit)break;}}}return url;
  })();inFlight.set(key,promise);try{return await promise;}finally{inFlight.delete(key);}
}
function hydrateImages(){
  document.querySelectorAll('.grid-photo img,.candidate-chip img').forEach(img=>img.addEventListener('load',()=>{
    if(img.closest('.grid-photo'))measuredDimensions.set(img.dataset.image,{width:img.naturalWidth,height:img.naturalHeight});
    cancelAnimationFrame(gridLayoutFrame);gridLayoutFrame=requestAnimationFrame(layoutGrid);
  },{once:true}));
  observer?.disconnect();observer=new IntersectionObserver(entries=>{for(const entry of entries){if(entry.isIntersecting){const img=entry.target;observer.unobserve(img);imageUrl(img.dataset.image,img.dataset.kind).then(url=>{if(img.isConnected&&url)img.src=url;else if(img.isConnected)img.alt='预览缺失，请重新导入原文件';}).catch(()=>{if(img.isConnected)img.alt='预览加载失败';});}}},{rootMargin:'120px'});
  document.querySelectorAll('img[data-image]').forEach(img=>observer.observe(img));
}
function imageTag(id,kind='thumb',extra=''){return `<img data-image="${escape(id)}" data-kind="${kind}" alt="${escape(photoById(id)?.name||'照片')}" ${extra}>`;}

function demoSvg(group=0,variation=0){
  const themes=[['#7986b3','#3b3756','#ded7ed','#872f45'],['#63968c','#1c333c','#252335','#b79e7b'],['#9c7399','#282138','#e9d2e7','#5c4093']];const [bg,deep,hair,outfit]=themes[group%3],x=260+variation*5;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800" viewBox="0 0 600 800"><defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="${bg}"/><stop offset="1" stop-color="${deep}"/></linearGradient><linearGradient id="coat" x2="1" y2="1"><stop stop-color="${outfit}"/><stop offset="1" stop-color="#211e35"/></linearGradient><filter id="blur"><feGaussianBlur stdDeviation="16"/></filter><linearGradient id="skin" x2="1" y2="1"><stop stop-color="#f5d4c7"/><stop offset="1" stop-color="#c89791"/></linearGradient></defs><rect width="600" height="800" fill="url(#bg)"/><g opacity=".28"><rect x="35" y="70" width="120" height="520" fill="#becad7"/><rect x="450" y="80" width="90" height="570" fill="#b9b6bf"/><path d="M0 410L600 270M0 590L600 460" stroke="#eee" stroke-width="8"/></g><g filter="url(#blur)" opacity=".55"><circle cx="80" cy="180" r="24" fill="#e4ceac"/><circle cx="490" cy="300" r="25" fill="#f2c491"/><circle cx="420" cy="100" r="20" fill="#cbc6e9"/><circle cx="130" cy="620" r="30" fill="#928aae"/></g><ellipse cx="300" cy="820" rx="205" ry="200" fill="#151c2d"/><path d="M180 370Q115 430 133 670L180 760L420 760L445 465Q428 380 355 368Z" fill="url(#coat)"/><path d="M240 354L239 412L298 463L359 415L339 341" fill="url(#skin)"/><path d="M195 202Q200 113 304 121Q401 121 413 231L400 400L364 380L362 230L230 228L221 424L179 405Z" fill="${hair}"/><ellipse cx="${x+39}" cy="267" rx="76" ry="103" fill="url(#skin)"/><path d="M204 240Q198 134 292 132Q375 125 401 223L365 241L326 184L300 232L268 201L246 247Z" fill="${hair}"/><path d="M201 230L224 420L190 479L178 342Z M380 213L391 419L426 463L420 286Z" fill="${hair}"/><path d="M248 272Q265 262 279 275M314 274Q331 262 346 274" stroke="#453948" fill="none" stroke-width="5" stroke-linecap="round"/><circle cx="267" cy="276" r="5" fill="#545d76"/><circle cx="328" cy="275" r="5" fill="#545d76"/><path d="M294 285L289 307L301 310M280 336Q298 ${345-variation} 314 335" stroke="#b57d7d" fill="none" stroke-width="3" stroke-linecap="round"/><path d="M213 406L272 468L221 526L177 430M363 402L310 467L368 528L413 430" fill="${outfit}" stroke="#bea17d" stroke-width="3"/><path d="M290 457L311 457L330 540L298 605L266 540Z" fill="#dac1a0"/><g fill="#c7ad87"><circle cx="234" cy="553" r="5"/><circle cx="361" cy="553" r="5"/><circle cx="234" cy="605" r="5"/><circle cx="361" cy="605" r="5"/></g><path d="M162 476Q111 551 165 663L212 574" fill="url(#coat)"/><path d="M168 597L230 465Q243 442 256 454L245 493L212 628Z" fill="url(#skin)"/><path d="M374 526Q448 571 409 701L363 680" fill="url(#coat)"/><path d="M370 676L323 575Q321 555 338 551L356 577L396 667Z" fill="url(#skin)"/><path d="M0 750Q300 724 600 760V800H0Z" fill="#171c2c" opacity=".25"/><rect x="22" y="22" width="76" height="25" rx="5" fill="#13172466"/><text x="60" y="39" fill="#e1dfec" font-family="sans-serif" font-size="11" text-anchor="middle">演示插画</text></svg>`;
}
function svgUrl(g,v){return 'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(demoSvg(g,v));}
function renderWelcome(){
  $('#app').innerHTML=`<section class="welcome"><div class="welcome-heading"><div><span class="eyebrow">LESS SCROLLING. BETTER PICKS.</span><h1>好照片，值得再比一次。</h1><p>拍了一千张，也不用记住每一张。<br>把同组照片排在一起，先挑候选，再精细比较。</p></div><span class="welcome-badge">不打星 · 不改原片 · 不上传照片</span></div>${storageWarning?`<p class="error-banner">${escape(storageWarning)}</p>`:''}<div class="welcome-grid"><div class="import-zone"><div class="import-symbol">＋</div><h2>把这一场漫展放进来</h2><p>拖入照片或缩略图，自动按拍摄时间分组<br>一次生成轻量预览，之后只专注于选择</p><button class="button primary" data-action="import">选择照片 →</button><p class="format-note">JPEG / PNG / WebP 等 · RAW 请先导出 JPEG 缩略图</p></div><div class="welcome-preview"><div class="preview-header"><span>候选擂台</span><span>01 / 让更好的上场</span></div><div class="mini-pair"><div class="mini-image"><img src="${svgUrl(0,0)}" alt="内置演示插画候选"><b>此前候选</b></div><div class="mini-image"><img src="${svgUrl(0,3)}" alt="内置演示插画挑战者"><b>新挑战者</b></div></div><div class="preview-bottom"><p>后面遇到更好的？<br>直接并排比较，一键换掉候选。</p><button class="text-button" data-action="demo">试试演示 →</button></div></div></div><div class="welcome-features"><div class="feature"><span>▥</span><div><h3>相近的，放在一起</h3><p>按拍摄时间或相近画面分组<br>同一组内，轻松前后对比</p></div></div><div class="feature"><span>⇄</span><div><h3>候选始终在场</h3><p>替换、同时保留、随时撤销<br>不用回头寻找刚才的好照片</p></div></div><div class="feature"><span>↻</span><div><h3>筛完，再精挑一轮</h3><p>保留、淘汰、待定，键盘直达<br>每一轮的判断都能回看</p></div></div></div><footer class="welcome-footer"><span>YOUR PHOTOS. YOUR CHOICE.</span><span><button class="link-button" data-action="demo">使用演示插画</button> · 预览与进度仅存本浏览器</span></footer></section>`;
  local.decorateWelcome();
}
function renderPanel(photo,side){
  const isLeft=side==='left',index=groupPhotos().findIndex(p=>p.id===photo?.id)+1;
  return `<article class="photo-panel ${state.selectedSide===side?'selected':''}" data-side="${side}" tabindex="0" aria-label="${isLeft?'左侧候选':'右侧挑战者'}${photo?'：'+escape(photo.name):''}"><div class="panel-heading"><span class="panel-role"><span class="role-mark">${isLeft?'◇':'↗'}</span>${isLeft?'此前候选':'新挑战者'} <kbd>${isLeft?'Q':'E'}</kbd></span><span class="panel-tag">${isLeft?'始终在场':'正在浏览'}</span></div><div class="photo-frame" data-side="${side}">${photo?`${imageTag(photo.id,'preview')}<span class="photo-index">${index} / ${groupPhotos().length}</span>`:`<div class="empty-photo"><span>${isLeft?'◇':'✓'}</span><h3>${isLeft?'把第一张好照片留在这里':'这一组已经看完'}</h3><p>${isLeft?'选一张照片，按 1 保留。它会成为候选，陪你比较后面的每一张。':'可以切换分组、查看全部照片，或开始下一轮。'}</p></div>`}</div><div class="photo-meta">${photo?`<div><strong title="${escape(photo.name)}">${escape(photo.name)}</strong><small>${formatTime(photo.time)} · ${photo.timeSource==='exif'?'拍摄时间':photo.timeSource==='demo'?'演示时间':'文件修改时间'}</small></div><span class="status-badge ${photo.status}">${labels[photo.status]}</span>`:`<small class="muted">${isLeft?'每组可以保留多张候选':'没有更多挑战者'}</small>`}</div></article>`;
}
function render(){
  const previousList=$('.group-list'),scope=sidebarScope();
  const sidebarPosition=previousList?.dataset.scope===scope?{top:previousList.scrollTop,left:previousList.scrollLeft}:state.sidebarScroll||{top:0,left:0};
  renderSerial++;if(!state.photos.length){renderWelcome();return;}
  normalizeSelection();const group=activeGroup(),photos=groupPhotos(),candidate=photoById(activeCandidate()),challenger=photoById(state.challengerId),pool=visiblePhotos();
  const counts=Object.fromEntries(STATUSES.map(s=>[s,state.photos.filter(p=>p.status===s).length]));
  const roundPhotos=state.photos.filter(p=>state.roundIds.includes(p.id)),reviewed=roundPhotos.filter(p=>p.status!=='pending').length;
  const thumbIndex=Math.max(0,pool.findIndex(p=>p.id===state.challengerId)),start=Math.max(0,thumbIndex-28),thumbs=pool.slice(start,start+70);
  const selected=selectedPhoto(),candIds=candidateIds();
  $('#app').innerHTML=`<div class="workspace"><aside class="sidebar"><div class="sidebar-heading"><span>本次照片</span><span>${state.photos.length} 张</span></div><div class="round-card"><div class="round-title"><span>第 ${state.round} 轮筛选</span><button class="text-button round-pill" data-action="history">查看历史 ↗</button></div><div class="round-progress"><span style="width:${roundPhotos.length?reviewed/roundPhotos.length*100:0}%"></span></div><small>已评 ${reviewed} / ${roundPhotos.length} · 保留 ${counts.keep} 张</small></div><div class="group-config"><label>把相近照片放在一起</label><div class="segment"><button data-mode="time" class="${state.mode==='time'?'active':''}">拍摄时间</button><button data-mode="visual" class="${state.mode==='visual'?'active':''}">相近画面</button></div><div class="threshold-row"><input id="group-threshold" type="number" min="${state.mode==='time'?1:1}" max="${state.mode==='time'?3600:30}" value="${state.threshold}" aria-label="分组阈值"><span>${state.mode==='time'?'秒内连续照片':'相似容差（1–30）'}</span><button data-action="regroup">应用</button></div></div><div class="sidebar-heading"><span>照片分组</span><span>${state.groups.length} 组</span></div><nav class="group-list" aria-label="照片分组">${state.groups.map((g,i)=>{const inRound=g.ids.filter(id=>state.roundIds.includes(id));const kept=g.ids.filter(id=>photoById(id)?.status==='keep').length;return `<button class="group-item ${g.id===group.id?'active':''}" data-group="${escape(g.id)}" aria-label="${escape(g.name)}，${g.ids.length}张">${imageTag(g.ids[0],'thumb','class="group-cover"')}<div class="group-info"><strong>${escape(g.name)}${kept?'<span class="group-candidate-dot">·</span>':''}</strong><small>${formatTime(photoById(g.ids[0])?.time||Date.now(),true)} · ${kept} 张保留</small></div><span class="group-count">${inRound.length}</span></button>`;}).join('')}</nav><div class="sidebar-footer"><p>▧ 预览仅存本机<br>你的每一次选择，都不会改动原片。</p><button class="text-button" data-action="reset">清空本地项目</button></div></aside><section class="stage">${storageWarning?`<p class="error-banner">${escape(storageWarning)}</p>`:''}<div class="stage-heading"><div><span class="eyebrow">THE CANDIDATE ARENA</span><h1 style="margin-top:9px">候选擂台 <span>${escape(group.name)} · ${photos.length} 张</span>${state.demo?'<span class="demo-label">演示插画</span>':''}</h1><p>让后来的好照片，挑战此前的选择。${state.mode==='visual'?'按色彩与画面结构近似分组，可手动修正。':'不必记住前一张，也不必反复改星级。'}</p></div><div class="stage-actions"><button class="button" data-action="export">↗ 导出</button><button class="button" data-action="round">下一轮 →</button></div></div><div class="summary-bar">${STATUSES.map(s=>`<span class="summary-item"><i class="mini-dot ${s}"></i>${labels[s]} <strong>${counts[s]}</strong></span>`).join('')}<span class="divider"></span><span class="summary-item">第 ${state.round} 轮</span><span class="view-label">轻量预览 · 点击照片放大 · 可撤销</span></div><div class="arena">${renderPanel(candidate,'left')}${renderPanel(challenger,'right')}</div><div class="compare-toolbar"><button class="button winner-button" data-action="winner" ${!candidate||!challenger?'disabled':''}>↗ 挑战者胜出 <kbd>W</kbd></button><button class="button both-button" data-action="both" ${!candidate||!challenger?'disabled':''}>✓ 两张都保留 <kbd>B</kbd></button><button class="button ghost" data-action="pin" ${!challenger?'disabled':''}>◇ 设为候选</button><button class="button ghost" data-action="original" ${!selected?'disabled':''}>查看原尺寸</button></div><div class="judge-bar"><div class="judge-caption">正在操作 <strong>${state.selectedSide==='left'?'左侧候选':'右侧挑战者'}</strong><br>${selected?escape(selected.name):'先选一张照片'}</div><div class="judge-actions"><button class="arrow-button" data-action="prev" aria-label="上一张挑战者" ${!challengerPhotos().length?'disabled':''}>‹</button><button class="judge-button" data-status="keep" ${!selected?'disabled':''}>✓ 保留 <kbd>1</kbd></button><button class="judge-button reject" data-status="reject" ${!selected?'disabled':''}>× 淘汰 <kbd>2</kbd></button><button class="judge-button unsure" data-status="unsure" ${!selected?'disabled':''}>? 待定 <kbd>3</kbd></button><button class="arrow-button" data-action="next" aria-label="下一张挑战者" ${!challengerPhotos().length?'disabled':''}>›</button><button class="undo-button" data-action="undo" ${!undoStack.length?'disabled':''}>↶ 撤销</button></div></div><div class="filmstrip-section"><div class="filmstrip-heading"><h2>这一组的照片</h2><small>候选 ${candIds.length} 张 · 点击缩略图重新比较</small><div class="filmstrip-filters">${[['round','本轮'],['keep','保留'],['unsure','待定'],['reject','淘汰'],['all','全部']].map(([key,label])=>`<button data-filter="${key}" class="${state.filter===key?'active':''}">${label}</button>`).join('')}</div><div class="manual-tools"><select id="move-group" aria-label="将当前照片移动到其他分组"><option value="">移动当前照片…</option><option value="new">单独分组</option>${state.groups.filter(g=>g.id!==group.id).map(g=>`<option value="${escape(g.id)}">${escape(g.name)}</option>`).join('')}</select></div></div><div class="filmstrip" aria-label="组内照片">${thumbs.length?thumbs.map(p=>`<button class="thumb-item ${p.id===state.challengerId?'active':''} ${candIds.includes(p.id)?'candidate':''}" data-photo="${escape(p.id)}" title="${escape(p.name)} · ${labels[p.status]}${candIds.includes(p.id)?' · 候选':''}" aria-label="${escape(p.name)}，${labels[p.status]}"><div class="thumb-photo">${imageTag(p.id)}<span class="thumb-status ${p.status}">${marks[p.status]}</span></div><small>${escape(p.name)}</small></button>`).join(''):'<div class="empty-filter">这个视图暂时没有照片。切换“全部”即可找回已淘汰的照片。</div>'}</div><p class="filmstrip-note">${pool.length>70?`为保持轻快，只显示当前位置附近的 ${thumbs.length} 张（${start+1}–${start+thumbs.length} / ${pool.length}）；方向键可浏览全部。`:'绿色边框是候选。点击候选可切换左侧参考；点击其他照片可送上右侧挑战。'}</p></div><div class="bottom-bar"><span>◉ 仅本地读取 · 原片不变${state.demo?' · 演示素材非真实照片':''}</span><span class="shortcut-hint"><span><kbd>←</kbd> <kbd>→</kbd> 浏览</span><span><kbd>1</kbd> 保留 <kbd>2</kbd> 淘汰 <kbd>3</kbd> 待定</span><button class="link-button" data-action="help">全部快捷键 ↗</button></span><button class="link-button" data-action="history">筛选历史</button><button class="link-button mobile-reset" data-action="reset">清空项目</button></div></section></div>`;
  decorateGroups();decorateGrid();hydrateImages();renderImportProgress();local.decorateWorkspace();
  const list=$('.group-list');if(list){list.dataset.scope=scope;state.sidebarScroll=sidebarPosition;list.scrollTop=sidebarPosition.top;list.scrollLeft=sidebarPosition.left;}
}
function sidebarScope(){return local.project?.id||`${state.demo?'demo':'browser'}:${state.photos[0]?.id||''}`;}
function decorateGroups(){
  const list=$('.group-list');if(!list)return;
  const byId=new Map(state.photos.map(p=>[p.id,p])),roundIds=new Set(state.roundIds),progress=new Map(state.groups.map(g=>[g.id,groupProgress(state,g,byId,roundIds)]));
  const descriptions={untouched:'未开始',progress:'进行中',review:'待复核',complete:'✓ 已完成',inactive:'本轮无照片'};
  for(const button of list.querySelectorAll('.group-item')){
    const stats=progress.get(button.dataset.group);if(!stats)continue;
    button.dataset.progress=stats.status;button.classList.add(`group-${stats.status}`);button.querySelector('.group-count')?.remove();
    const info=button.querySelector('.group-info'),badge=document.createElement('span');badge.className=`group-state ${stats.status}`;badge.textContent=descriptions[stats.status];info.querySelector('strong').append(badge);
    info.querySelector('small').textContent=stats.total?`已评 ${stats.reviewed}/${stats.total} · 保留 ${stats.kept}${stats.unsure?' · 待定 '+stats.unsure:''}`:'本轮没有待筛照片';
    const bar=document.createElement('span');bar.className='group-mini-progress';bar.innerHTML=`<i style="width:${stats.total?stats.reviewed/stats.total*100:0}%"></i>`;info.append(bar);
    button.setAttribute('aria-label',`${state.groups.find(g=>g.id===button.dataset.group).name}，${descriptions[stats.status]}，已评 ${stats.reviewed}/${stats.total}`);
  }
  const all=[...progress.values()],summary=document.createElement('div');summary.className='group-progress-summary';
  summary.textContent=`已完成 ${all.filter(s=>s.status==='complete').length}/${all.filter(s=>s.total).length} 组 · 待复核 ${all.filter(s=>s.status==='review').length} 组`;
  list.before(summary);
}
function gridSession(){return gridState(state,activeGroup());}
function currentGridPage(){
  const session=gridSession(),pool=gridPool(state,activeGroup(),session),size=state.grid.size;
  session.page=Math.max(0,Math.min(session.page,Math.max(0,Math.ceil(pool.length/size)-1)));
  return {session,pool,photos:pool.slice(session.page*size,(session.page+1)*size),pages:Math.max(1,Math.ceil(pool.length/size))};
}
function gridPicks(){return gridSession().picks.filter(id=>activeGroup().ids.includes(id)&&photoById(id));}
function toggleGrid(id){
  const s=gridSession();s.picks=s.picks.includes(id)?s.picks.filter(i=>i!==id):[...s.picks,id];render();scheduleSave();
}
function decorateGrid(){
  gridResizeObserver?.disconnect();
  const stage=$('.stage');if(!stage)return;
  const {session,pool,photos,pages}=currentGridPage(),isGrid=state.grid.view!=='arena',picks=gridPicks();
  const tabs=document.createElement('div');tabs.className='mode-tabs';tabs.innerHTML=`<button class="button ${isGrid?'active':''}" data-grid-action="grid">同组网格</button><button class="button ${!isGrid?'active':''}" data-grid-action="arena">候选擂台</button>`;
  $('.summary-bar').after(tabs);
  if(!isGrid)return;
  $('.workspace').classList.add('grid-workspace');
  $('.stage-heading h1').innerHTML=`${session.review?'候选复核':'同组筛选'} <span>${escape(activeGroup().name)} · ${groupPhotos().length} 张</span>`;
  $('.stage-heading .eyebrow').textContent='KEEP THE MOMENT';
  $('.stage-heading p').textContent='先选出喜欢的，再一起看细节。此前候选始终在场。';
  for(const selector of ['.arena','.compare-toolbar','.judge-bar','.filmstrip-section'])$(selector)?.remove();
  const candidates=candidateIds();
  const section=document.createElement('section');section.className='grid-section';
  section.innerHTML=`<div class="candidate-ribbon"><div class="ribbon-heading"><strong>本组候选 · ${candidates.length}</strong><span>点击加入比较选择；× 取消保留并改为待定</span><button class="button small" data-grid-action="compare">比较已选 ${picks.length} 张 <kbd>C</kbd></button><button class="button small" data-grid-action="clear">清空勾选</button><button class="button small" data-grid-action="review">候选复核</button></div><div class="candidate-items">${candidates.map(id=>`<div class="candidate-chip ${picks.includes(id)?'picked':''}"><button data-grid-pick="${escape(id)}" aria-pressed="${picks.includes(id)}" title="勾选 ${escape(photoById(id).name)}">${imageTag(id)}</button><button class="remove-candidate" data-grid-defer="${escape(id)}" aria-label="取消保留 ${escape(photoById(id).name)}">×</button><small>${escape(photoById(id).name)}</small></div>`).join('')||'<p>确认本页后，保留的照片会常驻这里。</p>'}</div></div>
  ${session.review?'<div class="review-banner">本组候选复核 · 显示保留和待定照片。勾选最终想留下的，再确认本页；待定照片不会被自动淘汰。<button class="text-button" data-grid-action="browse">返回组内浏览</button></div>':''}
  <div class="grid-controls"><label>每页 <select id="grid-size" aria-label="每页照片数量">${[4,6,8].map(n=>`<option ${n===state.grid.size?'selected':''}>${n}</option>`).join('')}</select> 张</label><span>第 ${session.page+1} / ${pages} 页 · ${pool.length} 张${session.review?'候选与待定':''}</span><div class="filmstrip-filters">${[['round','本轮'],['keep','保留'],['unsure','待定'],['reject','淘汰'],['all','全部']].map(([key,label])=>`<button data-grid-filter="${key}" class="${state.filter===key?'active':''}">${label}</button>`).join('')}</div></div>
  <div class="photo-grid size-${state.grid.size}">${photos.map((p,i)=>`<article class="grid-card status-${p.status} ${picks.includes(p.id)?'picked':''}" data-grid-id="${escape(p.id)}"><button class="grid-photo" data-grid-pick="${escape(p.id)}" aria-pressed="${picks.includes(p.id)}" aria-label="勾选 ${escape(p.name)}"><kbd>${i+1}</kbd>${imageTag(p.id,'preview')}<span class="grid-check">${picks.includes(p.id)?'✓':'○'}</span></button><div class="grid-caption"><span title="${escape(p.path||p.name)}">${escape(p.name)}</span><span class="status-badge ${p.status}">${labels[p.status]}</span><button data-grid-rotate="${escape(p.id)}" aria-label="旋转 ${escape(p.name)}" title="顺时针旋转 90°，仅调整显示">↻</button><button data-grid-defer="${escape(p.id)}" title="将这张标为待定">待定</button></div></article>`).join('')||'<div class="grid-empty">没有符合条件的照片。可切换“全部”找回已淘汰照片。</div>'}</div>
  <div class="grid-footer"><button class="button" data-grid-action="prev" ${session.page===0?'disabled':''}>← 上一页</button><button class="button" data-grid-action="next">${session.page+1>=pages?'查看候选':'下一页 →'}</button><button class="button" data-grid-action="defer">已选标为待定 <kbd>?</kbd></button><button class="button" data-action="undo" ${undoStack.length?'':'disabled'}>撤销整批</button><button class="button primary" data-grid-action="confirm" ${photos.length?'':'disabled'}>保留本页选中，其余淘汰 <kbd>Enter</kbd></button></div><p class="grid-note">数字 1–${state.grid.size} 勾选 · C 比较 2–4 张 · ← → 翻页 · Ctrl+Z 撤销。确认只处理当前页 ${photos.length} 张，待定除外；未展示照片与此前其他页候选不变。${picks.length?' 已勾选 '+picks.length+' 张（含跨页）。':''}</p>`;
  tabs.after(section);
  layoutGrid();gridResizeObserver=new ResizeObserver(()=>{cancelAnimationFrame(gridLayoutFrame);gridLayoutFrame=requestAnimationFrame(layoutGrid);});gridResizeObserver.observe($('.photo-grid'));
  const hint=$('.shortcut-hint');if(hint)hint.innerHTML='<span>1–8 勾选 · Enter 确认本页 · C 对比 · Ctrl+Z 撤销</span><button class="link-button" data-action="help">全部快捷键 ↗</button>';
}
function layoutGrid(){
  const grid=$('.photo-grid');if(!grid||!activeGroup())return;
  const cards=[...grid.querySelectorAll('.grid-card')];if(!cards.length)return;
  const width=grid.clientWidth,top=grid.getBoundingClientRect().top+scrollY;
  const foot=['.grid-footer','.grid-note','.bottom-bar'].reduce((sum,s)=>sum+($(s)?.getBoundingClientRect().height||0),0)+30;
  const height=Math.max(180,innerHeight-top-foot);
  const ratios=cards.map(card=>{const id=card.dataset.gridId;return photoRatio(photoById(id),rotationFor(state,id),measuredDimensions.get(id));});
  const rows=layoutRows(ratios,width,height);
  // Reuse rows and image nodes while image loads/resize callbacks settle.
  let containers=[...grid.querySelectorAll(':scope > .grid-row')];
  if(containers.length!==rows.length){containers=rows.map(()=>{const row=document.createElement('div');row.className='grid-row';return row;});grid.replaceChildren(...containers);}
  rows.forEach((row,r)=>{
    const expected=row.indices.map(index=>cards[index]),actual=[...containers[r].children];
    if(actual.length!==expected.length||actual.some((card,i)=>card!==expected[i]))containers[r].replaceChildren(...expected);
  });
  rows.forEach((row,r)=>row.indices.forEach((index,i)=>{
    const card=cards[index];
    card.style.width=`${row.widths[i]+4}px`;card.style.setProperty('--photo-height',`${row.height}px`);
    const frame=card.querySelector('.grid-photo'),img=frame.querySelector('img');fitRotatedImage(img,frame.clientWidth,frame.clientHeight,rotationFor(state,card.dataset.gridId));
  }));
  for(const img of document.querySelectorAll('.candidate-chip img')){const frame=img.parentElement;fitRotatedImage(img,frame.clientWidth,frame.clientHeight,rotationFor(state,img.dataset.image));}
}
function rotateGrid(id){
  if(busy||!photoById(id))return;remember();gridSession();state.grid.rotations[id]=(rotationFor(state,id)+90)%360;render();scheduleSave();
}
function gridDecision(ids,status){
  if(busy||!ids.length)return;remember();
  applyPage(state,activeGroup(),ids,ids,status);
  const session=gridSession();session.picks=status==='keep'?[...new Set([...session.picks,...ids])]:session.picks.filter(id=>!ids.includes(id));
  render();scheduleSave();
}
function openCompare(){
  const ids=gridPicks();if(ids.length<2||ids.length>4){toast('请勾选 2–4 张照片，可组合本页照片和上方此前候选');return;}
  showCompare({ids,photo:photoById,rotation:id=>rotationFor(state,id),escape,decide:gridDecision,undo,url:async(id,kind)=>{
    if(local.project)return local.asset(id,kind);
    if(kind==='detail')return null;
    return imageUrl(id,'preview');
  }}).catch(e=>toast(e.message));
}
function gridAction(name){
  if(busy)return;const {session,pool,photos,pages}=currentGridPage();
  if(name==='grid'||name==='arena'){state.grid.view=name;render();scheduleSave();return;}
  if(name==='compare'){openCompare();return;}
  if(name==='clear')session.picks=[];
  if(name==='review'){session.review=true;session.page=0;session.picks=[];}
  if(name==='browse'){session.review=false;session.page=0;session.picks=[];}
  if(name==='prev')session.page=Math.max(0,session.page-1);
  if(name==='next'){if(session.page+1<pages)session.page++;else if(!session.review){session.review=true;session.page=0;session.picks=[];}else toast('候选复核已到最后一页，可切换分组或开始下一轮');}
  if(name==='defer'){gridDecision(gridPicks(),'unsure');return;}
  if(name==='confirm'){
    if(!photos.length)return;
    const ready=new Set([...document.querySelectorAll('.grid-photo img')].filter(img=>img.complete&&img.naturalWidth>0).map(img=>img.dataset.image));
    if(photos.some(p=>p.status!=='unsure'&&!ready.has(p.id))){toast('本页预览尚未全部显示，请加载完成后确认；无法读取的照片可先标为待定。');return;}
    remember();const ids=photos.map(p=>p.id),at=session.page,wasReview=session.review;
    applyPage(state,activeGroup(),ids,session.picks);session.visited=[...new Set([...session.visited,...ids])];session.picks=session.picks.filter(id=>!ids.includes(id));
    if(wasReview||!['round','all'].includes(state.filter)){
      // Status-filtered views can shrink. Anchor on the first following ID.
      const following=pool.slice((at+1)*state.grid.size).map(p=>p.id),remaining=gridPool(state,activeGroup(),session);
      const next=remaining.findIndex(p=>following.includes(p.id));session.page=next<0?Math.min(at,Math.max(0,Math.ceil(remaining.length/state.grid.size)-1)):Math.floor(next/state.grid.size);
      if(next<0)toast('本页判断已保存，可继续复核、切换分组或开始下一轮');
    }else if(at+1<pages)session.page++;
    else {session.review=true;session.page=0;session.picks=[];toast('本组已到最后一批，进入候选与待定复核');}
  }
  render();scheduleSave();
}
function selectGroup(id){state.groupId=id;state.candidateId=null;state.challengerId=null;state.selectedSide='right';normalizeSelection();render();scheduleSave();}
function selectPhoto(id){
  if(candidateIds().includes(id)){state.candidateId=id;state.selectedSide='left';if(state.challengerId===id)state.challengerId=null;}
  else {state.challengerId=id;state.selectedSide='right';}
  render();scheduleSave();
}
function step(delta=1){
  const pool=challengerPhotos();if(!pool.length)return;let at=pool.findIndex(p=>p.id===state.challengerId);at=at<0?0:at+delta;
  if(at<0){toast('已经是本组第一张');return;}if(at>=pool.length){toast('本组浏览到底了，可以复看候选或切换分组');return;}
  state.challengerId=pool[at].id;state.selectedSide='right';render();scheduleSave();
}
function advanceAfter(oldId,oldPool){
  const pool=challengerPhotos();const at=oldPool.indexOf(oldId),remaining=oldPool.slice(at+1).find(id=>pool.some(p=>p.id===id));
  state.challengerId=remaining||pool.find(p=>p.status==='pending')?.id||pool[0]?.id||null;state.selectedSide='right';
}
function addCandidate(id){const group=activeGroup();if(!group)return;const ids=state.candidates[group.id]||[];if(!ids.includes(id))ids.push(id);state.candidates[group.id]=ids;if(!state.candidateId)state.candidateId=id;}
function includeInRound(photo){photo.roundIncluded=true;if(!state.roundIds.includes(photo.id))state.roundIds.push(photo.id);}
function removeCandidate(id){for(const key of Object.keys(state.candidates))state.candidates[key]=state.candidates[key].filter(i=>i!==id);if(state.candidateId===id)state.candidateId=null;}
function judge(status){
  if(busy)return;const photo=selectedPhoto();if(!photo)return;remember();const oldPool=challengerPhotos().map(p=>p.id),side=state.selectedSide;photo.status=status;
  if(status!=='reject')includeInRound(photo);if(status==='keep')addCandidate(photo.id);else removeCandidate(photo.id);
  if(side==='right')advanceAfter(photo.id,oldPool);else {state.selectedSide='right';normalizeSelection();}
  render();scheduleSave();
}
function win(){
  if(busy)return;const candidate=activeCandidate(),challenger=state.challengerId;if(!candidate||!challenger)return;remember();const oldPool=challengerPhotos().map(p=>p.id);
  state.photos=chooseWinner(state.photos,candidate,challenger);includeInRound(photoById(challenger));removeCandidate(candidate);addCandidate(challenger);state.candidateId=challenger;advanceAfter(challenger,oldPool);render();scheduleSave();toast('新候选已上场。旧候选标为淘汰，可撤销找回');
}
function keepBoth(){
  if(busy)return;const a=photoById(activeCandidate()),b=photoById(state.challengerId);if(!a||!b)return;remember();const oldPool=challengerPhotos().map(p=>p.id);a.status=b.status='keep';includeInRound(a);includeInRound(b);addCandidate(a.id);addCandidate(b.id);advanceAfter(b.id,oldPool);render();scheduleSave();toast('两张都已保留，可点击绿色缩略图切换参考候选');
}
function pin(){if(busy)return;const p=photoById(state.challengerId);if(!p)return;remember();const oldPool=challengerPhotos().map(p=>p.id);addCandidate(p.id);state.candidateId=p.id;advanceAfter(p.id,oldPool);render();scheduleSave();toast('已设为比较候选；最终是否保留，由你决定');}
function regroup(mode=state.mode){
  if(busy)return;remember();const oldCandidateIds=new Set(Object.values(state.candidates).flat());state.mode=mode;
  const input=$('#group-threshold');state.threshold=mode===state.mode&&input?Number(input.value)||90:90;
  if(mode==='visual')state.threshold=Math.min(30,Math.max(1,state.threshold));else state.threshold=Math.min(3600,Math.max(1,state.threshold));
  rebuildGroups(oldCandidateIds);render();scheduleSave();toast(`已分为 ${state.groups.length} 组，已有判断与候选保留`);
}
function rebuildGroups(oldCandidateIds=new Set(Object.values(state.candidates).flat())){
  if(state.grid)state.grid.sessions={};
  state.groups=makeGroups(state.photos,state.mode,state.threshold);state.candidates={};for(const g of state.groups)state.candidates[g.id]=g.ids.filter(id=>oldCandidateIds.has(id));state.groupId=state.groups.find(g=>g.ids.includes(state.challengerId||state.candidateId))?.id||state.groups[0]?.id;normalizeSelection();
}
function movePhoto(target){
  if(busy)return;const p=selectedPhoto(),from=activeGroup();if(!p||!target)return;remember();const wasCandidate=candidateIds().includes(p.id);from.ids=from.ids.filter(id=>id!==p.id);removeCandidate(p.id);
  if(state.grid)state.grid.sessions={};
  let to=state.groups.find(g=>g.id===target);if(target==='new'){to={id:`manual-${crypto.randomUUID()}`,name:`手动分组 ${state.groups.length+1}`,ids:[]};state.groups.push(to);}if(!to)return;to.ids.push(p.id);if(wasCandidate){state.candidates[to.id]=[...(state.candidates[to.id]||[]),p.id];}state.groups=state.groups.filter(g=>g.ids.length);state.groupId=to.id;state.challengerId=p.id;state.candidateId=null;normalizeSelection();render();scheduleSave();toast('已移动。重新自动分组会覆盖手动分组');
}
function startRound(){
  if(busy)return;const ids=nextRound(state.photos,state.round);if(!ids.length){toast('没有可进入下一轮的照片，请先从“全部”中找回照片');return;}
  $('#round-description').textContent=`第 ${state.round+1} 轮将带入 ${ids.length} 张照片：保留、待定和本轮未评的照片。`;$('#round-dialog').showModal();
}
function confirmRound(){
  if(busy)return;remember();const ids=nextRound(state.photos,state.round);state.history.push({round:state.round,at:Date.now(),decisions:state.photos.filter(p=>state.roundIds.includes(p.id)).map(p=>({id:p.id,name:p.name,status:p.status}))});state.round++;
  state.roundIds=ids;const included=new Set(ids);for(const p of state.photos){p.roundIncluded=included.has(p.id);if(included.has(p.id))p.status='pending';}
  state.filter='round';state.challengerId=null;state.selectedSide='right';$('#round-dialog').close();normalizeSelection();render();scheduleSave();toast(`第 ${state.round} 轮开始，历史判断已保存`);
}
function showHistory(){
  const history=[...state.history,{round:state.round,at:null,decisions:state.photos.filter(p=>state.roundIds.includes(p.id)).map(p=>({id:p.id,name:p.name,status:p.status}))}];
  $('#history-content').innerHTML=history.map(h=>`<div class="history-entry"><strong>第 ${h.round} 轮 ${h.at?'':'· 进行中'}</strong><p>${STATUSES.map(s=>`${labels[s]} ${h.decisions.filter(d=>d.status===s).length}`).join('　')}${h.at?' · '+formatTime(h.at):''}</p><details><summary>查看文件名与判断</summary><div class="history-files">${h.decisions.map(d=>`${escape(d.name)}　${labels[d.status]||'未评'}`).join('<br>')}</div></details></div>`).join('');$('#history-dialog').showModal();
}
async function viewOriginal(){
  const p=selectedPhoto();if(!p)return;const file=originalFiles.get(p.id);if(!file){toast('刷新后不保留原文件句柄。重新导入相同原文件即可查看原尺寸；当前显示 1400px 内预览。');return;}
  const side=state.selectedSide,frame=document.querySelector(`.photo-panel[data-side="${side}"] .photo-frame`),img=frame?.querySelector('img');if(!img)return;
  const url=URL.createObjectURL(file);img.src=url;img.onload=()=>URL.revokeObjectURL(url);img.onerror=()=>{URL.revokeObjectURL(url);toast('浏览器无法查看此原文件，请使用轻量预览');};frame.classList.add('zoomed');toast('已读取原尺寸，点击照片退出放大。一次只加载当前照片');
}
function download(content,name,type){const url=URL.createObjectURL(new Blob([content],{type})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function exportData(type){
  const date=new Date().toISOString().slice(0,10);
  if(type==='keep') {const kept=state.photos.filter(p=>p.status==='keep');if(!kept.length){toast('当前没有标为保留的照片');return;}download(kept.map(p=>p.path||p.name).join('\n'),`留影_保留_${date}.txt`,'text/plain;charset=utf-8');}
  if(type==='csv'){const groupMap=new Map(state.groups.flatMap(g=>g.ids.map(id=>[id,g.name])));const rows=[['文件名','相对路径','分组','时间','时间来源','状态','候选','轮次'],...state.photos.map(p=>[p.name,p.path||p.name,groupMap.get(p.id),new Date(p.time).toISOString(),p.timeSource,labels[p.status],Object.values(state.candidates).flat().includes(p.id)?'是':'否',state.round])];download('\ufeff'+rows.map(r=>r.map(csvCell).join(',')).join('\r\n'),`留影_筛选清单_${date}.csv`,'text/csv;charset=utf-8');}
  if(type==='progress')download(JSON.stringify({format:'framekeep-progress',version:1,exportedAt:new Date().toISOString(),project:snapshot()},null,2),`留影_筛选进度_${date}.json`,'application/json');
  $('#export-dialog').close();toast('已导出，原片保持不变');
}
async function restoreProgress(file){
  if(!file)return;if(file.size>15*1024*1024){toast('备份文件过大，无法导入');return;}
  try {
    const data=JSON.parse(await file.text()),project=data.project;
    if(data.format!=='framekeep-progress'||data.version!==1||!project||!Array.isArray(project.photos)||!Array.isArray(project.groups)||!Array.isArray(project.roundIds)||!Array.isArray(project.history))throw new Error('不是有效的留影进度备份');
    const existingByKey=new Map(state.photos.map(p=>[p.key,p]));let matched=0;
    // Restore only identifiers/decisions that match already-imported files; never trust preview paths from JSON.
    const idMap=new Map();for(const p of project.photos){const found=existingByKey.get(p.key);if(found){idMap.set(p.id,found.id);matched++;}}
    if(!matched)throw new Error('请先导入备份对应的照片，再导入进度 JSON');
    remember();for(const p of project.photos){const current=photoById(idMap.get(p.id));if(current&&STATUSES.includes(p.status)){current.status=p.status;current.roundIncluded=p.roundIncluded!==false;}}
    const restoredGroups=project.groups.map(g=>({id:`restored-${crypto.randomUUID()}`,name:String(g.name||'分组').slice(0,80),ids:(Array.isArray(g.ids)?g.ids:[]).map(id=>idMap.get(id)).filter(Boolean)})).filter(g=>g.ids.length);
    const seen=new Set();for(const g of restoredGroups)g.ids=g.ids.filter(id=>{if(seen.has(id))return false;seen.add(id);return true;});const extra=state.photos.filter(p=>!seen.has(p.id));if(extra.length)restoredGroups.push({id:`extra-${crypto.randomUUID()}`,name:'备份之外的照片',ids:extra.map(p=>p.id)});
    state.groups=restoredGroups.filter(g=>g.ids.length);state.candidates={};for(let i=0;i<project.groups.length;i++){const old=project.groups[i];const mapped=(project.candidates?.[old.id]||[]).map(id=>idMap.get(id)).filter(Boolean);for(const g of state.groups){const candidates=mapped.filter(id=>g.ids.includes(id)&&photoById(id)?.status!=='reject');state.candidates[g.id]=[...new Set([...(state.candidates[g.id]||[]),...candidates])];}}
    state.round=Math.max(1,Math.min(999,Number(project.round)||1));state.roundIds=[...new Set([...project.roundIds.map(id=>idMap.get(id)).filter(Boolean),...extra.map(p=>p.id)])];
    state.history=project.history.slice(-100).map(h=>({round:Number(h.round)||1,at:Number(h.at)||Date.now(),decisions:(Array.isArray(h.decisions)?h.decisions:[]).filter(d=>idMap.has(d.id)&&STATUSES.includes(d.status)).map(d=>({id:idMap.get(d.id),name:photoById(idMap.get(d.id))?.name,status:d.status}))}));state.groupId=state.groups[0]?.id;state.candidateId=null;state.challengerId=null;state.filter='round';normalizeSelection();render();scheduleSave();toast(`已恢复 ${matched} / ${project.photos.length} 张的判断${matched<project.photos.length?'，其余照片需重新导入':''}`);
  }catch(e){toast(e.message||'进度导入失败');}
}

async function mainThreadProcess(file){
  const time=exifTime(await file.slice(0,262144).arrayBuffer());const bitmap=await createImageBitmap(file);const scale=Math.min(1,1400/bitmap.width,1400/bitmap.height);
  const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();
  const toBlob=(c,quality)=>new Promise((resolve,reject)=>c.toBlob(b=>b?resolve(b):reject(new Error('图片转换失败')),'image/jpeg',quality));const preview=await toBlob(canvas,.82);
  const thumbCanvas=document.createElement('canvas');thumbCanvas.width=240;thumbCanvas.height=Math.max(1,Math.round(240*canvas.height/canvas.width));thumbCanvas.getContext('2d').drawImage(canvas,0,0,thumbCanvas.width,thumbCanvas.height);const thumb=await toBlob(thumbCanvas,.65);
  const hashCanvas=document.createElement('canvas');hashCanvas.width=9;hashCanvas.height=8;const ctx=hashCanvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(canvas,0,0,9,8);return {preview,thumb,time,width:canvas.width,height:canvas.height,...signature(ctx.getImageData(0,0,9,8).data)};
}
async function processFile(file){
  if(!worker)return mainThreadProcess(file);
  try {return await new Promise((resolve,reject)=>{const requestId=++jobCounter,timer=setTimeout(()=>{jobs.delete(requestId);worker?.terminate();worker=null;reject(new Error('解码超时'));},45000);jobs.set(requestId,{resolve,reject,timer});worker.postMessage({requestId,file});});}catch(e){if(!worker)return mainThreadProcess(file);throw e;}
}
function renderImportProgress(){
  document.querySelector('.import-progress')?.remove();if(!importProgress)return;
  const div=document.createElement('div');div.className='import-progress';div.setAttribute('role','status');div.innerHTML=`<strong>${escape(importProgress.title||'正在生成轻量预览')} · ${importProgress.done} / ${importProgress.total}</strong><small>逐张本地处理，原片不上传。完成后自动分组。</small><progress value="${importProgress.done}" max="${importProgress.total}"></progress><button id="cancel-import">停止导入</button>`;document.body.append(div);$('#cancel-import').onclick=()=>{cancelImport=true;toast('处理完当前照片后停止，已导入的照片会保留');};
}
async function importFiles(files,isDemo=false){
  if(busy){toast('正在导入，请稍候');return;}
  const accepted=[...files].filter(f=>/^image\//.test(f.type)||/\.(jpe?g|png|webp|avif|gif|bmp)$/i.test(f.name));if(!accepted.length){toast('请导入 JPEG、PNG、WebP 等图片；RAW 请先生成 JPEG 缩略图');return;}
  if(state.demo&&!isDemo)await clearProject(false);
  busy=true;cancelImport=false;undoStack=[];const oldCandidates=new Set(Object.values(state.candidates).flat()),existing=new Map(state.photos.map(p=>[p.key,p]));let added=0,skipped=files.length-accepted.length,duplicates=0;
  importProgress={done:0,total:accepted.length};renderImportProgress();
  for(let i=0;i<accepted.length;i++){
    if(cancelImport)break;const file=accepted[i],key=fileKey(file);if(existing.has(key)){originalFiles.set(existing.get(key).id,file);duplicates++;}
    else {try {const result=await processFile(file),id=crypto.randomUUID();await putAsset(id,{preview:result.preview,thumb:result.thumb});
      const photo={id,key,name:file.name,path:file.webkitRelativePath||file.name,size:file.size,lastModified:file.lastModified,time:result.time||file.lastModified||Date.now(),timeSource:result.time?'exif':isDemo?'demo':'modified',hash:result.hash,color:result.color,width:result.width,height:result.height,status:'pending',roundIncluded:true};state.photos.push(photo);state.roundIds.push(id);existing.set(key,photo);originalFiles.set(id,file);added++;
    }catch{skipped++;}}
    importProgress.done=i+1;if(i%3===0||i===accepted.length-1)renderImportProgress();if(i%20===0){rebuildGroups(oldCandidates);await save();}await new Promise(r=>setTimeout(r,0));
  }
  state.demo=isDemo;rebuildGroups(oldCandidates);busy=false;importProgress=null;render();document.querySelector('.import-progress')?.remove();await save();
  toast(`${cancelImport?'已停止；':''}导入 ${added} 张${duplicates?`，重连 ${duplicates} 张原文件`:''}${skipped?`，跳过 ${skipped} 个不支持或无法解码的文件`:''}`);
}
async function demoFile(g,v){
  const svg=new Blob([demoSvg(g,v)],{type:'image/svg+xml'}),url=URL.createObjectURL(svg);const img=new Image();await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=reject;img.src=url;});const canvas=document.createElement('canvas');canvas.width=600;canvas.height=800;canvas.getContext('2d').drawImage(img,0,0);URL.revokeObjectURL(url);const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.9));return new File([blob],`DEMO_${g+1}${String(v+1).padStart(3,'0')}.jpg`,{type:'image/jpeg',lastModified:new Date(2026,9,10,14,g*10,v*8).getTime()});
}
async function loadDemo(){
  if(busy)return;const files=[];for(let g=0;g<3;g++)for(let v=0;v<6;v++)files.push(await demoFile(g,v));await importFiles(files,true);
}
async function clearProject(showToast=true){
  if(busy)return;clearTimeout(saveTimer);observer?.disconnect();for(const map of [thumbUrls,previewUrls]){for(const url of map.values())URL.revokeObjectURL(url);map.clear();}originalFiles.clear();memoryAssets.clear();undoStack=[];
  if(db){await transaction('assets','readwrite',s=>s.clear());await transaction('project','readwrite',s=>s.clear());}
  state={schema:1,photos:[],groups:[],candidates:{},round:1,history:[],roundIds:[],mode:'time',threshold:90,groupId:null,challengerId:null,selectedSide:'right',filter:'round',demo:false};render();if(showToast)toast('本地项目已清空，原片保持不变');
}
function action(name){
  if(local.action(name))return;
  const readOnly=['help','export','history','original'];if(busy&&!readOnly.includes(name)&&name!=='import'){toast('正在生成预览，完成后即可筛选');return;}
  if(name==='import')$('#file-input').click();if(name==='demo')loadDemo().catch(()=>toast('演示加载失败，请直接导入照片'));
  if(name==='help'){
    $('#help-dialog .muted').textContent='网格与候选擂台使用不同快捷键；输入路径或打开弹窗时不会触发网格判断。';
    $('#help-dialog .key-list').innerHTML=`${[['1–8','网格：勾选本页对应照片'],['Enter','网格：保留本页选中，其余淘汰（待定除外）'],['C','网格：比较勾选的 2–4 张'],['?','网格：已选标为待定'],['← / →','网格翻页 / 擂台浏览挑战者'],['Ctrl / ⌘ Z','撤销上一次判断（整页操作一起撤销）'],['↑ / ↓','切换分组'],['1 / 2 / 3','擂台：保留 / 淘汰 / 待定'],['W / B','擂台：替换候选 / 两张都留'],['Q / E','擂台：选择左侧 / 右侧']].map(([k,t])=>`<div><kbd>${k}</kbd><span>${t}</span></div>`).join('')}`;
    $('#help-dialog').showModal();
  }if(name==='export')$('#export-dialog').showModal();if(name==='history')showHistory();if(name==='reset')$('#reset-dialog').showModal();
  if(name==='prev')step(-1);if(name==='next')step(1);if(name==='undo')undo();if(name==='winner')win();if(name==='both')keepBoth();if(name==='pin')pin();if(name==='round')startRound();if(name==='regroup')regroup();if(name==='original')viewOriginal();
}
$('#app').addEventListener('click',e=>{
  const button=e.target.closest('button');if(button?.disabled)return;
  if(button?.dataset.gridAction)return gridAction(button.dataset.gridAction);
  if(button?.dataset.gridPick)return toggleGrid(button.dataset.gridPick);
  if(button?.dataset.gridDefer)return gridDecision([button.dataset.gridDefer],'unsure');
  if(button?.dataset.gridRotate)return rotateGrid(button.dataset.gridRotate);
  if(button?.dataset.gridFilter){state.filter=button.dataset.gridFilter;gridSession().review=false;render();scheduleSave();return;}
  if(button?.dataset.action)return action(button.dataset.action);
  if(button?.dataset.status)return judge(button.dataset.status);
  if(button?.dataset.group)return selectGroup(button.dataset.group);
  if(button?.dataset.photo)return selectPhoto(button.dataset.photo);
  if(button?.dataset.filter){state.filter=button.dataset.filter;normalizeSelection();render();scheduleSave();return;}
  if(button?.dataset.mode){const mode=button.dataset.mode;if(mode!==state.mode){state.threshold=mode==='visual'?13:90;const input=$('#group-threshold');if(input)input.value=state.threshold;regroup(mode);}return;}
  const panel=e.target.closest('.photo-panel');if(panel){const changed=state.selectedSide!==panel.dataset.side;state.selectedSide=panel.dataset.side;
    if(e.target.tagName==='IMG'){const frame=e.target.closest('.photo-frame');frame.classList.toggle('zoomed');if(!frame.classList.contains('zoomed'))imageUrl(e.target.dataset.image,'preview').then(url=>{if(e.target.isConnected)e.target.src=url;});}
    if(changed){document.querySelectorAll('.photo-panel').forEach(el=>el.classList.toggle('selected',el===panel));const caption=$('.judge-caption');if(caption)caption.innerHTML=`正在操作 <strong>${state.selectedSide==='left'?'左侧候选':'右侧挑战者'}</strong><br>${escape(selectedPhoto()?.name||'先选一张照片')}`;scheduleSave();}
  }
});
$('#app').addEventListener('change',e=>{if(e.target.id==='move-group')movePhoto(e.target.value);if(e.target.id==='grid-size'){const s=gridSession(),offset=s.page*state.grid.size;state.grid.size=Number(e.target.value);s.page=Math.floor(offset/state.grid.size);render();scheduleSave();}});
$('#app').addEventListener('scroll',e=>{
  const list=e.target;if(!list.classList?.contains('group-list')||list.dataset.scope!==sidebarScope())return;
  const position={top:list.scrollTop,left:list.scrollLeft},old=state.sidebarScroll;
  if(old?.top===position.top&&old?.left===position.left)return;state.sidebarScroll=position;scheduleSave();
},true);
$('#app').addEventListener('pointermove',e=>{const frame=e.target.closest('.photo-frame.zoomed');if(frame){const r=frame.getBoundingClientRect();frame.style.setProperty('--zoom-x',`${(e.clientX-r.left)/r.width*100}%`);frame.style.setProperty('--zoom-y',`${(e.clientY-r.top)/r.height*100}%`);}});
$('#file-input').addEventListener('change',e=>{importFiles(e.target.files).catch(()=>toast('导入中断，请重试'));e.target.value='';});
$('#progress-input').addEventListener('change',e=>{restoreProgress(e.target.files[0]);e.target.value='';});
$('#import-button').onclick=()=>action('import');$('#help-button').onclick=()=>action('help');
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>b.closest('dialog').close());
$('#confirm-round').onclick=confirmRound;$('#confirm-reset').onclick=async()=>{$('#reset-dialog').close();await clearProject();};
document.querySelectorAll('[data-export]').forEach(b=>b.onclick=()=>exportData(b.dataset.export));$('#restore-progress').onclick=()=>{$('#export-dialog').close();$('#progress-input').click();};
document.addEventListener('keydown',e=>{
  if(document.querySelector('dialog[open]')||busy||['INPUT','SELECT','TEXTAREA'].includes(e.target.tagName)||e.target.isContentEditable)return;
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();undo();return;}if(e.ctrlKey||e.metaKey||e.altKey)return;
  if(!state.photos.length)return;const key=e.key.toLowerCase();const map={'1':()=>judge('keep'),'2':()=>judge('reject'),'3':()=>judge('unsure'),arrowleft:()=>step(-1),arrowright:()=>step(1),' ':()=>step(1),w:win,b:keepBoth,q:()=>{if(activeCandidate()){state.selectedSide='left';render();}},e:()=>{state.selectedSide='right';render();},'?':()=>action('help')};
  if(state.grid?.view!=='arena'){
    if(e.repeat&&key==='enter'){e.preventDefault();return;}
    const page=currentGridPage();let handled=true;
    if(/^[1-8]$/.test(key)){if(!e.repeat){const p=page.photos[Number(key)-1];if(p)toggleGrid(p.id);}}
    else if(key==='enter'){if(!e.repeat&&e.target.tagName!=='BUTTON')gridAction('confirm');else if(e.target.tagName==='BUTTON')return;}
    else if(key==='c'){if(!e.repeat)openCompare();}
    else if(key==='arrowleft')gridAction('prev');else if(key==='arrowright'||key===' ')gridAction('next');
    else if(key==='?'){if(!e.repeat)gridAction('defer');}else handled=false;
    if(handled){e.preventDefault();return;}
    if(['w','b','q','e'].includes(key))return;
  }
  if(key==='arrowup'||key==='arrowdown'){e.preventDefault();const i=state.groups.findIndex(g=>g.id===state.groupId),next=state.groups[i+(key==='arrowup'?-1:1)];if(next)selectGroup(next.id);return;}
  if(map[key]){e.preventDefault();map[key]();}
});
let dragDepth=0;document.addEventListener('dragenter',e=>{if(e.dataTransfer?.types.includes('Files')){e.preventDefault();dragDepth++;$('#drop-overlay').hidden=false;}});document.addEventListener('dragover',e=>{if(e.dataTransfer?.types.includes('Files'))e.preventDefault();});document.addEventListener('dragleave',e=>{if(e.dataTransfer?.types.includes('Files')){dragDepth=Math.max(0,dragDepth-1);if(!dragDepth)$('#drop-overlay').hidden=true;}});document.addEventListener('drop',e=>{e.preventDefault();dragDepth=0;$('#drop-overlay').hidden=true;if(local.enabled){action('import');return;}if(e.dataTransfer?.files.length)importFiles(e.dataTransfer.files).catch(()=>toast('导入中断，请重试'));});
document.addEventListener('visibilitychange',()=>{if(document.hidden&&(db||local.project)&&state.photos.length){clearTimeout(saveTimer);save();}});
window.addEventListener('beforeunload',e=>{if(busy||local.enabled&&$('#save-state').textContent.includes('保存中')){e.preventDefault();e.returnValue='';}});
renderWelcome();await initStorage();
