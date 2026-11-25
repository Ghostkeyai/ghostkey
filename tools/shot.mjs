// Potret halaman (WebGL nyala lewat SwiftShader). Pakai: node shot.mjs <url> <out.png> [lebar] [tinggi] [tunggu_ms]
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const [url, out, W = 1440, H = 900, wait = 7000] = process.argv.slice(2);
const port = 9700 + Math.floor(Math.random() * 200);
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--hide-scrollbars', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', `--user-data-dir=/private/tmp/claude-502/ghostkey-chrome-${port}`, `--remote-debugging-port=${port}`, `--window-size=${W},${H}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, id = 0; const pend = new Map();
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
try {
  let t; for (let i = 0; i < 60 && !t; i++) { try { t = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((x) => x.type === 'page'); } catch {} if (!t) await sleep(200); }
  ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener('open', r));
  const logs = [];
  ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { const p = pend.get(d.id); pend.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result); } if (d.method === 'Runtime.exceptionThrown') logs.push('EXC ' + d.params.exceptionDetails.exception?.description); if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') logs.push('ERR ' + d.params.args.map((a) => a.value ?? a.description).join(' ')); });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: +W, height: +H, deviceScaleFactor: 1, mobile: +W < 600 });
  await send('Page.navigate', { url }); await sleep(+wait);
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(out, Buffer.from(r.data, 'base64'));
  console.log('ok', out, logs.slice(0, 6).join(' | '));
} catch (e) { console.log('ERR', e.message); } finally { chrome.kill(); }
