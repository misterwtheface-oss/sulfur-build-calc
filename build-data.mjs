/*
  build-data.mjs — compiles the curated SULFUR extract CSVs into data.js
  as `window.SULFUR_DATA = {...}`, running data-hygiene guardrails first.

  Source data: references/data/*.csv  (copies of the _sulfur_extract datamine tables;
  see WIKI_CONTEXT.md for how they are (re)generated — never hand-edit them).
  Icons:       assets/{weapons,oils,scrolls,consumables}/  mapped by assets/icon_manifest.csv.

  Usage:  node build-data.mjs           (warnings allowed)
          node build-data.mjs --strict  (warnings promoted to errors)

  Guardrail philosophy: resolve every cross-reference and every asset path BEFORE
  writing data.js. A broken reference caught here is a log line; the same reference
  caught in production is a 404 and a lost user. On any error we refuse to write
  data.js, leaving the last good copy intact.
*/
import fs from "node:fs";
import path from "node:path";

// --- config ---
const ACRONYM = "SULFUR";                 // -> window.SULFUR_DATA
const DATA_DIR = "references/data";       // curated extract CSVs (the shipped subset)
const ASSETS_DIR = "assets";
const ICON_MANIFEST = path.join(ASSETS_DIR, "icon_manifest.csv");
const OUT = "data.js";

// Attributes the P0 damage engine actually folds into headline numbers. Anything
// outside this set is still surfaced in the UI ledger, but flag truly unknown-looking
// modifier types as errors.
const MOD_TYPES = new Set(["Flat", "PercentAdd", "PercentMult"]);
// -----------------

const STRICT = process.argv.includes("--strict");
const errors = [];
const warnings = [];

/** CSV parser: quote-aware AND bracket-aware (commas inside "..." or [...] are literal). */
function parseCSV(text, label) {
  const lines = text.replace(/\r\n/g, "\n").split("\n").filter((l) => l.length);
  if (!lines.length) return [];
  const header = splitRow(lines[0]);
  return lines.slice(1).map((line, i) => {
    const cells = splitRow(line);
    if (cells.length !== header.length) {
      // A common cause is a missing trailing newline on the LAST row — check EOF
      // before hunting for bracket/quote bugs.
      warnings.push(`${label} row ${i + 2}: expected ${header.length} fields, got ${cells.length}`);
    }
    const row = {};
    header.forEach((h, j) => (row[h] = cells[j] ?? ""));
    return row;
  });
}

function splitRow(line) {
  const out = [];
  let cur = "", depth = 0, quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { quoted = !quoted; continue; }
    if (quoted) { cur += ch; continue; }
    if (ch === "[") depth++;
    else if (ch === "]") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

/** Parse a modifier list "Attr=Val(ModType);Attr=Val(ModType)" -> [{attr,value,type}]. */
function parseMods(cell, ownerLabel) {
  const out = [];
  if (!cell) return out;
  for (const raw of cell.split(";").map((s) => s.trim()).filter(Boolean)) {
    const m = /^([A-Za-z0-9_]+)=(-?[0-9.]+)\((\w+)\)$/.exec(raw);
    if (!m) { errors.push(`${ownerLabel}: unparseable modifier "${raw}"`); continue; }
    const [, attr, value, type] = m;
    if (!MOD_TYPES.has(type)) errors.push(`${ownerLabel}: unknown modifier type "${type}" in "${raw}"`);
    out.push({ attr, value: Number(value), type });
  }
  return out;
}

const read = (f) => {
  const p = path.join(DATA_DIR, f);
  if (!fs.existsSync(p)) { console.error(`Missing source ${p}. See WIKI_CONTEXT.md.`); process.exit(1); }
  return parseCSV(fs.readFileSync(p, "utf8"), f);
};

// --- icon manifest: item key -> shipped relative path (only usable icons) ---
const iconByKey = new Map();
if (fs.existsSync(ICON_MANIFEST)) {
  for (const r of parseCSV(fs.readFileSync(ICON_MANIFEST, "utf8"), "icon_manifest.csv")) {
    if (r.status === "ok" && r.dest_rel_path) iconByKey.set(r.item_name, r.dest_rel_path.replace(/\\/g, "/"));
  }
} else {
  warnings.push(`icon_manifest.csv not found at ${ICON_MANIFEST}; weapons will ship without icons`);
}
/** Resolve an icon: manifest hit that also exists on disk, else null (+optional error). */
function resolveIcon(key, ownerLabel, required) {
  const rel = iconByKey.get(key);
  if (!rel) { if (required) errors.push(`${ownerLabel}: no icon_manifest entry for "${key}"`); return null; }
  if (!fs.existsSync(rel)) { errors.push(`${ownerLabel}: icon "${rel}" missing on disk (would 404)`); return null; }
  return rel;
}

// --- weapons ---
const rawWeapons = read("weapons.csv");
const weapons = rawWeapons.map((r) => ({
  key: r.name,
  name: r.displayName || r.name,
  icon: resolveIcon(r.name, `weapon "${r.displayName || r.name}"`, true),
  weaponType: r.weaponType_name,
  damageType: r.damageType_name,
  caliber: r.caliber_name,
  baseDamage: num(r.computed_base_damage),
  pellets: num(r.pellets, 1) || 1,
  rpm: num(r.rpm),
  shotInterval: num(r.shot_interval_s),
  ammoMax: num(r.iAmmoMax),
  reloadTime: num(r.fReloadTime),
  quality: r.itemQuality_name,
  basePrice: num(r.basePrice),
}));

// --- enchantments (Oils / Scrolls / upgrades that carry stat modifiers) ---
const rawEnch = read("enchantments.csv");
const enchantments = rawEnch.map((r) => {
  const cat = (r.category || "").trim();
  const group = cat.startsWith("Oils/") ? cat.slice(5) : (cat === "." || cat === "" ? "Other" : cat);
  return {
    id: r.name,
    name: r.enchantmentName || r.name,
    category: cat || "Other",
    group,
    isElemental: r.IsElemental === "1",
    costsDurability: r.CostsDurability === "1",
    mods: parseMods(r.modifiersApplied, `enchant "${r.enchantmentName || r.name}"`),
  };
});

// --- enemies (HP + 12 resistances) ---
const RESISTS = ["Fire","Frost","Electric","Poison","Explosive","Holy","Shadow","Earth","Punish","Bleed","Petrified","Charm"];
const rawEnemies = read("enemies.csv");
const enemies = rawEnemies.map((r) => {
  const resist = {};
  for (const k of RESISTS) resist[k] = num(r["Resistance_" + k]);
  return { id: r.name, name: r.displayName || r.name, faction: r.faction || "", hp: num(r.base_MaxHealth), resist };
});

// --- player base stats (Player source only) ---
const playerBase = {};
for (const r of read("player_base_stats.csv")) {
  if (r.source === "Player") playerBase[r.attribute_name] = num(r.base_value);
}

// --- guardrails: duplicate keys + dangling damageType->resistance sanity ---
function dupCheck(list, keyFn, label) {
  const seen = new Set();
  for (const it of list) {
    const k = keyFn(it);
    if (!k) { errors.push(`${label}: record with empty key`); continue; }
    if (seen.has(k)) errors.push(`${label}: duplicate key "${k}"`);
    seen.add(k);
  }
}
dupCheck(weapons, (w) => w.key, "weapons");
dupCheck(enchantments, (e) => e.id, "enchantments");
dupCheck(enemies, (e) => e.id, "enemies");

// weapon damageType should map to a known resistance channel (or be an unresisted type)
const UNRESISTED = new Set(["Normal", "Physics", "None", "", "Suffocate", "Sacrifice", "Water", "Critical", "Dark"]);
for (const w of weapons) {
  if (!RESISTS.includes(w.damageType) && !UNRESISTED.has(w.damageType)) {
    warnings.push(`weapon "${w.name}": damageType "${w.damageType}" has no resistance channel (treated as unresisted)`);
  }
}

// --- hygiene report ---
const iconCount = weapons.filter((w) => w.icon).length;
console.log("── SULFUR data hygiene report ──────────────────");
console.log(`✓ ${weapons.length} weapons, ${enchantments.length} enchantments, ${enemies.length} enemies`);
console.log(`✓ ${iconCount}/${weapons.length} weapon icons resolved on disk`);
if (errors.length) { console.log(`✗ ${errors.length} error(s):`); errors.forEach((e) => console.log(`    ${e}`)); }
if (warnings.length) { console.log(`⚠ ${warnings.length} warning(s):`); warnings.forEach((w) => console.log(`    ${w}`)); }
console.log("─".repeat(48));

const hard = errors.length + (STRICT ? warnings.length : 0);
if (hard) { console.error(`BUILD FAILED: ${hard} error(s). ${OUT} left untouched.`); process.exit(1); }

// --- write output ---
const data = {
  meta: { counts: { weapons: weapons.length, enchantments: enchantments.length, enemies: enemies.length } },
  engine: { critMult: 2, clampMin: 0.01, clampMax: 10 },
  resistChannels: RESISTS,
  weapons,
  enchantments,
  enemies,
  playerBase,
};
fs.writeFileSync(OUT, `window.${ACRONYM}_DATA = ${JSON.stringify(data)};\n`);
console.log(`Wrote ${OUT} (window.${ACRONYM}_DATA).`);
