// The page order is independent of judgments: rejecting a photo never shifts
// unseen photos into a page that was already confirmed.
export function gridState(state, group) {
  state.grid ??= {size:4, view:'grid', sessions:{}};
  state.grid.rotations ??= {};
  if (![4,6,8].includes(state.grid.size)) state.grid.size=4;
  const key=`${state.round}:${group.id}:${state.filter}`;
  return state.grid.sessions[key] ??= {page:0, review:false, picks:[], visited:[]};
}
export function gridPool(state, group, session) {
  const byId=new Map(state.photos.map(p=>[p.id,p]));
  const round=new Set(state.roundIds);
  return group.ids.map(id=>byId.get(id)).filter(p=>p && (session.review
    ? p.status==='keep'||p.status==='unsure'
    : state.filter==='all'||(state.filter==='round'?round.has(p.id):p.status===state.filter)));
}
export function applyPage(state, group, displayedIds, selectedIds, status='keep') {
  const members=new Set(group.ids), shown=new Set(displayedIds.filter(id=>members.has(id)));
  const selected=new Set(selectedIds), candidates=new Set(state.candidates[group.id]||[]);
  for(const p of state.photos) {
    if(!shown.has(p.id)) continue;
    // Deferred frames survive page confirmation unless explicitly selected.
    if(selected.has(p.id)) p.status=status;
    else if(status==='keep' && p.status!=='unsure') p.status='reject';
    else continue;
    if(p.status==='keep') candidates.add(p.id); else candidates.delete(p.id);
    if(p.status!=='reject') {p.roundIncluded=true;if(!state.roundIds.includes(p.id))state.roundIds.push(p.id);}
  }
  state.candidates[group.id]=[...candidates];
}

export function groupProgress(state,group,byId=new Map(state.photos.map(p=>[p.id,p])),roundIds=new Set(state.roundIds)) {
  const photos=group.ids.filter(id=>roundIds.has(id)).map(id=>byId.get(id)).filter(Boolean);
  const total=photos.length,pending=photos.filter(p=>p.status==='pending').length,unsure=photos.filter(p=>p.status==='unsure').length,kept=photos.filter(p=>p.status==='keep').length;
  const reviewed=total-pending;
  const status=!total?'inactive':!reviewed?'untouched':pending?'progress':unsure?'review':'complete';
  return {total,reviewed,pending,unsure,kept,status};
}
