let captureGeneration=0,lastOverlayAt=0,nextDetectionAt=0;
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
$('sens').parentElement.insertAdjacentHTML('afterend', '<p><label><input type="checkbox" id="far"> Door ke log mode (zyada tiles, thoda slow)</label></p><p><label><input type="checkbox" id="deep"> Bahut door (9 tiles, bahut slow)</label></p><label>Zoom: <span id="zv">1.0x</span><input id="zoom" type="range" min="10" max="60" value="10"></label><p style="color:#666;font-size:13px">Door ke liye: zoom 3x-4x karo (ya 2 ungli se pinch). Jis ko dekhna hai use peele dabbe ke beech me rakho. ~15 m par 3x-4x chahiye.</p><p id="fps" style="color:#666"></p>');
$('zoom').oninput = () => { $('zv').textContent = (+$('zoom').value / 10).toFixed(1) + 'x'; };
{ let d0 = 0, z0 = 10; const dist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY); o.addEventListener('touchstart', e => { if (e.touches.length === 2) { d0 = dist(e.touches); z0 = +$('zoom').value; } }, { passive: true }); o.addEventListener('touchmove', e => { if (e.touches.length === 2 && d0) { $('zoom').value = Math.max(10, Math.min(60, Math.round(z0 * dist(e.touches) / d0))); $('zoom').oninput(); e.preventDefault(); } }, { passive: false }); o.addEventListener('touchend', () => { d0 = 0; }); }
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
  if (vis >= 15) return true; window.__g.kd++; return false;
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
let sAudio = null, sOn = false, sMute = 0, sTimer = 0;
function makeWav() { const sr = 22050, dur = 2, n = sr * dur, b = new ArrayBuffer(44 + n * 2), d = new DataView(b), w = (o, t) => { for (let i = 0; i < t.length; i++) d.setUint8(o + i, t.charCodeAt(i)); }; w(0, 'RIFF'); d.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); d.setUint32(16, 16, true); d.setUint16(20, 1, true); d.setUint16(22, 1, true); d.setUint32(24, sr, true); d.setUint32(28, sr * 2, true); d.setUint16(32, 2, true); d.setUint16(34, 16, true); w(36, 'data'); d.setUint32(40, n * 2, true);
  let ph = 0; for (let i = 0; i < n; i++) { const t = i / sr, on = (t % 0.2) < 0.11, x = (ph += 2 * Math.PI * 2900 / sr); const sq = Math.sign(Math.sin(x)) * 0.75 + Math.sin(x) * 0.25; d.setInt16(44 + i * 2, on ? Math.max(-1, Math.min(1, sq)) * 32000 : 0, true); } return URL.createObjectURL(new Blob([b], { type: 'audio/wav' })); }
function unlockAudio() { try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); actx.resume(); const s = actx.createBufferSource(); s.buffer = actx.createBuffer(1, 1, 22050); s.connect(actx.destination); s.start(0); } catch (e) {}
  try { if (!sAudio) { sAudio = new Audio(makeWav()); sAudio.loop = true; sAudio.preload = 'auto'; } sAudio.volume = 0; const p = sAudio.play(); if (p && p.then) p.then(() => { if (!sOn) { sAudio.pause(); sAudio.currentTime = 0; } sAudio.volume = 1; window.__audioOk = true; }).catch(e => { window.__audioErr = String(e); }); } catch (e) { window.__audioErr = String(e); } }
function sirenUI() { let b = document.getElementById('ack'); if (!b) { document.body.insertAdjacentHTML('beforeend', '<button id="ack" type="button" hidden style="position:fixed;left:8px;right:8px;bottom:8px;z-index:99;padding:18px;font-size:20px;background:#d00;color:#fff;border:0;border-radius:12px">SIREN BAND KARO (maine dekh liya)</button>'); b = document.getElementById('ack'); b.onclick = () => stopSiren(15000); } return b; }
function stopSiren(muteMs) { sOn = false; sMute = Date.now() + (muteMs || 0); try { sAudio && sAudio.pause(); } catch (e) {} clearTimeout(sTimer); sirenUI().hidden = true; }
function beep() { try { navigator.vibrate && navigator.vibrate([500, 150, 500, 150, 500]); } catch (e) {}
  if (!$('snd').checked || sOn || Date.now() < sMute) return; sOn = true; sirenUI().hidden = false; window.__sirenAt = Date.now(); sTimer = setTimeout(() => stopSiren(0), 90000);
  try { if (sAudio) { sAudio.volume = 1; const p = sAudio.play(); if (p && p.catch) p.catch(e => { window.__audioErr = String(e); setStatus('Siren block hua (' + (e.name || e) + '). Phone ka volume/silent switch dekho aur Siren test dabao.'); }); } } catch (e) { window.__sirenErr = String(e); }
  try { if (actx) { actx.resume(); const t0 = actx.currentTime, dur = 4, g = actx.createGain(); g.gain.value = 0.8; g.connect(actx.destination); const o2 = actx.createOscillator(); o2.type = 'square'; o2.frequency.value = 2900; const bg = actx.createGain(); o2.connect(bg); bg.connect(g); for (let k = 0; k < dur / 0.2; k++) { bg.gain.setValueAtTime(1, t0 + k * 0.2); bg.gain.setValueAtTime(0, t0 + k * 0.2 + 0.11); } o2.start(t0); o2.stop(t0 + dur); } } catch (e) { window.__sirenErr = String(e); }
}
function step(ts) {
  if (v.readyState < 2 || !v.videoWidth) return null;
  const W = v.videoWidth, H = v.videoHeight; if (o.width !== W || o.height !== H) { o.width = W; o.height = H; }
  const zoom = +$('zoom').value / 10, far = $('far').checked && !$('light').checked;
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
  const tick = () => { raf = requestAnimationFrame(tick); if (!running || busy || performance.now()<nextDetectionAt) return;
    if (v.ended) { stopAll('Clip khatam.'); return; }
    busy = true; let p; const tq = performance.now(),generation=captureGeneration;
    try { const md = $('mode').value; if (Date.now() - (window.__lastStep || 0) < Math.max($('light').checked ? 450 : 0, adaptiveGap)) { busy = false; return; } window.__lastStep = Date.now(); p = Promise.resolve(md === 'helmet' ? stepHelmet() : md === 'traffic' ? stepTraffic() : md === 'school' ? stepSchool() : md === 'objects' ? stepObjects() : step(performance.now())); } catch (e) { busy = false; return; }
    p.then(out => { busy = false; nextDetectionAt=performance.now()+Math.max(100,adaptiveGap); if (!out || generation!==captureGeneration || !running) {ctx.clearRect(0,0,o.width,o.height);return;} lastOverlayAt=Date.now(); autoTune(performance.now() - tq); handle(out); }).catch(e => { busy = false; window.__lastErr = String(e); setStatus('Error: ' + (e && e.message || e)); });
  };
  raf = requestAnimationFrame(tick);
}
function handle(out) {
  const r = out.r; let lvl = r.level;
  if (r.alert) { if (!al.on) { al.on = true; al.start = Date.now(); beep(); if (!out.helmet) addEvidence('Maar-peet jaisi movement (pose alert)', null, true); } al.cool = 0; lvl = 'alert'; }
  else if (al.on && ++al.cool > (out.helmet ? 3 : 8)) { al.on = false; if (!out.helmet) { const li = document.createElement('li'); li.textContent = new Date(al.start).toLocaleTimeString() + ' par, ' + Math.max(1, Math.round((Date.now() - al.start) / 1000)) + ' sec'; $('log').prepend(li); $('nolog').hidden = true; } }
  else if (al.on) lvl = 'alert';
  if (out.fresh) beep();
  $('cam').className = 'cam ' + (lvl === 'alert' ? 'alert' : '');
  $('badge').textContent = out.text || (LABEL[lvl] + (r.count ? ' (' + r.count + ' log)' : '')); $('badge').hidden = false;
}
function stopAll(msg) { captureGeneration++; try { stopSiren(0); } catch (e) {} running = false; cancelAnimationFrame(raf); if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; } v.pause(); v.srcObject = null; det.reset(); al = { on: false, start: 0, cool: 0 }; $('badge').hidden = true; $('cam').className = 'cam'; $('start').textContent = 'Camera start karo'; setStatus(msg || 'Band.'); }
$('start').onclick = async () => {
  unlockAudio(); if (running) return stopAll();
  try { stopAll(); stream = await openAdaptiveCamera(); v.srcObject = stream; await v.play(); resetCameraAdaptation(); running = true; $('start').textContent = 'Band karo'; setStatus('Chal raha hai. Video kahin upload nahi ho raha.'); loop();
  } catch (e) { setStatus('Camera nahi khula: ' + (e.name || e) + '. Chrome me Allow dabao.'); }
};
$('file').onchange = async e => { const f = e.target.files[0]; if (!f) return; unlockAudio(); stopAll(); cameraNote='uploaded video'; v.src = URL.createObjectURL(f); v.muted = true; v.loop = false; try { await v.play(); running = true; setStatus('Clip chal rahi hai...'); loop(); } catch (er) { setStatus('Ye video play nahi hua: ' + (er && er.message || er)); } e.target.value = ''; };
$('sens').parentElement.insertAdjacentHTML('afterend', '<p><button id="tsiren" type="button">Siren test (volume max karo)</button></p>'); $('tsiren').onclick = () => { unlockAudio(); stopSiren(0); setTimeout(beep, 150); };
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
  const W = v.videoWidth, H = v.videoHeight; if (o.width !== W || o.height !== H) { o.width = W; o.height = H; }
  const zoom = +$('zoom').value / 10, far = $('far').checked && !$('light').checked, t0 = performance.now();
  const rw = W / zoom, rh = H / zoom, rx = (W - rw) / 2, ry = (H - rh) / 2, regs = [{ x: rx, y: ry, w: rw, h: rh }];
  if (far) for (const ix of [0, 1]) for (const iy of [0, 1]) regs.push({ x: rx + ix * rw * 0.4, y: ry + iy * rh * 0.4, w: rw * 0.6, h: rh * 0.6 });
  let heads = []; for (const P of regs) heads = heads.concat(await runHelmet(P, W, H, 0.35)); heads = nmsBoxes(heads, 0.4);
  const headTest = $('hAny').checked; const det = headTest ? { detections: [] } : odet.detect(v); const bikes = det.detections.filter(d => d.categories[0].categoryName === 'motorcycle').map(d => ({ x1: d.boundingBox.originX, y1: d.boundingBox.originY, x2: d.boundingBox.originX + d.boundingBox.width, y2: d.boundingBox.originY + d.boundingBox.height, s: d.categories[0].score }));
  const viol = [], ok = [], other = [];
  for (const h of heads) { const cx = (h.x1 + h.x2) / 2, cy = (h.y1 + h.y2) / 2; const bike = bikes.find(b => { const bw = b.x2 - b.x1, bh = b.y2 - b.y1; return cx > b.x1 - 0.15 * bw && cx < b.x2 + 0.15 * bw && cy > b.y1 - 0.9 * bh && cy < b.y2; });
    if (bike) (h.no ? viol : ok).push({ h, bike }); else other.push(h); }
  if ($('hAny').checked) { for (const h of other.splice(0)) { const w = h.x2 - h.x1, hh = h.y2 - h.y1, fb = { x1: h.x1 - w, x2: h.x2 + w, y1: h.y1, y2: h.y2 + 3 * hh, s: h.s }; (h.no ? viol : ok).push({ h, bike: fb }); } }
  ctx.clearRect(0, 0, W, H); ctx.lineWidth = Math.max(2, W / 250); ctx.font = Math.max(14, W / 40) + 'px sans-serif';
  if (zoom > 1) { ctx.strokeStyle = '#ffd60a'; ctx.setLineDash([10, 6]); ctx.strokeRect(rx, ry, rw, rh); ctx.setLineDash([]); }
  ctx.strokeStyle = '#ffd60a'; for (const b of bikes) ctx.strokeRect(b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1);
  ctx.setLineDash([6, 6]); ctx.strokeStyle = '#999'; for (const h of other) ctx.strokeRect(h.x1, h.y1, h.x2 - h.x1, h.y2 - h.y1); ctx.setLineDash([]);
  ctx.strokeStyle = '#34c759'; for (const { h } of ok) ctx.strokeRect(h.x1, h.y1, h.x2 - h.x1, h.y2 - h.y1);
  ctx.strokeStyle = '#ff3b30'; for (const { h } of viol) ctx.strokeRect(h.x1, h.y1, h.x2 - h.x1, h.y2 - h.y1);
  const lab = (h, t, c) => { ctx.fillStyle = c; const tw = ctx.measureText(t).width + 6; ctx.fillRect(h.x1, Math.max(0, h.y1 - 20), tw, 20); ctx.fillStyle = '#fff'; ctx.fillText(t, h.x1 + 3, Math.max(15, h.y1 - 5)); }; for (const { h } of ok) lab(h, 'HELMET ' + Math.round(h.s * 100) + '%', '#1a7f37'); for (const { h } of viol) lab(h, 'NO HELMET ' + Math.round(h.s * 100) + '%', '#ff3b30'); for (const h of other) lab(h, 'sir ' + (h.no ? 'bina helmet' : 'helmet') + ' (bike nahi)', '#666');
  const now = Date.now(); let fresh = false;
  for (const { h, bike } of viol) { const cx = (bike.x1 + bike.x2) / 2, cy = (bike.y1 + bike.y2) / 2; if (recent.some(r => now - r.t < 4000 && Math.hypot(r.x - cx, r.y - cy) < Math.max(80, (bike.x2 - bike.x1)))) continue; recent.push({ t: now, x: cx, y: cy }); fresh = true; logViolation(bike, W, H, headTest); }
  const ms = performance.now() - t0; $('fps').textContent = (headTest ? 'Sir test: ' : 'Helmet road: ') + Math.round(ms) + ' ms/frame (' + (1000 / Math.max(ms, 1)).toFixed(1) + ' fps), bikes ' + bikes.length;
  const text = viol.length ? (headTest ? 'ALERT: bina helmet sir (test, bike verify nahi)' : 'ALERT: bina helmet bike sawar') + ' (' + viol.length + ')'  : bikes.length ? 'Bike dikhi, helmet theek / dikh nahi raha' : heads.length ? 'Sir dikhe (' + heads.length + '), koi bina-helmet nahi' : 'Koi sir / bike nahi dikha';
  return { r: { level: viol.length ? 'alert' : 'calm', alert: viol.length > 0, count: heads.length }, helmet: true, text, fresh, viol: viol.length, heads: heads.length, bikes: bikes.length };
}
function logViolation(bike, W, H, headTest = false) {
  addEvidence(headTest ? 'Bina helmet sir (test, bike verify nahi)' : 'Bina helmet bike sawar', bike, headTest);
  if (headTest) return;
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
$('far').parentElement.insertAdjacentHTML('afterend', '<p><label><input type="checkbox" id="hAny"> Sirf model-test (road alert nahi): bike ke bina sir dekho. Sadak ke liye ise OFF rakho.</label></p>');
$('mode').onchange = () => { if ($('mode').value === 'helmet') initHelmet().catch(() => {}); };
document.body.insertAdjacentHTML('beforeend', '<div class="warn" style="font-size:13px"><b>Helmet + plate mode (private concept test):</b> helmet model = Smolry/Helmet-classifer (YOLO11s, AGPL-3.0, Roboflow-forked dataset). Bike detection = MediaPipe EfficientDet-Lite0 (Apache-2.0). Plate = OpenIPC/lpr-wasm (code MIT, model weights CC BY-NC 4.0, non-commercial). Pose = MediaPipe BlazePose (Apache-2.0). Models browser me download hote hain, tumhari video kahin nahi jaati. In licences ke saath ye bechne layak nahi, sirf private test. Plate padhna sirf paas, saaf, din ki roshni me chalega; door, tez, blur ya raat me galat/khali aayega.</div>');
// ---- Extras: camera switch, photo input, traffic mode, evidence, light mode ----
let vdet = null, vInit = null; const tracks = []; let nextTid = 1, cal = null, calPts = [], calOn = false; const ring = [];
$('mode').insertAdjacentHTML('beforeend', '<option value="traffic">Traffic: gaadi + speed</option>');
$('start').insertAdjacentHTML('afterend', '<button id="flip" type="button" style="margin-left:6px;background:#555">Camera badlo (front/back)</button><label class="btn" style="background:#555;margin-left:6px">Gallery se photo<input id="photo" type="file" accept="image/*" style="display:none"></label>');
$('front').parentElement.insertAdjacentHTML('afterend', '<label><input type="checkbox" id="light"> Light AI mode (camera quality alag, detection dheere)</label>');
$('cam').insertAdjacentHTML('afterend', '<div id="tpanel" hidden style="background:#eef;padding:8px;border-radius:8px;margin:8px 0;font-size:14px"><b>Traffic setup</b><br>Speed limit (km/h): <input id="lim" type="number" value="40" style="width:60px"> <label><input type="checkbox" id="govt"> Class-wise reference limits (car 70, bike 60, truck/bus 60; user ne bataye, official nahi, khud verify karo)</label><br>Line 1 (camera ke paas, road par): asli doori <input id="cdist" type="number" value="10" style="width:55px"> m <button id="calb" type="button">Line 1: 2 point tap</button><br>Line 2 (door, optional - perspective sahi karne ke liye): asli doori <input id="cdist2" type="number" value="10" style="width:55px"> m <button id="calb2" type="button">Line 2: 2 point tap</button><br><span id="calst">Calibrate nahi hua (speed nahi dikhegi)</span></div><h3>Evidence (sirf is phone me)</h3><ul id="evl" style="padding-left:0;list-style:none"></ul>');
function showPanel() { $('tpanel').hidden = $('mode').value !== 'traffic'; }
$('mode').addEventListener('change', () => { showPanel(); if ($('mode').value === 'traffic') initTraffic().catch(() => {}); });
function initTraffic() { if (vInit) return vInit; vInit = (async () => { setStatus('Gaadi detector load ho raha hai...'); const M = window.__mpv, opt = d => ({ baseOptions: { modelAssetPath: EFFDET_URL, delegate: d }, runningMode: 'IMAGE', scoreThreshold: 0.4, maxResults: 25, categoryAllowlist: ['car', 'truck', 'bus', 'motorcycle', 'bicycle'] });
  try { vdet = await M.ObjectDetector.createFromOptions(window.__fs, opt('GPU')); } catch (e) { vdet = await M.ObjectDetector.createFromOptions(window.__fs, opt('CPU')); } setStatus('Traffic mode ready.'); })().catch(e => { vInit = null; setStatus('Traffic load fail: ' + e); throw e; }); return vInit; }
const cals = [null, null]; let calIdx = 0;
function startCal(i) { calIdx = i; calPts = []; calOn = true; o.style.pointerEvents = 'auto'; $('calst').textContent = 'Line ' + (i + 1) + ': pehla point tap karo (video par)'; }
$('calb').onclick = () => startCal(0); $('calb2').onclick = () => startCal(1);
function calText() { const c = cals.filter(Boolean); return c.length ? 'Calibrated: ' + c.map((x, i) => 'L' + (i + 1) + ' ' + x.ppm.toFixed(1) + ' px/m').join(', ') + (c.length > 1 ? ' (perspective on)' : ' (1 line: poore frame me same scale)') : 'Calibrate nahi hua'; }
o.addEventListener('pointerdown', e => { if (!calOn) return; const r = o.getBoundingClientRect(), W = o.width || v.videoWidth, H = o.height || v.videoHeight; calPts.push({ x: (e.clientX - r.left) / r.width * W, y: (e.clientY - r.top) / r.height * H });
  if (calPts.length === 1) $('calst').textContent = 'Ab doosra point tap karo'; else { calOn = false; o.style.pointerEvents = 'none'; const d = +$(calIdx ? 'cdist2' : 'cdist').value, px = Math.hypot(calPts[0].x - calPts[1].x, calPts[0].y - calPts[1].y); if (d > 0 && px > 5) { cals[calIdx] = { p: calPts.slice(), ppm: px / d, y: (calPts[0].y + calPts[1].y) / 2 }; cal = cals.filter(Boolean); $('calst').textContent = calText(); } else $('calst').textContent = 'Calibrate fail, dubara'; } });
function ppmAt(y) { const c = cals.filter(Boolean); if (!c.length) return null; if (c.length === 1) return c[0].ppm; c.sort((a, b) => a.y - b.y); const [A, B] = c; if (Math.abs(B.ppm - A.ppm) < 0.05 * A.ppm || Math.abs(B.y - A.y) < 10) return (A.ppm + B.ppm) / 2;
  const yh = (A.y * B.ppm - B.y * A.ppm) / (B.ppm - A.ppm); let p; if (yh < A.y - 5 && B.ppm > A.ppm || yh > B.y + 5 && B.ppm < A.ppm) { p = (A.ppm / (A.y - yh)) * (y - yh); } else p = A.ppm + (B.ppm - A.ppm) * (y - A.y) / (B.y - A.y); return Math.min(Math.max(p, 0.4 * Math.min(A.ppm, B.ppm)), 2.5 * Math.max(A.ppm, B.ppm)); }
function trackSpeed(h) { if (h.length < 12) return null; const last = h[h.length - 1]; let k = h.length - 1; while (k > 0 && last.t - h[k - 1].t < 2.5) k--; const w = h.slice(k); if (w.length < 10 || last.t - w[0].t < 1.2) return null; const n = Math.max(3, Math.floor(w.length / 3)), avg = arr => ({ x: arr.reduce((a, p) => a + p.x, 0) / arr.length, y: arr.reduce((a, p) => a + p.y, 0) / arr.length, t: arr.reduce((a, p) => a + p.t, 0) / arr.length }), p0 = avg(w.slice(0, n)), p1 = avg(w.slice(-n)); const dt = p1.t - p0.t; if (dt < 0.6) return null; const ppm = ppmAt((p0.y + p1.y) / 2); if (!ppm) return null; return Math.hypot(p1.x - p0.x, p1.y - p0.y) / ppm / dt * 3.6; }
const CLS = { car: 'car', truck: 'truck', bus: 'bus', motorcycle: 'bike', bicycle: 'cycle' }, GOVT = { car: 70, truck: 60, bus: 60, motorcycle: 60, bicycle: 30 };
function iou(a, b) { const x = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1)), y = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1)), i = x * y; return i / ((a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - i + 1e-6); }
async function stepTraffic() {
  if (!vdet) await initTraffic(); if (v.readyState < 2 || !v.videoWidth) return null;
  const W = v.videoWidth, H = v.videoHeight; if (o.width !== W || o.height !== H) { o.width = W; o.height = H; } const t0 = performance.now(), now = t0 / 1000;
  const dets = vdet.detect(v).detections.map(d => ({ x1: d.boundingBox.originX, y1: d.boundingBox.originY, x2: d.boundingBox.originX + d.boundingBox.width, y2: d.boundingBox.originY + d.boundingBox.height, cls: d.categories[0].categoryName, s: d.categories[0].score }));
  const used = new Set();
  for (const d of dets) { let best = null, bs = 0.15; for (const t of tracks) { if (used.has(t)) continue; const s = iou(d, t.box); const dd = Math.hypot((d.x1 + d.x2 - t.box.x1 - t.box.x2) / 2, (d.y1 + d.y2 - t.box.y1 - t.box.y2) / 2) / Math.max(d.x2 - d.x1, 1); const sc = s + (dd < 0.8 ? 0.15 : 0); if (sc > bs) { bs = sc; best = t; } }
    if (!best) { best = { id: nextTid++, hist: [], miss: 0, over: false, spd: null }; tracks.push(best); } used.add(best); best.box = d; best.cls = d.cls; best.miss = 0; best.hist.push({ t: now, x: (d.x1 + d.x2) / 2, y: d.y2 }); while (best.hist.length > 40) best.hist.shift(); }
  for (let i = tracks.length - 1; i >= 0; i--) { if (!used.has(tracks[i]) && ++tracks[i].miss > 6) tracks.splice(i, 1); }
  ctx.clearRect(0, 0, W, H); ctx.lineWidth = Math.max(2, W / 250); ctx.font = Math.max(16, W / 38) + 'px sans-serif'; const lim = +$('lim').value || 40; let over = 0, fresh = false;
  for (const c of cals) if (c) { ctx.strokeStyle = '#ffd60a'; ctx.beginPath(); ctx.moveTo(c.p[0].x, c.p[0].y); ctx.lineTo(c.p[1].x, c.p[1].y); ctx.stroke(); }
  for (const t of tracks) { if (t.miss) continue; const h = t.hist, last = h[h.length - 1]; const sp = cals.some(Boolean) ? trackSpeed(h) : null; if (sp != null) { t.sps = (t.sps || []).concat(sp).slice(-7); const m = t.sps.slice().sort((x, y) => x - y)[t.sps.length >> 1]; t.spd = t.spd == null ? m : 0.7 * t.spd + 0.3 * m; }
    const L = $('govt').checked ? GOVT[t.cls] || lim : lim, ov = t.spd != null && t.spd > L && (t.sps || []).length >= 4 && last.t - h[0].t > 1.5; if (ov) { over++; if (!t.over) { t.over = true; fresh = true; addEvidence('Overspeed ' + Math.round(t.spd) + ' km/h (limit ' + L + ')', t.box, true); } }
    const b = t.box; ctx.strokeStyle = ov ? '#ff3b30' : '#34c759'; ctx.strokeRect(b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1); const lab = (CLS[t.cls] || t.cls) + (t.spd != null ? ' ' + Math.round(t.spd) + ' km/h' : ''); const tw = ctx.measureText(lab).width + 8; ctx.fillStyle = ov ? '#ff3b30' : '#1a7f37'; ctx.fillRect(b.x1, Math.max(0, b.y1 - 22), tw, 22); ctx.fillStyle = '#fff'; ctx.fillText(lab, b.x1 + 4, Math.max(16, b.y1 - 5)); }
  const ms = performance.now() - t0; $('fps').textContent = 'Traffic: ' + Math.round(ms) + ' ms/frame, gaadiyan ' + tracks.filter(t => !t.miss).length + (cals.some(Boolean) ? '' : ' (calibrate karo speed ke liye)');
  return { r: { level: over ? 'alert' : 'calm', alert: over > 0 }, helmet: true, text: over ? 'ALERT: overspeed (' + over + ')' : 'Traffic chal raha hai', fresh };
}
// ---- Evidence ----
let edb = null; const eopen = new Promise(res => { try { const q = indexedDB.open('evidence', 1); q.onupgradeneeded = () => q.result.createObjectStore('e', { keyPath: 'id' }); q.onsuccess = () => { edb = q.result; res(); }; q.onerror = () => res(); } catch (e) { res(); } });
const ecan = document.createElement('canvas'), ectx = ecan.getContext('2d'); let rec = null, recBusy = false, ctimer = 0, clipPending = [], clipStartedAt = 0;
function stamp(c2, type) { const t = new Date().toLocaleString(); c2.font = Math.max(14, c2.canvas.width / 38) + 'px sans-serif'; const w = c2.measureText(t + ' | ' + type).width + 12; c2.fillStyle = 'rgba(0,0,0,.65)'; c2.fillRect(0, 0, w, Math.max(24, c2.canvas.width / 30)); c2.fillStyle = '#fff'; c2.fillText(t + ' | ' + type, 6, Math.max(17, c2.canvas.width / 44)); }
function compose(type) { const W = v.videoWidth, H = v.videoHeight; if (!W) return; if (ecan.width !== W) { ecan.width = W; ecan.height = H; } ectx.drawImage(v, 0, 0, W, H); ectx.drawImage(o, 0, 0, W, H); stamp(ectx, type); }
setInterval(() => { if (!running || !v.videoWidth) return; const c2 = document.createElement('canvas'); c2.width = 320; c2.height = Math.round(320 * v.videoHeight / v.videoWidth); c2.getContext('2d').drawImage(v, 0, 0, c2.width, c2.height); ring.push({ t: Date.now(), c: c2 }); while (ring.length > 4) ring.shift(); }, 1500);
const blob = (c2, q) => new Promise(r => c2.toBlob(r, 'image/jpeg', q || 0.85));
async function addEvidence(type, box, noPlate) {
  if (!running || !v.videoWidth) return; const id = Date.now() + '' + Math.floor(Math.random() * 1000), W = v.videoWidth, H = v.videoHeight; compose(type); const snap = await blob(ecan); let crop = null, cc = null;
  if (box) { const w = box.x2 - box.x1, h = box.y2 - box.y1, x = Math.max(0, box.x1 - w * 0.2), y = Math.max(0, box.y1 - h * 0.6), cw = Math.min(W - x, w * 1.4), ch = Math.min(H - y, h * 1.9), sc = Math.min(3, Math.max(1, 480 / cw)); cc = document.createElement('canvas'); cc.width = Math.round(cw * sc); cc.height = Math.round(ch * sc); const g = cc.getContext('2d'); g.drawImage(v, x, y, cw, ch, 0, 0, cc.width, cc.height); stamp(g, type); crop = await blob(cc); }
  const before = []; for (const r of ring.slice(-3)) { const c2 = r.c; before.push(await blob(c2, 0.7)); }
  const recd = { id, ts: Date.now(), type, snap, crop, before, clip: null, plate: '' }; if (edb) { try { edb.transaction('e', 'readwrite').objectStore('e').put(recd); } catch (e) {} } renderEv(recd);
  if (cc && !noPlate) readPlate(cc).then(p => { recd.plate = p; save(recd); renderEv(recd); }).catch(() => {});
  if (recBusy) { recd.clipStatus = 'shared_pending'; clipPending.push(recd); save(recd); }
  if (!recBusy && window.MediaRecorder) { recBusy = true; clipPending = [recd]; clipStartedAt = Date.now(); try { const sourceStream = v.srcObject || (v.captureStream ? v.captureStream() : v.mozCaptureStream ? v.mozCaptureStream() : null); if (!sourceStream) throw new Error('video capture unsupported'); const st = new MediaStream(sourceStream.getVideoTracks().map(t => t.clone())), mt = ['video/webm;codecs=vp8', 'video/webm', 'video/mp4'].find(m => MediaRecorder.isTypeSupported(m)); const mr = new MediaRecorder(st, mt ? { mimeType: mt, videoBitsPerSecond: 800000 } : {}), ch2 = []; mr.ondataavailable = e => e.data.size && ch2.push(e.data); const tm = 0;
    mr.onstop = () => { clearInterval(tm); recBusy = false; const clip = new Blob(ch2, { type: mr.mimeType }), endedAt = Date.now(); for (const item of clipPending) { item.clip = clip.size ? clip : null; item.clipStatus = clip.size ? 'complete' : 'failed'; item.clipStartedAt = clipStartedAt; item.clipEndedAt = endedAt; save(item); renderEv(item); } clipPending = []; st.getTracks().forEach(t => t.stop()); }; mr.start(1000); setTimeout(() => { try { mr.stop(); } catch (e) {} }, 10000); } catch (e) { recBusy = false; for (const item of clipPending) { item.clipStatus = 'failed'; save(item); renderEv(item); } clipPending = []; } } else if (!window.MediaRecorder) { recd.clipStatus = 'unsupported'; save(recd); renderEv(recd); }
  return recd; }
function save(r) { if (edb) try { edb.transaction('e', 'readwrite').objectStore('e').put(r); } catch (e) {} }
function renderEv(r) { let li = document.getElementById('ev' + r.id); if (!li) { li = document.createElement('li'); li.id = 'ev' + r.id; li.style.cssText = 'margin:10px 0;padding:8px;background:#fff;border-radius:8px'; $('evl').prepend(li); } li.innerHTML = '';
  const t = document.createElement('div'); t.innerHTML = '<b></b><br><small></small>'; t.firstChild.textContent = new Date(r.ts).toLocaleString() + ' - ' + r.type; t.lastChild.textContent = r.plate ? 'Plate: ' + r.plate : ''; li.append(t);
  const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin:6px 0'; for (const b of [r.snap, r.crop, ...(r.before || [])]) if (b) { const im = document.createElement('img'); im.src = URL.createObjectURL(b); im.style.cssText = 'max-height:90px;border-radius:6px'; row.append(im); } li.append(row);
  if (r.clip) { const vd = document.createElement('video'); vd.src = URL.createObjectURL(r.clip); vd.controls = true; vd.muted = true; vd.style.cssText = 'max-width:100%;max-height:160px'; li.append(vd); if (r.clipStartedAt) { const note = document.createElement('small'); note.textContent = 'Clip: ' + new Date(r.clipStartedAt).toLocaleTimeString() + '-' + new Date(r.clipEndedAt).toLocaleTimeString() + ' (raw camera video; time/photo alag saved, paas ke alerts me shared clip)'; li.append(note); } } else { const s = document.createElement('small'); s.textContent = r.clipStatus === 'failed' ? '(Clip record nahi hui; photo saved)' : r.clipStatus === 'unsupported' ? '(Is browser me video recording supported nahi; photo saved)' : r.clipStatus === 'shared_pending' ? '(Isi waqt ki chalti clip se video judegi...)' : '(10 sec clip record ho rahi hai...)'; li.append(s); }
  const mk = (txt, fn) => { const b = document.createElement('button'); b.textContent = txt; b.type = 'button'; b.style.marginRight = '6px'; b.onclick = fn; li.append(b); };
  const ext = r.clip && /mp4/.test(r.clip.type) ? 'mp4' : 'webm'; const dl = (b, n) => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = n; a.click(); };
  mk('Photo download', () => dl(r.snap, 'evidence-' + r.id + '.jpg')); if (r.clip) mk('Video download', () => dl(r.clip, 'evidence-' + r.id + '.' + ext));
  mk('Share (WhatsApp)', async () => { const files = [new File([r.snap], 'evidence-' + r.id + '.jpg', { type: 'image/jpeg' })]; if (r.clip) files.push(new File([r.clip], 'evidence-' + r.id + '.' + ext, { type: r.clip.type })); try { await navigator.share({ files, title: r.type, text: new Date(r.ts).toLocaleString() + ' - ' + r.type + (r.plate ? ' - ' + r.plate : '') }); } catch (e) { if (e.name !== 'AbortError') setStatus('Share is browser me nahi chala, download use karo.'); } }); }
eopen.then(() => { if (!edb) return; const q = edb.transaction('e').objectStore('e').getAll(); q.onsuccess = () => q.result.sort((a, b) => a.ts - b.ts).slice(-30).forEach(renderEv); });
// ---- Camera switch, photo, wake lock, light mode ----
let wl = null; async function wake() { try { if (navigator.wakeLock && running) wl = await navigator.wakeLock.request('screen'); } catch (e) {} }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') wake(); });
$('flip').onclick = async () => { const wasRunning=running && !!stream; $('front').checked = !$('front').checked; if(wasRunning){stopAll(); await $('start').onclick();}else setStatus('Camera '+($('front').checked?'front':'back')+' select hua. Start dabao.'); };
let phT = 0; $('photo').onchange = async e => { const f = e.target.files[0]; if (!f) return; unlockAudio(); stopAll(); const img = new Image(); img.src = URL.createObjectURL(f); try { await img.decode(); } catch (er) { setStatus('Photo khul nahi payi.'); return; }
  const c2 = document.createElement('canvas'), s = Math.min(1, 1280 / Math.max(img.width, img.height)); c2.width = Math.round(img.width * s); c2.height = Math.round(img.height * s); const g = c2.getContext('2d'); const draw = () => g.drawImage(img, 0, 0, c2.width, c2.height); draw(); clearInterval(phT); phT = setInterval(draw, 400); cameraNote='photo test'; v.srcObject = c2.captureStream(3); v.muted = true; await v.play(); running = true; setStatus('Photo analyse ho rahi hai (stop karne ko Band karo).'); $('start').textContent = 'Band karo'; loop(); e.target.value = ''; };
const _stop = stopAll; stopAll = function (m) { clearInterval(phT); clearInterval(cameraWatch); _stop(m); }; const _start = $('start').onclick; $('start').onclick = async () => { await _start(); wake(); if ($('light').checked) setStatus('Light mode on: kam resolution/fps.'); };

$('light').parentElement.insertAdjacentHTML('afterend', '<br><label><input type="checkbox" id="auto" checked> Auto mode (device check karke best setting khud chune)</label> <span id="autost" style="font-size:13px;color:#555"></span>');
let aEma = 0, aN = 0, aLowN = 0; function benchDevice() { const c = document.createElement('canvas'); c.width = c.height = 640; const g = c.getContext('2d', { willReadFrequently: true }); const t = performance.now(); for (let i = 0; i < 6; i++) { g.fillStyle = 'rgb(' + i * 30 + ',90,120)'; g.fillRect(0, 0, 640, 640); const d = g.getImageData(0, 0, 640, 640).data; let s = 0; for (let k = 0; k < d.length; k += 16) s += d[k]; window.__bs = s; } return (performance.now() - t) / 6; }
function autoTune(ms) { if (!$('auto').checked) return; aEma = aN++ ? .8*aEma+.2*ms : ms; if(aN<6)return;
  if(aEma>900){$('light').checked=true; $('light').dataset.auto=1; adaptiveGap=Math.min(1200,Math.round(aEma*.35));}
  $('autost').textContent='Auto: AI '+Math.round(aEma)+' ms/frame; '+($('light').checked?'light processing':'full processing')+'; camera '+cameraNote;
  if(aN>=10 && aEma>1400 && Date.now()-lastCameraStep>30000) lowerCameraCapture('phone load');
}
const _start2=$('start').onclick; $('start').onclick=async()=>{if(!running && $('auto').checked){aN=0;aEma=0;const b=benchDevice();$('light').checked=b>25;adaptiveGap=b>25?350:0;$('autost').textContent='Auto: camera capability + device check...';}await _start2();};

init();
// ---- School mode: fight(pose) + phone use, with principal exemption window (phone ONLY; fight etc. stay active) ----
function exemptNow(rule, now) { if (!rule || !rule.on || !rule.from || !rule.to) return false; now = now || new Date(); const d = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0'); const m = now.getHours() * 60 + now.getMinutes(), f = rule.from.split(':'), t = rule.to.split(':'), a = +f[0] * 60 + +f[1], b = +t[0] * 60 + +t[1];
  if (a <= b) return rule.date === d && m >= a && m < b; const y = new Date(now.getTime() - 864e5), yd = y.getFullYear() + '-' + String(y.getMonth() + 1).padStart(2, '0') + '-' + String(y.getDate()).padStart(2, '0'); return (rule.date === d && m >= a) || (rule.date === yd && m < b); }
window.__exemptNow = exemptNow;
function getRule() { try { return JSON.parse(localStorage.getItem('phoneRule') || 'null'); } catch (e) { return null; } }
$('mode').insertAdjacentHTML('beforeend', '<option value="school">School: ladai + phone (principal chhoot)</option>');
$('tpanel').insertAdjacentHTML('afterend', '<div id="spanel" hidden style="background:#fff;padding:10px;border-radius:8px;margin:8px 0"><b>Principal: phone chhoot (sirf phone)</b><br><label><input type="checkbox" id="rOn"> Phone use allowed (alert band)</label><br><label>Se <input type="time" id="rFrom" value="10:00"></label> <label>Tak <input type="time" id="rTo" value="13:00"></label> <small>(aaj ke din ke liye)</small><p id="rSt" style="margin:6px 0;font-size:13px"></p><small>Chhoot sirf phone par lagti hai. Ladai / maar-peet ka alert hamesha chalu rehta hai, phone haath me ho tab bhi.</small></div>');
function rUpd(saveUserEdit=false) { const n=new Date(),today=n.getFullYear()+'-'+String(n.getMonth()+1).padStart(2,'0')+'-'+String(n.getDate()).padStart(2,'0');let rule=getRule();if(saveUserEdit || !rule){rule={on:$('rOn').checked,from:$('rFrom').value,to:$('rTo').value,date:today};localStorage.setItem('phoneRule',JSON.stringify(rule));}const ex=exemptNow(rule);$('rSt').textContent=!rule.on?'Chhoot band: phone par alert aayega.':ex?'Chhoot ABHI chalu '+rule.date+' '+rule.from+'-'+rule.to+': phone par alert nahi.':'Chhoot set '+rule.date+' '+rule.from+'-'+rule.to+'; abhi chalu nahi. Phone alert chalu.';}
for(const id of ['rOn','rFrom','rTo'])$(id).addEventListener('change',()=>rUpd(true));{const r0=getRule();if(r0){$('rOn').checked=r0.on;$('rFrom').value=r0.from;$('rTo').value=r0.to;}rUpd();setInterval(()=>rUpd(false),30000);}
function showS() { $('spanel').hidden = $('mode').value !== 'school'; } $('mode').addEventListener('change', showS); showS();
let phdet = null, phN = 0, phOn = false, poseOn = false;
async function initPh() { if (phdet) return; setStatus('Phone detector load ho raha hai...'); const M = window.__mpv, opt = d => ({ baseOptions: { modelAssetPath: EFFDET_URL, delegate: d }, runningMode: 'IMAGE', scoreThreshold: 0.3, maxResults: 25, categoryAllowlist: ['person', 'cell phone'] }); phdet = await M.ObjectDetector.createFromOptions(window.__fs, opt('CPU')); setStatus('School mode ready.'); }
async function stepSchool() {
  if (!phdet) await initPh(); if (v.readyState < 2 || !v.videoWidth) return null;
  const s = step(performance.now()); const W = v.videoWidth, H = v.videoHeight; let fresh = false;
  const dets = phdet.detect(v).detections.map(d => ({ x1: d.boundingBox.originX, y1: d.boundingBox.originY, x2: d.boundingBox.originX + d.boundingBox.width, y2: d.boundingBox.originY + d.boundingBox.height, cls: d.categories[0].categoryName }));
  const ph = dets.filter(d => d.cls === 'cell phone'), pe = dets.filter(d => d.cls === 'person');
  const near = ph.filter(p => pe.some(q => { const cx = (p.x1 + p.x2) / 2, cy = (p.y1 + p.y2) / 2, w = q.x2 - q.x1, h = q.y2 - q.y1; return cx > q.x1 - 0.1 * w && cx < q.x2 + 0.1 * w && cy > q.y1 - 0.1 * h && cy < q.y1 + 0.75 * h; }));
  phN = near.length ? phN + 1 : Math.max(0, phN - 1); const ex = exemptNow(getRule()), phoneAlert = phN >= 3 && !ex;
  for (const p of ph) { ctx.lineWidth = Math.max(2, W / 250); ctx.strokeStyle = ex ? '#0a84ff' : '#ff9f0a'; ctx.strokeRect(p.x1, p.y1, p.x2 - p.x1, p.y2 - p.y1); }
  if (phoneAlert && !phOn) { phOn = true; fresh = true; addEvidence('Phone use', near[0], true); } if (!phoneAlert && phN === 0) phOn = false;
  const fight = !!s.r.alert; if (fight && !poseOn) { poseOn = true; fresh = true; addEvidence('Maar-peet jaisi movement (pose alert)', null, true); } if (!fight && !s.r.alert) poseOn = fight;
  const text = fight ? 'ALERT: maar-peet jaisi movement' : phoneAlert ? 'ALERT: phone use' : ex && phN >= 3 ? 'Phone chhoot chalu - alert nahi' : 'Sab theek';
  $('fps').textContent = 'School: phone ' + ph.length + ', log ' + pe.length + (ex ? ' (phone chhoot ON)' : '');
  return { r: { level: fight || phoneAlert ? 'alert' : 'calm', alert: fight || phoneAlert, count: s.r.count }, helmet: true, text, fresh };
}
const _step = window.__stepMode; window.__school = stepSchool;
window.__test = { setDet: d => { phdet = d; }, school: stepSchool, reset: () => { phN = 0; phOn = false; poseOn = false; } };
// ---- Plain-language principal instruction (Hindi/Hinglish/English), pattern rules only. Never applies without a confirm tap. ----
function parsePrincipal(text, now) { now = now || new Date(); const t = text.toLowerCase().replace(/[।]/g, ' '), notes = [];
  if (/mana\b|not allowed|isn.?t allowed|nahi\s+(chalega|chalegi|allowed)|banned|prohibit|forbid|don.?t allow|allow\s*(mat|nahi)/.test(t)) return { ok: false, reason: 'Yeh chhoot nahi, rok/mana hai. Kuch nahi badla.' };
  if (/fight|ladai|ladayi|लड़ाई|maar.?peet|मारपीट|helmet|हेलमेट|speed|स्पीड/.test(t)) return { ok: false, reason: 'Web page par sirf phone ki chhoot hoti hai (ladai/helmet/speed ka alert band nahi kiya ja sakta).' };
  if (!/phone|mobile|मोबाइल|फोन|फ़ोन|cell/.test(t)) return { ok: false, reason: 'Kis cheez ki chhoot? "phone" likho.' };
  if (!/allow|permit|exempt|\bok\b|okay|fine|chalega|chalegi|ijaz|chhoot|chhut|\bchut\b|छूट|इजाज़त|manzoor|karne\s*do|use\s*kar|ignore|alert\s*(mat|nahi|band)|no alert/.test(t)) return { ok: false, reason: 'Samajh nahi aaya ki chhoot deni hai. "allowed" / "chhoot" likho.' };
  const part = ['subah', 'morning', 'dopahar', 'afternoon', 'shaam', 'evening', 'raat', 'night'].find(p => t.includes(p)); let s, f;
  if (/poora din|pura din|din bhar|all day|whole day|full day/.test(t)) { s = [0, 0]; f = [23, 59]; } else {
    const N = '(\\d{1,2})(?::|\\.|h)?(\\d{2})?\\s*(am|pm|a\\.m\\.|p\\.m\\.)?\\s*(?:baje|bje|बजे|o.?clock)?', m = new RegExp(N + '\\s*(?:se|से|to|till|until|tak|तक|-|–)\\s*' + N).exec(t);
    if (!m) return { ok: false, reason: "Time samajh nahi aaya. Aise likho: '10 baje se 1 baje tak' ya '10am to 1pm'." };
    const hm = (h, mi, mer) => { h = +h; mi = +(mi || 0); if (mer) mer = mer[0]; let nt = null; if (mer === 'p' && h < 12) h += 12; else if (mer === 'a' && h === 12) h = 0; else if (!mer) { if (['shaam', 'raat', 'dopahar', 'evening', 'night', 'afternoon'].includes(part) && h < 12) h += (part === 'dopahar' && h === 12) ? 0 : 12; else if (!part && h >= 1 && h <= 6) { h += 12; nt = (h - 12) + ' ko ' + h + ':00 (dopahar/shaam) maana'; } } return [h, mi, nt]; };
    let a = hm(m[1], m[2], m[3]), b = hm(m[4], m[5], m[6]); if (!m[3] && !m[6] && !part && b[0] * 60 + b[1] <= a[0] * 60 + a[1] && b[0] < 12) { b = [b[0] + 12, b[1], b[0] + ' ko ' + (b[0] + 12) + ':' + String(b[1]).padStart(2, '0') + ' maana']; }
    for (const x of [a, b]) if (x[2]) notes.push(x[2]); s = a.slice(0, 2); f = b.slice(0, 2);
    if (s[0] > 23 || f[0] > 23 || s[1] > 59 || f[1] > 59 || (s[0] === f[0] && s[1] === f[1])) return { ok: false, reason: 'Time galat hai.' }; }
  const d0 = /\bkal\b|tomorrow|कल/.test(t) ? new Date(now.getTime() + 864e5) : now, date = d0.getFullYear() + '-' + String(d0.getMonth() + 1).padStart(2, '0') + '-' + String(d0.getDate()).padStart(2, '0'), p2 = x => String(x).padStart(2, '0');
  return { ok: true, from: p2(s[0]) + ':' + p2(s[1]), to: p2(f[0]) + ':' + p2(f[1]), date, notes }; }
window.__parsePrincipal = parsePrincipal;
$('rSt').insertAdjacentHTML('afterend', '<div id="nlp"><textarea id="nlpT" rows="2" style="width:100%" placeholder="Aise likho: aaj 10 baje se 1 baje tak phone allowed hai  /  phones are fine from 10am to 1pm"></textarea><button id="nlpB" type="button">Samjho</button> <span id="nlpR" style="font-size:13px"></span> <button id="nlpY" type="button" hidden>Haan, lagu karo</button></div>');
let pend = null;
$('nlpB').onclick = () => { const o = parsePrincipal($('nlpT').value); pend = null; $('nlpY').hidden = true; if (!o.ok) { $('nlpR').textContent = o.reason; return; } pend = o; $('nlpR').textContent = 'Maine samjha: phone par alert band ' + o.from + '-' + o.to + ' (' + o.date + '). Baaki sab alert chalu.' + (o.notes.length ? ' [' + o.notes.join('; ') + ']' : '') + ' Sahi hai?'; $('nlpY').hidden = false; };
$('nlpY').onclick = () => { if (!pend) return; localStorage.setItem('phoneRule', JSON.stringify({ on: true, from: pend.from, to: pend.to, date: pend.date })); $('rOn').checked = true; $('rFrom').value = pend.from; $('rTo').value = pend.to; $('nlpY').hidden = true; $('nlpR').textContent = 'Lagu ho gaya.'; pend = null; rUpd(); };
document.body.insertAdjacentHTML('beforeend', '<details class="warn" style="font-size:13px"><summary><b>Camera kahan lagayein / roshni (zaroori)</b></summary><ul><li>Helmet: sir kam se kam ~60-80 px ooncha dikhe; side/saamne se thoda upar se. Bahut door ya seedha upar se nahi chalega.</li><li>Number plate: plate khud ~130x70 px ho; camera 3-6 m door, 30 degree se kam angle, chamak (glare) nahi.</li><li>Speed: camera fixed, seedhi sadak, 2 line (jaise 5 m) calibrate karo; camera hile to dobara.</li><li>Ladai / phone: log 120+ px ooche dikhein, 2.5-3.5 m ooncha, khidki ki taraf peeth (backlight) nahi.</li><li>Din / achhi roshni me test hua hai. Raat, baarish, blur, IR (kala-safed) me zyada galti hogi, test nahi hua.</li><li>Har alert ke saath photo + 10 sec clip banti hai: pehle insaan dekhe, phir action.</li></ul></details>');

// Scope media layout to the camera. Evidence canvases must not overlay the page.
const mediaStyle = document.createElement('style');
mediaStyle.textContent = '#cam{position:relative} #cam>video{width:100%;height:auto;display:block} #cam>canvas{position:absolute;inset:0;width:100%;height:100%;pointer-events:none} #evl canvas,#log canvas{position:static;inset:auto;width:auto;height:auto;max-width:100%;display:block} #evl video{position:static;width:100%;height:auto}';
document.head.append(mediaStyle);

const resolutionInfo=document.createElement('p');resolutionInfo.id='captureInfo';resolutionInfo.style.cssText='font-size:13px;color:#444';$('cam').before(resolutionInfo);setInterval(()=>{if(!v.videoWidth)return;const settings=v.srcObject&&v.srcObject.getVideoTracks()[0]?.getSettings();resolutionInfo.textContent='Asli camera/video: '+v.videoWidth+' x '+v.videoHeight+(settings?.frameRate?' @ '+Math.round(settings.frameRate)+' fps':'')+'; AI crop/input alag hai. '+cameraNote;},1000);

// Capture stays separate from AI input. Lower capture only after sustained slow operation.
let adaptiveGap=0,cameraLevel=0,lastCameraStep=0,cameraChanging=false,cameraNote='source selected',cameraWatch=0,videoLastTime=-1,stallN=0;
const captureLevels=[[3840,2160,30],[1920,1080,24],[1280,720,20],[640,480,15]];
async function openAdaptiveCamera(){let last;for(let i=0;i<captureLevels.length;i++){const [w,h,f]=captureLevels[i];try{const st=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:$('front').checked?'user':'environment'},width:{ideal:w},height:{ideal:h},frameRate:{ideal:f,max:30}},audio:false});cameraLevel=i;cameraNote=i?'startup fallback':'up to 4K requested';return st;}catch(e){last=e;if(!['OverconstrainedError','NotReadableError','AbortError'].includes(e.name))throw e;}}throw last;}
function resetCameraAdaptation(){lastCameraStep=Date.now();videoLastTime=-1;stallN=0;clearInterval(cameraWatch);cameraWatch=setInterval(()=>{if(!running||!stream||document.hidden)return;if(v.currentTime===videoLastTime)stallN++;else stallN=0;videoLastTime=v.currentTime;if(stallN>=4){stallN=0;lowerCameraCapture('camera frames stalled');}},1500);}
async function lowerCameraCapture(reason){if(cameraChanging||!stream||cameraLevel>=captureLevels.length-1||!$('auto').checked)return;const track=stream.getVideoTracks()[0],cur=track.getSettings();let next=cameraLevel+1;while(next<captureLevels.length-1 && cur.width<=captureLevels[next][0] && cur.height<=captureLevels[next][1])next++;cameraChanging=true;lastCameraStep=Date.now();const [w,h,f]=captureLevels[next];try{await track.applyConstraints({width:{ideal:w,max:w},height:{ideal:h,max:h},frameRate:{ideal:f,max:f}});if(!running || track.readyState==='ended')return;cameraLevel=next;cameraNote='auto fallback: '+reason;setStatus('Auto: '+reason+'; camera halka kiya. Chhoti/door cheez ki detail kam ho sakti hai.');}catch(e){if(!running || track.readyState==='ended')return;cameraLevel=next;cameraNote='capture unchanged; AI slowed';}finally{cameraChanging=false;}}

// Person and visible object labels. Proximity never means ownership or intent.
$('mode').insertAdjacentHTML('beforeend','<option value="objects">Person + cheez labels (test)</option>');
let objectDetector=null,objectReady=null;
const objectClasses=['person','cell phone','backpack','handbag','suitcase','bottle','cup','umbrella','knife','scissors','book'];
async function initObjects(){if(objectReady)return objectReady;objectReady=(async()=>{const M=window.__mpv,opt=d=>({baseOptions:{modelAssetPath:EFFDET_URL,delegate:d},runningMode:'IMAGE',scoreThreshold:.35,maxResults:40,categoryAllowlist:objectClasses});objectDetector=await M.ObjectDetector.createFromOptions(window.__fs,opt('CPU'));})();return objectReady;}
const objectCanvas=document.createElement('canvas'),objectCtx=objectCanvas.getContext('2d');
function detectionLabel(b,text,color,W,H){const font=Math.max(16,W/38),pad=W/150;ctx.font='600 '+font+'px sans-serif';ctx.lineWidth=Math.max(2,W/250);ctx.strokeStyle=color;const x=Math.max(0,Math.min(W,b.x1)),y=Math.max(0,Math.min(H,b.y1));ctx.strokeRect(x,y,Math.min(W-x,b.x2-x),Math.min(H-y,b.y2-y));const tw=Math.min(W,ctx.measureText(text).width+pad*2),lh=font*1.35,tx=Math.min(x,W-tw),ty=Math.max(0,y-lh);ctx.fillStyle=color;ctx.fillRect(tx,ty,tw,lh);ctx.fillStyle='#fff';ctx.fillText(text,tx+pad,ty+font,tw-pad*2);}
async function stepObjects(){await initObjects();if(v.readyState<2||!v.videoWidth)return null;const W=v.videoWidth,H=v.videoHeight,t0=performance.now(),z=Math.max(1,+$('zoom').value/10),rw=W/z,rh=H/z,rx=(W-rw)/2,ry=(H-rh)/2,scale=Math.min(1,1280/rw);objectCanvas.width=Math.round(rw*scale);objectCanvas.height=Math.round(rh*scale);objectCtx.drawImage(v,rx,ry,rw,rh,0,0,objectCanvas.width,objectCanvas.height);const ds=objectDetector.detect(objectCanvas).detections.map(d=>({x1:rx+d.boundingBox.originX/scale,y1:ry+d.boundingBox.originY/scale,x2:rx+(d.boundingBox.originX+d.boundingBox.width)/scale,y2:ry+(d.boundingBox.originY+d.boundingBox.height)/scale,cls:d.categories[0].categoryName}));if(o.width!==W||o.height!==H){o.width=W;o.height=H;}ctx.clearRect(0,0,W,H);const pe=ds.filter(d=>d.cls==='person');for(const d of ds){let name=d.cls==='cell phone'?'phone':d.cls;if(d.cls!=='person' && pe.some(q=>iou(d,q)>0 || ((d.x1+d.x2)/2>q.x1 && (d.x1+d.x2)/2<q.x2 && (d.y1+d.y2)/2>q.y1 && (d.y1+d.y2)/2<q.y2)))name+=' (person ke paas)';detectionLabel(d,name,d.cls==='person'?'#126431':'#915600',W,H);}window.__objectDets=ds;const ms=performance.now()-t0;$('fps').textContent='Labels: '+Math.round(ms)+' ms/frame. Paas = haath me hona pakka nahi.';return {r:{level:'calm',alert:false},helmet:true,text:ds.length?'Person '+pe.length+', cheez '+(ds.length-pe.length):'Koi supported cheez nahi mili'};}

const phoneStyle=document.createElement('style');phoneStyle.textContent='#cam{min-height:0}#cam video{width:100%;height:auto;display:block}#cam canvas{width:100%;height:100%;position:absolute;inset:0}#badge{font-size:14px;line-height:1.3;max-height:64px;overflow:hidden}#captureInfo{overflow-wrap:anywhere}';document.head.append(phoneStyle);

setInterval(()=>{if(running && Date.now()-lastOverlayAt>800){ctx.clearRect(0,0,o.width,o.height);if($('badge'))$('badge').hidden=true;}},200);

const hiddenFix=document.createElement('style');hiddenFix.textContent='[hidden]{display:none!important}';document.head.append(hiddenFix);

// Demo copy is deliberately limited to what this browser build can show.
document.querySelector('h1').textContent='Camera Guard - demo v1';document.title='Camera Guard demo';document.querySelector('h1').nextElementSibling.textContent='Phone par live camera aur detection boxes. Person/cheez labels, road, helmet aur school mode alag chun sakte ho. Video upload nahi hota. Yeh test demo hai: har alert insaan verify kare.';
const existingGuides=[...document.querySelectorAll('details.warn')];for(const g of existingGuides)if(g.textContent.includes('Camera kahan'))g.remove();
document.body.insertAdjacentHTML('beforeend','<details class="warn"><summary>Demo ki seema aur test ka tarika</summary><p>Person + cheez mode me pehle phone paas se dikhao, phir dheere door le jao. Box aur label ko khud check karo. Phone, bag, bottle, umbrella, book, knife/scissors model categories hain; sab ki real-camera testing poori nahi hui. Paas ka matlab haath me hona pakka nahi.</p><p>4K request hai, guarantee nahi. Asli resolution upar dikhti hai. Auto mode slow phone par AI ko halka karta hai aur zaroorat par capture kam karta hai. Chhoti/door cheez blur ya kam pixels me miss ho sakti hai.</p><p>Road car/bike classification abhi test hai, kuch bikes cycle aur van bus aa sakti hai. Speed ke liye fixed camera aur measured-distance calibration chahiye. Helmet alert sirf detected motorcycle se association par; ghar me bare-head test default band hai.</p><p>Evidence isi browser me photo aur supported camera par clip rakhta hai. Clip fail ho to photo-only dikhega. Browser storage clear hone par evidence mit sakta hai. Phone chhoot sirf phone alert par hai, movement alert par nahi.</p><p>Automatic challan, theft/intent proof, sab cameras par guaranteed smoothness, raat/blur reliability aur sale/licensing clearance is demo ka claim nahi.</p></details>');

$('mode').addEventListener('change',()=>{captureGeneration++;ctx.clearRect(0,0,o.width,o.height);$('badge').hidden=true;});
