// GHOSTKEY — hantu pendamping gulir.
// Satu hantu 3D (hero-ghost.js) ikut sepanjang halaman. Ia hanya duduk di "tempat" ([data-gslot]) yang sudah
// disisihkan di tata letak, jadi tidak pernah menutup tulisan. Saat bagian berganti, ia buyar jadi piksel,
// pikselnya mengalir ke tempat berikutnya, lalu menyatu lagi. Selama diam di tempatnya ia ikut gulir dengan
// sedikit lambat (pegas) dan condong ke arah gulir, supaya terasa hidup.
// data-gslot="nama" · data-look="-0.6" (menoleh ke kiri/kanan, -1..1) · data-size="w,h" opsional
import { mountGhost } from './hero-ghost.js';

const REDUCE = matchMedia('(prefers-reduced-motion: reduce)').matches;
const COLORS = ['#eef2ef', '#eef2ef', '#eef2ef', '#eef2ef', '#dfe7e2', '#eef2ef', '#9ff0c8', '#ffd27a'];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export function mountCompanion() {
  const slots = [...document.querySelectorAll('[data-gslot]')];
  if (!slots.length) return null;

  // kotak hantu (fixed, tak bisa diklik: klik ditangkap tempatnya)
  const box = document.createElement('div');
  box.id = 'companion';
  box.setAttribute('aria-hidden', 'true');
  document.body.appendChild(box);
  // kanvas partikel layar penuh (hanya digambar saat pindah)
  const fx = document.createElement('canvas');
  fx.id = 'companion-fx';
  fx.setAttribute('aria-hidden', 'true');
  document.body.appendChild(fx);
  const cx = fx.getContext('2d');

  const pixel = innerWidth < 700 ? 3 : 4;
  let cur = pickInitial();
  sizeTo(cur);
  let g;
  try { g = mountGhost(box, { pixel }); }
  catch (e) { box.remove(); fx.remove(); throw e; }
  for (const s of slots) s.classList.add('gslot-live');
  g.look(Number(cur.dataset.look || 0));

  addEventListener('gk-wave', () => { if (!moving) g.wave(); });
  // ketuk tempat = hantu menyapa
  for (const s of slots) s.addEventListener('pointerdown', () => { if (s === cur && !moving) g.wave(); });

  // ---------- keadaan ----------
  let moving = null;            // { t0, from:{x,y,w,h}, to, parts:[] }
  let lastY = scrollY, vel = 0, off = 0, offV = 0, lean = 0;
  let dpr = 1;

  function sizeTo(slot) {
    const r = slot.getBoundingClientRect();
    box.style.width = Math.round(r.width) + 'px';
    box.style.height = Math.round(r.height) + 'px';
  }
  function slotRect(s) { return s.getBoundingClientRect(); }
  function visibleSlot(s) {
    const r = slotRect(s);
    if (!r.width || !r.height) return false;             // tersembunyi (mis. hanya-desktop)
    const c = r.top + r.height / 2;
    return c > -r.height * 0.2 && c < innerHeight + r.height * 0.2;
  }
  function pickInitial() {
    let best = slots[0], bd = Infinity;
    for (const s of slots) {
      const r = slotRect(s); if (!r.width) continue;
      const d = Math.abs(r.top + r.height / 2 - innerHeight * 0.45);
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }
  // tempat aktif = yang terlihat dan paling dekat garis 45% layar; tempat sekarang dipertahankan selama masih nyaman terlihat
  function wanted() {
    const anchor = innerHeight * 0.45;
    let best = null, bd = Infinity;
    for (const s of slots) {
      if (!visibleSlot(s)) continue;
      const r = slotRect(s), d = Math.abs(r.top + r.height / 2 - anchor);
      if (d < bd) { bd = d; best = s; }
    }
    if (!best) return cur;
    if (best === cur) return cur;
    const rc = slotRect(cur), cc = rc.top + rc.height / 2;
    const curOk = rc.width && cc > innerHeight * 0.12 && cc < innerHeight * 0.88;
    const rb = slotRect(best), dc = Math.abs(cc - anchor), db = Math.abs(rb.top + rb.height / 2 - anchor);
    return curOk && dc < db + innerHeight * 0.18 ? cur : best;
  }

  // ---------- pindah: buyar → mengalir → menyatu ----------
  function startMove(to) {
    const r = box.getBoundingClientRect();
    const from = { x: clamp(r.left, -r.width * 0.5, innerWidth - r.width * 0.5), y: clamp(r.top, -r.height * 0.6, innerHeight - r.height * 0.4), w: r.width, h: r.height };
    cur = to;
    if (REDUCE) { sizeTo(to); g.look(Number(to.dataset.look || 0)); return; }
    const n = innerWidth < 700 ? 90 : 150, parts = [];
    const sz = pixel;
    for (let i = 0; i < n; i++) {
      // titik awal: di dalam siluet kira-kira (elips badan, agak ke kiri karena kunci di kanan)
      const a = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random());
      const sx = from.x + from.w * (0.45 + Math.cos(a) * rr * 0.22), sy = from.y + from.h * (0.46 + Math.sin(a) * rr * 0.3);
      const a2 = Math.random() * Math.PI * 2, r2 = Math.sqrt(Math.random());
      parts.push({ sx, sy, ex: 0.45 + Math.cos(a2) * r2 * 0.22, ey: 0.46 + Math.sin(a2) * r2 * 0.3,
        d: Math.random() * 0.28, bend: (Math.random() - 0.5) * 0.5, c: COLORS[(Math.random() * COLORS.length) | 0],
        s: sz * (Math.random() < 0.2 ? 2 : 1) });
    }
    moving = { t0: performance.now(), parts, swapped: false };
    box.classList.add('out');
  }

  const DUR = 1000;   // ms total
  function drawMove(now) {
    const m = moving, t = (now - m.t0) / DUR;
    cx.clearRect(0, 0, fx.width, fx.height);
    // tukar ukuran & tempat saat hantu tak terlihat
    if (!m.swapped && t > 0.22) { m.swapped = true; sizeTo(cur); g.look(Number(cur.dataset.look || 0)); }
    if (!m.reveal && t > 0.74) { m.reveal = true; box.classList.remove('out'); g.hop(); }
    const tr = slotRect(cur);
    for (const p of m.parts) {
      const k = clamp((t - p.d) / 0.7, 0, 1);
      if (k <= 0) { // belum berangkat: piksel diam di tempat lama, muncul cepat
        const a0 = clamp(t / 0.12, 0, 1);
        cx.globalAlpha = a0; cx.fillStyle = p.c; cx.fillRect(p.sx * dpr, p.sy * dpr, p.s * dpr, p.s * dpr); continue;
      }
      if (k >= 1) continue;
      const e = ease(k);
      const ex = tr.left + tr.width * p.ex, ey = tr.top + tr.height * p.ey;
      // lengkung lembut ke samping (bukan garis lurus)
      const mx = (p.sx + ex) / 2 + (ey - p.sy) * p.bend, my = (p.sy + ey) / 2 - (ex - p.sx) * p.bend;
      const x = (1 - e) * (1 - e) * p.sx + 2 * (1 - e) * e * mx + e * e * ex;
      const y = (1 - e) * (1 - e) * p.sy + 2 * (1 - e) * e * my + e * e * ey;
      cx.globalAlpha = k > 0.82 ? (1 - k) / 0.18 : 0.95;
      cx.fillStyle = p.c;
      cx.fillRect(Math.round(x * dpr), Math.round(y * dpr), p.s * dpr, p.s * dpr);
    }
    cx.globalAlpha = 1;
    if (t >= 1.02) { moving = null; cx.clearRect(0, 0, fx.width, fx.height); }
  }

  function resizeFx() {
    dpr = Math.min(devicePixelRatio || 1, 2);
    fx.width = Math.round(innerWidth * dpr); fx.height = Math.round(innerHeight * dpr);
    if (!moving) sizeTo(cur);
  }
  addEventListener('resize', resizeFx, { passive: true });
  resizeFx();

  // ---------- loop: ikuti tempat + pegas gulir ----------
  let last = performance.now();
  function tick(now) {
    const dt = clamp((now - last) / 1000, 0, 0.05); last = now;
    const dy = scrollY - lastY; lastY = scrollY;
    vel += (dy / Math.max(dt, 1 / 120) - vel) * 0.2;                  // px/s
    // pegas: hantu sedikit tertinggal saat menggulir, kembali pelan
    const target = clamp(-vel * 0.018, -22, 22);
    offV += ((target - off) * 90 - offV * 14) * dt; off += offV * dt;
    lean += (clamp(vel * 0.004, -7, 7) - lean) * 0.12;

    if (!moving) { const w = wanted(); if (w !== cur) startMove(w); }
    const r = slotRect(cur);
    const y = moving && !moving.swapped ? null : r.top + (REDUCE ? 0 : off);
    if (y !== null) box.style.transform = `translate3d(${Math.round(r.left)}px, ${Math.round(y)}px, 0) rotate(${(REDUCE ? 0 : lean).toFixed(2)}deg)`;
    if (moving) drawMove(now);
    raf = requestAnimationFrame(tick);
  }
  let raf = requestAnimationFrame(tick);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) cancelAnimationFrame(raf);
    else { last = performance.now(); lastY = scrollY; raf = requestAnimationFrame(tick); }
  });

  return { ghost: g, get slot() { return cur; } };
}
