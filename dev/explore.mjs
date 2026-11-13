// Explore practice history: per-market volatility stats to design the forecaster.
// Prints, per case/market: n, last price, median|d| and sd of 1-min diffs over
// the full history and the last 6h, jump rates, and the realized h-step move
// quantiles (h=60, 240) for a sense of tail width.
import { readFileSync } from 'node:fs';

function quantile(sorted, q) {
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

for (const cid of ['p00', 'p02', 'p05']) {
  const c = JSON.parse(readFileSync(`/home/hatch/workspace/makefun/kits/polymarket-nvidia-ceo-forecast-01-kit/input/${cid}.in`, 'utf8'));
  console.log(`== ${cid} at ${c.at} ==`);
  for (const m of c.markets) {
    const p = m.prices;
    const d = [];
    for (let i = 1; i < p.length; i++) d.push(p[i] - p[i - 1]);
    const abs = d.map(Math.abs).sort((a, b) => a - b);
    const d6 = d.slice(-360);
    const abs6 = d6.map(Math.abs).sort((a, b) => a - b);
    const mean = d.reduce((a, b) => a + b, 0) / d.length;
    const sd = Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / d.length);
    const jumps = d.filter((x) => Math.abs(x) > 0.02).length / d.length;
    const med = quantile(abs, 0.5);
    const med6 = quantile(abs6, 0.5);
    // h-step move quantiles over full history
    const mv60 = [], mv240 = [];
    for (let i = 0; i + 240 < p.length; i++) {
      mv60.push(p[i + 60] - p[i]);
      mv240.push(p[i + 240] - p[i]);
    }
    mv60.sort((a, b) => a - b); mv240.sort((a, b) => a - b);
    const q60 = [0.05, 0.95].map((q) => quantile(mv60, q));
    const q240 = [0.05, 0.95].map((q) => quantile(mv240, q));
    console.log(`${m.name.padEnd(22)} n=${String(p.length).padStart(4)} x=${p[p.length - 1].toFixed(3)} med|d|=${med.toFixed(4)} med6=${med6.toFixed(4)} sd=${sd.toFixed(4)} jump>0.02=${(jumps * 100).toFixed(1)}% q60=[${q60[0].toFixed(3)},${q60[1].toFixed(3)}] q240=[${q240[0].toFixed(3)},${q240[1].toFixed(3)}]`);
  }
}
