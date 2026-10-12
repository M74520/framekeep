"""Reproducible synthetic JPEG import benchmark; no user photos are read."""
import ctypes
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'local'))

def peak_memory_mib():
    if os.name!='nt':return None
    class Counters(ctypes.Structure):
        _fields_=[('cb',ctypes.c_ulong),('faults',ctypes.c_ulong)]+[(name,ctypes.c_size_t) for name in ['peak','working','peakPaged','paged','peakNonPaged','nonPaged','pagefile','peakPagefile']]
    counters=Counters();counters.cb=ctypes.sizeof(counters)
    ctypes.windll.kernel32.GetCurrentProcess.restype=ctypes.c_void_p
    handle=ctypes.windll.kernel32.GetCurrentProcess()
    if ctypes.windll.psapi.GetProcessMemoryInfo(ctypes.c_void_p(handle),ctypes.byref(counters),counters.cb):return round(counters.peak/1024**2,1)
    return None

def worker(base,workers):
    from server import Store
    store=Store(Path(base)/('cache-'+str(workers)))
    try:
        jid=store.start_scan(str(Path(base)/'photos'),workers=workers)
        while not store.jobs[jid]['finished']:time.sleep(.02)
        job=store.jobs[jid]
        assert not job.get('error') and not job['errors'] and job['count']==1000,job
        result={'workers':workers,'elapsedSeconds':job['elapsedSeconds'],'imagesPerSecond':job['imagesPerSecond'],'peakWorkingSetMiB':peak_memory_mib()}
        jid=store.start_scan(str(Path(base)/'photos'),workers=workers)
        while not store.jobs[jid]['finished']:time.sleep(.01)
        assert store.jobs[jid]['reused']==1000
        result['cachedRescanSeconds']=store.jobs[jid]['elapsedSeconds']
        print(json.dumps(result))
    finally:store.db.close()

def main():
    from PIL import Image
    from performance import import_performance
    with tempfile.TemporaryDirectory(prefix='framekeep-import-bench-') as temp:
        source=Path(temp)/'photos';source.mkdir();image=Image.effect_noise((1200,1800),35).convert('RGB')
        first=source/'0000.jpg';image.save(first,'JPEG',quality=78);image.close()
        for i in range(1,1000):
            try:os.link(first,source/f'{i:04}.jpg')
            except OSError:(source/f'{i:04}.jpg').write_bytes(first.read_bytes())
        report={'input':'1000 synthetic noisy JPEGs, 1200x1800, identical source pixels via hardlinks; not a real-camera RAW benchmark','bytesPerImage':first.stat().st_size,'machine':import_performance(),'results':[]}
        for workers in [1,2,4]:
            completed=subprocess.run([sys.executable,__file__,'worker',temp,str(workers)],capture_output=True,text=True,check=True,timeout=600)
            result=json.loads(completed.stdout);report['results'].append(result);print(json.dumps(result),flush=True)
        output=Path(__file__).resolve().parent.parent/'artifacts'/'import-benchmark.json';output.parent.mkdir(exist_ok=True);output.write_text(json.dumps(report,indent=2),encoding='utf-8')
        print('REPORT='+str(output),flush=True)

if __name__=='__main__':
    if len(sys.argv)>1 and sys.argv[1]=='worker':worker(sys.argv[2],int(sys.argv[3]))
    else:main()
