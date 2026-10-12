export async function showCompare({ids,photo,url,decide,undo,rotation=()=>0,escape:esc}) {
  document.querySelector('#multi-compare')?.remove();
  const dialog=document.createElement('dialog');dialog.id='multi-compare';dialog.className='dialog multi-compare';
  let scale=1,actual=false,center={x:.5,y:.5},drag=null,closed=false,detailGeneration=0;
  dialog.innerHTML=`<div class="dialog-heading"><h2>精细比较 · ${ids.length} 张</h2><button class="icon-button" data-exit aria-label="关闭比较">×</button></div><div class="compare-tools"><button class="button small" data-fit>适应窗口</button><label>同步放大 <input aria-label="同步放大倍率" type="range" min="1" max="6" step=".25" value="1"></label><button class="button small" data-detail>加载原尺寸细节</button><button class="button small" data-actual>100%</button><button class="button small" data-keep>全部保留</button><button class="button small" data-undo>撤销</button><span>拖动任一照片同步查看相同相对位置；滚轮同步缩放。</span></div><div class="compare-grid" style="--count:${ids.length}">${ids.map(id=>`<section class="compare-cell" data-id="${esc(id)}"><div class="compare-viewport"><img alt="${esc(photo(id).name)}" draggable="false"></div><div class="compare-name" title="${esc(photo(id).name)}">${esc(photo(id).name)}</div><div class="compare-load" role="status">正在加载预览…</div><div class="compare-decisions">${[['keep','保留'],['reject','淘汰'],['unsure','待定']].map(([s,l])=>`<button class="button" data-decision="${s}">${l}</button>`).join('')}</div></section>`).join('')}</div><p class="grid-note">可逐张决定，也可全部保留。判断自动保存，关闭后回到原网格；同步位置按照片相对坐标计算，不自动对齐人脸。</p>`;
  document.body.append(dialog);dialog.showModal();
  const cells=[...dialog.querySelectorAll('.compare-cell')];
  function transform(){for(const cell of cells){
    const viewport=cell.querySelector('.compare-viewport'),img=cell.querySelector('img'),angle=rotation(cell.dataset.id),sideways=angle%180!==0;
    const nw=img.naturalWidth||1,nh=img.naturalHeight||1,fit=Math.min(viewport.clientWidth/(sideways?nh:nw),viewport.clientHeight/(sideways?nw:nh)),factor=actual?1:fit*scale;
    const width=(sideways?nh:nw)*factor,height=(sideways?nw:nh)*factor;
    const dx=(.5-center.x)*Math.max(0,width-viewport.clientWidth),dy=(.5-center.y)*Math.max(0,height-viewport.clientHeight);
    Object.assign(img.style,{position:'absolute',left:'50%',top:'50%',width:`${nw}px`,height:`${nh}px`,maxWidth:'none',maxHeight:'none',transformOrigin:'center',transform:`translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) rotate(${angle}deg) scale(${factor})`});
  }}
  function statuses(){for(const cell of cells)for(const b of cell.querySelectorAll('[data-decision]')){const active=photo(cell.dataset.id)?.status===b.dataset.decision;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));}}
  async function load(kind){
    const generation=++detailGeneration;dialog.querySelector('[data-detail]').disabled=true;
    // Decode one full RAW at a time to limit peak memory and CPU load.
    for(const cell of cells){
      if(closed||generation!==detailGeneration)break;
      const img=cell.querySelector('img'),caption=cell.querySelector('.compare-load');caption.textContent=kind==='detail'?'正在读取原尺寸（RAW 按需解码）…':'正在加载预览…';
      try {const source=await url(cell.dataset.id,kind);if(closed||generation!==detailGeneration)break;if(!source)throw Error('当前素材无法读取原尺寸');
        await new Promise((resolve,reject)=>{img.onload=()=>resolve();img.onerror=()=>reject(Error('读取失败，请检查原文件；可关闭后重试'));img.src=source;});
        if(closed)break;caption.textContent=`${kind==='detail'?'原尺寸':'预览'} · ${img.naturalWidth} × ${img.naturalHeight}`;transform();
      }catch(e){caption.textContent=e.message;}
    }
    if(!closed&&generation===detailGeneration)dialog.querySelector('[data-detail]').disabled=false;
  }
  dialog.addEventListener('click',e=>{const b=e.target.closest('button');if(!b||b.disabled)return;
    if(b.hasAttribute('data-exit'))dialog.close();
    if(b.hasAttribute('data-fit')){actual=false;scale=1;center={x:.5,y:.5};dialog.querySelector('input').value=1;transform();}
    if(b.hasAttribute('data-detail'))load('detail');
    if(b.hasAttribute('data-actual')){actual=true;transform();}
    if(b.hasAttribute('data-keep')){decide(ids,'keep');statuses();}
    if(b.hasAttribute('data-undo')){undo();statuses();}
    if(b.dataset.decision){decide([b.closest('.compare-cell').dataset.id],b.dataset.decision);statuses();}
  });
  dialog.querySelector('input').oninput=e=>{actual=false;scale=Number(e.target.value);transform();};
  dialog.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();undo();statuses();}});
  dialog.addEventListener('wheel',e=>{if(!e.target.closest('.compare-viewport'))return;e.preventDefault();actual=false;scale=Math.max(1,Math.min(6,scale+(e.deltaY<0?.25:-.25)));dialog.querySelector('input').value=scale;transform();},{passive:false});
  dialog.addEventListener('pointerdown',e=>{const viewport=e.target.closest('.compare-viewport');if(!viewport||e.button!==0)return;drag={x:e.clientX,y:e.clientY,cx:center.x,cy:center.y,w:viewport.clientWidth,h:viewport.clientHeight};viewport.setPointerCapture(e.pointerId);e.preventDefault();});
  dialog.addEventListener('pointermove',e=>{if(!drag)return;center.x=Math.max(0,Math.min(1,drag.cx-(e.clientX-drag.x)/drag.w));center.y=Math.max(0,Math.min(1,drag.cy-(e.clientY-drag.y)/drag.h));transform();});
  for(const event of ['pointerup','pointercancel','lostpointercapture'])dialog.addEventListener(event,()=>drag=null);
  const resize=new ResizeObserver(transform);cells.forEach(c=>resize.observe(c));
  dialog.addEventListener('close',()=>{closed=true;detailGeneration++;resize.disconnect();for(const img of dialog.querySelectorAll('img')){img.onload=null;img.onerror=null;img.removeAttribute('src');}dialog.remove();});
  statuses();await load('preview');
}
