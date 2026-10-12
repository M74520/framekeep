import test from 'node:test';
import assert from 'node:assert/strict';
import {photoRatio,rotationFor,layoutRows} from '../public/layout.mjs';

test('oriented dimensions distinguish portrait, landscape and manual quarter turns',()=>{
  const p={id:'p',width:600,height:900};assert.equal(photoRatio(p),2/3);assert.equal(photoRatio(p,90),1.5);
  assert.equal(photoRatio({width:1600,height:900}),16/9);
  assert.equal(rotationFor({grid:{rotations:{p:-90}}},'p'),270);
  assert.equal(photoRatio(p,0,{width:1200,height:600}),2);
});
test('four portraits on a six-photo page occupy one larger row without letterboxing',()=>{
  const rows=layoutRows(Array(4).fill(2/3),1000,350);
  assert.equal(rows.length,1);assert(rows[0].height>300);
  assert(rows[0].widths.every(width=>Math.abs(width/rows[0].height-2/3)<1e-9));
});
test('mixed aspect layouts fit the viewport and retain capture order exactly',()=>{
  for(const ratios of [[2/3,1.5,2/3,1.5,1,2/3],Array(8).fill(2/3),[.2,3,1.5,2/3]]){
    for(const width of [480,1000,1400]){
      const rows=layoutRows(ratios,width,430);
      assert.deepEqual(rows.flatMap(r=>r.indices),ratios.map((_,i)=>i));
      for(const row of rows){assert(row.widths.reduce((a,b)=>a+b,0)+10*(row.indices.length-1)<=width+.01);row.indices.forEach((index,i)=>assert(Math.abs(row.widths[i]/row.height-ratios[index])<1e-9));}
      assert(rows.reduce((sum,r)=>sum+r.height+34,0)+10*(rows.length-1)<=430+.01);
    }
  }
});
