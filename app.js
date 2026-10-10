const LIMBS = [13, 14, 15, 16, 25, 26, 27, 28];
const WRISTS = [15, 16], ANKLES = [27, 28];
const vis = p => !!p && (p.v ?? 1) > 0.4;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function summarize(lm, aspect) {
  const pick = [11, 12, 23, 24].map(i => lm[i]).filter(vis);
  if (pick.length < 2) return null;
  const c = { x: pick.reduce((a, p) => a + p.x, 0) / pick.length * aspect, y: pick.reduce((a, p) => a + p.y, 0) / pick.length };
  const v = lm.filter(vis), ys = v.map(p => p.y), xs = v.map(p => p.x * aspect);
  const h = Math.max(...ys) - Math.min(...ys), w = Math.max(...xs) - Math.min(...xs);
  const sh = vis(lm[11]) && vis(lm[12]) ? dist({ x: lm[11].x * aspect, y: lm[11].y }, { x: lm[12].x * aspect, y: lm[12].y }) * 2.2 : 0;
  return { c, scale: Math.max(sh, h * 0.5, w * 0.5, 0.015) };
}
class Detector {
  constructor() { this.sens = 5; this.reset(); }
  reset() { this.people = []; this.nextId = 1; this.pairEma = 0; this.actEma = 0; this.hist = []; this.lastT = 0; }
  update(poses, t, aspect) {
    const dt = this.lastT ? Math.min(Math.max(t - this.lastT, 0.03), 0.5) : 0.1; this.lastT = t;
    const cur = [];
    for (const lm of poses) {
      const s = summarize(lm, aspect); if (!s) continue;
      let best = null, bd = 1e9;
      for (const p of this.people) { const d = dist(p.c, s.c); if (d < bd && d < 0.4 && !cur.find(q => q.id === p.id)) { bd = d; best = p; } }
      let speed = 0;
      if (best && best.prevLm) {
        const tdx = s.c.x - best.c.x, tdy = s.c.y - best.c.y;
        for (const i of LIMBS) { const a = lm[i], b = best.prevLm[i]; if (!vis(a) || !vis(b)) continue;
          speed = Math.max(speed, Math.hypot((a.x - b.x) * aspect - tdx, a.y - b.y - tdy) / s.scale / dt); }
      }
      const sm = best ? best.speed * 0.5 + speed * 0.5 : 0;
      cur.push({ id: best ? best.id : this.nextId++, c: s.c, scale: s.scale, lm, speed: sm, prevLm: lm });
    }
    this.people = cur;
    const fast = 2.2 + (10 - this.sens) * 0.25;
    this.actEma = this.actEma * 0.8 + (cur.some(p => p.speed > fast) ? 1 : 0) * 0.2;
    let pairHit = 0, closePair = false;
    for (let i = 0; i < cur.length; i++) for (let j = i + 1; j < cur.length; j++) {
      const A = cur[i], B = cur[j], d = dist(A.c, B.c) / ((A.scale + B.scale) / 2);
      if (d > 2.4) continue; closePair = true;
      const reach = this.reaches(A, B, aspect) || this.reaches(B, A, aspect);
      if (Math.max(A.speed, B.speed) > fast && (reach || d < 1.4)) pairHit = Math.max(pairHit, reach ? 1 : 0.7);
    }
    this.pairEma = this.pairEma * 0.85 + pairHit * 0.15;
    this.hist.push(pairHit > 0 ? 1 : 0); if (this.hist.length > 25) this.hist.shift();
    const burst = this.hist.reduce((a, b) => a + b, 0) / Math.max(this.hist.length, 1);
    const thr = 0.30 - this.sens * 0.018, alert = this.pairEma > thr && burst > 0.35;
    const level = alert ? 'alert' : closePair && this.pairEma > thr * 0.5 ? 'watch' : cur.length ? (this.actEma > 0.4 ? 'active' : 'calm') : 'none';
    return { count: cur.length, level, alert, pair: this.pairEma };
  }
  reaches(A, B, aspect) {
    if (![11, 12, 23, 24].some(i => vis(B.lm[i]))) return false;
    for (const i of [...WRISTS, ...ANKLES]) { const p = A.lm[i]; if (!vis(p)) continue;
      if (dist({ x: p.x * aspect, y: p.y }, B.c) < B.scale * 0.9 && A.speed > 1.2) return true; }
    return false;
  }
}
const $ = id => document.getElementById(id);
const LINKS = [[11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],[23,24],[23,25],[25,27],[24,26],[26,28]];
const LABEL = { none: 'Koi insaan nahi dikha', calm: 'Shaant', active: 'Koi tez hila raha hai', watch: 'Do log paas, nazar rakho', alert: 'ALERT: paas me tez maar-peet jaisi movement' };
const det = new Detector(); let pl = null, stream = null, raf = 0, running = false, busy = false, al = { on: false, start: 0, cool: 0 };
const v = $('v'), o = $('o'), ctx = o.getContext('2d'); const tile = document.createElement('canvas'), tctx = tile.getContext('2d');
function setStatus(t) { $('status').textContent = t; }
$('sens').parentElement.insertAdjacentHTML('afterend', '<p><label><input type="checkbox" id="far" checked> Door ke log mode (zyada tiles, thoda slow)</label></p><p><label><input type="checkbox" id="deep"> Bahut door (9 tiles, bahut slow)</label></p><label>Zoom: <span id="zv">1.0x</span><input id="zoom" type="range" min="10" max="40" value="10"></label><p id="fps" style="color:#666"></p>');
$('zoom').oninput = () => { $('zv').textContent = (+$('zoom').value / 10).toFixed(1) + 'x'; };
async function init() {
  try {
    setStatus('Model load ho raha hai (10-20 sec)...');
    const MPV = await import('./4-vision_bundle.mjs'); window.__mpv = MPV; window.__fs = { wasmLoaderPath: new URL('./5-vision_wasm_internal.js', location.href).href, wasmBinaryPath: new URL('./7-vision_wasm_internal.wasm', location.href).href }; const { PoseLandmarker } = MPV;
    const fs = { wasmLoaderPath: new URL('./5-vision_wasm_internal.js', location.href).href, wasmBinaryPath: new URL('./7-vision_wasm_internal.wasm', location.href).href };
    const opt = d => ({ baseOptions: { modelAssetPath: new URL('./6-pose.task', location.href).href, delegate: d }, runningMode: 'IMAGE', numPoses: 6, minPoseDetectionConfidence: 0.3, minPosePresenceConfidence: 0.3, minTrackingConfidence: 0.3 });
    try { pl = await PoseLandmarker.createFromOptions(fs, opt('GPU')); window.__delegate = 'GPU'; } catch (e) { pl = await PoseLandmarker.createFromOptions(fs, opt('CPU')); window.__delegate = 'CPU'; }
    try { pdet = await MPV.ObjectDetector.createFromOptions(window.__fs, { baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float32/latest/efficientdet_lite0.tflite', delegate: 'CPU' }, runningMode: 'IMAGE', scoreThreshold: 0.3, maxResults: 30, categoryAllowlist: ['person'] }); window.__pgate = 'on'; } catch (e) { pdet = null; window.__pgate = 'off ' + e; }
    window.__model = 'ready'; setStatus('Ready. Camera start karo.'); $('start').disabled = false; $('file').disabled = false;
  } catch (e) { window.__model = 'fail ' + e; setStatus('Model load fail: ' + (e && e.message || e)); }
}
function passes(W, H, zoom, far) {
  const rw = W / zoom, rh = H / zoom, rx = (W - rw) / 2, ry = (H - rh) / 2, list = [{ x: rx, y: ry, w: rw, h: rh, edge: [1, 1, 1, 1] }];
  if (far) { const deep = $('deep').checked, n = deep ? 3 : 2, f = deep ? 0.4 : 0.6, tw = rw * f, th = rh * f; for (let ix = 0; ix < n; ix++) for (let iy = 0; iy < n; iy++) list.push({ x: rx + ix * (rw - tw) / (n - 1), y: ry + iy * (rh - th) / (n - 1), w: tw, h: th, edge: [ix === 0, iy === 0, ix === n - 1, iy === n - 1].map(Number) }); }
  return list;
}
let pdet = null;
function gateOK(lm, pts, boxes, tw, th) {
  const vis = pts.filter(p => p.v > 0.6).length, vp = pts.filter(p => p.v > 0.5); window.__g = window.__g || { in: 0, kv: 0, kp: 0, kd: 0 }; window.__g.in++; if (vis < 5) { window.__g.kv++; return false; }
  const sh = [pts[11], pts[12]], hp = [pts[23], pts[24]]; if (sh[0].v < 0.4 || sh[1].v < 0.4) { window.__g.kv++; return false; }
  const sw = Math.hypot((sh[0].tx - sh[1].tx) * tw, (sh[0].ty - sh[1].ty) * th), mh = { x: (hp[0].tx + hp[1].tx) / 2 * tw, y: (hp[0].ty + hp[1].ty) / 2 * th }, ms = { x: (sh[0].tx + sh[1].tx) / 2 * tw, y: (sh[0].ty + sh[1].ty) / 2 * th };
  const tl = Math.hypot(mh.x - ms.x, mh.y - ms.y); if (sw < 3 || tl / sw < 0.3 || tl / sw > 5) { window.__g.kp++; return false; }
  const xs = vp.map(p => p.tx * tw), ys = vp.map(p => p.ty * th), bw = Math.max(...xs) - Math.min(...xs), bh = Math.max(...ys) - Math.min(...ys); if (bh / Math.max(bw, 1) < 0.25 && bw / Math.max(bh, 1) < 0.25) return false;
  if (!pdet) return true;
  const cx = (ms.x + mh.x) / 2, cy = (ms.y + mh.y) / 2;
  if (boxes.some(b => cx > b.x1 && cx < b.x2 && cy > b.y1 && cy < b.y2)) return true;
  window.__g.kd++; return false;
}
function detectAll(W, H, zoom, far) {
  const found = [];
  for (const P of passes(W, H, zoom, far)) {
    tile.width = Math.round(Math.min(960, Math.max(P.w, 480))); tile.height = Math.round(tile.width * P.h / P.w);
    tctx.drawImage(v, P.x, P.y, P.w, P.h, 0, 0, tile.width, tile.height);
    const res = pl.detect(tile);
    let pboxes = []; if (pdet) { try { pboxes = pdet.detect(tile).detections.map(d => ({ x1: d.boundingBox.originX - 0.05 * d.boundingBox.width, y1: d.boundingBox.originY - 0.05 * d.boundingBox.height, x2: d.boundingBox.originX + 1.05 * d.boundingBox.width, y2: d.boundingBox.originY + 1.05 * d.boundingBox.height })); } catch (e) {} }
    for (const lm of (res.landmarks || [])) {
      const pts = lm.map(q => ({ x: (P.x + q.x * P.w) / W, y: (P.y + q.y * P.h) / H, v: q.visibility ?? 1, tx: q.x, ty: q.y }));
      if (!gateOK(lm, pts, pboxes, tile.width, tile.height)) continue;
      const torso = [11, 12, 23, 24].map(i => pts[i]).filter(p => p.v > 0.4); if (torso.length < 2) continue;
      const cx = torso.reduce((a, p) => a + p.tx, 0) / torso.length, cy = torso.reduce((a, p) => a + p.ty, 0) / torso.length, m = 0.04;
      if ((cx < m && !P.edge[0]) || (cx > 1 - m && !P.edge[2]) || (cy < m && !P.edge[1]) || (cy > 1 - m && !P.edge[3])) continue;
      const vp = pts.filter(p => p.v > 0.4), ys = vp.map(p => p.y), xs = vp.map(p => p.x);
      found.push({ pts, c: { x: torso.reduce((a, p) => a + p.x, 0) / torso.length, y: torso.reduce((a, p) => a + p.y, 0) / torso.length }, h: Math.max(...ys) - Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), conf: pts.reduce((a, p) => a + p.v, 0) / pts.length });
    }
  }
  found.sort((a, b) => b.conf - a.conf); const keep = [];
  for (const f of found) { const sz = Math.max(f.h, f.w, 0.02); if (!keep.some(k => Math.hypot((k.c.x - f.c.x) * W / H, k.c.y - f.c.y) < 0.5 * Math.max(sz, k.h, k.w))) keep.push(f); }
  return keep;
}
let actx = null;
function unlockAudio() { try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); actx.resume(); const s = actx.createBufferSource(); s.buffer = actx.createBuffer(1, 1, 22050); s.connect(actx.destination); s.start(0); } catch (e) {} }
function beep() {
  try { navigator.vibrate && navigator.vibrate([500, 150, 500, 150, 500]); } catch (e) {}
  if (!$('snd').checked || !actx) return;
  try { actx.resume(); const t0 = actx.currentTime, dur = 5, comp = actx.createDynamicsCompressor(), g = actx.createGain(); g.gain.value = 1.0; comp.connect(g); g.connect(actx.destination);
    for (const type of ['square', 'sawtooth']) { const o = actx.createOscillator(); o.type = type; const og = actx.createGain(); og.gain.value = type === 'square' ? 0.7 : 0.5; o.connect(og); og.connect(comp);
      for (let k = 0; k < dur / 0.4; k++) { o.frequency.setValueAtTime(k % 2 ? 1250 : 700, t0 + k * 0.4); o.frequency.linearRampToValueAtTime(k % 2 ? 700 : 1250, t0 + k * 0.4 + 0.38); }
      o.start(t0); o.stop(t0 + dur); }
    window.__sirenAt = Date.now(); } catch (e) { window.__sirenErr = String(e); }
}
function step(ts) {
  if (v.readyState < 2 || !v.videoWidth) return null;
  const W = v.videoWidth, H = v.videoHeight; if (o.width !== W) { o.width = W; o.height = H; }
  const zoom = +$('zoom').value / 10, far = $('far').checked;
  const t0 = performance.now(); const people = detectAll(W, H, zoom, far); const ms = performance.now() - t0;
  const poses = people.map(p => p.pts.map(q => ({ x: q.x, y: q.y, v: q.v })));
  det.sens = +$('sens').value;
  const r = det.update(poses, ts / 1000, W / H);
  ctx.clearRect(0, 0, W, H); ctx.lineWidth = Math.max(2, W / 250);
  if (zoom > 1) { ctx.strokeStyle = '#ffd60a'; ctx.strokeRect(W * (1 - 1 / zoom) / 2, H * (1 - 1 / zoom) / 2, W / zoom, H / zoom); }
  poses.forEach((p, i) => { ctx.strokeStyle = r.alert ? '#ff3b30' : ['#34c759', '#0a84ff', '#ff9f0a', '#bf5af2', '#64d2ff'][i % 5];
    for (const [a, b] of LINKS) { if ((p[a].v ?? 1) < 0.4 || (p[b].v ?? 1) < 0.4) continue; ctx.beginPath(); ctx.moveTo(p[a].x * W, p[a].y * H); ctx.lineTo(p[b].x * W, p[b].y * H); ctx.stroke(); } });
  $('fps').textContent = (far ? 'Door mode: ' : 'Normal: ') + Math.round(ms) + ' ms/frame (' + (1000 / Math.max(ms, 1)).toFixed(1) + ' fps)';
  return { r, poses, ms };
}
function loop() {
  const tick = () => { raf = requestAnimationFrame(tick); if (!running || busy) return;
    if (v.ended) { stopAll('Clip khatam.'); return; }
    busy = true; let p;
    try { p = Promise.resolve($('mode').value === 'helmet' ? stepHelmet() : step(performance.now())); } catch (e) { busy = false; return; }
    p.then(out => { busy = false; if (!out) return; handle(out); }).catch(e => { busy = false; window.__lastErr = String(e); setStatus('Error: ' + (e && e.message || e)); });
  };
  raf = requestAnimationFrame(tick);
}
function handle(out) {
  const r = out.r; let lvl = r.level;
  if (r.alert) { if (!al.on) { al.on = true; al.start = Date.now(); beep(); } al.cool = 0; lvl = 'alert'; }
  else if (al.on && ++al.cool > (out.helmet ? 3 : 8)) { al.on = false; if (!out.helmet) { const li = document.createElement('li'); li.textContent = new Date(al.start).toLocaleTimeString() + ' par, ' + Math.max(1, Math.round((Date.now() - al.start) / 1000)) + ' sec'; $('log').prepend(li); $('nolog').hidden = true; } }
  else if (al.on) lvl = 'alert';
  $('cam').className = 'cam ' + (lvl === 'alert' ? 'alert' : '');
  $('badge').textContent = out.text || (LABEL[lvl] + (r.count ? ' (' + r.count + ' log)' : '')); $('badge').hidden = false;
}
function stopAll(msg) { running = false; cancelAnimationFrame(raf); if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; } v.pause(); v.srcObject = null; det.reset(); al = { on: false, start: 0, cool: 0 }; $('badge').hidden = true; $('cam').className = 'cam'; $('start').textContent = 'Camera start karo'; setStatus(msg || 'Band.'); }
$('start').onclick = async () => {
  unlockAudio(); if (running) return stopAll();
  try { stopAll(); stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: $('front').checked ? 'user' : 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    v.srcObject = stream; await v.play(); running = true; $('start').textContent = 'Band karo'; setStatus('Chal raha hai. Video kahin upload nahi ho raha.'); loop();
  } catch (e) { setStatus('Camera nahi khula: ' + (e.name || e) + '. Chrome me Allow dabao.'); }
};
$('file').onchange = async e => { const f = e.target.files[0]; if (!f) return; unlockAudio(); stopAll(); v.src = URL.createObjectURL(f); v.muted = true; v.loop = false; try { await v.play(); running = true; setStatus('Clip chal rahi hai...'); loop(); } catch { setStatus('Ye video play nahi hua.'); } e.target.value = ''; };
$('sens').parentElement.insertAdjacentHTML('afterend', '<p><button id="tsiren" type="button">Siren test (volume max karo)</button></p>'); $('tsiren').onclick = () => { unlockAudio(); beep(); };
window.__step = step; window.__det = det; window.__v = v;

// ---- Helmet + number plate mode (private concept test) ----
const HELMET_PARTS = ['./1-hpart0.bin', './2-hpart1.bin'];
const EFFDET_URL = 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float32/latest/efficientdet_lite0.tflite';
const ORT_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/';
const LPR_BASE = 'https://cdn.jsdelivr.net/gh/OpenIPC/lpr-wasm@v0.1.0/dist/';
let hsess = null, odet = null, lprReader = null, lprBusy = false, hInit = null; const recent = [];
const hcan = document.createElement('canvas'); hcan.width = hcan.height = 640; const hctx = hcan.getContext('2d', { willReadFrequently: true });
function loadScript(u) { return new Promise((ok, no) => { const s = document.createElement('script'); s.src = u; s.onload = ok; s.onerror = () => no(new Error('load ' + u)); document.head.appendChild(s); }); }
function initHelmet() {
  if (hInit) return hInit;
  hInit = (async () => {
    setStatus('Helmet model load ho raha hai (40 MB, pehli baar 1-2 min)...');
    await loadScript(ORT_BASE + 'ort.wasm.min.js'); ort.env.wasm.wasmPaths = ORT_BASE; ort.env.wasm.numThreads = 1;
    const parts = await Promise.all(HELMET_PARTS.map(u => fetch(u + '?v=1').then(r => { if (!r.ok) throw new Error('model part ' + r.status); return r.arrayBuffer(); })));
    const buf = new Uint8Array(parts[0].byteLength + parts[1].byteLength); buf.set(new Uint8Array(parts[0]), 0); buf.set(new Uint8Array(parts[1]), parts[0].byteLength);
    hsess = await ort.InferenceSession.create(buf, { executionProviders: ['wasm'] });
    const MPV = window.__mpv;
    try { odet = await MPV.ObjectDetector.createFromOptions(window.__fs, { baseOptions: { modelAssetPath: EFFDET_URL, delegate: 'GPU' }, runningMode: 'IMAGE', scoreThreshold: 0.25, maxResults: 20 }); }
    catch (e) { odet = await MPV.ObjectDetector.createFromOptions(window.__fs, { baseOptions: { modelAssetPath: EFFDET_URL, delegate: 'CPU' }, runningMode: 'IMAGE', scoreThreshold: 0.25, maxResults: 20 }); }
    window.__helmet = 'ready'; setStatus('Helmet mode ready.');
  })().catch(e => { hInit = null; window.__helmet = 'fail ' + e; setStatus('Helmet mode load fail: ' + (e && e.message || e)); throw e; });
  return hInit;
}
function nmsBoxes(list, thr) { list.sort((a, b) => b.s - a.s); const keep = []; for (const d of list) { if (!keep.some(k => { const x = Math.max(0, Math.min(d.x2, k.x2) - Math.max(d.x1, k.x1)), y = Math.max(0, Math.min(d.y2, k.y2) - Math.max(d.y1, k.y1)), i = x * y; return i / ((d.x2 - d.x1) * (d.y2 - d.y1) + (k.x2 - k.x1) * (k.y2 - k.y1) - i) > thr; })) keep.push(d); } return keep; }
async function runHelmet(P, W, H, conf) {
  const sc = Math.min(640 / P.w, 640 / P.h), nw = P.w * sc, nh = P.h * sc, dx = (640 - nw) / 2, dy = (640 - nh) / 2;
  hctx.fillStyle = '#727272'; hctx.fillRect(0, 0, 640, 640); hctx.drawImage(v, P.x, P.y, P.w, P.h, dx, dy, nw, nh);
  const d = hctx.getImageData(0, 0, 640, 640).data, n = 640 * 640, f = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) { f[i] = d[i * 4] / 255; f[n + i] = d[i * 4 + 1] / 255; f[2 * n + i] = d[i * 4 + 2] / 255; }
  const out = await hsess.run({ images: new ort.Tensor('float32', f, [1, 3, 640, 640]) }); const o = out[Object.keys(out)[0]].data, N = 8400, res = [];
  for (let i = 0; i < N; i++) { const c0 = o[4 * N + i], c1 = o[5 * N + i], s = Math.max(c0, c1); if (s < conf) continue; const cx = o[i], cy = o[N + i], w = o[2 * N + i], h = o[3 * N + i];
    res.push({ x1: (cx - w / 2 - dx) / sc + P.x, y1: (cy - h / 2 - dy) / sc + P.y, x2: (cx + w / 2 - dx) / sc + P.x, y2: (cy + h / 2 - dy) / sc + P.y, s, no: c1 > c0 }); }
  return nmsBoxes(res, 0.45);
}
async function stepHelmet() {
  if (!hsess) { await initHelmet(); }
  if (v.readyState < 2 || !v.videoWidth) return null;
  const W = v.videoWidth, H = v.videoHeight; if (o.width !== W) { o.width = W; o.height = H; }
  const zoom = +$('zoom').value / 10, far = $('far').checked, t0 = performance.now();
  const rw = W / zoom, rh = H / zoom, rx = (W - rw) / 2, ry = (H - rh) / 2, regs = [{ x: rx, y: ry, w: rw, h: rh }];
  if (far) for (const ix of [0, 1]) for (const iy of [0, 1]) regs.push({ x: rx + ix * rw * 0.4, y: ry + iy * rh * 0.4, w: rw * 0.6, h: rh * 0.6 });
  let heads = []; for (const P of regs) heads = heads.concat(await runHelmet(P, W, H, 0.35)); heads = nmsBoxes(heads, 0.4);
  const det = odet.detect(v); const bikes = det.detections.filter(d => d.categories[0].categoryName === 'motorcycle').map(d => ({ x1: d.boundingBox.originX, y1: d.boundingBox.originY, x2: d.boundingBox.originX + d.boundingBox.width, y2: d.boundingBox.originY + d.boundingBox.height, s: d.categories[0].score }));
  const viol = [], ok = [], other = [];
  for (const h of heads) { const cx = (h.x1 + h.x2) / 2, cy = (h.y1 + h.y2) / 2; const bike = bikes.find(b => { const bw = b.x2 - b.x1, bh = b.y2 - b.y1; return cx > b.x1 - 0.15 * bw && cx < b.x2 + 0.15 * bw && cy > b.y1 - 0.9 * bh && cy < b.y2; });
    if (bike) (h.no ? viol : ok).push({ h, bike }); else other.push(h); }
  ctx.clearRect(0, 0, W, H); ctx.lineWidth = Math.max(2, W / 250);
  ctx.strokeStyle = '#ffd60a'; for (const b of bikes) ctx.strokeRect(b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1);
  ctx.setLineDash([6, 6]); ctx.strokeStyle = '#999'; for (const h of other) ctx.strokeRect(h.x1, h.y1, h.x2 - h.x1, h.y2 - h.y1); ctx.setLineDash([]);
  ctx.strokeStyle = '#34c759'; for (const { h } of ok) ctx.strokeRect(h.x1, h.y1, h.x2 - h.x1, h.y2 - h.y1);
  ctx.strokeStyle = '#ff3b30'; for (const { h } of viol) ctx.strokeRect(h.x1, h.y1, h.x2 - h.x1, h.y2 - h.y1);
  const now = Date.now(); let fresh = false;
  for (const { h, bike } of viol) { const cx = (bike.x1 + bike.x2) / 2, cy = (bike.y1 + bike.y2) / 2; if (recent.some(r => now - r.t < 4000 && Math.hypot(r.x - cx, r.y - cy) < Math.max(80, (bike.x2 - bike.x1)))) continue; recent.push({ t: now, x: cx, y: cy }); fresh = true; logViolation(bike, W, H); }
  const ms = performance.now() - t0; $('fps').textContent = 'Helmet mode: ' + Math.round(ms) + ' ms/frame (' + (1000 / Math.max(ms, 1)).toFixed(1) + ' fps), bikes ' + bikes.length;
  const text = viol.length ? 'ALERT: bina helmet bike sawar (' + viol.length + ')' : bikes.length ? 'Bike dikhi, helmet theek / dikh nahi raha' : 'Koi bike nahi dikhi';
  return { r: { level: viol.length ? 'alert' : 'calm', alert: viol.length > 0, count: heads.length }, helmet: true, text, fresh, viol: viol.length, heads: heads.length, bikes: bikes.length };
}
function logViolation(bike, W, H) {
  const pw = (bike.x2 - bike.x1), ph = (bike.y2 - bike.y1), x = Math.max(0, bike.x1 - pw * 0.25), y = Math.max(0, bike.y1 - ph * 0.9), w = Math.min(W - x, pw * 1.5), h = Math.min(H - y, ph * 1.9);
  const c = document.createElement('canvas'); const sc = Math.min(2.5, Math.max(1, 640 / w)); c.width = Math.round(w * sc); c.height = Math.round(h * sc); c.getContext('2d').drawImage(v, x, y, w, h, 0, 0, c.width, c.height);
  c.style.cssText = 'max-width:160px;border-radius:8px;display:block'; const li = document.createElement('li'); li.style.margin = '8px 0';
  const t = document.createElement('div'); t.textContent = new Date().toLocaleTimeString() + ' - bina helmet. Plate: padh raha hu...'; li.append(c, t); $('log').prepend(li); $('nolog').hidden = true;
  readPlate(c).then(r => { t.textContent = new Date().toLocaleTimeString() + ' - bina helmet. Plate: ' + r; }).catch(e => { t.textContent = new Date().toLocaleTimeString() + ' - bina helmet. Plate: padh nahi paya (' + (e && e.message || e) + ')'; });
}
async function readPlate(canvas) {
  while (lprBusy) await new Promise(r => setTimeout(r, 200)); lprBusy = true;
  try {
    if (!lprReader) { const m = await import(LPR_BASE + 'lpr.js'); lprReader = await m.open({ base: LPR_BASE }); }
    const found = await lprReader.readAll(canvas); window.__plates = found;
    if (!found.length) return 'koi plate nahi mili (door/blur/andhera)';
    const b = found[0]; return b.confident ? b.text + ' (bharosa ' + Math.round(b.minConf * 100) + '%)' : 'saaf nahi padha, andaza: ' + b.text + ' (bharosa kam, ' + Math.round(b.minConf * 100) + '%)';
  } finally { lprBusy = false; }
}
// UI
$('status').insertAdjacentHTML('afterend', '<p><label>Mode: <select id="mode"><option value="pose">Ladai / maar-peet (pose)</option><option value="helmet">Bina helmet bike + number plate</option></select></label></p>');
$('mode').onchange = () => { if ($('mode').value === 'helmet') initHelmet().catch(() => {}); };
document.body.insertAdjacentHTML('beforeend', '<div class="warn" style="font-size:13px"><b>Helmet + plate mode (private concept test):</b> helmet model = Smolry/Helmet-classifer (YOLO11s, AGPL-3.0, Roboflow-forked dataset). Bike detection = MediaPipe EfficientDet-Lite0 (Apache-2.0). Plate = OpenIPC/lpr-wasm (code MIT, model weights CC BY-NC 4.0, non-commercial). Pose = MediaPipe BlazePose (Apache-2.0). Models browser me download hote hain, tumhari video kahin nahi jaati. In licences ke saath ye bechne layak nahi, sirf private test. Plate padhna sirf paas, saaf, din ki roshni me chalega; door, tez, blur ya raat me galat/khali aayega.</div>');
init();
