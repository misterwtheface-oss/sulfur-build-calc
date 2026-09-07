# SULFUR Build Calculator

A single-page build calculator & damage simulator for **SULFUR** (Perfect Random),
hosted on GitHub Pages. Vanilla HTML/CSS/JS — no framework, no build server. Game
data is authored as CSV (curated from the `_sulfur_extract` datamine), compiled to
`data.js` (a `window.SULFUR_DATA` global) by `build-data.mjs`.

Pick a weapon → apply Oils/Scrolls → pick a target enemy → see effective damage,
DPS, crit, resistance-adjusted damage, and time-to-kill. The math is the **verified**
stat engine and damage pipeline decompiled from the game (see `WIKI_CONTEXT.md`).

## Develop
```bash
node build-data.mjs          # compile references/data/*.csv -> data.js (runs hygiene guardrails)
node build-data.mjs --strict # promote warnings to errors (pre-release pass)
node tools/serve.mjs         # preview at http://localhost:8080 (+ LAN URL for phone testing)
```
Stop the preview server (Ctrl+C) when you're done.

## Data pipeline
- Source data lives in `references/data/*.csv` — copies of the `_sulfur_extract`
  tables. **Never hand-edit them**: regenerate from the datamine (see `WIKI_CONTEXT.md`).
- Icons are in `assets/{weapons,oils,scrolls,consumables}/`, mapped by `assets/icon_manifest.csv`.
- `build-data.mjs` resolves every weapon icon and cross-reference, prints a hygiene
  report, and **refuses to write `data.js` if anything is broken**.

## Deploy (GitHub Pages)
1. `git push` to your repo.
2. Enable Pages on the branch, `/root`. No build action needed — it's all static.
3. (At public release only) add the Cloudflare Web Analytics beacon.

## Project docs
- `SPEC_PLAN.md` — architecture and the phased (P0/P1/P2) feature plan.
- `WIKI_CONTEXT.md` — game context + how to (re)generate data from the datamine.
- `Progress.md` — **read this first when resuming**: current state + backlog.
