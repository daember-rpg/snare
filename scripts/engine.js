import { MODULE_ID, RANKS, VALUED, CONDITIONS, TERRAIN } from "./constants.js";
import {
  getTrap, getTraps, updateState, cellCenter, tokenCell, cheb, triggerKeys, terrainCellsOf, triggerCentroid,
  degreeOf, DEGREES, whisperGM, whisperOwners, announce, esc, exemptReason, cellTopLeft, isPC, isPartyToken
} from "./store.js";
import { onMessage, broadcastFx } from "./socket.js";
import { requestDraw } from "./overlay.js";

const BLIND = () => CONST.DICE_ROLL_MODES?.BLIND ?? "blindroll";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fireLock = new Set();

/* =========================================================================
   Detection (runs on the client that moves the token)
   ========================================================================= */

export function activityOf(actor) {
  return actor?.getFlag?.(MODULE_ID, "activity") ?? "";
}

/**
 * Secret Perception check against the trap, following GM Core: anyone gets a check for a trap with no minimum
 * proficiency; otherwise only a creature that is Searching and has the rank.
 * @returns {Promise<{found: boolean}>}
 */
export async function rollDetection(trap, tokenDoc) {
  const actor = tokenDoc.actor;
  if (!actor) return { found: false };
  const activity = activityOf(actor);
  const perception = actor.perception ?? null;
  const rank = perception?.rank ?? actor.system?.perception?.rank ?? 0;
  const name = esc(trap.name), who = esc(tokenDoc.name);

  if (trap.magical && activity === "detect-magic") {
    if (trap.minProf === 0) {
      await whisperOwners(actor, `${who}'s <i>detect magic</i> picks up a magical aura nearby.`, "fa-wand-sparkles");
      await whisperGM(`${who} senses the magic of <b>${name}</b> (presence only).`, "fa-wand-sparkles");
    } else {
      await whisperGM(`${who} is using Detect Magic, but it can't find <b>${name}</b>: it needs a minimum proficiency.`, "fa-wand-sparkles");
    }
  }

  if (trap.minProf > 0 && !(activity === "search" && rank >= trap.minProf)) {
    const why = activity === "search"
      ? `${who} is Searching but needs ${RANKS[trap.minProf]} Perception.`
      : `${who} isn't Searching, and <b>${name}</b> needs Search with ${RANKS[trap.minProf]} Perception.`;
    await whisperGM(`${why} No check.`, "fa-eye-slash");
    return { found: false };
  }

  let degree = null, total = "?";
  try {
    const roll = await perception.roll({
      dc: { value: trap.stealthDC }, rollMode: BLIND(), skipDialog: true, traits: ["secret"],
      extraRollOptions: ["snare:detect"]
    });
    if (roll) { degree = roll.degreeOfSuccess ?? null; total = roll.total; }
  } catch (err) {
    console.warn(`${MODULE_ID} | PF2e Perception roll failed, using a plain roll`, err);
  }
  if (degree === null) {
    const mod = perception?.mod ?? 0;
    const r = await new Roll(`1d20 + ${mod}`).evaluate();
    total = r.total;
    degree = degreeOf(r.total, trap.stealthDC, r.dice[0]?.total);
    await r.toMessage({ speaker: ChatMessage.getSpeaker({ actor }), flavor: `Perception (secret): ${name}` }, { rollMode: BLIND() });
  }

  const found = degree >= 2;
  if (found) {
    await whisperGM(`<b>${who}</b> found <b>${name}</b>: Perception ${total} vs DC ${trap.stealthDC}. The token stopped.`, "fa-eye");
    await whisperOwners(actor, `You notice something wrong ahead: <b>${name}</b>.`, "fa-eye");
  } else {
    await whisperGM(`<b>${who}</b> missed <b>${name}</b>: Perception ${total} vs DC ${trap.stealthDC}.`, "fa-eye-slash");
  }
  return { found };
}

/* =========================================================================
   GM side
   ========================================================================= */

export function registerEngine() {
  onMessage("detect", async ({ sceneId, trapId, actorId, found }) => {
    const scene = game.scenes.get(sceneId);
    const trap = getTrap(scene, trapId);
    if (!trap) return;
    const rolledBy = [...new Set([...trap.state.rolledBy, actorId])];
    const detectedBy = found ? [...new Set([...trap.state.detectedBy, actorId])] : trap.state.detectedBy;
    await updateState(scene, trapId, { rolledBy, detectedBy });
  });
  onMessage("fire", ({ sceneId, trapId, tokenId }) => fireTrap(game.scenes.get(sceneId), trapId, tokenId));
  onMessage("condition", async ({ sceneId, tokenId, slug }) => {
    const doc = game.scenes.get(sceneId)?.tokens.get(tokenId);
    if (doc?.actor) await applyCondition(doc.actor, slug, 1);
  });
}

async function applyCondition(actor, slug, value) {
  try {
    if (VALUED.includes(slug)) {
      const current = actor.getCondition?.(slug)?.value ?? 0;
      if (current >= value) return;
      await actor.increaseCondition(slug, { value });
    } else if (!actor.hasCondition?.(slug)) {
      if (typeof actor.increaseCondition === "function") await actor.increaseCondition(slug);
      else await actor.toggleCondition?.(slug);
    }
  } catch (err) {
    console.warn(`${MODULE_ID} | could not apply ${slug}`, err);
  }
}

function damageRollClass() {
  return CONFIG.Dice.rolls.find((r) => r.name === "DamageRoll") ?? null;
}

/** Posts a PF2e damage roll (with its apply buttons) when possible, a plain roll otherwise. */
async function rollDamage(formula, type, { double = false, flavor, alias }) {
  const inner = double ? `2*(${formula})` : formula;
  let roll = null;
  const DR = damageRollClass();
  if (DR) {
    try { roll = await new DR(`(${inner})[${type}]`).evaluate(); } catch (err) { roll = null; }
  }
  if (!roll) roll = await new Roll(inner).evaluate();
  await roll.toMessage({ speaker: { alias }, flavor });
  return roll;
}

function tokenPoint(doc) {
  return cellCenter(tokenCell(doc));
}

async function resolveTargets(scene, trap, trigger) {
  if (trap.targets === "allInTrigger") {
    const keys = triggerKeys(trap);
    const list = scene.tokens.filter((t) => t.actor && keys.has(tokenCell(t).join(",")));
    return list.length ? list : [trigger].filter(Boolean);
  }
  if (trap.targets === "nearestOrigin" && trap.origin) {
    const list = scene.tokens.filter((t) => t.actor && !t.hidden);
    list.sort((a, b) => cheb(tokenCell(a), trap.origin) - cheb(tokenCell(b), trap.origin));
    return list.slice(0, 1);
  }
  return [trigger].filter(Boolean);
}

export async function fireTrap(scene, trapId, tokenId, { skipConfirm = false } = {}) {
  if (!scene || fireLock.has(trapId)) return;
  const trap = getTrap(scene, trapId);
  if (!trap || trap.state.status !== "armed") return;
  const trigger = scene.tokens.get(tokenId) ?? null;
  fireLock.add(trapId);
  try {
    if (trap.confirm && !skipConfirm) {
      const ok = await foundry.applications.api.DialogV2.confirm({
        window: { title: `Snare · ${trap.name}`, icon: "fa-solid fa-diamond" },
        classes: ["snare-dialog"],
        content: `<p><b>${esc(trap.name)}</b> was triggered by <b>${esc(trigger?.name ?? "someone")}</b>. Players see nothing until you decide.</p>`,
        yes: { label: "Fire", icon: "fa-solid fa-burst", default: true },
        no: { label: "Hold", icon: "fa-solid fa-hand" },
        rejectClose: false
      });
      if (!ok) {
        await whisperGM(`You held <b>${esc(trap.name)}</b>. It stays armed.`, "fa-hand");
        return;
      }
    }

    await updateState(scene, trap.id, { status: "triggered" });
    await announce(`<b>${esc(trap.name)}</b> goes off!`, "fa-burst", trap.name);

    const targets = await resolveTargets(scene, trap, trigger);
    const originPt = trap.origin ? cellCenter(trap.origin) : null;
    const terrain = [...trap.state.terrain];
    let previous = new Set();

    for (const e of trap.effects) {
      try {
        if (e.type === "strike") previous = await doStrike(scene, trap, e, targets, originPt);
        else if (e.type === "burst") previous = await doBurst(scene, trap, e, trigger, originPt);
        else if (e.type === "condition") await doCondition(trap, e, targets, previous, scene);
        else if (e.type === "terrain") terrain.push(await doTerrain(scene, trap, e));
      } catch (err) {
        console.error(`${MODULE_ID} | effect ${e.type} failed`, err);
        ui.notifications.error(`Snare: the ${e.type} effect of ${trap.name} failed. See the console (F12).`);
      }
    }

    await updateState(scene, trap.id, {
      status: trap.after === "oneshot" ? "spent" : "triggered",
      rearmIn: trap.after === "rounds" ? Number(trap.rearmRounds) || 1 : 0,
      terrain
    });
    requestDraw();
  } finally {
    fireLock.delete(trapId);
  }
}

async function doStrike(scene, trap, e, targets, originPt) {
  const hit = new Set();
  for (const t of targets) {
    if (!t?.actor) continue;
    broadcastFx({ sceneId: scene.id, preset: e.pyre, from: originPt ?? tokenPoint(t), targets: [t.id] });
    const roll = await new Roll(`1d20 + ${Number(e.attack) || 0}`).evaluate();
    const ac = t.actor.attributes?.ac?.value ?? t.actor.system?.attributes?.ac?.value ?? 10;
    const deg = degreeOf(roll.total, ac, roll.dice[0]?.total);
    await roll.toMessage({ speaker: { alias: trap.name }, flavor: `<b>${esc(trap.name)}</b> attacks ${esc(t.name)} (AC ${ac}): <b>${deg === 3 ? "Critical hit" : deg === 2 ? "Hit" : "Miss"}</b>` });
    if (deg >= 2) {
      hit.add(t.id);
      await sleep(150);
      await rollDamage(e.damage, e.dtype, { double: deg === 3, alias: trap.name, flavor: `${esc(trap.name)} → ${esc(t.name)}${deg === 3 ? " (critical, doubled)" : ""}` });
    }
  }
  return hit;
}

async function doBurst(scene, trap, e, trigger, originPt) {
  const c = e.center === "origin" ? trap.origin : e.center === "custom" ? e.cell : (trigger ? tokenCell(trigger) : null);
  if (!c) { await whisperGM(`The burst of <b>${esc(trap.name)}</b> has no center set, so it was skipped.`, "fa-triangle-exclamation"); return new Set(); }
  const at = cellCenter(c);
  broadcastFx({ sceneId: scene.id, preset: e.pyre, from: originPt ?? at, at });
  const inside = scene.tokens.filter((t) => t.actor && !t.hidden && cheb(tokenCell(t), c) <= Number(e.radius));
  const failed = new Set();
  const lines = [];
  const saveLabel = e.save[0].toUpperCase() + e.save.slice(1);
  for (const t of inside) {
    let deg = null;
    try {
      const r = await t.actor.saves?.[e.save]?.roll({ dc: { value: Number(e.dc) }, skipDialog: true, extraRollOptions: ["snare:burst"] });
      deg = r?.degreeOfSuccess ?? null;
    } catch (err) { deg = null; }
    if (deg === null) {
      const mod = t.actor.saves?.[e.save]?.mod ?? 0;
      const r = await new Roll(`1d20 + ${mod}`).evaluate();
      deg = degreeOf(r.total, Number(e.dc), r.dice[0]?.total);
      await r.toMessage({ speaker: ChatMessage.getSpeaker({ token: t }), flavor: `${saveLabel} save vs ${esc(trap.name)} (DC ${e.dc})` });
    }
    if (deg <= 1) failed.add(t.id);
    const share = e.basic ? ["double", "full", "half", "none"][deg] : (deg <= 1 ? "affected" : "unaffected");
    lines.push(`${esc(t.name)}: ${DEGREES[deg]} (${share})`);
  }
  if (!inside.length) {
    await announce(`The burst of <b>${esc(trap.name)}</b> hits no one.`, "fa-bomb", trap.name);
    return failed;
  }
  await rollDamage(e.damage, e.dtype, {
    alias: trap.name,
    flavor: `<b>${esc(trap.name)}</b> burst · ${e.basic ? "basic " : ""}${saveLabel} DC ${e.dc}<br>${lines.join("<br>")}`
  });
  return failed;
}

async function doCondition(trap, e, targets, previous, scene) {
  const list = e.appliesTo === "failed" ? scene.tokens.filter((t) => previous.has(t.id)) : targets;
  const label = CONDITIONS.find(([s]) => s === e.condition)?.[1] ?? e.condition;
  for (const t of list) {
    if (!t?.actor) continue;
    await applyCondition(t.actor, e.condition, Number(e.value) || 1);
  }
  if (list.length) await announce(`${list.map((t) => esc(t.name)).join(", ")}: ${label}${VALUED.includes(e.condition) ? ` ${e.value}` : ""}.`, "fa-person-falling", trap.name);
}

async function buildTerrain(scene, trap, e) {
  const cells = terrainCellsOf(trap, e).map((c) => [...c]);
  const entry = {
    id: foundry.utils.randomID(), effectId: e.id, terrain: e.terrain, cells,
    balanceDC: Number(e.balanceDC) || 15, hazDamage: e.hazDamage, hazType: e.hazType ?? "fire",
    affects: e.affects, exemptTokens: [...(e.exemptTokens ?? [])], exemptTraits: [...(e.exemptTraits ?? [])],
    roundsLeft: e.duration === "rounds" ? Number(e.rounds) || 1 : null, regionId: null
  };
  if (e.terrain !== "hazardous") entry.regionId = await createCostRegion(scene, trap, entry);
  return entry;
}

async function doTerrain(scene, trap, e) {
  const entry = await buildTerrain(scene, trap, e);
  const words = { slippery: "The floor turns slick", difficult: "Rubble covers the floor", greater: "Heavy rubble blocks the way", hazardous: "The floor turns dangerous" };
  await announce(`${words[e.terrain] ?? TERRAIN[e.terrain]}${entry.roundsLeft ? ` for ${entry.roundsLeft} rounds` : ""}.`, e.terrain === "slippery" ? "fa-snowflake" : "fa-mountain", trap.name);
  const exempt = scene.tokens.filter((t) => t.actor).map((t) => [t, exemptReason(entry, t)]).filter(([, r]) => r);
  if (exempt.length) await whisperGM(`Unaffected by this terrain: ${exempt.map(([t, r]) => `${esc(t.name)} (${r})`).join(", ")}.`, "fa-shield-halved");
  return entry;
}

/** Real movement cost for difficult terrain, through a Modify Movement Cost region that Snare's patch makes token-aware. */
async function createCostRegion(scene, trap, entry) {
  try {
    const gs = scene.grid.size;
    const shapes = entry.cells.map((c) => {
      const tl = cellTopLeft(c);
      return { type: "rectangle", x: tl.x, y: tl.y, width: gs, height: gs, rotation: 0, hole: false };
    });
    const mult = entry.terrain === "greater" ? 3 : 2;
    const actions = Object.keys(CONFIG.Token?.movement?.actions ?? { walk: {} }).filter((a) => !["blink", "displace", "teleport"].includes(a));
    const difficulties = Object.fromEntries(actions.map((a) => [a, mult]));
    const [region] = await scene.createEmbeddedDocuments("Region", [{
      name: `Snare · ${trap.name}`, color: "#8a6a48", shapes,
      visibility: CONST.REGION_VISIBILITY?.LAYER ?? 0,
      behaviors: [{ type: "modifyMovementCost", name: "Snare terrain", system: { difficulties } }],
      flags: { [MODULE_ID]: { terrain: { affects: entry.affects, exemptTokens: entry.exemptTokens, exemptTraits: entry.exemptTraits } } }
    }]);
    return region?.id ?? null;
  } catch (err) {
    console.warn(`${MODULE_ID} | could not create the movement cost region`, err);
    ui.notifications.warn("Snare: difficult terrain is shown, but Foundry refused the movement cost region. See the console (F12).");
    return null;
  }
}

/** Makes the core Modify Movement Cost behavior skip tokens that a Snare region exempts. */
export function patchMovementCost() {
  const Cls = foundry.data?.regionBehaviors?.ModifyMovementCostRegionBehaviorType;
  const original = Cls?.prototype?._getTerrainEffects;
  if (typeof original !== "function") {
    console.warn(`${MODULE_ID} | Modify Movement Cost not found; terrain exemptions won't change movement cost`);
    return;
  }
  Cls.prototype._getTerrainEffects = function (token, ...rest) {
    try {
      const rule = this.parent?.parent?.flags?.[MODULE_ID]?.terrain;
      const doc = token?.document ?? token;
      if (rule && exemptReason(rule, doc)) return [];
    } catch (err) { /* fall through */ }
    return original.call(this, token, ...rest);
  };
}

/** A new round: terrain counts down, self-rearming traps count down. */
export async function tickRound(scene) {
  if (!scene) return;
  for (const trap of getTraps(scene)) {
    const st = trap.state;
    let changed = false;
    const keep = [];
    for (const t of st.terrain) {
      if (t.roundsLeft == null) { keep.push(t); continue; }
      const left = t.roundsLeft - 1;
      changed = true;
      if (left > 0) keep.push({ ...t, roundsLeft: left });
      else if (t.regionId) await scene.regions?.get(t.regionId)?.delete().catch(() => {});
    }
    const patch = {};
    if (changed) patch.terrain = keep;
    if (st.rearmIn > 0) {
      patch.rearmIn = st.rearmIn - 1;
      if (patch.rearmIn === 0 && st.status === "triggered") {
        patch.status = "armed";
        await whisperGM(`<b>${esc(trap.name)}</b> rearms itself.`, "fa-rotate");
      }
    }
    if (Object.keys(patch).length) await updateState(scene, trap.id, patch);
  }
}

/** A scene feature is always active: its terrain exists from the moment it is set up, with nothing to find or disable. */
export async function syncFeature(scene, trap) {
  if (!scene || !trap) return;
  for (const t of trap.state.terrain) if (t.regionId) await scene.regions?.get(t.regionId)?.delete().catch(() => {});
  if (!trap.feature) {
    if (trap.state.status === "active") await updateState(scene, trap.id, { status: "armed", terrain: [] });
    return;
  }
  const terrain = [];
  for (const e of trap.effects.filter((x) => x.type === "terrain")) {
    const entry = await buildTerrain(scene, trap, { ...e, duration: "permanent" });
    if (entry.cells.length) terrain.push(entry);
  }
  await updateState(scene, trap.id, { status: "active", terrain, detectedBy: [], rolledBy: [], progress: 0, rearmIn: 0 });
  requestDraw();
}

export async function clearTerrain(scene, trap) {
  for (const t of trap.state.terrain) if (t.regionId) await scene.regions?.get(t.regionId)?.delete().catch(() => {});
  await updateState(scene, trap.id, { terrain: [] });
}

/* =========================================================================
   Disable (GM, from the manager)
   ========================================================================= */

export async function attemptDisable(scene, trapId, actorId, rowIndex) {
  const trap = getTrap(scene, trapId);
  const row = trap?.disable[rowIndex];
  const actor = game.actors.get(actorId);
  if (!trap || !row || !actor || trap.state.status !== "armed") return;
  if (trap.noDisable || trap.feature) return ui.notifications.info(`Snare: ${trap.name} can't be disabled.`);
  const stat = actor.skills?.[row.skill];
  const rank = stat?.rank ?? 0;
  const skillLabel = row.skill[0].toUpperCase() + row.skill.slice(1);
  if (rank < row.minProf) {
    ui.notifications.warn(`${actor.name} needs ${RANKS[row.minProf]} in ${skillLabel} to try this.`);
    return;
  }
  let deg = null;
  try {
    const r = await stat.roll({ dc: { value: Number(row.dc) }, skipDialog: true, extraRollOptions: ["action:disable-a-device", "snare:disable"] });
    deg = r?.degreeOfSuccess ?? null;
  } catch (err) { deg = null; }
  if (deg === null) {
    const r = await new Roll(`1d20 + ${stat?.mod ?? 0}`).evaluate();
    deg = degreeOf(r.total, Number(row.dc), r.dice[0]?.total);
    await r.toMessage({ speaker: ChatMessage.getSpeaker({ actor }), flavor: `${skillLabel}: disable ${esc(trap.name)} (DC ${row.dc})` });
  }
  if (deg >= 2) {
    const progress = trap.state.progress + 1;
    const done = progress >= trap.successes;
    await updateState(scene, trap.id, { progress, status: done ? "disabled" : "armed" });
    if (done) await announce(`${esc(actor.name)} disables <b>${esc(trap.name)}</b>.`, "fa-lock");
    else await whisperGM(`${esc(actor.name)} makes progress on <b>${esc(trap.name)}</b>: ${progress}/${trap.successes}.`, "fa-screwdriver-wrench");
    return;
  }
  if (deg === 0 && trap.critFailTriggers) {
    await announce(`${esc(actor.name)} fumbles the mechanism of <b>${esc(trap.name)}</b>!`, "fa-burst");
    const tok = scene.tokens.find((t) => t.actorId === actor.id);
    await fireTrap(scene, trap.id, tok?.id, { skipConfirm: true });
    return;
  }
  await whisperGM(`${esc(actor.name)} fails to disable <b>${esc(trap.name)}</b>. No progress.`, "fa-screwdriver-wrench");
}

export { isPC, isPartyToken, triggerCentroid };
