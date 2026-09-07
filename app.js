/*
  SULFUR Build Calculator — app logic (P0 baseline).
  Reads window.SULFUR_DATA (generated into data.js by build-data.mjs).

  P0 flow: pick a weapon -> apply Oils/Scrolls -> pick a target enemy -> live totals.
  State persists to localStorage under "sulfurbc.build".

  Math is the VERIFIED engine from _sulfur_extract/code/PROCEDURAL_MAP.md:
   §1 stat engine  — Flat (sum) -> PercentAdd (pooled, ×clamp(1+Σ,0.01,10)) -> PercentMult (each ×(1+v))
   §3 outgoing dmg — weapon Damage stat, then ×(1+GlobalDamageMultiplier)
   §4 incoming     — crit flat ×2, resistance ×((100-r)/100)
  NOTE (P0 scope): player class/element ExtraDamage_*, headshots, status/DoT synergies
  and endless-loop scaling are P1 — see Progress.md. They are surfaced in the ledger
  but not yet folded into the headline damage numbers.
*/
(function () {
  "use strict";

  const DATA = window.SULFUR_DATA || { weapons: [], enchantments: [], enemies: [], engine: {}, playerBase: {} };
  const STORAGE_KEY = "sulfurbc.build";
  const ENGINE = Object.assign({ critMult: 2, clampMin: 0.01, clampMax: 10 }, DATA.engine);

  // damageType_name -> enemy resistance channel (unlisted types are unresisted)
  const DMG_TO_RESIST = {
    Fire: "Fire", Frost: "Frost", Electric: "Electric", Poison: "Poison",
    Explosive: "Explosive", Holy: "Holy", Shadow: "Shadow", Earth: "Earth",
    Punish: "Punish", Bleed: "Bleed", Petrified: "Petrified", Charm: "Charm",
  };

  const els = {
    weaponSearch: document.getElementById("weapon-search"),
    weaponSelector: document.getElementById("weapon-selector"),
    enchGroup: document.getElementById("enchant-group"),
    enchSearch: document.getElementById("enchant-search"),
    enchSelector: document.getElementById("enchant-selector"),
    enemySelect: document.getElementById("enemy-select"),
    enemyInfo: document.getElementById("enemy-info"),
    buildWeapon: document.getElementById("build-weapon"),
    buildEnchants: document.getElementById("build-enchants"),
    clear: document.getElementById("clear-build"),
    totals: document.getElementById("totals"),
    ledger: document.getElementById("ledger"),
    counts: document.getElementById("counts"),
  };

  const weaponByKey = new Map(DATA.weapons.map((w) => [w.key, w]));
  const enchById = new Map(DATA.enchantments.map((e) => [e.id, e]));
  const enemyById = new Map(DATA.enemies.map((e) => [e.id, e]));

  // --- state ---
  let state = load();
  function load() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch { s = {}; }
    return { weapon: s.weapon || null, enchants: Array.isArray(s.enchants) ? s.enchants : [], enemy: s.enemy || null };
  }
  function persist() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }

  // =====================================================================
  //  Stat engine (PROCEDURAL_MAP §1) — CalculateFinalValue for one attribute
  // =====================================================================
  function calcStat(base, mods) {
    let num = base, pooledAdd = 0, hasAdd = false;
    for (const m of mods) if (m.type === "Flat") num += m.value;
    for (const m of mods) if (m.type === "PercentAdd") { pooledAdd += m.value; hasAdd = true; }
    if (hasAdd) num *= clamp(1 + pooledAdd, ENGINE.clampMin, ENGINE.clampMax);
    for (const m of mods) if (m.type === "PercentMult") num *= (1 + m.value);
    return round(num, 4);
  }
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const round = (v, d) => { const p = 10 ** d; return Math.round(v * p) / p; };

  // Collect every modifier from the applied enchants, grouped by attribute.
  function collectMods() {
    const byAttr = new Map();
    for (const id of state.enchants) {
      const e = enchById.get(id);
      if (!e) continue;
      for (const m of e.mods) {
        if (!byAttr.has(m.attr)) byAttr.set(m.attr, []);
        byAttr.get(m.attr).push(m);
      }
    }
    return byAttr;
  }

  // =====================================================================
  //  Damage computation (PROCEDURAL_MAP §3 outgoing, §4 incoming)
  // =====================================================================
  function compute() {
    const w = state.weapon ? weaponByKey.get(state.weapon) : null;
    if (!w) return null;
    const byAttr = collectMods();

    // §3: weapon Damage stat = base modified by "Damage" modifiers
    const dmgMods = byAttr.get("Damage") || [];
    let perPellet = calcStat(w.baseDamage, dmgMods);

    // §3: ×(1 + GlobalDamageMultiplier). Attribute is a multiplier ~1.0; treat pooled
    // deltas around 0 as the fractional bonus.
    const gMods = byAttr.get("Stat_GlobalDamageMultiplier") || [];
    const gBonus = gMods.length ? calcStat(0, gMods) : 0;
    perPellet *= (1 + gBonus);

    const perShot = perPellet * w.pellets;

    // crit (§4): flat ×2, rolled at critChance. Player base + enchant Stat_CritChance.
    const critBase = Number(DATA.playerBase.Stat_CritChance || 0);
    const critMods = byAttr.get("Stat_CritChance") || [];
    const critChance = clamp(calcStat(critBase, critMods), 0, 1);
    const critPerShot = perShot * ENGINE.critMult;
    const expectedPerShot = perShot * (1 + critChance * (ENGINE.critMult - 1));

    // resistance mitigation (§4) vs selected enemy
    const enemy = state.enemy ? enemyById.get(state.enemy) : null;
    const channel = DMG_TO_RESIST[w.damageType] || null;
    const resist = enemy && channel ? Number(enemy.resist[channel] || 0) : 0;
    const mitig = Math.max(0, (100 - resist) / 100);
    const effPerShot = expectedPerShot * mitig;

    // rate of fire: shots/sec = rpm/60 (fireRate = 60/rpm, §6)
    const sps = w.rpm > 0 ? w.rpm / 60 : 0;
    const dpsRaw = perShot * sps;
    const dpsEff = effPerShot * sps;

    // time to kill vs enemy HP (expected damage incl. crit + resistance)
    const hp = enemy ? enemy.hp : 0;
    const shotsToKill = effPerShot > 0 && hp > 0 ? Math.ceil(hp / effPerShot) : null;
    const ttk = dpsEff > 0 && hp > 0 ? hp / dpsEff : null;

    return {
      w, enemy, channel, resist, mitig, byAttr,
      perPellet, perShot, critPerShot, expectedPerShot, effPerShot,
      critChance, sps, dpsRaw, dpsEff, shotsToKill, ttk,
    };
  }

  // =====================================================================
  //  Rendering
  // =====================================================================
  function fmt(n) { return Number.isFinite(n) ? (Math.abs(n) >= 100 ? Math.round(n) : round(n, 1)) : "—"; }

  function itemRow(html, cls, onClick, selected) {
    const row = document.createElement("div");
    row.className = "item" + (selected ? " selected" : "") + (cls ? " " + cls : "");
    row.innerHTML = html;
    if (onClick) row.addEventListener("click", onClick);
    return row;
  }

  function renderWeapons() {
    const q = (els.weaponSearch.value || "").toLowerCase();
    const prev = els.weaponSelector.scrollTop;
    els.weaponSelector.innerHTML = "";
    for (const w of DATA.weapons) {
      if (q && !w.name.toLowerCase().includes(q) && !w.weaponType.toLowerCase().includes(q)) continue;
      const icon = w.icon ? `<img src="${w.icon}" alt="" loading="lazy">` : "";
      const html = `${icon}<span class="name">${w.name}<span class="meta"> ${w.weaponType} · ${fmt(w.baseDamage)}dmg${w.pellets > 1 ? " ×" + w.pellets : ""}</span></span>`;
      els.weaponSelector.appendChild(itemRow(html, null, () => {
        state.weapon = w.key; persist(); renderAll();
      }, state.weapon === w.key));
    }
    els.weaponSelector.scrollTop = prev;
  }

  function renderEnchantGroups() {
    const groups = [...new Set(DATA.enchantments.map((e) => e.group))].sort();
    els.enchGroup.innerHTML = `<option value="">All groups</option>` +
      groups.map((g) => `<option value="${g}">${g}</option>`).join("");
  }

  function renderEnchants() {
    const q = (els.enchSearch.value || "").toLowerCase();
    const grp = els.enchGroup.value;
    const prev = els.enchSelector.scrollTop;
    els.enchSelector.innerHTML = "";
    for (const e of DATA.enchantments) {
      if (grp && e.group !== grp) continue;
      if (q && !e.name.toLowerCase().includes(q)) continue;
      const summary = e.mods.map((m) => `${m.attr} ${m.value > 0 ? "+" : ""}${m.value}`).slice(0, 3).join(", ");
      const html = `<span class="name">${e.name}<span class="meta"> ${e.group}${summary ? " · " + summary : ""}</span></span>`;
      els.enchSelector.appendChild(itemRow(html, e.isElemental ? "elemental" : null, () => {
        state.enchants.push(e.id); persist(); renderBuild(); renderTotals();
      }, false));
    }
    els.enchSelector.scrollTop = prev;
  }

  function renderEnemies() {
    if (els.enemySelect.options.length) return; // static list, build once
    const sorted = [...DATA.enemies].sort((a, b) => a.name.localeCompare(b.name));
    els.enemySelect.innerHTML = `<option value="">— no target (raw damage) —</option>` +
      sorted.map((e) => `<option value="${e.id}">${e.name} (${fmt(e.hp)} HP)</option>`).join("");
    els.enemySelect.value = state.enemy || "";
  }

  function renderEnemyInfo() {
    const e = state.enemy ? enemyById.get(state.enemy) : null;
    if (!e) { els.enemyInfo.textContent = "Pick a target to see resistance-adjusted damage & time-to-kill."; return; }
    const res = Object.entries(e.resist).filter(([, v]) => v).map(([k, v]) => `${k} ${v}%`).join(", ");
    els.enemyInfo.textContent = `${e.name} · ${fmt(e.hp)} HP · ${e.faction || "—"}` + (res ? ` · resists: ${res}` : " · no resistances");
  }

  function renderBuild() {
    const w = state.weapon ? weaponByKey.get(state.weapon) : null;
    els.buildWeapon.innerHTML = w
      ? `${w.icon ? `<img src="${w.icon}" alt="">` : ""}<div><div class="wname">${w.name}</div>
         <div class="wmeta">${w.weaponType} · ${w.damageType} · ${w.caliber} · ${fmt(w.baseDamage)} dmg${w.pellets > 1 ? " ×" + w.pellets + " pellets" : ""} · ${fmt(w.rpm)} rpm</div></div>`
      : `<span class="muted">Select a weapon to begin.</span>`;

    els.buildEnchants.innerHTML = "";
    if (!state.enchants.length) {
      els.buildEnchants.innerHTML = `<span class="muted small">No enchants applied — tap Oils above to add (stacks allowed).</span>`;
    } else {
      state.enchants.forEach((id, idx) => {
        const e = enchById.get(id);
        if (!e) return;
        const chip = document.createElement("span");
        chip.className = "chip" + (e.isElemental ? " elemental" : "");
        chip.innerHTML = `${e.name} <span class="x">✕</span>`;
        chip.title = "Remove";
        chip.addEventListener("click", () => { state.enchants.splice(idx, 1); persist(); renderBuild(); renderTotals(); });
        els.buildEnchants.appendChild(chip);
      });
    }
    // reflect selection state in the weapon grid without a full rebuild
    renderWeapons();
  }

  function statRow(label, val, cls) {
    return `<div class="stat ${cls || ""}"><span class="label">${label}</span><span class="val">${val}</span></div>`;
  }

  function renderTotals() {
    const r = compute();
    if (!r) { els.totals.innerHTML = `<div class="muted">Select a weapon to compute damage.</div>`; els.ledger.innerHTML = ""; return; }

    const w = r.w;
    let html = "";
    html += statRow("Effective damage / pellet", fmt(r.perPellet));
    html += statRow(`Per shot${w.pellets > 1 ? " (×" + w.pellets + " pellets)" : ""}`, fmt(r.perShot), "big");
    html += statRow("On crit (×2)", fmt(r.critPerShot));
    if (r.critChance > 0) html += statRow(`Expected (crit ${Math.round(r.critChance * 100)}%)`, fmt(r.expectedPerShot));
    html += statRow("Fire rate", `${fmt(r.sps)} shots/s`);
    html += statRow("DPS (raw)", fmt(r.dpsRaw), "head");

    if (r.enemy) {
      const chanTxt = r.channel ? `${r.channel} ${r.resist}%` : "unresisted";
      html += statRow(`vs ${r.enemy.name} — ${chanTxt}`, `×${round(r.mitig, 2)}`, "head");
      html += statRow("Effective per shot", fmt(r.effPerShot));
      html += statRow("Effective DPS", fmt(r.dpsEff), "big");
      html += statRow("Shots to kill", r.shotsToKill ?? "—", "ttk");
      html += statRow("Time to kill", r.ttk != null ? round(r.ttk, 2) + " s" : "—", "ttk");
    } else {
      html += `<div class="stat"><span class="muted small">Pick a target enemy for resistance-adjusted damage &amp; time-to-kill.</span></div>`;
    }
    els.totals.innerHTML = html;

    // ledger: every attribute the applied enchants touch (transparency; P1 folds more of these in)
    const rows = [];
    for (const [attr, mods] of [...r.byAttr.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const parts = [];
      const f = mods.filter((m) => m.type === "Flat").reduce((s, m) => s + m.value, 0);
      const pa = mods.filter((m) => m.type === "PercentAdd").reduce((s, m) => s + m.value, 0);
      const pm = mods.filter((m) => m.type === "PercentMult");
      if (f) parts.push(`${f > 0 ? "+" : ""}${round(f, 3)} flat`);
      if (pa) parts.push(`${pa > 0 ? "+" : ""}${round(pa * 100, 1)}% add`);
      for (const m of pm) parts.push(`×${round(1 + m.value, 3)}`);
      rows.push(`<div class="lrow"><span class="lattr">${attr}</span><span class="lval">${parts.join(", ")}</span></div>`);
    }
    els.ledger.innerHTML = rows.length ? rows.join("") : `<div class="muted small">Apply enchants to see their stat effects.</div>`;
  }

  function renderAll() { renderBuild(); renderEnemyInfo(); renderTotals(); }

  // --- events ---
  els.weaponSearch.addEventListener("input", renderWeapons);
  els.enchGroup.addEventListener("change", renderEnchants);
  els.enchSearch.addEventListener("input", renderEnchants);
  els.enemySelect.addEventListener("change", () => { state.enemy = els.enemySelect.value || null; persist(); renderEnemyInfo(); renderTotals(); });
  els.clear.addEventListener("click", () => { state = { weapon: null, enchants: [], enemy: null }; persist(); els.enemySelect.value = ""; renderAll(); });

  // --- init ---
  renderWeapons();
  renderEnchantGroups();
  renderEnchants();
  renderEnemies();
  renderAll();
  els.counts.textContent = `${DATA.weapons.length} weapons · ${DATA.enchantments.length} enchantments · ${DATA.enemies.length} enemies`;
})();
