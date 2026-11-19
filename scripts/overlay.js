import { MODULE_ID } from "./constants.js";
import { getTraps, cellTopLeft, cellCenter, detectKeys, triggerKeys, terrainCellsOf, triggerCentroid, key } from "./store.js";

let layer = null;
/** Builder drafts shown live on the canvas before they are saved: trapId → trap. */
export const drafts = new Map();
let queued = false;
let hover = null;

/** The square under the cursor while painting. */
export function setHover(cell) {
  const k = cell ? key(cell) : null;
  if ((hover ? key(hover) : null) === k) return;
  hover = cell;
  requestDraw();
}

const C = { gold: 0xd4b25a, ember: 0xc8553d, emberLight: 0xe8876d, ink: 0xefe3c8, ice: 0x8fb0c9, mud: 0x8a6a48, orange: 0xff8a4c };
const TERRAIN_FILL = { slippery: [C.ice, 0.38], difficult: [C.mud, 0.4], greater: [C.mud, 0.6], hazardous: [C.ember, 0.32] };

function ensureLayer() {
  if (!canvas?.ready) return null;
  if (!layer || layer.destroyed || !layer.parent) {
    layer = new PIXI.Container();
    layer.name = `${MODULE_ID}-overlay`;
    layer.eventMode = "none";
    (canvas.interface ?? canvas.stage).addChild(layer);
  }
  return layer;
}

export function requestDraw() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; draw(); });
}

function ownsDetector(trap) {
  if (game.user.isGM) return true;
  return trap.state.detectedBy.some((id) => game.actors.get(id)?.isOwner);
}

function rect(g, c, inset, gs) {
  const tl = cellTopLeft(c);
  g.drawRoundedRect(tl.x + inset, tl.y + inset, gs - inset * 2, gs - inset * 2, Math.max(2, gs * 0.08));
}

export function draw() {
  const root = ensureLayer();
  if (!root) return;
  for (const child of root.removeChildren()) child.destroy({ children: true });
  const gs = canvas.grid.size;
  const gm = game.user.isGM;
  const showGM = gm && game.settings.get(MODULE_ID, "showOverlay");
  const g = new PIXI.Graphics();
  root.addChild(g);

  for (const saved of getTraps(canvas.scene)) {
    const trap = drafts.get(saved.id) ? { ...drafts.get(saved.id), state: saved.state } : saved;
    const st = trap.state;

    // Active terrain: everyone sees it.
    for (const t of st.terrain) {
      const [color, alpha] = TERRAIN_FILL[t.terrain] ?? [C.ink, 0.2];
      g.lineStyle(0); g.beginFill(color, alpha);
      for (const c of t.cells) rect(g, c, 1, gs);
      g.endFill();
    }

    const visibleTrigger = showGM || st.revealed || st.status !== "armed" || ownsDetector(trap);
    if (showGM && st.status === "armed") {
      // Detection zone
      const trig = triggerKeys(trap);
      g.lineStyle(2, C.gold, 0.55);
      for (const k of detectKeys(trap)) {
        if (trig.has(k)) continue;
        const [i, j] = k.split(",").map(Number);
        rect(g, [i, j], gs * 0.1, gs);
      }
      // Effect previews
      for (const e of trap.effects) {
        if (e.type === "terrain") {
          g.lineStyle(2, C.ice, 0.8);
          for (const c of terrainCellsOf(trap, e)) rect(g, c, gs * 0.2, gs);
        } else if (e.type === "burst") {
          const c = e.center === "origin" ? trap.origin : e.center === "custom" ? e.cell : null;
          if (c) {
            const p = cellCenter(c);
            g.lineStyle(2, C.orange, 0.8); g.beginFill(C.orange, 0.06);
            g.drawCircle(p.x, p.y, (Number(e.radius) + 0.5) * gs); g.endFill();
          }
        }
      }
    }

    if (visibleTrigger && trap.trigger.length) {
      const spent = st.status !== "armed";
      g.lineStyle(2, spent ? C.ink : C.ember, spent ? 0.35 : 0.9);
      g.beginFill(spent ? C.ink : C.ember, spent ? 0.12 : 0.32);
      for (const c of trap.trigger) rect(g, c, 3, gs);
      g.endFill();
    }

    if (showGM && trap.origin) {
      const o = cellCenter(trap.origin);
      const mid = triggerCentroid(trap);
      if (mid) {
        g.lineStyle(2, C.emberLight, 0.75);
        dashed(g, o, mid, gs * 0.18);
      }
      g.lineStyle(3, C.emberLight, 0.95); g.beginFill(C.ember, 0.18);
      g.drawCircle(o.x, o.y, gs * 0.32); g.endFill();
      g.lineStyle(2, C.emberLight, 0.95);
      g.moveTo(o.x - gs * 0.18, o.y); g.lineTo(o.x + gs * 0.18, o.y);
      g.moveTo(o.x, o.y - gs * 0.18); g.lineTo(o.x, o.y + gs * 0.18);
    }

    if (showGM && trap.trigger.length) {
      const mid = triggerCentroid(trap);
      const label = new PIXI.Text(`${trap.name}${st.status !== "armed" ? ` · ${st.status}` : ""}`, {
        fontFamily: "Cinzel, serif", fontSize: Math.max(12, gs * 0.26), fontWeight: "600",
        fill: C.ink, stroke: 0x0f0d0c, strokeThickness: 4, letterSpacing: 1
      });
      label.anchor.set(0.5, 1);
      const top = Math.min(...trap.trigger.map((c) => cellTopLeft(c).y));
      label.position.set(mid.x, top - 4);
      root.addChild(label);
    }
  }
  drawHover(root);
}

function drawHover(root) {
  if (!hover || !game.user.isGM) return;
  const gs = canvas.grid.size;
  const g = new PIXI.Graphics();
  const tl = cellTopLeft(hover);
  g.lineStyle(3, C.gold, 1); g.beginFill(C.gold, 0.22);
  g.drawRoundedRect(tl.x + 2, tl.y + 2, gs - 4, gs - 4, Math.max(3, gs * 0.1)); g.endFill();
  root.addChild(g);
}

function dashed(g, a, b, dash) {
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
  if (!len) return;
  const ux = dx / len, uy = dy / len;
  for (let d = 0; d < len; d += dash * 2) {
    const e = Math.min(len, d + dash);
    g.moveTo(a.x + ux * d, a.y + uy * d);
    g.lineTo(a.x + ux * e, a.y + uy * e);
  }
}

export { key };
