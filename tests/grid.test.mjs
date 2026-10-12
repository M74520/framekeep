import test from 'node:test';
import assert from 'node:assert/strict';
import {gridState,gridPool,applyPage} from '../public/grid.mjs';
function fixture(){const photos=Array.from({length:20},(_,i)=>({id:String(i+1),status:'pending'}));return {photos,groups:[{id:'g',ids:photos.map(p=>p.id)}],candidates:{g:[]},round:1,roundIds:photos.map(p=>p.id),filter:'round'};}
test('confirmation affects only visible group members; stable pool never skips rejected frames',()=>{
  const s=fixture(),g=s.groups[0],session=gridState(s,g);s.photos[1].status='unsure';s.photos[15].status='keep';s.candidates.g=['16'];
  applyPage(s,g,['1','2','3','4'],['1','16']);
  assert.deepEqual(s.photos.slice(0,5).map(p=>p.status),['keep','unsure','reject','reject','pending']);
  assert.deepEqual(new Set(s.candidates.g),new Set(['16','1']));
  assert.deepEqual(gridPool(s,g,session).slice(4,8).map(p=>p.id),['5','6','7','8']);
  assert.equal(gridPool(s,g,session).length,20);
});
test('review includes retained and deferred; deferral removes candidate without rejecting peers',()=>{
  const s=fixture(),g=s.groups[0],session=gridState(s,g);
  applyPage(s,g,['1','2','3','4'],['1','3']);applyPage(s,g,['1'],['1'],'unsure');session.review=true;
  assert.deepEqual(gridPool(s,g,session).map(p=>p.id),['1','3']);assert.deepEqual(s.candidates.g,['3']);assert.equal(s.photos[4].status,'pending');
});
test('session persists via JSON, is independent by group/round/filter, and rejects unknown IDs',()=>{
  const s=fixture(),g=s.groups[0];gridState(s,g).page=3;gridState(s,g).picks=['15'];
  const restored=JSON.parse(JSON.stringify(s));assert.equal(gridState(restored,g).page,3);assert.deepEqual(gridState(restored,g).picks,['15']);
  s.round=2;assert.equal(gridState(s,g).page,0);s.filter='all';assert.equal(gridState(s,g).page,0);
  applyPage(s,{id:'other',ids:['1']},['2'],['2']);assert.equal(s.photos[1].status,'pending');
});
