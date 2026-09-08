/*
  SULFUR Loadout Planner — app logic.  Reads window.SULFUR_DATA (data.js) + window.SULFUR_LABELS (labels.js).

  Weapons are the focus: each has a full-width shape, 4 mod slots (Muzzle / Sight / Action / Caliber)
  and up to 5 enchant cells (≤1 scroll). Attachments are gated to the weapon's real compatibility;
  the Caliber slot (Chamber Chisel) swaps the round, recomputing damage + pellets (not mag / fire rate).
  Clicking a filled weapon opens its base-vs-modified detail table; long-press / right-click reopens the
  selector. Equipment aggregates into a shared per-slot matrix. DPS lives in a header-button overlay.

  Engine (verified decompile): per attribute Flat -> pooled PercentAdd (×clamp(1+Σ,0.01,10)) -> each
  PercentMult (×(1+v)); crit flat ×2; resistance ((100-r)/100). Equipment mods = EntityAttributes;
  attachment/enchant mods = ItemAttributes (see labels.js / build-data.mjs).
*/
(function () {
  "use strict";

  const DATA = window.SULFUR_DATA || {};
  const ITEMS = DATA.items || [], WEAPONS = DATA.weapons || [], ENCH = DATA.enchantments || [];
  const ENEMIES = DATA.enemies || [], CALIBERS = DATA.calibers || [], PBASE = DATA.playerBase || {};
  const ENGINE = Object.assign({ critMult: 2, clampMin: 0.01, clampMax: 10 }, DATA.engine);
  const STORAGE_KEY = "sulfurbc.loadout", SCHEMA = 3;
  const WEAPON_SLOTS = 2, MAX_ENCH = 5;
  const ATTACH_SLOTS = ["muzzle", "sight", "action"];
  const ATTACH_LABEL = { muzzle: "Muzzle", sight: "Sight", action: "Action", caliber: "Caliber" };
  const EQUIP_ORDER = ["head", "torso", "footL", "footR", "gadget"];
  const SLOT_LABELS = { head: "Head", torso: "Torso", footL: "Left Foot", footR: "Right Foot", gadget: "Gadget" };
  const DMG_TO_RESIST = { Fire:"Fire",Frost:"Frost",Electric:"Electric",Poison:"Poison",Explosive:"Explosive",
    Holy:"Holy",Shadow:"Shadow",Earth:"Earth",Punish:"Punish",Bleed:"Bleed",Petrified:"Petrified",Charm:"Charm" };

  const itemByKey = new Map(ITEMS.map((i) => [i.key, i]));
  const weaponByKey = new Map(WEAPONS.map((w) => [w.key, w]));
  const enchById = new Map(ENCH.map((e) => [e.id, e]));
  const enemyById = new Map(ENEMIES.map((e) => [e.id, e]));
  const caliberById = new Map(CALIBERS.map((c) => [c.id, c]));

  // --- label standardization (labels.js) ---
  const LABELS = (window.SULFUR_LABELS && window.SULFUR_LABELS.attr) || {};
  const attrMeta = (t) => LABELS[t] || {};
  const spaced = (s) => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").trim();
  function label(tag) {
    const e = LABELS[tag]; if (e && e.name) return e.name;
    let m;
    if ((m = /^Resistance_(.+)$/.exec(tag))) return m[1] === "Armor" ? "Armor" : spaced(m[1]) + " Resistance";
    if ((m = /^ExtraDamage_(.+)$/.exec(tag))) return spaced(m[1]) + " Damage";
    if ((m = /^NegativeEffect_(.+)$/.exec(tag))) return spaced(m[1]);
    if ((m = /^(?:Stat|Status)_Wearing(.+)$/.exec(tag))) return "Wearing " + spaced(m[1]);
    return spaced(String(tag).replace(/^ItemStat_/, "").replace(/^Stat_/, "")
      .replace(/^ProjectileApply/, "Applies ").replace(/^ProjectileOnHit/, "On Hit: ").replace(/^Projectile/, "Projectile "));
  }

  const el = (id) => document.getElementById(id);
  const els = {
    weaponSlots: el("weapon-slots"), weaponDetail: el("weapon-detail"), equipMatrix: el("equip-matrix"),
    enemy: el("enemy-select"), counts: el("counts"), clear: el("clear-loadout"),
    overlay: el("overlay"), overlayList: el("overlay-list"), overlayTitle: el("overlay-title"),
    overlaySearch: el("overlay-search"), overlayClose: el("overlay-close"),
    overlayFilters: el("overlay-filters"), overlayDetail: el("overlay-detail"),
    dpsOverlay: el("dps-overlay"), dps: el("dps"), openDps: el("open-dps"), dpsClose: el("dps-close"),
  };

  // --- state ---
  function freshWeapon() { return { weapon: null, caliber: null, attachments: { muzzle: null, sight: null, action: null }, enchants: [] }; }
  function freshState() {
    return { schema: SCHEMA, equipment: { head: null, torso: null, footL: null, footR: null, gadget: null },
      weapons: Array.from({ length: WEAPON_SLOTS }, freshWeapon), enemy: null };
  }
  let state = load();
  function load() {
    try { const s = JSON.parse(localStorage.getItem(STORAGE_KEY)); if (s && s.schema === SCHEMA) return s; } catch { /**/ }
    return freshState();
  }
  const persist = () => localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  let focusedWeapon = null;   // index of weapon whose detail panel is open

  // --- engine ---
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const round = (v, d) => { const p = 10 ** d; return Math.round(v * p) / p; };
  const fmt = (n) => (Number.isFinite(n) ? (Math.abs(n) >= 100 ? Math.round(n) : round(n, 2)) : "—");
  function calcStat(base, mods) {
    let n = base, pa = 0, has = false;
    for (const m of mods) if (m.type === "Flat") n += m.value;
    for (const m of mods) if (m.type === "PercentAdd") { pa += m.value; has = true; }
    if (has) n *= clamp(1 + pa, ENGINE.clampMin, ENGINE.clampMax);
    for (const m of mods) if (m.type === "PercentMult") n *= (1 + m.value);
    return round(n, 4);
  }

  // gather all weapon mods (attachments + enchants) grouped by attribute
  function weaponMods(slot) {
    const by = new Map();
    const add = (m) => { if (!by.has(m.attr)) by.set(m.attr, []); by.get(m.attr).push(m); };
    for (const s of ATTACH_SLOTS) { const a = slot.attachments[s] && itemByKey.get(slot.attachments[s]); if (a) (a.attachMods || []).forEach(add); }
    for (const id of slot.enchants) { const e = enchById.get(id); if (e) e.mods.forEach(add); }
    return by;
  }
  const effCaliber = (w, slot) => caliberById.get(slot.caliber != null ? slot.caliber : w.caliberId) || null;

  // full stat model for a weapon slot: {stat rows base->val}, headline dps, affected extras
  function computeWeapon(slot) {
    const w = slot.weapon && weaponByKey.get(slot.weapon); if (!w) return null;
    const by = weaponMods(slot), get = (a) => by.get(a) || [];
    const cal = effCaliber(w, slot);
    const calId = cal ? cal.id : w.caliberId;
    const perPelletBase = (cal && w.damageMult) ? round(cal.baseDamage * w.weaponTypeMult * w.damageMult, 4) : w.baseDamage;
    const pellets = (cal && w.damageMult) ? cal.pellets : w.pellets;
    // per-caliber recoil (kick) + spread bases, falling back to the weapon's defaults
    const baseSpread = (w.spreadByCaliber && w.spreadByCaliber[calId] != null) ? w.spreadByCaliber[calId] : (w.baseSpread || 0);
    const baseKick = (w.kickByCaliber && w.kickByCaliber[calId] != null) ? w.kickByCaliber[calId] : (w.baseKickComp || 0);

    let perPellet = calcStat(perPelletBase, get("Damage"));
    const gBonus = get("Stat_GlobalDamageMultiplier").length ? calcStat(0, get("Stat_GlobalDamageMultiplier")) : 0;
    perPellet *= (1 + gBonus);
    const perShot = perPellet * pellets, perShotBase = perPelletBase * pellets;
    const rpm = w.rpm, sps = rpm > 0 ? rpm / 60 : 0;
    const critChance = clamp(calcStat(Number(PBASE.Stat_CritChance || 0), get("Stat_CritChance")), 0, 1);
    const expected = perShot * (1 + critChance * (ENGINE.critMult - 1));

    const enemy = state.enemy && enemyById.get(state.enemy);
    const channel = DMG_TO_RESIST[w.damageType] || null;
    const resist = enemy && channel ? Number(enemy.resist[channel] || 0) : 0;
    const mitig = Math.max(0, (100 - resist) / 100);
    const dpsEff = expected * mitig * sps, hp = enemy ? enemy.hp : 0;

    // stat table (base -> final)
    const stat = (k, base, val, o = {}) => Object.assign({ k, base, val }, o);
    const stats = [
      stat("Damage / shot", perShotBase, perShot, { better: "up" }),
      stat("Pellets", w.pellets, pellets, { better: "up", show: pellets > 1 || w.pellets > 1 }),
      stat("Fire rate", sps, sps, { unit: "/s", better: "up" }),
      stat("Magazine", w.ammoMax, w.ammoMax, { better: "up" }),
      stat("Reload", w.reloadTime, w.reloadTime, { unit: "s", better: "down" }),
      stat("Bullet speed", w.bulletSpeed, w.bulletSpeed, { better: "up" }),
      stat("Spread", baseSpread, calcStat(baseSpread, get("Spread")), { better: "down" }),
      stat("Recoil", baseKick, round(baseKick * calcStat(1, get("KickMultiplier")), 3), { better: "down" }),
      stat("Durability", w.maxDurability, calcStat(w.maxDurability, get("MaxDurability")), { better: "up", show: w.maxDurability > 0 }),
      stat("Crit (ADS)", 0, calcStat(0, get("CritChanceADS")), { better: "up", pct: true, show: by.has("CritChanceADS") }),
      stat("Full-auto", w.baseFullAuto ? 1 : 0, (w.baseFullAuto ? 1 : 0) + calcStat(0, get("FullAuto")), { better: "up", flag: true }),
    ].filter((r) => r.show !== false);

    const shown = new Set(["Damage", "RPM", "Stat_GlobalDamageMultiplier", "Stat_CritChance", "KickMultiplier", "Spread", "MaxDurability", "CritChanceADS", "FullAuto"]);
    const other = [...by.keys()].filter((a) => !shown.has(a)).map((a) => ({ attr: a, val: calcStat(attrMeta(a).__base || 0, by.get(a)) }));

    return { w, cal, enemy, resist, channel, mitig, perShot, sps, critChance, dpsRaw: perShot * sps, dpsEff,
      ttk: dpsEff > 0 && hp > 0 ? hp / dpsEff : null, stats, other };
  }

  // --- rendering helpers ---
  const changed = (r) => Math.abs(r.val - r.base) > 1e-6;
  function statVal(r) {
    if (r.flag) return r.val > 0 ? "ON" : "—";
    if (r.pct) return (r.val > 0 ? "+" : "") + round(r.val * 100, 1) + "%";
    return fmt(r.val) + (r.unit || "");
  }
  function statCls(r) {
    if (r.flag) return r.val > 0 ? "pos" : "";
    if (!changed(r)) return "";
    return ((r.val > r.base) === (r.better === "up")) ? "pos" : "neg";
  }

  // =====================================================================
  //  Paperdoll
  // =====================================================================
  function paintSlot(node, item, lbl) {
    node.classList.toggle("filled", !!item);
    node.innerHTML = (item && item.icon ? `<img class="slot-icon" src="${item.icon}" alt="">` : "") +
      `<span class="slot-label">${item ? item.name : lbl}</span>`;
    node.title = item ? item.name + " — click to change" : "Select " + lbl;
  }
  function renderPaperdoll() {
    for (const [slot, lbl] of Object.entries(SLOT_LABELS)) {
      const node = document.querySelector(`.slot[data-slot="${slot}"]`);
      if (node) paintSlot(node, state.equipment[slot] && itemByKey.get(state.equipment[slot]), lbl);
    }
  }

  // =====================================================================
  //  Weapon cards
  // =====================================================================
  function renderWeapons() {
    els.weaponSlots.innerHTML = "";
    state.weapons.forEach((slot, wi) => {
      const w = slot.weapon && weaponByKey.get(slot.weapon);
      const box = document.createElement("div");
      box.className = "weapon-slot" + (focusedWeapon === wi ? " focused" : "");
      const cal = w ? effCaliber(w, slot) : null;
      const sub = w ? `${w.weaponType} · ${w.damageType}${cal ? " · " + cal.label : ""}` : "Tap to choose a weapon";
      const wIcon = w && w.icon ? `<img class="slot-icon" src="${w.icon}" alt="">` : "";

      // 4 mod slots: muzzle / sight / action / caliber (always shown; invalid = disabled+red)
      const modSlots = ATTACH_SLOTS.map((s) => {
        const ok = w && (w.attachSlots[s] || []).length;
        const it = slot.attachments[s] && itemByKey.get(slot.attachments[s]);
        const cls = "acell " + (it ? "filled" : ok ? "add" : "invalid");
        const inner = it && it.icon ? `<img src="${it.icon}" alt="">` : "";
        return `<button class="${cls}" data-act="attach" data-wi="${wi}" data-slot="${s}" type="button" ${ok ? "" : "disabled"} title="${it ? it.name : ok ? "Add " + ATTACH_LABEL[s] : ATTACH_LABEL[s] + " — not supported"}">${inner}<span class="acell-label">${ATTACH_LABEL[s]}</span></button>`;
      }).join("");
      const calOk = w && w.canModCaliber;
      const calCls = "acell caliber " + (slot.caliber != null ? "filled" : calOk ? "add" : "invalid");
      const calSlot = `<button class="${calCls}" data-act="caliber" data-wi="${wi}" type="button" ${calOk ? "" : "disabled"} title="${calOk ? "Change caliber (Chamber Chisel)" : "Caliber locked (" + (cal ? cal.label : "—") + ")"}"><span class="cal-txt">${cal ? cal.label : "—"}</span><span class="acell-label">${ATTACH_LABEL.caliber}</span></button>`;

      const scrolls = slot.enchants.filter((id) => (enchById.get(id) || {}).isElemental).length;
      const enchCells = Array.from({ length: MAX_ENCH }, (_, i) => {
        const id = slot.enchants[i], e = id && enchById.get(id);
        if (e) {
          const inner = e.icon ? `<img src="${e.icon}" alt="">` : `<span class="ench-glyph">${e.isElemental ? "✦" : "◈"}</span>`;
          return `<button class="ecell filled ${e.isElemental ? "scroll" : "oil"}" data-act="unench" data-wi="${wi}" data-ei="${i}" type="button" title="${e.name} — remove">${inner}</button>`;
        }
        return `<button class="ecell add" data-act="ench" data-wi="${wi}" type="button" title="Add oil / scroll">+</button>`;
      }).join("");

      const comp = w ? computeWeapon(slot) : null;
      const liveHtml = comp ? comp.stats.map((r) => `<div class="lv"><span class="lk">${r.k}</span><span class="lvv ${statCls(r)}">${statVal(r)}</span></div>`).join("") : "";

      box.innerHTML = `
        <div class="ws-head" data-act="weapon-info" data-wi="${wi}">
          <div class="ws-name">${w ? w.name : "Weapon slot " + (wi + 1)}</div>
          <div class="ws-sub">${sub}</div>
        </div>
        <button class="ws-weapon${w ? " filled" : ""}" data-act="weapon" data-wi="${wi}" type="button" title="${w ? "Long-press / right-click to change weapon" : "Select a weapon"}">${wIcon}<span class="ws-hint">${w ? "" : "＋ weapon"}</span></button>
        ${w ? `
        <div class="ws-mods">
          <div class="mg-label">Mods</div>
          <div class="acells">${modSlots}${calSlot}</div>
        </div>
        <div class="ws-ench">
          <div class="mg-label">Enchantments <span class="mg-note">${slot.enchants.length}/${MAX_ENCH}${scrolls ? " · 1 scroll" : ""}</span></div>
          <div class="ecells">${enchCells}</div>
        </div>
        <div class="ws-live">${liveHtml}</div>` : ""}`;
      els.weaponSlots.appendChild(box);
    });
    renderWeaponDetail();
  }

  // weapon detail: base vs modified table (shown when a weapon is focused)
  function renderWeaponDetail() {
    if (focusedWeapon == null || !state.weapons[focusedWeapon] || !state.weapons[focusedWeapon].weapon) {
      els.weaponDetail.hidden = true; return;
    }
    const slot = state.weapons[focusedWeapon], comp = computeWeapon(slot); if (!comp) { els.weaponDetail.hidden = true; return; }
    const rows = comp.stats.map((r) => {
      const delta = changed(r) && !r.flag ? `<span class="wd-delta ${statCls(r)}">${r.val > r.base ? "▲" : "▼"}</span>` : "";
      return `<tr><td>${r.k}</td><td class="wd-base">${r.flag ? (r.base > 0 ? "ON" : "—") : fmt(r.base) + (r.unit || "")}</td><td class="wd-mod ${statCls(r)}">${statVal(r)} ${delta}</td></tr>`;
    }).join("");
    const others = comp.other.length ? `<div class="wd-other">${comp.other.map((o) => `${label(o.attr)}: ${fmt(o.val)}`).join(" · ")}</div>` : "";
    els.weaponDetail.hidden = false;
    els.weaponDetail.innerHTML = `<h2>${comp.w.name} <span class="muted small">— base vs modified</span></h2>
      <table class="wd-table"><thead><tr><th>Stat</th><th>Base</th><th>Modified</th></tr></thead><tbody>${rows}</tbody></table>${others}`;
  }

  // =====================================================================
  //  Equipment matrix (column per slot)
  // =====================================================================
  function renderEquipMatrix() {
    const cols = EQUIP_ORDER.map((s) => ({ slot: s, item: state.equipment[s] && itemByKey.get(state.equipment[s]) }));
    // union of attributes across equipped gear
    const attrs = [];
    const seen = new Set();
    for (const c of cols) if (c.item) for (const m of c.item.mods || []) if (!seen.has(m.attr)) { seen.add(m.attr); attrs.push(m.attr); }
    attrs.sort((a, b) => (attrMeta(a).cat || "z").localeCompare(attrMeta(b).cat || "z") || label(a).localeCompare(label(b)));

    const modOf = (item, attr) => {
      if (!item) return "";
      const ms = (item.mods || []).filter((m) => m.attr === attr); if (!ms.length) return "";
      return ms.map((m) => m.type === "Flat" ? (m.value > 0 ? "+" : "") + round(m.value, 3)
        : m.type === "PercentAdd" ? (m.value > 0 ? "+" : "") + round(m.value * 100, 1) + "%" : "×" + round(1 + m.value, 3)).join(" ");
    };
    const head = `<tr><th>Stat</th>${cols.map((c) => `<th class="em-col ${c.item ? "on" : ""}">${SLOT_LABELS[c.slot].replace(" ", "<br>")}</th>`).join("")}</tr>`;
    const body = attrs.length ? attrs.map((a) => `<tr><td class="em-attr">${label(a)}</td>${cols.map((c) => {
      const v = modOf(c.item, a); const good = attrMeta(a).lowerBetter ? /-/.test(v) : /\+|×[1-9]/.test(v) && !/×0/.test(v);
      return `<td class="${v ? (good ? "pos" : /-/.test(v) ? "neg" : "") : "em-empty"}">${v || "·"}</td>`;
    }).join("")}</tr>`).join("") : `<tr><td colspan="${cols.length + 1}" class="muted small">Equip armour to compare stat contributions.</td></tr>`;
    els.equipMatrix.innerHTML = `<table class="em-table"><thead>${head}</thead><tbody>${body}</tbody></table>`;
  }

  // =====================================================================
  //  DPS overlay
  // =====================================================================
  function renderDps() {
    let html = "";
    state.weapons.forEach((slot) => {
      const r = computeWeapon(slot); if (!r) return;
      html += `<div class="dps-w">${r.w.name}${r.cal ? " · " + r.cal.label : ""}</div>`;
      html += `<div class="row big"><span class="k">DPS${r.enemy ? " vs " + r.enemy.name : " (raw)"}</span><span class="v">${fmt(r.enemy ? r.dpsEff : r.dpsRaw)}</span></div>`;
      html += `<div class="row"><span class="k">Per shot${r.critChance > 0 ? " · crit " + Math.round(r.critChance * 100) + "%" : ""}</span><span class="v">${fmt(r.perShot)}</span></div>`;
      if (r.enemy) {
        html += `<div class="row"><span class="k">${r.channel ? r.channel + " " + r.resist + "%" : "unresisted"}</span><span class="v">×${round(r.mitig, 2)}</span></div>`;
        html += `<div class="row ttk"><span class="k">Time to kill</span><span class="v">${r.ttk != null ? round(r.ttk, 2) + " s" : "—"}</span></div>`;
      }
    });
    els.dps.innerHTML = html || `<div class="muted small">Equip a weapon to simulate damage.</div>`;
  }

  function renderAll() { renderPaperdoll(); renderWeapons(); renderEquipMatrix(); renderDps(); persist(); }

  // =====================================================================
  //  Selector overlay (static size, top-anchored, info panel)
  // =====================================================================
  let ctx = null, activeFilter = null;
  function openSelector(next) {
    ctx = next; activeFilter = null;
    els.overlayTitle.textContent = next.title;
    els.overlaySearch.value = "";
    els.overlayDetail.innerHTML = `<div class="od-empty muted small">Tap an option to see its stats, then Equip.</div>`;
    if (next.filters && next.filters.length) {
      els.overlayFilters.hidden = false;
      els.overlayFilters.innerHTML = [`<button class="fchip on" data-f="">All</button>`]
        .concat(next.filters.map((f) => `<button class="fchip" data-f="${f}">${f}</button>`)).join("");
    } else { els.overlayFilters.hidden = true; els.overlayFilters.innerHTML = ""; }
    renderOptions();
    els.overlay.hidden = false;
    els.overlaySearch.focus({ preventScroll: true });
  }
  const closeSelector = () => { els.overlay.hidden = true; ctx = null; };

  function renderOptions() {
    if (!ctx) return;
    const q = (els.overlaySearch.value || "").toLowerCase();
    const keyOf = ctx.filterKey || ((o) => o.filter);
    const list = ctx.opts.filter((o) => (!q || o.name.toLowerCase().includes(q)) && (!activeFilter || keyOf(o) === activeFilter));
    let html = ctx.allowClear ? `<button class="opt clear-opt" data-clear="1">✕ Clear slot</button>` : "";
    html += list.map((o) => `<button class="opt${o.disabled ? " disabled" : ""}" data-i="${o._i}" ${o.disabled ? "disabled" : ""}>${o.icon ? `<img src="${o.icon}" alt="">` : `<span class="opt-noimg"></span>`}<span><span class="opt-name">${o.name}</span>${o.sub ? `<span class="opt-sub"> ${o.sub}</span>` : ""}</span></button>`).join("");
    els.overlayList.innerHTML = html || `<div class="muted small">No matches.</div>`;
  }
  function showDetail(o) {
    els.overlayDetail._item = o;
    const lines = ctx.statLines ? ctx.statLines(o) : [];
    els.overlayDetail.innerHTML =
      `<div class="od-head">${o.icon ? `<img src="${o.icon}" alt="">` : ""}<div><div class="od-name">${o.name}</div>${o.sub ? `<div class="od-sub">${o.sub}</div>` : ""}</div></div>` +
      (lines.length ? `<div class="od-stats">${lines.map((l) => `<div class="od-stat"><span>${l.k}</span><span class="${l.cls || ""}">${l.v}</span></div>`).join("")}</div>` : `<div class="muted small">No stat effects.</div>`) +
      `<button class="od-equip" data-equip="1" type="button" ${o.disabled ? "disabled" : ""}>${o.disabled ? "Unavailable" : "Equip"}</button>`;
  }
  const modLines = (mods) => (mods || []).map((m) => {
    const good = attrMeta(m.attr).lowerBetter ? m.value < 0 : m.value > 0;
    return { k: label(m.attr),
      v: m.type === "Flat" ? (m.value > 0 ? "+" : "") + round(m.value, 3) : m.type === "PercentAdd" ? (m.value > 0 ? "+" : "") + round(m.value * 100, 1) + "%" : "×" + round(1 + m.value, 3),
      cls: m.value === 0 ? "" : (good ? "pos" : "neg") };
  });
  const weaponLines = (w) => {
    const cal = caliberById.get(w.caliberId);
    return [
      { k: "Damage", v: fmt(w.baseDamage) + (w.pellets > 1 ? " ×" + w.pellets + " pellets" : "") },
      { k: "Fire rate", v: fmt(w.rpm / 60) + "/s (" + fmt(w.rpm) + " rpm)" },
      { k: "Magazine", v: w.ammoMax + (w.ammoPerShot > 1 ? " (" + w.ammoPerShot + "/shot)" : "") },
      { k: "Reload", v: fmt(w.reloadTime) + "s" }, { k: "Bullet speed", v: fmt(w.bulletSpeed) },
      { k: "Spread", v: fmt(w.baseSpread || 0) }, { k: "Durability", v: fmt(w.maxDurability) },
      { k: "Caliber", v: cal ? cal.label : w.caliber }, { k: "Weight", v: w.weight },
      { k: "Type", v: w.weaponType + " · " + w.damageType }, { k: "Quality", v: w.quality },
    ];
  };

  const indexed = (opts) => { opts.forEach((o, i) => (o._i = i)); return opts; };
  const itemOpts = (slot) => ITEMS.filter((i) => i.slot === slot).map((i) => ({ ref: i, key: i.key, name: i.name, sub: `${i.quality || ""}${i.size ? " · " + i.size.w + "×" + i.size.h : ""}`, icon: i.icon }));
  const attachOpts = (keys) => keys.map((k) => itemByKey.get(k)).filter(Boolean)
    .map((i) => ({ ref: i, key: i.key, name: i.name, sub: i.subtype ? i.subtype + (i.mag ? " · " + i.mag + "x" : "") : (i.quality || ""), icon: i.icon, filter: i.subtype || null }))
    .sort((a, b) => (a.filter || "").localeCompare(b.filter || "") || (a.ref.mag || 0) - (b.ref.mag || 0) || a.name.localeCompare(b.name));
  const weaponOpts = () => WEAPONS.map((w) => ({ ref: w, key: w.key, name: w.name, sub: `${w.weaponType} · ${fmt(w.baseDamage)}dmg`, icon: w.icon, filter: w.weaponType }));
  const enchOpts = (elemental) => ENCH.filter((e) => !!e.isElemental === elemental).map((e) => ({ ref: e, key: e.id, name: e.name, sub: e.group, icon: e.icon, filter: e.group }));
  const caliberOpts = () => CALIBERS.filter((c) => c.hasChisel).map((c) => ({ ref: c, calId: c.id, name: c.label, sub: `${c.baseDamage} base dmg${c.pellets > 1 ? " · " + c.pellets + " pellets" : ""}`, icon: null }));

  // =====================================================================
  //  Slot -> selector wiring
  // =====================================================================
  function selectEquip(slot, lbl) {
    openSelector({ title: "Select " + lbl, allowClear: true,
      opts: indexed(itemOpts(slot === "footL" || slot === "footR" ? "feet" : slot)),
      statLines: (o) => modLines(o.ref.mods),
      onPick: (o) => { state.equipment[slot] = o.key; }, onClear: () => { state.equipment[slot] = null; } });
  }
  document.querySelectorAll(".slot[data-slot]").forEach((node) =>
    node.addEventListener("click", () => selectEquip(node.dataset.slot, SLOT_LABELS[node.dataset.slot])));

  function openWeaponSelector(wi) {
    openSelector({ title: "Select weapon", allowClear: true, opts: indexed(weaponOpts()),
      filters: [...new Set(WEAPONS.map((w) => w.weaponType))].sort(), statLines: (o) => weaponLines(o.ref),
      onPick: (o) => { const e = state.weapons[wi].enchants; state.weapons[wi] = freshWeapon(); state.weapons[wi].weapon = o.key; state.weapons[wi].enchants = e; },
      onClear: () => { const e = state.weapons[wi].enchants; state.weapons[wi] = freshWeapon(); state.weapons[wi].enchants = e; if (focusedWeapon === wi) focusedWeapon = null; } });
  }

  // long-press / right-click a FILLED weapon shape reopens the selector; a tap opens its info panel
  let lpTimer = null, lpFired = false;
  els.weaponSlots.addEventListener("pointerdown", (ev) => {
    const t = ev.target.closest('[data-act="weapon"]'); if (!t) return;
    const wi = Number(t.dataset.wi); lpFired = false;
    if (!state.weapons[wi].weapon) return;                      // empty slot: no long-press
    lpTimer = setTimeout(() => { lpFired = true; openWeaponSelector(wi); }, 500);
  });
  const cancelLp = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } };
  ["pointerup", "pointerleave", "pointercancel", "pointermove"].forEach((e) => els.weaponSlots.addEventListener(e, cancelLp));
  els.weaponSlots.addEventListener("contextmenu", (ev) => {
    const t = ev.target.closest('[data-act="weapon"]'); if (!t) return;
    ev.preventDefault(); const wi = Number(t.dataset.wi);
    if (state.weapons[wi].weapon) openWeaponSelector(wi);
  });

  els.weaponSlots.addEventListener("click", (ev) => {
    const t = ev.target.closest("[data-act]"); if (!t) return;
    const wi = Number(t.dataset.wi), act = t.dataset.act, slot = state.weapons[wi];
    if (act === "weapon" || act === "weapon-info") {
      if (lpFired) { lpFired = false; return; }                 // long-press already opened the selector
      cancelLp();
      if (!slot.weapon) { openWeaponSelector(wi); return; }      // empty -> pick a weapon
      focusedWeapon = focusedWeapon === wi ? null : wi; renderWeapons();  // filled -> toggle info panel
      if (focusedWeapon === wi) els.weaponDetail.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } else if (act === "attach") {
      const s = t.dataset.slot; const w = weaponByKey.get(slot.weapon); if (!w || !(w.attachSlots[s] || []).length) return;
      if (itemByKey.has(slot.attachments[s])) { slot.attachments[s] = null; renderAll(); return; }
      const opts = indexed(attachOpts(w.attachSlots[s]));
      const subs = [...new Set(opts.map((o) => o.filter).filter(Boolean))];
      openSelector({ title: ATTACH_LABEL[s] + " attachment", opts, filters: subs.length > 1 ? subs : null,
        statLines: (o) => modLines(o.ref.attachMods), onPick: (o) => { slot.attachments[s] = o.key; } });
    } else if (act === "caliber") {
      const w = weaponByKey.get(slot.weapon); if (!w || !w.canModCaliber) return;
      openSelector({ title: "Chamber Chisel — caliber", allowClear: slot.caliber != null,
        opts: indexed(caliberOpts()),
        statLines: (o) => { const c = o.ref; return [{ k: "Base damage", v: fmt(c.baseDamage) }, { k: "Pellets", v: c.pellets }, { k: "Knockback", v: fmt(c.knockback) }]; },
        onPick: (o) => { slot.caliber = o.calId; }, onClear: () => { slot.caliber = null; } });
    } else if (act === "ench") {
      if (slot.enchants.length >= MAX_ENCH) return;
      const hasScroll = slot.enchants.some((id) => (enchById.get(id) || {}).isElemental);
      const oils = enchOpts(false), scrolls = enchOpts(true).map((o) => hasScroll ? Object.assign(o, { disabled: true, sub: o.sub + " · 1 scroll max" }) : o);
      openSelector({ title: "Add oil / scroll", opts: indexed([...oils, ...scrolls]),
        filters: ["Oils", "Scrolls"], filterKey: (o) => (o.ref.isElemental ? "Scrolls" : "Oils"),
        statLines: (o) => modLines(o.ref.mods),
        onPick: (o) => { if (o.disabled) return; slot.enchants.push(o.key); } });
    } else if (act === "unench") {
      slot.enchants.splice(Number(t.dataset.ei), 1); renderAll();
    }
  });

  // overlay interactions
  els.overlayFilters.addEventListener("click", (ev) => {
    const t = ev.target.closest("[data-f]"); if (!t) return;
    activeFilter = t.dataset.f || null;
    els.overlayFilters.querySelectorAll(".fchip").forEach((c) => c.classList.toggle("on", c === t));
    renderOptions();                                            // only the LIST changes, overlay size is fixed
  });
  els.overlayList.addEventListener("click", (ev) => {
    const t = ev.target.closest("button"); if (!t || !ctx) return;
    if (t.dataset.clear) { ctx.onClear && ctx.onClear(); closeSelector(); renderAll(); return; }
    if (t.dataset.i == null || t.disabled) return;
    showDetail(ctx.opts[Number(t.dataset.i)]);                  // updates ONLY the info panel
  });
  els.overlayDetail.addEventListener("click", (ev) => {
    if (!ev.target.closest("[data-equip]") || !ctx) return;
    const o = els.overlayDetail._item; if (!o || o.disabled) return;
    ctx.onPick(o); closeSelector(); renderAll();
  });
  els.overlaySearch.addEventListener("input", renderOptions);
  els.overlayClose.addEventListener("click", closeSelector);
  els.overlay.addEventListener("click", (ev) => { if (ev.target === els.overlay) closeSelector(); });

  // DPS overlay
  els.openDps.addEventListener("click", () => { renderDps(); els.dpsOverlay.hidden = false; });
  els.dpsClose.addEventListener("click", () => { els.dpsOverlay.hidden = true; });
  els.dpsOverlay.addEventListener("click", (ev) => { if (ev.target === els.dpsOverlay) els.dpsOverlay.hidden = true; });
  els.enemy.addEventListener("change", () => { state.enemy = els.enemy.value || null; persist(); renderWeapons(); renderDps(); });

  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    if (!els.overlay.hidden) closeSelector(); else if (!els.dpsOverlay.hidden) els.dpsOverlay.hidden = true;
  });
  els.clear.addEventListener("click", () => { state = freshState(); focusedWeapon = null; els.enemy.value = ""; renderAll(); });

  // --- init ---
  els.enemy.innerHTML = `<option value="">— no target —</option>` +
    [...ENEMIES].sort((a, b) => a.name.localeCompare(b.name)).map((e) => `<option value="${e.id}">${e.name} (${fmt(e.hp)} HP)</option>`).join("");
  els.enemy.value = state.enemy || "";
  els.counts.textContent = `${WEAPONS.length} weapons · ${ITEMS.length} gear · ${ENCH.length} enchantments · ${CALIBERS.length} calibers · ${ENEMIES.length} enemies`;
  renderAll();
})();
