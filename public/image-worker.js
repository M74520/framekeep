import { exifTime, signature, imageSize } from './core.mjs';
self.onmessage=async({data:{requestId,file}})=>{
  let bitmap;
  try {
    const header=await file.slice(0,262144).arrayBuffer(),time=exifTime(header),dimensions=imageSize(header);
    bitmap=await createImageBitmap(file,{resizeWidth:Math.min(1400,dimensions?.width||1400),resizeQuality:'high',imageOrientation:'from-image'});
    // Some decoders scale height proportionally; explicitly bound both dimensions next.
    const scale=Math.min(1,1400/bitmap.width,1400/bitmap.height);
    const canvas=new OffscreenCanvas(Math.max(1,Math.round(bitmap.width*scale)),Math.max(1,Math.round(bitmap.height*scale)));
    const ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();bitmap=null;
    const preview=await canvas.convertToBlob({type:'image/jpeg',quality:.82});
    const thumbCanvas=new OffscreenCanvas(240,Math.max(1,Math.round(240*canvas.height/canvas.width)));
    thumbCanvas.getContext('2d').drawImage(canvas,0,0,thumbCanvas.width,thumbCanvas.height);
    const thumb=await thumbCanvas.convertToBlob({type:'image/jpeg',quality:.65});
    const hashCanvas=new OffscreenCanvas(9,8);const hctx=hashCanvas.getContext('2d',{willReadFrequently:true});hctx.drawImage(canvas,0,0,9,8);
    const sig=signature(hctx.getImageData(0,0,9,8).data);
    self.postMessage({requestId,preview,thumb,time,width:canvas.width,height:canvas.height,...sig});
  } catch(error) {bitmap?.close();self.postMessage({requestId,error:error.message||'无法解码图片'});}
};
