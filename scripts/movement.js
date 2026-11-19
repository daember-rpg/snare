import { MODULE_ID } from "./constants.js";
import {
  getTraps, key, pointCell, tokenCenterAt, cellCenter, triggerKeys, detectKeys, canTrigger, isPC,
  exemptReason, degreeOf, DEGREES, esc, announce, whisperGM
} from "./store.js";
import { rollDetection } from "./engine.js";
import { toGM } from "./socket.js";

/** Tokens whose next move is Snare's own re-issued move. */
const bypass = new Set();
/** scene:trap:actor already checked on this client (the scene flag can lag behind a quick second move). */
const rolledHere = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WP_KEYS = ["x", "y", "elevation", "width", "height", "shape", "action", "snapped", "explicit", "checkpoint"];

export function registerMovement() {
  Hooks.on("preMoveToken", (doc, movement) => {
    try {
      if (bypass.has(doc.id) || !doc.actor || !doc.parent) return;
      const scene = doc.parent;
      const traps = getTraps(scene);
      if (!traps.length) return;
      const plan = buildPath(doc, movement);
      if (!plan.cells.length || !needsSnare(scene, traps, doc, plan.cells)) return;
      handleMove(scene, doc, movement, plan).catch((err) => console.error(`${MODULE_ID} | movement`, err));
      return false;
    } catch (err) {
      console.error(`${MODULE_ID} | preMoveToken`, err);
    }
  });
}

function waypointList(movement) {
  return [...(movement.passed?.waypoints ?? []), ...(movement.pending?.waypoints ?? [])];
}

function cellsBetween(a, b) {
  try {
    const offs = canvas.grid.getDirectPath([a, b]);
    if (Array.isArray(offs) && offs.length) return offs.map((o) => [o.i, o.j]);
  } catch (err) { /* fallback below */ }
  const s = pointCell(a), e = pointCell(b), out = [s];
  let [i, j] = s;
  while (i !== e[0] || j !== e[1]) { i += Math.sign(e[0] - i); j += Math.sign(e[1] - j); out.push([i, j]); }
  return out;
}

/** Cells the token will enter, in order, each tagged with the waypoint segment it belongs to. */
function buildPath(doc, movement) {
  const wps = waypointList(movement);
  let prev = tokenCenterAt(doc, movement.origin ?? doc);
  const cells = [];
  let last = key(pointCell(prev));
  wps.forEach((wp, seg) => {
    const c = tokenCenterAt(doc, wp);
    for (const cell of cellsBetween(prev, c)) {
      const k = key(cell);
      if (k === last) continue;
      cells.push({ cell, seg });
      last = k;
    }
    prev = c;
  });
  return { wps, cells };
}

function rolledKey(scene, trap, actor) { return `${scene.id}:${trap.id}:${actor.id}`; }
function hasRolled(scene, trap, actor) {
  return trap.state.rolledBy.includes(actor.id) || rolledHere.has(rolledKey(scene, trap, actor));
}

function activeTerrainAt(traps, k) {
  for (const trap of traps) for (const t of trap.state.terrain) if (t.cells.some((c) => key(c) === k)) return t;
  return null;
}

function needsSnare(scene, traps, doc, cells) {
  const pc = isPC(doc);
  for (const { cell } of cells) {
    const k = key(cell);
    for (const trap of traps) {
      if (trap.state.status === "armed") {
        if (triggerKeys(trap).has(k) && canTrigger(trap, doc)) return true;
        if (pc && detectKeys(trap).has(k) && !hasRolled(scene, trap, doc.actor)) return true;
      }
    }
    const t = activeTerrainAt(traps, k);
    if (t && (t.terrain === "slippery" || t.terrain === "hazardous") && !exemptReason(t, doc)) return true;
  }
  return false;
}

async function handleMove(scene, doc, movement, plan) {
  const traps = getTraps(scene);
  const pc = isPC(doc);
  let stop = plan.cells.length - 1;
  let fire = null;
  let fallProne = false;
  let balanced = false;

  outer:
  for (let n = 0; n < plan.cells.length; n++) {
    const { cell } = plan.cells[n];
    const k = key(cell);

    // 1. Secret detection, before anyone steps on the trigger.
    for (const trap of traps) {
      if (trap.state.status !== "armed" || !pc || hasRolled(scene, trap, doc.actor)) continue;
      if (!detectKeys(trap).has(k)) continue;
      rolledHere.add(rolledKey(scene, trap, doc.actor));
      const { found } = await rollDetection(trap, doc);
      toGM({ type: "detect", sceneId: scene.id, trapId: trap.id, actorId: doc.actor.id, found });
      if (found) { stop = triggerKeys(trap).has(k) ? n - 1 : n; break outer; }
    }

    // 2. Active terrain under this square.
    const t = activeTerrainAt(traps, k);
    if (t && !exemptReason(t, doc)) {
      if (t.terrain === "slippery" && !balanced) {
        const deg = await balanceCheck(doc, t.balanceDC);
        if (deg >= 2) balanced = true;
        else { stop = n; fallProne = deg === 0; break outer; }
      } else if (t.terrain === "hazardous") {
        await hazardDamage(doc, t);
      }
    }

    // 3. The trigger.
    for (const trap of traps) {
      if (trap.state.status !== "armed" || !triggerKeys(trap).has(k) || !canTrigger(trap, doc)) continue;
      stop = n; fire = trap; break outer;
    }
  }

  await moveTo(doc, movement, plan, stop);
  if (fallProne) toGM({ type: "condition", sceneId: scene.id, tokenId: doc.id, slug: "prone" });
  if (fire) {
    if (fire.state.detectedBy.includes(doc.actor.id)) await whisperGM(`${esc(doc.name)} knowingly steps on <b>${esc(fire.name)}</b>.`, "fa-person-walking");
    await toGM({ type: "fire", sceneId: scene.id, trapId: fire.id, tokenId: doc.id });
  }
}

async function moveTo(doc, movement, plan, stop) {
  if (stop < 0) return;
  const target = plan.cells[stop];
  const gs = canvas.grid.size;
  const center = cellCenter(target.cell);
  const base = plan.wps[target.seg] ?? {};
  const pick = (wp) => Object.fromEntries(WP_KEYS.filter((k) => wp[k] !== undefined).map((k) => [k, wp[k]]));
  const wps = plan.wps.slice(0, target.seg).map(pick);
  const end = pick(base);
  end.x = Math.round(center.x - ((base.width ?? doc.width) * gs) / 2);
  end.y = Math.round(center.y - ((base.height ?? doc.height) * gs) / 2);
  wps.push(end);
  bypass.add(doc.id);
  try {
    if (typeof doc.move === "function") await doc.move(wps, { method: movement.method ?? "api" });
    else await doc.update({ x: end.x, y: end.y });
    await sleep(Math.min(2000, 120 * (stop + 1)));
  } catch (err) {
    console.warn(`${MODULE_ID} | re-issued move failed, placing the token directly`, err);
    await doc.update({ x: end.x, y: end.y }).catch(() => {});
  } finally {
    bypass.delete(doc.id);
  }
}

async function balanceCheck(doc, dc) {
  const actor = doc.actor;
  const stat = actor.skills?.acrobatics;
  let deg = null, total = "?";
  try {
    const r = await stat?.roll({ dc: { value: Number(dc) }, skipDialog: true, extraRollOptions: ["action:balance", "snare:balance"] });
    if (r) { deg = r.degreeOfSuccess ?? null; total = r.total; }
  } catch (err) { deg = null; }
  if (deg === null) {
    const r = await new Roll(`1d20 + ${stat?.mod ?? 0}`).evaluate();
    total = r.total;
    deg = degreeOf(r.total, Number(dc), r.dice[0]?.total);
    await r.toMessage({ speaker: ChatMessage.getSpeaker({ token: doc }), flavor: `Balance (Acrobatics) DC ${dc}` });
  }
  const text = deg >= 2 ? "keeps their footing" : deg === 1 ? "loses their footing and stops" : "slips and falls prone";
  await announce(`${esc(doc.name)} ${text} (${DEGREES[deg]}).`, "fa-snowflake");
  return deg;
}

async function hazardDamage(doc, t) {
  const DR = CONFIG.Dice.rolls.find((r) => r.name === "DamageRoll");
  let roll = null;
  if (DR) { try { roll = await new DR(`(${t.hazDamage})[${t.hazType ?? "fire"}]`).evaluate(); } catch (err) { roll = null; } }
  if (!roll) roll = await new Roll(t.hazDamage || "1").evaluate();
  await roll.toMessage({ speaker: { alias: "Snare" }, flavor: `${esc(doc.name)} moves through hazardous terrain` });
}
