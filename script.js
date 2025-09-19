const video = document.getElementById('video');
const preview = document.getElementById('preview');
const glow = document.getElementById('glow');
const captureBtn = document.getElementById('capture');
const toggleCamBtn = document.getElementById('toggleCam');
const status = document.getElementById('status');

let stream = null;
let camera = null;
let running = false;

const previewCtx = preview.getContext('2d');
const glowCtx = glow.getContext('2d');
const scan = document.getElementById('scan');
const scanCtx = scan.getContext('2d');
const particles = document.getElementById('particles');
const particlesCtx = particles.getContext('2d');

// Workers
const contrastWorker = new Worker('worker_contrast.js');
const segmentWorker = new Worker('worker_segment.js');

function setStatus(s){status.textContent = s}

function resizeCanvases(){
  const w = video.videoWidth || 640;
  const h = video.videoHeight || 480;
  [preview, glow, scan].forEach(c=>{c.width=w;c.height=h});
  [particles].forEach(c=>{c.width=w;c.height=h});
}

async function startCamera(){
  try{
    // prefer selected device if present
    const cameraSelect = document.getElementById('cameraSelect');
    const selectedId = cameraSelect && cameraSelect.value ? cameraSelect.value : null;
    const constraints = selectedId ? { video: { deviceId: { exact: selectedId } } } : { video:{facingMode:'environment'} };
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = stream;
    await video.play();
    resizeCanvases();
    setStatus('Camera started');
    toggleCamBtn.textContent = 'Stop Camera';
  running = true;

    // If MediaPipe Hands is available, set up camera utils to send frames
    if(hands && typeof Camera !== 'undefined'){
      if(mpCamera) mpCamera.stop();
      mpCamera = new Camera(video, {
        onFrame: async () => { await hands.send({image: video}); },
        width: video.videoWidth,
        height: video.videoHeight
      });
      mpCamera.start();
    }
  }catch(e){console.error(e);setStatus('Camera error');}
}

function stopCamera(){
  if(stream){stream.getTracks().forEach(t=>t.stop());stream=null}
  video.pause();video.srcObject=null;running=false;toggleCamBtn.textContent='Start Camera';setStatus('Camera stopped');
}

toggleCamBtn.addEventListener('click', ()=>{
  if(running) stopCamera(); else startCamera();
});

captureBtn.addEventListener('click', async ()=>{
  if(!running){setStatus('Starting camera...');await startCamera();}
  setStatus('Capturing...');
  await captureAndProcess();
  // freeze the preview and stop camera so the image stays
  stopCamera();
});

// enumerate cameras and populate select
async function populateCameras(){
  try{
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter(d=>d.kind === 'videoinput');
    const sel = document.getElementById('cameraSelect');
    sel.innerHTML = '';
    cams.forEach(c=>{
      const opt = document.createElement('option');
      opt.value = c.deviceId;
      opt.textContent = c.label || `Camera ${sel.length+1}`;
      sel.appendChild(opt);
    });
  }catch(err){console.warn('Could not list cameras',err);}
}

document.getElementById('cameraSelect').addEventListener('change', async (e)=>{
  if(running){ stopCamera(); }
  await startCamera();
});

document.getElementById('swapCam').addEventListener('click', async ()=>{
  // try toggling facingMode
  if(running) stopCamera();
  // find a device with opposite label hint (front/back) if available
  const sel = document.getElementById('cameraSelect');
  const opts = Array.from(sel.options);
  if(opts.length < 2){ await startCamera(); return; }
  // pick next device
  const idx = sel.selectedIndex;
  const next = (idx+1) % opts.length;
  sel.selectedIndex = next;
  await startCamera();
});

// initial population
populateCameras();

// Handle uploads
const upload = document.getElementById('upload');
upload.addEventListener('change', async (ev)=>{
  const f = ev.target.files && ev.target.files[0];
  if(!f) return;
  const img = new Image();
  img.src = URL.createObjectURL(f);
  await img.decode();
  // draw to preview canvas and process
  resizeCanvases();
  previewCtx.clearRect(0,0,preview.width,preview.height);
  previewCtx.drawImage(img,0,0,preview.width,preview.height);
  const bmp = await createImageBitmap(preview);
  // send to workers (no landmarks)
  contrastWorker.postMessage({bitmap:bmp,w:preview.width,h:preview.height},{transfer:[bmp]});
  const bmp2 = await createImageBitmap(preview);
  segmentWorker.postMessage({bitmap:bmp2,w:preview.width,h:preview.height,landmarks:null},{transfer:[bmp2]});
  setStatus('Processing uploaded photo');
});

// When worker returns results, we collect them and then composite
let lastContrast = null;
let lastMask = null;

contrastWorker.onmessage = (e)=>{
  lastContrast = e.data; // ImageBitmap
  tryComposite();
};

segmentWorker.onmessage = (e)=>{
  lastMask = e.data; // ImageBitmap (alpha mask)
  tryComposite();
};

// Setup MediaPipe Hands
let hands = null;
let mpCamera = null;
let latestLandmarks = null;
function setupMediaPipe(){
  if(window.Hands){
    hands = new Hands({locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`});
    hands.setOptions({maxNumHands:1,minDetectionConfidence:0.6,minTrackingConfidence:0.5});
    hands.onResults((results)=>{
      if(results.multiHandLandmarks && results.multiHandLandmarks.length){
        latestLandmarks = results.multiHandLandmarks[0].map(p=>({x:p.x,y:p.y}));
      }else latestLandmarks = null;
    });
  }
}

setupMediaPipe();


async function captureAndProcess(){
  setStatus('Preparing image');
  resizeCanvases();
  const w = preview.width, h = preview.height;
  // draw current video frame onto preview and use that frozen image
  previewCtx.drawImage(video,0,0,w,h);
  const bitmap = await createImageBitmap(preview);
  setStatus('Sending to workers');
  lastContrast = null; lastMask = null;
  contrastWorker.postMessage({bitmap, w, h},{transfer:[bitmap]});
  // Need another bitmap for segment worker
  const bitmap2 = await createImageBitmap(preview);
  segmentWorker.postMessage({bitmap:bitmap2,w,h,landmarks: latestLandmarks},{transfer:[bitmap2]});
}

async function tryComposite(){
  if(!lastContrast || !lastMask) return;
  setStatus('Compositing');
  const w = preview.width, h = preview.height;
  // draw original photo
  // We will produce a masked base image where background is black and hand remains
  const baseCanvas = new OffscreenCanvas(w,h);
  const baseCtx = baseCanvas.getContext('2d');
  // draw the captured preview image into base
  baseCtx.drawImage(preview,0,0,w,h);
  // clear preview then fill black background
  previewCtx.clearRect(0,0,w,h);
  previewCtx.fillStyle = 'black';
  previewCtx.fillRect(0,0,w,h);
  // draw mask to clip
  glowCtx.clearRect(0,0,w,h);

  // Create an offscreen canvas to merge crease (contrast) into glow
  const off = new OffscreenCanvas(w,h);
  const offCtx = off.getContext('2d');
  // fill transparent
  offCtx.clearRect(0,0,w,h);
  // draw contrast map (black creases on white) -> we'll use black pixels as glow-forming
  offCtx.drawImage(lastContrast,0,0,w,h);
  const imgd = offCtx.getImageData(0,0,w,h);
  // convert to mask where darker => glow alpha; color channels will be purple/gold mix later
  const glowImage = glowCtx.createImageData(w,h);
  for(let i=0;i<imgd.data.length;i+=4){
    const r = imgd.data[i];
    // black lines => r small; white => r large
    const alpha = Math.max(0, 255 - r);
    // store purple/gold base as two-tone: we'll create a two-layer cloud (purple base, gold highlights)
    glowImage.data[i]=88;   // deep purple R-like (placeholder)
    glowImage.data[i+1]=26; // G
    glowImage.data[i+2]=132; // B
    glowImage.data[i+3]=alpha;
  }
  // apply hand mask to glow alpha
  const maskOff = new OffscreenCanvas(w,h);
  const maskCtx = maskOff.getContext('2d');
  maskCtx.drawImage(lastMask,0,0,w,h);
  const maskData = maskCtx.getImageData(0,0,w,h).data;
  for(let i=0, j=3;i<maskData.length;i+=4,j+=4){
    // use mask alpha to attenuate glow alpha
    const malpha = maskData[i+3]/255;
    glowImage.data[j] = glowImage.data[j] * malpha;
  }

  // animate glow by drawing multiple blurred layers
  // Create a masked hand image: apply the mask as alpha to the baseCanvas
  const maskedHandCanvas = new OffscreenCanvas(w,h);
  const mhCtx = maskedHandCanvas.getContext('2d');
  mhCtx.drawImage(baseCanvas,0,0,w,h);
  // apply mask: keep only areas where mask alpha > 0
  mhCtx.globalCompositeOperation = 'destination-in';
  mhCtx.drawImage(lastMask,0,0,w,h);
  mhCtx.globalCompositeOperation = 'source-over';

  // draw masked hand into visible preview canvas (background remains black)
  previewCtx.drawImage(maskedHandCanvas,0,0,w,h);

  // Now animate glow on top
  animateGlow(glowImage, maskedHandCanvas);
  // also start the scan overlay
  startScan(maskedHandCanvas);
  // start sparkles
  startParticles(maskedHandCanvas);

  // cleanup bitmaps
  lastContrast.close(); lastMask.close();
  lastContrast = null; lastMask = null;
}

let animHandle = null;
function animateGlow(glowImage, maskedHandCanvas){
  let t=0;
  const w = glow.width,h=glow.height;
  const base = new ImageData(new Uint8ClampedArray(glowImage.data),w,h);
  // prepare an offscreen canvas with the glow image
  const maskCanvas = new OffscreenCanvas(w,h);
  const mctx = maskCanvas.getContext('2d');
  mctx.putImageData(base,0,0);

  if(animHandle) cancelAnimationFrame(animHandle);
  function frame(){
    t += 0.04;
    glowCtx.clearRect(0,0,w,h);

  // preview already has masked hand drawn with black background.

    // create two moving cloud layers (purple base and gold highlight)
    const t1 = Math.sin(t*0.7) * 12;
    const t2 = Math.cos(t*0.5) * 18;

  // purple cloud (use maskedHandCanvas as clipping area for glow so glow doesn't spill outside hand)
    glowCtx.save();
    glowCtx.globalCompositeOperation = 'screen';
    glowCtx.globalAlpha = 1.1; // stronger
    glowCtx.filter = `blur(12px) saturate(1.2)`;
  // clip to hand
  glowCtx.drawImage(maskCanvas, t1, t1, w, h);
    glowCtx.restore();

    // gold highlight cloud (smaller, faster)
    // tint maskCanvas to gold by drawing it into a temporary canvas and applying colorize
    const goldCanvas = new OffscreenCanvas(w,h);
    const gctx = goldCanvas.getContext('2d');
    gctx.filter = 'blur(6px)';
    gctx.drawImage(maskCanvas,0,0);
    // colorize by drawing a filled rect with gold and using destination-in
    gctx.globalCompositeOperation = 'source-in';
    gctx.fillStyle = 'rgba(210,176,74,0.95)';
    gctx.fillRect(0,0,w,h);

  glowCtx.save();
  glowCtx.globalCompositeOperation = 'screen';
  glowCtx.globalAlpha = 1.0;
  glowCtx.filter = `blur(8px) saturate(1.6)`;
  glowCtx.drawImage(goldCanvas, t2, -t2, w, h);
  glowCtx.restore();

    // sharper purple veins
  glowCtx.save();
  glowCtx.globalCompositeOperation = 'screen';
  glowCtx.globalAlpha = 1.0;
  glowCtx.filter = 'blur(0px)';
  glowCtx.drawImage(maskCanvas,0,0);
  glowCtx.restore();

  // Finally, composite the glow only where the masked hand exists (avoid spilling onto black bg)
  glowCtx.globalCompositeOperation = 'destination-in';
  glowCtx.drawImage(maskedHandCanvas,0,0,w,h);
  glowCtx.globalCompositeOperation = 'source-over';

  // emphasize crease outlines by overlaying a sharpened contrast layer
  const outlineAlpha = 0.9;
  glowCtx.save();
  glowCtx.globalCompositeOperation = 'screen';
  glowCtx.globalAlpha = outlineAlpha;
  // draw a slightly sharpened version of the maskCanvas to make creases pop
  glowCtx.filter = 'contrast(1.2) brightness(1.05)';
  glowCtx.drawImage(maskCanvas,0,0,w,h);
  glowCtx.restore();

    animHandle = requestAnimationFrame(frame);
  }
  frame();
  setStatus('Showing result');
}

// --- Particles (sparkles) ---
let particleAnim = null;
const particlePool = [];
function spawnParticle(x,y){
  const angle = Math.random()*Math.PI*2;
  const speed = 0.2 + Math.random()*1.2;
  const p = {x,y,vx:Math.cos(angle)*speed, vy:Math.sin(angle)*speed, life: 40 + Math.random()*50, size: 1 + Math.random()*3.5, hue: 30 + Math.random()*50, wobble: Math.random()*0.5};
  particlePool.push(p);
}

function startParticles(maskedHandCanvas){
  if(particleAnim) cancelAnimationFrame(particleAnim);
  const w = particles.width, h = particles.height;
  function step(){
    particlesCtx.clearRect(0,0,w,h);
    // spawn some particles along bright glow areas (randomized)
    if(Math.random() < 0.6){
      const sx = Math.random()*w; const sy = Math.random()*h;
      // sample mask alpha to bias spawn inside hand
      const tmp = maskedHandCanvas.getContext('2d').getImageData(Math.floor(sx), Math.floor(sy),1,1).data;
      if(tmp[3] > 40){ // inside hand
        spawnParticle(sx, sy);
      }
    }

    for(let i=particlePool.length-1;i>=0;i--){
      const p = particlePool[i];
      p.x += p.vx + Math.sin(p.life*0.1)*p.wobble;
      p.y += p.vy + Math.cos(p.life*0.1)*p.wobble;
      p.life--;
      const alpha = Math.max(0, p.life / 90);
      // draw radial sparkle
      const grad = particlesCtx.createRadialGradient(p.x, p.y, 0, p.x, p.y, Math.max(6, p.size*6));
      grad.addColorStop(0, `rgba(255,245,200,${alpha})`);
      grad.addColorStop(0.2, `rgba(255,215,120,${alpha*0.9})`);
      grad.addColorStop(0.6, `rgba(210,176,74,${alpha*0.2})`);
      grad.addColorStop(1, `rgba(0,0,0,0)`);
      particlesCtx.fillStyle = grad;
      particlesCtx.fillRect(p.x - p.size*6, p.y - p.size*6, p.size*12, p.size*12);
      if(p.life <= 0) particlePool.splice(i,1);
    }

    // mask particles to hand
    particlesCtx.globalCompositeOperation = 'destination-in';
    particlesCtx.drawImage(maskedHandCanvas,0,0);
    particlesCtx.globalCompositeOperation = 'source-over';

    particleAnim = requestAnimationFrame(step);
  }
  step();
}


// Sweeping scan overlay; draws a moving linear-gradient stripe masked to the hand
let scanHandle = null;
function startScan(maskedHandCanvas){
  if(scanHandle) cancelAnimationFrame(scanHandle);
  const w = scan.width, h = scan.height;
  let s = 0;
  function step(){
    s += 0.01;
    scanCtx.clearRect(0,0,w,h);
    // gradient stripe moves across diagonally
    const stripe = scanCtx.createLinearGradient(-w + (s % 2) * (2*w), -h, w + (s % 2) * (2*w), h);
    stripe.addColorStop(0, 'rgba(120,40,180,0)');
    stripe.addColorStop(0.45, 'rgba(120,40,180,0.06)');
    stripe.addColorStop(0.5, 'rgba(255,215,120,0.12)');
    stripe.addColorStop(0.55, 'rgba(120,40,180,0.06)');
    stripe.addColorStop(1, 'rgba(120,40,180,0)');

    scanCtx.fillStyle = stripe;
    scanCtx.fillRect(0,0,w,h);

    // mask the scan to the hand area so it only scans the hand
    scanCtx.globalCompositeOperation = 'destination-in';
    scanCtx.drawImage(maskedHandCanvas,0,0);
    scanCtx.globalCompositeOperation = 'source-over';

    scanHandle = requestAnimationFrame(step);
  }
  step();
}

// graceful shutdown
window.addEventListener('beforeunload', ()=>{contrastWorker.terminate();segmentWorker.terminate();if(stream) stopCamera();});
