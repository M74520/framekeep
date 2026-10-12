"""Read-only image previews. RAW files are never rewritten."""
import io
import mmap
import struct
import datetime
from pathlib import Path
from PIL import Image, ImageOps

RAW = {'.arw', '.dng', '.nef', '.cr2', '.cr3', '.raf', '.rw2', '.orf', '.pef', '.srw'}
RASTER = {'.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff'}

def tiff_metadata(data):
    """Bounded TIFF directory traversal; supports Sony ARW's EXIF and JPEG IFD."""
    if data[:2] not in (b'II', b'MM'):
        return {}, []
    endian = '<' if data[:2] == b'II' else '>'
    def u16(at): return struct.unpack_from(endian + 'H', data, at)[0]
    def u32(at): return struct.unpack_from(endian + 'I', data, at)[0]
    if len(data) < 8 or u16(2) != 42:
        return {}, []
    todo, seen, meta, previews = [u32(4)], set(), {}, []
    while todo and len(seen) < 32:
        at = todo.pop()
        if at in seen or not 8 <= at <= len(data)-2:
            continue
        seen.add(at)
        count = min(u16(at), 512)
        values = {}
        for i in range(count):
            entry = at+2+i*12
            if entry+12 > len(data): break
            tag, typ, n = u16(entry), u16(entry+2), u32(entry+4)
            unit = {1:1, 2:1, 3:2, 4:4, 7:1}.get(typ)
            if not unit or n > 4096: continue
            pos = entry+8 if n*unit <= 4 else u32(entry+8)
            if pos+n*unit > len(data): continue
            if typ == 2:
                value = bytes(data[pos:pos+n]).split(b'\0')[0].decode('utf-8', 'replace')
            elif typ in (3, 4):
                value = [(u16 if typ == 3 else u32)(pos+j*unit) for j in range(n)]
            else: continue
            values[tag] = value
            if tag in (330, 34665) and isinstance(value, list): todo.extend(value)
        for tag, field in [(271,'make'), (272,'model'), (274,'orientation'), (36867,'date'), (36868,'date'), (306,'date')]:
            if tag in values and field not in meta:
                val = values[tag]
                meta[field] = val[0] if isinstance(val, list) and val else val
        if 513 in values and 514 in values:
            previews.append((values[513][0], values[514][0]))
        end = at+2+count*12
        if end+4 <= len(data) and u32(end): todo.append(u32(end))
    return meta, previews

def metadata(path):
    path = Path(path)
    meta = {}
    try:
        if path.suffix.lower() in RAW:
            with path.open('rb') as f:
                meta, _ = tiff_metadata(f.read(4*1024*1024))
        else:
            with Image.open(path) as im:
                exif = im.getexif()
                nested = exif.get_ifd(34665) if 34665 in exif else {}
                meta = {'date':nested.get(36867) or nested.get(36868) or exif.get(306), 'model':exif.get(272,''), 'orientation':exif.get(274,1)}
        if meta.get('date'):
            dt = datetime.datetime.strptime(str(meta['date'])[:19], '%Y:%m:%d %H:%M:%S')
            meta['time'] = int(dt.timestamp()*1000)
    except (ValueError, OSError, struct.error, TypeError): pass
    return meta

def orient(im, orientation):
    methods = {2:Image.Transpose.FLIP_LEFT_RIGHT,3:Image.Transpose.ROTATE_180,4:Image.Transpose.FLIP_TOP_BOTTOM,
               5:Image.Transpose.TRANSPOSE,6:Image.Transpose.ROTATE_270,7:Image.Transpose.TRANSVERSE,8:Image.Transpose.ROTATE_90}
    return im.transpose(methods[orientation]) if orientation in methods else im

def embedded_jpeg(path):
    """Prefer TIFF preview offsets, then search JPEG signatures without loading RAW pixels."""
    best, pixels = None, 0
    with open(path, 'rb') as f, mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ) as data:
        _, offsets = tiff_metadata(data[:4*1024*1024])
        def consider(blob):
            nonlocal best, pixels
            if not blob.startswith(b'\xff\xd8'): return
            try:
                with Image.open(io.BytesIO(blob)) as im:
                    area = im.width*im.height
                    if area > 100_000_000: return
                    im.verify()
                    if area > pixels:
                        best, pixels = blob, area
            except (OSError, ValueError, Image.DecompressionBombError): pass
        for at, size in offsets:
            if at >= 0 and 0 < size < 40*1024*1024 and at+size <= len(data): consider(data[at:at+size])
        if best: return best
        def jpeg_end(start):
            # Skip complete marker payloads: EXIF may itself contain a JPEG thumbnail.
            at, limit = start+2, min(len(data), start+40*1024*1024)
            while at+1 < limit:
                if data[at] != 255: return None
                while at < limit and data[at] == 255: at += 1
                if at >= limit: return None
                marker = data[at]; at += 1
                if marker == 217: return at
                if marker == 1 or 208 <= marker <= 215: continue
                if at+2 > limit: return None
                length = struct.unpack_from('>H',data,at)[0]
                if length < 2 or at+length > limit: return None
                at += length
                if marker == 218:
                    while at+1 < limit:
                        at = data.find(b'\xff',at,limit)
                        if at < 0: return None
                        next_marker = data[at+1] if at+1 < limit else 0
                        if next_marker == 0 or 208 <= next_marker <= 215:
                            at += 2; continue
                        if next_marker == 255: at += 1;continue
                        break
            return None
        # The first few MiB usually contain Sony's preview. Full scan is only a fallback.
        position, attempts = 0, 0
        while position < len(data) and attempts < 128:
            start = data.find(b'\xff\xd8\xff', position)
            if start < 0: break
            end = jpeg_end(start)
            if end is not None: consider(data[start:end])
            position = start+3
            attempts += 1
            if best and position > 4*1024*1024: break
    if best is None: raise ValueError('没有找到可用的 RAW 内嵌 JPEG')
    return best

def raw_image(path, full=False):
    try:
        import rawpy
    except ImportError as exc:
        raise ValueError('RAW 解码组件未安装；请联网重新运行启动脚本完成安装') from exc
    with rawpy.RawPy() as raw:
        raw.open_file(str(path))
        if not full:
            try:
                thumb = raw.extract_thumb()
                return Image.open(io.BytesIO(thumb.data)).copy() if thumb.format == rawpy.ThumbFormat.JPEG else Image.fromarray(thumb.data)
            except (rawpy.LibRawNoThumbnailError, rawpy.LibRawUnsupportedThumbnailError): pass
        raw.unpack()
        return Image.fromarray(raw.postprocess(half_size=not full, use_camera_wb=True, no_auto_bright=True, output_bps=8))

def read_image(path, meta, full=False, paired=None):
    path = Path(path)
    if path.suffix.lower() not in RAW:
        with Image.open(path) as source:
            source.draft('RGB', (1800,1800)) if not full else None
            return ImageOps.exif_transpose(source).convert('RGB'), '原图' if full else 'JPEG / 图片预览'
    if full: return raw_image(path, True).convert('RGB'), 'RAW 解码 · 相机白平衡'
    # LibRaw knows which camera preview is the largest. open_file only parses
    # the container; extract_thumb does not unpack the full sensor mosaic.
    try:
        import rawpy
        with rawpy.RawPy() as raw:
            raw.open_file(str(path))
            thumb = raw.extract_thumb()
            if thumb.format == rawpy.ThumbFormat.JPEG:
                with Image.open(io.BytesIO(thumb.data)) as source:
                    own_orientation = source.getexif().get(274)
                    source.draft('RGB',(1800,1800))
                    im = ImageOps.exif_transpose(source).convert('RGB')
                    if not own_orientation: im = orient(im,meta.get('orientation',1))
                return im, 'RAW 内嵌 JPEG'
            return orient(Image.fromarray(thumb.data),meta.get('orientation',1)).convert('RGB'), 'RAW 内嵌位图'
    except (ImportError, OSError, ValueError): pass
    except Exception: pass  # Corrupt/unsupported containers still get the bounded JPEG fallback below.
    try:
        blob = embedded_jpeg(path)
        with Image.open(io.BytesIO(blob)) as source:
            own_orientation = source.getexif().get(274)
            source.draft('RGB',(1800,1800))
            im = ImageOps.exif_transpose(source).convert('RGB')
            if not own_orientation: im = orient(im, meta.get('orientation',1))
            return im, 'RAW 内嵌 JPEG'
    except (ValueError, OSError):
        if paired:
            im, _ = read_image(paired, metadata(paired))
            return im, '同名 JPEG'
        return raw_image(path).convert('RGB'), 'RAW 轻量解码'

def previews(path, cache, meta, paired=None):
    cache = Path(cache)
    cache.mkdir(parents=True, exist_ok=True)
    im, source = read_image(path, meta, paired=paired)
    width, height = im.size
    small = im.resize((9,8), Image.Resampling.BILINEAR)
    rgb = list(small.get_flattened_data() if hasattr(small, 'get_flattened_data') else small.getdata())
    color = [sum(px[c] for px in rgb)/(72*255) for c in range(3)]
    luma = [r*.299+g*.587+b*.114 for r,g,b in rgb]
    signature = ''.join('1' if luma[y*9+x]>luma[y*9+x+1] else '0' for y in range(8) for x in range(8))
    for kind, edge, quality in [('preview',1600,85),('thumb',260,72)]:
        image = im.copy()
        image.thumbnail((edge,edge), Image.Resampling.LANCZOS)
        image.save(cache/f'{kind}.jpg','JPEG',quality=quality)
        image.close()
    im.close()
    return {'width':width,'height':height,'previewSource':source,'hash':signature,'color':color}
