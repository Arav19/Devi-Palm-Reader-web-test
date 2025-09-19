self.onmessage = async (e) => {
  const {bitmap,w,h,landmarks} = e.data;
  try{
    const off = new OffscreenCanvas(w,h);
    const ctx = off.getContext('2d');
    ctx.drawImage(bitmap,0,0,w,h);
    const img = ctx.getImageData(0,0,w,h);

    // if landmarks are provided, build polygon mask around them using convex hull
    const mask = ctx.createImageData(w,h);
    if(landmarks && landmarks.length){
      // landmarks are in normalized coords [x,y]
      // convert to pixel coords
      const pts = landmarks.map(p=>[Math.min(Math.max(p.x,0),1)*w, Math.min(Math.max(p.y,0),1)*h]);
      // compute convex hull (Monotone chain)
      pts.sort((a,b)=> a[0] === b[0] ? a[1]-b[1] : a[0]-b[0]);
      function cross(o,a,b){return (a[0]-o[0])*(b[1]-o[1]) - (a[1]-o[1])*(b[0]-o[0]);}
      const lower = [];
      for(const p of pts){ while(lower.length>=2 && cross(lower[lower.length-2], lower[lower.length-1], p) <= 0) lower.pop(); lower.push(p); }
      const upper = [];
      for(let i=pts.length-1;i>=0;i--){ const p=pts[i]; while(upper.length>=2 && cross(upper[upper.length-2], upper[upper.length-1], p) <= 0) upper.pop(); upper.push(p); }
      upper.pop(); lower.pop();
      const hull = lower.concat(upper);

      // draw hull polygon, then expand (stroke) to cover the hand area
      ctx.clearRect(0,0,w,h);
      ctx.fillStyle='white';
      ctx.beginPath();
      hull.forEach((p,i)=>{ if(i===0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]); });
      ctx.closePath();
      ctx.fill();
      // expand mask by drawing a thick stroke and compositing
      ctx.lineWidth = Math.max(24, Math.min(w,h)*0.06);
      ctx.strokeStyle = 'white';
      ctx.stroke();
      // blur edges to smooth
      ctx.filter='blur(28px)';
      const temp = ctx.getImageData(0,0,w,h);
      ctx.filter='none';
      for(let i=0;i<temp.data.length;i+=4){
        const a = temp.data[i];
        mask.data[i]=mask.data[i+1]=mask.data[i+2]=255;
        mask.data[i+3]=a;
      }
    }else{
      // fallback: simple skin color detection in YCrCb-ish space
      for(let i=0;i<img.data.length;i+=4){
        const r=img.data[i], g=img.data[i+1], b=img.data[i+2];
        const Y = 0.299*r + 0.587*g + 0.114*b;
        const Cr = (r - Y);
        const Cb = (b - Y);
        // heuristic thresholds
        const skin = (Cr>8 && Cr<70 && Cb>-25 && Cb<25 && Y>30);
        mask.data[i]=mask.data[i+1]=mask.data[i+2]=255;
        mask.data[i+3]=skin?255:0;
      }
    }

    // put mask into canvas and return as bitmap
    const maskCanvas = new OffscreenCanvas(w,h);
    const mctx = maskCanvas.getContext('2d');
    mctx.putImageData(mask,0,0);
    const bmp = maskCanvas.transferToImageBitmap();
    self.postMessage(bmp,{transfer:[bmp]});
  }catch(err){console.error(err);}
};
