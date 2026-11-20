import { dcForLevel, newEffect } from "./store.js";

/** Rough level-based numbers for a quick start. The GM fine-tunes them in the builder. */
export const attackFor = (level) => dcForLevel(level) - 6;
export const saveFor = (level) => dcForLevel(level) + 2;
export function damageFor(level, die = 8) {
  const dice = Math.max(1, Math.ceil((Number(level) + 2) / 2));
  const bonus = Math.max(0, Number(level) || 0);
  return bonus ? `${dice}d${die}+${bonus}` : `${dice}d${die}`;
}

function strike(level, over = {}) {
  return { ...newEffect("strike", level), attack: attackFor(level), damage: damageFor(level), ...over };
}
function burst(level, over = {}) {
  return { ...newEffect("burst", level), dc: saveFor(level), damage: damageFor(level, 6), ...over };
}
function condition(level, over = {}) {
  return { ...newEffect("condition", level), ...over };
}
function terrain(level, over = {}) {
  return { ...newEffect("terrain", level), balanceDC: dcForLevel(level), ...over };
}

export const TEMPLATES = [
  {
    id: "bolt", label: "Dart or bolt", icon: "fa-location-arrow", origin: true, skill: "thievery",
    blurb: "Something shoots out of a wall at whoever steps on the trigger.",
    build: (L) => [strike(L, { dtype: "piercing", pyre: "std-force-bolt" })]
  },
  {
    id: "blades", label: "Spikes or blades", icon: "fa-khanda", origin: false, skill: "thievery",
    blurb: "Blades spring from the floor under the creature that stepped there.",
    build: (L) => [strike(L, { dtype: "slashing", pyre: "" })]
  },
  {
    id: "rune", label: "Explosive rune", icon: "fa-fire", origin: false, magical: true, skill: "arcana",
    blurb: "A rune bursts when touched and catches everyone nearby.",
    build: (L) => [burst(L, { center: "triggering", radius: 2, save: "reflex", basic: true, dtype: "fire", pyre: "std-fireball" })]
  },
  {
    id: "pit", label: "Hidden pit", icon: "fa-arrow-down", origin: false, skill: "thievery",
    blurb: "The floor gives way. A Reflex save grabs the edge; a failure means a fall.",
    build: (L) => {
      const depth = 20 + 10 * Math.floor(Math.max(0, L) / 3);
      return [
        burst(L, { center: "triggering", radius: 0, save: "reflex", basic: false, damage: String(depth / 2), dtype: "bludgeoning", pyre: "" }),
        condition(L, { condition: "prone", appliesTo: "failed" })
      ];
    }
  },
  {
    id: "collapse", label: "Collapsing ceiling", icon: "fa-house-crack", origin: false, skill: "athletics",
    blurb: "Stones fall on the area and leave rubble behind.",
    build: (L) => [
      burst(L, { center: "triggering", radius: 1, save: "reflex", basic: true, dtype: "bludgeoning", pyre: "std-blade-storm" }),
      terrain(L, { terrain: "difficult", area: "trigger", duration: "permanent" })
    ]
  },
  {
    id: "ice", label: "Slippery floor", icon: "fa-snowflake", origin: false, skill: "thievery",
    blurb: "Ice or oil spreads over the floor. Crossing it needs a Balance check.",
    build: (L) => [terrain(L, { terrain: "slippery", area: "trigger", duration: "permanent" })]
  },
  {
    id: "needle", label: "Poison needle", icon: "fa-syringe", origin: false, skill: "thievery",
    blurb: "A needle in a lock or chest jabs whoever fiddles with it.",
    build: (L) => [
      strike(L, { damage: damageFor(Math.max(0, L - 2), 4), dtype: "piercing", pyre: "" }),
      condition(L, { condition: "sickened", value: 1, appliesTo: "failed" })
    ]
  },
  {
    id: "custom", label: "Something else", icon: "fa-pen-ruler", origin: true, skill: "thievery",
    blurb: "Start empty and add the effects yourself.",
    build: () => []
  }
];

export const FEATURE_CARD = { id: 3, label: "Part of the scene", icon: "fa-mountain-sun", blurb: "Always there and always active. Nobody rolls to find it, and it can't be disabled." };

export const HIDDENNESS = [
  { id: 0, label: "In plain sight", icon: "fa-eye", blurb: "Anyone can notice it. Every PC gets a secret check, Searching or not.", minProf: 0, adj: 0 },
  { id: 1, label: "Hidden", icon: "fa-eye-low-vision", blurb: "Only characters who are Searching with Trained Perception get a check.", minProf: 1, adj: 2 },
  { id: 2, label: "Very well hidden", icon: "fa-eye-slash", blurb: "Only characters who are Searching with Expert Perception get a check.", minProf: 2, adj: 5 }
];
