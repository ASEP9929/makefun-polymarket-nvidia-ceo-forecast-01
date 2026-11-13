// Local practice scorer: scores forecast .out files in <outdir> against
// dev/answers.json exactly like the RULES: pinball loss in percentage points,
// 100 * max(tau*(y-q), (tau-1)*(y-q)), averaged over every (case, market,
// minute, tau); plus median error (mean 100*|y - q50|) and 90% coverage
// (share of market-minutes with q05 <= y <= q95). Usage:
//   node dev/score.mjs <outdir> [label]
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const TAU = [0.05, 0.25, 0.5, 0.75, 0.95];
const outDir = process.argv[2];
const label = process.argv[3] ?? outDir;
const answers = JSON.parse(readFileSync('dev/answers.json', 'utf8'));

let totalLoss = 0, totalItems = 0, totalMedErr = 0, totalMin = 0, totalCov = 0;
const perCase = [];

for (const cid of Object.keys(answers).sort()) {
  const fc = JSON.parse(readFileSync(join(outDir, `${cid}.out`), 'utf8'));
  const byId = new Map(fc.forecasts.map((f) => [f.id, f.q]));
  let loss = 0, items = 0, medErr = 0, mins = 0, cov = 0;
  for (const [mid, ys] of Object.entries(answers[cid])) {
    const q = byId.get(mid);
    if (!q || q.length !== 240) throw new Error(`${cid} ${mid}: forecast missing or wrong length`);
    for (let h = 0; h < 240; h++) {
      const y = ys[h];
      const row = q[h];
      for (let j = 0; j < 5; j++) {
        const d = y - row[j];
        loss += 100 * Math.max(TAU[j] * d, (TAU[j] - 1) * d);
        items++;
      }
      medErr += 100 * Math.abs(y - row[2]);
      mins++;
      if (row[0] <= y && y <= row[4]) cov++;
    }
  }
  perCase.push({ cid, loss: loss / items, medErr: medErr / mins, cov: cov / mins });
  totalLoss += loss; totalItems += items; totalMedErr += medErr; totalMin += mins; totalCov += cov;
}

console.log(`== ${label} ==`);
for (const c of perCase) console.log(`  ${c.cid}: loss ${c.loss.toFixed(6)}  medErr ${c.medErr.toFixed(4)}  cov90 ${c.cov.toFixed(4)}`);
console.log(`  MEAN: loss ${(totalLoss / totalItems).toFixed(6)}  medErr ${(totalMedErr / totalMin).toFixed(4)}  cov90 ${(totalCov / totalMin).toFixed(4)}`);
