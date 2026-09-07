# SULFUR Build Calculator — Spec Plan

## Purpose
A theorycrafting tool for **SULFUR** (Perfect Random, a Steam roguelite extraction
shooter). It lets a player plan and simulate a build **before committing to it in a
run** — assemble a weapon with its Oils/Scrolls, evaluate the resulting damage against
a specific enemy, and (over time) plan a full character loadout and look up the best
use of any pickup. Because SULFUR is an extraction shooter, a bad in-run commitment is
expensive; this tool moves that decision out of the run.

The full vision is three tools in one:
1. **Weapon builder / damage simulator** — weapon + Oils/Scrolls → effective damage vs a target.
2. **Full character loadout calculator** — player base + items + mutations → all EntityAttributes.
3. **Pickup / loot advisor appendix** — searchable index of every item with a KEEP/EAT/COOK/SELL
   verdict and best-combo recommendations.

P0 ships #1 as the runnable core; #2 and #3 are the P1/P2 backlog.

## Data model
Source of truth = the `_sulfur_extract` datamine (verified decompile + tabulated CSVs).
The build pipeline emits these entities to `window.SULFUR_DATA`:

- **Weapon** (`weapons.csv`, `WeaponSO : ItemDefinition`) — `key` (raw asset name), `name`,
  `icon`, `weaponType` (Shotgun/Rifle/…), `damageType` (Fire/Normal/…), `caliber`,
  `baseDamage` (`computed_base_damage`, already includes caliber × damageMultiplier ×
  weaponType-mult), `pellets`, `rpm`, `shotInterval`, `ammoMax`, `reloadTime`, `quality`.
- **Enchantment** (`enchantments.csv`) — Oils/Scrolls/upgrades. `id`, `name`, `category`,
  `group` (e.g. `DamageFlat`, `CritChance`, `Reload`), `isElemental`, `costsDurability`,
  and `mods: [{attr, value, type}]` where `type ∈ {Flat, PercentAdd, PercentMult}`.
- **Enemy** (`enemies.csv`) — `id`, `name`, `faction`, `hp` (`base_MaxHealth`),
  `resist: {Fire, Frost, Electric, Poison, Explosive, Holy, Shadow, Earth, Punish,
  Bleed, Petrified, Charm}` (0–100 %; 100 = immune).
- **Player base** (`player_base_stats.csv`, `source=Player`) — baseline attributes (100 HP, etc.).
- Later (P1/P2): **Item** (`items.csv`, `modifiersOnEquip`/`baseAttributes`), **Mutation**
  (`mutations.csv`), **Pickup guide** (`pickup_guide.csv`), **Cooking** (`recipes.csv` …).

### The engine (VERIFIED — `_sulfur_extract/code/PROCEDURAL_MAP.md`)
- **§1 Stat engine** — for one attribute: `Flat` summed into base → `PercentAdd` pooled
  then applied once as `× clamp(1 + ΣPercentAdd, 0.01, 10)` → each `PercentMult` as `×(1+v)`.
- **§3 Outgoing damage** — weapon `Damage` stat, then `×(1 + Stat_GlobalDamageMultiplier)`.
  (Player class/element `ExtraDamage_*` bonuses = `base × clamp(attr−1, 0, 10)` — P1.)
- **§4 Incoming pipeline** — crit is a **flat ×2** rolled at `critChance`; resistance
  mitigation `× ((100 − resist) / 100)`. (Headshots, player type-mitigation, Oily+Fire ×2 — P1.)
- **§9 Endless scaling** — enemy HP `×5^loop`, damage `×1.5^loop` (P1 toggle).

## Architecture
- Stack: vanilla HTML/CSS/JS; data compiled to `window.SULFUR_DATA` (see `WIKI_CONTEXT.md`).
- Data flow: `references/data/*.csv` → `build-data.mjs` (+ hygiene guardrails) → `data.js` → `app.js`.
- Persistence: `localStorage` under `sulfurbc.*` (P0 uses `sulfurbc.build`).
- Palette: brimstone (ash-black / sulfur-amber / rust) in CSS `:root` variables.
- Mobile-first: single-column base, grid at ≥760px / ≥1100px.

## Feature plan (prioritized)
### P0 — baseline (this session; runnable + testable)
- [x] Weapon selector (74 weapons, icons, search).
- [x] Apply Oils/Scrolls (314 enchantments, group filter + search, stackable chips).
- [x] Target enemy selector (117 enemies with resistances).
- [x] Live totals: effective dmg/pellet, per shot, crit ×2, expected, DPS, resistance-adjusted
      DPS, shots-to-kill, time-to-kill — via the verified §1/§3/§4 engine.
- [x] Modifier ledger (every attribute the applied enchants touch — transparency).
- [x] localStorage build persistence; scroll-preserving re-renders.
- [x] `build-data.mjs` hygiene guardrails (icon 404s, dup keys, modifier-grammar, dangling refs).

### P1 — core value (next sessions)
- [ ] Full character loadout: items (`modifiersOnEquip`/`baseAttributes`) + mutations +
      player base → compute ALL EntityAttributes (HP, move speed, resistances, luck…).
- [ ] Fold player class/element `ExtraDamage_*`, headshot multiplier, and crit-damage
      attributes into the damage headline (currently ledger-only).
- [ ] Endless-loop scaling toggle (HP ×5^loop, dmg ×1.5^loop).
- [ ] Status/DoT synergies (Oily+Fire ×2, Wet+Electric…) and DoT tick modelling (§8).
- [ ] Sustained DPS (reload + magazine): `ammoMax`, `reloadTime`, `RPM`/`ReloadSpeed` mods.
- [ ] Save / load / share builds (`sulfurbc.builds`, schema-versioned, URL share).

### P2 — nice-to-have
- [ ] **Pickup / loot advisor appendix** — searchable index of all 1034 items with the
      KEEP/EAT/COOK/SELL verdict (`pickup_guide.csv`) + best-combo & best-dish recommendations.
- [ ] Loot-table drop-rate browser (`loot_tables.csv`).
- [ ] Cooking optimizer (`recipes.csv`, `food_effects.csv`, `ingredient_value.csv`).
- [ ] Collection / ownership tracking; per-item detail pages; damage-type coverage view.

## Open questions
- GlobalDamageMultiplier: exact base/scaling of the attribute (treated as pooled fractional
  bonus around 0 in P0) — confirm against `Weapon.GetDamage` if any enchant grants it.
- Data-vs-runtime overrides: some weapons are overridden at runtime (e.g. Augusta forced to
  3 pellets — data shows 1). Decide whether to patch a curated overrides layer or annotate.
- Which enchantments are actually weapon-applicable Oils vs. armor/consumable enchants —
  P0 lists all 314; may want to gate by slot/apply-context in P1.
