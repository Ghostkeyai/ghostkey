// Latar piksel hidup untuk semua halaman: bintang berkelip bertahap, paket data mint melintas, hantu mini melayang naik.
// Kanvas resolusi rendah (1 sel = 4 px CSS) diperbesar dengan image-rendering: pixelated → murah & tajam.
// Jalan ±20 fps, berhenti saat tab tersembunyi; prefers-reduced-motion → digambar sekali, diam.
const CELL = 4;
const MINT = [159, 240, 200], INK = [238, 242, 239], GOLD = [255, 210, 122];
// hantu mini 7×8 (1 = badan, 0 = kosong; mata = lubang)
const GHOST = ['0111110', '1111111', '1011011', '1111111', '1111111', '1111111', '1111111', '1010101'];

export function mountPixelBg() {
  if (document.getElementById('pxbg')) return;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const cv = document.createElement('canvas');
  cv.id = 'pxbg'; cv.setAttribute('aria-hidden', 'true');
  document.body.prepend(cv);
  const g = cv.getContext('2d', { alpha: true });
  let W = 0, H = 0, stars = [], packets = [], ghosts = [], seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

  function build() {
    W = Math.ceil(innerWidth / CELL); H = Math.ceil(innerHeight / CELL);
    cv.width = W; cv.height = H;
    const small = innerWidth < 700;
    seed = 7;
    stars = Array.from({ length: Math.round((W * H) / (small ? 260 : 190)) }, () => ({
      x: Math.floor(rnd() * W), y: Math.floor(rnd() * H * 1.6), ph: rnd() * 10, sp: .5 + rnd() * 1.4,
      c: rnd() < .22 ? MINT : INK, big: rnd() < .06, depth: .2 + rnd() * .8,
    }));
    packets = Array.from({ length: small ? 5 : 11 }, () => newPacket(true));
    ghosts = Array.from({ length: small ? 2 : 4 }, () => newGhost(true));
  }
  function newPacket(anywhere) {
    return { x: anywhere ? rnd() * W : -6, y: Math.floor(rnd() * H), v: .25 + rnd() * .5, len: 2 + Math.floor(rnd() * 4), stripAt: rnd() < .45 ? W * (.35 + rnd() * .45) : Infinity };
  }
  function newGhost(anywhere) {
    return { x: rnd() * (W - 8), y: anywhere ? rnd() * H : H + 10, v: .05 + rnd() * .07, ph: rnd() * 6, a: .08 + rnd() * .07 };
  }
  const px = (x, y, c, a) => { g.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${a})`; g.fillRect(x | 0, y | 0, 1, 1); };

  function draw(t) {
    g.clearRect(0, 0, W, H);
    const sy = (scrollY / CELL) * .06;
    // bintang: kecerahan 4 tingkat (patah-patah ala piksel)
    for (const s of stars) {
      const y = ((s.y - sy * s.depth) % (H * 1.6) + H * 1.6) % (H * 1.6);
      if (y >= H) continue;
      const k = Math.floor(((Math.sin(t * s.sp + s.ph) + 1) / 2) * 4) / 4;
      const a = (.05 + k * .3) * s.depth;
      px(s.x, y, s.c, a);
      if (s.big && k > .6) { px(s.x - 1, y, s.c, a * .5); px(s.x + 1, y, s.c, a * .5); px(s.x, y - 1, s.c, a * .5); px(s.x, y + 1, s.c, a * .5); }
    }
    // paket data: garis mint melintas; sebagian "dilepas" jadi titik emas lalu pudar (identitas dibuang)
    for (let i = 0; i < packets.length; i++) {
      const p = packets[i];
      p.x += p.v;
      if (p.x > p.stripAt) {
        const f = Math.min(1, (p.x - p.stripAt) / 18);
        px(p.x, p.y, MINT, .35 * (1 - f * .3));
        px(p.stripAt - (p.x - p.stripAt) * .3, p.y + Math.min(3, (p.x - p.stripAt) / 6), GOLD, .4 * (1 - f));
      } else for (let j = 0; j < p.len; j++) px(p.x - j, p.y, MINT, .32 - j * .06);
      if (p.x > W + 6) packets[i] = newPacket(false);
    }
    // hantu mini melayang naik, bergoyang pelan
    for (let i = 0; i < ghosts.length; i++) {
      const h = ghosts[i];
      h.y -= h.v;
      const ox = Math.round(h.x + Math.sin(t * .6 + h.ph) * 2), oy = Math.round(h.y);
      const wob = Math.floor(t * 2 + h.ph) % 2; // ujung bawah bergantian
      for (let r = 0; r < 8; r++) for (let c = 0; c < 7; c++) {
        let on = GHOST[r][c] === '1';
        if (r === 7) on = (c + wob) % 2 === 0;
        if (on) px(ox + c, oy + r, INK, h.a);
      }
      if (h.y < -12) ghosts[i] = newGhost(false);
    }
  }

  build();
  addEventListener('resize', () => { build(); if (reduce) draw(1); }, { passive: true });
  if (reduce) { draw(1); return; }
  let last = 0, raf = 0;
  const loop = (ms) => {
    raf = requestAnimationFrame(loop);
    if (ms - last < 50) return; // ±20 fps cukup untuk gerak piksel
    last = ms; draw(ms / 1000);
  };
  const sync = () => { cancelAnimationFrame(raf); if (!document.hidden) raf = requestAnimationFrame(loop); };
  document.addEventListener('visibilitychange', sync);
  sync();
}
