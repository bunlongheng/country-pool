// Playable surface themes. Each theme recolors the felt bed and paints its own
// sport markings inside the felt clip. Physics is unaffected - this is pure paint.
// Coordinates are TABLE units (200 x 100), same space the physics uses.

export type PaintCtx = {
  ctx: CanvasRenderingContext2D;
  px: (x: number) => number; // table-x -> device px
  py: (y: number) => number; // table-y -> device px
  scale: number; // device px per table unit
};

export type Surface = {
  key: string;
  label: string;
  emoji: string;
  felt: [string, string, string]; // radial gradient: center, mid, edge
  draw: (g: PaintCtx) => void; // markings, drawn within the felt clip
};

const W = 200;
const H = 100;
const TAU = Math.PI * 2;

// ---- tiny paint helpers (table-unit coordinates) ----
function pen(g: PaintCtx, color: string, width: number) {
  g.ctx.strokeStyle = color;
  g.ctx.lineWidth = Math.max(0.8, g.scale * width);
}
function line(g: PaintCtx, x1: number, y1: number, x2: number, y2: number) {
  g.ctx.beginPath();
  g.ctx.moveTo(g.px(x1), g.py(y1));
  g.ctx.lineTo(g.px(x2), g.py(y2));
  g.ctx.stroke();
}
function box(g: PaintCtx, x: number, y: number, w: number, h: number) {
  g.ctx.strokeRect(g.px(x), g.py(y), w * g.scale, h * g.scale);
}
function fill(g: PaintCtx, x: number, y: number, w: number, h: number, color: string) {
  g.ctx.fillStyle = color;
  g.ctx.fillRect(g.px(x), g.py(y), w * g.scale, h * g.scale);
}
function ring(g: PaintCtx, x: number, y: number, r: number) {
  g.ctx.beginPath();
  g.ctx.arc(g.px(x), g.py(y), r * g.scale, 0, TAU);
  g.ctx.stroke();
}
function arc(g: PaintCtx, x: number, y: number, r: number, a0: number, a1: number) {
  g.ctx.beginPath();
  g.ctx.arc(g.px(x), g.py(y), r * g.scale, a0, a1);
  g.ctx.stroke();
}
function dot(g: PaintCtx, x: number, y: number, color = "rgba(255,255,255,0.9)", r = 0.7) {
  g.ctx.beginPath();
  g.ctx.arc(g.px(x), g.py(y), Math.max(1, g.scale * r), 0, TAU);
  g.ctx.fillStyle = color;
  g.ctx.fill();
}
// Alternating mow bands down the length of the pitch.
function stripes(g: PaintCtx, n: number, a: string, b: string) {
  const bw = W / n;
  for (let i = 0; i < n; i++) fill(g, i * bw, 0, bw, H, i % 2 ? b : a);
}

export const SURFACES: Surface[] = [
  {
    key: "pool",
    label: "Pool",
    emoji: "🎱",
    felt: ["#2b8a76", "#17685c", "#0d443d"],
    draw: (g) => {
      pen(g, "rgba(255,255,255,0.09)", 0.22);
      line(g, 50, 0, 50, H); // head string
      dot(g, 50, 50, "rgba(255,255,255,0.16)");
      dot(g, 140, 50, "rgba(255,255,255,0.16)");
    },
  },
  {
    key: "soccer",
    label: "Soccer",
    emoji: "⚽",
    felt: ["#43a457", "#348c48", "#1f6c34"],
    draw: (g) => {
      stripes(g, 10, "rgba(255,255,255,0.05)", "rgba(0,0,0,0.06)");
      pen(g, "rgba(255,255,255,0.75)", 0.4);
      box(g, 5, 5, W - 10, H - 10); // touchlines
      line(g, 100, 5, 100, H - 5); // halfway
      ring(g, 100, 50, 15); // centre circle
      dot(g, 100, 50);
      box(g, 5, 25, 26, 50); // penalty areas
      box(g, W - 31, 25, 26, 50);
      box(g, 5, 38, 10, 24); // goal areas
      box(g, W - 15, 38, 10, 24);
      dot(g, 22, 50);
      dot(g, W - 22, 50);
    },
  },
  {
    key: "football",
    label: "Football",
    emoji: "🏈",
    felt: ["#2f8a3e", "#237033", "#164f24"],
    draw: (g) => {
      stripes(g, 12, "rgba(255,255,255,0.04)", "rgba(0,0,0,0.05)");
      fill(g, 5, 5, 23, H - 10, "rgba(255,255,255,0.07)"); // end zones
      fill(g, W - 28, 5, 23, H - 10, "rgba(255,255,255,0.07)");
      pen(g, "rgba(255,255,255,0.55)", 0.3);
      box(g, 5, 5, W - 10, H - 10);
      for (let i = 0; i <= 10; i++) {
        const x = 28 + i * 14.4; // yard lines
        line(g, x, 5, x, H - 5);
      }
      pen(g, "rgba(255,255,255,0.4)", 0.22);
      for (let i = 0; i <= 10; i++) {
        const x = 28 + i * 14.4; // hash marks
        line(g, x, 37, x, 41);
        line(g, x, 59, x, 63);
      }
    },
  },
  {
    key: "basketball",
    label: "Basketball",
    emoji: "🏀",
    felt: ["#cf9247", "#b5762f", "#82501c"],
    draw: (g) => {
      pen(g, "rgba(0,0,0,0.06)", 0.18); // wood planks
      for (let y = 8; y < H; y += 8) line(g, 5, y, W - 5, y);
      pen(g, "rgba(255,255,255,0.6)", 0.4);
      box(g, 5, 6, W - 10, H - 12);
      line(g, 100, 6, 100, H - 6);
      ring(g, 100, 50, 12); // centre circle
      box(g, 5, 34, 38, 32); // keys
      ring(g, 43, 50, 11);
      box(g, W - 43, 34, 38, 32);
      ring(g, W - 43, 50, 11);
      arc(g, 12, 50, 42, -1.15, 1.15); // 3pt arcs
      arc(g, W - 12, 50, 42, Math.PI - 1.15, Math.PI + 1.15);
    },
  },
  {
    key: "baseball",
    label: "Baseball",
    emoji: "⚾",
    felt: ["#43a457", "#348c48", "#1f6c34"],
    draw: (g) => {
      const dirt = "rgba(196,150,94,0.9)";
      // Infield diamond: home left, rotated square of base paths.
      const home = [16, 50];
      const first = [50, 27];
      const second = [84, 50];
      const third = [50, 73];
      g.ctx.fillStyle = dirt;
      g.ctx.beginPath();
      g.ctx.moveTo(g.px(home[0]), g.py(home[1]));
      g.ctx.lineTo(g.px(first[0]), g.py(first[1]));
      g.ctx.lineTo(g.px(second[0]), g.py(second[1]));
      g.ctx.lineTo(g.px(third[0]), g.py(third[1]));
      g.ctx.closePath();
      g.ctx.globalAlpha = 0.28;
      g.ctx.fill();
      g.ctx.globalAlpha = 1;
      pen(g, dirt, 0.9);
      line(g, home[0], home[1], first[0], first[1]);
      line(g, first[0], first[1], second[0], second[1]);
      line(g, second[0], second[1], third[0], third[1]);
      line(g, third[0], third[1], home[0], home[1]);
      dot(g, 50, 50, dirt, 3.4); // pitcher's mound
      for (const b of [home, first, second, third]) dot(g, b[0], b[1], "rgba(255,255,255,0.95)", 1);
      pen(g, "rgba(255,255,255,0.5)", 0.4);
      arc(g, 16, 50, 176, -0.72, 0.72); // outfield fence
    },
  },
  {
    key: "tennis",
    label: "Tennis",
    emoji: "🎾",
    felt: ["#3f8f6c", "#2f7659", "#1d5540"],
    draw: (g) => {
      pen(g, "rgba(255,255,255,0.8)", 0.4);
      box(g, 8, 12, W - 16, H - 24); // doubles
      line(g, 8, 24, W - 8, 24); // singles sidelines
      line(g, 8, H - 24, W - 8, H - 24);
      line(g, 54, 24, 54, H - 24); // service lines
      line(g, W - 54, 24, W - 54, H - 24);
      line(g, 54, 50, W - 54, 50); // centre service line
      pen(g, "rgba(255,255,255,0.95)", 0.55);
      line(g, 100, 12, 100, H - 12); // net
    },
  },
  {
    key: "pingpong",
    label: "Ping Pong",
    emoji: "🏓",
    felt: ["#2f6fb0", "#255f9c", "#173f6e"],
    draw: (g) => {
      pen(g, "rgba(255,255,255,0.9)", 0.5);
      box(g, 6, 6, W - 12, H - 12); // white edge
      line(g, 6, 50, W - 6, 50); // centre line (length)
      pen(g, "rgba(235,235,235,0.95)", 0.7);
      line(g, 100, 4, 100, H - 4); // net
    },
  },
  {
    key: "swim",
    label: "Swim Lanes",
    emoji: "🏊",
    felt: ["#1f9fc4", "#1580a6", "#0c5273"],
    draw: (g) => {
      const lanes = 6;
      const lw = H / lanes;
      pen(g, "rgba(255,255,255,0.55)", 0.5);
      g.ctx.setLineDash([g.scale * 3, g.scale * 2]);
      for (let i = 1; i < lanes; i++) line(g, 5, i * lw, W - 5, i * lw); // lane ropes
      g.ctx.setLineDash([]);
      pen(g, "rgba(0,0,0,0.3)", 0.5);
      for (let i = 0; i < lanes; i++) line(g, 22, (i + 0.5) * lw, W - 22, (i + 0.5) * lw); // lane lines
      pen(g, "rgba(0,0,0,0.3)", 0.6);
      line(g, 16, 6, 16, H - 6); // end T-bars
      line(g, W - 16, 6, W - 16, H - 6);
    },
  },
];

// ---- Rail / frame materials. Each surface gets a themed frame + bolt colour and a
// gloss strength (0 = matte, 1 = mirror) that drives the light sheen on the rails. ----
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

const RAILS: Record<string, RailMaterial> = {
  pool: WOOD, // classic wood + brass
  soccer: ALUMINUM, // stadium aluminium
  football: LEATHER, // black leather
  basketball: WALNUT, // hardwood walnut
  baseball: WOOD, // natural bat wood
  tennis: METAL, // brushed gunmetal
  pingpong: BLACK, // matte black
  swim: ALUMINUM, // pool-deck aluminium
};

export function railFor(key: string): RailMaterial {
  return RAILS[key] ?? WOOD;
}

// ---- Cloth colours: popular pool-table felt shades, independent of the sport. Pick
// "classic" to keep each surface's own felt (grass for soccer, etc.); any other choice
// overrides the felt base colour while the sport markings still draw on top. ----
export type Cloth = { key: string; label: string; felt: [string, string, string] };

export const CLOTHS: Cloth[] = [
  { key: "classic", label: "Classic (per table)", felt: ["#2b8a76", "#17685c", "#0d443d"] },
  { key: "green", label: "Tournament Green", felt: ["#2f9c6a", "#1f7a52", "#124a33"] },
  { key: "blue", label: "Championship Blue", felt: ["#2f7fc4", "#1f5f9c", "#123a63"] },
  { key: "turquoise", label: "Dark Turquoise", felt: ["#1f9c94", "#137a72", "#0a4a45"] },
  { key: "red", label: "Burgundy Red", felt: ["#b0403f", "#8a2f2e", "#521a1a"] },
  { key: "purple", label: "Royal Purple", felt: ["#8250b8", "#5f3a86", "#382050"] },
  { key: "black", label: "Midnight Black", felt: ["#3a3a40", "#242427", "#0e0e10"] },
  { key: "tan", label: "Camel Tan", felt: ["#c2a86a", "#a38a4e", "#6a5a30"] },
  { key: "grey", label: "Slate Grey", felt: ["#8a9096", "#5f656b", "#33373b"] },
];

// The felt stops to paint, or null when "classic" (use the surface's own felt).
export function clothFor(key: string): [string, string, string] | null {
  if (key === "classic") return null;
  return CLOTHS.find((c) => c.key === key)?.felt ?? null;
}

export const DEFAULT_SURFACE = SURFACES[0];

export function surfaceByKey(key: string | null | undefined): Surface {
  return SURFACES.find((s) => s.key === key) ?? DEFAULT_SURFACE;
}
