// Penampil JSON berwarna dengan penanda per jalur kunci (mis. 'body.provider' disorot, 'user' dicoret).
// mark(path) → null | { cls: 'hl' | 'rm', note?: 'teks', noteCls?: 'add' | 'del' }
import { esc } from '/js/common.js';

export function jsonHtml(value, { mark = () => null, maxStr = 0 } = {}) {
  // String panjang dipotong untuk tampilan saja (salinan lengkap tetap bisa disalin)
  const str = (s) => {
    if (maxStr && s.length > maxStr) {
      return `<span class="s">${esc(JSON.stringify(s.slice(0, maxStr)).slice(0, -1))}…"</span><span class="note cut">+${s.length - maxStr} chars</span>`;
    }
    return `<span class="s">${esc(JSON.stringify(s))}</span>`;
  };
  const prim = (v) => {
    if (v === null) return '<span class="b">null</span>';
    if (typeof v === 'string') return str(v);
    if (typeof v === 'number') return `<span class="n">${v}</span>`;
    if (typeof v === 'boolean') return `<span class="b">${v}</span>`;
    return esc(String(v));
  };
  const wrap = (path, html) => {
    const m = mark(path);
    if (!m) return html;
    const note = m.note ? `<span class="note ${m.noteCls || (m.cls === 'rm' ? 'del' : 'add')}">${esc(m.note)}</span>` : '';
    return `<span class="${m.cls}">${html}</span>${note}`;
  };
  const walk = (v, path, ind) => {
    if (v === null || typeof v !== 'object') return prim(v);
    const pad = ind + '  ';
    if (Array.isArray(v)) {
      if (!v.length) return '[]';
      return '[\n' + v.map((x, i) => pad + wrap(`${path}[${i}]`, walk(x, `${path}[${i}]`, pad))).join(',\n') + '\n' + ind + ']';
    }
    const keys = Object.keys(v);
    if (!keys.length) return '{}';
    return '{\n' + keys.map((k) => {
      const p = path ? `${path}.${k}` : k;
      return pad + wrap(p, `<span class="k">"${esc(k)}"</span>: ${walk(v[k], p, pad)}`);
    }).join(',\n') + '\n' + ind + '}';
  };
  return walk(value, '', '');
}
