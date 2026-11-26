// GHOSTKEY — "filter hidup" di belakang hantu hero (kanvas 2D piksel, di bawah hantu & di bawah tulisan).
// Paket permintaan datang dari kiri membawa label identitas (dompet emas, IP merah, perangkat biru).
// Saat lewat tirai pindai di belakang hantu, labelnya rontok jadi debu piksel; paket keluar bersih (mint)
// ke salah satu "dermaga" model di kanan. Nama model ASLI dari /api/models. Ilustrasi cara kerja, bukan lalu lintas sungguhan.
const REDUCE = matchMedia('(prefers-reduced-motion: reduce)').matches;
const TAG = ['#ffd27a', '#ff8a7a', '#8ec5ff'];          // dompet · IP · perangkat
const MSG = '#eef2ef', CLEAN = '#9ff0c8';
const OUTS = [-1, -0.74, 0.74, 1];                       // jalur keluar = dermaga model (atas & bawah, menjauhi kunci)
const rnd = (a, b) => a + Math.random() * (b - a);
const short = (id) => String(id).split('/').pop().replace(/:.*/, '').slice(0, 24);

export function mountFlow(stage, models = []) {
  const cv = document.createElement('canvas');
  cv.id = 'hero-flow';
  cv.setAttribute('aria-hidden', 'true');
  document.body.appendChild(cv);
  const cx = cv.getContext('2d');
  const font = getComputedStyle(document.documentElement).getPropertyValue('--font-pixel').trim() || 'monospace';
  const pool = (models.length ? models : ['anthropic/claude-sonnet-5.5', 'openai/gpt-5.5', 'google/gemini-3.8-flash', 'deepseek/deepseek-v4.1']).map(short);
  let poolI = 0;
  const docks = OUTS.map((o) => ({ o, name: pool[poolI++ % pool.length], flash: 0, swapAt: 0 }));

  let W = 1, H = 1, dpr = 1, P = 5, gx = 0, gy = 0, mobile = false, padL = 0, dx = 0;
  function layout() {
    const r = stage.getBoundingClientRect();
    mobile = innerWidth < 700;
    padL = 0;                                          // jangan mendekati judul di kolom kiri
    W = Math.max(1, Math.round(r.width + padL)); H = Math.max(1, Math.round(r.height));
    dpr = Math.min(devicePixelRatio || 1, 2);
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    cv.style.left = Math.round(r.left + scrollX - padL) + 'px';
    cv.style.top = Math.round(r.top + scrollY) + 'px';
    P = mobile ? 4 : 6;
    gx = padL + r.width * 0.42; gy = H * 0.46;           // tirai pindai: tepat di belakang badan hantu
    dx = W - (mobile ? 118 : 172);                       // penanda dermaga; nama model di kanannya
  }
  const snap = (v) => Math.round(v / P) * P;
  const dockY = (o) => gy + o * H * 0.4;

  const packets = [], dust = [];
  let spawnIn = 0.1, scan = 0;
  function spawn() {
    const len = 4 + ((Math.random() * 4) | 0);
    const tags = TAG.filter(() => Math.random() < 0.8);
    if (!tags.length) tags.push(TAG[(Math.random() * 3) | 0]);
    const d = (Math.random() * docks.length) | 0;
    packets.push({ x: -len * P - 40, lane: rnd(-1, 1), dock: d, v: rnd(95, 135) * (mobile ? 0.75 : 1), len, tags, clean: false });
  }
  // jalur: menyempit ke tirai, lalu menyebar ke dermaga model
  function yAt(p, x) {
    const spread = H * 0.34;
    if (x < gx) { const k = Math.max(0, Math.min(1, x / gx)); return gy + p.lane * spread * (1 - k * k * (3 - 2 * k)); }
    const k = Math.max(0, Math.min(1, (x - gx) / (dx - gx))); const e = k * k * (3 - 2 * k);
    return gy + (dockY(OUTS[p.dock]) - gy) * e;
  }

  function step(dt) {
    spawnIn -= dt; scan = Math.max(0, scan - dt * 2.2);
    if (spawnIn <= 0) { spawn(); spawnIn = rnd(0.28, 0.55) * (mobile ? 1.4 : 1); }
    for (let i = packets.length - 1; i >= 0; i--) {
      const p = packets[i];
      p.x += p.v * dt;
      if (!p.clean && p.x > gx) {
        p.clean = true; scan = 1;
        const y = yAt(p, p.x);
        p.tags.forEach((c, j) => { for (let k = 0; k < 9; k++) dust.push({ x: p.x - (p.len + 1 + j * 1.6) * P, y: y + rnd(-P * 1.5, P), vx: rnd(-90, 0), vy: rnd(-70, 10), c, life: rnd(0.6, 1.2), t: 0 }); });
      }
      if (p.x > dx) {
        const dk = docks[p.dock]; dk.flash = 1;
        if (++dk.swapAt % 3 === 0) dk.name = pool[poolI++ % pool.length];   // dermaga berganti model sesekali
        packets.splice(i, 1);
      }
    }
    for (let i = dust.length - 1; i >= 0; i--) {
      const d = dust[i]; d.t += dt; d.vy += 170 * dt; d.x += d.vx * dt; d.y += d.vy * dt;
      if (d.t > d.life) dust.splice(i, 1);
    }
    for (const d of docks) d.flash = Math.max(0, d.flash - dt * 1.6);
  }

  function draw() {
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cx.clearRect(0, 0, W, H);
    // rel titik redup: masuk menyempit, keluar ke tiap dermaga
    cx.fillStyle = '#ffffff14';
    for (const lane of [-0.85, -0.3, 0.3, 0.85]) { const p = { lane, dock: 0 }; for (let x = 0; x < gx; x += P * 3) cx.fillRect(snap(x), snap(yAt(p, x)), 2, 2); }
    cx.fillStyle = '#9ff0c818';
    for (let d = 0; d < OUTS.length; d++) { const p = { lane: 0, dock: d }; for (let x = gx; x < dx; x += P * 3) cx.fillRect(snap(x), snap(yAt(p, x)), 2, 2); }
    // tirai pindai di belakang hantu (berkedip saat paket lewat)
    const sh = H * 0.62, sy = gy - sh / 2;
    for (let y = 0; y < sh; y += P) {
      const a = (0.05 + scan * 0.22) * (1 - Math.abs(y / sh - 0.5) * 1.6);
      if (a <= 0) continue;
      cx.fillStyle = `rgba(159,240,200,${a.toFixed(3)})`;
      cx.fillRect(snap(gx), snap(sy + y), P / 2, P - 2);
    }
    // dermaga model di tepi kanan
    cx.font = `400 ${mobile ? 9 : 11}px ${font}`;
    cx.textAlign = 'left'; cx.textBaseline = 'middle';
    for (const d of docks) {
      const y = snap(dockY(d.o));
      cx.globalAlpha = 0.55 + d.flash * 0.45;
      cx.fillStyle = d.flash > 0.05 ? CLEAN : '#8f9a94';
      cx.fillRect(snap(dx) + P, y - P, P, P * 2 - 1);
      cx.fillText(d.name.toUpperCase(), snap(dx) + P * 3, y, W - snap(dx) - P * 3 - 4);   // tak pernah melewati tepi
    }
    cx.globalAlpha = 1;
    // paket
    for (const p of packets) {
      const x0 = snap(p.x), y = snap(yAt(p, p.x));
      const fadeIn = Math.max(0, Math.min(1, (p.x - p.len * P) / 90));
      cx.globalAlpha = fadeIn;
      if (p.clean) {   // pendar tipis di belakang paket bersih
        cx.fillStyle = '#9ff0c822'; cx.fillRect(x0 - p.len * P - 2, y - P - 2, p.len * P + 4, P * 3 + 4);
      }
      cx.fillStyle = p.clean ? CLEAN : MSG;
      for (let k = 0; k < p.len; k++) { cx.fillRect(x0 - k * P, y - P, P - 1, P - 1); if (k % 3 !== 1) cx.fillRect(x0 - k * P, y, P - 1, P - 1); }
      if (!p.clean) p.tags.forEach((c, j) => { cx.fillStyle = c; const tx = x0 - (p.len + 1 + j * 1.6) * P; cx.fillRect(tx, y - P, P, P * 2 - 1); });
    }
    for (const d of dust) {
      cx.globalAlpha = Math.max(0, 1 - d.t / d.life);
      cx.fillStyle = d.c; cx.fillRect(snap(d.x), snap(d.y), P - 2, P - 2);
    }
    cx.globalAlpha = 1;
  }

  let on = false, raf = 0, last = 0;
  const loop = (t) => { const dt = Math.min(0.05, (t - last) / 1000 || 0.016); last = t; step(dt); draw(); raf = requestAnimationFrame(loop); };
  const io = new IntersectionObserver(([e]) => {
    const want = e.isIntersecting && !REDUCE;
    if (want && !on) { on = true; last = performance.now(); raf = requestAnimationFrame(loop); }
    if (!want && on) { on = false; cancelAnimationFrame(raf); }
  });
  io.observe(stage);
  new ResizeObserver(layout).observe(stage);
  addEventListener('resize', layout, { passive: true });
  layout();
  for (let i = 0; i < 150; i++) step(1 / 30);           // mulai dengan jalur sudah terisi
  draw();
}
