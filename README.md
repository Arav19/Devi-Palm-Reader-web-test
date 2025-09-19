# Devi Palm Reader

Simple web demo that captures a photo of your palm and applies a glowing crease-line effect. It uses two Web Workers:

- `worker_contrast.js` — computes a high-contrast binary map (creases as black on white) via Sobel edge detection and thresholding.
- `worker_segment.js` — generates a hand mask (from landmarks if supplied, otherwise a skin-color heuristic) so the glow only appears on the hand.

The main thread composes the original image, mask, and crease map and animates a glowing, spiritual-style effect on the palm lines.

How to run

1. Serve the folder over a local HTTP server (required for camera access). With Python 3 installed:

```powershell
cd "e:\Devi Hand Web Test"
python -m http.server 8000
```

2. Open `http://localhost:8000` in Chrome or Edge (or any browser with camera + OffscreenCanvas support). Allow camera access.

Notes
- The demo initializes MediaPipe Hands in the main thread (if available) to compute landmarks and sends them to `worker_segment.js` for higher-quality masks. If MediaPipe isn't available the worker falls back to a simple skin-color heuristic.
- For best results, use a plain background and good lighting.
- This demo runs fully in-browser; no data leaves your machine.
