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
  return { c, scale: Math.max(sh, h * 0.5, w * 0.5, 0.05) };
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
