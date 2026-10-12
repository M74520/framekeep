export const STATUSES = ['pending','keep','reject','unsure'];
export function fileKey(file) { return `${file.webkitRelativePath || file.name}|${file.size}|${file.lastModified}`; }
export function validDate(value) { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : 0; }
export function imageSize(buffer) {
  try {
    const v=new DataView(buffer);
    if(v.byteLength>=24&&v.getUint32(0)===0x89504e47&&v.getUint32(4)===0x0d0a1a0a)return {width:v.getUint32(16),height:v.getUint32(20)};
    if(v.byteLength<4||v.getUint16(0)!==0xffd8)return null;
    let p=2;while(p+4<v.byteLength){if(v.getUint8(p)!==0xff)return null;const marker=v.getUint8(p+1);p+=2;if(marker===0xda||marker===0xd9)return null;const length=v.getUint16(p);if(length<2||p+length>v.byteLength)return null;
      if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)&&length>=7)return {height:v.getUint16(p+3),width:v.getUint16(p+5)};p+=length;}
  }catch{}return null;
}
export function exifTime(buffer) {
  try {
    const v = new DataView(buffer); if (v.getUint16(0) !== 0xffd8) return 0;
    let p = 2;
    while (p + 4 <= v.byteLength) {
      if (v.getUint8(p) !== 0xff) break;
      const marker=v.getUint8(p+1); p+=2;
      if (marker===0xda || marker===0xd9) break;
      if (marker===0x01 || (marker>=0xd0 && marker<=0xd7)) continue;
      const len=v.getUint16(p); if (len<2 || p+len>v.byteLength) break;
      if (marker===0xe1 && len>16 && v.getUint32(p+2)===0x45786966 && v.getUint16(p+6)===0) {
        const base=p+8, le=v.getUint16(base)===0x4949;
        if (v.getUint16(base+2,le)!==42) return 0;
        const u16=o=>v.getUint16(base+o,le), u32=o=>v.getUint32(base+o,le);
        const readIFD=(offset, depth=0)=>{
          if (depth>2 || base+offset+2>p+len) return '';
          const count=u16(offset); let fallback='', original='', digitized='';
          for(let i=0;i<Math.min(count,512);i++) {
            const entry=offset+2+i*12; if(base+entry+12>p+len) break;
            const tag=u16(entry), type=u16(entry+2), size=u32(entry+4);
            if (tag===0x8769) { const result=readIFD(u32(entry+8),depth+1); if(result) original=result; }
            if ([0x9003,0x9004,0x0132].includes(tag) && type===2 && size>=19 && size<=64) {
              const at=size<=4?entry+8:u32(entry+8); if(base+at+size>p+len) continue;
              const value=String.fromCharCode(...new Uint8Array(buffer,base+at,size)).replace(/\0.*$/,'');
              if(tag===0x9003) original=value; else if(tag===0x9004) digitized=value; else fallback=value;
            }
          }
          return original || digitized || fallback;
        };
        const date=readIFD(u32(4)); const m=/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(date);
        if(m) return validDate(new Date(+m[1],+m[2]-1,+m[3],+m[4],+m[5],+m[6]).getTime());
      }
      p+=len;
    }
  } catch {} return 0;
}
export function signature(rgba,width=9,height=8) {
  const bits=[], color=[0,0,0];
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
    const i=(y*width+x)*4; color[0]+=rgba[i];color[1]+=rgba[i+1];color[2]+=rgba[i+2];
    if(x<width-1) { const j=i+4; const a=rgba[i]*.299+rgba[i+1]*.587+rgba[i+2]*.114, b=rgba[j]*.299+rgba[j+1]*.587+rgba[j+2]*.114; bits.push(a>b?1:0); }
  }
  return {hash:bits.join(''), color:color.map(v=>v/(width*height*255))};
}
export function visualDistance(a,b) {
  if(!a.hash || !b.hash) return {hash:64,color:1};
  let hash=0;for(let i=0;i<64;i++) if(a.hash[i]!==b.hash[i]) hash++;
  return {hash,color:Math.sqrt(a.color.reduce((s,v,i)=>s+(v-b.color[i])**2,0)/3)};
}
export function makeGroups(photos,mode='time',threshold=90) {
  const sorted=[...photos].sort((a,b)=>a.time-b.time || a.name.localeCompare(b.name,undefined,{numeric:true}));
  const groups=[];
  for(const photo of sorted) {
    let group;
    if(mode==='visual') {
      let best=Infinity;
      for(const g of groups) {
        // Compare a stable representative and the latest frame, without transitive chain drift.
        const d1=visualDistance(photo,g.representative), d2=visualDistance(photo,g.last);
        const score=d1.hash+d1.color*32;
        if(d1.hash<=threshold && d1.color<=.20 && d2.hash<=threshold+5 && score<best) {group=g;best=score;}
      }
    } else if(groups.length) {
      const g=groups.at(-1); if(photo.time-g.last.time<=threshold*1000) group=g;
    }
    if(!group) {group={id:`group-${photo.id}`,ids:[],representative:photo,last:photo};groups.push(group);}
    group.ids.push(photo.id);group.last=photo;
  }
  return groups.map((g,i)=>({id:g.id,name:`分组 ${String(i+1).padStart(2,'0')}`,ids:g.ids}));
}
export function nextRound(photos,round) { return photos.filter(p=>p.roundIncluded!==false && p.status!=='reject').map(p=>p.id); }
export function chooseWinner(photos,candidateId,challengerId) {
  return photos.map(p=>p.id===candidateId?{...p,status:'reject'}:p.id===challengerId?{...p,status:'keep'}:p);
}
export function csvCell(value) { let s=String(value??''); if(/^[=+\-@\t\r]/.test(s)) s="'"+s; return '"'+s.replaceAll('"','""')+'"'; }
