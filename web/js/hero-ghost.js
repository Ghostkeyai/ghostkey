// GHOSTKEY — maskot hantu imut 3D di hero (three.js, tanpa aset luar).
// Hantu putih ramah memegang kunci emas, digambar lewat efek piksel kotak:
// render resolusi rendah → kuantisasi warna + dither Bayer → kisi tipis antarpiksel hanya di objek, latar transparan.
// Pemakaian: import { mountGhost } from './hero-ghost.js'; const g = mountGhost(elemen, { pixel: 4 });
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const BG = '#121413';
const V2 = THREE.Vector2;

// ---------- tekstur kecil dari kanvas 2D ----------
function radialTex(inner) {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, inner); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
// bintang 4 sudut untuk kilau kunci
function starTex() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  g.translate(64, 64); g.fillStyle = '#fff6d8';
  g.beginPath();
  for (let i = 0; i < 8; i++) { const r = i % 2 ? 9 : 62, a = i * Math.PI / 4; g.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
  g.closePath(); g.fill();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

// ---------- kunci emas (titik asal = pusat lingkaran pegangan) ----------
function keyGeometry() {
  const bow = new THREE.Shape(); bow.absarc(0, 0, 1, 0, Math.PI * 2, false);
  const hole = new THREE.Path(); hole.absarc(0, 0, 0.5, 0, Math.PI * 2, true); bow.holes.push(hole);
  const P = [[0.9, 0.15], [4.0, 0.15], [4.0, -0.66], [3.8, -0.66], [3.8, -0.42], [3.6, -0.42], [3.6, -0.74],
    [3.38, -0.74], [3.38, -0.46], [3.18, -0.46], [3.18, -0.62], [2.98, -0.62], [2.98, -0.15], [0.9, -0.15]];
  const shaft = new THREE.Shape(); shaft.moveTo(...P[0]); P.slice(1).forEach((p) => shaft.lineTo(...p)); shaft.closePath();
  const collar = new THREE.Shape();
  collar.moveTo(1.1, 0.3); collar.lineTo(1.3, 0.3); collar.lineTo(1.3, -0.3); collar.lineTo(1.1, -0.3); collar.closePath();
  const set = { depth: 0.28, bevelEnabled: true, bevelThickness: 0.07, bevelSize: 0.05, bevelSegments: 4, curveSegments: 48 };
  const g = mergeGeometries([bow, shaft, collar].map((s) => new THREE.ExtrudeGeometry(s, set)), false);
  g.translate(0, 0, -0.14);
  return g;
}

// ---------- hantu ----------
function makeGhost() {
  const uT = { value: 0 };
  const root = new THREE.Group();      // posisi melayang
  const body = new THREE.Group();      // badan + wajah + tangan
  root.add(body);

  // profil lathe: ujung bawah sedikit mengembang → sisi → kubah kepala yang agak tinggi
  const prof = [];
  const Y0 = -0.08, RY = 1.1;
  for (let i = 0; i <= 18; i++) {
    const k = i / 18, y = -1.46 + k * (1.46 + Y0);
    prof.push(new V2(1.0 + 0.085 * (1 - k) ** 2.2 - 0.012 * Math.sin(k * Math.PI), y));
  }
  for (let i = 1; i <= 40; i++) {
    const a = (Math.PI / 2) * (i / 40);
    prof.push(new V2(Math.max(0.0001, Math.cos(a)), Y0 + Math.sin(a) * RY));
  }
  const geo = new THREE.LatheGeometry(prof, 160);
  geo.rotateY(Math.PI);   // jahitan lathe ke belakang, jauh dari kamera

  const bodyMat = new THREE.MeshPhysicalMaterial({
    color: '#f6faf8', roughness: 0.4, sheen: 1, sheenRoughness: 0.5, sheenColor: '#9ff0c8',
    clearcoat: 0.35, clearcoatRoughness: 0.35, envMapIntensity: 0.75, side: THREE.DoubleSide,
    emissive: '#9ff0c8', emissiveIntensity: 0.035,
  });
  bodyMat.onBeforeCompile = (s) => {
    s.uniforms.uTime = uT;
    s.vertexShader = 'uniform float uTime;\n' + s.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      float phi = atan(position.z, position.x);
      float hem = smoothstep(-0.8, -1.46, position.y);
      float w = phi*6.0 - uTime*2.3;
      transformed.y += hem*0.15*sin(w);
      transformed.xz *= 1.0 + hem*(0.055*cos(w) + 0.03);`);
  };
  const armMat = new THREE.MeshPhysicalMaterial({
    color: '#f6faf8', roughness: 0.42, sheen: 1, sheenRoughness: 0.5, sheenColor: '#9ff0c8',
    clearcoat: 0.3, envMapIntensity: 0.75, emissive: '#9ff0c8', emissiveIntensity: 0.035,
  });
  body.add(new THREE.Mesh(geo, bodyMat));

  // titik di permukaan kepala (untuk menempel wajah)
  const surfZ = (x, y) => {
    let r = 1.0;
    if (y > Y0) { const s = Math.min(1, (y - Y0) / RY); r = Math.sqrt(1 - s * s); }
    return Math.sqrt(Math.max(0, r * r - x * x));
  };

  // wajah
  const face = new THREE.Group(); body.add(face);
  const eyeMat = new THREE.MeshPhysicalMaterial({ color: '#11141b', roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: 1.3 });
  const white = new THREE.MeshBasicMaterial({ color: '#ffffff' });
  const sph = new THREE.SphereGeometry(1, 28, 18);
  const eyes = [], happy = [];
  const EY = 0.03;
  [-1, 1].forEach((sx) => {
    const x = sx * 0.32, z = surfZ(x, EY);
    const eye = new THREE.Group(); eye.position.set(x, EY, z - 0.025);
    eye.lookAt(x * 3, EY * 0.4, z * 3);
    const ball = new THREE.Mesh(sph, eyeMat); ball.scale.set(0.14, 0.19, 0.07); eye.add(ball);
    const hi1 = new THREE.Mesh(sph, white); hi1.scale.setScalar(0.055); hi1.position.set(-0.045, 0.07, 0.06); eye.add(hi1);
    const hi2 = new THREE.Mesh(sph, white); hi2.scale.setScalar(0.026); hi2.position.set(0.05, -0.07, 0.06); eye.add(hi2);
    face.add(eye); eyes.push(eye);
    // mata senang "^": busur kecil, tampil saat melambai
    const arc = new THREE.Mesh(new THREE.TorusGeometry(0.085, 0.024, 8, 20, Math.PI), eyeMat);
    arc.position.set(x, EY - 0.04, z + 0.01); arc.lookAt(x * 3, EY * 0.4, z * 3); arc.visible = false;
    face.add(arc); happy.push(arc);
    // pipi merona
    const by = -0.15, bx = sx * 0.56, bz = surfZ(bx, by) + 0.012;
    const blush = new THREE.Mesh(new THREE.CircleGeometry(0.125, 28), new THREE.MeshBasicMaterial({ color: '#ff9db2', transparent: true, opacity: 0.6 }));
    blush.position.set(bx, by, bz); blush.lookAt(bx * 3, by, bz * 3); blush.scale.set(1, 0.62, 1);
    face.add(blush);
  });
  // senyum
  const smile = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.019, 8, 24, Math.PI), eyeMat);
  smile.rotation.z = Math.PI; smile.position.set(0, -0.1, surfZ(0, -0.1) + 0.005); face.add(smile);
  // mulut terbuka kecil (saat senang)
  const mouth = new THREE.Mesh(new THREE.CircleGeometry(0.075, 24, Math.PI, Math.PI), new THREE.MeshBasicMaterial({ color: '#2a1a22' }));
  mouth.position.set(0, -0.085, surfZ(0, -0.1) + 0.008); mouth.visible = false; face.add(mouth);
  const tongue = new THREE.Mesh(new THREE.CircleGeometry(0.04, 16, Math.PI, Math.PI), new THREE.MeshBasicMaterial({ color: '#ff8fa8' }));
  tongue.position.set(0, -0.13, 0.002); tongue.scale.set(1, 0.7, 1); mouth.add(tongue);

  // tangan kiri (layar kiri) — bisa melambai
  const armL = new THREE.Group(); armL.position.set(-0.86, -0.36, 0.12); body.add(armL);
  const handL = new THREE.Mesh(sph, armMat); handL.scale.set(0.24, 0.155, 0.17); handL.position.set(-0.2, -0.02, 0.06); handL.rotation.z = 0.35;
  armL.add(handL);

  // tangan kanan memegang kunci emas
  const armR = new THREE.Group(); armR.position.set(0.86, -0.36, 0.12); body.add(armR);
  const handR = new THREE.Mesh(sph, armMat); handR.scale.set(0.24, 0.155, 0.17); handR.position.set(0.2, -0.02, 0.06); handR.rotation.z = -0.35;
  armR.add(handR);
  const goldMat = new THREE.MeshPhysicalMaterial({ color: '#ffcf6b', metalness: 1, roughness: 0.2, clearcoat: 1, clearcoatRoughness: 0.08,
    envMapIntensity: 1.6, emissive: '#ffb84a', emissiveIntensity: 0 });
  const keyPivot = new THREE.Group(); keyPivot.position.set(0.36, 0.02, 0.16); armR.add(keyPivot);
  const key = new THREE.Mesh(keyGeometry(), goldMat);
  key.scale.setScalar(0.27); key.rotation.set(0.15, -0.45, 0.95);
  keyPivot.add(key);
  // ibu jari di depan cincin kunci → terbaca "digenggam"
  const thumb = new THREE.Mesh(sph, armMat); thumb.scale.set(0.1, 0.085, 0.08); thumb.position.set(0.02, -0.07, 0.15);
  keyPivot.add(thumb);
  // kilau di ujung kunci
  const glint = new THREE.Sprite(new THREE.SpriteMaterial({ map: starTex(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: '#ffe9b0' }));
  glint.position.set(3.4, 0.35, 0.4); glint.scale.setScalar(0.001); key.add(glint);

  root.position.y = 0;
  return {
    root, body, uT,
    parts: { eyes, happy, smile, mouth, armL, armR, keyPivot, key, goldMat, glint, face },
  };
}

// bintang piksel kecil di sekitar hantu
function sparkles(n = 26) {
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), seed = [];
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, r = 1.9 + Math.random() * 1.6;
    pos.set([Math.cos(a) * r * 1.2, Math.sin(a) * r * 0.85 + 0.1, -0.8 - Math.random() * 1.6], i * 3);
    seed.push(Math.random() * 6.28);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const tints = [new THREE.Color('#c9ffe6'), new THREE.Color('#ffffff'), new THREE.Color('#9ff0c8')];
  const bg = new THREE.Color(BG), tmp = new THREE.Color();
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.075, vertexColors: true, depthWrite: false }));
  return {
    pts,
    update(t) {
      for (let i = 0; i < n; i++) {
        const k = Math.max(0, Math.sin(t * 1.3 + seed[i])) ** 2;
        tmp.copy(bg).lerp(tints[i % 3], k); col.set([tmp.r, tmp.g, tmp.b], i * 3);
      }
      geo.attributes.color.needsUpdate = true;
    },
  };
}

// ---------- shader efek piksel ----------
function pixelPass(rt, exposure) {
  return new THREE.ShaderMaterial({
    toneMapped: false, depthTest: false, transparent: true,
    uniforms: {
      tDiffuse: { value: rt.texture }, uLow: { value: new V2() }, uScreen: { value: new V2() },
      uPx: { value: 1 }, uExp: { value: exposure }, uBg: { value: new THREE.Color(BG) }, uLevels: { value: 11 },
    },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }',
    fragmentShader: /* glsl */`
      uniform sampler2D tDiffuse; uniform vec2 uLow, uScreen; uniform float uPx, uExp, uLevels; uniform vec3 uBg;
      varying vec2 vUv;
      vec3 aces(vec3 x){ return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14), 0., 1.); }
      vec3 tm(vec2 cc){ return pow(aces(texture2D(tDiffuse, (cc + 0.5)/uLow).rgb*uExp), vec3(1./2.2)); }
      float bayer(vec2 p){
        int i = int(mod(p.x,4.)) + int(mod(p.y,4.))*4;
        float m[16] = float[16](0.,8.,2.,10.,12.,4.,14.,6.,3.,11.,1.,9.,15.,7.,13.,5.);
        return (m[i] + 0.5)/16.;
      }
      void main(){
        vec2 fp = vUv*uScreen, cell = floor(fp/uPx);
        vec3 c = tm(cell);
        vec3 bgT = pow(aces(uBg*uExp), vec3(1./2.2));
        if (distance(c, bgT) < 0.045) { gl_FragColor = vec4(0.); return; }   // latar → transparan (CSS di belakang terlihat)
        vec3 q = floor(c*uLevels + bayer(cell))/uLevels;
        vec2 l = fract(fp/uPx);
        float gap = clamp(step(l.x, 1./uPx) + step(l.y, 1./uPx), 0., 1.);
        q = mix(q, q*0.82, gap*step(3.5, uPx));                                // kisi tipis antarpiksel, hanya di objek
        gl_FragColor = vec4(q, 1.);
      }`,
  });
}

// ---------- pasang ke elemen ----------
export function mountGhost(host, { pixel = 4 } = {}) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const canvas = document.createElement('canvas');
  canvas.className = 'ghost-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  host.appendChild(canvas);

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: 'default' });
  } catch (e) { canvas.remove(); throw e; }
  if (!renderer.capabilities.isWebGL2) { renderer.dispose(); canvas.remove(); throw new Error('webgl2'); }
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BG);   // warna latar dipakai shader untuk mengenali latar
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  scene.add(new THREE.HemisphereLight('#eafff5', '#1b2420', 0.95));
  const sun = new THREE.DirectionalLight('#ffffff', 1.7); sun.position.set(-3, 4, 6); scene.add(sun);
  const rim = new THREE.DirectionalLight('#9ff0c8', 2.4); rim.position.set(3.5, 2, -4); scene.add(rim);
  const warm = new THREE.PointLight('#ffd27a', 3, 4, 2); warm.position.set(2.2, 0.6, 1.6); scene.add(warm);

  const world = new THREE.Group(); scene.add(world);
  const ghost = makeGhost(); world.add(ghost.root);
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: radialTex('rgba(159,240,200,0.42)'), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  glow.position.set(0, -2.05, -0.2); world.add(glow);
  const sp = sparkles(); world.add(sp.pts);

  // render target resolusi rendah + MSAA (tepi siluet lebih halus)
  const rt = new THREE.WebGLRenderTarget(1, 1, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, type: THREE.HalfFloatType, samples: 4 });
  const postMat = pixelPass(rt, 1.05);
  const postScene = new THREE.Scene();
  postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMat));
  const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  // tata letak: kamera menjaga hantu + kunci tetap utuh di kotak berapa pun rasionya
  let W = 1, H = 1;
  function layout() {
    const r = host.getBoundingClientRect();
    W = Math.max(1, Math.round(r.width)); H = Math.max(1, Math.round(r.height));
    renderer.setSize(W, H, false);
    const dpr = renderer.getPixelRatio(), cell = Math.max(1, pixel * dpr);
    const lw = Math.ceil((W * dpr) / cell), lh = Math.ceil((H * dpr) / cell);
    rt.setSize(lw, lh);
    postMat.uniforms.uLow.value.set(lw, lh);
    postMat.uniforms.uScreen.value.set(W * dpr, H * dpr);
    postMat.uniforms.uPx.value = cell;
    camera.aspect = W / H;
    const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const d = Math.max(4.6 / (2 * tan), 4.9 / (2 * tan * camera.aspect));
    camera.position.set(0, 0.05, d); camera.lookAt(0, -0.1, 0);
    camera.updateProjectionMatrix();
    world.position.x = -0.3;
    if (reduce) frame(1.2);
  }

  // input: ikuti penunjuk, ketuk = melambai
  const m = { x: 0, y: 0, sx: 0, sy: 0 };
  const onMove = (e) => {
    const r = host.getBoundingClientRect();
    m.x = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / (innerWidth * 0.5)));
    m.y = Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height / 2)) / (innerHeight * 0.6)));
  };
  addEventListener('pointermove', onMove, { passive: true });
  let waveAt = 1.6, waveLen = 2.2, hopAt = -10;
  const t0 = performance.now();
  const now = () => (performance.now() - t0) / 1000;
  const greet = () => { const t = now(); if (t - waveAt > waveLen) { waveAt = t; hopAt = t; } };
  host.addEventListener('pointerdown', greet);

  const P = ghost.parts;
  let blinkNext = 2.4, blinkAt = -1, doubleBlink = false;
  let glintAt = 3.2;

  function frame(t) {
    ghost.uT.value = t;
    sp.update(t);
    // kedip acak, kadang dua kali
    if (t > blinkNext) { blinkAt = t; doubleBlink = Math.random() < 0.3; blinkNext = t + 2.6 + Math.random() * 3.2; }
    const bt = t - blinkAt;
    const closed = (bt >= 0 && bt < 0.11) || (doubleBlink && bt > 0.22 && bt < 0.33);

    // lambaian: angkat tangan kiri, goyang
    const wt = t - waveAt;
    const waving = wt >= 0 && wt < waveLen;
    const up = waving ? Math.sin(Math.min(1, wt / 0.35) * Math.PI / 2) * (wt > waveLen - 0.35 ? (waveLen - wt) / 0.35 : 1) : 0;
    P.armL.rotation.z = -up * 1.75 + (waving ? Math.sin(wt * 13) * 0.38 * up : Math.sin(t * 1.9) * 0.08);
    P.armR.rotation.z = Math.sin(t * 1.9 + 1) * 0.07 + up * 0.12;
    P.keyPivot.rotation.z = Math.sin(t * 1.6) * 0.07;
    P.eyes.forEach((e) => { e.visible = !waving; e.scale.y = closed ? 0.12 : 1; });
    P.happy.forEach((a) => { a.visible = waving; });
    P.smile.visible = !waving; P.mouth.visible = waving;
    if (!waving && t - waveAt > 9 + Math.random() * 0.02) { waveAt = t + 0.001; }

    // kilau kunci tiap ±3,4 detik
    if (t > glintAt + 1.1) glintAt = t + 2.2 + Math.random() * 1.6;
    const gt = (t - glintAt) / 0.9;
    const g = gt > 0 && gt < 1 ? Math.sin(gt * Math.PI) : 0;
    P.goldMat.emissiveIntensity = g * 0.55;
    P.glint.scale.setScalar(0.001 + g * 2.6);
    P.glint.material.rotation = gt * 1.2;

    // melayang + loncat kecil saat disapa
    const ht = t - hopAt;
    const hop = ht >= 0 && ht < 0.5 ? Math.sin((ht / 0.5) * Math.PI) * 0.28 : 0;
    const bob = Math.sin(t * 1.45) * 0.12;
    ghost.root.position.y = 0.06 + bob + hop;
    ghost.root.rotation.z = Math.sin(t * 0.9) * 0.045;
    ghost.body.scale.set(1 - hop * 0.08, 1 + Math.sin(t * 2.9) * 0.012 + hop * 0.12, 1);
    const k = 1 - (bob + hop + 0.12) * 0.9;
    glow.scale.set(3.1 * k, 0.75 * k, 1);
    glow.material.opacity = 0.75 + 0.25 * k;

    // menoleh ke arah penunjuk
    m.sx += (m.x - m.sx) * 0.06; m.sy += (m.y - m.sy) * 0.06;
    ghost.root.rotation.y = m.sx * 0.55;
    ghost.root.rotation.x = m.sy * 0.16;

    renderer.setRenderTarget(rt); renderer.render(scene, camera);
    renderer.setRenderTarget(null); renderer.render(postScene, postCam);
  }

  // jalan hanya saat hero terlihat & tab aktif
  let visible = true, running = false;
  const loop = () => frame(now());
  function sync() {
    const want = !reduce && visible && !document.hidden;
    if (want && !running) { renderer.setAnimationLoop(loop); running = true; }
    if (!want && running) { renderer.setAnimationLoop(null); running = false; }
  }
  const io = new IntersectionObserver(([en]) => { visible = en.isIntersecting; sync(); }, { rootMargin: '80px' });
  io.observe(host);
  document.addEventListener('visibilitychange', sync);
  const ro = new ResizeObserver(() => layout());
  ro.observe(host);
  layout();
  frame(reduce ? 1.2 : 0);
  host.classList.add('live');
  sync();

  return {
    wave: greet,
    dispose() {
      renderer.setAnimationLoop(null); io.disconnect(); ro.disconnect();
      removeEventListener('pointermove', onMove); document.removeEventListener('visibilitychange', sync);
      renderer.dispose(); canvas.remove(); host.classList.remove('live');
    },
  };
}
