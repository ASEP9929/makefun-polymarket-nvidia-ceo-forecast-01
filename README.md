# Polymarket NVIDIA CEO forecast — make.fun entry

Forecasts the Yes price of every trading market of Polymarket's
"Next CEO of NVIDIA?" event, minute by minute, 4 hours ahead, as five
quantiles (0.05, 0.25, 0.5, 0.75, 0.95). One program, `main.ts`
(Node 22, standard library only, no network), reads a case file and
writes the forecast.

## Method

Polymarket prices are step functions: most minutes nothing moves, then a
tick, now and then a jump. A normal random walk with one sigma spreads the
middle quantiles far too wide on quiet minutes, while a fixed sigma cannot
cover the jumps either. So instead of assuming a shape, the program measures
it from each market's own recent history:

1. Take the last 6 hours (360 minutes) of the market's prices.
2. For each horizon on a log grid (1, 2, 4, …, 240 minutes), collect the
   market's own h-minute moves inside that window and read off their
   5/25/50/75/95% quantiles. That captures the zero-inflation (the 25/75%
   quantiles of a quiet market are exactly 0) and the fat tails (the 5/95%
   quantiles are the jumps the market actually made).
3. Recenter the five quantiles so the median move is 0: the median price
   stays where it was. Recent drift is noise — every drift variant tested
   scored worse than pinning the median.
4. Interpolate each quantile across log(h) for the horizons between grid
   points, so the interval widens smoothly with h.
5. Floor the outer quantiles at the normal 1.644854 × 0.001 × √h away from
   the price, so a market that did not move at all in the last 6 hours
   still gets a nonzero tail width.

## Practice results

Scored locally against Polymarket's own price history (all six practice
cases, fetched from the public CLOB price-history endpoint and rebuilt on
the house's 1-minute grid; the local scorer reproduces the house baseline
exactly: loss 0.363589, median error 0.767503, coverage 0.949642):

| case | loss | median error | 90% coverage |
|------|------|--------------|--------------|
| p00 | 0.466549 | 1.4179 | 0.9333 |
| p01 | 0.328243 | 0.7764 | 0.9572 |
| p02 | 0.382912 | 0.9932 | 0.8993 |
| p03 | 0.332887 | 0.7176 | 0.9058 |
| p04 | 0.203494 | 0.6000 | 0.9802 |
| p05 | 0.122967 | 0.2822 | 0.9842 |
| **mean** | **0.295843** | **0.7675** | **0.9452** |

House baseline: **0.363589**. This entry: **0.295843** (−18.6%).

Variants tried and discarded: per-market normal sigma from winsorized
variance (0.45 — jumps inflate the variance and the middle quantiles end
up far too wide); fatter normal tails (worse); empirical quantiles without
median recentering (0.37–0.39 — the drifting median hurts); smoothing the
quantiles to a √h curve (0.34 — it erases the zero-inflation); tail
inflation factors 1.15–1.6 (worse — the empirical tails are already
calibrated); longer windows 720–4320 min (worse — the regime moves fast);
an inner-quantile floor (worse). The 6-hour window with the 0.001 tail
floor sits in the middle of a flat optimum (300–420 min and floors
0.001–0.0012 all score within 0.002 of each other), so it is not a
knife-edge fit to the practice.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Reads every `<id>.in` in the input directory and writes `<id>.out`.
Deterministic (two runs are byte-identical); about 0.05 s per case, far
under the 8 s cap.

## Files

- `main.ts` — the entry (the only file the grader runs).
- `dev/` — build tooling, not run by the grader: `fetch-answers.mjs`
  (fetches practice answers from Polymarket), `score.mjs` (local pinball
  scorer), `variant.mjs` (the variant tester used to pick the method),
  `explore.mjs` (history statistics).
- `LICENSE` — MIT.
