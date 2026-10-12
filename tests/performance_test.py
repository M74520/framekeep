from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'local'))
import server
import performance
from PIL import Image

def finish(store,jid):
    deadline=time.monotonic()+15
    while not store.jobs[jid]['finished']:
        if time.monotonic()>deadline:raise AssertionError('Scan timed out')
        time.sleep(.01)
    job=store.jobs[jid]
    if job.get('error'):raise AssertionError(job['error'])
    return job

class ImportPerformance(unittest.TestCase):
    def test_recommendation_and_explicit_bounds(self):
        with patch.object(performance.os,'cpu_count',return_value=8),patch.object(performance,'memory_available',return_value=32*1024**3):
            self.assertEqual(performance.resolve_workers('auto'),4)
        with patch.object(performance,'memory_available',return_value=1024**3):self.assertEqual(performance.resolve_workers('auto'),1)
        for value in [1,2,4,8,'4']:self.assertEqual(performance.resolve_workers(value),int(value))
        for value in [0,9,True,1.5,'oops',{}]:
            with self.assertRaises(ValueError):performance.resolve_workers(value)

    def fixture(self,root):
        source=root/'photos';source.mkdir()
        for i in range(12):Image.new('RGB',(48,72),(i*10,80,100)).save(source/f'{i:02}.jpg')
        return source

    def test_parallel_bound_order_and_cache_reuse(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);source=self.fixture(root);store=server.Store(root/'data')
            original=server.previews;lock=threading.Lock();counts={'active':0,'peak':0}
            def preview(*args):
                with lock:counts['active']+=1;counts['peak']=max(counts['peak'],counts['active'])
                try:time.sleep(.02);return original(*args)
                finally:
                    with lock:counts['active']-=1
            try:
                with patch.object(server,'previews',side_effect=preview):job=finish(store,store.start_scan(str(source),workers=4))
                self.assertEqual(counts['peak'],4);self.assertEqual(job['done'],12);self.assertEqual(job['workers'],4)
                project=store.project(job['projectId']);self.assertEqual([p['name'] for p in project['state']['photos']],[f'{i:02}.jpg' for i in range(12)])
                self.assertEqual(project['state']['importWorkers'],4)
                with patch.object(server,'previews',side_effect=AssertionError('cache should be reused')):
                    cached=finish(store,store.start_scan(str(source),workers=8))
                self.assertEqual(cached['reused'],12);self.assertEqual(cached['errors'],[])
            finally:store.db.close()

    def test_cancel_drains_only_current_batch_and_rejects_duplicate_scan(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);source=self.fixture(root);store=server.Store(root/'data')
            original=server.previews;ready=threading.Event();release=threading.Event();lock=threading.Lock();calls=[]
            def preview(*args):
                with lock:
                    calls.append(args[0]);
                    if len(calls)==4:ready.set()
                if not release.wait(5):raise AssertionError('release timed out')
                return original(*args)
            try:
                with patch.object(server,'previews',side_effect=preview):
                    jid=store.start_scan(str(source),workers=4)
                    self.assertTrue(ready.wait(5))
                    with self.assertRaises(server.Conflict):store.start_scan(str(source),workers=4)
                    store.jobs[jid]['cancelled']=True;release.set();job=finish(store,jid)
                self.assertEqual(len(calls),4);self.assertEqual(job['done'],4);self.assertEqual(job['count'],4)
                self.assertEqual(len(store.project(job['projectId'])['state']['photos']),4)
            finally:release.set();store.db.close()

if __name__=='__main__':unittest.main()
