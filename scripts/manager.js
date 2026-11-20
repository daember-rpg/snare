import {
  MODULE_ID, RANKS, ACTIVITIES, CONDITIONS, VALUED, SKILLS, DTYPES, TERRAIN, PYRE_STRIKE, PYRE_BURST, EFFECT_META, terrainRules
} from "./constants.js";
import {
  getTraps, getTrap, saveConfig, createTrap, deleteTrap, updateState, blankTrap, newEffect, pickConfig, clone,
  dcForLevel, xpInfo, esc, key, pointCell, alliance, freshState, terrainCellsOf, tokenCell, isActiveGM
} from "./store.js";
import { drafts, requestDraw, setHover, setOpacity } from "./overlay.js";
import { fireTrap, tickRound, attemptDisable, clearTerrain, activityOf, syncFeature } from "./engine.js";
import { pyreReady } from "./pyre.js";
import { TEMPLATES, HIDDENNESS, FEATURE_CARD } from "./templates.js";

const { ApplicationV2 } = foundry.applications.api;
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const fid = (p) => `snare-f-${p.replace(/\./g, "-")}`;

function num(p, v, min, max) {
  return `<input type="number" id="${fid(p)}" data-path="${p}" data-type="num" value="${esc(v)}"${min != null ? ` min="${min}"` : ""}${max != null ? ` max="${max}"` : ""}>`;
}
function txt(p, v, ph = "") {
  return `<input type="text" id="${fid(p)}" data-path="${p}" value="${esc(v)}" placeholder="${esc(ph)}">`;
}
function sel(p, v, opts, isNum) {
  return `<select id="${fid(p)}" data-path="${p}"${isNum ? ' data-type="num"' : ""}>${opts.map((o) => {
    const [ov, ol] = Array.isArray(o) ? o : [o, o];
    return `<option value="${esc(ov)}"${String(ov) === String(v) ? " selected" : ""}>${esc(ol)}</option>`;
  }).join("")}</select>`;
}
function chk(p, v, label) {
  return `<label class="snare-check" for="${fid(p)}"><input type="checkbox" id="${fid(p)}" data-path="${p}" data-type="bool"${v ? " checked" : ""}><span>${label}</span></label>`;
}
function field(label, p, input, hint) {
  return `<div class="snare-field"><label for="${fid(p)}">${label}</label>${input}${hint ? `<small>${hint}</small>` : ""}</div>`;
}
const RANK_OPTS = RANKS.map((r, i) => [i, r]);

export class SnareManager extends ApplicationV2 {
  static #instance = null;
  static open() {
    if (!game.user.isGM) return ui.notifications.warn("Snare: only the GM can build traps.");
    if (!this.#instance) this.#instance = new SnareManager();
    this.#instance.render({ force: true });
    return this.#instance;
  }
  static get instance() { return this.#instance; }

  static DEFAULT_OPTIONS = {
    id: "snare-manager",
    classes: ["snare-app"],
    tag: "div",
    window: { title: "Snare", icon: "fa-solid fa-diamond", resizable: true },
    position: { width: 860, height: 800 }
  };

  tab = "traps";
  selectedId = null;
  draft = null;
  paint = null;
  createFrom = "blank";
  wizard = null;
  hazards = null;
  #saveTimer = null;
  #listeners = false;
  #canvasHandlers = null;

  get scene() { return canvas?.scene ?? null; }

  /* ---------------- data ---------------- */

  #select(id) {
    this.#flush();
    this.stopPaint(false);
    drafts.delete(this.selectedId);
    this.selectedId = id;
    const t = id ? getTrap(this.scene, id) : null;
    this.draft = t ? { ...pickConfig(t), id: t.id } : null;
    if (this.draft) drafts.set(this.draft.id, this.draft);
    requestDraw();
  }

  #queueSave() {
    if (!this.draft) return;
    drafts.set(this.draft.id, this.draft);
    requestDraw();
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => this.#flush(), 400);
  }

  #featureSig = {};
  async #flush() {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = null;
    const t = this.draft, scene = this.scene;
    if (!t || !scene || !getTrap(scene, t.id)) return;
    await saveConfig(scene, t);
    // Scene features keep their terrain in step with the painted area and the terrain effects.
    const saved = getTrap(scene, t.id);
    if (!saved || (!saved.feature && saved.state.status !== "active")) return;
    const sig = JSON.stringify([saved.feature, saved.trigger, saved.effects.filter((e) => e.type === "terrain")]);
    if (this.#featureSig[t.id] === sig && saved.state.status === (saved.feature ? "active" : "armed")) return;
    this.#featureSig[t.id] = sig;
    await syncFeature(scene, saved);
  }

  async #loadHazards() {
    if (this.hazards) return;
    this.hazards = [];
    const pack = game.packs.get("pf2e.hazards");
    if (!pack) return;
    try {
      const index = await pack.getIndex({ fields: ["system.details.level.value", "system.details.isComplex"] });
      this.hazards = index.map((e) => ({ id: e._id, name: e.name, level: e.system?.details?.level?.value ?? 0, complex: !!e.system?.details?.isComplex }))
        .sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
    } catch (err) {
      console.warn(`${MODULE_ID} | could not index pf2e.hazards`, err);
    }
  }

  /* ---------------- rendering ---------------- */

  async _renderHTML() {
    await this.#loadHazards();
    if (this.selectedId && !getTrap(this.scene, this.selectedId)) this.#select(null);
    if (!this.selectedId && this.tab === "traps" && !this.wizard) {
      const first = getTraps(this.scene)[0];
      if (first) this.#select(first.id);
    }
    return this.#html();
  }

  _replaceHTML(result, content) {
    const body = content.querySelector(".snare-main");
    const top = body?.scrollTop ?? 0;
    content.innerHTML = result;
    const nb = content.querySelector(".snare-main");
    if (nb) nb.scrollTop = top;
    if (!this.#listeners) { this.#bind(content); this.#listeners = true; }
  }

  _onClose(options) {
    this.#flush();
    this.stopPaint(false);
    if (this.selectedId) drafts.delete(this.selectedId);
    this.selectedId = null; this.draft = null; this.wizard = null;
    this.#listeners = false;
    requestDraw();
    super._onClose?.(options);
  }

  /** Re-render the state bits only, so typing in a field never loses focus. */
  refreshState() {
    if (!this.rendered) return;
    const list = this.element.querySelector(".snare-list-items");
    if (list) list.innerHTML = this.#listItems();
    const st = this.element.querySelector(".snare-state");
    if (st && this.draft) st.outerHTML = this.#stateHTML(getTrap(this.scene, this.draft.id));
    if (this.tab === "exploration") {
      const ex = this.element.querySelector(".snare-main");
      if (ex && !ex.contains(document.activeElement)) ex.innerHTML = this.#explorationHTML();
    }
  }

  #html() {
    const scene = this.scene;
    if (!scene) return `<div class="snare-empty">Open a scene to build traps.</div>`;
    if (this.paint && this.draft) return this.#compactHTML();
    return `<div class="snare-shell">
      <aside class="snare-side">
        <nav class="snare-tabs" aria-label="Snare sections">
          <button type="button" class="snare-tab${this.tab === "traps" ? " is-on" : ""}" data-action="tab" data-tab="traps"><i class="fa-solid fa-diamond"></i> Traps</button>
          <button type="button" class="snare-tab${this.tab === "exploration" ? " is-on" : ""}" data-action="tab" data-tab="exploration"><i class="fa-solid fa-person-hiking"></i> Explore</button>
        </nav>
        <div class="snare-scene-name">${esc(scene.name)}</div>
        <div class="snare-list-items">${this.#listItems()}</div>
        <div class="snare-mapview">
          <button type="button" class="snare-icon${game.settings.get(MODULE_ID, "showOverlay") ? " on" : ""}" data-action="toggleOverlay" data-tooltip="Show or hide trap markings on the map (only you see them)" aria-label="Show trap markings" aria-pressed="${game.settings.get(MODULE_ID, "showOverlay")}"><i class="fa-solid ${game.settings.get(MODULE_ID, "showOverlay") ? "fa-eye" : "fa-eye-slash"}"></i></button>
          <label for="snare-opacity">Markings</label>
          <input type="range" id="snare-opacity" data-opacity min="10" max="100" step="5" value="${game.settings.get(MODULE_ID, "overlayOpacity")}">
        </div>
        <div class="snare-create">
          <button type="button" class="snare-btn primary wide" data-action="wizStart"${this.wizard ? " disabled" : ""}><i class="fa-solid fa-wand-magic-sparkles"></i> New trap</button>
          <details class="snare-more">
            <summary>Or start from…</summary>
            <select id="snare-create-from" aria-label="Start from" data-create-from>${this.#createOptions()}</select>
            <button type="button" class="snare-btn sm wide" data-action="create"><i class="fa-solid fa-plus"></i> Create</button>
          </details>
        </div>
      </aside>
      <section class="snare-main">${this.wizard ? this.#wizardHTML() : this.tab === "exploration" ? this.#explorationHTML() : this.#builderHTML()}</section>
    </div>`;
  }

  #compactHTML() {
    const t = this.draft, pm = this.paint, w = this.wizard;
    const e = t.effects.find((x) => x.id === pm.effectId);
    const many = pm.mode === "trigger" || (pm.mode === "area" && e?.type === "terrain");
    const title = pm.mode === "trigger" ? "Paint the trigger" : pm.mode === "origin" ? "Place the origin" : e?.type === "burst" ? "Pick the burst's center" : "Paint the terrain";
    const icon = pm.mode === "trigger" ? "fa-shoe-prints" : pm.mode === "origin" ? "fa-crosshairs" : e?.type === "burst" ? "fa-bomb" : "fa-vector-square";
    const steps = w ? this.#wizSteps() : null;
    const count = pm.mode === "trigger" ? t.trigger.length : e?.type === "terrain" ? terrainCellsOf(t, e).length : 0;
    const how = many
      ? [["fa-arrow-pointer", "<b>Click</b> a square on the map to add it."],
         ["fa-hand-pointer", "<b>Hold and drag</b> to paint several in a row."],
         ["fa-eraser", "<b>Click a painted square</b> to remove it."],
         ["fa-computer-mouse", "<b>Right-click</b> anywhere on the map when you're done."]]
      : [["fa-arrow-pointer", `<b>Click one square</b> on the map${pm.mode === "origin" ? ": a slot in the wall, the ceiling, a statue's mouth" : ""}.`],
         ["fa-computer-mouse", "<b>Right-click</b> to cancel."]];
    let foot;
    if (w) {
      foot = `<button type="button" class="snare-btn ghost" data-action="wizBack"><i class="fa-solid fa-arrow-left"></i> Back</button>
        <span class="snare-spacer"></span>
        ${pm.mode === "origin" ? `<button type="button" class="snare-btn sm ghost" data-action="wizSkipOrigin">Skip</button>` : ""}
        <button type="button" class="snare-btn primary" data-action="wizNext"${pm.mode === "trigger" && !count ? " disabled" : ""}>Next <i class="fa-solid fa-arrow-right"></i></button>`;
    } else {
      foot = `<span class="snare-spacer"></span><button type="button" class="snare-btn primary" data-action="stopPaint"><i class="fa-solid fa-check"></i> Done</button>`;
    }
    return `<div class="snare-compact">
      <div class="snare-compact-h">
        <span class="snare-card-icon"><i class="fa-solid ${icon}"></i></span>
        <div><div class="snare-compact-title">${title}</div><div class="snare-compact-sub">${esc(t.name)}${steps ? ` · step ${steps.indexOf(w.step) + 1} of ${steps.length}` : ""}</div></div>
      </div>
      <ul class="snare-howto">${how.map(([i, h]) => `<li><i class="fa-solid ${i}"></i><span>${h}</span></li>`).join("")}</ul>
      ${many ? `<div class="snare-wiz-live"><i class="fa-solid fa-paintbrush"></i><span class="snare-wiz-count">${count} square${count === 1 ? "" : "s"} painted</span></div>` : ""}
      <div class="snare-compact-foot">${foot}</div>
    </div>`;
  }

  #listItems() {
    const traps = getTraps(this.scene);
    if (!traps.length) return `<p class="snare-muted small">No traps on this scene yet.</p>`;
    return traps.map((t) => `<button type="button" class="snare-item${t.id === this.selectedId && this.tab === "traps" ? " is-on" : ""}" data-action="select" data-id="${t.id}">
      <span class="snare-item-name">${esc(t.name)}</span>
      <span class="snare-item-meta"><span class="snare-pill ${t.state.status}">${t.state.status}</span> Level ${t.level}</span>
    </button>`).join("");
  }

  #createOptions() {
    let lib = [];
    try { lib = game.settings.get(MODULE_ID, "library") ?? []; } catch (err) { lib = []; }
    const o = (v, l) => `<option value="${esc(v)}"${this.createFrom === v ? " selected" : ""}>${esc(l)}</option>`;
    let html = o("blank", "Empty trap (full builder)");
    if (lib.length) html += `<optgroup label="My library">${lib.map((t, i) => o(`lib:${i}`, t.name)).join("")}</optgroup>`;
    if (this.hazards?.length) html += `<optgroup label="PF2e hazards">${this.hazards.map((h) => o(`comp:${h.id}`, `${h.name} (${h.level}${h.complex ? ", complex" : ""})`)).join("")}</optgroup>`;
    return html;
  }

  #explorationHTML() {
    const actors = game.actors.filter((a) => a.type === "character" && a.hasPlayerOwner);
    const rows = actors.map((a) => {
      const p = a.perception;
      return `<tr><td>${esc(a.name)}</td>
        <td><select data-activity="${a.id}" aria-label="${esc(a.name)} activity">${ACTIVITIES.map((x) => `<option value="${x.id}"${activityOf(a) === x.id ? " selected" : ""}>${x.label}</option>`).join("")}</select></td>
        <td class="num">${p ? (p.mod >= 0 ? "+" : "") + p.mod : "—"} <span class="snare-muted">${RANKS[p?.rank ?? 0]}</span></td></tr>`;
    }).join("");
    return `<div class="snare-sec first"><h3><i class="fa-solid fa-person-hiking"></i>Exploration activities</h3>
      <p class="snare-muted small">Players pick theirs from the Triad tray or the token HUD. Only Searching characters get a check against traps that need a minimum proficiency.</p>
      ${actors.length ? `<table class="snare-table"><thead><tr><th>Character</th><th>Activity</th><th>Perception</th></tr></thead><tbody>${rows}</tbody></table>` : `<p class="snare-muted">No player characters yet.</p>`}
    </div>`;
  }

  #stateHTML(trap) {
    if (!trap) return `<div class="snare-state"></div>`;
    const st = trap.state;
    if (trap.feature) {
      return `<div class="snare-state"><div class="snare-state-row">
        <span class="snare-pill active">${st.status === "active" ? "Always active" : "Setting up"}</span>
        <span class="snare-muted small">Part of the scene: no checks to find it, nothing to disable.${trap.playersSee ? "" : " Hidden from players."}</span>
      </div></div>`;
    }
    const found = st.detectedBy.map((id) => game.actors.get(id)).filter(Boolean);
    const disableRow = trap.noDisable ? `<p class="snare-muted small">This trap can't be disabled.</p>` : st.status === "armed" ? (found.length
      ? `<div class="snare-disarm">
          <div class="snare-field"><label for="snare-dis-actor">Who disables</label><select id="snare-dis-actor">${found.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join("")}</select></div>
          <div class="snare-field"><label for="snare-dis-row">Check</label><select id="snare-dis-row">${trap.disable.map((d, i) => `<option value="${i}">${esc(cap(d.skill))} DC ${d.dc}${d.minProf ? ` (${RANKS[d.minProf]})` : ""}</option>`).join("")}</select></div>
          <button type="button" class="snare-btn primary" data-action="disable"><i class="fa-solid fa-screwdriver-wrench"></i> Disable</button>
        </div>`
      : `<p class="snare-muted small">No one has found it yet. Disabling needs someone who found it, or point it out to the party.</p>`) : "";
    return `<div class="snare-state">
      <div class="snare-state-row">
        <span class="snare-pill ${st.status}">${st.status}</span>
        ${trap.successes > 1 && st.status === "armed" ? `<span class="snare-muted small">Disable ${st.progress}/${trap.successes}</span>` : ""}
        ${st.rearmIn ? `<span class="snare-muted small">Rearms in ${st.rearmIn}</span>` : ""}
        ${st.terrain.length ? `<span class="snare-muted small">${st.terrain.length} terrain area${st.terrain.length > 1 ? "s" : ""} active</span>` : ""}
        <span class="snare-spacer"></span>
        ${st.status !== "armed" ? `<button type="button" class="snare-btn sm" data-action="rearm"><i class="fa-solid fa-rotate"></i> Rearm</button>` : `<button type="button" class="snare-btn sm" data-action="fireNow" data-tooltip="Fire it now at the selected token"><i class="fa-solid fa-burst"></i> Fire</button>`}
        <button type="button" class="snare-btn sm ghost" data-action="nextRound" data-tooltip="Count down terrain and rearming (also happens on each combat round)"><i class="fa-solid fa-hourglass-half"></i> Round</button>
      </div>
      <div class="snare-state-row">
        <span class="snare-muted small">Found by:</span>
        ${found.length ? found.map((a) => `<span class="snare-chip on">${esc(a.name)}</span>`).join("") : `<span class="snare-muted small">nobody</span>`}
        <span class="snare-spacer"></span>
        <button type="button" class="snare-btn sm ghost" data-action="pointOut" data-tooltip="Everyone in the party now knows where it is">Point out</button>
        <button type="button" class="snare-btn sm ghost" data-action="resetDetect" data-tooltip="Forget who found it and who already rolled">Reset checks</button>
        ${st.terrain.length ? `<button type="button" class="snare-btn sm ghost" data-action="clearTerrain">Clear terrain</button>` : ""}
      </div>
      ${disableRow}
    </div>`;
  }

  #builderHTML() {
    const t = this.draft;
    if (!t) return `<div class="snare-empty"><i class="fa-solid fa-diamond"></i><p>Create a trap on the left, then paint its trigger on the map.</p></div>`;
    const saved = getTrap(this.scene, t.id);
    const xp = xpInfo(t);
    const sug = dcForLevel(t.level);
    const hasTerrain = t.effects.some((e) => e.type === "terrain");
    const tokens = this.scene.tokens.filter((d) => d.actor).sort((a, b) => a.name.localeCompare(b.name));
    const chipList = (list, action, extra = "") => tokens.map((d) => `<button type="button" class="snare-chip${list.includes(d.id) ? " on" : ""}" data-action="${action}" data-token="${d.id}" ${extra} aria-pressed="${list.includes(d.id)}"><span class="snare-dot ${alliance(d.actor)}"></span>${esc(d.name)}</button>`).join("") || `<span class="snare-muted small">No tokens on this scene.</span>`;
    const paintBtn = (mode, icon, label, effectId = "") => {
      const on = this.paint?.mode === mode && (this.paint.effectId ?? "") === effectId;
      return `<button type="button" class="snare-btn sm${on ? " on" : ""}" data-action="paint" data-mode="${mode}" data-effect="${effectId}" aria-pressed="${on}"><i class="fa-solid ${icon}"></i> ${on ? "Done" : label}</button>`;
    };
    const profHint = t.minProf === 0
      ? "Every PC gets a secret check near it, Searching or not."
      : `Only PCs who are Searching with ${RANKS[t.minProf]} Perception get a check. Everyone else walks into it.`;

    return `
    <div class="snare-head">
      <input type="text" class="snare-title-input" id="${fid("name")}" data-path="name" value="${esc(t.name)}" aria-label="Trap name">
      <button type="button" class="snare-icon" data-action="saveLib" data-tooltip="Save to my library" aria-label="Save to my library"><i class="fa-solid fa-book-bookmark"></i></button>
      <button type="button" class="snare-icon" data-action="duplicate" data-tooltip="Duplicate" aria-label="Duplicate"><i class="fa-solid fa-clone"></i></button>
      <button type="button" class="snare-icon danger" data-action="delete" data-tooltip="Delete trap" aria-label="Delete trap"><i class="fa-solid fa-trash"></i></button>
    </div>
    ${this.#stateHTML(saved)}
    ${this.paint ? `<div class="snare-painting"><i class="fa-solid fa-paintbrush"></i> ${this.#paintHint()} Right-click or press Done to stop.</div>` : ""}

    <section class="snare-sec"><h3><i class="fa-solid fa-diamond"></i>Trap</h3>
      <div class="snare-row">${field("Level", "level", num("level", t.level, -1, 25))}${field("Complexity", "kind", sel("kind", t.kind, [["simple", "Simple"], ["complex", "Complex"]]))}${field("Party level", "partyLevel", num("partyLevel", t.partyLevel, 1, 20))}</div>
      <div class="snare-xp"><span>XP</span><b>${xp.xp == null ? "—" : xp.xp}</b><span class="snare-muted">${xp.text}</span></div>
      ${t.notes ? `<p class="snare-notes">${esc(t.notes)}</p>` : ""}
      ${hasTerrain ? `<div class="snare-opts">
        ${chk("feature", t.feature, "Part of the scene: always active, nobody rolls to find it, and it can't be disabled")}
        ${chk("playersSee", t.playersSee, "Players see the terrain marked on the map")}
      </div>` : ""}
    </section>
    ${t.feature ? "" : `
    <section class="snare-sec"><h3><i class="fa-solid fa-eye"></i>Detection</h3>
      <div class="snare-row">${field("Stealth DC", "stealthDC", num("stealthDC", t.stealthDC))}${field("Detection radius", "detectRadius", num("detectRadius", t.detectRadius, 0, 6), "Squares around the trigger")}</div>
      <div class="snare-suggest">Level ${t.level}:
        <button type="button" class="snare-btn sm" data-action="useDC" data-adj="0">DC ${sug}</button>
        <button type="button" class="snare-btn sm" data-action="useDC" data-adj="2">Hard ${sug + 2}</button>
        <button type="button" class="snare-btn sm" data-action="useDC" data-adj="5">Very hard ${sug + 5}</button></div>
      ${field("Minimum proficiency to find it", "minProf", sel("minProf", t.minProf, [[0, "None (anyone can notice)"], ...RANK_OPTS.slice(1)], true), profHint)}
      ${chk("magical", t.magical, "Magical trap")}
    </section>

    <section class="snare-sec"><h3><i class="fa-solid fa-shoe-prints"></i>Trigger &amp; origin</h3>
      <div class="snare-inline"><span class="snare-muted">${t.trigger.length} trigger square${t.trigger.length === 1 ? "" : "s"}</span>${paintBtn("trigger", "fa-shoe-prints", "Paint trigger")}<button type="button" class="snare-btn sm ghost" data-action="clearTrigger">Clear</button></div>
      <div class="snare-inline"><span class="snare-muted">Origin: ${t.origin ? "set" : "not set"}</span>${paintBtn("origin", "fa-crosshairs", "Place origin")}${t.origin ? `<button type="button" class="snare-btn sm ghost" data-action="clearOrigin">Clear</button>` : ""}</div>
      <div class="snare-row">${field("Triggered by", "triggeredBy", sel("triggeredBy", t.triggeredBy, [["any", "Any creature"], ["party", "Party only"]]))}${field("Targets", "targets", sel("targets", t.targets, [["triggering", "Triggering creature"], ["allInTrigger", "Everyone on the trigger"], ["nearestOrigin", "Nearest to the origin"]]))}</div>
      <div class="snare-field"><span>Never triggered by</span><div class="snare-chips">${chipList(t.triggerIgnore, "toggleIgnore")}</div></div>
      ${chk("confirm", t.confirm, "Ask me before it fires")}
      <div class="snare-row">${field("After firing", "after", sel("after", t.after, [["oneshot", "Spent (one use)"], ["manual", "I rearm it"], ["rounds", "Rearms by itself"]]))}${t.after === "rounds" ? field("Rearm after (rounds)", "rearmRounds", num("rearmRounds", t.rearmRounds, 1, 50)) : ""}</div>
    </section>

`}
    ${t.feature ? `<section class="snare-sec"><h3><i class="fa-solid fa-vector-square"></i>Area</h3>
      <div class="snare-inline"><span class="snare-muted">${t.trigger.length} square${t.trigger.length === 1 ? "" : "s"}</span>${paintBtn("trigger", "fa-paintbrush", "Paint area")}<button type="button" class="snare-btn sm ghost" data-action="clearTrigger">Clear</button></div>
      <p class="snare-muted small">Terrain set to "Trigger squares" covers this area.</p></section>` : ""}
    <section class="snare-sec"><h3><i class="fa-solid fa-burst"></i>${t.feature ? "What it does" : "When it fires"}</h3>
      ${!pyreReady() ? `<p class="snare-muted small">Pyre is not active, so effects play without animation.</p>` : ""}
      ${t.effects.map((e, i) => this.#effectHTML(e, i, t, tokens, chipList, paintBtn)).join("")}
      <div class="snare-addrow">${Object.entries(EFFECT_META).map(([k, m]) => `<button type="button" class="snare-btn sm" data-action="addEffect" data-type="${k}"><i class="fa-solid fa-plus"></i> ${m.label}</button>`).join("")}</div>
    </section>

    ${t.feature ? "" : this.#disableHTML(t, sug)}`;
  }

  #disableHTML(t, sug) {
    if (t.noDisable) return `<section class="snare-sec"><h3><i class="fa-solid fa-screwdriver-wrench"></i>Disable</h3>
      ${chk("noDisable", t.noDisable, "It can't be disabled (part of the place, a curse, a force of nature)")}</section>`;
    return `<section class="snare-sec"><h3><i class="fa-solid fa-screwdriver-wrench"></i>Disable</h3>
      ${chk("noDisable", t.noDisable, "It can't be disabled (part of the place, a curse, a force of nature)")}
      ${t.disable.map((d, i) => `<div class="snare-drow">
        ${sel(`disable.${i}.skill`, d.skill, SKILLS.map((s) => [s, cap(s)]))}
        ${num(`disable.${i}.dc`, d.dc)}
        ${sel(`disable.${i}.minProf`, d.minProf, RANK_OPTS, true)}
        <button type="button" class="snare-icon" data-action="delDisable" data-i="${i}" aria-label="Remove check"><i class="fa-solid fa-xmark"></i></button></div>`).join("")}
      <div class="snare-inline"><button type="button" class="snare-btn sm" data-action="addDisable"><i class="fa-solid fa-plus"></i> Add check</button>
        <span class="snare-muted small">Set all DCs:</span>
        ${[0, 2, 5].map((a) => `<button type="button" class="snare-btn sm ghost" data-action="useDisableDC" data-adj="${a}">${sug + a}</button>`).join("")}</div>
      <div class="snare-row">${field("Successes needed", "successes", num("successes", t.successes, 1, 10))}</div>
      ${chk("critFailTriggers", t.critFailTriggers, "A critical failure sets it off")}
</section>`;
  }

  #effectHTML(e, i, t, tokens, chipList, paintBtn) {
    const p = `effects.${i}.`;
    const meta = EFFECT_META[e.type];
    let body = "";
    if (e.type === "strike") {
      body = `<div class="snare-row">${field("Attack bonus", p + "attack", num(p + "attack", e.attack))}${field("Damage", p + "damage", txt(p + "damage", e.damage))}</div>
        <div class="snare-row">${field("Damage type", p + "dtype", sel(p + "dtype", e.dtype, DTYPES))}${field("Pyre animation", p + "pyre", sel(p + "pyre", e.pyre, PYRE_STRIKE))}</div>
        <p class="snare-muted small">Fired from the origin at the trap's targets, against their AC.</p>`;
    } else if (e.type === "burst") {
      body = `<div class="snare-row">${field("Center", p + "center", sel(p + "center", e.center, [["origin", "Origin point"], ["triggering", "Triggering creature"], ["custom", "Custom square"]]))}${field("Radius (squares)", p + "radius", num(p + "radius", e.radius, 0, 12))}</div>
        ${e.center === "custom" ? `<div class="snare-inline"><span class="snare-muted">Center ${e.cell ? "set" : "not set"}</span>${paintBtn("area", "fa-crosshairs", "Pick center", e.id)}</div>` : ""}
        <div class="snare-row">${field("Save", p + "save", sel(p + "save", e.save, [["reflex", "Reflex"], ["fortitude", "Fortitude"], ["will", "Will"]]))}${field("Save DC", p + "dc", num(p + "dc", e.dc))}</div>
        ${chk(p + "basic", e.basic, "Basic save")}
        <div class="snare-row">${field("Damage", p + "damage", txt(p + "damage", e.damage))}${field("Damage type", p + "dtype", sel(p + "dtype", e.dtype, DTYPES))}</div>
        ${field("Pyre animation", p + "pyre", sel(p + "pyre", e.pyre, PYRE_BURST))}`;
    } else if (e.type === "condition") {
      body = `<div class="snare-row">${field("Condition", p + "condition", sel(p + "condition", e.condition, CONDITIONS))}${VALUED.includes(e.condition) ? field("Value", p + "value", num(p + "value", e.value, 1, 4)) : ""}</div>
        ${field("Applies to", p + "appliesTo", sel(p + "appliesTo", e.appliesTo, [["targets", "The trap's targets"], ["failed", "Whoever was hit or failed the previous effect"]]))}`;
    } else {
      const cells = terrainCellsOf(t, e).length;
      body = `${field("Type", p + "terrain", sel(p + "terrain", e.terrain, Object.entries(TERRAIN)))}
        <p class="snare-rules">${esc(terrainRules(e))}</p>
        ${e.terrain === "slippery" ? `${field("Balance DC (Acrobatics)", p + "balanceDC", num(p + "balanceDC", e.balanceDC), "Player Core samples: untrained for uneven cobblestones, master for a smooth sheet of ice.")}
          ${chk(p + "offGuard", e.offGuard !== false, "Off-guard while standing on it (added and removed automatically)")}
          <div class="snare-row">${field("On a failed Balance", p + "failResult", sel(p + "failResult", e.failResult ?? "stop", [["stop", "Stops in place (rules)"], ["prone", "Falls prone"]]))}${field("Damage from a fall (optional)", p + "fallDamage", txt(p + "fallDamage", e.fallDamage ?? "", "e.g. 1d6"), "On a critical failure they always fall prone.")}</div>` : ""}
        ${e.terrain === "hazardous" ? `<div class="snare-row">${field("Damage per square", p + "hazDamage", txt(p + "hazDamage", e.hazDamage))}${field("Damage type", p + "hazType", sel(p + "hazType", e.hazType ?? "fire", DTYPES))}</div>` : ""}
        ${e.terrain !== "hazardous" ? `<p class="snare-muted small">Snare adds the extra cost to Foundry's ruler. Exempt creatures move at normal cost.</p>` : ""}
        <div class="snare-row">${field("Area", p + "area", sel(p + "area", e.area, [["trigger", "Trigger squares"], ["painted", "Painted area"]]), `${cells} square${cells === 1 ? "" : "s"}`)}
          ${field("Duration", p + "duration", sel(p + "duration", e.duration, [["permanent", "Permanent"], ["rounds", "Rounds"], ["manual", "Until I clear it"]]))}</div>
        ${e.area === "painted" ? `<div class="snare-inline">${paintBtn("area", "fa-vector-square", "Paint area", e.id)}<button type="button" class="snare-btn sm ghost" data-action="clearArea" data-id="${e.id}">Clear</button></div>` : ""}
        ${e.duration === "rounds" ? field("Rounds", p + "rounds", num(p + "rounds", e.rounds, 1, 100)) : ""}
        ${field("Who it affects", p + "affects", sel(p + "affects", e.affects, [["all", "Everyone"], ["enemies", "Enemies only (party moves normally)"], ["party", "Party only (enemies move normally)"]]))}
        <div class="snare-field"><span>Never affects these tokens</span><div class="snare-chips">${chipList(e.exemptTokens, "toggleExempt", `data-id="${e.id}"`)}</div></div>
        <div class="snare-field"><label for="snare-trait-${e.id}">Never affects creatures with these traits</label>
          <div class="snare-chips">${e.exemptTraits.map((tr) => `<span class="snare-chip">${esc(tr)}<button type="button" data-action="removeTrait" data-id="${e.id}" data-trait="${esc(tr)}" aria-label="Remove ${esc(tr)}"><i class="fa-solid fa-xmark"></i></button></span>`).join("")}</div>
          <input type="text" id="snare-trait-${e.id}" data-trait-input="${e.id}" placeholder="Type a trait and press Enter (cold, incorporeal…)"></div>`;
    }
    const icon = e.type === "terrain" && e.terrain !== "slippery" ? "fa-mountain" : meta.icon;
    return `<div class="snare-effect">
      <div class="snare-effect-h">
        <span class="snare-effect-num">${i + 1}</span><span class="snare-effect-icon"><i class="fa-solid ${icon}"></i></span>
        <span class="snare-effect-title">${meta.label}</span>
        <button type="button" class="snare-icon" data-action="upEffect" data-id="${e.id}" aria-label="Move up"${i === 0 ? " disabled" : ""}><i class="fa-solid fa-arrow-up"></i></button>
        <button type="button" class="snare-icon" data-action="downEffect" data-id="${e.id}" aria-label="Move down"${i === t.effects.length - 1 ? " disabled" : ""}><i class="fa-solid fa-arrow-down"></i></button>
        <button type="button" class="snare-icon" data-action="delEffect" data-id="${e.id}" aria-label="Remove effect"><i class="fa-solid fa-trash"></i></button>
      </div>
      <div class="snare-effect-b">${body}</div></div>`;
  }

  #paintHint() {
    if (this.paint?.mode === "trigger") return "Click or drag on squares to add or remove trigger squares.";
    if (this.paint?.mode === "origin") return "Click where the attack comes from: a wall slot, the ceiling, a statue.";
    const e = this.draft?.effects.find((x) => x.id === this.paint?.effectId);
    if (e?.type === "burst") return "Click the square where the burst is centered.";
    return "Click or drag on squares to paint the terrain area.";
  }

  /* ---------------- events ---------------- */

  #bind(root) {
    root.addEventListener("click", (ev) => {
      const el = ev.target.closest("[data-action]");
      if (!el || el.disabled || !root.contains(el)) return;
      ev.preventDefault();
      this.#action(el.dataset.action, el);
    });
    root.addEventListener("input", (ev) => {
      const el = ev.target;
      if (el.dataset.opacity !== undefined) { setOpacity(Number(el.value)); return; }
      if (!el.dataset.path || el.dataset.type === "bool" || el.tagName === "SELECT") return;
      this.#setPath(el.dataset.path, el);
      if (el.dataset.path === "name") { const n = root.querySelector(`.snare-item.is-on .snare-item-name`); if (n) n.textContent = el.value; }
      this.#queueSave();
    });
    root.addEventListener("change", (ev) => {
      const el = ev.target;
      if (el.dataset.createFrom !== undefined) { this.createFrom = el.value; return; }
      if (el.dataset.opacity !== undefined) { game.settings.set(MODULE_ID, "overlayOpacity", Number(el.value)); return; }
      if (el.dataset.wizLevel !== undefined) { this.wizard.level = Math.max(-1, Math.min(25, Number(el.value) || 0)); return; }
      if (el.dataset.activity) {
        const a = game.actors.get(el.dataset.activity);
        a?.setFlag(MODULE_ID, "activity", el.value);
        return;
      }
      if (!el.dataset.path) return;
      this.#setPath(el.dataset.path, el);
      this.#queueSave();
      if (el.tagName === "SELECT" || el.dataset.type === "bool" || ["level", "minProf"].includes(el.dataset.path)) this.render();
    });
    root.addEventListener("keydown", (ev) => {
      const el = ev.target;
      if (ev.key !== "Enter" || !el.dataset.traitInput) return;
      ev.preventDefault();
      const v = el.value.trim().toLowerCase();
      const e = this.draft?.effects.find((x) => x.id === el.dataset.traitInput);
      if (!v || !e) return;
      if (!e.exemptTraits.includes(v)) e.exemptTraits.push(v);
      this.#queueSave();
      this.render().then(() => this.element.querySelector(`#snare-trait-${e.id}`)?.focus());
    });
  }

  #setPath(path, el) {
    const parts = path.split(".");
    let o = this.draft;
    for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
    const last = parts.at(-1);
    o[last] = el.dataset.type === "num" ? (el.value === "" ? 0 : Number(el.value)) : el.dataset.type === "bool" ? el.checked : el.value;
  }

  async #action(action, el) {
    const t = this.draft, scene = this.scene;
    const eff = (id) => t?.effects.find((e) => e.id === id);
    const done = () => { this.#queueSave(); this.render(); };
    switch (action) {
      case "tab": if (this.wizard) return; this.tab = el.dataset.tab; this.stopPaint(false); return this.render();
      case "select": if (this.wizard) return ui.notifications.info("Snare: finish or cancel the new trap first."); this.tab = "traps"; this.#select(el.dataset.id); return this.render();
      case "wizStart": return this.#wizStart();
      case "wizPick": this.wizard.tplId = el.dataset.tpl; return this.render();
      case "wizHidden": return this.#wizHidden(Number(el.dataset.id));
      case "wizNext": return this.#wizNext();
      case "wizBack": return this.#wizBack();
      case "wizCancel": return this.#wizCancel();
      case "wizSkipOrigin": this.draft.origin = null; this.stopPaint(false); return this.#wizGo(1);
      case "create": return this.#create();
      case "delete": {
        const ok = await foundry.applications.api.DialogV2.confirm({ window: { title: "Delete trap" }, content: `<p>Delete <b>${esc(t.name)}</b> from this scene?</p>`, rejectClose: false });
        if (!ok) return;
        const saved = getTrap(scene, t.id);
        if (saved) await clearTerrain(scene, saved);
        drafts.delete(t.id);
        const id = t.id; this.draft = null; this.selectedId = null;
        await deleteTrap(scene, id);
        return this.render();
      }
      case "duplicate": {
        this.#flush();
        const copy = { ...clone(pickConfig(t)), id: foundry.utils.randomID(), name: `${t.name} (copy)`, state: freshState() };
        await createTrap(scene, copy);
        this.#select(copy.id);
        return this.render();
      }
      case "saveLib": {
        const lib = [...(game.settings.get(MODULE_ID, "library") ?? [])].filter((x) => x.name !== t.name);
        const item = clone(pickConfig(t));
        item.trigger = []; item.origin = null; item.triggerIgnore = [];
        item.effects.forEach((e) => { if (e.cells) e.cells = []; if (e.cell) e.cell = null; if (e.exemptTokens) e.exemptTokens = []; });
        lib.push(item);
        await game.settings.set(MODULE_ID, "library", lib);
        ui.notifications.info(`Snare: saved "${t.name}" to your library (without its squares).`);
        return this.render();
      }
      case "paint": {
        const same = this.paint?.mode === el.dataset.mode && (this.paint.effectId ?? "") === (el.dataset.effect ?? "");
        if (same) return this.stopPaint();
        return this.startPaint(el.dataset.mode, el.dataset.effect || null);
      }
      case "stopPaint": return this.stopPaint();
      case "toggleOverlay": await game.settings.set(MODULE_ID, "showOverlay", !game.settings.get(MODULE_ID, "showOverlay")); return this.render();
      case "clearTrigger": t.trigger = []; return done();
      case "clearOrigin": t.origin = null; return done();
      case "clearArea": { const e = eff(el.dataset.id); if (e) e.cells = []; return done(); }
      case "toggleIgnore": { const i = t.triggerIgnore.indexOf(el.dataset.token); i >= 0 ? t.triggerIgnore.splice(i, 1) : t.triggerIgnore.push(el.dataset.token); return done(); }
      case "toggleExempt": { const e = eff(el.dataset.id); const i = e.exemptTokens.indexOf(el.dataset.token); i >= 0 ? e.exemptTokens.splice(i, 1) : e.exemptTokens.push(el.dataset.token); return done(); }
      case "removeTrait": { const e = eff(el.dataset.id); e.exemptTraits = e.exemptTraits.filter((x) => x !== el.dataset.trait); return done(); }
      case "addEffect": t.effects.push(newEffect(el.dataset.type, t.level)); return done();
      case "delEffect": t.effects = t.effects.filter((e) => e.id !== el.dataset.id); if (this.paint?.effectId === el.dataset.id) this.stopPaint(false); return done();
      case "upEffect": case "downEffect": {
        const i = t.effects.findIndex((e) => e.id === el.dataset.id), j = action === "upEffect" ? i - 1 : i + 1;
        if (i < 0 || j < 0 || j >= t.effects.length) return;
        [t.effects[i], t.effects[j]] = [t.effects[j], t.effects[i]];
        return done();
      }
      case "addDisable": t.disable.push({ skill: "athletics", dc: dcForLevel(t.level), minProf: 0 }); return done();
      case "delDisable": t.disable.splice(Number(el.dataset.i), 1); return done();
      case "useDC": t.stealthDC = dcForLevel(t.level) + Number(el.dataset.adj); return done();
      case "useDisableDC": { const v = dcForLevel(t.level) + Number(el.dataset.adj); t.disable.forEach((d) => (d.dc = v)); return done(); }
      case "rearm": this.#flush(); return updateState(scene, t.id, { status: "armed", progress: 0, rearmIn: 0 });
      case "nextRound": return tickRound(scene);
      case "clearTerrain": { const saved = getTrap(scene, t.id); if (saved) await clearTerrain(scene, saved); return; }
      case "resetDetect": return updateState(scene, t.id, { detectedBy: [], rolledBy: [] });
      case "pointOut": {
        const ids = scene.tokens.filter((d) => d.actor?.type === "character" && alliance(d.actor) === "party").map((d) => d.actor.id);
        const saved = getTrap(scene, t.id);
        return updateState(scene, t.id, { detectedBy: [...new Set([...saved.state.detectedBy, ...ids])] });
      }
      case "fireNow": {
        this.#flush();
        const tok = canvas.tokens.controlled[0]?.document;
        if (!tok) return ui.notifications.info("Snare: select the token the trap should hit, then press Fire.");
        return fireTrap(scene, t.id, tok.id, { skipConfirm: true });
      }
      case "disable": {
        const actorId = this.element.querySelector("#snare-dis-actor")?.value;
        const row = Number(this.element.querySelector("#snare-dis-row")?.value ?? 0);
        this.#flush();
        return attemptDisable(scene, t.id, actorId, row);
      }
    }
  }

  async #create() {
    const scene = this.scene;
    const level = Math.max(1, ...game.actors.filter((a) => a.type === "character" && a.hasPlayerOwner).map((a) => a.level ?? 1));
    let trap = blankTrap(level);
    trap.partyLevel = level;
    const from = this.createFrom;
    if (from.startsWith("lib:")) {
      const item = (game.settings.get(MODULE_ID, "library") ?? [])[Number(from.slice(4))];
      if (item) trap = { ...blankTrap(item.level), ...clone(item), id: foundry.utils.randomID(), state: freshState() };
      trap.effects.forEach((e) => (e.id = foundry.utils.randomID()));
    } else if (from.startsWith("comp:")) {
      trap = await this.#fromCompendium(from.slice(5), level) ?? trap;
    }
    await createTrap(scene, trap);
    this.tab = "traps";
    this.#select(trap.id);
    await this.render();
    this.startPaint("trigger");
  }

  async #fromCompendium(id, partyLevel) {
    try {
      const doc = await game.packs.get("pf2e.hazards")?.getDocument(id);
      if (!doc) return null;
      const sys = doc.system;
      const level = sys.details?.level?.value ?? 0;
      const trap = blankTrap(level);
      trap.name = doc.name;
      trap.partyLevel = partyLevel;
      trap.kind = sys.details?.isComplex ? "complex" : "simple";
      const traits = sys.traits?.value ?? [];
      trap.magical = (Array.isArray(traits) ? traits : [...traits]).includes("magical");
      const stealth = sys.attributes?.stealth ?? {};
      trap.stealthDC = (Number(stealth.value) || 0) + 10;
      const detail = String(stealth.details ?? "").toLowerCase();
      trap.minProf = detail.includes("legendary") ? 4 : detail.includes("master") ? 3 : detail.includes("expert") ? 2 : detail.includes("trained") ? 1 : 0;
      const disableText = String(sys.details?.disable ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      const rows = [...disableText.matchAll(/DC\s*(\d+)\s+([A-Za-z]+)(?:\s*\((trained|expert|master|legendary)\))?/gi)]
        .map((m) => ({ skill: m[2].toLowerCase(), dc: Number(m[1]), minProf: ["", "trained", "expert", "master", "legendary"].indexOf((m[3] ?? "").toLowerCase()) }))
        .filter((r) => SKILLS.includes(r.skill)).map((r) => ({ ...r, minProf: Math.max(0, r.minProf) }));
      if (rows.length) trap.disable = rows;
      const descText = String(sys.details?.description ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      trap.notes = [disableText && `Disable: ${disableText}`, descText].filter(Boolean).join(" · ").slice(0, 600);
      for (const item of doc.items.filter((i) => i.type === "melee")) {
        const dmg = Object.values(item.system?.damageRolls ?? {})[0];
        const e = newEffect("strike", level);
        e.attack = Number(item.system?.bonus?.value) || e.attack;
        if (dmg?.damage) { e.damage = dmg.damage; e.dtype = dmg.damageType ?? e.dtype; }
        trap.effects.push(e);
        break;
      }
      ui.notifications.info(`Snare: loaded ${doc.name}. Check the effects: hazard abilities written as text need setting up by hand.`);
      return trap;
    } catch (err) {
      console.warn(`${MODULE_ID} | could not import the hazard`, err);
      ui.notifications.warn("Snare: could not read that hazard. Starting from a blank trap.");
      return null;
    }
  }

  /* ---------------- guided creation ---------------- */

  #partyLevel() {
    return Math.max(1, ...game.actors.filter((a) => a.type === "character" && a.hasPlayerOwner).map((a) => a.level ?? 1));
  }

  #wizSteps() {
    const tpl = TEMPLATES.find((x) => x.id === this.wizard?.tplId);
    return ["type", "where", ...(tpl?.origin ? ["origin"] : []), "hidden", "who", "review"];
  }

  #wizStart() {
    this.#flush();
    this.stopPaint(false);
    drafts.delete(this.selectedId);
    this.selectedId = null; this.draft = null;
    this.tab = "traps";
    this.wizard = { step: "type", tplId: null, level: this.#partyLevel(), hidden: 1, trapId: null, builtFor: null };
    this.render();
  }

  async #wizCancel() {
    this.stopPaint(false);
    const id = this.wizard?.trapId;
    this.wizard = null;
    if (id) { drafts.delete(id); this.draft = null; this.selectedId = null; await deleteTrap(this.scene, id); }
    this.render();
  }

  /** Applies the chosen template to the draft (again, if the GM went back and picked another). */
  async #wizBuild() {
    const w = this.wizard;
    const tpl = TEMPLATES.find((x) => x.id === w.tplId);
    const signature = `${w.tplId}:${w.level}`;
    if (w.trapId && w.builtFor === signature) return;
    const h = HIDDENNESS.find((x) => x.id === w.hidden) ?? HIDDENNESS[1];
    const dc = dcForLevel(w.level) + h.adj;
    const fields = {
      name: tpl.label, level: w.level, partyLevel: this.#partyLevel(), magical: !!tpl.magical,
      stealthDC: dc, minProf: h.minProf, effects: tpl.build(w.level),
      disable: [{ skill: tpl.skill, dc, minProf: Math.max(1, h.minProf) }]
    };
    if (!w.trapId) {
      const trap = { ...blankTrap(w.level), ...fields };
      await createTrap(this.scene, trap);
      w.trapId = trap.id;
      this.#select(trap.id);
    } else {
      Object.assign(this.draft, fields, { trigger: this.draft.trigger, origin: this.draft.origin });
      this.#queueSave();
    }
    w.builtFor = signature;
  }

  #wizHidden(id) {
    if (!this.draft) return;
    if (id === FEATURE_CARD.id) {
      this.wizard.hidden = id;
      Object.assign(this.draft, { feature: true, noDisable: true, playersSee: false, minProf: 0 });
      this.#queueSave();
      return this.render();
    }
    const h = HIDDENNESS.find((x) => x.id === id);
    if (!h) return;
    this.wizard.hidden = id;
    Object.assign(this.draft, { feature: false, noDisable: false, playersSee: true });
    const dc = dcForLevel(this.draft.level) + h.adj;
    this.draft.minProf = h.minProf;
    this.draft.stealthDC = dc;
    this.draft.disable.forEach((d) => { d.dc = dc; d.minProf = Math.max(1, h.minProf); });
    this.#queueSave();
    this.render();
  }

  async #wizGo(delta) {
    const steps = this.#wizSteps();
    const i = steps.indexOf(this.wizard.step);
    const next = steps[Math.max(0, Math.min(steps.length - 1, i + delta))];
    this.stopPaint(false);
    this.wizard.step = next;
    if (next === "where") return this.startPaint("trigger");
    if (next === "origin") return this.startPaint("origin");
    return this.render();
  }

  async #wizNext() {
    const w = this.wizard;
    if (w.step === "type") {
      if (!w.tplId) return ui.notifications.info("Snare: pick what kind of trap it is.");
      await this.#wizBuild();
    }
    if (w.step === "where" && !this.draft?.trigger.length) return ui.notifications.info("Snare: paint at least one square on the map.");
    if (w.step === "review") {
      this.wizard = null;
      await this.#flush();
      ui.notifications.info(`Snare: ${this.draft?.name ?? "the trap"} is ${this.draft?.feature ? "active on the scene" : "armed"}.`);
      return this.render();
    }
    return this.#wizGo(1);
  }

  #wizBack() {
    if (this.wizard.step === "type") return;
    return this.#wizGo(-1);
  }

  #summary(t) {
    const n = t.trigger.length;
    if (t.feature) {
      const ter = t.effects.filter((e) => e.type === "terrain");
      return `<p>These <b>${n} square${n === 1 ? "" : "s"}</b> are part of the scene and always active.</p>
        ${ter.map((e) => `<p><b>${TERRAIN[e.terrain]}</b>${e.affects !== "all" ? ` (${e.affects === "enemies" ? "enemies only" : "party only"})` : ""}: ${esc(terrainRules(e))}</p>`).join("")}
        ${ter.some((e) => e.exemptTokens.length || e.exemptTraits.length) ? `<p>Some creatures move through it normally.</p>` : ""}
        <p>Nobody rolls to find it, and it can't be disabled. ${t.playersSee ? "Players see it marked on the map." : "Players don't see it marked on the map."}</p>`;
    }
    const parts = [];
    parts.push(`When ${t.triggeredBy === "party" ? "a party member" : "someone"} steps on the <b>${n} square${n === 1 ? "" : "s"}</b>${t.triggerIgnore.length ? ` (except ${t.triggerIgnore.map((id) => esc(this.scene.tokens.get(id)?.name ?? "?")).join(", ")})` : ""}:`);
    const lines = t.effects.map((e) => {
      if (e.type === "strike") return `${t.origin ? "a projectile flies from the origin" : "it strikes"}: attack <b>+${e.attack}</b>, <b>${esc(e.damage)} ${e.dtype}</b>`;
      if (e.type === "burst") return e.radius > 0
        ? `a burst of ${e.radius * 5} ft: <b>${e.basic ? "basic " : ""}${cap(e.save)} DC ${e.dc}</b>, <b>${esc(e.damage)} ${e.dtype}</b>`
        : `<b>${cap(e.save)} DC ${e.dc}</b>; on a failure, <b>${esc(e.damage)} ${e.dtype}</b>`;
      if (e.type === "condition") return `${e.appliesTo === "failed" ? "whoever fails or is hit" : "the target"} becomes <b>${CONDITIONS.find(([s]) => s === e.condition)?.[1] ?? e.condition}${VALUED.includes(e.condition) ? ` ${e.value}` : ""}</b>`;
      return `the floor becomes <b>${TERRAIN[e.terrain].toLowerCase()}</b>${e.affects !== "all" ? ` (${e.affects === "enemies" ? "enemies only" : "party only"})` : ""}${e.exemptTokens.length || e.exemptTraits.length ? ", with exceptions" : ""}. ${esc(terrainRules(e))}`;
    });
    const find = t.minProf === 0 ? `Anyone can notice it (DC ${t.stealthDC}).` : `Found only by characters Searching with ${RANKS[t.minProf]} Perception (DC ${t.stealthDC}).`;
    const dis = t.noDisable ? "" : t.disable.map((d) => `${cap(d.skill)} DC ${d.dc}${d.minProf ? ` (${RANKS[d.minProf]})` : ""}`).join(" or ");
    return `<p>${parts.join("")}</p>${lines.length ? `<ul>${lines.map((l) => `<li>${l}</li>`).join("")}</ul>` : `<p class="snare-muted">No effects yet. Add them in the builder after finishing.</p>`}
      <p>${find}</p><p>${t.noDisable ? "It can't be disabled." : `Disable: ${dis || "nothing set"}.`}</p>`;
  }

  #wizardHTML() {
    const w = this.wizard;
    const steps = this.#wizSteps();
    const idx = steps.indexOf(w.step);
    const t = this.draft;
    const LABELS = { type: "Type", where: "Trigger", origin: "Origin", hidden: "Hidden", who: "Who", review: "Review" };
    const dots = `<ol class="snare-steps">${steps.map((s, i) => `<li class="${i < idx ? "done" : i === idx ? "now" : ""}"><span>${i < idx ? '<i class="fa-solid fa-check"></i>' : i + 1}</span>${LABELS[s]}</li>`).join("")}</ol>`;
    let body = "", nextLabel = "Next", nextDisabled = false;

    if (w.step === "type") {
      body = `<h2 class="snare-wiz-q">What kind of trap is it?</h2>
        <div class="snare-cards">${TEMPLATES.map((tp) => `<button type="button" class="snare-card-btn${w.tplId === tp.id ? " is-on" : ""}" data-action="wizPick" data-tpl="${tp.id}" aria-pressed="${w.tplId === tp.id}">
          <span class="snare-card-icon"><i class="fa-solid ${tp.icon}"></i></span><span class="snare-card-label">${tp.label}</span><span class="snare-card-blurb">${tp.blurb}</span></button>`).join("")}</div>
        <div class="snare-wiz-level"><label for="snare-wiz-level">Trap level</label><input type="number" id="snare-wiz-level" data-wiz-level value="${w.level}" min="-1" max="25"><small>Your party is level ${this.#partyLevel()}. Damage and DCs follow the level.</small></div>`;
      nextDisabled = !w.tplId;
    } else if (w.step === "where") {
      body = `<h2 class="snare-wiz-q">Where is the trigger?</h2>
        <p class="snare-wiz-help">Click or drag on the map to paint the squares that set it off: a pressure plate, a tripwire, a chest. Click a painted square again to remove it.</p>
        <div class="snare-wiz-live"><i class="fa-solid fa-paintbrush"></i><span class="snare-wiz-count">${t.trigger.length} square${t.trigger.length === 1 ? "" : "s"} painted</span>${t.trigger.length ? `<button type="button" class="snare-btn sm ghost" data-action="clearTrigger">Clear</button>` : ""}</div>`;
      nextDisabled = !t.trigger.length;
    } else if (w.step === "origin") {
      body = `<h2 class="snare-wiz-q">Where does the attack come from?</h2>
        <p class="snare-wiz-help">Click one square on the map: a slot in the wall, the ceiling, a statue's mouth. It can be far from the trigger.</p>
        <div class="snare-wiz-live"><i class="fa-solid fa-crosshairs"></i><span>${t.origin ? "Origin placed. Click again to move it." : "Waiting for a click on the map…"}</span>
          ${t.origin ? `<button type="button" class="snare-btn sm" data-action="paint" data-mode="origin" data-effect="">Move it</button>` : ""}</div>
        <button type="button" class="snare-btn sm ghost" data-action="wizSkipOrigin">Skip: it comes from the trigger itself</button>`;
    } else if (w.step === "hidden") {
      const terrainOnly = t.effects.length && t.effects.every((e) => e.type === "terrain");
      const cards = [...(terrainOnly ? [{ ...FEATURE_CARD, dc: null }] : []), ...HIDDENNESS.map((h) => ({ ...h, dc: dcForLevel(t.level) + h.adj }))];
      body = `<h2 class="snare-wiz-q">${terrainOnly ? "Is it part of the scene, or a hidden trap?" : "How well hidden is it?"}</h2>
        <div class="snare-cards three">${cards.map((h) => `<button type="button" class="snare-card-btn${w.hidden === h.id ? " is-on" : ""}" data-action="wizHidden" data-id="${h.id}" aria-pressed="${w.hidden === h.id}">
          <span class="snare-card-icon"><i class="fa-solid ${h.icon}"></i></span><span class="snare-card-label">${h.label}</span><span class="snare-card-blurb">${h.blurb}</span>${h.dc ? `<span class="snare-card-dc">DC ${h.dc}</span>` : ""}</button>`).join("")}</div>`;
    } else if (w.step === "who") {
      const tokens = this.scene.tokens.filter((d) => d.actor).sort((a, b) => a.name.localeCompare(b.name));
      const chips = (list, action, extra = "") => tokens.map((d) => `<button type="button" class="snare-chip${list.includes(d.id) ? " on" : ""}" data-action="${action}" data-token="${d.id}" ${extra} aria-pressed="${list.includes(d.id)}"><span class="snare-dot ${alliance(d.actor)}"></span>${esc(d.name)}</button>`).join("") || `<span class="snare-muted small">No tokens on this scene.</span>`;
      const ter = t.effects.map((e, i) => [e, i]).filter(([e]) => e.type === "terrain");
      body = `<h2 class="snare-wiz-q">Who does it affect?</h2>
        ${t.feature ? "" : `<div class="snare-row">${field("Who can set it off", "triggeredBy", sel("triggeredBy", t.triggeredBy, [["any", "Any creature"], ["party", "Only the party"]]))}</div>
        <div class="snare-field"><span>Never sets it off (for example, whoever built it)</span><div class="snare-chips">${chips(t.triggerIgnore, "toggleIgnore")}</div></div>`}
        ${ter.map(([e, i]) => `<div class="snare-wiz-sub"><h3><i class="fa-solid fa-snowflake"></i> The ${TERRAIN[e.terrain].toLowerCase()}</h3>
          <p class="snare-rules">${esc(terrainRules(e))}</p>
          ${field("Who it affects", `effects.${i}.affects`, sel(`effects.${i}.affects`, e.affects, [["all", "Everyone"], ["enemies", "Enemies only"], ["party", "Party only"]]))}
          <div class="snare-field"><span>These move through it normally</span><div class="snare-chips">${chips(e.exemptTokens, "toggleExempt", `data-id="${e.id}"`)}</div></div>
          <div class="snare-field"><label for="snare-trait-${e.id}">So do creatures with these traits</label>
            <div class="snare-chips">${e.exemptTraits.map((tr) => `<span class="snare-chip">${esc(tr)}<button type="button" data-action="removeTrait" data-id="${e.id}" data-trait="${esc(tr)}" aria-label="Remove ${esc(tr)}"><i class="fa-solid fa-xmark"></i></button></span>`).join("")}</div>
            <input type="text" id="snare-trait-${e.id}" data-trait-input="${e.id}" placeholder="Type a trait and press Enter (cold, incorporeal…)"></div></div>`).join("")}`;
    } else if (w.step === "review") {
      body = `<h2 class="snare-wiz-q">Ready to arm it?</h2>
        ${field("Name", "name", txt("name", t.name))}
        <div class="snare-summary">${this.#summary(t)}</div>
        ${t.feature ? "" : chk("confirm", t.confirm, "Ask me before it fires (players see nothing until you decide)")}
        ${t.effects.some((e) => e.type === "terrain") ? chk("playersSee", t.playersSee, "Players see the terrain marked on the map") : ""}
        <p class="snare-muted small">Everything can be changed later in the builder: damage, DCs, more effects, terrain areas.</p>`;
      nextLabel = t.feature ? "Activate it" : "Arm the trap";
      body = body.replace("Ready to arm it?", t.feature ? "Ready to add it to the scene?" : "Ready to arm it?");
    }

    return `<div class="snare-wizard">
      ${dots}
      <div class="snare-wiz-body">${body}</div>
      <div class="snare-wiz-foot">
        <button type="button" class="snare-btn ghost" data-action="wizCancel">Cancel</button>
        <span class="snare-spacer"></span>
        ${idx > 0 ? `<button type="button" class="snare-btn" data-action="wizBack"><i class="fa-solid fa-arrow-left"></i> Back</button>` : ""}
        <button type="button" class="snare-btn primary" data-action="wizNext"${nextDisabled ? " disabled" : ""}>${nextLabel} ${w.step === "review" ? '<i class="fa-solid fa-check"></i>' : '<i class="fa-solid fa-arrow-right"></i>'}</button>
      </div>
    </div>`;
  }

  /* ---------------- painting on the canvas ---------------- */

  startPaint(mode, effectId = null) {
    this.stopPaint(false);
    if (!this.draft || !canvas?.ready) return;
    this.paint = { mode, effectId, op: null, last: null };
    const view = canvas.app.view;
    if (!this._fullPos) {
      this._fullPos = { left: this.position.left, top: this.position.top, width: this.position.width, height: this.position.height };
      this.setPosition({ width: 360, height: "auto", left: 110, top: 70 });
    }
    view.style.cursor = "crosshair";
    const toCell = (ev) => {
      const p = typeof canvas.canvasCoordinatesFromClient === "function"
        ? canvas.canvasCoordinatesFromClient({ x: ev.clientX, y: ev.clientY })
        : canvas.stage.worldTransform.applyInverse(new PIXI.Point(ev.clientX - view.getBoundingClientRect().left, ev.clientY - view.getBoundingClientRect().top));
      return pointCell(p);
    };
    // Listen on window in the capture phase: it runs before Foundry's and PIXI's own handlers,
    // so a click on a token or an empty square is always ours while painting.
    const onBoard = (ev) => ev.target === view;
    const swallow = (ev) => { ev.preventDefault(); ev.stopPropagation(); ev.stopImmediatePropagation(); };
    const down = (ev) => {
      if (!onBoard(ev)) return;
      if (ev.button === 2) { swallow(ev); this.stopPaint(); return; }
      if (ev.button !== 0) return;
      swallow(ev);
      this.#paintAt(toCell(ev), true);
    };
    const move = (ev) => {
      if (!onBoard(ev)) { setHover(null); return; }
      const cell = toCell(ev);
      setHover(cell);
      if (!(ev.buttons & 1) || !this.paint?.op) return;
      swallow(ev);
      this.#paintAt(cell, false);
    };
    const up = (ev) => {
      if (this.paint?.op && onBoard(ev)) swallow(ev);
      if (this.paint) this.paint.op = null;
    };
    const ctx = (ev) => { if (onBoard(ev)) swallow(ev); };
    const block = (ev) => { if (onBoard(ev) && ev.button === 0) swallow(ev); };
    for (const type of ["mousedown", "click", "dblclick"]) window.addEventListener(type, block, true);
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("contextmenu", ctx, true);
    this.#canvasHandlers = { view, down, move, up, ctx, block };
    this.render();
    canvas.app.view.focus?.();
  }

  stopPaint(rerender = true) {
    const h = this.#canvasHandlers;
    if (h) {
      window.removeEventListener("pointerdown", h.down, true);
      window.removeEventListener("pointermove", h.move, true);
      window.removeEventListener("pointerup", h.up, true);
      window.removeEventListener("contextmenu", h.ctx, true);
      for (const type of ["mousedown", "click", "dblclick"]) window.removeEventListener(type, h.block, true);
      h.view.style.cursor = "";
    }
    setHover(null);
    if (this._fullPos) {
      const pos = this._fullPos;
      this._fullPos = null;
      if (this.rendered) this.setPosition(pos);
    }
    this.#canvasHandlers = null;
    const was = !!this.paint;
    this.paint = null;
    if (was) { this.#flush(); if (rerender && this.rendered) this.render(); }
  }

  #paintAt(cell, first) {
    const t = this.draft, pm = this.paint;
    if (!t || !pm) return;
    const k = key(cell);
    if (!first && pm.last === k) return;
    pm.last = k;
    const toggle = (list) => {
      const i = list.findIndex((c) => key(c) === k);
      if (first) pm.op = i >= 0 ? "remove" : "add";
      if (pm.op === "add" && i < 0) list.push(cell);
      if (pm.op === "remove" && i >= 0) list.splice(i, 1);
    };
    if (pm.mode === "trigger") toggle(t.trigger);
    else if (pm.mode === "origin") { t.origin = cell; this.#queueSave(); this.stopPaint(); return; }
    else if (pm.mode === "area") {
      const e = t.effects.find((x) => x.id === pm.effectId);
      if (!e) return;
      if (e.type === "burst") { e.center = "custom"; e.cell = cell; this.#queueSave(); this.stopPaint(); return; }
      if (e.area !== "painted") { e.area = "painted"; e.cells = t.trigger.map((c) => [...c]); }
      toggle(e.cells);
    }
    this.#queueSave();
    const wc = this.element?.querySelector(".snare-wiz-count");
    if (wc && pm.mode === "trigger") wc.textContent = `${t.trigger.length} square${t.trigger.length === 1 ? "" : "s"} painted`;
    if (wc && pm.mode === "area") { const e = t.effects.find((x) => x.id === pm.effectId); if (e) wc.textContent = `${terrainCellsOf(t, e).length} squares`; }
    const next = this.element?.querySelector("[data-action=wizNext]");
    if (next && this.wizard?.step === "where") next.disabled = !t.trigger.length;
    const count = this.element?.querySelector(".snare-sec .snare-inline .snare-muted");
    if (count && pm.mode === "trigger") count.textContent = `${t.trigger.length} trigger square${t.trigger.length === 1 ? "" : "s"}`;
  }
}

export { isActiveGM, tokenCell };
