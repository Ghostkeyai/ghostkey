// Grafik DEX Screener (iframe) untuk $GHOST. Pakai alamat TOKEN, bukan pasangan: DEX Screener memilih pool utama sendiri,
// jadi setelah graduasi ke Uniswap v4 grafik otomatis pindah ke pool besar. Dimuat malas (lazy) saat terlihat.
import { getConfig, esc } from '/js/common.js';

export async function mountChart(el) {
  if (!el) return;
  const cfg = await getConfig();
  const t = cfg.ghostToken;
  if (!t) { el.hidden = true; return; }
  const ponsUrl = cfg.links?.pons || `https://ponsfamily.com/launchpad/${t.toLowerCase()}`;
  const src = `https://dexscreener.com/robinhood/${t}?embed=1&loadChartSettings=0&trades=0&tabs=0&info=0&chartLeftToolbar=0&chartTheme=dark&theme=dark&chartStyle=1&chartType=usd&interval=15`;
  el.hidden = false;
  el.innerHTML = `<div class="dx-frame"><iframe src="${esc(src)}" title="$GHOST chart on DEX Screener" loading="lazy" referrerpolicy="no-referrer" allow="clipboard-write"></iframe></div>
    <p class="hint dx-note">Chart by DEX Screener. Until $GHOST graduates, most trading happens on the Pons bonding curve, which this chart may not include. The live curve price is on <a class="link" href="${esc(ponsUrl)}" target="_blank" rel="noopener">Pons</a>. · <a class="link" href="https://dexscreener.com/robinhood/${esc(t)}" target="_blank" rel="noopener">Open on DEX Screener</a></p>`;
}
