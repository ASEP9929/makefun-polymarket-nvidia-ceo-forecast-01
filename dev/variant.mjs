// Variant tester: parameterized forecaster + practice scorer in one script.
// Usage: node dev/variant.mjs [variantName ...]   (no args = run all)
// Each variant forecasts all 6 practice cases from the kit inputs and scores
// them against dev/answers.json. No files written except nothing (in-memory).
import { readFileSync } from 'node:fs';

const KIT = '/home/hatch/workspace/makefun/kits/polymarket-nvidia-ceo-forecast-01-kit/input';
const TAU = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z = [-1.644854, -0.67449, 0, 0.67449, 1.644854];
const answers = JSON.parse(readFileSync('dev/answers.json', 'utf8'));
const cases = {};
for (const cid of Object.keys(answers).sort()) cases[cid] = JSON.parse(readFileSync(`${KIT}/${cid}.in`, 'utf8'));

const price6 = (x) => Math.round(Math.min(1, Math.max(0, x)) * 1e6) / 1e6 + 0;
function quantile(sorted, q) {
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
// Winsorized per-minute sd over the last `win` minutes (caps single jumps).
function robustSigma(prices, win, cap = 0.05) {
  const n = prices.length;
  const start = Math.max(1, n - win);
  let s = 0, cnt = 0;
  for (let i = start; i < n; i++) {
    const d = prices[i] - prices[i - 1];
    const w = Math.max(-cap, Math.min(cap, d));
    s += w * w; cnt++;
  }
  return cnt ? Math.sqrt(s / cnt) : 0.0025;
}

// --- forecasters: each takes (prices, horizon) and returns 240 x 5 rows ---
const forecasters = {
  // V1: per-market robust sigma, normal quantiles, no drift.
  v1_normal_robust: (p, H, o) => {
    const x = p[p.length - 1];
    const s = o.sigma ?? Math.min(0.01, Math.max(0.0004, robustSigma(p, o.win)));
    const rows = [];
    for (let h = 1; h <= H; h++) rows.push(Z.map((z) => price6(x + z * s * Math.sqrt(h))));
    return rows;
  },
  // V2: V1 with fatter outer z (heavier tails).
  v2_fat_tails: (p, H, o) => {
    const x = p[p.length - 1];
    const s = Math.min(0.01, Math.max(0.0004, robustSigma(p, o.win)));
    const z = [-o.zOut, -0.67449, 0, 0.67449, o.zOut];
    const rows = [];
    for (let h = 1; h <= H; h++) rows.push(z.map((zz) => price6(x + zz * s * Math.sqrt(h))));
    return rows;
  },
  // V3: empirical h-step quantiles from the recent window, log-h interpolation.
  v3_empirical: (p, H, o) => {
    const x = p[p.length - 1];
    const n = p.length;
    const win = Math.min(o.win, n);
    const base = n - win; // window start index in prices
    const gridH = [1, 2, 4, 8, 16, 32, 64, 128, 240];
    // quantiles[gi][j] for each grid horizon
    const table = gridH.map((h) => {
      const moves = [];
      for (let t = base; t + h < n; t++) {
        const mv = p[t + h] - p[t];
        moves.push(o.cap ? Math.max(-o.cap, Math.min(o.cap, mv)) : mv);
      }
      moves.sort((a, b) => a - b);
      if (!moves.length) return [0, 0, 0, 0, 0];
      return TAU.map((tau) => quantile(moves, tau));
    });
    const rows = [];
    for (let h = 1; h <= H; h++) {
      // find bracketing grid horizons, interpolate in log h
      let gi = 0;
      while (gi < gridH.length - 1 && gridH[gi + 1] <= h) gi++;
      let q;
      if (h <= gridH[0]) q = table[0];
      else if (h >= gridH[gridH.length - 1]) q = table[gridH.length - 1];
      else {
        const h0 = gridH[gi], h1 = gridH[gi + 1];
        const w = (Math.log(h) - Math.log(h0)) / (Math.log(h1) - Math.log(h0));
        q = TAU.map((_, j) => table[gi][j] * (1 - w) + table[gi + 1][j] * w);
      }
      // drift shrink: pull the median move toward 0
      const med = q[2] * o.driftShrink;
      const row = q.map((v, j) => price6(x + (j === 2 ? med : v)));
      // enforce non-decreasing
      for (let j = 1; j < 5; j++) if (row[j] < row[j - 1]) row[j] = row[j - 1];
      rows.push(row);
    }
    return rows;
  },
  // V7: median-recentered empirical h-step quantiles, smoothed by fitting
  // q_tau(h) = a_tau * sqrt(h) (least squares over the log-h grid), with
  // h-step moves winsorized to +/-o.cap before taking quantiles.
  v7_smooth_empirical: (p, H, o) => {
    const x = p[p.length - 1];
    const n = p.length;
    const win = Math.min(o.win, n);
    const base = n - win;
    const gridH = [1, 2, 4, 8, 16, 32, 64, 128, 240];
    const cap = o.cap;
    // empirical quantiles per grid horizon, median-recentered
    const table = gridH.map((h) => {
      const moves = [];
      for (let t = base; t + h < n; t++) {
        const mv = p[t + h] - p[t];
        moves.push(Math.max(-cap, Math.min(cap, mv)));
      }
      moves.sort((a, b) => a - b);
      if (!moves.length) return [0, 0, 0, 0, 0];
      const qs = TAU.map((tau) => quantile(moves, tau));
      const med = qs[2];
      return qs.map((q) => q - med);
    });
    // fit a_tau: q = a * sqrt(h), least squares with weights = grid interval width
    const a = TAU.map((_, j) => {
      let num = 0, den = 0;
      for (let gi = 0; gi < gridH.length; gi++) {
        const h = gridH[gi];
        const w = gi + 1 < gridH.length ? gridH[gi + 1] - h : 240 - h + 1;
        const s = Math.sqrt(h);
        num += w * table[gi][j] * s;
        den += w * h;
      }
      return den ? num / den : 0;
    });
    const rows = [];
    for (let h = 1; h <= H; h++) {
      const s = Math.sqrt(h);
      const row = a.map((av) => price6(x + av * s));
      for (let j = 1; j < 5; j++) if (row[j] < row[j - 1]) row[j] = row[j - 1];
      rows.push(row);
    }
    return rows;
  },
  // V8: v5 but with median recentering (fix the monotonicity/median bug).
  v8_recentered: (p, H, o) => {
    const x = p[p.length - 1];
    const n = p.length;
    const win = Math.min(o.win, n);
    const base = n - win;
    const gridH = [1, 2, 4, 8, 16, 32, 64, 128, 240];
    const table = gridH.map((h) => {
      const moves = [];
      for (let t = base; t + h < n; t++) {
        const mv = p[t + h] - p[t];
        moves.push(o.cap ? Math.max(-o.cap, Math.min(o.cap, mv)) : mv);
      }
      moves.sort((a, b) => a - b);
      if (!moves.length) return [0, 0, 0, 0, 0];
      const qs = TAU.map((tau) => quantile(moves, tau));
      const med = qs[2];
      return qs.map((q) => q - med);
    });
    const rows = [];
    for (let h = 1; h <= H; h++) {
      let gi = 0;
      while (gi < gridH.length - 1 && gridH[gi + 1] <= h) gi++;
      let q;
      if (h <= gridH[0]) q = table[0];
      else if (h >= gridH[gridH.length - 1]) q = table[gridH.length - 1];
      else {
        const h0 = gridH[gi], h1 = gridH[gi + 1];
        const w = (Math.log(h) - Math.log(h0)) / (Math.log(h1) - Math.log(h0));
        q = TAU.map((_, j) => table[gi][j] * (1 - w) + table[gi + 1][j] * w);
      }
      const row = q.map((v) => price6(x + v));
      for (let j = 1; j < 5; j++) if (row[j] < row[j - 1]) row[j] = row[j - 1];
      rows.push(row);
    }
    return rows;
  },
  // V9: v8 generalized — denser grid option, outer-tail inflation, and a
  // normal floor on the outer quantiles (so a market that never moved in the
  // window still gets a nonzero tail width).
  v9_general: (p, H, o) => {
    const x = p[p.length - 1];
    const n = p.length;
    const win = Math.min(o.win, n);
    const base = n - win;
    const gridH = o.dense ? [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 240] : [1, 2, 4, 8, 16, 32, 64, 128, 240];
    const table = gridH.map((h) => {
      const moves = [];
      for (let t = base; t + h < n; t++) {
        const mv = p[t + h] - p[t];
        moves.push(o.cap ? Math.max(-o.cap, Math.min(o.cap, mv)) : mv);
      }
      moves.sort((a, b) => a - b);
      if (!moves.length) return [0, 0, 0, 0, 0];
      const qs = TAU.map((tau) => quantile(moves, tau));
      const med = qs[2];
      return qs.map((q) => q - med);
    });
    const rows = [];
    for (let h = 1; h <= H; h++) {
      let gi = 0;
      while (gi < gridH.length - 1 && gridH[gi + 1] <= h) gi++;
      let q;
      if (h <= gridH[0]) q = table[0];
      else if (h >= gridH[gridH.length - 1]) q = table[gridH.length - 1];
      else {
        const h0 = gridH[gi], h1 = gridH[gi + 1];
        const w = (Math.log(h) - Math.log(h0)) / (Math.log(h1) - Math.log(h0));
        q = TAU.map((_, j) => table[gi][j] * (1 - w) + table[gi + 1][j] * w);
      }
      if (o.tail && o.tail !== 1) {
        q = q.map((v, j) => (j === 0 || j === 4) ? v * o.tail : v);
      }
      if (o.floor) {
        const f = 1.644854 * o.floor * Math.sqrt(h);
        if (q[0] > -f) q[0] = -f;
        if (q[4] < f) q[4] = f;
      }
      if (o.floorIn) {
        const fi = 0.67449 * o.floorIn * Math.sqrt(h);
        if (q[1] > -fi) q[1] = -fi;
        if (q[3] < fi) q[3] = fi;
      }
      const row = q.map((v) => price6(x + v));
      for (let j = 1; j < 5; j++) if (row[j] < row[j - 1]) row[j] = row[j - 1];
      rows.push(row);
    }
    return rows;
  },
  // V10: v9 inner quantiles from a short window, outer from a longer one.
  v10_split: (p, H, o) => {
    const inner = forecasters.v9_general(p, H, { win: o.winIn });
    const outer = forecasters.v9_general(p, H, { win: o.winOut });
    const x = p[p.length - 1];
    return inner.map((row, i) => {
      const r = [outer[i][0], row[1], x, row[3], outer[i][4]];
      for (let j = 1; j < 5; j++) if (r[j] < r[j - 1]) r[j] = r[j - 1];
      return r;
    });
  },
  // V5: empirical quantiles, median pinned at x, outer quantiles inflated by o.tail.
  v5_empirical_tail: (p, H, o) => {
    const rows = forecasters.v3_empirical(p, H, { win: o.win, driftShrink: 0 });
    const x = p[p.length - 1];
    return rows.map((row) => {
      const r = row.slice();
      r[2] = x; // median = persistence
      r[0] = price6(x + (row[0] - x) * o.tail);
      r[4] = price6(x + (row[4] - x) * o.tail);
      for (let j = 1; j < 5; j++) if (r[j] < r[j - 1]) r[j] = r[j - 1];
      return r;
    });
  },
  // V6: split windows — inner quantiles from a short window, outer from a long one.
  v6_split: (p, H, o) => {
    const inner = forecasters.v3_empirical(p, H, { win: o.winIn, driftShrink: 0 });
    const outer = forecasters.v3_empirical(p, H, { win: o.winOut, driftShrink: 0 });
    const x = p[p.length - 1];
    return inner.map((row, i) => {
      const r = [outer[i][0], row[1], x, row[3], outer[i][4]];
      for (let j = 1; j < 5; j++) if (r[j] < r[j - 1]) r[j] = r[j - 1];
      return r;
    });
  },
  // V4: empirical quantiles blended with the normal core (weight wEmp on empirical).
  v4_blend: (p, H, o) => {
    const emp = forecasters.v3_empirical(p, H, o);
    const x = p[p.length - 1];
    const s = Math.min(0.01, Math.max(0.0004, robustSigma(p, o.win)));
    const rows = [];
    for (let h = 1; h <= H; h++) {
      const row = emp[h - 1].map((v, j) => {
        const norm = price6(x + Z[j] * s * Math.sqrt(h));
        return price6(v * o.wEmp + norm * (1 - o.wEmp));
      });
      for (let j = 1; j < 5; j++) if (row[j] < row[j - 1]) row[j] = row[j - 1];
      rows.push(row);
    }
    return rows;
  },
};

const variants = [
  { name: 'baseline-0.0025', fn: 'v1_normal_robust', o: { sigma: 0.0025 } },
  { name: 'v1_win1440', fn: 'v1_normal_robust', o: { win: 1440 } },
  { name: 'v1_win720', fn: 'v1_normal_robust', o: { win: 720 } },
  { name: 'v1_win4320', fn: 'v1_normal_robust', o: { win: 4320 } },
  { name: 'v2_z2.0_win1440', fn: 'v2_fat_tails', o: { win: 1440, zOut: 2.0 } },
  { name: 'v2_z2.5_win1440', fn: 'v2_fat_tails', o: { win: 1440, zOut: 2.5 } },
  { name: 'v3_emp_w1440_d1.0', fn: 'v3_empirical', o: { win: 1440, driftShrink: 1.0 } },
  { name: 'v3_emp_w1440_d0.5', fn: 'v3_empirical', o: { win: 1440, driftShrink: 0.5 } },
  { name: 'v3_emp_w720_d0.5', fn: 'v3_empirical', o: { win: 720, driftShrink: 0.5 } },
  { name: 'v3_emp_w4320_d0.5', fn: 'v3_empirical', o: { win: 4320, driftShrink: 0.5 } },
  { name: 'v4_blend0.7_w1440', fn: 'v4_blend', o: { win: 1440, driftShrink: 0.5, wEmp: 0.7 } },
  { name: 'v4_blend0.5_w1440', fn: 'v4_blend', o: { win: 1440, driftShrink: 0.5, wEmp: 0.5 } },
  { name: 'v5a_emp_w1440_d0', fn: 'v5_empirical_tail', o: { win: 1440, tail: 1.0 } },
  { name: 'v5b_emp_w1440_t1.3', fn: 'v5_empirical_tail', o: { win: 1440, tail: 1.3 } },
  { name: 'v5c_emp_w1440_t1.6', fn: 'v5_empirical_tail', o: { win: 1440, tail: 1.6 } },
  { name: 'v5d_emp_w720_t1.3', fn: 'v5_empirical_tail', o: { win: 720, tail: 1.3 } },
  { name: 'v5e_emp_w2880_t1.3', fn: 'v5_empirical_tail', o: { win: 2880, tail: 1.3 } },
  { name: 'v6_split_720_2880', fn: 'v6_split', o: { winIn: 720, winOut: 2880 } },
  { name: 'v6_split_1440_4320', fn: 'v6_split', o: { winIn: 1440, winOut: 4320 } },
  { name: 'v8_rec_w1440', fn: 'v8_recentered', o: { win: 1440 } },
  { name: 'v8_rec_w720', fn: 'v8_recentered', o: { win: 720 } },
  { name: 'v7_smooth_w1440_c25', fn: 'v7_smooth_empirical', o: { win: 1440, cap: 0.25 } },
  { name: 'v7_smooth_w2880_c25', fn: 'v7_smooth_empirical', o: { win: 2880, cap: 0.25 } },
  { name: 'v7_smooth_w1440_c15', fn: 'v7_smooth_empirical', o: { win: 1440, cap: 0.15 } },
  { name: 'v7_smooth_w4320_c25', fn: 'v7_smooth_empirical', o: { win: 4320, cap: 0.25 } },
  { name: 'v9_w360', fn: 'v9_general', o: { win: 360 } },
  { name: 'v9_w480', fn: 'v9_general', o: { win: 480 } },
  { name: 'v9_w720', fn: 'v9_general', o: { win: 720 } },
  { name: 'v9_w960', fn: 'v9_general', o: { win: 960 } },
  { name: 'v9_w720_dense', fn: 'v9_general', o: { win: 720, dense: true } },
  { name: 'v9_w720_t1.15', fn: 'v9_general', o: { win: 720, tail: 1.15 } },
  { name: 'v9_w720_t1.3', fn: 'v9_general', o: { win: 720, tail: 1.3 } },
  { name: 'v9_w720_f0.0005', fn: 'v9_general', o: { win: 720, floor: 0.0005 } },
  { name: 'v9_w720_f0.001', fn: 'v9_general', o: { win: 720, floor: 0.001 } },
  { name: 'v10_split_720_2880', fn: 'v10_split', o: { winIn: 720, winOut: 2880 } },
  { name: 'v10_split_720_1440', fn: 'v10_split', o: { winIn: 720, winOut: 1440 } },
  { name: 'v9_w360_f0.0005', fn: 'v9_general', o: { win: 360, floor: 0.0005 } },
  { name: 'v9_w360_f0.001', fn: 'v9_general', o: { win: 360, floor: 0.001 } },
  { name: 'v9_w360_f0.0015', fn: 'v9_general', o: { win: 360, floor: 0.0015 } },
  { name: 'v9_w360_f0.002', fn: 'v9_general', o: { win: 360, floor: 0.002 } },
  { name: 'v9_w240_f0.001', fn: 'v9_general', o: { win: 240, floor: 0.001 } },
  { name: 'v9_w480_f0.001', fn: 'v9_general', o: { win: 480, floor: 0.001 } },
  { name: 'v9_w480_f0.0015', fn: 'v9_general', o: { win: 480, floor: 0.0015 } },
  { name: 'v9_w360_dense_f0.001', fn: 'v9_general', o: { win: 360, dense: true, floor: 0.001 } },
  { name: 'v9_w720_f0.0015', fn: 'v9_general', o: { win: 720, floor: 0.0015 } },
  { name: 'v9_w300_f0.001', fn: 'v9_general', o: { win: 300, floor: 0.001 } },
  { name: 'v9_w420_f0.001', fn: 'v9_general', o: { win: 420, floor: 0.001 } },
  { name: 'v9_w360_f0.001_fi0.0005', fn: 'v9_general', o: { win: 360, floor: 0.001, floorIn: 0.0005 } },
  { name: 'v9_w360_f0.001_fi0.001', fn: 'v9_general', o: { win: 360, floor: 0.001, floorIn: 0.001 } },
  { name: 'v9_w360_f0.0012', fn: 'v9_general', o: { win: 360, floor: 0.0012 } },
  { name: 'v11_w360_f0.001_cap0.25', fn: 'v9_general', o: { win: 360, floor: 0.001, cap: 0.25 } },
  { name: 'v11_w360_f0.001_cap0.15', fn: 'v9_general', o: { win: 360, floor: 0.001, cap: 0.15 } },
  { name: 'v11_w480_f0.001_cap0.25', fn: 'v9_general', o: { win: 480, floor: 0.001, cap: 0.25 } },
];

function scoreVariant(v) {
  let loss = 0, items = 0, medErr = 0, mins = 0, cov = 0;
  const perCase = {};
  for (const cid of Object.keys(cases)) {
    const c = cases[cid];
    let cl = 0, ci = 0, cm = 0, cn = 0, cc = 0;
    for (const m of c.markets) {
      const rows = forecasters[v.fn](m.prices, 240, v.o);
      const ys = answers[cid][m.id];
      for (let h = 0; h < 240; h++) {
        const y = ys[h], row = rows[h];
        for (let j = 0; j < 5; j++) {
          const d = y - row[j];
          cl += 100 * Math.max(TAU[j] * d, (TAU[j] - 1) * d);
          ci++;
        }
        cm += 100 * Math.abs(y - row[2]); cn++;
        if (row[0] <= y && y <= row[4]) cc++;
      }
    }
    perCase[cid] = cl / ci;
    loss += cl; items += ci; medErr += cm; mins += cn; cov += cc;
  }
  return { loss: loss / items, medErr: medErr / mins, cov: cov / mins, perCase };
}

const only = process.argv.slice(2);
for (const v of variants) {
  if (only.length && !only.includes(v.name)) continue;
  const t0 = Date.now();
  const r = scoreVariant(v);
  const ms = Date.now() - t0;
  const pc = Object.entries(r.perCase).map(([k, x]) => `${k}:${x.toFixed(3)}`).join(' ');
  console.log(`${v.name.padEnd(22)} loss ${r.loss.toFixed(6)} medErr ${r.medErr.toFixed(4)} cov90 ${r.cov.toFixed(4)} ${ms}ms  [${pc}]`);
}
