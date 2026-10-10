const $ = id => document.getElementById(id);
const b64 = id => { const s = atob($(id).textContent.trim()); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };
const LINKS = [[11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],[23,24],[23,25],[25,27],[24,26],[26,28]];
const LABEL = { none: 'Koi insaan nahi dikha', calm: 'Shaant', active: 'Koi tez hila raha hai', watch: 'Do log paas, nazar rakho', alert: 'ALERT: paas me tez maar-peet jaisi movement' };
const det = new Detector(); let pl = null, stream = null, raf = 0, running = false, al = { on: false, start: 0, cool: 0 };
const v = $('v'), o = $('o'), ctx = o.getContext('2d');
function setStatus(t) { $('status').textContent = t; }
async function init() {
  try {
    setStatus('Model load ho raha hai (10-20 sec)...');
    const { PoseLandmarker } = await import('./vision_bundle.mjs');
    const fs = { wasmLoaderPath: new URL('./vision_wasm_internal.js', location.href).href, wasmBinaryPath: new URL('./vision_wasm_internal.wasm', location.href).href };
    const base = { modelAssetPath: new URL('./pose.task', location.href).href };
    const opt = d => ({ baseOptions: { ...base, delegate: d }, runningMode: 'VIDEO', numPoses: 5, minPoseDetectionConfidence: 0.4, minTrackingConfidence: 0.4 });
    try { pl = await PoseLandmarker.createFromOptions(fs, opt('GPU')); window.__delegate = 'GPU'; } catch (e) { pl = await PoseLandmarker.createFromOptions(fs, opt('CPU')); window.__delegate = 'CPU'; }
    window.__model = 'ready'; setStatus('Ready. Neeche camera start karo.'); $('start').disabled = false; $('file').disabled = false;
  } catch (e) { window.__model = 'fail ' + e; setStatus('Model load fail: ' + (e && e.message || e)); }
}
function beep() { try { navigator.vibrate && navigator.vibrate(400); } catch {} if (!$('snd').checked) return; try { const a = new AudioContext(), s = a.createOscillator(); s.frequency.value = 880; s.connect(a.destination); s.start(); setTimeout(() => { s.stop(); a.close(); }, 300); } catch {} }
function step(ts) {
  if (v.readyState < 2 || !v.videoWidth) return null;
  if (o.width !== v.videoWidth) { o.width = v.videoWidth; o.height = v.videoHeight; }
  const res = pl.detectForVideo(v, ts);
  const poses = (res.landmarks || []).map(p => p.map(q => ({ x: q.x, y: q.y, v: q.visibility })));
  det.sens = +$('sens').value;
  const r = det.update(poses, ts / 1000, v.videoWidth / v.videoHeight);
  ctx.clearRect(0, 0, o.width, o.height); ctx.lineWidth = Math.max(2, o.width / 200);
  poses.forEach((p, i) => { ctx.strokeStyle = r.alert ? '#ff3b30' : ['#34c759', '#0a84ff', '#ff9f0a', '#bf5af2', '#64d2ff'][i % 5];
    for (const [a, b] of LINKS) { if ((p[a].v ?? 1) < 0.4 || (p[b].v ?? 1) < 0.4) continue; ctx.beginPath(); ctx.moveTo(p[a].x * o.width, p[a].y * o.height); ctx.lineTo(p[b].x * o.width, p[b].y * o.height); ctx.stroke(); } });
  return { r, poses };
}
function loop() {
  let last = -1;
  const tick = () => { raf = requestAnimationFrame(tick); if (!running) return;
    if (v.ended) { stopAll('Clip khatam.'); return; }
    const ts = performance.now(); if (ts - last < 90) return; last = ts;
    let out; try { out = step(ts); } catch (e) { return; } if (!out) return;
    const r = out.r; let lvl = r.level;
    if (r.alert) { if (!al.on) { al.on = true; al.start = Date.now(); beep(); } al.cool = 0; lvl = 'alert'; }
    else if (al.on && ++al.cool > 12) { al.on = false; const li = document.createElement('li'); li.textContent = new Date(al.start).toLocaleTimeString() + ' par, ' + Math.max(1, Math.round((Date.now() - al.start) / 1000)) + ' sec'; $('log').prepend(li); $('nolog').hidden = true; }
    else if (al.on) lvl = 'alert';
    $('cam').className = 'cam ' + (lvl === 'alert' ? 'alert' : '');
    $('badge').textContent = LABEL[lvl] + (r.count ? ' (' + r.count + ' log)' : ''); $('badge').hidden = false;
  };
  raf = requestAnimationFrame(tick);
}
function stopAll(msg) { running = false; cancelAnimationFrame(raf); if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; } v.pause(); v.srcObject = null; det.reset(); al = { on: false, start: 0, cool: 0 }; $('badge').hidden = true; $('cam').className = 'cam'; $('start').textContent = 'Camera start karo'; setStatus(msg || 'Band.'); }
$('start').onclick = async () => {
  if (running) return stopAll();
  try { stopAll(); stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: $('front').checked ? 'user' : 'environment', width: { ideal: 640 } }, audio: false });
    v.srcObject = stream; await v.play(); running = true; $('start').textContent = 'Band karo'; setStatus('Chal raha hai. Video kahin upload nahi ho raha.'); loop();
  } catch (e) { setStatus('Camera nahi khula: ' + (e.name || e) + '. Chrome me Allow dabao.'); }
};
$('file').onchange = async e => { const f = e.target.files[0]; if (!f) return; stopAll(); v.src = URL.createObjectURL(f); v.muted = true; v.loop = false; try { await v.play(); running = true; setStatus('Clip chal rahi hai...'); loop(); } catch { setStatus('Ye video play nahi hua.'); } e.target.value = ''; };
window.__step = step; window.__det = det; window.__v = v;
init();
