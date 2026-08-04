// Ball themes = learnable categories. Every ball carries a NAME (spoken aloud and
// shown when it drops, so kids learn the category) plus a FACE - a flag/state image,
// an emoji, or a solid colour. Physics never sees any of this; it is pure presentation.
import { COUNTRIES } from "./countries";

export type Face =
  | { kind: "image"; src: string } // a PNG under /public (flags, state flags)
  | { kind: "emoji"; glyph: string } // rendered to a canvas texture at runtime
  | { kind: "ball"; n: number; color: string; stripe: boolean } // a real numbered pool ball
  | { kind: "color" }; // a solid glossy ball, colour taken from the item hue

export type BallItem = { name: string; hue: number; face: Face };
export type Theme = { key: string; label: string; icon: string; items: BallItem[] };

// --- Classic: a real 8-ball pool set - 1-7 solids, 8 black, 9-15 stripes, numbered. ---
const BALL_SET = [
  { n: 1, color: "#e6b400", hue: 48 },
  { n: 2, color: "#1c3fa8", hue: 222 },
  { n: 3, color: "#c81f1f", hue: 0 },
  { n: 4, color: "#5f2a86", hue: 275 },
  { n: 5, color: "#e0641b", hue: 24 },
  { n: 6, color: "#1f7a44", hue: 145 },
  { n: 7, color: "#8a1f2b", hue: 351 },
  { n: 8, color: "#161616", hue: 0 },
  { n: 9, color: "#e6b400", hue: 48 },
  { n: 10, color: "#1c3fa8", hue: 222 },
  { n: 11, color: "#c81f1f", hue: 0 },
  { n: 12, color: "#5f2a86", hue: 275 },
  { n: 13, color: "#e0641b", hue: 24 },
  { n: 14, color: "#1f7a44", hue: 145 },
  { n: 15, color: "#8a1f2b", hue: 351 },
];
const POOL_BALLS: BallItem[] = BALL_SET.map((b) => ({
  name: String(b.n),
  hue: b.hue,
  face: { kind: "ball", n: b.n, color: b.color, stripe: b.n > 8 } as Face,
}));

// --- Fruits: emoji faces (no downloads), hue tuned to the fruit's real colour. ---
const FRUITS: BallItem[] = [
  { name: "Apple", glyph: "🍎", hue: 0 },
  { name: "Banana", glyph: "🍌", hue: 50 },
  { name: "Orange", glyph: "🍊", hue: 28 },
  { name: "Grapes", glyph: "🍇", hue: 280 },
  { name: "Strawberry", glyph: "🍓", hue: 348 },
  { name: "Watermelon", glyph: "🍉", hue: 150 },
  { name: "Peach", glyph: "🍑", hue: 20 },
  { name: "Cherry", glyph: "🍒", hue: 352 },
  { name: "Pineapple", glyph: "🍍", hue: 48 },
  { name: "Mango", glyph: "🥭", hue: 33 },
  { name: "Lemon", glyph: "🍋", hue: 58 },
  { name: "Kiwi", glyph: "🥝", hue: 108 },
  { name: "Coconut", glyph: "🥥", hue: 30 },
  { name: "Pear", glyph: "🍐", hue: 84 },
  { name: "Blueberry", glyph: "🫐", hue: 220 },
].map((f) => ({ name: f.name, hue: f.hue, face: { kind: "emoji", glyph: f.glyph } as Face }));

// --- Vegetables: emoji faces. ---
const VEGGIES: BallItem[] = [
  { name: "Carrot", glyph: "🥕", hue: 28 },
  { name: "Broccoli", glyph: "🥦", hue: 120 },
  { name: "Corn", glyph: "🌽", hue: 50 },
  { name: "Tomato", glyph: "🍅", hue: 4 },
  { name: "Potato", glyph: "🥔", hue: 34 },
  { name: "Onion", glyph: "🧅", hue: 40 },
  { name: "Garlic", glyph: "🧄", hue: 40 },
  { name: "Eggplant", glyph: "🍆", hue: 275 },
  { name: "Bell Pepper", glyph: "🫑", hue: 120 },
  { name: "Cucumber", glyph: "🥒", hue: 100 },
  { name: "Mushroom", glyph: "🍄", hue: 0 },
  { name: "Avocado", glyph: "🥑", hue: 80 },
  { name: "Leafy Greens", glyph: "🥬", hue: 110 },
  { name: "Hot Pepper", glyph: "🌶️", hue: 5 },
  { name: "Peas", glyph: "🫛", hue: 100 },
].map((v) => ({ name: v.name, hue: v.hue, face: { kind: "emoji", glyph: v.glyph } as Face }));

// --- Countries: the original theme (flag PNGs in /public/flags). ---
const COUNTRY_ITEMS: BallItem[] = COUNTRIES.map((c) => ({
  name: c.name,
  hue: c.hue,
  face: { kind: "image", src: `/flags/${c.code}.png` },
}));

// --- US states: flag PNGs in /public/state-flags (public-domain, from flagcdn). ---
const US_STATES: { code: string; name: string }[] = [
  { code: "al", name: "Alabama" }, { code: "ak", name: "Alaska" },
  { code: "az", name: "Arizona" }, { code: "ar", name: "Arkansas" },
  { code: "ca", name: "California" }, { code: "co", name: "Colorado" },
  { code: "ct", name: "Connecticut" }, { code: "de", name: "Delaware" },
  { code: "fl", name: "Florida" }, { code: "ga", name: "Georgia" },
  { code: "hi", name: "Hawaii" }, { code: "id", name: "Idaho" },
  { code: "il", name: "Illinois" }, { code: "in", name: "Indiana" },
  { code: "ia", name: "Iowa" }, { code: "ks", name: "Kansas" },
  { code: "ky", name: "Kentucky" }, { code: "la", name: "Louisiana" },
  { code: "me", name: "Maine" }, { code: "md", name: "Maryland" },
  { code: "ma", name: "Massachusetts" }, { code: "mi", name: "Michigan" },
  { code: "mn", name: "Minnesota" }, { code: "ms", name: "Mississippi" },
  { code: "mo", name: "Missouri" }, { code: "mt", name: "Montana" },
  { code: "ne", name: "Nebraska" }, { code: "nv", name: "Nevada" },
  { code: "nh", name: "New Hampshire" }, { code: "nj", name: "New Jersey" },
  { code: "nm", name: "New Mexico" }, { code: "ny", name: "New York" },
  { code: "nc", name: "North Carolina" }, { code: "nd", name: "North Dakota" },
  { code: "oh", name: "Ohio" }, { code: "ok", name: "Oklahoma" },
  { code: "or", name: "Oregon" }, { code: "pa", name: "Pennsylvania" },
  { code: "ri", name: "Rhode Island" }, { code: "sc", name: "South Carolina" },
  { code: "sd", name: "South Dakota" }, { code: "tn", name: "Tennessee" },
  { code: "tx", name: "Texas" }, { code: "ut", name: "Utah" },
  { code: "vt", name: "Vermont" }, { code: "va", name: "Virginia" },
  { code: "wa", name: "Washington" }, { code: "wv", name: "West Virginia" },
  { code: "wi", name: "Wisconsin" }, { code: "wy", name: "Wyoming" },
];
const STATE_ITEMS: BallItem[] = US_STATES.map((s, i) => ({
  name: s.name,
  hue: (i * 31) % 360, // deterministic spread for the marble glow
  face: { kind: "image", src: `/state-flags/${s.code}.png` },
}));

export const THEMES: Theme[] = [
  { key: "classic", label: "Classic", icon: "🎱", items: POOL_BALLS },
  { key: "country", label: "Countries", icon: "🌍", items: COUNTRY_ITEMS },
  { key: "fruit", label: "Fruits", icon: "🍎", items: FRUITS },
  { key: "veg", label: "Veggies", icon: "🥦", items: VEGGIES },
  { key: "usstate", label: "US States", icon: "🏛️", items: STATE_ITEMS },
];

export const RANDOM_KEY = "random";
export const DEFAULT_THEME = "classic";

export function themeByKey(key: string): Theme | undefined {
  return THEMES.find((t) => t.key === key);
}

// Pick n random items for a rack. "random" picks a whole RANDOM category each rack, so
// every New Rack surprises you with a different category (countries, then fruits, etc.).
export function pickItems(key: string, n: number): BallItem[] {
  const theme = key === RANDOM_KEY ? THEMES[Math.floor(Math.random() * THEMES.length)] : themeByKey(key);
  const pool = theme?.items ?? COUNTRY_ITEMS;
  const idx = pool.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, Math.min(n, pool.length)).map((i) => pool[i]);
}
