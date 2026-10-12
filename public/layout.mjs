export function rotationFor(state, id) {
  const angle=Number(state.grid?.rotations?.[id])||0;
  return ((Math.round(angle/90)*90)%360+360)%360;
}

export function photoRatio(photo, rotation=0, dimensions=null) {
  let width=Number(dimensions?.width||photo?.width),height=Number(dimensions?.height||photo?.height);
  if(!(width>0&&height>0)){width=2;height=3;}
  if(rotation%180!==0)[width,height]=[height,width];
  return Math.max(.1,Math.min(10,width/height));
}

// Consider contiguous row breaks so keyboard numbers and capture order stay
// stable. Select the arrangement painting the most image area in the viewport.
export function layoutRows(ratios, width, height, gap=10, caption=38, border=4) {
  if(!ratios.length||width<=0)return [];
  let best=null;
  function score(rows){
    const raw=rows.map(row=>Math.max(1,width-gap*(row.length-1)-border*row.length)/row.reduce((sum,i)=>sum+ratios[i],0));
    const space=Math.max(60,height-caption*rows.length-gap*(rows.length-1));
    const scale=Math.min(1,space/raw.reduce((a,b)=>a+b,0));
    const result=rows.map((indices,r)=>({indices,height:raw[r]*scale,widths:indices.map(i=>ratios[i]*raw[r]*scale)}));
    const area=result.reduce((sum,row)=>sum+row.widths.reduce((a,b)=>a+b,0)*row.height,0);
    if(!best||area>best.area+.1)best={area,rows:result};
  }
  function visit(at,rows){
    if(at===ratios.length){score(rows);return;}
    if(rows.length>=Math.min(3,ratios.length))return;
    for(let end=at+1;end<=ratios.length;end++)visit(end,[...rows,Array.from({length:end-at},(_,i)=>at+i)]);
  }
  visit(0,[]);return best.rows;
}

// Set the unrotated image box to its fitted size, then rotate around its center.
// This preserves the entire composition even when width and height swap.
export function fitRotatedImage(img, width, height, rotation=0) {
  const nw=img.naturalWidth,nh=img.naturalHeight;if(!(nw&&nh&&width&&height))return;
  const sideways=rotation%180!==0,scale=Math.min(width/(sideways?nh:nw),height/(sideways?nw:nh));
  Object.assign(img.style,{position:'absolute',left:'50%',top:'50%',width:`${nw*scale}px`,height:`${nh*scale}px`,maxWidth:'none',maxHeight:'none',objectFit:'contain',transformOrigin:'center',transform:`translate(-50%, -50%) rotate(${rotation}deg)`});
}
