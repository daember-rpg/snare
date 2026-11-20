import { MODULE_ID } from "./constants.js";
import { getTraps, trapVisibleOnViewedLevel, viewedLevel, cellTopLeft, cellCenter, detectKeys, triggerKeys, terrainCellsOf, triggerCentroid, key } from "./store.js";

let layer = null;
/** Builder drafts shown live on the canvas before they are saved: trapId → trap. */
export const drafts = new Map();
let queued = false;
let hover = null;
let lastLevel = null;

/** Foundry has no hook for switching the viewed floor, so watch it from the ticker. */
let watching = false;
export function watchLevel() {
  if (watching) return;
  watching = true;
  canvas.app.ticker.add(() => { if (canvas?.ready && viewedLevel() !== lastLevel) requestDraw(); });
}

/** Live opacity while the GM drags the slider. */
export function setOpacity(pct) {
  if (layer && !layer.destroyed && game.user.isGM) layer.alpha = Math.max(0.1, Math.min(1, pct / 100));
}

/** The square under the cursor while painting. */
export function setHover(cell) {
  const k = cell ? key(cell) : null;
  if ((hover ? key(hover) : null) === k) return;
  hover = cell;
  paintHover();
}

let hoverG = null;
let previewG = null;
/** The trap being painted: its painted squares live in their own graphic so each square costs one tiny redraw. */
let painting = null;
const labels = new Map();

export function beginPaintPreview(trapId, mode, effectId, cells) {
  painting = { trapId, mode, effectId, cells: cells ?? [] };
  requestDraw();
}
export function paintCells(cells) {
  if (!painting) return;
  painting.cells = cells;
  paintPreview();
}
export function endPaintPreview() {
  painting = null;
  previewG?.clear();
  requestDraw();
}
function paintPreview() {
  if (!previewG || previewG.destroyed) return;
  previewG.clear();
  if (!painting || !canvas?.ready) return;
  const gs = canvas.grid.size;
  const [color, alpha] = painting.mode === "trigger" ? [C.ember, 0.34] : [C.ice, 0.3];
  previewG.lineStyle(2, color, 0.9);
  previewG.beginFill(color, alpha);
  for (const c of painting.cells) { const tl = cellTopLeft(c); previewG.drawRect(tl.x + 3, tl.y + 3, gs - 6, gs - 6); }
  previewG.endFill();
}
function paintHover() {
  if (!hoverG || hoverG.destroyed) return;
  hoverG.clear();
  if (!hover || !game.user.isGM || !canvas?.ready) return;
  const gs = canvas.grid.size;
  const tl = cellTopLeft(hover);
  hoverG.lineStyle(3, C.gold, 1); hoverG.beginFill(C.gold, 0.22);
  hoverG.drawRoundedRect(tl.x + 2, tl.y + 2, gs - 4, gs - 4, Math.max(3, gs * 0.1)); hoverG.endFill();
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
  const keep = new Set([hoverG, previewG, ...[...labels.values()].map((l) => l.obj)]);
  for (const child of root.removeChildren()) if (!keep.has(child)) child.destroy({ children: true });
  const drawnLabels = new Set();
  root.alpha = game.user.isGM ? (Number(game.settings.get(MODULE_ID, "overlayOpacity")) || 100) / 100 : 1;
  const gs = canvas.grid.size;
  const gm = game.user.isGM;
  const showGM = gm && game.settings.get(MODULE_ID, "showOverlay");
  const g = new PIXI.Graphics();
  root.addChild(g);

  lastLevel = viewedLevel();
  for (const saved of getTraps(canvas.scene)) {
    const trap = drafts.get(saved.id) ? { ...drafts.get(saved.id), state: saved.state } : saved;
    if (!trapVisibleOnViewedLevel(trap)) continue;
    const st = trap.state;
    const paintingThis = painting?.trapId === trap.id;

    // Active terrain: the GM always; players only when the trap allows it.
    for (const t of (gm || trap.playersSee !== false) ? st.terrain : []) {
      const [color, alpha] = TERRAIN_FILL[t.terrain] ?? [C.ink, 0.2];
      g.lineStyle(0); g.beginFill(color, alpha);
      for (const c of t.cells) rect(g, c, 1, gs);
      g.endFill();
    }

    const visibleTrigger = !trap.feature && (showGM || st.revealed || st.status !== "armed" || ownsDetector(trap));
    if (showGM && st.status === "armed" && !(paintingThis && painting.mode === "trigger")) {
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
        if (paintingThis && painting.effectId === e.id) continue;
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

    if (visibleTrigger && trap.trigger.length && !(paintingThis && painting.mode === "trigger")) {
      const spent = st.status !== "armed";
      g.lineStyle(2, spent ? C.ink : C.ember, spent ? 0.35 : 0.9);
      g.beginFill(spent ? C.ink : C.ember, spent ? 0.12 : 0.32);
      for (const c of trap.trigger) rect(g, c, 3, gs);
      g.endFill();
    }

    if (showGM && trap.origin && !trap.feature) {
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
      const text = `${trap.name}${trap.feature ? " · scene" : st.status !== "armed" ? ` · ${st.status}` : ""}`;
      const size = Math.max(12, gs * 0.26);
      let cached = labels.get(trap.id);
      if (!cached || cached.obj.destroyed || cached.text !== text || cached.size !== size) {
        cached?.obj?.destroy?.();
        const obj = new PIXI.Text(text, {
          fontFamily: "Cinzel, serif", fontSize: size, fontWeight: "600",
          fill: C.ink, stroke: 0x0f0d0c, strokeThickness: 4, letterSpacing: 1
        });
        obj.anchor.set(0.5, 1);
        cached = { text, size, obj };
        labels.set(trap.id, cached);
      }
      const label = cached.obj;
      drawnLabels.add(trap.id);
      const top = Math.min(...trap.trigger.map((c) => cellTopLeft(c).y));
      label.position.set(mid.x, top - 4);
      root.addChild(label);
    }
  }
  for (const [id, l] of labels) if (!drawnLabels.has(id)) { l.obj.destroy(); labels.delete(id); }
  if (!previewG || previewG.destroyed) previewG = new PIXI.Graphics();
  root.addChild(previewG);
  paintPreview();
  if (!hoverG || hoverG.destroyed) hoverG = new PIXI.Graphics();
  root.addChild(hoverG);
  paintHover();
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
