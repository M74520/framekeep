"""Small, dependency-free import concurrency hints; not a hard memory cap."""
import ctypes
import os

def memory_available():
    try:
        if os.name=='nt':
            class Status(ctypes.Structure):
                _fields_=[('length',ctypes.c_ulong),('load',ctypes.c_ulong)]+[(name,ctypes.c_ulonglong) for name in ['total','available','totalPage','availablePage','totalVirtual','availableVirtual','extended']]
            status=Status();status.length=ctypes.sizeof(status)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
                return status.available
        else:
            with open('/proc/meminfo') as source:
                for line in source:
                    if line.startswith('MemAvailable:'):return int(line.split()[1])*1024
    except (OSError,AttributeError,ValueError):pass
    return None

def import_performance():
    cpu=os.cpu_count() or 2;available=memory_available()
    # Leave roughly 2 GiB free; 0.75 GiB per task is a conservative hint for
    # RAW fallback decoding. Embedded JPEG previews commonly use much less.
    memory_tasks=max(1,int((available/1024**3-2)/.75)) if available else 2
    recommended=max(1,min(4,max(1,cpu//2),memory_tasks))
    return {'cpuThreads':cpu,'availableMemoryGiB':round(available/1024**3,1) if available else None,'recommendedWorkers':recommended,'maxWorkers':8}

def resolve_workers(value):
    if value in (None,'auto'):return import_performance()['recommendedWorkers']
    if isinstance(value,bool):raise ValueError('导入并行数量应为 1–8 或 auto')
    try:
        number=int(value)
        if str(number)!=str(value) or not 1<=number<=8:raise ValueError()
    except (TypeError,ValueError):raise ValueError('导入并行数量应为 1–8 或 auto')
    return number
