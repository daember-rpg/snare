import { MODULE_ID } from "./constants.js";
import { initSocket, onMessage } from "./socket.js";
import { playFx } from "./pyre.js";
import { draw, requestDraw } from "./overlay.js";
import { registerMovement } from "./movement.js";
import { registerEngine, patchMovementCost, tickRound, fireTrap, refreshUneven } from "./engine.js";
import { SnareManager } from "./manager.js";
import { ActivityPicker, registerActivityEntryPoints } from "./activity.js";
import { isActiveGM } from "./store.js";

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "library", { scope: "world", config: false, type: Array, default: [] });
  game.settings.register(MODULE_ID, "showOverlay", {
    name: "Show traps on the map (GM)",
    hint: "Draw trigger squares, detection zones, origins and effect areas for the GM.",
    scope: "client", config: true, type: Boolean, default: true,
    onChange: () => requestDraw()
  });
  game.settings.register(MODULE_ID, "overlayOpacity", {
    name: "Trap markings opacity (GM)",
    hint: "How strongly trap markings show on the map for you.",
    scope: "client", config: true, type: Number, range: { min: 10, max: 100, step: 5 }, default: 100,
    onChange: () => requestDraw()
  });
  game.keybindings.register(MODULE_ID, "open", {
    name: "Open Snare",
    editable: [{ key: "KeyT", modifiers: ["Shift"] }],
    restricted: true,
    onDown: () => { SnareManager.open(); return true; }
  });
  patchMovementCost();
  registerMovement();
  registerActivityEntryPoints();
});

Hooks.once("ready", () => {
  if (game.system.id !== "pf2e") console.warn(`${MODULE_ID} | built for Pathfinder 2e; other systems are not supported`);
  initSocket();
  registerEngine();
  onMessage("fx", playFx);
  const mod = game.modules.get(MODULE_ID);
  if (mod) mod.api = { open: () => SnareManager.open(), activity: (actor) => ActivityPicker.open(actor), fire: fireTrap, tick: tickRound };
  console.log(`${MODULE_ID} | Ready, version ${mod?.version ?? "?"}`);
});

Hooks.on("canvasReady", () => {
  draw();
  if (SnareManager.instance?.rendered) SnareManager.instance.render();
});

Hooks.on("updateScene", (scene, changes) => {
  if (scene.id !== canvas?.scene?.id) return;
  if (!foundry.utils.hasProperty(changes, `flags.${MODULE_ID}`) && !Object.keys(changes).some((k) => k.startsWith(`flags.${MODULE_ID}`))) return;
  requestDraw();
  SnareManager.instance?.refreshState();
});

Hooks.on("updateActor", (actor, changes) => {
  if (foundry.utils.hasProperty(changes, `flags.${MODULE_ID}`)) SnareManager.instance?.refreshState();
});

// Off-guard on uneven ground follows the token.
Hooks.on("updateToken", (doc, changes) => {
  if (!isActiveGM() || !("x" in changes || "y" in changes)) return;
  refreshUneven(doc.parent, doc);
});

// Terrain and self-rearming traps count down each combat round.
Hooks.on("updateCombat", (combat, changes) => {
  if (!("round" in changes) || !isActiveGM()) return;
  const scene = combat.scene ?? canvas?.scene;
  tickRound(scene);
});

// GM entry point: a tool in the token controls.
Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user.isGM) return;
  const tool = { name: MODULE_ID, title: "Snare traps", icon: "fa-solid fa-diamond", button: true, visible: true, order: 90,
    onChange: () => SnareManager.open(), onClick: () => SnareManager.open() };
  if (Array.isArray(controls)) {
    controls.find((c) => c.name === "token")?.tools.push(tool);
    return;
  }
  const tokens = controls.tokens ?? controls.token;
  if (tokens?.tools) tokens.tools[MODULE_ID] = { ...tool, order: Object.keys(tokens.tools).length };
});
