// Fetch practice answers from Polymarket's public price history (build-time only,
// never used by the entry itself). For each practice case p00..p05 and each of its
// markets, fetch the 1-minute price history from the checkpoint through checkpoint
// + 240 minutes and rebuild the house's 1-minute grid: the price at minute m is the
// last history point at or before m, carried forward, seeded with the case's price
// at the checkpoint. Output: dev/answers.json  { caseId: { marketId: [240 prices] } }
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const KIT_INPUT = process.argv[2] ?? '/home/hatch/workspace/makefun/kits/polymarket-nvidia-ceo-forecast-01-kit/input';
const OUT = process.argv[3] ?? 'dev/answers.json';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'makefun-practice-fetch/1.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(1000 * (i + 1));
    }
  }
}

const caseFiles = ['p00', 'p01', 'p02', 'p03', 'p04', 'p05'];
const answers = {};
let fetched = 0;
let failed = 0;

for (const cid of caseFiles) {
  const c = JSON.parse(readFileSync(join(KIT_INPUT, `${cid}.in`), 'utf8'));
  const atSec = Math.floor(new Date(c.at).getTime() / 1000);
  const endSec = atSec + 240 * 60;
  answers[cid] = {};
  // modest concurrency: 5 in flight
  const queue = [...c.markets];
  const workers = Array.from({ length: 5 }, async () => {
    while (queue.length) {
      const m = queue.shift();
      const url = `https://clob.polymarket.com/prices-history?market=${m.yes_token}&startTs=${atSec}&endTs=${endSec}&fidelity=1`;
      try {
        const data = await fetchJson(url);
        const pts = (data.history ?? []).slice().sort((a, b) => a.t - b.t);
        const x0 = m.prices[m.prices.length - 1];
        const grid = [];
        let last = x0;
        let pi = 0;
        for (let h = 1; h <= 240; h++) {
          const minute = atSec + h * 60;
          while (pi < pts.length && pts[pi].t <= minute) { last = pts[pi].p; pi++; }
          grid.push(last);
        }
        answers[cid][m.id] = grid;
        fetched++;
      } catch (e) {
        console.error(`FAIL ${cid} ${m.name}: ${e.message}`);
        failed++;
      }
    }
  });
  await Promise.all(workers);
  console.log(`${cid}: ${Object.keys(answers[cid]).length}/${c.markets.length} markets, checkpoint ${c.at}`);
}

mkdirSync('dev', { recursive: true });
writeFileSync(OUT, JSON.stringify(answers));
console.log(`done: fetched=${fetched} failed=${failed} -> ${OUT}`);
