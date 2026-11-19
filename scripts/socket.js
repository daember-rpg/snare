import { SOCKET } from "./constants.js";
import { isActiveGM } from "./store.js";

const handlers = {};

export function onMessage(type, fn) { handlers[type] = fn; }

export function initSocket() {
  game.socket.on(SOCKET, (msg) => {
    if (!msg?.type) return;
    if (msg.type === "fx") return handlers.fx?.(msg);
    if (msg.type === "refresh") return handlers.refresh?.(msg);
    if (!isActiveGM()) return;
    handlers[msg.type]?.(msg);
  });
}

/** Run on the active GM: directly when that is me, otherwise through the socket. */
export async function toGM(msg) {
  if (isActiveGM()) return handlers[msg.type]?.(msg);
  if (!game.users.activeGM) {
    ui.notifications.warn("Snare: no GM is connected, so the trap can't resolve.");
    return;
  }
  game.socket.emit(SOCKET, msg);
}

/** Play on every client, me included. */
export function broadcastFx(msg) {
  const m = { ...msg, type: "fx" };
  game.socket.emit(SOCKET, m);
  handlers.fx?.(m);
}
