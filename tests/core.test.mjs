import test from 'node:test';
import assert from 'node:assert/strict';
import {makeGroups, visualDistance, nextRound, chooseWinner, exifTime, csvCell, imageSize} from '../public/core.mjs';
const p=(id,time,extra={})=>({id,name:`IMG_${id}.jpg`,time,hash:'0'.repeat(64),color:[.3,.4,.5],status:'pending',...extra});
test('time grouping sorts first, accepts boundary and preserves all photos',()=>{
  const groups=makeGroups([p('3',100001),p('1',1000),p('2',91000),p('4',300000)],'time',90);
  assert.deepEqual(groups.map(g=>g.ids),[['1','2','3'],['4']]);
});
test('visual grouping joins similar nonadjacent frames and splits different scenes',()=>{
  const photos=[p('a',1),p('b',2,{hash:'1'.repeat(64),color:[.9,.8,.7]}),p('c',3,{hash:'1'.repeat(5)+'0'.repeat(59)})];
  assert.deepEqual(makeGroups(photos,'visual',13).map(g=>g.ids),[['a','c'],['b']]);
  assert.equal(visualDistance(photos[0],photos[2]).hash,5);
});
test('winner replaces current reference, keeps unrelated candidates intact',()=>{
  const photos=[p('a',1,{status:'keep'}),p('b',2),p('c',3,{status:'keep'})];
  const result=chooseWinner(photos,'a','b');assert.deepEqual(result.map(p=>p.status),['reject','keep','keep']);assert.equal(photos[0].status,'keep');
});
test('next round includes undecided and pending but excludes rejected and old-round removals',()=>{
  const photos=[p('a',1,{status:'keep'}),p('b',2,{status:'unsure'}),p('c',3),p('d',4,{status:'reject'}),p('e',5,{roundIncluded:false})];
  assert.deepEqual(nextRound(photos,1),['a','b','c']);
});
test('EXIF date reads little-endian original date and ignores malformed inputs',()=>{
  const b=new ArrayBuffer(80),v=new DataView(b);v.setUint16(0,0xffd8);v.setUint16(2,0xffe1);v.setUint16(4,74);v.setUint32(6,0x45786966);v.setUint16(10,0);const base=12;
  v.setUint16(base,0x4949);v.setUint16(base+2,42,true);v.setUint32(base+4,8,true);v.setUint16(base+8,1,true);v.setUint16(base+10,0x9003,true);v.setUint16(base+12,2,true);v.setUint32(base+14,20,true);v.setUint32(base+18,26,true);
  new Uint8Array(b,base+26,20).set(new TextEncoder().encode('2026:10:10 14:05:06\0'));assert.equal(exifTime(b),new Date(2026,9,10,14,5,6).getTime());assert.equal(exifTime(new ArrayBuffer(4)),0);
});
test('CSV export escapes quotes and spreadsheet formula filenames',()=>{
  assert.equal(csvCell('normal"name.jpg'),'"normal""name.jpg"');assert.equal(csvCell('=cmd.jpg'),'"\'=cmd.jpg"');
});
test('image dimensions prevent small JPEG thumbnails from being upscaled',()=>{
  const b=new ArrayBuffer(20),v=new DataView(b);v.setUint16(0,0xffd8);v.setUint16(2,0xffc0);v.setUint16(4,11);v.setUint8(6,8);v.setUint16(7,1200);v.setUint16(9,800);assert.deepEqual(imageSize(b),{width:800,height:1200});assert.equal(imageSize(new ArrayBuffer(4)),null);
});
