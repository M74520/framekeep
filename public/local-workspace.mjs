const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const $=s=>document.querySelector(s);
export class LocalWorkspace {
  constructor(app){this.app=app;this.enabled=!!$('meta[name="framekeep-local"]');this.project=null;this.token='';this.queue=Promise.resolve();this.conflict=false;this.projects=[];this.task=null;this.importWorkers='auto';}
  async request(path,body){
    const response=await fetch(path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json','X-Framekeep-Token':this.token},body:body===undefined?undefined:JSON.stringify(body)});
    const data=await response.json();if(!response.ok){const error=new Error(data.error||'本机请求失败');error.status=response.status;throw error;}return data;
  }
  async init(){
    try {
      const data=await this.request('/api/bootstrap');this.token=data.token;this.projects=data.projects;this.dataDir=data.dataDir;this.rawDecode=data.rawDecode;
      $('.private-tag').innerHTML='<span class="status-dot"></span>本机工作台 <span class="tag-divider">/</span> 原片只读';
      $('#import-button').textContent='＋ 照片文件夹';
      const switcher=document.createElement('button');switcher.className='button small';switcher.id='projects-button';switcher.textContent='项目';switcher.onclick=()=>this.showProjects();$('.header-actions').prepend(switcher);
      $('#help-dialog .help-note').innerHTML='<strong>每一轮，都可以重新比较。</strong><p>下一轮保留候选，将保留、待定和未评照片带入，并保存上一轮判断。网格用 1–8 勾选、Enter 确认本页、C 比较 2–4 张；Ctrl + Z 撤销。切到候选擂台后，1 / 2 / 3 判断，W 换候选，B 两张都留。</p><p>直接选择本机文件夹，支持索尼 ARW 和常见 RAW、JPEG、PNG、WebP。RAW 优先提取内嵌 JPEG；点“原尺寸细节”时才解码 RAW。内嵌预览和 RAW 解码的色彩可能不同，预览主要用于筛选。</p><p>同目录同名 RAW + JPEG 合并显示。导出默认复制保留原片，也可同时复制配对 JPEG；已有文件跳过。文件夹路径、缓存和筛选记录保存在本机，原片只读。多轮记录可导出 JSON 备份。</p><p>项目中标“文件缺失”的照片仍保留判断。将原文件放回原路径后，点“重新扫描”恢复。请只在一个页面编辑同一项目；检测到另一个页面的修改时会停止自动保存。</p>';
      $('#export-dialog>p').textContent='复制保留的原片到本机目标文件夹，或导出筛选清单与进度。';
      const copy=document.createElement('button');copy.className='export-option';copy.id='copy-originals';copy.innerHTML='<span>▣</span><div><strong>复制保留的原片</strong><small>选择目标文件夹 · 不移动原片</small></div><b>→</b>';copy.onclick=()=>{$('#export-dialog').close();this.showExport();};$('#export-dialog>p').after(copy);
      this.installDialogs();
      if(this.projects.length)await this.open(this.projects[0].id);else this.app.render();
    }catch(e){this.app.toast(e.message);this.app.render();$('#save-state').textContent='本机服务连接失败 · 请刷新';}
  }
  installDialogs(){
    const container=document.createElement('div');container.innerHTML=`
    <dialog id="folder-dialog" class="dialog"><div class="dialog-heading"><h2>选择照片文件夹</h2><button data-close class="icon-button">×</button></div><p>文件直接从本机读取。预览与记录存入程序缓存，不写入原片文件夹。</p><div class="path-row"><input id="folder-path" placeholder="例如 D:\\照片\\漫展" aria-label="照片文件夹完整路径"><button id="browse-source" class="button">浏览…</button></div><label class="check-row"><input id="recursive" type="checkbox" checked> 包含子文件夹</label><label class="performance-row">预览生成 <select id="import-workers" aria-label="预览生成并行数量"><option value="auto">自动推荐</option><option value="1">1 并行 · 省资源</option><option value="2">2 并行 · 均衡</option><option value="4">4 并行 · 更快</option><option value="8">8 并行 · 更多资源</option></select></label><p id="performance-hint" class="muted">自动根据 CPU 和可用内存推荐；手动增加并行会占用更多资源。</p><p class="muted">支持 Sony ARW / 常见 RAW / JPEG / PNG / WebP。RAW + 同名 JPEG 合并显示。</p><p id="folder-error" class="inline-error" role="alert"></p><div class="dialog-actions"><button class="button" data-close>取消</button><button id="scan-folder" class="button primary">读取文件夹 →</button></div></dialog>
    <dialog id="projects-dialog" class="dialog"><div class="dialog-heading"><h2>本机照片项目</h2><button data-close class="icon-button">×</button></div><div id="project-list"></div><p class="muted">项目之间独立保存候选与轮次。把程序 ZIP 发给同事即可，他们的照片和判断保留在各自电脑。</p><div class="dialog-actions"><button id="new-project" class="button primary">＋ 选择新文件夹</button></div></dialog>
    <dialog id="copy-dialog" class="dialog"><div class="dialog-heading"><h2>复制保留的原片</h2><button data-close class="icon-button">×</button></div><p id="copy-summary"></p><div class="path-row"><input id="target-path" placeholder="目标文件夹完整路径" aria-label="导出文件夹完整路径"><button id="browse-target" class="button">浏览…</button></div><label class="check-row"><input id="copy-paired" type="checkbox"> 同时复制同名配对 JPEG</label><label class="check-row"><input id="preserve-paths" type="checkbox" checked> 保留子文件夹结构</label><p class="muted">默认复制 ARW 等源文件；已有同名文件跳过，结果清单写入目标文件夹。请选择原片文件夹之外的位置。</p><p id="copy-error" class="inline-error" role="alert"></p><div class="dialog-actions"><button class="button" data-close>取消</button><button id="start-copy" class="button primary">开始复制 →</button></div></dialog>
    <dialog id="task-dialog" class="dialog"><div class="dialog-heading"><h2 id="task-title">正在读取照片</h2></div><p id="task-file" class="task-file"></p><progress id="task-progress" max="1" value="0"></progress><p id="task-count" role="status" aria-live="polite"></p><div id="task-result"></div><div class="dialog-actions"><button id="cancel-task" class="button">停止任务</button><button id="close-task" class="button primary" hidden>继续 →</button></div></dialog>
    <dialog id="detail-dialog" class="dialog detail-dialog"><div class="dialog-heading"><div><h2 id="detail-title">原尺寸细节</h2><p id="detail-caption"></p></div><div class="detail-actions"><button id="detail-fit" class="button small">适应窗口</button><button id="detail-100" class="button small">100%</button><button class="icon-button" data-close>×</button></div></div><div id="detail-scroll" class="detail-scroll"><img id="detail-image" alt="照片原尺寸细节"></div><p class="muted">100% 显示时拖动照片查看细节；此窗口关闭后只保留轻量预览。RAW 解码使用相机白平衡，不影响原片。</p></dialog>`;
    document.body.append(container);
    container.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>b.closest('dialog').close());
    $('#browse-source').onclick=()=>this.browse('#folder-path','#folder-error');$('#browse-target').onclick=()=>this.browse('#target-path','#copy-error');
    $('#scan-folder').onclick=()=>this.scan();$('#new-project').onclick=()=>{$('#projects-dialog').close();this.showFolder();};
    $('#start-copy').onclick=()=>this.copy();$('#close-task').onclick=()=>$('#task-dialog').close();$('#cancel-task').onclick=()=>this.cancel();
    $('#task-dialog').addEventListener('cancel',e=>{if(this.task)e.preventDefault();});
    $('#folder-path').onkeydown=e=>{if(e.key==='Enter')this.scan();};
    $('#detail-fit').onclick=()=>{$('#detail-image').classList.remove('actual-size');};$('#detail-100').onclick=()=>{$('#detail-image').classList.add('actual-size');};
    $('#detail-dialog').addEventListener('close',()=>{$('#detail-image').removeAttribute('src');$('#detail-image').onload=null;});
    let drag=null;const scroll=$('#detail-scroll');scroll.onpointerdown=e=>{if(!$('#detail-image').classList.contains('actual-size'))return;drag={x:e.clientX,y:e.clientY,left:scroll.scrollLeft,top:scroll.scrollTop};scroll.setPointerCapture(e.pointerId);e.preventDefault();};scroll.onpointermove=e=>{if(drag){scroll.scrollLeft=drag.left+drag.x-e.clientX;scroll.scrollTop=drag.top+drag.y-e.clientY;}};scroll.onpointerup=scroll.onpointercancel=()=>drag=null;
  }
  async browse(input,error){
    if(this.browsing)return;this.browsing=true;
    const buttons=[$('#browse-source'),$('#browse-target')];buttons.forEach(b=>{b.disabled=true;b.textContent='选择中…';});
    $(error).textContent='正在打开系统文件夹窗口，请在弹出的窗口中选择；也可取消后粘贴完整路径。';
    try{const data=await this.request('/api/choose-folder',{});if(data.path)$(input).value=data.path;$(error).textContent=data.path?'':'已取消选择，可重新浏览或直接粘贴路径。';}
    catch(e){$(error).textContent=e.message;}
    finally{this.browsing=false;buttons.forEach(b=>{b.disabled=false;b.textContent='浏览…';});}
  }
  decorateWelcome(){
    if(!this.enabled)return;
    $('.import-zone h2').textContent='选一个照片文件夹，开始筛选';$('.import-zone>p').innerHTML='ARW 自动生成轻量预览，无需先转 JPEG<br>支持子文件夹，判断与轮次自动保存';$('.import-zone [data-action="import"]').textContent='选择照片文件夹 →';$('.format-note').textContent='Sony ARW / 常见 RAW / JPEG / PNG / WebP';$('.welcome-footer>span:last-child').innerHTML='<button class="link-button" data-action="projects">本机项目</button> · <button class="link-button" data-action="demo">演示插画</button>';$('#save-state').textContent='照片与记录保留在本机';
  }
  decorateWorkspace(){
    if(!this.enabled)return;
    if(this.project){
      const heading=$('.sidebar-heading');if(heading)heading.firstElementChild.textContent=this.project.name;
      const footer=$('.sidebar-footer');if(footer)footer.innerHTML=`<p title="${esc(this.project.root)}" class="project-path">${esc(this.project.root)}</p><button class="text-button" data-action="rescan">重新扫描文件夹</button><button class="text-button" data-action="projects">切换照片项目</button>`;
      $('.mobile-reset')?.setAttribute('data-action','projects');if($('.mobile-reset'))$('.mobile-reset').textContent='切换项目';
      const detail=$('[data-action="original"]');if(detail)detail.textContent='原尺寸细节';
      for(const panel of document.querySelectorAll('.photo-panel')){
        const id=panel.querySelector('img[data-image]')?.dataset.image;const p=this.app.state().photos.find(p=>p.id===id);
        if(p){const small=panel.querySelector('.photo-meta small');if(small){const text=document.createElement('small');text.className='preview-source';text.textContent=p.missing?'⚠ 原文件缺失 · 请重新扫描':`${p.previewSource} · ${p.width} × ${p.height}${p.pairedPath?' · RAW + JPEG':''}`;small.after(text);}}
      }
      const missing=this.app.state().photos.filter(p=>p.missing).length;
      if(missing){const warning=document.createElement('p');warning.className='error-banner';warning.textContent=`${missing} 张原文件缺失或读取失败，判断仍保留。请恢复文件后重新扫描；缺失照片不能复制导出。`;$('.stage').prepend(warning);}
    } else if(this.app.state().demo){$('#save-state').textContent='演示 · 未保存到照片项目';$('#copy-originals').disabled=true;}
    if($('#copy-originals'))$('#copy-originals').disabled=!this.project;
  }
  asset(id,kind){if(!this.project)return null;const p=this.app.state().photos.find(p=>p.id===id);return `/api/projects/${this.project.id}/photos/${id}/${kind}?v=${p?.cacheKey||''}`;}
  save(state){
    if(!this.project){$('#save-state').textContent=this.app.state().demo?'演示 · 仅当前页面':'照片与记录保留在本机';return Promise.resolve();}
    if(this.conflict)return Promise.reject(new Error('自动保存已暂停，请先导出备份，再刷新页面'));
    const pid=this.project.id,snapshot=structuredClone(state);
    const pending=this.queue.then(async()=>{
      if(this.project?.id!==pid)return;
      try{const result=await this.request(`/api/projects/${pid}/state`,{state:snapshot,revision:this.project.revision});this.project.revision=result.revision;$('#save-state').textContent='✓ 判断已保存到本机';}
      catch(e){if(e.status===409){this.conflict=true;this.app.warning(e.message);}$('#save-state').textContent='保存失败 · 请导出备份';throw e;}
    });
    this.queue=pending.catch(()=>{});return pending;
  }
  async flush(){this.app.clearSaveTimer();if(this.project){await this.save(this.app.state());await this.queue;}}
  async open(id){
    if(this.project)await this.flush();
    const project=await this.request(`/api/projects/${id}`);this.project=project;this.conflict=false;this.app.replace(project.state);$('#save-state').textContent='✓ 已恢复本机项目';
    $('#projects-dialog')?.close();$('#copy-originals').disabled=false;
  }
  async showProjects(){
    try{const data=await this.request('/api/projects');this.projects=data.projects;
      $('#project-list').innerHTML=this.projects.length?this.projects.map(p=>`<button class="project-option" data-project="${esc(p.id)}"><strong>${esc(p.name)} <span>${p.count} 张${this.project?.id===p.id?' · 当前':''}</span></strong><small>${esc(p.root)}</small></button>`).join(''):'<p>还没有照片项目，选择一个文件夹开始。</p>';
      $('#project-list').querySelectorAll('button').forEach(b=>b.onclick=()=>this.open(b.dataset.project).catch(e=>this.app.toast(e.message)));$('#projects-dialog').showModal();
    }catch(e){this.app.toast(e.message);}
  }
  showFolder(rescan=false){
    $('#folder-error').textContent='';$('#folder-path').value=rescan?this.project?.root||'':'';$('#recursive').checked=rescan?this.project?.recursive!==false:true;
    const value=String(rescan?this.project?.state.importWorkers??this.importWorkers:this.importWorkers);$('#import-workers').value=['auto','1','2','4','8'].includes(value)?value:'auto';
    $('#folder-dialog').showModal();
    this.request('/api/performance').then(info=>{$('#performance-hint').textContent=`自动建议 ${info.recommendedWorkers} 并行 · ${info.cpuThreads} 个 CPU 线程${info.availableMemoryGiB!==null?' · 当前可用内存约 '+info.availableMemoryGiB+' GB':''}。机械硬盘可先试 1–2 并行。`;}).catch(()=>{});
  }
  async scan(){
    const button=$('#scan-folder');button.disabled=true;
    try{this.importWorkers=$('#import-workers').value||'auto';await this.flush();const {jobId}=await this.request('/api/scan',{path:$('#folder-path').value,recursive:$('#recursive').checked,workers:this.importWorkers});$('#folder-dialog').close();await this.watch(jobId,'scan');}
    catch(e){$('#folder-error').textContent=e.message;this.app.toast(e.message);}finally{button.disabled=false;}
  }
  async watch(id,kind){
    this.task=id;this.app.busy(true);$('#task-title').textContent=kind==='scan'?'读取照片与生成预览':'复制保留的原片';$('#task-result').innerHTML='';$('#close-task').hidden=true;$('#cancel-task').hidden=false;$('#cancel-task').disabled=false;$('#task-file').textContent='准备中…';$('#task-count').textContent='';$('#task-progress').removeAttribute('value');$('#task-dialog').showModal();
    try{
      let job;
      while(true){job=await this.request(`/api/jobs/${id}`);$('#task-file').textContent=job.message;$('#task-progress').max=job.total||1;if(job.total)$('#task-progress').value=job.done;$('#task-count').textContent=`${job.done} / ${job.total||'查找中'}${job.kind==='scan'?` · ${job.workers||1} 并行${job.imagesPerSecond?' · '+job.imagesPerSecond+' 张/秒':''}${job.elapsedSeconds?' · 已用 '+job.elapsedSeconds+' 秒':''}`:''}`;if(job.finished)break;await new Promise(r=>setTimeout(r,400));}
      this.task=null;this.app.busy(false);
      if(kind==='scan'&&!job.error){
        // Scan already flushed and incremented the revision. Don't send the old state back.
        const previousId=this.project?.id;this.project=null;await this.open(job.projectId);
        if(job.added&&(!job.reused||previousId!==job.projectId)&&this.app.state().groups.length===1){this.app.regroup();this.app.render();await this.flush();}
      }
      $('#task-title').textContent=job.error?'任务未完成':job.cancelled?'任务已停止':'已完成';$('#task-file').textContent=job.error||job.message;
      $('#task-result').innerHTML=(kind==='scan'?`<p>新增 ${job.added||0} 张 · 复用 ${job.reused||0} 张预览${job.changed?` · ${job.changed} 张原片已改变，重置为未评`:''}${job.missing?` · 缺失 ${job.missing} 张`:''}</p>`:`<p>目标：${esc(job.destination||'')}</p>`)+(job.errors?.length?`<details open><summary>${job.errors.length} 个文件需要检查</summary><div class="task-errors">${job.errors.map(e=>`<p><strong>${esc(e.file)}</strong><br>${esc(e.reason)}</p>`).join('')}</div></details>`:'');
      $('#cancel-task').hidden=true;$('#close-task').hidden=false;
    }catch(e){this.task=null;this.app.busy(false);$('#task-title').textContent='连接中断';$('#task-file').textContent=e.message;$('#task-result').innerHTML='<p>任务可能仍在运行，请保持启动窗口打开，刷新工作台后检查项目。</p>';$('#cancel-task').hidden=true;$('#close-task').hidden=false;}
  }
  async cancel(){if(!this.task)return;$('#cancel-task').disabled=true;try{await this.request(`/api/jobs/${this.task}/cancel`,{});}catch(e){this.app.toast(e.message);$('#cancel-task').disabled=false;}}
  showExport(){
    if(!this.project){this.app.toast('请先选择照片文件夹；演示插画没有源文件可复制');return;}
    const kept=this.app.state().photos.filter(p=>p.status==='keep');if(!kept.length){this.app.toast('当前没有标为保留的照片');return;}
    $('#copy-summary').textContent=`第 ${this.app.state().round} 轮：保留 ${kept.length} 张，其中 RAW ${kept.filter(p=>p.raw).length} 张${kept.some(p=>p.missing)?'。包含缺失文件，复制时将报告失败。':'。'}`;
    $('#copy-paired').disabled=!kept.some(p=>p.pairedPath);$('#copy-error').textContent='';$('#copy-dialog').showModal();
  }
  async copy(){
    $('#start-copy').disabled=true;
    try{await this.flush();const ids=this.app.state().photos.filter(p=>p.status==='keep').map(p=>p.id);const {jobId}=await this.request(`/api/projects/${this.project.id}/export`,{ids,target:$('#target-path').value,paired:$('#copy-paired').checked,preserve:$('#preserve-paths').checked});$('#copy-dialog').close();await this.watch(jobId,'export');}
    catch(e){$('#copy-error').textContent=e.message;}finally{$('#start-copy').disabled=false;}
  }
  async detail(){
    const p=this.app.selected();if(!p)return;
    $('#detail-title').textContent=p.name;$('#detail-caption').textContent=p.raw?'正在解码 RAW，仅加载这一张…':'正在读取原尺寸…';$('#detail-image').classList.remove('actual-size');$('#detail-dialog').showModal();
    const img=$('#detail-image');img.onload=()=>{$('#detail-caption').textContent=`${img.naturalWidth} × ${img.naturalHeight} · ${p.raw?'RAW 解码 / 相机白平衡':'原尺寸图片'} · 点 100% 检查对焦`;};
    img.onerror=async()=>{try{const result=await fetch(this.asset(p.id,'detail'));const error=await result.json();$('#detail-caption').textContent=error.error||'无法读取细节';}catch{$('#detail-caption').textContent='读取失败，请检查原文件与启动窗口';}};
    img.src=this.asset(p.id,'detail');
  }
  action(name){
    if(!this.enabled)return false;
    if(['import','rescan','projects','reset','original','demo'].includes(name)){
      if(this.task){this.app.toast('请等待或停止当前任务');return true;}
      if(name==='import')this.showFolder();if(name==='rescan')this.showFolder(true);if(name==='projects'||name==='reset')this.showProjects();if(name==='original'){if(this.project)this.detail();else return false;}
      if(name==='demo'){(async()=>{await this.flush();this.project=null;await this.app.clear();await this.app.demo();})().catch(e=>this.app.toast(e.message));}
      return true;
    }return false;
  }
}
