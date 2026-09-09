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
  const STORAGE_KEY = "sulfurbc.loadout", SCHEMA = 4;
  const WEAPON_SLOTS = 2, MAX_ENCH = 5;
  const ATTACH_SLOTS = ["muzzle", "sight", "action"];
  const ATTACH_LABEL = { muzzle: "Muzzle", sight: "Sight", action: "Action", caliber: "Caliber" };
  // ranged weapon groups (order shown in the selector); Melee/Throwable excluded from ranged slots
  const WEAPON_GROUP_ORDER = ["Pistol", "Revolver", "Shotgun", "SMG", "AssaultRifle", "LMG", "Rifle", "Sniper"];
  const WEAPON_TYPE_LABEL = { AssaultRifle: "AR" };
  const RANGED_TYPES = new Set(WEAPON_GROUP_ORDER);
  // oil functional buckets (16 raw oil groups -> ~6 sensible categories for the selector)
  const OIL_BUCKET = {
    DamageFlat: "Damage", DamagePercentage: "Damage",
    RPM: "Fire Rate", Reload: "Fire Rate", Recycle: "Fire Rate",
    Spread: "Accuracy", Recoil: "Accuracy", BulletSpeed: "Accuracy",
    Multishot: "Projectile", Penetration: "Projectile", Bounce: "Projectile", Size: "Projectile",
    CritChance: "Crit", Durability: "Utility", Knockback: "Utility", Weight: "Utility",
  };
  const OIL_BUCKET_ORDER = ["Damage", "Fire Rate", "Accuracy", "Projectile", "Crit", "Utility", "Other", "Scroll"];
  const PASSIVE_SLOTS = ["passive0", "passive1", "passive2", "passive3"];
  const EQUIP_ORDER = ["head", "torso", "footL", "footR", ...PASSIVE_SLOTS];
  const SLOT_LABELS = { head: "Head", torso: "Torso", footL: "Left Foot", footR: "Right Foot",
    passive0: "Passive 1", passive1: "Passive 2", passive2: "Passive 3", passive3: "Passive 4" };
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

  // --- plain-language tooltips (glossary.js), keyed by derived display label or attribute tag ---
  const GLOSS = window.SULFUR_GLOSSARY || { attr: {}, derived: {} };
  const tip = (key) => GLOSS.derived[key] || GLOSS.attr[key] || "";
  const escAttr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const tipAttr = (key) => { const d = tip(key); return d ? ` title="${escAttr(d)}" data-tip="${escAttr(d)}"` : ""; };
  const tipCls = (key) => (tip(key) ? " tip-label" : "");

  const el = (id) => document.getElementById(id);
  const els = {
    weaponSlots: el("weapon-slots"), meleeSlot: el("melee-slot"), arsenal: document.querySelector(".arsenal"),
    weaponDetail: el("weapon-detail"), wdOverlay: el("wd-overlay"), wdTitle: el("wd-title"), wdClose: el("wd-close"),
    equipMatrix: el("equip-matrix"),
    enemy: el("enemy-select"), counts: el("counts"), clear: el("clear-loadout"),
    overlay: el("overlay"), overlayList: el("overlay-list"), overlayTitle: el("overlay-title"),
    overlaySearch: el("overlay-search"), overlayClose: el("overlay-close"),
    overlayFilters: el("overlay-filters"), overlayDetail: el("overlay-detail"),
    dpsOverlay: el("dps-overlay"), dps: el("dps"), openDps: el("open-dps"), dpsClose: el("dps-close"),
    targetPanel: el("target-panel"),
  };

  // --- state ---
  function freshWeapon() { return { weapon: null, caliber: null, attachments: { muzzle: null, sight: null, action: null }, enchants: [] }; }
  function freshState() {
    return { schema: SCHEMA, equipment: { head: null, torso: null, footL: null, footR: null,
        passive0: null, passive1: null, passive2: null, passive3: null },
      weapons: Array.from({ length: WEAPON_SLOTS }, freshWeapon), melee: freshWeapon(), enemy: null, aimPart: null };
  }
  let state = load();
  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (s && s.schema === SCHEMA) {
        if (!s.melee) s.melee = freshWeapon();                  // backfill melee slot for pre-melee saves
        if (!Array.isArray(s.weapons)) s.weapons = Array.from({ length: WEAPON_SLOTS }, freshWeapon);
        return s;
      }
    } catch { /**/ }
    return freshState();
  }
  const persist = () => localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  let focusedWeapon = null;   // loc ("0" | "1" | "melee") of the weapon whose detail panel is open
  const slotFromLoc = (loc) => (loc === "melee" ? state.melee : state.weapons[Number(loc)]);

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

  // per-enchant durability cost per shot: +1 by default, unless the enchant explicitly states
  // no cost (EnchantmentDurabilityCost=0) or a different cost (EnchantmentDurabilityCost / DurabilityLoss). See WIKI_CONTEXT.
  function enchDurabilityCost(e) {
    let explicit = null;
    for (const m of e.mods) {
      if (m.attr === "EnchantmentDurabilityCost") explicit = m.value;
      else if (m.attr === "DurabilityLoss" && explicit == null) explicit = m.value;
    }
    return explicit != null ? explicit : 1;
  }

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

    // durability: final pool, per-shot cost (1 + enchant costs), and shots before it breaks
    const finalMaxDur = calcStat(w.maxDurability, get("MaxDurability"));
    const durPerShot = 1 + slot.enchants.reduce((s, id) => { const e = enchById.get(id); return e ? s + enchDurabilityCost(e) : s; }, 0);
    const shotsToBreak = durPerShot > 0 && finalMaxDur > 0 ? Math.floor(finalMaxDur / durPerShot) : null;

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
      stat("Durability", w.maxDurability, finalMaxDur, { better: "up", show: w.maxDurability > 0 }),
      stat("Durability / shot", 1, durPerShot, { better: "down", show: w.maxDurability > 0 }),
      stat("Shots to break", w.maxDurability, shotsToBreak, { better: "up", show: w.maxDurability > 0 && shotsToBreak != null }),
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
      `<span class="slot-label">${item ? item.name : lbl}</span>` +
      (item && item.set ? `<span class="slot-set">${item.set}</span>` : "");
    node.title = item ? `${item.name}${item.set ? ` · ${item.set} set` : ""} — click to change` : "Select " + lbl;
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
  function weaponCard(slot, loc, isMelee) {
    const w = slot.weapon && weaponByKey.get(slot.weapon);
    const box = document.createElement("div");
    box.className = "weapon-slot" + (isMelee ? " melee" : "");
    const cal = (w && !isMelee) ? effCaliber(w, slot) : null;
    const sub = w ? `${w.weaponType} · ${w.damageType}${cal ? " · " + cal.label : ""}`
      : (isMelee ? "Tap to choose a melee weapon" : "Tap to choose a weapon");
    const wIcon = w && w.icon ? `<img class="slot-icon" src="${w.icon}" alt="">` : "";

    // mods (ranged only): muzzle / sight / action / caliber — always shown; invalid = disabled+red
    const clearX = (kind, extra) => `<span class="cell-x" data-act="clear" data-kind="${kind}" data-loc="${loc}"${extra || ""} title="Clear">✕</span>`;
    let modsHtml = "";
    if (w && !isMelee) {
      const modSlots = ATTACH_SLOTS.map((s) => {
        const ok = (w.attachSlots[s] || []).length;
        const it = slot.attachments[s] && itemByKey.get(slot.attachments[s]);
        const cls = "acell " + (it ? "filled" : ok ? "add" : "invalid");
        const inner = it && it.icon ? `<img src="${it.icon}" alt="">` : "";
        const x = it ? clearX("attach", ` data-slot="${s}"`) : "";
        return `<button class="${cls}" data-act="attach" data-loc="${loc}" data-slot="${s}" type="button" ${ok ? "" : "disabled"} title="${it ? it.name : ok ? "Add " + ATTACH_LABEL[s] : ATTACH_LABEL[s] + " — not supported"}">${inner}<span class="acell-label">${ATTACH_LABEL[s]}</span>${x}</button>`;
      }).join("");
      // caliber always exists — show its ammo icon (no "+"); interactive only if the weapon can be re-chambered
      const calOk = w.canModCaliber, modded = slot.caliber != null;
      const calImg = cal && cal.icon ? `<img src="${cal.icon}" alt="">` : `<span class="cal-txt">${cal ? cal.label : "—"}</span>`;
      const calCls = "acell caliber " + (calOk ? (modded ? "filled" : "base") : "locked");
      const calSlot = `<button class="${calCls}" data-act="caliber" data-loc="${loc}" type="button" ${calOk ? "" : "disabled"} title="${calOk ? "Change caliber (" + (cal ? cal.label : "") + ")" : "Caliber locked (" + (cal ? cal.label : "—") + ")"}">${calImg}<span class="acell-label">${cal ? cal.label : "Caliber"}</span>${modded ? clearX("caliber") : ""}</button>`;
      modsHtml = `<div class="ws-mods"><div class="mg-label">Mods</div><div class="acells">${modSlots}${calSlot}</div></div>`;
    }

    // enchants (ranged only — melee weapons cannot be enchanted)
    let enchHtml = "";
    if (w && !isMelee) {
      const scrolls = slot.enchants.filter((id) => (enchById.get(id) || {}).isElemental).length;
      const enchCells = Array.from({ length: MAX_ENCH }, (_, i) => {
        const id = slot.enchants[i], e = id && enchById.get(id);
        if (e) {
          const inner = e.icon ? `<img src="${e.icon}" alt="">` : `<span class="ench-glyph">${e.isElemental ? "✦" : "◈"}</span>`;
          return `<button class="ecell filled ${e.isElemental ? "scroll" : "oil"}" data-act="clear" data-kind="ench" data-loc="${loc}" data-ei="${i}" type="button" title="${e.name} — remove">${inner}<span class="cell-x">✕</span></button>`;
        }
        return `<button class="ecell add" data-act="ench" data-loc="${loc}" type="button" title="Add oil / scroll">+</button>`;
      }).join("");
      enchHtml = `<div class="ws-ench"><div class="mg-label">Enchantments <span class="mg-note">${slot.enchants.length}/${MAX_ENCH}${scrolls ? " · 1 scroll" : ""}</span></div><div class="ecells">${enchCells}</div></div>`;
    }

    const comp = w ? computeWeapon(slot) : null;
    const liveHtml = comp ? comp.stats.map((r) => `<div class="lv"><span class="lk${tipCls(r.k)}"${tipAttr(r.k)}>${r.k}</span><span class="lvv ${statCls(r)}">${statVal(r)}</span></div>`).join("") : "";
    const emptyLbl = isMelee ? "Melee slot" : "Weapon slot " + (Number(loc) + 1);
    box.innerHTML = `
      <div class="ws-head" data-act="weapon-info" data-loc="${loc}">
        <div class="ws-name">${w ? w.name : emptyLbl}</div>
        <div class="ws-sub">${sub}</div>
      </div>
      <button class="ws-weapon${w ? " filled" : ""}" data-act="weapon" data-loc="${loc}" type="button" title="${w ? "Long-press / right-click to change" : "Select a weapon"}">${wIcon}<span class="ws-hint">${w ? "" : (isMelee ? "＋ melee" : "＋ weapon")}</span>${w ? clearX("weapon") : ""}</button>
      ${w ? modsHtml + enchHtml + `<div class="ws-live">${liveHtml}</div>` : ""}`;
    return box;
  }

  function renderWeapons() {
    els.weaponSlots.innerHTML = "";
    state.weapons.forEach((slot, wi) => els.weaponSlots.appendChild(weaponCard(slot, String(wi), false)));
    els.meleeSlot.innerHTML = "";
    els.meleeSlot.appendChild(weaponCard(state.melee, "melee", true));
    renderWeaponDetail();
  }

  // weapon detail: base-vs-modified table, shown in the half-page overlay
  function renderWeaponDetail() {
    const slot = focusedWeapon != null ? slotFromLoc(focusedWeapon) : null;
    const comp = slot && slot.weapon ? computeWeapon(slot) : null;
    if (!comp) { els.wdOverlay.hidden = true; return; }
    const rows = comp.stats.map((r) => {
      const delta = changed(r) && !r.flag ? `<span class="wd-delta ${statCls(r)}">${r.val > r.base ? "▲" : "▼"}</span>` : "";
      return `<tr><td class="${tipCls(r.k).trim()}"${tipAttr(r.k)}>${r.k}</td><td class="wd-base">${r.flag ? (r.base > 0 ? "ON" : "—") : fmt(r.base) + (r.unit || "")}</td><td class="wd-mod ${statCls(r)}">${statVal(r)} ${delta}</td></tr>`;
    }).join("");
    const others = comp.other.length ? `<div class="wd-other">${comp.other.map((o) => `${label(o.attr)}: ${fmt(o.val)}`).join(" · ")}</div>` : "";
    els.wdTitle.textContent = comp.w.name + (comp.cal ? " · " + comp.cal.label : "");
    els.weaponDetail.innerHTML = `<div class="wd-sub-h">base vs modified</div>
      <table class="wd-table"><thead><tr><th>Stat</th><th>Base</th><th>Modified</th></tr></thead><tbody>${rows}</tbody></table>${others}`;
    els.wdOverlay.hidden = false;
  }
  function closeWeaponDetail() { focusedWeapon = null; els.wdOverlay.hidden = true; }

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
    const body = attrs.length ? attrs.map((a) => `<tr><td class="em-attr${tipCls(a)}"${tipAttr(a)}>${label(a)}</td>${cols.map((c) => {
      const v = modOf(c.item, a); const good = attrMeta(a).lowerBetter ? /-/.test(v) : /\+|×[1-9]/.test(v) && !/×0/.test(v);
      return `<td class="${v ? (good ? "pos" : /-/.test(v) ? "neg" : "") : "em-empty"}">${v || "·"}</td>`;
    }).join("")}</tr>`).join("") : `<tr><td colspan="${cols.length + 1}" class="muted small">Equip armour to compare stat contributions.</td></tr>`;
    els.equipMatrix.innerHTML = `<table class="em-table"><thead>${head}</thead><tbody>${body}</tbody></table>`;
  }

  // =====================================================================
  //  DPS simulator — hitmap target picker + sustained-fire model
  //  (geometry: references/hitboxes.json served at site root; see HITMAP_FEATURE.md)
  // =====================================================================
  let HITBOXES = null, hbPromise = null;
  function loadHitboxes() {
    if (HITBOXES) return Promise.resolve();
    if (hbPromise) return hbPromise;
    hbPromise = fetch("hitboxes.json").then((r) => (r.ok ? r.json() : null)).then((j) => { HITBOXES = j; }).catch(() => { HITBOXES = null; });
    return hbPromise;
  }
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const unitFor = (enemyId) => (HITBOXES && HITBOXES.units[norm(enemyId)]) || null;
  const partMultMeta = (p) => { const m = HITBOXES && HITBOXES._meta.parts[p]; return m && m.mult != null ? m.mult : 1; };
  function resolvedAim(model) {                                  // selected part, validated against this body
    const present = (model.summary && model.summary.partsPresent) || [];
    let p = state.aimPart;
    if (!p || !present.includes(p)) p = model.summary ? model.summary.bestPart : null;
    return p;
  }
  // Toxic Lobotomy (EnchantmentIncreaseHeadshotDamage=3): a Head hit ×3 for RANGED weapons only
  function headshotBonus(slot) {
    let b = 1;
    for (const id of slot.enchants) { const e = enchById.get(id); if (!e) continue;
      for (const m of e.mods) if (m.attr === "EnchantmentIncreaseHeadshotDamage") b *= (m.value || 1); }
    return b;
  }
  // sustained damage over a 5s window: fire a full mag at RPM, reload, repeat (partial mag at the edge counts)
  function sustained5s(perShot, rpm, mag, reload) {
    const T = 5, sps = rpm / 60;
    if (sps <= 0) return null;
    const gap = 1 / sps, m = mag > 0 ? mag : Infinity;
    let t = 0, dmg = 0, shots = 0, guard = 0;
    while (t < T && guard++ < 100000) {
      let fired = 0;
      while (fired < m && t < T) { dmg += perShot; shots++; t += gap; fired++; }
      if (t >= T) break;
      t += reload;                                              // reload only between mags, not after the last shot
    }
    return { dps: dmg / T, shots };
  }
  // wall-clock to land n shots incl. reloads: (n-1) gaps + one reload per exhausted mag
  function timeForShots(n, rpm, mag, reload) {
    const sps = rpm / 60;
    if (sps <= 0 || n <= 0) return null;
    const reloads = mag > 0 ? Math.floor((n - 1) / mag) : 0;
    return (n - 1) / sps + reloads * reload;
  }

  // SVG hitmap: triangles painted body-first so weak-points sit on top and stay clickable
  function renderHitmap(model, sel) {
    const [x, y, w, h] = model.viewBox;
    const paint = { Block: 0, Body: 1, Thorax: 2, Groin: 2, Arm: 3, Leg: 3, Head: 4, Eye: 5, Custom: 1, None: 0 };
    const sw = Math.max(w, h) * 0.004;
    const polys = model.parts.slice().sort((a, b) => (paint[a.part] ?? 1) - (paint[b.part] ?? 1))
      .flatMap((p) => p.triangles.map((t) => {
        const on = p.part === sel;
        return `<polygon points="${t[0]},${t[1]} ${t[2]},${t[3]} ${t[4]},${t[5]}" fill="${p.color}" fill-opacity="${on ? 0.95 : 0.7}" stroke="${on ? "#fff" : "#0008"}" stroke-width="${on ? sw * 2.4 : sw}" data-aim="${p.part}" style="cursor:pointer"><title>${p.part} — ×${p.mult}</title></polygon>`;
      })).join("");
    return `<svg class="hitmap-svg" viewBox="${x} ${y} ${w} ${h}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${model.enemyClean || "enemy"} hitmap">${polys}</svg>`;
  }

  function renderTargetPanel() {
    const host = els.targetPanel;
    if (!state.enemy) { host.hidden = true; host.innerHTML = ""; return; }
    host.hidden = false;
    const enemy = enemyById.get(state.enemy);
    if (!HITBOXES) { host.innerHTML = `<div class="muted small">Loading hitmap…</div>`; return; }
    const unit = unitFor(state.enemy), model = unit && HITBOXES.models[unit.model];
    if (!model) { host.innerHTML = `<div class="muted small">No hitmap for ${enemy ? enemy.name : "this target"}.</div>`; return; }
    const aim = resolvedAim(model);
    const resists = Object.entries(enemy.resist).filter(([, v]) => v).map(([k, v]) => `${k} ${v}%`);
    const present = (model.summary.partsPresent || []).slice()
      .sort((a, b) => partMultMeta(b) - partMultMeta(a));       // strongest multiplier first
    const chips = present.map((p) => `<button class="aim-chip${p === aim ? " on" : ""}" data-aim="${p}" type="button">${p} <span class="am-mult">×${round(partMultMeta(p), 2)}</span></button>`).join("");
    const utype = unit.unitType && unit.unitType !== "None" ? unit.unitType : "";
    host.innerHTML = `
      <div class="tp-grid">
        <div class="tp-map" id="tp-map">${renderHitmap(model, aim)}</div>
        <div class="tp-info">
          <div class="tp-name">${enemy.name}</div>
          <div class="tp-sub">${[utype, unit.faction].filter(Boolean).join(" · ")}</div>
          <div class="tp-stat"><span class="k">HP</span><span class="v">${fmt(enemy.hp)}${unit.randomizeHealth && unit.randomizeHealth !== "0" ? " ±" + unit.randomizeHealth : ""}</span></div>
          ${resists.length ? `<div class="tp-stat"><span class="k">Resist</span><span class="v">${resists.join(", ")}</span></div>` : `<div class="tp-stat muted"><span class="k">Resist</span><span class="v">none</span></div>`}
          ${model.summary.hasBlock ? `<div class="tp-note bad">⛊ armor plates — ×0 zones</div>` : ""}
          ${unit.modelShared ? `<div class="tp-note muted">shared body model (stats are exact)</div>` : ""}
        </div>
      </div>
      <div class="aim-row"><span class="aim-label">Aim</span><div class="aim-chips">${chips}</div></div>`;
  }

  function renderDps() {
    const enemy = state.enemy && enemyById.get(state.enemy);
    const unit = enemy && unitFor(state.enemy), model = unit && HITBOXES.models[unit.model];
    const aim = model ? resolvedAim(model) : null;
    let html = "";
    [...state.weapons, state.melee].forEach((slot) => {
      const r = computeWeapon(slot); if (!r) return;
      const w = r.w, ranged = w.weaponType !== "Melee";
      const expected = r.perShot * (1 + r.critChance * (ENGINE.critMult - 1));   // crit-averaged per shot
      // Avg DPS (5s) — AGNOSTIC of hit location (part ×1.0); resistance + reloads/mag/RPM included
      const sus = sustained5s(expected * r.mitig, w.rpm, w.ammoMax, w.reloadTime);
      const avgDps = sus ? sus.dps : r.dpsEff;
      html += `<div class="dps-w">${w.name}${r.cal ? " · " + r.cal.label : ""}</div>`;
      html += `<div class="row big"><span class="k">Avg DPS · 5s${enemy ? " vs " + enemy.name : ""}</span><span class="v">${fmt(avgDps)}</span></div>`;
      if (enemy && model) {
        let pm = partMultMeta(aim);
        if (aim === "Head" && ranged) pm *= headshotBonus(slot);
        const perHitLoc = expected * pm * r.mitig;
        const stk = perHitLoc > 0 ? Math.ceil(enemy.hp / perHitLoc) : null;
        const ttk = stk ? timeForShots(stk, w.rpm, w.ammoMax, w.reloadTime) : null;
        html += `<div class="row"><span class="k">Per hit · ${aim} ×${round(pm, 2)}</span><span class="v">${fmt(perHitLoc)}</span></div>`;
        html += `<div class="row"><span class="k">Shots to kill</span><span class="v">${stk != null ? stk : "—"}</span></div>`;
        html += `<div class="row ttk"><span class="k">Time to kill</span><span class="v">${ttk != null ? round(ttk, 2) + " s" : "—"}</span></div>`;
        if (r.channel) html += `<div class="row"><span class="k">${r.channel} resist ${r.resist}%</span><span class="v">×${round(r.mitig, 2)}</span></div>`;
      } else {
        html += `<div class="row"><span class="k">Per shot${r.critChance > 0 ? " · crit " + Math.round(r.critChance * 100) + "%" : ""}</span><span class="v">${fmt(expected)}</span></div>`;
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
    // minmax(0,1fr) — NOT 1fr (=minmax(auto,1fr)) — so tracks shrink below tile content
    // and N columns always fit the viewport width instead of forcing a horizontal scrollbar
    els.overlayList.style.gridTemplateColumns = "repeat(" + (next.cols || 4) + ", minmax(0, 1fr))";
    renderOptions();
    els.overlay.hidden = false;
    // no auto-focus: focusing the search field pops the mobile keyboard and obscures the list
  }
  const closeSelector = () => { els.overlay.hidden = true; ctx = null; };

  // image-forward tile: icon on top, name below, no superfluous sub-text
  const optHTML = (o) => `<button class="opt${o.disabled ? " disabled" : ""}${o.dupe ? " dupe" : ""}${ctx && o.key === ctx.current ? " selected" : ""}" data-i="${o._i}" ${o.disabled ? "disabled" : ""} ${o.dupe ? 'title="Already applied to this weapon"' : ""}>${o.icon ? `<img src="${o.icon}" alt="">` : `<span class="opt-noimg"></span>`}<span class="opt-name">${o.name}</span></button>`;
  function renderOptions() {
    if (!ctx) return;
    const q = (els.overlaySearch.value || "").toLowerCase();
    const keyOf = ctx.filterKey || ((o) => o.filter);
    // search matches the name OR the item's stat keywords (e.g. "recoil", "armor")
    const list = ctx.opts.filter((o) => (!q || o.name.toLowerCase().includes(q) || (o.keywords || "").includes(q)) && (!activeFilter || keyOf(o) === activeFilter));
    let html = ctx.allowClear ? `<button class="opt clear-opt" data-clear="1">✕ Clear slot</button>` : "";
    if (ctx.groupBy && !activeFilter) {
      const order = ctx.groupOrder || [...new Set(list.map(ctx.groupBy))];
      for (const g of order) {
        const members = list.filter((o) => ctx.groupBy(o) === g);
        if (!members.length) continue;
        html += `<div class="opt-group">${ctx.groupLabel ? ctx.groupLabel(g) : g}</div>` + members.map(optHTML).join("");
      }
    } else {
      html += list.map(optHTML).join("");
    }
    els.overlayList.innerHTML = html || `<div class="muted small">No matches.</div>`;
  }
  function showDetail(o) {
    els.overlayDetail._item = o;
    const lines = ctx.statLines ? ctx.statLines(o) : [];
    els.overlayDetail.innerHTML =
      `<div class="od-scroll">` +
      `<div class="od-head">${o.icon ? `<img src="${o.icon}" alt="">` : ""}<div><div class="od-name">${o.name}</div>${o.sub ? `<div class="od-sub">${o.sub}</div>` : ""}</div></div>` +
      (lines.length ? `<div class="od-stats">${lines.map((l) => `<div class="od-stat"><span class="${tipCls(l.tipKey || l.k).trim()}"${tipAttr(l.tipKey || l.k)}>${l.k}</span><span class="${l.cls || ""}">${l.v}</span></div>`).join("")}</div>` : `<div class="muted small">No stat effects.</div>`) +
      `</div>` +
      `<button class="od-equip" data-equip="1" type="button" ${o.disabled ? "disabled" : ""}>${o.disabled ? "Unavailable" : (ctx && o.key === ctx.current ? "Remove" : "Equip")}</button>`;
  }
  const modLines = (mods) => (mods || []).map((m) => {
    const good = attrMeta(m.attr).lowerBetter ? m.value < 0 : m.value > 0;
    return { k: label(m.attr), tipKey: m.attr,
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
  // keyword blob for search: the stat labels an item touches, so e.g. "recoil"/"armor" find items
  const kw = (...parts) => parts.filter(Boolean).join(" ").toLowerCase();
  const modKw = (mods) => (mods || []).map((m) => label(m.attr)).join(" ");
  const itemOpts = (slot) => ITEMS.filter((i) => i.slot === slot).map((i) => ({ ref: i, key: i.key, name: i.name, sub: `${i.quality || ""}${i.set ? " · " + i.set + " set" : ""}${i.size ? " · " + i.size.w + "×" + i.size.h : ""}`, icon: i.icon, keywords: kw(i.name, i.set, modKw(i.mods), i.tags) }));
  const attachOpts = (keys) => keys.map((k) => itemByKey.get(k)).filter(Boolean)
    .map((i) => ({ ref: i, key: i.key, name: i.name, sub: i.subtype ? i.subtype + (i.mag ? " · " + i.mag + "x" : "") : (i.quality || ""), icon: i.icon, filter: i.subtype || null, keywords: kw(i.name, i.subtype, modKw(i.attachMods)) }))
    .sort((a, b) => (a.filter || "").localeCompare(b.filter || "") || (a.ref.mag || 0) - (b.ref.mag || 0) || a.name.localeCompare(b.name));
  const weaponOpts = () => WEAPONS.filter((w) => RANGED_TYPES.has(w.weaponType)).map((w) => ({ ref: w, key: w.key, name: w.name, sub: `${w.weaponType} · ${fmt(w.baseDamage)}dmg`, icon: w.icon, keywords: kw(w.name, w.weaponType, w.damageType, w.caliber) }));
  const meleeOpts = () => WEAPONS.filter((w) => w.weaponType === "Melee").map((w) => ({ ref: w, key: w.key, name: w.name, sub: `${w.weaponType} · ${fmt(w.baseDamage)}dmg`, icon: w.icon, keywords: kw(w.name, w.weaponType, w.damageType) }));
  const enchOpts = (elemental) => ENCH.filter((e) => !!e.isElemental === elemental).map((e) => ({ ref: e, key: e.id, name: e.name, sub: e.group, icon: e.icon, filter: e.group, keywords: kw(e.name, e.group, modKw(e.mods)) }));
  const caliberOpts = () => CALIBERS.filter((c) => c.hasChisel).map((c) => ({ ref: c, key: "cal" + c.id, calId: c.id, name: c.label, sub: `${c.baseDamage} base dmg${c.pellets > 1 ? " · " + c.pellets + " pellets" : ""}`, icon: c.icon, keywords: kw(c.label, "ammo caliber chisel") }));

  // =====================================================================
  //  Slot -> selector wiring
  // =====================================================================
  // paperdoll slot -> the item pool it draws from (feet slots share one pool; the 4 passive
  // slots all draw from the single "passive" pool)
  const poolForSlot = (slot) => (slot === "footL" || slot === "footR") ? "feet"
    : slot.startsWith("passive") ? "passive" : slot;
  function selectEquip(slot, lbl) {
    openSelector({ title: "Select " + lbl, allowClear: true, current: state.equipment[slot],
      opts: indexed(itemOpts(poolForSlot(slot))),
      statLines: (o) => modLines(o.ref.mods),
      onPick: (o) => { state.equipment[slot] = o.key; }, onClear: () => { state.equipment[slot] = null; } });
  }
  document.querySelectorAll(".slot[data-slot]").forEach((node) =>
    node.addEventListener("click", () => selectEquip(node.dataset.slot, SLOT_LABELS[node.dataset.slot])));

  const assignSlot = (loc, obj) => { if (loc === "melee") state.melee = obj; else state.weapons[Number(loc)] = obj; };
  function openWeaponSelector(loc) {
    const isMelee = loc === "melee";
    openSelector({ title: isMelee ? "Select melee" : "Select weapon", allowClear: true, current: slotFromLoc(loc).weapon,
      opts: indexed(isMelee ? meleeOpts() : weaponOpts()),
      groupBy: isMelee ? null : (o) => o.ref.weaponType, groupOrder: isMelee ? null : WEAPON_GROUP_ORDER,
      groupLabel: (t) => WEAPON_TYPE_LABEL[t] || t,
      statLines: (o) => weaponLines(o.ref),
      onPick: (o) => { const fresh = freshWeapon(); fresh.weapon = o.key; fresh.enchants = slotFromLoc(loc).enchants; assignSlot(loc, fresh); },
      onClear: () => { const fresh = freshWeapon(); fresh.enchants = slotFromLoc(loc).enchants; assignSlot(loc, fresh); if (focusedWeapon === loc) focusedWeapon = null; } });
  }

  // long-press / right-click a FILLED weapon shape reopens the selector; a tap opens its info panel
  let lpTimer = null, lpFired = false;
  els.arsenal.addEventListener("pointerdown", (ev) => {
    const t = ev.target.closest('[data-act="weapon"]'); if (!t) return;
    const loc = t.dataset.loc; lpFired = false;
    if (!slotFromLoc(loc).weapon) return;                       // empty slot: no long-press
    lpTimer = setTimeout(() => { lpFired = true; openWeaponSelector(loc); }, 500);
  });
  const cancelLp = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } };
  ["pointerup", "pointerleave", "pointercancel", "pointermove"].forEach((e) => els.arsenal.addEventListener(e, cancelLp));
  els.arsenal.addEventListener("contextmenu", (ev) => {
    const t = ev.target.closest('[data-act="weapon"]'); if (!t) return;
    ev.preventDefault(); const loc = t.dataset.loc;
    if (slotFromLoc(loc).weapon) openWeaponSelector(loc);
  });

  els.arsenal.addEventListener("click", (ev) => {
    const t = ev.target.closest("[data-act]"); if (!t) return;
    const loc = t.dataset.loc, act = t.dataset.act, slot = slotFromLoc(loc);
    if (act === "weapon" || act === "weapon-info") {
      if (lpFired) { lpFired = false; return; }                 // long-press already opened the selector
      cancelLp();
      if (!slot.weapon) { openWeaponSelector(loc); return; }     // empty -> pick a weapon
      if (focusedWeapon === loc) { closeWeaponDetail(); return; } // filled -> toggle the info overlay
      focusedWeapon = loc; renderWeaponDetail();
    } else if (act === "clear") {
      const kind = t.dataset.kind;
      if (kind === "attach") slot.attachments[t.dataset.slot] = null;
      else if (kind === "caliber") slot.caliber = null;
      else if (kind === "ench") slot.enchants.splice(Number(t.dataset.ei), 1);
      else if (kind === "weapon") { assignSlot(loc, freshWeapon()); if (focusedWeapon === loc) closeWeaponDetail(); }
      renderAll();
    } else if (act === "attach") {
      const s = t.dataset.slot; const w = weaponByKey.get(slot.weapon); const keys = w ? (w.attachSlots[s] || []) : [];
      if (!keys.length) return;
      if (keys.length === 1) { slot.attachments[s] = slot.attachments[s] ? null : keys[0]; renderAll(); return; }  // one option -> no overlay
      const opts = indexed(attachOpts(keys));
      const subs = [...new Set(opts.map((o) => o.filter).filter(Boolean))];
      openSelector({ title: ATTACH_LABEL[s] + " attachment", opts, filters: subs.length > 1 ? subs : null, current: slot.attachments[s],
        statLines: (o) => modLines(o.ref.attachMods), onPick: (o) => { slot.attachments[s] = o.key; }, onClear: () => { slot.attachments[s] = null; } });
    } else if (act === "caliber") {
      const w = weaponByKey.get(slot.weapon); if (!w || !w.canModCaliber) return;
      const curCal = slot.caliber != null ? slot.caliber : w.caliberId;   // can't pick the round it already chambers
      const opts = indexed(caliberOpts()).map((o) => o.calId === curCal ? Object.assign(o, { disabled: true, dupe: true, sub: o.sub + " · current" }) : o);
      openSelector({ title: "Chamber Chisel — caliber", allowClear: slot.caliber != null, opts,
        statLines: (o) => { const c = o.ref; return [{ k: "Base damage", v: fmt(c.baseDamage) }, { k: "Pellets", v: c.pellets }, { k: "Knockback", v: fmt(c.knockback) }]; },
        onPick: (o) => { slot.caliber = o.calId; }, onClear: () => { slot.caliber = null; } });
    } else if (act === "ench") {
      if (slot.enchants.length >= MAX_ENCH) return;
      const hasScroll = slot.enchants.some((id) => (enchById.get(id) || {}).isElemental);
      const applied = new Set(slot.enchants);                    // duplicates aren't allowed on the same weapon
      const dupe = (o) => applied.has(o.key) ? Object.assign(o, { disabled: true, dupe: true }) : o;
      const oils = enchOpts(false).map(dupe);
      const scrolls = enchOpts(true).map((o) => applied.has(o.key) ? dupe(o) : (hasScroll ? Object.assign(o, { disabled: true, sub: o.sub + " · 1 scroll max" }) : o));
      openSelector({ title: "Add oil / scroll", opts: indexed([...oils, ...scrolls]), cols: 6,
        filters: ["Oils", "Scrolls"], filterKey: (o) => (o.ref.isElemental ? "Scrolls" : "Oils"),
        groupBy: (o) => (o.ref.isElemental ? "Scroll" : (OIL_BUCKET[o.ref.group] || "Other")),
        groupOrder: OIL_BUCKET_ORDER, statLines: (o) => modLines(o.ref.mods),
        onPick: (o) => { if (o.disabled) return; slot.enchants.push(o.key); } });
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
    if (o.key === ctx.current && ctx.onClear) ctx.onClear();   // re-picking the equipped item deselects it
    else ctx.onPick(o);
    closeSelector(); renderAll();
  });
  els.overlaySearch.addEventListener("input", renderOptions);
  els.overlayClose.addEventListener("click", closeSelector);
  els.overlay.addEventListener("click", (ev) => { if (ev.target === els.overlay) closeSelector(); });

  // weapon-info overlay
  els.wdClose.addEventListener("click", closeWeaponDetail);
  els.wdOverlay.addEventListener("click", (ev) => { if (ev.target === els.wdOverlay) closeWeaponDetail(); });

  // DPS overlay — lazy-load hitmap geometry the first time it opens
  els.openDps.addEventListener("click", async () => {
    els.dpsOverlay.hidden = false;
    renderTargetPanel(); renderDps();                           // paints immediately (shows "Loading…" if a target is set)
    if (!HITBOXES) { await loadHitboxes(); renderTargetPanel(); renderDps(); }
  });
  els.dpsClose.addEventListener("click", () => { els.dpsOverlay.hidden = true; });
  els.dpsOverlay.addEventListener("click", (ev) => { if (ev.target === els.dpsOverlay) els.dpsOverlay.hidden = true; });
  els.enemy.addEventListener("change", () => {
    state.enemy = els.enemy.value || null; state.aimPart = null;  // new target -> default to its best weak-point
    persist(); renderWeapons(); renderTargetPanel(); renderDps();
  });
  // click a body part on the SVG or an aim chip to set the hit location
  els.targetPanel.addEventListener("click", (ev) => {
    const t = ev.target.closest("[data-aim]"); if (!t) return;
    state.aimPart = t.dataset.aim; persist();
    renderTargetPanel(); renderDps();
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    if (!els.overlay.hidden) closeSelector();
    else if (!els.wdOverlay.hidden) closeWeaponDetail();
    else if (!els.dpsOverlay.hidden) els.dpsOverlay.hidden = true;
  });

  // tap-tooltip: any element with data-tip shows a floating glossary note (mobile); desktop also gets native title
  const tipEl = el("tooltip");
  document.addEventListener("click", (ev) => {
    const t = ev.target.closest("[data-tip]");
    if (!t) { tipEl.hidden = true; return; }
    tipEl.textContent = t.getAttribute("data-tip");
    tipEl.hidden = false;
    const r = t.getBoundingClientRect(), w = Math.min(260, window.innerWidth - 16);
    tipEl.style.maxWidth = w + "px";
    tipEl.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left)) + "px";
    tipEl.style.top = Math.min(window.innerHeight - 90, r.bottom + 6) + "px";
  });
  document.addEventListener("scroll", () => { tipEl.hidden = true; }, true);
  els.clear.addEventListener("click", () => { state = freshState(); focusedWeapon = null; els.enemy.value = ""; renderAll(); });

  // --- init ---
  els.enemy.innerHTML = `<option value="">— no target —</option>` +
    [...ENEMIES].sort((a, b) => a.name.localeCompare(b.name)).map((e) => `<option value="${e.id}">${e.name} (${fmt(e.hp)} HP)</option>`).join("");
  els.enemy.value = state.enemy || "";
  els.counts.textContent = `${WEAPONS.length} weapons · ${ITEMS.length} gear · ${ENCH.length} enchantments · ${CALIBERS.length} calibers · ${ENEMIES.length} enemies`;
  renderAll();
})();
