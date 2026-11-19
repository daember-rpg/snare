export const MODULE_ID = "snare";
export const SOCKET = `module.${MODULE_ID}`;

/** GM Core: DCs by level, 0 to 25. */
export const LEVEL_DC = [14, 15, 16, 18, 19, 20, 22, 23, 24, 26, 27, 28, 30, 31, 32, 34, 35, 36, 38, 39, 40, 42, 44, 46, 48, 50];

/** GM Core: XP for a simple hazard by level difference to the party. Complex hazards give five times this. */
export const XP_SIMPLE = { "-4": 2, "-3": 3, "-2": 4, "-1": 6, "0": 8, "1": 12, "2": 16, "3": 24, "4": 32 };

export const RANKS = ["Untrained", "Trained", "Expert", "Master", "Legendary"];

export const ACTIVITIES = [
  { id: "search", label: "Search", icon: "fa-magnifying-glass" },
  { id: "avoid-notice", label: "Avoid Notice", icon: "fa-user-secret" },
  { id: "scout", label: "Scout", icon: "fa-binoculars" },
  { id: "detect-magic", label: "Detect Magic", icon: "fa-wand-sparkles" },
  { id: "investigate", label: "Investigate", icon: "fa-book-open" },
  { id: "defend", label: "Defend", icon: "fa-shield-halved" },
  { id: "follow-the-expert", label: "Follow the Expert", icon: "fa-people-arrows" },
  { id: "hustle", label: "Hustle", icon: "fa-person-running" },
  { id: "", label: "Nothing in particular", icon: "fa-circle-minus" }
];

export const CONDITIONS = [
  ["prone", "Prone"], ["off-guard", "Off-Guard"], ["slowed", "Slowed"], ["clumsy", "Clumsy"],
  ["immobilized", "Immobilized"], ["grabbed", "Grabbed"], ["frightened", "Frightened"], ["stunned", "Stunned"],
  ["sickened", "Sickened"], ["enfeebled", "Enfeebled"], ["blinded", "Blinded"], ["deafened", "Deafened"]
];
export const VALUED = ["slowed", "clumsy", "frightened", "stunned", "sickened", "enfeebled"];

export const SKILLS = ["acrobatics", "arcana", "athletics", "crafting", "deception", "diplomacy", "intimidation", "medicine",
  "nature", "occultism", "performance", "religion", "society", "stealth", "survival", "thievery"];

export const DTYPES = ["piercing", "slashing", "bludgeoning", "fire", "cold", "electricity", "acid", "poison", "sonic",
  "force", "mental", "void", "vitality", "spirit", "bleed"];

export const TERRAIN = {
  slippery: "Slippery (Balance check)",
  difficult: "Difficult terrain",
  greater: "Greater difficult terrain",
  hazardous: "Hazardous terrain"
};

/** Pyre presets that fly from a point to a target. */
export const PYRE_STRIKE = [
  ["", "No animation"], ["std-force-bolt", "Bolt (force)"], ["std-ray-of-frost", "Ice shard"],
  ["std-hurtling-stone", "Stone"], ["std-hydraulic-push", "Water jet"], ["std-spirit-ray", "Spirit ray"], ["std-umbral-ray", "Umbral ray"]
];
/** Pyre presets that explode at a point. */
export const PYRE_BURST = [
  ["", "No animation"], ["std-fireball", "Fire"], ["std-ice-ball", "Ice"], ["std-blade-storm", "Shrapnel"],
  ["std-sound-burst", "Concussion"], ["std-psychic-ripple", "Psychic"], ["std-quench", "Water"]
];

export const EFFECT_META = {
  strike: { label: "Projectile strike", icon: "fa-location-arrow" },
  burst: { label: "Burst", icon: "fa-bomb" },
  condition: { label: "Condition", icon: "fa-person-falling" },
  terrain: { label: "Terrain change", icon: "fa-snowflake" }
};
