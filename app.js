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
$('sens').parentElement.insertAdjacentHTML('afterend', '<p><label><input type="checkbox" id="far" checked> Door ke log mode (zyada tiles, thoda slow)</label></p><label>Zoom: <span id="zv">1.0x</span><input id="zoom" type="range" min="10" max="40" value="10"></label><p id="fps" style="color:#666"></p>');
$('zoom').oninput = () => { $('zv').textContent = (+$('zoom').value / 10).toFixed(1) + 'x'; };
async function init() {
  try {
    setStatus('Model load ho raha hai (10-20 sec)...');
    const { PoseLandmarker } = await import('./4-vision_bundle.mjs');
    const fs = { wasmLoaderPath: new URL('./5-vision_wasm_internal.js', location.href).href, wasmBinaryPath: new URL('./7-vision_wasm_internal.wasm', location.href).href };
    const opt = d => ({ baseOptions: { modelAssetPath: new URL('./6-pose.task', location.href).href, delegate: d }, runningMode: 'IMAGE', numPoses: 6, minPoseDetectionConfidence: 0.3, minPosePresenceConfidence: 0.3, minTrackingConfidence: 0.3 });
    try { pl = await PoseLandmarker.createFromOptions(fs, opt('GPU')); window.__delegate = 'GPU'; } catch (e) { pl = await PoseLandmarker.createFromOptions(fs, opt('CPU')); window.__delegate = 'CPU'; }
    window.__model = 'ready'; setStatus('Ready. Camera start karo.'); $('start').disabled = false; $('file').disabled = false;
  } catch (e) { window.__model = 'fail ' + e; setStatus('Model load fail: ' + (e && e.message || e)); }
}
function passes(W, H, zoom, far) {
  const rw = W / zoom, rh = H / zoom, rx = (W - rw) / 2, ry = (H - rh) / 2, list = [{ x: rx, y: ry, w: rw, h: rh, edge: [1, 1, 1, 1] }];
  if (far) { const tw = rw * 0.6, th = rh * 0.6; for (const ix of [0, 1]) for (const iy of [0, 1]) list.push({ x: rx + ix * (rw - tw), y: ry + iy * (rh - th), w: tw, h: th, edge: [ix === 0, iy === 0, ix === 1, iy === 1].map(Number) }); }
  return list;
}
function detectAll(W, H, zoom, far) {
  const found = [];
  for (const P of passes(W, H, zoom, far)) {
    tile.width = Math.round(Math.min(960, Math.max(P.w, 480))); tile.height = Math.round(tile.width * P.h / P.w);
    tctx.drawImage(v, P.x, P.y, P.w, P.h, 0, 0, tile.width, tile.height);
    const res = pl.detect(tile);
    for (const lm of (res.landmarks || [])) {
      const pts = lm.map(q => ({ x: (P.x + q.x * P.w) / W, y: (P.y + q.y * P.h) / H, v: q.visibility ?? 1, tx: q.x, ty: q.y }));
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
    let out; busy = true; try { out = step(performance.now()); } catch (e) { busy = false; return; } busy = false; if (!out) return;
    const r = out.r; let lvl = r.level;
    if (r.alert) { if (!al.on) { al.on = true; al.start = Date.now(); beep(); } al.cool = 0; lvl = 'alert'; }
    else if (al.on && ++al.cool > 8) { al.on = false; const li = document.createElement('li'); li.textContent = new Date(al.start).toLocaleTimeString() + ' par, ' + Math.max(1, Math.round((Date.now() - al.start) / 1000)) + ' sec'; $('log').prepend(li); $('nolog').hidden = true; }
    else if (al.on) lvl = 'alert';
    $('cam').className = 'cam ' + (lvl === 'alert' ? 'alert' : '');
    $('badge').textContent = LABEL[lvl] + (r.count ? ' (' + r.count + ' log)' : ''); $('badge').hidden = false;
  };
  raf = requestAnimationFrame(tick);
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
init();
