# SULFUR — Wiki / Context Tree

An LLM-oriented context tree so a future session can understand the game and the data
pipeline without re-datamining. The authoritative datamine hub is
`../_sulfur_extract/CONTEXT_MAP.md` — start there for anything not covered here.

## Game basics
**SULFUR** (dev: Perfect Random) is a Steam roguelite **extraction shooter** with immersive-sim
and looter mechanics — grimy dark-fantasy tone. Core loop: enter a run, loot/fight, and
**extract** with your gear; commitments made in-run (which Oils to burn on a gun, what to
keep vs sell) are costly to undo. Engine: **Unity, Mono** (clean decompile). Content ships as
Addressables/AssetBundles (no cleartext JSON) — data lives in ScriptableObjects, logic in
`PerfectRandom.Sulfur.{Core,Gameplay,LevelGeneration}.dll`.

## Key mechanics (for the calculator)
Capture the non-obvious rules — the ones that will cause bugs if forgotten:

- **Stat modifier engine (§1).** Every stat = `BaseValue` + ordered modifiers. Order:
  `Flat` (summed) → `PercentAdd` (**pooled**, applied once as `× clamp(1 + Σ, 0.01, 10)`) →
  `PercentMult` (each its own `×(1+v)`, uncapped). The `[0.01, 10]` clamp on the pooled
  PercentAdd is a Sulfur-specific customization. Modifier grammar in CSV: `Attr=Val(ModType)`,
  `;`-separated.
- **Weapon damage (§3).** `computed_base_damage` in `weapons.csv` **already includes**
  caliber base × `damageMultiplier` × weaponType-mult (AR 1.2 / Revolver 1.6 / Rifle&Sniper 2.0…).
  Do **not** re-apply those. `pellets > 1` means per-shot damage = per-pellet × pellets
  (shotguns). Crit is **NOT** applied here — it is rolled on receipt.
- **Incoming damage (§4).** Crit = flat **×2** at `critChance`. Resistance mitigation =
  `× ((100 − resist) / 100)`; resist is 0–100 (100 = immune, negative = vulnerable). Player-only
  type mitigation (Explosive ×0.2, most ×0.5, Punish ×1) and headshot mult are **not** in P0.
- **Oily + Fire ⇒ ×2** damage (status synergy, §4/§8) — a headline synergy to model in P1.
- **Endless loop scaling (§9).** In endless mode, enemy HP `×5^loop`, damage `×1.5^loop`
  (applied as `PercentMult` of `5^loop − 1`). P1 toggle.
- **Data ≠ runtime in a few cases.** Some values are overridden in code at runtime — e.g.
  **Augusta** is forced to 3 pellets but `weapons.csv` shows 1 (PROCEDURAL_MAP §6). Treat the
  CSV as the datamined default; a curated overrides layer may be needed later.
- **Nothing is pure trash** in the pickup economy — the decision is SELL vs KEEP/COOK/EAT
  (`pickup_guide.csv`), which is why the P2 advisor gives a *verdict*, not a keep/drop flag.

## Data sources & datamine access
- **Datamine workspace:** `../_sulfur_extract/` — **NOT shipped**, lives as a sibling.
  Hub: `../_sulfur_extract/CONTEXT_MAP.md` (navigation index + context chain).
  Formulas: `../_sulfur_extract/code/PROCEDURAL_MAP.md` (§1–§9, anchored to `file:line`).
  Regen guide + guardrails: `../_sulfur_extract/TOOLS.md`.
- **How to (re)generate data** (never hand-edit CSVs — edit the builder and rerun):
  - `cd ../_sulfur_extract/data && python build_tables.py`  → `weapons.csv`, `items.csv`,
    `enchantments.csv`, `loot_tables.csv`, `cards.csv`.
  - `python build_units.py`   → `enemies.csv`, `player_base_stats.csv`, `mutations.csv`.
  - `python build_cooking.py` → `recipes.csv`, `food_effects.csv`, `ingredient_usage.csv`,
    `ingredient_value.csv`; then `python pickup_guide.py` → `pickup_guide.csv`.
  - Icons: `python ../_sulfur_extract/tools/extract_icons.py` → repopulates
    `assets/{weapons,oils,scrolls,consumables}/` + `assets/icon_manifest.csv`.
  - After a game patch: re-export (AssetRipper) + re-`ilspycmd`, then rerun the builders + icons,
    then copy the CSVs into `references/data/` and re-run `node build-data.mjs`.
- **Which extract files feed the SPA:** `references/data/` holds copies of the extract CSVs;
  `build-data.mjs` currently consumes `weapons.csv`, `enchantments.csv`, `enemies.csv`,
  `player_base_stats.csv` (P1/P2 will add `items.csv`, `mutations.csv`, `pickup_guide.csv`,
  cooking tables). Icons resolved via `assets/icon_manifest.csv`.

### What's shipped vs. gitignored
- **SHIPPED (committed):** `index.html`, `styles.css`, `app.js`, `build-data.mjs`, `data.js`
  (generated), `tools/serve.mjs`, `references/data/*.csv` (the curated subset), and the item
  icons under `assets/**` that the SPA actually uses.
- **GITIGNORED / never committed:** the entire `../_sulfur_extract` workspace — raw ScriptableObject
  dumps, decompiled C#, the ~1.7 GB AssetRipper Unity export, and any intermediate not read by
  the SPA. Rule of thumb: if the SPA doesn't load it at runtime, it does not belong in this repo.
- If the datamine ever needs to be recreated from scratch: use the **game-datamine** skill.

## Data model reference (fields the pipeline expects)
`window.SULFUR_DATA = { meta, engine, resistChannels, weapons[], enchantments[], enemies[], playerBase }`
- `engine`: `{ critMult: 2, clampMin: 0.01, clampMax: 10 }`.
- `weapons[]`: `key, name, icon, weaponType, damageType, caliber, baseDamage, pellets, rpm,
  shotInterval, ammoMax, reloadTime, quality, basePrice`.
- `enchantments[]`: `id, name, category, group, isElemental, costsDurability, mods[{attr,value,type}]`.
- `enemies[]`: `id, name, faction, hp, resist{<12 channels>}`.
- `playerBase`: `{ Stat_MaxHealth: 100, ... }` (Player source only).
See `../_sulfur_extract/data/README.md` for the full CSV column semantics.
