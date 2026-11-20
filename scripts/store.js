import { MODULE_ID, LEVEL_DC, XP_SIMPLE } from "./constants.js";

/** Keys the builder edits. Everything else lives under `state` and is written only by the GM's engine. */
export const CONFIG_KEYS = ["name", "level", "kind", "magical", "partyLevel", "stealthDC", "minProf", "detectRadius",
  "trigger", "origin", "triggeredBy", "triggerIgnore", "targets", "confirm", "after", "rearmRounds",
  "effects", "disable", "successes", "critFailTriggers", "notes", "feature", "noDisable", "playersSee", "sceneLevel"];

export const clone = (o) => foundry.utils.deepClone(o);
export const key = (c) => `${c[0]},${c[1]}`;
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function freshState() {
  return { status: "armed", detectedBy: [], rolledBy: [], progress: 0, rearmIn: 0, revealed: false, terrain: [] };
}

export function dcForLevel(level) {
  return LEVEL_DC[clamp(Number(level) || 0, 0, LEVEL_DC.length - 1)];
}

export function blankTrap(level = 1) {
  const dc = dcForLevel(level);
  return {
    id: foundry.utils.randomID(), name: "New Trap", level, kind: "simple", magical: false, partyLevel: Math.max(1, level),
    stealthDC: dc, minProf: 1, detectRadius: 1,
    trigger: [], origin: null, triggeredBy: "any", triggerIgnore: [], targets: "triggering", confirm: true,
    after: "oneshot", rearmRounds: 3,
    effects: [], disable: [{ skill: "thievery", dc, minProf: 1 }], successes: 1, critFailTriggers: true, notes: "",
    feature: false, noDisable: false, playersSee: true, sceneLevel: viewedLevel(),
    state: freshState()
  };
}

export function newEffect(type, level = 1) {
  const id = foundry.utils.randomID();
  const dc = dcForLevel(level);
  if (type === "strike") return { id, type, attack: dc - 8, damage: "2d6+3", dtype: "piercing", pyre: "std-force-bolt" };
  if (type === "burst") return { id, type, center: "origin", cell: null, radius: 2, save: "reflex", dc, basic: true, damage: "3d6", dtype: "fire", pyre: "std-fireball" };
  if (type === "condition") return { id, type, condition: "prone", value: 1, appliesTo: "failed" };
  return { id, type: "terrain", terrain: "difficult", balanceDC: dc, hazDamage: "1d6", offGuard: true, failResult: "stop", fallDamage: "", area: "trigger", cells: [], duration: "permanent", rounds: 3, affects: "all", exemptTokens: [], exemptTraits: [] };
}

/** Fill gaps so older or hand-edited data never breaks the UI. */
function normalize(raw) {
  const base = blankTrap(raw.level ?? 1);
  const t = foundry.utils.mergeObject(base, raw, { inplace: false, insertKeys: true, insertValues: true });
  t.state = foundry.utils.mergeObject(freshState(), raw.state ?? {}, { inplace: false });
  if (!("sceneLevel" in raw)) t.sceneLevel = null;
  for (const k of ["trigger", "triggerIgnore", "effects", "disable"]) if (!Array.isArray(t[k])) t[k] = [];
  for (const k of ["detectedBy", "rolledBy", "terrain"]) if (!Array.isArray(t.state[k])) t.state[k] = [];
  return t;
}

export function getTraps(scene = canvas?.scene) {
  const raw = scene?.getFlag?.(MODULE_ID, "traps");
  if (!raw || typeof raw !== "object") return [];
  return Object.values(raw).filter((t) => t?.id).map(normalize).sort((a, b) => a.name.localeCompare(b.name));
}

export function getTrap(scene, id) {
  const raw = scene?.getFlag?.(MODULE_ID, "traps")?.[id];
  return raw?.id ? normalize(raw) : null;
}

export function pickConfig(trap) {
  const out = {};
  for (const k of CONFIG_KEYS) out[k] = clone(trap[k]);
  return out;
}

/** GM only. Writes the builder's keys and leaves the state alone. */
export async function saveConfig(scene, trap) {
  const data = pickConfig(trap);
  data.id = trap.id;
  await scene.update({ [`flags.${MODULE_ID}.traps.${trap.id}`]: data });
}

export async function createTrap(scene, trap) {
  await scene.update({ [`flags.${MODULE_ID}.traps.${trap.id}`]: trap });
}

export async function deleteTrap(scene, id) {
  await scene.unsetFlag(MODULE_ID, `traps.${id}`);
}

/** GM only. Merges into the trap's state. */
export async function updateState(scene, id, patch) {
  await scene.update({ [`flags.${MODULE_ID}.traps.${id}.state`]: patch });
}

/* ---------------- grid geometry ---------------- */

export const gridSize = () => canvas.grid.size;
export function cellCenter(c) { return canvas.grid.getCenterPoint({ i: c[0], j: c[1] }); }
export function cellTopLeft(c) { return canvas.grid.getTopLeftPoint({ i: c[0], j: c[1] }); }
export function pointCell(p) { const o = canvas.grid.getOffset(p); return [o.i, o.j]; }
export function tokenCenterAt(doc, pos) {
  const gs = canvas.grid.size;
  const w = (pos?.width ?? doc.width ?? 1) * gs, h = (pos?.height ?? doc.height ?? 1) * gs;
  return { x: (pos?.x ?? doc.x) + w / 2, y: (pos?.y ?? doc.y) + h / 2 };
}
export function tokenCell(doc) { return pointCell(tokenCenterAt(doc)); }
export const cheb = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));

export function triggerKeys(trap) { return new Set(trap.trigger.map(key)); }
export function detectKeys(trap) {
  const s = new Set(), r = Math.max(0, Number(trap.detectRadius) || 0);
  for (const [i, j] of trap.trigger) for (let di = -r; di <= r; di++) for (let dj = -r; dj <= r; dj++) s.add(key([i + di, j + dj]));
  return s;
}
export function terrainCellsOf(trap, e) { return e.area === "trigger" ? trap.trigger : (e.cells ?? []); }
export function triggerCentroid(trap) {
  if (!trap.trigger.length) return null;
  const pts = trap.trigger.map(cellCenter);
  return { x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length };
}

/* ---------------- scene levels (Foundry V14) ---------------- */

export const viewedLevel = () => canvas?.level?.id ?? null;
export function sceneLevels(scene = canvas?.scene) {
  try { return Array.from(scene?.levels ?? []).filter((l) => l?.id); } catch (err) { return []; }
}
/** A trap on a floor only touches tokens on that floor. Tokens or traps without a floor match everything. */
export function sameLevel(trap, doc) {
  const lv = trap?.sceneLevel, tl = doc?.level ?? null;
  return !lv || !tl || lv === tl;
}
export function trapVisibleOnViewedLevel(trap) {
  const viewed = viewedLevel();
  return !trap.sceneLevel || !viewed || trap.sceneLevel === viewed;
}

/* ---------------- rules helpers ---------------- */

export function xpInfo(t) {
  const diff = (Number(t.level) || 0) - (Number(t.partyLevel) || 1);
  if (diff < -4) return { xp: 0, text: "Trivial for this party" };
  if (diff > 4) return { xp: null, text: "More than 4 levels above the party" };
  let xp = XP_SIMPLE[String(diff)];
  if (t.kind === "complex") xp *= 5;
  return { xp, text: `${t.kind === "complex" ? "Complex" : "Simple"} hazard, ${diff === 0 ? "party level" : (diff > 0 ? "+" : "") + diff + " vs party"}` };
}

export function alliance(actor) {
  if (!actor) return "opposition";
  return actor.alliance ?? (actor.hasPlayerOwner ? "party" : "opposition");
}
export const isPartyToken = (doc) => alliance(doc?.actor) === "party";
export const isPC = (doc) => doc?.actor?.type === "character";

export function actorTraits(actor) {
  const v = actor?.system?.traits?.value;
  return Array.isArray(v) ? v : (v instanceof Set ? [...v] : []);
}

/** Why a token ignores a terrain rule, or "" when it is affected. */
export function exemptReason(rule, doc) {
  if (!rule || !doc) return "";
  const side = alliance(doc.actor);
  if (rule.affects === "enemies" && side === "party") return "the party is not affected";
  if (rule.affects === "party" && side !== "party") return "only the party is affected";
  if ((rule.exemptTokens ?? []).includes(doc.id)) return "exempt token";
  const traits = (rule.exemptTraits ?? []).map((t) => String(t).toLowerCase());
  const hit = actorTraits(doc.actor).find((t) => traits.includes(String(t).toLowerCase()));
  return hit ? `${hit} trait` : "";
}

export function canTrigger(trap, doc) {
  if (!doc?.actor) return false;
  if (trap.triggerIgnore.includes(doc.id)) return false;
  return trap.triggeredBy === "any" || isPartyToken(doc);
}

export const isActiveGM = () => !!game.user?.isGM && (game.users.activeGM?.id ?? game.user.id) === game.user.id;
export const gmIds = () => game.users.filter((u) => u.isGM).map((u) => u.id);
export const ownerIds = (actor) => game.users.filter((u) => !u.isGM && actor?.testUserPermission?.(u, "OWNER")).map((u) => u.id);

export function degreeOf(total, dc, nat) {
  let d = total >= dc + 10 ? 3 : total >= dc ? 2 : total <= dc - 10 ? 0 : 1;
  if (nat === 20) d = Math.min(3, d + 1);
  if (nat === 1) d = Math.max(0, d - 1);
  return d;
}
export const DEGREES = ["Critical failure", "Failure", "Success", "Critical success"];

export function card(html, icon = "fa-diamond", tone = "") {
  return `<div class="snare-card ${tone}"><i class="fa-solid ${icon}"></i><div>${html}</div></div>`;
}
export async function whisperGM(html, icon) {
  return ChatMessage.create({ speaker: { alias: "Snare" }, content: card(html, icon), whisper: gmIds() });
}
export async function whisperOwners(actor, html, icon) {
  const ids = ownerIds(actor);
  if (!ids.length) return;
  return ChatMessage.create({ speaker: { alias: "Snare" }, content: card(html, icon), whisper: ids });
}
export async function announce(html, icon, alias = "Snare") {
  return ChatMessage.create({ speaker: { alias }, content: card(html, icon, "public") });
}
