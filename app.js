/*
  SULFUR Loadout Planner — app logic.
  Reads window.SULFUR_DATA (generated into data.js by build-data.mjs).

  Sandbox loop: click a slot -> category-limited selector overlay -> equip -> stats
  recompute live. Character paperdoll (Head/Torso/2×Foot/Gadget) + weapon slots, each
  with attachment containers and enchantment (oil/scroll) chips shown beside the weapon.

  Stat math mirrors the game's engine: per attribute, Flat (sum) -> pooled PercentAdd
  (× clamp(1+Σ, 0.01, 10)) -> each PercentMult (×(1+v)). Weapon DPS applies the enchant
  Damage mods + crit (flat ×2) + resistance ((100-r)/100) vs the chosen target.
  NOTE: attachment stat effects are a known extract gap (their modifiers aren't captured
  in items.csv) — attachment containers store/visualise items but don't yet feed the math.
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
  const WEAPON_SLOTS = 2;
  const ATTACH_PER_WEAPON = 4;

  const DMG_TO_RESIST = { Fire:"Fire",Frost:"Frost",Electric:"Electric",Poison:"Poison",
    Explosive:"Explosive",Holy:"Holy",Shadow:"Shadow",Earth:"Earth",Punish:"Punish",
    Bleed:"Bleed",Petrified:"Petrified",Charm:"Charm" };

  const itemByKey = new Map(ITEMS.map((i) => [i.key, i]));
  const weaponByKey = new Map(WEAPONS.map((w) => [w.key, w]));
  const enchById = new Map(ENCH.map((e) => [e.id, e]));
  const enemyById = new Map(ENEMIES.map((e) => [e.id, e]));

  const el = (id) => document.getElementById(id);
  const els = {
    weaponSlots: el("weapon-slots"), stats: el("stats"), dps: el("dps"),
    enemy: el("enemy-select"), counts: el("counts"), clear: el("clear-loadout"),
    overlay: el("overlay"), overlayList: el("overlay-list"), overlayTitle: el("overlay-title"),
    overlaySearch: el("overlay-search"), overlayClose: el("overlay-close"),
  };

  // ---- state ----
  function freshState() {
    return {
      equipment: { head: null, torso: null, footL: null, footR: null, gadget: null },
      weapons: Array.from({ length: WEAPON_SLOTS }, () => ({
        weapon: null, attachments: Array(ATTACH_PER_WEAPON).fill(null), enchants: [],
      })),
      enemy: null,
    };
  }
  let state = load();
  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (s && s.equipment && Array.isArray(s.weapons)) return s;
    } catch { /* ignore */ }
    return freshState();
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

  function equippedItems() {
    return Object.values(state.equipment).map((k) => k && itemByKey.get(k)).filter(Boolean);
  }
  // aggregate every equipped item's modifiersOnEquip, grouped by attribute
  function aggregateEquipMods() {
    const byAttr = new Map();
    for (const it of equippedItems())
      for (const m of it.mods || []) {
        if (!byAttr.has(m.attr)) byAttr.set(m.attr, []);
        byAttr.get(m.attr).push(m);
      }
    return byAttr;
  }

  // per-weapon damage (enchant Damage mods + crit + resistance vs target)
  function weaponDPS(slot) {
    const w = slot.weapon && weaponByKey.get(slot.weapon);
    if (!w) return null;
    const mods = { Damage: [], Global: [], Crit: [] };
    for (const id of slot.enchants) {
      const e = enchById.get(id); if (!e) continue;
      for (const m of e.mods) {
        if (m.attr === "Damage") mods.Damage.push(m);
        else if (m.attr === "Stat_GlobalDamageMultiplier") mods.Global.push(m);
        else if (m.attr === "Stat_CritChance") mods.Crit.push(m);
      }
    }
    let perPellet = calcStat(w.baseDamage, mods.Damage);
    perPellet *= (1 + (mods.Global.length ? calcStat(0, mods.Global) : 0));
    const perShot = perPellet * w.pellets;
    const critChance = clamp(calcStat(Number(PBASE.Stat_CritChance || 0), mods.Crit), 0, 1);
    const expected = perShot * (1 + critChance * (ENGINE.critMult - 1));
    const enemy = state.enemy && enemyById.get(state.enemy);
    const channel = DMG_TO_RESIST[w.damageType] || null;
    const resist = enemy && channel ? Number(enemy.resist[channel] || 0) : 0;
    const mitig = Math.max(0, (100 - resist) / 100);
    const sps = w.rpm > 0 ? w.rpm / 60 : 0;
    const dpsEff = expected * mitig * sps;
    const hp = enemy ? enemy.hp : 0;
    return {
      w, enemy, resist, channel, perShot, critChance,
      dpsRaw: perShot * sps, dpsEff,
      ttk: dpsEff > 0 && hp > 0 ? hp / dpsEff : null,
    };
  }

  // =====================================================================
  //  Rendering
  // =====================================================================
  const fmt = (n) => (Number.isFinite(n) ? (Math.abs(n) >= 100 ? Math.round(n) : round(n, 1)) : "—");

  function paintSlot(node, item, label) {
    node.classList.toggle("filled", !!item);
    node.innerHTML =
      (item && item.icon ? `<img class="slot-icon" src="${item.icon}" alt="">` : "") +
      `<span class="slot-label">${item ? item.name : label}</span>`;
    node.title = item ? item.name + " — click to change" : "Select " + label;
  }

  function renderPaperdoll() {
    const map = { head: "Head", torso: "Torso", footL: "Left Foot", footR: "Right Foot", gadget: "Gadget" };
    for (const [slot, label] of Object.entries(map)) {
      const node = document.querySelector(`.slot[data-slot="${slot}"]`);
      if (node) paintSlot(node, state.equipment[slot] && itemByKey.get(state.equipment[slot]), label);
    }
  }

  function renderWeapons() {
    els.weaponSlots.innerHTML = "";
    state.weapons.forEach((slot, wi) => {
      const w = slot.weapon && weaponByKey.get(slot.weapon);
      const box = document.createElement("div");
      box.className = "weapon-slot";

      const wIcon = w && w.icon ? `<img class="slot-icon" src="${w.icon}" alt="">` : "";
      const meta = w ? `${w.weaponType} · ${fmt(w.baseDamage)} dmg${w.pellets > 1 ? " ×" + w.pellets : ""} · ${fmt(w.rpm)} rpm` : "Tap to choose a weapon";

      const attachCells = slot.attachments.map((ak, ci) => {
        const it = ak && itemByKey.get(ak);
        return it
          ? `<div class="cell" data-act="attach" data-wi="${wi}" data-ci="${ci}" title="${it.name} — remove">${it.icon ? `<img src="${it.icon}" alt="">` : ""}</div>`
          : `<div class="cell add" data-act="attach" data-wi="${wi}" data-ci="${ci}" title="Add attachment"></div>`;
      }).join("");

      const enchChips = slot.enchants.map((id, ei) => {
        const e = enchById.get(id); if (!e) return "";
        return `<span class="chip${e.isElemental ? " elemental" : ""}" data-act="unench" data-wi="${wi}" data-ei="${ei}" title="Remove">${e.name} <span class="x">✕</span></span>`;
      }).join("") + `<span class="chip add" data-act="ench" data-wi="${wi}">+ oil / scroll</span>`;

      box.innerHTML = `
        <div class="ws-main">
          <button class="ws-weapon${w ? " filled" : ""}" data-act="weapon" data-wi="${wi}" type="button">${wIcon}</button>
          <div class="ws-info">
            <div class="ws-name">${w ? w.name : "Weapon slot " + (wi + 1)}</div>
            <div class="ws-meta">${meta}</div>
          </div>
        </div>
        <div class="ws-mods">
          <div class="mod-group"><span class="mg-label">Attachments</span><div class="mg-cells">${attachCells}</div></div>
          <div class="mod-group"><span class="mg-label">Enchantments</span><div class="chips">${enchChips}</div></div>
        </div>`;
      els.weaponSlots.appendChild(box);
    });
  }

  function renderReadout() {
    // DPS per weapon
    let dhtml = "";
    state.weapons.forEach((slot, wi) => {
      const r = weaponDPS(slot);
      if (!r) return;
      dhtml += `<div class="dps-w">${r.w.name}</div>`;
      dhtml += `<div class="row big"><span class="k">DPS${r.enemy ? " vs " + r.enemy.name : ""}</span><span class="v">${fmt(r.enemy ? r.dpsEff : r.dpsRaw)}</span></div>`;
      dhtml += `<div class="row"><span class="k">Per shot${r.critChance > 0 ? ` · crit ${Math.round(r.critChance * 100)}%` : ""}</span><span class="v">${fmt(r.perShot)}</span></div>`;
      if (r.enemy) {
        dhtml += `<div class="row"><span class="k">${r.channel ? r.channel + " resist " + r.resist + "%" : "unresisted"}</span><span class="v">×${round(Math.max(0,(100-r.resist)/100),2)}</span></div>`;
        dhtml += `<div class="row ttk"><span class="k">Time to kill</span><span class="v">${r.ttk != null ? round(r.ttk, 2) + " s" : "—"}</span></div>`;
      }
    });
    els.dps.innerHTML = dhtml || `<div class="muted small">Equip a weapon to see damage.</div>`;

    // aggregated equipment stats
    const byAttr = aggregateEquipMods();
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
      const cls = net > 0 ? "pos" : net < 0 ? "neg" : "";
      const label = attr in PBASE ? `${attr} → ${fmt(calcStat(PBASE[attr], mods))}` : attr;
      rows.push(`<div class="stat"><span class="sk">${label}</span><span class="sv ${cls}">${parts.join("  ")}</span></div>`);
    }
    els.stats.innerHTML =
      `<div class="sl-head">Equipment effects (${rows.length} attributes)</div>` +
      (rows.length ? rows.join("") : `<div class="muted small">Equip armour to see stat changes.</div>`);
  }

  function renderAll() { renderPaperdoll(); renderWeapons(); renderReadout(); persist(); }

  // =====================================================================
  //  Selector overlay (category-limited)
  // =====================================================================
  let ctx = null; // { title, opts:[{key,name,sub,icon}], onPick, allowClear }
  function openSelector(next) {
    ctx = next;
    els.overlayTitle.textContent = next.title;
    els.overlaySearch.value = "";
    renderOptions();
    els.overlay.hidden = false;
    els.overlaySearch.focus();
  }
  function closeSelector() { els.overlay.hidden = true; ctx = null; }

  function renderOptions() {
    if (!ctx) return;
    const q = (els.overlaySearch.value || "").toLowerCase();
    const list = ctx.opts.filter((o) => !q || o.name.toLowerCase().includes(q));
    let html = ctx.allowClear ? `<button class="opt clear-opt" data-clear="1">✕ Clear slot</button>` : "";
    html += list.map((o, i) =>
      `<button class="opt" data-i="${o._i}">${o.icon ? `<img src="${o.icon}" alt="">` : ""}<span><span class="opt-name">${o.name}</span>${o.sub ? `<span class="opt-sub"> ${o.sub}</span>` : ""}</span></button>`
    ).join("");
    els.overlayList.innerHTML = html || `<div class="muted small">No matches.</div>`;
  }

  const itemOpts = (slot) => ITEMS.filter((i) => i.slot === slot)
    .map((i, _n) => ({ key: i.key, name: i.name, sub: `${i.quality || ""}${i.size ? " · " + i.size.w + "×" + i.size.h : ""}`, icon: i.icon }));
  const weaponOpts = () => WEAPONS.map((w) => ({ key: w.key, name: w.name, sub: `${w.weaponType} · ${fmt(w.baseDamage)}dmg`, icon: w.icon }));
  const enchOpts = () => ENCH.map((e) => ({ key: e.id, name: e.name, sub: e.group, icon: null }));

  // index opts for stable click lookup
  function indexed(opts) { opts.forEach((o, i) => (o._i = i)); return opts; }

  function selectEquip(slot, label) {
    openSelector({
      title: "Select " + label, allowClear: true, opts: indexed(itemOpts(slot === "footL" || slot === "footR" ? "feet" : slot)),
      onPick: (o) => { state.equipment[slot] = o.key; },
      onClear: () => { state.equipment[slot] = null; },
    });
  }

  // =====================================================================
  //  Events
  // =====================================================================
  document.querySelectorAll(".slot[data-slot]").forEach((node) => {
    node.addEventListener("click", () => {
      const slot = node.dataset.slot;
      const label = { head: "Head", torso: "Torso", footL: "Left Foot", footR: "Right Foot", gadget: "Gadget" }[slot];
      selectEquip(slot, label);
    });
  });

  els.weaponSlots.addEventListener("click", (ev) => {
    const t = ev.target.closest("[data-act]");
    if (!t) return;
    const wi = Number(t.dataset.wi);
    const act = t.dataset.act;
    if (act === "weapon") {
      openSelector({ title: "Select weapon", allowClear: true, opts: indexed(weaponOpts()),
        onPick: (o) => { state.weapons[wi].weapon = o.key; }, onClear: () => { state.weapons[wi].weapon = null; } });
    } else if (act === "attach") {
      const ci = Number(t.dataset.ci);
      if (itemByKey.has(state.weapons[wi].attachments[ci])) { state.weapons[wi].attachments[ci] = null; renderAll(); return; }
      openSelector({ title: "Select attachment", allowClear: false, opts: indexed(itemOpts("attachment")),
        onPick: (o) => { state.weapons[wi].attachments[ci] = o.key; } });
    } else if (act === "ench") {
      openSelector({ title: "Select oil / scroll", allowClear: false, opts: indexed(enchOpts()),
        onPick: (o) => { state.weapons[wi].enchants.push(o.key); } });
    } else if (act === "unench") {
      state.weapons[wi].enchants.splice(Number(t.dataset.ei), 1); renderAll();
    }
  });

  els.overlayList.addEventListener("click", (ev) => {
    const t = ev.target.closest("button"); if (!t || !ctx) return;
    if (t.dataset.clear) { ctx.onClear && ctx.onClear(); closeSelector(); renderAll(); return; }
    if (t.dataset.i == null) return;
    const o = ctx.opts[Number(t.dataset.i)];
    ctx.onPick(o); closeSelector(); renderAll();
  });
  els.overlaySearch.addEventListener("input", renderOptions);
  els.overlayClose.addEventListener("click", closeSelector);
  els.overlay.addEventListener("click", (ev) => { if (ev.target === els.overlay) closeSelector(); });
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && !els.overlay.hidden) closeSelector(); });

  els.enemy.addEventListener("change", () => { state.enemy = els.enemy.value || null; persist(); renderReadout(); });
  els.clear.addEventListener("click", () => { state = freshState(); els.enemy.value = ""; renderAll(); });

  // ---- init ----
  const sortedEnemies = [...ENEMIES].sort((a, b) => a.name.localeCompare(b.name));
  els.enemy.innerHTML = `<option value="">— no target —</option>` +
    sortedEnemies.map((e) => `<option value="${e.id}">${e.name} (${fmt(e.hp)} HP)</option>`).join("");
  els.enemy.value = state.enemy || "";
  els.counts.textContent = `${WEAPONS.length} weapons · ${ITEMS.length} gear · ${ENCH.length} enchantments · ${ENEMIES.length} enemies`;
  renderAll();
})();
