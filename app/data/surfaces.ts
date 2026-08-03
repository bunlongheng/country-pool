// Table customisation data: felt cloth colours, rail/frame materials, and cue-stick
// materials. Pure data - physics is unaffected. (The old sport "table styles" with
// painted markings were removed; a pool table just has felt + rails + a cue.)

// ---- Rail / frame materials: a vertical frame gradient + bright trim + bolt colour and
// a gloss strength (0 = matte, 1 = mirror) driving the light sheen on the rails. ----
export type RailMaterial = {
  frame: [string, string, string]; // vertical gradient top -> mid -> bottom
  edge: string; // bright outer + inner trim
  bolt: string; // bolt colour
  gloss: number; // 0..1 sheen strength
};

const WOOD: RailMaterial = { frame: ["#6b4525", "#5a3a1f", "#3a2412"], edge: "#d9b25a", bolt: "#d9b25a", gloss: 0.35 };
const WALNUT: RailMaterial = { frame: ["#5a3a22", "#432a17", "#281809"], edge: "#c79a5a", bolt: "#c79a5a", gloss: 0.4 };
const LEATHER: RailMaterial = { frame: ["#4a3128", "#33211b", "#1c110d"], edge: "#b98a4e", bolt: "#7a5a3a", gloss: 0.22 };
const BLACK: RailMaterial = { frame: ["#34353b", "#212227", "#0c0c0f"], edge: "#8a8f98", bolt: "#b8bcc4", gloss: 0.5 };
const METAL: RailMaterial = { frame: ["#8b929b", "#565c64", "#2e333a"], edge: "#dfe4ea", bolt: "#eef2f6", gloss: 0.72 };
const ALUMINUM: RailMaterial = { frame: ["#cfd3d8", "#9aa0a7", "#646a72"], edge: "#eef1f4", bolt: "#f4f6f8", gloss: 0.82 };

export const DEFAULT_RAIL = WOOD;

export const RAIL_OPTIONS: { key: string; label: string; mat: RailMaterial }[] = [
  { key: "wood", label: "Wood", mat: WOOD },
  { key: "walnut", label: "Walnut", mat: WALNUT },
  { key: "leather", label: "Leather", mat: LEATHER },
  { key: "black", label: "Black", mat: BLACK },
  { key: "metal", label: "Metal", mat: METAL },
  { key: "aluminum", label: "Aluminum", mat: ALUMINUM },
];

export function railByKey(key: string): RailMaterial {
  return RAIL_OPTIONS.find((r) => r.key === key)?.mat ?? DEFAULT_RAIL;
}

// ---- Cue-stick materials: a shaft gradient (butt -> tip) + a grip-wrap colour. ----
export type StickMaterial = { shaft: [string, string, string]; wrap: string };
export const STICKS: { key: string; label: string; mat: StickMaterial }[] = [
  { key: "wood", label: "Wood", mat: { shaft: ["#c89a5a", "#a8783c", "#6a4a24"], wrap: "#3a2412" } },
  { key: "black", label: "Black", mat: { shaft: ["#4a4a52", "#2a2a30", "#0e0e12"], wrap: "#111114" } },
  { key: "bamboo", label: "Bamboo", mat: { shaft: ["#e2d59c", "#c4b06a", "#8a7538"], wrap: "#5a4a24" } },
  { key: "redwalnut", label: "Red Walnut", mat: { shaft: ["#a85a3f", "#7a3524", "#4a1e12"], wrap: "#2a1008" } },
  { key: "aluminum", label: "Aluminum", mat: { shaft: ["#e6eaef", "#a8afb8", "#61686f"], wrap: "#33383e" } },
];

export function stickByKey(key: string): StickMaterial {
  return STICKS.find((s) => s.key === key)?.mat ?? STICKS[0].mat;
}

// ---- Cloth colours: the felt shade. Each is a radial gradient (centre, mid, edge). ----
export type Cloth = { key: string; label: string; felt: [string, string, string] };
export const CLOTHS: Cloth[] = [
  { key: "green", label: "Tournament Green", felt: ["#2f9c6a", "#1f7a52", "#124a33"] },
  { key: "emerald", label: "Emerald Green", felt: ["#1f8f5a", "#136b42", "#0a3f28"] },
  { key: "classic", label: "Classic Teal", felt: ["#2b8a76", "#17685c", "#0d443d"] },
  { key: "orange", label: "Hardwood Orange", felt: ["#e0913f", "#c06a24", "#7a3f14"] },
  { key: "blue", label: "Championship Blue", felt: ["#2f7fc4", "#1f5f9c", "#123a63"] },
  { key: "turquoise", label: "Dark Turquoise", felt: ["#1f9c94", "#137a72", "#0a4a45"] },
  { key: "red", label: "Burgundy Red", felt: ["#b0403f", "#8a2f2e", "#521a1a"] },
  { key: "purple", label: "Royal Purple", felt: ["#8250b8", "#5f3a86", "#382050"] },
  { key: "black", label: "Midnight Black", felt: ["#3a3a40", "#242427", "#0e0e10"] },
  { key: "tan", label: "Camel Tan", felt: ["#c2a86a", "#a38a4e", "#6a5a30"] },
];

export const DEFAULT_CLOTH = CLOTHS[0].felt;

export function clothFor(key: string): [string, string, string] {
  return CLOTHS.find((c) => c.key === key)?.felt ?? DEFAULT_CLOTH;
}
