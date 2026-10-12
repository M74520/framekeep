"""Integration checks use temporary sources and exercise the actual local HTTP API."""
import copy
import hashlib
import io
import json
from pathlib import Path
import struct
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
import urllib.error
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'local'))
from server import Store, Handler, ThreadingHTTPServer, Conflict
from imaging import embedded_jpeg, metadata, previews
from PIL import Image

def sample_arw(path, orientation=6):
    """TIFF/EXIF/JPEG fixture, not a real sensor RAW. No third-party photo is shipped."""
    image=Image.new('RGB',(900,600),'#8f6c97');buf=io.BytesIO();image.save(buf,'JPEG');jpeg=buf.getvalue()
    model=b'ILCE-7CM2\0';date=b'2026:10:10 14:30:20\0'
    count=6;end=8+2+count*12+4;model_at=end;date_at=model_at+len(model);jpeg_at=date_at+len(date)
    entries=[(272,2,len(model),model_at),(274,3,1,orientation),(36867,2,len(date),date_at),(513,4,1,jpeg_at),(514,4,1,len(jpeg)),(256,4,1,900)]
    output=b'II'+struct.pack('<HI',42,8)+struct.pack('<H',count)
    for tag,typ,n,val in entries:output+=struct.pack('<HHII',tag,typ,n,val)
    output+=b'\0'*4+model+date+jpeg+b'\x00sensor-placeholder\x00'*100
    path.write_bytes(output)

def wait(store,jid):
    deadline=time.monotonic()+20
    while not store.jobs[jid]['finished']:
        if time.monotonic()>deadline:raise AssertionError('Job timed out')
        time.sleep(.01)
    job=store.jobs[jid]
    if job.get('error'):raise AssertionError(job['error'])
    return job

class LocalIntegration(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.base=Path(self.tmp.name);self.source=self.base/'源照片';self.source.mkdir()
        self.store=Store(self.base/'app-data')
        sample_arw(self.source/'DSC0001.ARW')
        Image.new('RGB',(900,600),'#8f6c97').save(self.source/'DSC0001.JPG')
        Image.new('RGB',(800,1200),'green').save(self.source/'DSC0002.jpg')
        (self.source/'子目录').mkdir();Image.new('RGB',(640,480),'blue').save(self.source/'子目录'/'DSC0002.jpg')
        (self.source/'broken.arw').write_bytes(b'not-a-raw')
        self.originals={p.relative_to(self.source).as_posix():(hashlib.sha256(p.read_bytes()).hexdigest(),p.stat().st_mtime_ns) for p in self.source.rglob('*') if p.is_file()}

    def tearDown(self):
        for relative,(digest,mtime) in self.originals.items():
            path=self.source/relative
            if path.exists():self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(),digest);self.assertEqual(path.stat().st_mtime_ns,mtime)
        self.store.db.close();self.tmp.cleanup()

    def scan(self,recursive=True):
        job=wait(self.store,self.store.start_scan(str(self.source),recursive));return self.store.project(job['projectId']),job

    def test_arw_embedded_metadata_rotation_and_pair(self):
        meta=metadata(self.source/'DSC0001.ARW');self.assertEqual(meta['model'],'ILCE-7CM2');self.assertEqual(meta['orientation'],6);self.assertGreater(meta['time'],0)
        blob=embedded_jpeg(self.source/'DSC0001.ARW');self.assertTrue(blob.startswith(b'\xff\xd8'))
        project,job=self.scan();self.assertEqual(job['count'],3);self.assertEqual(len(job['errors']),1)
        raw=next(p for p in project['state']['photos'] if p['raw']);self.assertEqual(raw['pairedPath'],'DSC0001.JPG');self.assertEqual((raw['width'],raw['height']),(600,900));self.assertEqual(raw['previewSource'],'RAW 内嵌 JPEG')
        with Image.open(self.store.image(project['id'],raw['id'],'thumb')) as image:self.assertLessEqual(max(image.size),260)

    def test_fallback_jpeg_search_skips_nested_thumbnail(self):
        thumb=io.BytesIO();Image.new('RGB',(20,20),'red').save(thumb,'JPEG')
        main=io.BytesIO();Image.new('RGB',(1200,800),'blue').save(main,'JPEG')
        # An APP1 payload containing another SOI/EOI must not truncate the main JPEG.
        payload=b'Exif\0\0'+thumb.getvalue()
        image=main.getvalue()
        image=image[:2]+b'\xff\xe1'+struct.pack('>H',len(payload)+2)+payload+image[2:]
        path=self.base/'fallback.arw';path.write_bytes(b'II'+b'\0'*26+image)
        blob=embedded_jpeg(path)
        with Image.open(io.BytesIO(blob)) as im:self.assertEqual(im.size,(1200,800));im.load()

    def test_save_revision_reopen_rescan_missing_recovery(self):
        project,job=self.scan();pid=project['id'];state=project['state'];photo=state['photos'][0];photo['status']='keep';state['candidates'][state['groups'][0]['id']]=[photo['id']]
        revision=self.store.save_state(pid,state,project['revision'])
        with self.assertRaises(Conflict):self.store.save_state(pid,state,project['revision'])
        current=self.store.project(pid);self.assertEqual(current['revision'],revision)
        current,job=self.scan();self.assertEqual(job['reused'],3);self.assertEqual(next(p for p in current['state']['photos'] if p['id']==photo['id'])['status'],'keep')
        original=self.source/photo['path'];moved=self.base/'moved';original.rename(moved)
        current,job=self.scan();self.assertEqual(job['missing'],1);self.assertTrue(next(p for p in current['state']['photos'] if p['id']==photo['id'])['missing'])
        moved.rename(original);current,job=self.scan();self.assertEqual(job['missing'],0)
        second=Store(self.base/'app-data');self.assertEqual(second.project(pid)['state'],current['state']);second.db.close()

    def test_copy_raw_pairs_paths_duplicates_and_conflict_protection(self):
        project,_=self.scan();pid=project['id'];state=project['state']
        for p in state['photos']:p['status']='keep'
        self.store.save_state(pid,state,project['revision']);ids=[p['id'] for p in state['photos']]
        target=self.base/'导出';job=wait(self.store,self.store.start_export(pid,str(target),ids,paired=True));self.assertEqual(job['copied'],4)
        for relative in ['DSC0001.ARW','DSC0001.JPG','DSC0002.jpg','子目录/DSC0002.jpg']:self.assertEqual((target/relative).read_bytes(),(self.source/relative).read_bytes())
        (target/'DSC0002.jpg').write_bytes(b'user-edited-file')
        job=wait(self.store,self.store.start_export(pid,str(target),ids,paired=True));self.assertEqual(job['skipped'],4);self.assertEqual((target/'DSC0002.jpg').read_bytes(),b'user-edited-file')
        with self.assertRaises(ValueError):self.store.start_export(pid,str(self.source/'export'),ids)
        with self.assertRaises(ValueError):self.store.start_export(pid,str(target),ids[:1])
        self.assertTrue(list(target.glob('Framekeep-export-*.json')));self.assertFalse(list(target.rglob('*.part')))

    def test_recursive_choice_source_changes_and_symlink(self):
        outside=self.base/'outside.jpg';Image.new('RGB',(20,20)).save(outside)
        try:(self.source/'link.jpg').symlink_to(outside)
        except OSError:pass
        project,job=self.scan(False);self.assertEqual(job['count'],2)
        photo=next(p for p in project['state']['photos'] if not p['raw']);record=self.store.record(project['id'],photo['id']);self.source.joinpath(photo['path']).write_bytes(b'changed')
        del self.originals[photo['path']]
        with self.assertRaises(ValueError):self.store.source(project,record)

    def test_http_security_real_routes_and_detail(self):
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler);server.store=self.store;server.token='test-only-token';server.daemon_threads=True
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start();url=f'http://127.0.0.1:{server.server_port}'
        def request(path,body=None,headers=None):
            h={'Cookie':'framekeep=test-only-token','X-Framekeep-Token':'test-only-token','Content-Type':'application/json',**(headers or {})}
            req=urllib.request.Request(url+path,data=None if body is None else json.dumps(body).encode(),headers=h)
            return urllib.request.urlopen(req,timeout=10)
        try:
            with request('/') as response:self.assertIn(b'framekeep-local',response.read())
            with request('/api/bootstrap') as response:self.assertEqual(json.load(response)['token'],server.token)
            with self.assertRaises(urllib.error.HTTPError) as ctx:request('/api/projects',headers={'Cookie':''})
            self.assertEqual(ctx.exception.code,403)
            with self.assertRaises(urllib.error.HTTPError) as ctx:request('/api/scan',{'path':str(self.source)},headers={'Origin':'https://evil.test'})
            self.assertEqual(ctx.exception.code,403)
            with self.assertRaises(urllib.error.HTTPError) as ctx:request('/api/scan',{'path':str(self.source)},headers={'X-Framekeep-Token':''})
            self.assertEqual(ctx.exception.code,403)
            with request('/api/scan',{'path':str(self.source)}) as response:jid=json.load(response)['jobId']
            job=wait(self.store,jid);pid=job['projectId']
            with request('/api/projects/'+pid) as response:project=json.load(response)
            photo=next(p for p in project['state']['photos'] if not p['raw'])
            with request(f'/api/projects/{pid}/photos/{photo["id"]}/detail') as response:
                with Image.open(io.BytesIO(response.read())) as image:self.assertEqual(image.size,(800,1200))
            with self.assertRaises(urllib.error.HTTPError):request('/api/projects',headers={'Host':'evil.test'})
        finally:server.shutdown();server.server_close();thread.join()

    def test_changed_source_resets_judgement_and_candidate(self):
        project,_=self.scan();state=project['state'];photo=next(p for p in state['photos'] if not p['raw'])
        photo['status']='keep';gid=state['groups'][0]['id'];state['candidates'][gid]=[photo['id']]
        state['grid']={'view':'grid','size':8,'sessions':{'old':{'page':2,'picks':[photo['id']]}}}
        self.store.save_state(project['id'],state,project['revision'])
        path=self.source/photo['path'];Image.new('RGB',(800,1200),'yellow').save(path)
        del self.originals[photo['path']]
        project,job=self.scan();self.assertEqual(job['changed'],1)
        changed=next(p for p in project['state']['photos'] if p['id']==photo['id']);self.assertEqual(changed['status'],'pending')
        self.assertNotIn(photo['id'],project['state']['candidates'][gid])
        self.assertEqual(project['state']['grid'],{'view':'grid','size':8,'sessions':{}})

    def test_cancel_does_not_lose_prior_decisions(self):
        project,_=self.scan();state=project['state'];state['photos'][0]['status']='unsure';self.store.save_state(project['id'],state,project['revision'])
        jid=self.store.start_scan(str(self.source));self.store.jobs[jid]['cancelled']=True;wait(self.store,jid)
        restored=self.store.project(project['id']);self.assertEqual(restored['state']['photos'][0]['status'],'unsure')

if __name__=='__main__':unittest.main(verbosity=2)
