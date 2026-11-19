import { MODULE_ID } from "./constants.js";

export const pyreReady = () => {
  const mod = game.modules.get("pyre");
  return !!(mod?.active && typeof mod.api?.preset === "function");
};

/** Pyre plays presets from token to token. A trap origin is not a token, so hand it a stand-in with what Pyre reads. */
function standIn(point) {
  const gs = canvas.grid.size;
  return {
    id: `${MODULE_ID}-${foundry.utils.randomID()}`,
    center: { x: point.x, y: point.y },
    x: point.x - gs / 2, y: point.y - gs / 2, w: gs, h: gs,
    visible: true, actor: null,
    document: { width: 1, height: 1, hidden: false, disposition: 0, level: null }
  };
}

/** msg: { sceneId, preset, from: {x,y}, targets: [tokenId], at: {x,y} } */
export function playFx(msg) {
  if (!msg?.preset || !pyreReady() || !canvas?.ready || canvas.scene?.id !== msg.sceneId) return;
  try {
    const api = game.modules.get("pyre").api;
    const from = msg.from ?? msg.at;
    if (!from) return;
    const targets = (msg.targets ?? []).map((id) => canvas.tokens.get(id)).filter(Boolean);
    if (msg.at) targets.push(standIn(msg.at));
    api.preset(msg.preset, standIn(from), targets);
  } catch (err) {
    console.warn(`${MODULE_ID} | Pyre animation failed`, err);
  }
}
