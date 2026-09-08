/*
  SULFUR Loadout Planner — app logic.
  Reads window.SULFUR_DATA (generated into data.js by build-data.mjs).

  Weapons are the focus: each weapon has 3 typed attachment slots (Muzzle / Sight /
  Action), and up to 5 enchantments (oils + scrolls) with at most ONE scroll (elemental).
  Attachments and enchants modify the weapon's live stats as they are applied. A character
  paperdoll (Head/Torso/2×Foot/Gadget) aggregates gear stats. Selectors are category-limited
  and show an info panel with the item's stats before you commit.

  Math mirrors the game's engine per attribute: Flat (sum) -> pooled PercentAdd
  (× clamp(1+Σ, 0.01, 10)) -> each PercentMult (×(1+v)). Attachment effects come from
  ItemDefinition.modifiersOnAttachToItem; enchant effects from modifiersApplied; crit is a
  flat ×2 rolled at CritChance; resistance is ((100-r)/100) vs the chosen target.
*/
(function () {
  "use strict";

  const DATA = window.SULFUR_DATA || {};
  const ITEMS = DATA.items || [];
  const WEAPONS = DATA.weapons || [];
  const ENCH = DATA.enchantments || [];
  const ENEMIES = DATA.enemies || [];
  const PBASE = DATA.playerBase || {};
  const ENGINE = Object.assign({ critMult: 2, clampMin: 0.01, clampMax: 10 }, DATA.engine);
  const STORAGE_KEY = "sulfurbc.loadout";
  const SCHEMA = 2;
  const WEAPON_SLOTS = 2;
  const MAX_ENCH = 5;                 // rank-based cap; 5 is the practical planning max
  const ATTACH_SLOTS = ["muzzle", "sight", "action"];
  const ATTACH_LABEL = { muzzle: "Muzzle", sight: "Sight", action: "Action" };

  const DMG_TO_RESIST = { Fire:"Fire",Frost:"Frost",Electric:"Electric",Poison:"Poison",
    Explosive:"Explosive",Holy:"Holy",Shadow:"Shadow",Earth:"Earth",Punish:"Punish",
    Bleed:"Bleed",Petrified:"Petrified",Charm:"Charm" };

  const itemByKey = new Map(ITEMS.map((i) => [i.key, i]));
  const weaponByKey = new Map(WEAPONS.map((w) => [w.key, w]));
  const enchById = new Map(ENCH.map((e) => [e.id, e]));
  const enemyById = new Map(ENEMIES.map((e) => [e.id, e]));

  // --- label standardization: backend attribute tag -> display text (see labels.js) ---
  const LABELS = (window.SULFUR_LABELS && window.SULFUR_LABELS.attr) || {};
  const attrMeta = (tag) => LABELS[tag] || {};
  const spaced = (s) => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").trim();
  function label(tag) {
    const e = LABELS[tag];
    if (e && e.name) return e.name;
    let m;
    // EntityAttribute families (equipment / player stats)
    if ((m = /^Resistance_(.+)$/.exec(tag))) return m[1] === "Armor" ? "Armor" : spaced(m[1]) + " Resistance";
    if ((m = /^ExtraDamage_(.+)$/.exec(tag))) return spaced(m[1]) + " Damage";
    if ((m = /^NegativeEffect_(.+)$/.exec(tag))) return spaced(m[1]);
    if ((m = /^(?:Stat|Status)_Wearing(.+)$/.exec(tag))) return "Wearing " + spaced(m[1]);
    // ItemAttribute families (weapon / projectile)
    const t = String(tag).replace(/^ItemStat_/, "").replace(/^Stat_/, "")
      .replace(/^ProjectileApply/, "Applies ").replace(/^ProjectileOnHit/, "On Hit: ")
      .replace(/^Projectile/, "Projectile ");
    return spaced(t);
  }

  const el = (id) => document.getElementById(id);
  const els = {
    weaponSlots: el("weapon-slots"), stats: el("stats"), dps: el("dps"),
    enemy: el("enemy-select"), counts: el("counts"), clear: el("clear-loadout"),
    overlay: el("overlay"), overlayList: el("overlay-list"), overlayTitle: el("overlay-title"),
    overlaySearch: el("overlay-search"), overlayClose: el("overlay-close"),
    overlayFilters: el("overlay-filters"), overlayDetail: el("overlay-detail"),
  };

  // ---- state ----
  function freshState() {
    return {
      schema: SCHEMA,
      equipment: { head: null, torso: null, footL: null, footR: null, gadget: null },
      weapons: Array.from({ length: WEAPON_SLOTS }, () => ({
        weapon: null, attachments: { muzzle: null, sight: null, action: null }, enchants: [],
      })),
      enemy: null,
    };
  }
  let state = load();
  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (s && s.schema === SCHEMA && s.equipment && Array.isArray(s.weapons)) return s;
    } catch { /* ignore */ }
    return freshState();               // old/absent schema -> fresh (no silent breakage)
  }
  const persist = () => localStorage.setItem(STORAGE_KEY, JSON.stringify(state));

  // =====================================================================
  //  Stat engine
  // =====================================================================
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const round = (v, d) => { const p = 10 ** d; return Math.round(v * p) / p; };
  function calcStat(base, mods) {
    let n = base, pa = 0, has = false;
    for (const m of mods) if (m.type === "Flat") n += m.value;
    for (const m of mods) if (m.type === "PercentAdd") { pa += m.value; has = true; }
    if (has) n *= clamp(1 + pa, ENGINE.clampMin, ENGINE.clampMax);
    for (const m of mods) if (m.type === "PercentMult") n *= (1 + m.value);
    return round(n, 4);
  }
  const fmt = (n) => (Number.isFinite(n) ? (Math.abs(n) >= 100 ? Math.round(n) : round(n, 2)) : "—");

  // attribute base defaults: multipliers default to 1.0, additive stats to 0
  function attrBase(attr, w) {
    if (attr === "Damage") return w ? w.baseDamage : 0;
    if (attr === "RPM") return w ? w.rpm : 0;
    if (/Multiplier$/.test(attr) || attr === "ReloadSpeed") return 1;
    return 0;
  }

  // =====================================================================
  //  Weapon: gather mods (attachments + enchants) and derive live stats
  // =====================================================================
  function weaponMods(slot) {
    const byAttr = new Map();
    const add = (m) => { if (!byAttr.has(m.attr)) byAttr.set(m.attr, []); byAttr.get(m.attr).push(m); };
    for (const s of ATTACH_SLOTS) {
      const a = slot.attachments[s] && itemByKey.get(slot.attachments[s]);
      if (a) for (const m of a.attachMods || []) add(m);
    }
    for (const id of slot.enchants) {
      const e = enchById.get(id);
      if (e) for (const m of e.mods) add(m);
    }
    return byAttr;
  }

  function computeWeapon(slot) {
    const w = slot.weapon && weaponByKey.get(slot.weapon);
    if (!w) return null;
    const byAttr = weaponMods(slot);
    const get = (a) => byAttr.get(a) || [];

    const perPellet0 = w.baseDamage;
    let perPellet = calcStat(w.baseDamage, get("Damage"));
    const gBonus = get("Stat_GlobalDamageMultiplier").length ? calcStat(0, get("Stat_GlobalDamageMultiplier")) : 0;
    perPellet *= (1 + gBonus);
    const perShot = perPellet * w.pellets;

    const rpm = calcStat(w.rpm, get("RPM"));
    const sps = rpm > 0 ? rpm / 60 : 0;
    const critChance = clamp(calcStat(Number(PBASE.Stat_CritChance || 0), get("Stat_CritChance")), 0, 1);
    const expected = perShot * (1 + critChance * (ENGINE.critMult - 1));

    const enemy = state.enemy && enemyById.get(state.enemy);
    const channel = DMG_TO_RESIST[w.damageType] || null;
    const resist = enemy && channel ? Number(enemy.resist[channel] || 0) : 0;
    const mitig = Math.max(0, (100 - resist) / 100);
    const dpsEff = expected * mitig * sps;
    const hp = enemy ? enemy.hp : 0;

    // curated live stats for the weapon card: always-on base stats + modded stats
    const live = [
      { k: "Damage / shot", base: perPellet0 * w.pellets, val: perShot, better: "up" },
      { k: "Fire rate", base: w.rpm / 60, val: sps, unit: "/s", better: "up" },
      { k: "Magazine", base: w.ammoMax, val: w.ammoMax, better: "up" },
      { k: "Reload", base: w.reloadTime, val: w.reloadTime, unit: "s", better: "down" },
      { k: "Bullet speed", base: w.bulletSpeed, val: w.bulletSpeed, better: "up" },
      { k: "Recoil", base: 1, val: calcStat(1, get("KickMultiplier")), better: "down", show: byAttr.has("KickMultiplier") },
      { k: "Spread", base: 0, val: calcStat(0, get("Spread")), better: "down", show: byAttr.has("Spread") },
      { k: "Crit (ADS)", base: 0, val: calcStat(0, get("CritChanceADS")), better: "up", pct: true, show: byAttr.has("CritChanceADS") },
      { k: "Full-auto", base: 0, val: calcStat(0, get("FullAuto")), better: "up", flag: true, show: byAttr.has("FullAuto") },
    ].filter((r) => r.show !== false);

    // everything else the mods touch, for completeness (labelled via label())
    const shown = new Set(["Damage", "RPM", "Stat_GlobalDamageMultiplier", "Stat_CritChance", "KickMultiplier", "Spread", "CritChanceADS", "FullAuto"]);
    const other = [];
    for (const [attr, mods] of byAttr) {
      if (shown.has(attr)) continue;
      other.push({ attr, base: attrBase(attr, w), val: calcStat(attrBase(attr, w), mods) });
    }

    return { w, enemy, resist, channel, mitig, perShot, rpm, sps, critChance, dpsRaw: perShot * sps, dpsEff,
      ttk: dpsEff > 0 && hp > 0 ? hp / dpsEff : null, live, other };
  }

  // =====================================================================
  //  Rendering — paperdoll
  // =====================================================================
  function paintSlot(node, item, label) {
    node.classList.toggle("filled", !!item);
    node.innerHTML =
      (item && item.icon ? `<img class="slot-icon" src="${item.icon}" alt="">` : "") +
      `<span class="slot-label">${item ? item.name : label}</span>`;
    node.title = item ? item.name + " — click to change" : "Select " + label;
  }
  const SLOT_LABELS = { head: "Head", torso: "Torso", footL: "Left Foot", footR: "Right Foot", gadget: "Gadget" };
  function renderPaperdoll() {
    for (const [slot, label] of Object.entries(SLOT_LABELS)) {
      const node = document.querySelector(`.slot[data-slot="${slot}"]`);
      if (node) paintSlot(node, state.equipment[slot] && itemByKey.get(state.equipment[slot]), label);
    }
  }

  // =====================================================================
  //  Rendering — weapon cards
  // =====================================================================
  function statDelta(r) {
    const changed = Math.abs(r.val - r.base) > 1e-6;
    let disp;
    if (r.flag) disp = r.val > 0 ? "ON" : "—";
    else if (r.pct) disp = (r.val > 0 ? "+" : "") + round(r.val * 100, 1) + "%";
    else disp = fmt(r.val) + (r.unit || "");
    let cls = "";
    if (changed && !r.flag) cls = ((r.val > r.base) === (r.better === "up")) ? "pos" : "neg";
    else if (r.flag && r.val > 0) cls = "pos";
    return `<div class="lv"><span class="lk">${r.k}</span><span class="lvv ${cls}">${disp}</span></div>`;
  }

  function renderWeapons() {
    els.weaponSlots.innerHTML = "";
    state.weapons.forEach((slot, wi) => {
      const w = slot.weapon && weaponByKey.get(slot.weapon);
      const box = document.createElement("div");
      box.className = "weapon-slot";
      const wIcon = w && w.icon ? `<img class="slot-icon" src="${w.icon}" alt="">` : "";
      const meta = w ? `${w.weaponType} · ${w.damageType} · ${w.caliber}` : "Tap to choose a weapon";

      // only the attachment slots THIS weapon actually supports (from prefab compatibility)
      const supported = w ? ATTACH_SLOTS.filter((s) => (w.attachSlots[s] || []).length) : [];
      const attachCells = supported.map((s) => {
        const it = slot.attachments[s] && itemByKey.get(slot.attachments[s]);
        const inner = it && it.icon ? `<img src="${it.icon}" alt="">` : "";
        return `<button class="acell ${it ? "filled" : "add"}" data-act="attach" data-wi="${wi}" data-slot="${s}" type="button" title="${it ? it.name : "Add " + ATTACH_LABEL[s]}">${inner}<span class="acell-label">${ATTACH_LABEL[s]}</span></button>`;
      }).join("");
      const attachHtml = supported.length
        ? `<div class="acells">${attachCells}</div>`
        : `<div class="muted small">No attachment slots on this weapon.</div>`;

      const scrolls = slot.enchants.filter((id) => (enchById.get(id) || {}).isElemental).length;
      const enchChips = slot.enchants.map((id, ei) => {
        const e = enchById.get(id); if (!e) return "";
        return `<span class="chip${e.isElemental ? " scroll" : " oil"}" data-act="unench" data-wi="${wi}" data-ei="${ei}" title="Remove">${e.name} <span class="x">✕</span></span>`;
      }).join("");
      const full = slot.enchants.length >= MAX_ENCH;
      const addOil = full ? "" : `<button class="chip add" data-act="ench" data-kind="oil" data-wi="${wi}" type="button">+ oil</button>`;
      const addScroll = (full || scrolls >= 1) ? "" : `<button class="chip add scroll" data-act="ench" data-kind="scroll" data-wi="${wi}" type="button">+ scroll</button>`;

      const comp = w ? computeWeapon(slot) : null;
      const liveHtml = comp ? comp.live.map(statDelta).join("") : "";
      const otherHtml = comp && comp.other.length
        ? `<details class="wother"><summary>+${comp.other.length} more affected</summary>` +
          comp.other.map((o) => `<div class="lv"><span class="lk">${label(o.attr)}</span><span class="lvv">${attrMeta(o.attr).flag ? (o.val > 0 ? "ON" : "—") : fmt(o.val)}</span></div>`).join("") + `</details>`
        : "";

      box.innerHTML = `
        <div class="ws-main">
          <button class="ws-weapon${w ? " filled" : ""}" data-act="weapon" data-wi="${wi}" type="button">${wIcon}</button>
          <div class="ws-info">
            <div class="ws-name">${w ? w.name : "Weapon slot " + (wi + 1)}</div>
            <div class="ws-meta">${meta}</div>
          </div>
        </div>
        ${w ? `<div class="ws-cols">
          <div class="mod-group"><span class="mg-label">Attachments</span>${attachHtml}</div>
          <div class="mod-group"><span class="mg-label">Enchantments <span class="mg-note">${slot.enchants.length}/${MAX_ENCH}${scrolls ? " · 1 scroll" : ""}</span></span>
            <div class="chips">${enchChips}${addOil}${addScroll}</div></div>
        </div>
        <div class="ws-live">${liveHtml}${otherHtml}</div>` : ""}`;
      els.weaponSlots.appendChild(box);
    });
  }

  // =====================================================================
  //  Rendering — readout (per-weapon DPS vs target + gear stats)
  // =====================================================================
  function renderReadout() {
    let dhtml = "";
    state.weapons.forEach((slot) => {
      const r = computeWeapon(slot);
      if (!r) return;
      dhtml += `<div class="dps-w">${r.w.name}</div>`;
      dhtml += `<div class="row big"><span class="k">DPS${r.enemy ? " vs " + r.enemy.name : ""}</span><span class="v">${fmt(r.enemy ? r.dpsEff : r.dpsRaw)}</span></div>`;
      if (r.enemy) {
        dhtml += `<div class="row"><span class="k">${r.channel ? r.channel + " " + r.resist + "%" : "unresisted"}</span><span class="v">×${round(r.mitig, 2)}</span></div>`;
        dhtml += `<div class="row ttk"><span class="k">Time to kill</span><span class="v">${r.ttk != null ? round(r.ttk, 2) + " s" : "—"}</span></div>`;
      }
    });
    els.dps.innerHTML = dhtml || `<div class="muted small">Equip a weapon to see damage.</div>`;

    // aggregated equipment stats
    const byAttr = new Map();
    for (const k of Object.values(state.equipment)) {
      const it = k && itemByKey.get(k); if (!it) continue;
      for (const m of it.mods || []) { if (!byAttr.has(m.attr)) byAttr.set(m.attr, []); byAttr.get(m.attr).push(m); }
    }
    const rows = [];
    for (const [attr, mods] of [...byAttr.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const f = mods.filter((m) => m.type === "Flat").reduce((s, m) => s + m.value, 0);
      const pa = mods.filter((m) => m.type === "PercentAdd").reduce((s, m) => s + m.value, 0);
      const pm = mods.filter((m) => m.type === "PercentMult");
      const parts = [];
      if (f) parts.push(`${f > 0 ? "+" : ""}${round(f, 3)}`);
      if (pa) parts.push(`${pa > 0 ? "+" : ""}${round(pa * 100, 1)}%`);
      for (const m of pm) parts.push(`×${round(1 + m.value, 3)}`);
      const net = f + pa + pm.reduce((s, m) => s + m.value, 0);
      const good = attrMeta(attr).lowerBetter ? net < 0 : net > 0;
      const cls = net === 0 ? "" : (good ? "pos" : "neg");
      rows.push({ cat: attrMeta(attr).cat || "Other", html: `<div class="stat"><span class="sk">${label(attr)}</span><span class="sv ${cls}">${parts.join("  ")}</span></div>` });
    }
    rows.sort((a, b) => a.cat.localeCompare(b.cat));
    els.stats.innerHTML = `<div class="sl-head">Equipment effects (${rows.length})</div>` +
      (rows.length ? rows.map((r) => r.html).join("") : `<div class="muted small">Equip armour to see stat changes.</div>`);
  }

  function renderAll() { renderPaperdoll(); renderWeapons(); renderReadout(); persist(); }

  // =====================================================================
  //  Selector overlay (category-limited, with info panel + optional filters)
  // =====================================================================
  let ctx = null;   // { title, opts, onPick, onClear?, allowClear?, filters?, filterKey?, statLines? }
  let activeFilter = null;
  function openSelector(next) {
    ctx = next; activeFilter = null;
    els.overlayTitle.textContent = next.title;
    els.overlaySearch.value = "";
    els.overlayDetail.hidden = true; els.overlayDetail.innerHTML = "";
    if (next.filters && next.filters.length) {
      els.overlayFilters.hidden = false;
      els.overlayFilters.innerHTML = [`<button class="fchip on" data-f="">All</button>`]
        .concat(next.filters.map((f) => `<button class="fchip" data-f="${f}">${f}</button>`)).join("");
    } else { els.overlayFilters.hidden = true; els.overlayFilters.innerHTML = ""; }
    renderOptions();
    els.overlay.hidden = false;
    els.overlaySearch.focus();
  }
  function closeSelector() { els.overlay.hidden = true; ctx = null; }

  function renderOptions() {
    if (!ctx) return;
    const q = (els.overlaySearch.value || "").toLowerCase();
    let list = ctx.opts.filter((o) => !q || o.name.toLowerCase().includes(q));
    if (activeFilter) list = list.filter((o) => o.filter === activeFilter);
    let html = ctx.allowClear ? `<button class="opt clear-opt" data-clear="1">✕ Clear slot</button>` : "";
    html += list.map((o) =>
      `<button class="opt" data-i="${o._i}">${o.icon ? `<img src="${o.icon}" alt="">` : `<span class="opt-noimg"></span>`}<span><span class="opt-name">${o.name}</span>${o.sub ? `<span class="opt-sub"> ${o.sub}</span>` : ""}</span></button>`
    ).join("");
    els.overlayList.innerHTML = html || `<div class="muted small">No matches.</div>`;
  }

  // info panel: show the focused item's stats before committing (VS-style)
  function showDetail(o) {
    els.overlayDetail._item = o;      // Equip button reads this to know what to commit
    const lines = (ctx.statLines ? ctx.statLines(o) : []);
    els.overlayDetail.hidden = false;
    els.overlayDetail.innerHTML =
      `<div class="od-head">${o.icon ? `<img src="${o.icon}" alt="">` : ""}<div><div class="od-name">${o.name}</div>${o.sub ? `<div class="od-sub">${o.sub}</div>` : ""}</div></div>` +
      (lines.length ? `<div class="od-stats">${lines.map((l) => `<div class="od-stat"><span>${l.k}</span><span class="${l.cls || ""}">${l.v}</span></div>`).join("")}</div>` : `<div class="muted small">No stat effects.</div>`) +
      `<button class="od-equip" data-equip="1" type="button">Equip</button>`;
    els.overlayDetail.scrollIntoView({ block: "nearest" });
  }

  // stat-line builders
  const modLines = (mods) => (mods || []).map((m) => {
    const good = attrMeta(m.attr).lowerBetter ? m.value < 0 : m.value > 0;
    return {
      k: label(m.attr),
      v: m.type === "Flat" ? (m.value > 0 ? "+" : "") + round(m.value, 3)
        : m.type === "PercentAdd" ? (m.value > 0 ? "+" : "") + round(m.value * 100, 1) + "%" : "×" + round(1 + m.value, 3),
      cls: m.value === 0 ? "" : (good ? "pos" : "neg"),
    };
  });
  const weaponLines = (w) => [
    { k: "Damage", v: fmt(w.baseDamage) + (w.pellets > 1 ? " ×" + w.pellets + " pellets" : "") },
    { k: "Fire rate", v: fmt(w.rpm / 60) + "/s (" + fmt(w.rpm) + " rpm)" },
    { k: "Reload", v: fmt(w.reloadTime) + "s" },
    { k: "Magazine", v: w.ammoMax + (w.ammoPerShot > 1 ? " (" + w.ammoPerShot + "/shot)" : "") },
    { k: "Bullet speed", v: fmt(w.bulletSpeed) },
    { k: "Shots to full spread", v: w.shotsToFullSpread || "—" },
    { k: "Weight class", v: w.weight }, { k: "ADS", v: w.ads ? "Yes" : "No" },
    { k: "Type", v: w.weaponType + " · " + w.caliber }, { k: "Damage type", v: w.damageType },
    { k: "Quality", v: w.quality },
  ];

  // opt builders (each opt keeps its index within the current ctx.opts)
  const indexed = (opts) => { opts.forEach((o, i) => (o._i = i)); return opts; };
  const itemOpts = (slot) => ITEMS.filter((i) => i.slot === slot).map((i) => ({ ref: i, key: i.key, name: i.name, sub: `${i.quality || ""}${i.size ? " · " + i.size.w + "×" + i.size.h : ""}`, icon: i.icon }));
  const attachOpts = (keys) => keys.map((k) => itemByKey.get(k)).filter(Boolean)
    .map((i) => ({ ref: i, key: i.key, name: i.name,
      sub: i.subtype ? i.subtype + (i.mag ? " · " + i.mag + "x" : "") : (i.quality || ""),
      icon: i.icon, filter: i.subtype || null }))
    .sort((a, b) => (a.filter || "").localeCompare(b.filter || "") || (a.ref.mag || 0) - (b.ref.mag || 0) || a.name.localeCompare(b.name));
  const weaponOpts = () => WEAPONS.map((w) => ({ ref: w, key: w.key, name: w.name, sub: `${w.weaponType} · ${fmt(w.baseDamage)}dmg`, icon: w.icon, filter: w.weaponType }));
  const enchOpts = (elemental) => ENCH.filter((e) => !!e.isElemental === elemental).map((e) => ({ ref: e, key: e.id, name: e.name, sub: e.group, icon: null, filter: e.group }));

  // =====================================================================
  //  Slot -> selector wiring
  // =====================================================================
  function selectEquip(slot, label) {
    openSelector({
      title: "Select " + label, allowClear: true, opts: indexed(itemOpts(slot === "footL" || slot === "footR" ? "feet" : slot)),
      statLines: (o) => modLines(o.ref.mods),
      onPick: (o) => { state.equipment[slot] = o.key; }, onClear: () => { state.equipment[slot] = null; },
    });
  }

  document.querySelectorAll(".slot[data-slot]").forEach((node) => {
    node.addEventListener("click", () => selectEquip(node.dataset.slot, SLOT_LABELS[node.dataset.slot]));
  });

  els.weaponSlots.addEventListener("click", (ev) => {
    const t = ev.target.closest("[data-act]"); if (!t) return;
    const wi = Number(t.dataset.wi); const act = t.dataset.act;
    if (act === "weapon") {
      openSelector({ title: "Select weapon", allowClear: true, opts: indexed(weaponOpts()),
        filters: [...new Set(WEAPONS.map((w) => w.weaponType))].sort(),
        statLines: (o) => weaponLines(o.ref),
        onPick: (o) => { state.weapons[wi].weapon = o.key; state.weapons[wi].attachments = { muzzle: null, sight: null, action: null }; },
        onClear: () => { state.weapons[wi].weapon = null; state.weapons[wi].attachments = { muzzle: null, sight: null, action: null }; } });
    } else if (act === "attach") {
      const s = t.dataset.slot;
      if (itemByKey.has(state.weapons[wi].attachments[s])) { state.weapons[wi].attachments[s] = null; renderAll(); return; }
      const w = state.weapons[wi].weapon && weaponByKey.get(state.weapons[wi].weapon);
      const keys = w ? (w.attachSlots[s] || []) : [];
      const opts = indexed(attachOpts(keys));
      const subs = [...new Set(opts.map((o) => o.filter).filter(Boolean))];
      openSelector({ title: ATTACH_LABEL[s] + " attachment", allowClear: false, opts,
        filters: subs.length > 1 ? subs : null,
        statLines: (o) => modLines(o.ref.attachMods),
        onPick: (o) => { state.weapons[wi].attachments[s] = o.key; } });
    } else if (act === "ench") {
      const elemental = t.dataset.kind === "scroll";
      openSelector({ title: elemental ? "Select scroll (elemental)" : "Select oil", allowClear: false, opts: indexed(enchOpts(elemental)),
        filters: [...new Set(ENCH.filter((e) => !!e.isElemental === elemental).map((e) => e.group))].sort(),
        statLines: (o) => modLines(o.ref.mods),
        onPick: (o) => {
          const sl = state.weapons[wi];
          if (sl.enchants.length >= MAX_ENCH) return;
          if (elemental && sl.enchants.some((id) => (enchById.get(id) || {}).isElemental)) return;
          sl.enchants.push(o.key);
        } });
    } else if (act === "unench") {
      state.weapons[wi].enchants.splice(Number(t.dataset.ei), 1); renderAll();
    }
  });

  // overlay interactions
  els.overlayFilters.addEventListener("click", (ev) => {
    const t = ev.target.closest("[data-f]"); if (!t) return;
    activeFilter = t.dataset.f || null;
    els.overlayFilters.querySelectorAll(".fchip").forEach((c) => c.classList.toggle("on", c === t));
    renderOptions();
  });
  els.overlayList.addEventListener("click", (ev) => {
    const t = ev.target.closest("button"); if (!t || !ctx) return;
    if (t.dataset.clear) { ctx.onClear && ctx.onClear(); closeSelector(); renderAll(); return; }
    if (t.dataset.i == null) return;
    showDetail(ctx.opts[Number(t.dataset.i)]);   // info panel first
  });
  els.overlayDetail.addEventListener("click", (ev) => {
    const t = ev.target.closest("[data-equip]"); if (!t || !ctx) return;
    const o = els.overlayDetail._item; if (!o) return;
    ctx.onPick(o); closeSelector(); renderAll();
  });

  els.overlaySearch.addEventListener("input", renderOptions);
  els.overlayClose.addEventListener("click", closeSelector);
  els.overlay.addEventListener("click", (ev) => { if (ev.target === els.overlay) closeSelector(); });
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && !els.overlay.hidden) closeSelector(); });

  els.enemy.addEventListener("change", () => { state.enemy = els.enemy.value || null; persist(); renderWeapons(); renderReadout(); });
  els.clear.addEventListener("click", () => { state = freshState(); els.enemy.value = ""; renderAll(); });

  // ---- init ----
  const sortedEnemies = [...ENEMIES].sort((a, b) => a.name.localeCompare(b.name));
  els.enemy.innerHTML = `<option value="">— no target —</option>` +
    sortedEnemies.map((e) => `<option value="${e.id}">${e.name} (${fmt(e.hp)} HP)</option>`).join("");
  els.enemy.value = state.enemy || "";
  els.counts.textContent = `${WEAPONS.length} weapons · ${ITEMS.length} gear · ${ENCH.length} enchantments · ${ENEMIES.length} enemies`;
  renderAll();
})();
