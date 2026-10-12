"""Framekeep's loopback-only backend. Source photos are read-only; export copies."""
import argparse
import base64
import hashlib
import importlib.util
import json
import mimetypes
import os
from pathlib import Path
import secrets
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, unquote
import webbrowser
os.environ.setdefault('OMP_NUM_THREADS','2')
sys.path.insert(0,str(Path(__file__).resolve().parent))
from imaging import RAW, RASTER, metadata, previews, read_image

ROOT = Path(__file__).resolve().parent.parent
STATUSES = {'pending','keep','reject','unsure'}

def empty_state():
    return dict(schema=1,photos=[],groups=[],candidates={},round=1,history=[],roundIds=[],mode='time',threshold=90,groupId=None,challengerId=None,selectedSide='right',filter='round',demo=False)

def data_directory():
    if os.name == 'nt': base = Path(os.environ.get('LOCALAPPDATA', Path.home()/'AppData'/'Local'))
    elif sys.platform == 'darwin': base = Path.home()/'Library'/'Application Support'
    else: base = Path(os.environ.get('XDG_DATA_HOME', Path.home()/'.local'/'share'))
    return base/'Framekeep'

def choose_folder():
    if os.name == 'nt':
        script = """$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
$owner=New-Object System.Windows.Forms.Form
$owner.TopMost=$true
$owner.ShowInTaskbar=$false
$owner.StartPosition='CenterScreen'
$owner.Size=New-Object System.Drawing.Size(1,1)
$owner.Opacity=0
$d=New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description='Framekeep - Select folder'
try {
    $owner.Show()
    $owner.Activate()
    if($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK){
        [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($d.SelectedPath))
    }
} finally {$d.Dispose();$owner.Dispose()}
"""
        try:
            result = subprocess.run(['powershell.exe','-NoProfile','-STA','-EncodedCommand',base64.b64encode(script.encode('utf-16le')).decode()],capture_output=True,timeout=180,creationflags=0x08000000)
        except subprocess.TimeoutExpired:
            raise ValueError('文件夹选择超时，请重试浏览，或粘贴文件夹完整路径')
        if result.returncode:
            raise ValueError('Windows 文件夹选择器启动失败，请粘贴文件夹完整路径')
        return base64.b64decode(result.stdout.strip()).decode('utf-8') if result.stdout.strip() else ''
    if sys.platform == 'darwin':
        result = subprocess.run(['osascript','-e','POSIX path of (choose folder with prompt "留影：选择照片文件夹")'],capture_output=True,timeout=180)
        return result.stdout.decode().strip() if result.returncode == 0 else ''
    try:
        import tkinter as tk
        from tkinter import filedialog
        window = tk.Tk(); window.withdraw()
        try: return filedialog.askdirectory(title='留影：选择照片文件夹')
        finally: window.destroy()
    except Exception:
        raise ValueError('系统文件夹选择器不可用，请在输入框粘贴文件夹完整路径')

class Store:
    def __init__(self, directory):
        self.directory = Path(directory).resolve(); self.directory.mkdir(parents=True,exist_ok=True)
        self.cache = self.directory/'cache'; self.cache.mkdir(exist_ok=True)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(self.directory/'projects.sqlite3', check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, root TEXT UNIQUE, name TEXT, state TEXT, revision INTEGER DEFAULT 0, updated REAL, recursive INTEGER DEFAULT 1)')
        self.db.execute('CREATE TABLE IF NOT EXISTS photos(project TEXT, id TEXT, record TEXT, PRIMARY KEY(project,id))')
        self.db.commit()
        self.jobs = {}; self.scan_lock = threading.Lock(); self.detail_lock = threading.Lock()

    def query(self, sql, args=()):
        with self.lock: return self.db.execute(sql,args).fetchall()

    def listing(self):
        return [dict(id=r['id'],name=r['name'],root=r['root'],updated=r['updated'],count=len(json.loads(r['state'])['photos']),recursive=bool(r['recursive'])) for r in self.query('SELECT * FROM projects ORDER BY updated DESC')]

    def project(self, pid):
        rows = self.query('SELECT * FROM projects WHERE id=?',(pid,))
        if not rows: raise ValueError('项目不存在，请重新选择文件夹')
        row=rows[0]
        return dict(id=pid,name=row['name'],root=row['root'],state=json.loads(row['state']),revision=row['revision'],recursive=bool(row['recursive']))

    def record(self, pid, photo_id):
        rows=self.query('SELECT record FROM photos WHERE project=? AND id=?',(pid,photo_id))
        if not rows: raise ValueError('照片不存在')
        return json.loads(rows[0][0])

    def source(self, project, record, field='path'):
        root=Path(project['root']).resolve()
        source=(root/record[field]).resolve()
        if not source.is_relative_to(root) or not source.is_file(): raise ValueError('原文件缺失或已经移出照片文件夹，请重新扫描')
        stat=source.stat()
        expected = record.get('pairStat') if field == 'pairedPath' else [record['size'],record['mtimeNs']]
        if expected and [stat.st_size,stat.st_mtime_ns] != expected:
            raise ValueError('原文件已改变，请重新扫描后再预览或导出')
        return source

    def save_state(self, pid, state, revision):
        if not isinstance(state,dict) or state.get('schema') != 1: raise ValueError('筛选记录格式无效')
        with self.lock:
            project=self.project(pid)
            if revision != project['revision']: raise Conflict('另一页面已修改项目，请刷新后继续。当前页面可先导出进度备份。')
            if any(j.get('projectId') == pid and j['kind']=='scan' and not j['finished'] for j in self.jobs.values()): raise Conflict('正在扫描，请稍后保存')
            records={r['id']:json.loads(r['record']) for r in self.query('SELECT id,record FROM photos WHERE project=?',(pid,))}
            items=state.get('photos',[])
            if len(items)!=len(records) or set(p['id'] for p in items)!=set(records): raise ValueError('照片列表不一致，请刷新项目')
            for p in items:
                if p.get('status') not in STATUSES: raise ValueError('照片状态无效')
                p.update(records[p['id']])
            ids=set(records)
            grouped=[]
            for g in state.get('groups',[]):
                if not isinstance(g.get('name'),str) or len(g['name'])>100: raise ValueError('分组名称无效')
                if not isinstance(g.get('id'),str) or len(g['id'])>100: raise ValueError('分组标识无效')
                grouped.extend(g['ids'])
            if len(grouped)!=len(ids) or set(grouped)!=ids: raise ValueError('每张照片必须且只能属于一个分组')
            if not set(state.get('roundIds',[])) <= ids: raise ValueError('轮次中存在未知照片')
            group_map={g['id']:set(g['ids']) for g in state['groups']}
            if any(k not in group_map or not set(v)<=group_map[k] for k,v in state.get('candidates',{}).items()): raise ValueError('候选与分组不一致')
            state['demo']=False
            self.db.execute('UPDATE projects SET state=?,revision=revision+1,updated=? WHERE id=?',(json.dumps(state,ensure_ascii=False),time.time(),pid)); self.db.commit()
            return project['revision']+1

    def job(self, kind, target, **kwargs):
        with self.lock:
            active=[j for j in self.jobs.values() if not j['finished']]
            if active: raise ValueError('请先等待或取消当前任务')
            jid=secrets.token_hex(12)
            job=dict(id=jid,kind=kind,finished=False,cancelled=False,done=0,total=0,message='准备中…',errors=[],**kwargs)
            self.jobs[jid]=job
        def run():
            try: target(job)
            except Exception as exc:
                job['error']=str(exc); traceback.print_exc()
            finally:
                job['finished']=True
                if job['cancelled']: job['message']='已停止，已完成的内容保留'
        threading.Thread(target=run,daemon=True).start()
        return jid

    def start_scan(self, folder, recursive=True):
        root=Path(folder.strip().strip('"')).expanduser().resolve()
        if not root.is_dir(): raise ValueError('文件夹不存在，请输入本机的完整路径')
        if root == self.directory or root.is_relative_to(self.directory): raise ValueError('请选择照片文件夹，而不是程序缓存文件夹')
        pid=hashlib.sha256(os.path.normcase(str(root)).encode()).hexdigest()[:24]
        with self.lock:
            if not self.query('SELECT id FROM projects WHERE id=?',(pid,)):
                self.db.execute('INSERT INTO projects VALUES(?,?,?,?,?,?,?)',(pid,str(root),root.name,json.dumps(empty_state()),0,time.time(),int(recursive)));self.db.commit()
        return self.job('scan',lambda j:self.scan(j,root,pid,recursive),projectId=pid)

    def scan(self, job, root, pid, recursive):
        # Sequential processing bounds memory and keeps culling fast after the initial scan.
        all_files={}; job['message']='正在查找照片…'
        for directory, dirs, files in os.walk(root,followlinks=False):
            dirs[:]=sorted(d for d in dirs if not (Path(directory)/d).is_symlink() and (Path(directory)/d).resolve() != self.directory)
            for name in sorted(files):
                if job['cancelled']: return
                path=Path(directory)/name
                if path.suffix.lower() not in RAW|RASTER or path.is_symlink(): continue
                try:
                    if path.resolve().is_relative_to(root): all_files[path.relative_to(root).as_posix()]=path
                except OSError: pass
            if not recursive: break
        project=self.project(pid); previous=project['state']; old={p['id']:p for p in previous['photos']}
        old_records={r['id']:json.loads(r['record']) for r in self.query('SELECT id,record FROM photos WHERE project=?',(pid,))}
        pairs={}
        for relative,path in all_files.items():
            if path.suffix.lower() in {'.jpg','.jpeg'}: pairs.setdefault(str(Path(relative).with_suffix('')).casefold(),relative)
        skip={r['pairedPath'] for r in old_records.values() if r.get('pairedPath')}; raw_pairs={}
        for relative,path in all_files.items():
            if path.suffix.lower() in RAW:
                paired=pairs.get(str(Path(relative).with_suffix('')).casefold())
                if paired: raw_pairs[relative]=paired;skip.add(paired)
        files=[(rel,p) for rel,p in all_files.items() if rel not in skip]
        job['total']=len(files)
        successful={}; added=[]; job['reused']=0
        for relative,path in files:
            if job['cancelled']: break
            photo_id=hashlib.sha256(relative.encode()).hexdigest()[:24]
            job['message']=relative
            try:
                stat=path.stat(); pair=raw_pairs.get(relative)
                pair_stat=all_files[pair].stat() if pair else None
                fingerprint=f'{relative}|{stat.st_size}|{stat.st_mtime_ns}|{pair_stat.st_size if pair else 0}|{pair_stat.st_mtime_ns if pair else 0}'
                key=hashlib.sha256(fingerprint.encode()).hexdigest()
                cache=self.cache/pid/photo_id/key
                if old_records.get(photo_id,{}).get('cacheKey')==key and (cache/'preview.jpg').exists() and (cache/'thumb.jpg').exists():
                    record=old_records[photo_id]; job['reused']+=1
                else:
                    meta=metadata(path)
                    info=previews(path,cache,meta,all_files[pair] if pair else None)
                    record=dict(id=photo_id,name=path.name,path=relative,size=stat.st_size,mtimeNs=stat.st_mtime_ns,lastModified=stat.st_mtime_ns//1_000_000,
                        key=f'{relative}|{stat.st_size}|{stat.st_mtime_ns//1_000_000}',cacheKey=key,time=meta.get('time',stat.st_mtime_ns//1_000_000),timeSource='exif' if meta.get('time') else 'modified',
                        camera=meta.get('model',''),raw=path.suffix.lower() in RAW,pairedPath=pair,pairStat=[pair_stat.st_size,pair_stat.st_mtime_ns] if pair else None,**info)
                successful[photo_id]=record
                if photo_id not in old: added.append(photo_id)
            except Exception as exc:
                job['errors'].append({'file':relative,'reason':str(exc)})
            job['done']+=1
        # Keep missing/failed previous photos recoverable, with explicit availability markers.
        merged=[]; changed_ids=set()
        for p in previous['photos']:
            record=successful.pop(p['id'],None)
            changed=record and (record['size'],record['mtimeNs']) != (p['size'],p['mtimeNs'])
            merged.append({**p,**(record or {}),'missing':record is None,**({'status':'pending','roundIncluded':True} if changed else {})})
            if changed: changed_ids.add(p['id'])
        for record in successful.values(): merged.append({**record,'status':'pending','roundIncluded':True,'missing':False})
        known=set(p['id'] for p in merged)
        previous['photos']=merged
        new_ids=[p['id'] for p in merged if p['id'] not in old]
        previous['roundIds']=list(dict.fromkeys([i for i in previous['roundIds'] if i in known]+new_ids+list(changed_ids)))
        previous['candidates']={g:[i for i in candidates if i not in changed_ids] for g,candidates in previous['candidates'].items()}
        if (new_ids or changed_ids) and isinstance(previous.get('grid'),dict):
            # Old checkmarks/page positions must not silently select changed files.
            previous['grid']['sessions']={}
        if new_ids:
            previous['groups'].append({'id':'import-'+secrets.token_hex(6),'name':'新导入照片','ids':new_ids})
        previous['demo']=False
        all_records={p['id']:{k:v for k,v in p.items() if k not in {'status','roundIncluded','missing'}} for p in merged}
        with self.lock:
            self.db.execute('UPDATE projects SET state=?,revision=revision+1,updated=?,recursive=? WHERE id=?',(json.dumps(previous,ensure_ascii=False),time.time(),int(recursive),pid))
            for photo_id,record in all_records.items():
                self.db.execute('INSERT OR REPLACE INTO photos VALUES(?,?,?)',(pid,photo_id,json.dumps(record,ensure_ascii=False)))
            self.db.commit()
        job.update(added=len(new_ids),changed=len(changed_ids),missing=sum(p['missing'] for p in merged),count=len(merged),message=f'已读取 {len(merged)} 张照片')

    def image(self, pid, photo_id, kind):
        project=self.project(pid); record=self.record(pid,photo_id)
        folder=self.cache/pid/photo_id/record['cacheKey']
        file=folder/(kind+'.jpg')
        if kind not in {'thumb','preview','detail'}: raise ValueError('预览类型无效')
        if kind=='detail': source=self.source(project,record)
        if kind=='detail' and not file.exists():
            with self.detail_lock:
                if not file.exists():
                    image,_=read_image(source,metadata(source),full=True)
                    image.save(file,'JPEG',quality=93);image.close()
                    # Only keep two full-size detail images across projects.
                    details=sorted(self.cache.glob('*/*/*/detail.jpg'),key=lambda p:p.stat().st_mtime,reverse=True)
                    for stale in details[2:]: stale.unlink(missing_ok=True)
        if not file.exists(): raise ValueError('预览缺失，请重新扫描文件夹')
        return file

    def start_export(self,pid,target,photo_ids,paired=False,preserve=True):
        project=self.project(pid)
        kept={p['id'] for p in project['state']['photos'] if p['status']=='keep'}
        if not photo_ids or set(photo_ids)!=kept: raise ValueError('保留照片已改变，请重新打开导出窗口')
        destination=Path(target.strip().strip('"')).expanduser().resolve()
        root=Path(project['root']).resolve()
        if destination==root or destination.is_relative_to(root): raise ValueError('导出文件夹需位于原片文件夹之外，避免再次导入副本')
        if destination==self.directory or destination.is_relative_to(self.directory): raise ValueError('不能导出到程序缓存文件夹')
        copies=[]
        for photo_id in sorted(kept):
            record=self.record(pid,photo_id);copies.append((record,False))
            if paired and record.get('pairedPath'): copies.append((record,True))
        return self.job('export',lambda j:self.copy(j,project,copies,destination,preserve),projectId=pid)

    def copy(self,job,project,copies,destination,preserve):
        destination.mkdir(parents=True,exist_ok=True)
        job.update(total=len(copies),copied=0,skipped=0,destination=str(destination))
        report=[]
        for record,is_pair in copies:
            if job['cancelled']: break
            relative=record['pairedPath'] if is_pair else record['path']; job['message']=relative
            target=destination/(relative if preserve else Path(relative).name)
            status='copied'; temp=None
            try:
                source=self.source(project,record,'pairedPath' if is_pair else 'path')
                target.parent.mkdir(parents=True,exist_ok=True)
                if not target.resolve().is_relative_to(destination): raise ValueError('目标路径越过导出文件夹')
                if target.exists():
                    job['skipped']+=1; status='skipped-existing'
                else:
                    temp=target.with_name('.'+target.name+'.framekeep-'+job['id']+'.part')
                    with source.open('rb') as incoming, temp.open('xb') as outgoing:
                        while True:
                            if job['cancelled']: break
                            chunk=incoming.read(4*1024*1024)
                            if not chunk: break
                            outgoing.write(chunk)
                    if job['cancelled']:
                        status='cancelled';break
                    self.source(project,record,'pairedPath' if is_pair else 'path')
                    shutil.copystat(source,temp)
                    # Exclusive create prevents accidental overwrites even if another app races us.
                    try:
                        os.link(temp,target)
                    except FileExistsError:
                        job['skipped']+=1;status='skipped-existing'
                    except OSError:
                        # FAT / some removable disks do not support hard links.
                        created=False
                        try:
                            with target.open('xb') as output, temp.open('rb') as incoming:
                                created=True
                                shutil.copyfileobj(incoming,output,4*1024*1024)
                        except FileExistsError:
                            job['skipped']+=1;status='skipped-existing'
                        except Exception:
                            if created: target.unlink(missing_ok=True)
                            raise
                    if status=='copied': shutil.copystat(temp,target);job['copied']+=1
            except Exception as exc:
                status='error';job['errors'].append({'file':relative,'reason':str(exc)})
            finally:
                if temp: temp.unlink(missing_ok=True)
                report.append({'source':relative,'target':str(target),'status':status});job['done']+=1
        report_file=destination/f'Framekeep-export-{time.strftime("%Y%m%d-%H%M%S")}-{job["id"][:6]}.json'
        report_file.write_text(json.dumps({'round':project['state']['round'],'cancelled':job['cancelled'],'files':report,'errors':job['errors']},ensure_ascii=False,indent=2),encoding='utf-8')
        job['message']=f'复制 {job["copied"]} 个文件，跳过 {job["skipped"]} 个已有文件'

class Conflict(Exception): pass

class Handler(BaseHTTPRequestHandler):
    def log_message(self,format,*args): pass
    def send(self,status,value,content_type='application/json; charset=utf-8',cookie=False):
        data=json.dumps(value,ensure_ascii=False).encode() if isinstance(value,(dict,list)) else value
        self.send_response(status);self.send_header('Content-Type',content_type);self.send_header('Content-Length',str(len(data)))
        self.send_header('X-Content-Type-Options','nosniff');self.send_header('Referrer-Policy','no-referrer');self.send_header('Cache-Control','no-store' if content_type.startswith(('application/json','text/html')) else 'private, max-age=3600')
        if cookie:self.send_header('Set-Cookie',f'framekeep={self.server.token}; HttpOnly; SameSite=Strict; Path=/')
        self.end_headers()
        try:self.wfile.write(data)
        except (BrokenPipeError,ConnectionResetError):pass

    def allowed(self,api=False,mutation=False):
        origin=f'http://127.0.0.1:{self.server.server_port}'
        host=self.headers.get('Host','')
        if host != f'127.0.0.1:{self.server.server_port}': raise PermissionError('请使用启动窗口显示的本机地址')
        supplied=self.headers.get('Origin')
        if supplied and supplied!=origin:raise PermissionError('只接受本机工作台请求')
        if api and f'framekeep={self.server.token}' not in self.headers.get('Cookie','').split('; '):raise PermissionError('请重新打开本机工作台')
        if mutation and self.headers.get('X-Framekeep-Token')!=self.server.token:raise PermissionError('请求验证失败，请刷新页面')

    def do_GET(self):
        try:
            path=unquote(urlsplit(self.path).path);self.allowed(api=path.startswith('/api/') and path!='/api/bootstrap')
            store=self.server.store;parts=path.strip('/').split('/')
            if path=='/api/bootstrap': return self.send(200,{'token':self.server.token,'projects':store.listing(),'dataDir':str(store.directory),'rawDecode':importlib.util.find_spec('rawpy') is not None},cookie=True)
            if path=='/api/projects': return self.send(200,{'projects':store.listing()})
            if len(parts)==3 and parts[:2]==['api','projects']:return self.send(200,store.project(parts[2]))
            if len(parts)==3 and parts[:2]==['api','jobs']:
                with store.lock:job=dict(store.jobs.get(parts[2],{}))
                if not job:raise ValueError('任务不存在')
                return self.send(200,job)
            if len(parts)==6 and parts[:2]==['api','projects'] and parts[3]=='photos':
                file=store.image(parts[2],parts[4],parts[5]);return self.send(200,file.read_bytes(),'image/jpeg')
            file=(ROOT/'public'/('index.html' if path=='/' else path.lstrip('/'))).resolve()
            if not file.is_relative_to(ROOT/'public') or not file.is_file():return self.send(404,{'error':'页面不存在'})
            body=file.read_bytes()
            if file.name=='index.html':body=body.replace(b'<head>',b'<head><meta name="framekeep-local" content="1">')
            mime=mimetypes.guess_type(str(file))[0] or 'application/octet-stream'
            if file.suffix in {'.js','.mjs'}:mime='application/javascript'
            return self.send(200,body,mime+'; charset=utf-8' if mime.startswith(('text/','application/javascript')) else mime)
        except PermissionError as exc:self.send(403,{'error':str(exc)})
        except (ValueError,OSError) as exc:self.send(400,{'error':str(exc)})
        except Exception:traceback.print_exc();self.send(500,{'error':'本机服务发生错误，请查看启动窗口'})

    def do_POST(self):
        try:
            self.allowed(api=True,mutation=True)
            length=int(self.headers.get('Content-Length',0))
            if length>32*1024*1024:raise ValueError('请求过大')
            body=json.loads(self.rfile.read(length) or b'{}')
            path=urlsplit(self.path).path;parts=path.strip('/').split('/');store=self.server.store
            if path=='/api/choose-folder':return self.send(200,{'path':choose_folder()})
            if path=='/api/scan':return self.send(200,{'jobId':store.start_scan(str(body.get('path','')),bool(body.get('recursive',True)))})
            if len(parts)==4 and parts[:2]==['api','projects']:
                if parts[3]=='state':return self.send(200,{'revision':store.save_state(parts[2],body['state'],body['revision'])})
                if parts[3]=='export':return self.send(200,{'jobId':store.start_export(parts[2],str(body.get('target','')),body.get('ids',[]),bool(body.get('paired')),bool(body.get('preserve',True)))})
            if len(parts)==4 and parts[:2]==['api','jobs'] and parts[3]=='cancel':
                job=store.jobs.get(parts[2])
                if not job:raise ValueError('任务不存在')
                job['cancelled']=True;return self.send(200,{'ok':True})
            self.send(404,{'error':'接口不存在'})
        except Conflict as exc:self.send(409,{'error':str(exc)})
        except PermissionError as exc:self.send(403,{'error':str(exc)})
        except (ValueError,OSError,KeyError,TypeError) as exc:self.send(400,{'error':str(exc)})
        except Exception:traceback.print_exc();self.send(500,{'error':'本机服务发生错误，请查看启动窗口'})

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--port',type=int,default=0);parser.add_argument('--data-dir');parser.add_argument('--no-browser',action='store_true');args=parser.parse_args()
    store=Store(args.data_dir or data_directory())
    server=ThreadingHTTPServer(('127.0.0.1',args.port),Handler);server.daemon_threads=True;server.store=store;server.token=secrets.token_urlsafe(32)
    url=f'http://127.0.0.1:{server.server_port}'
    print(f'FRAMEKEEP_URL={url}',flush=True)
    print('Keep this window open while culling. Ctrl+C stops the server. Your photos stay unchanged.',flush=True)
    if not args.no_browser:webbrowser.open(url)
    try:server.serve_forever()
    except KeyboardInterrupt:pass
    finally:server.server_close();store.db.close()

if __name__=='__main__':main()
