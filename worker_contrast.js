self.onmessage = async (e) => {
  const {bitmap,w,h} = e.data;
  try{
    const off = new OffscreenCanvas(w,h);
    const ctx = off.getContext('2d');
    ctx.drawImage(bitmap,0,0,w,h);
    const img = ctx.getImageData(0,0,w,h);
    // convert to grayscale
    const gray = new Uint8ClampedArray(w*h);
    for(let i=0, j=0;i<img.data.length;i+=4,j++){
      const r = img.data[i], g = img.data[i+1], b = img.data[i+2];
      gray[j] = (0.299*r + 0.587*g + 0.114*b)|0;
    }
    // simple Sobel
    const sobel = new Uint8ClampedArray(w*h);
    const gx = [-1,0,1,-2,0,2,-1,0,1];
    const gy = [-1,-2,-1,0,0,0,1,2,1];
    for(let y=1;y<h-1;y++){
      for(let x=1;x<w-1;x++){
        let sx=0, sy=0;
        let k=0;
        for(let ky=-1;ky<=1;ky++){
          for(let kx=-1;kx<=1;kx++){
            const v = gray[(y+ky)*w + (x+kx)];
            sx += gx[k]*v; sy += gy[k]*v; k++;
          }
        }
        const mag = Math.sqrt(sx*sx + sy*sy);
        sobel[y*w+x] = mag>255?255:mag;
      }
    }
    // normalize and threshold adaptively (use median-ish approach)
    const vals = Array.from(sobel);
    vals.sort((a,b)=>a-b);
    const median = vals[Math.floor(vals.length*0.55)] || 20;
    const thresh = Math.max(18, median * 1.1);
    const out = ctx.createImageData(w,h);
    for(let i=0,j=0;i<sobel.length;i++,j+=4){
      const v = sobel[i] > thresh ? 0 : 255; // black lines (0) on white (255)
      out.data[j]=v; out.data[j+1]=v; out.data[j+2]=v; out.data[j+3]=255;
    }
    // optional thin the result a bit (simple erosion-like pass)
    const copy = new Uint8ClampedArray(out.data);
    for(let y=1;y<h-1;y++){
      for(let x=1;x<w-1;x++){
        const idx = (y*w + x)*4;
        if(copy[idx] === 0){
          // check neighbors count
          let cnt=0;
          for(let yy=-1;yy<=1;yy++) for(let xx=-1;xx<=1;xx++){
            const nidx = ((y+yy)*w + (x+xx))*4;
            if(copy[nidx] === 0) cnt++;
          }
          if(cnt < 3){ out.data[idx]=255; out.data[idx+1]=255; out.data[idx+2]=255; }
        }
      }
    }
    ctx.putImageData(out,0,0);
    const resultBitmap = off.transferToImageBitmap();
    self.postMessage(resultBitmap,{transfer:[resultBitmap]});
  }catch(err){console.error(err);}
};
