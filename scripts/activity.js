import { MODULE_ID, ACTIVITIES } from "./constants.js";
import { esc } from "./store.js";
import { activityOf } from "./engine.js";

const { ApplicationV2 } = foundry.applications.api;

/** A small picker players use to say what their character does while exploring. */
export class ActivityPicker extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    classes: ["snare-app", "snare-picker"],
    tag: "div",
    window: { title: "Exploration activity", icon: "fa-solid fa-person-hiking", resizable: false },
    position: { width: 340, height: "auto" }
  };

  static open(actor) {
    if (!actor) return;
    if (!actor.isOwner) return ui.notifications.warn("Snare: you can only set the activity of your own character.");
    const app = new ActivityPicker({ id: `snare-activity-${actor.id}` });
    app.actor = actor;
    app.render({ force: true });
  }

  async _renderHTML() {
    const current = activityOf(this.actor);
    return `<div class="snare-picker-body">
      <p class="snare-picker-who">${esc(this.actor.name)}</p>
      <div class="snare-picker-grid">${ACTIVITIES.map((a) => `<button type="button" class="snare-act${a.id === current ? " is-on" : ""}" data-activity="${a.id}" aria-pressed="${a.id === current}">
        <i class="fa-solid ${a.icon}"></i><span>${a.label}</span></button>`).join("")}</div>
      <p class="snare-muted small">Searching lets you notice hidden traps that need a trained eye.</p>
    </div>`;
  }

  _replaceHTML(result, content) {
    content.innerHTML = result;
    content.querySelectorAll("[data-activity]").forEach((b) => b.addEventListener("click", async () => {
      await this.actor.setFlag(MODULE_ID, "activity", b.dataset.activity);
      const label = ACTIVITIES.find((a) => a.id === b.dataset.activity)?.label ?? "";
      ui.notifications.info(`${this.actor.name}: ${label}.`);
      this.close();
    }));
  }
}

export function registerActivityEntryPoints() {
  // Triad tray: a tool button for the character on display.
  Hooks.on("triad.ready", (api) => {
    if (typeof api?.registerTool !== "function") return;
    api.registerTool({
      id: MODULE_ID,
      label: "Exploration activity",
      icon: "fa-solid fa-person-hiking",
      order: 20,
      visible: (actor) => actor?.type === "character" && actor.isOwner,
      onClick: (actor) => ActivityPicker.open(actor)
    });
  });

  // Token HUD, for anyone without Triad.
  Hooks.on("renderTokenHUD", (hud, html) => {
    const root = html instanceof HTMLElement ? html : html?.[0];
    const doc = hud.object?.document;
    const actor = doc?.actor;
    if (!root || actor?.type !== "character" || !actor.isOwner) return;
    const col = root.querySelector(".col.left");
    if (!col || col.querySelector(".snare-hud")) return;
    const current = ACTIVITIES.find((a) => a.id === activityOf(actor));
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "control-icon snare-hud";
    btn.dataset.tooltip = `Exploration activity${current?.id ? `: ${current.label}` : ""}`;
    btn.innerHTML = `<i class="fa-solid ${current?.id ? current.icon : "fa-person-hiking"}"></i>`;
    btn.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); ActivityPicker.open(actor); });
    col.append(btn);
  });
}
