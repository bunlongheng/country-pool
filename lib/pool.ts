// Pure, deterministic pool physics. No DOM, no rendering - just balls, cushions,
// pockets, and elastic collisions in table units. The canvas component owns the
// render + the real-time loop and feeds dt in; everything here is unit-testable.

export type Ball = {
  id: number;
  ci: number; // country index into COUNTRIES (-1 for the cue ball)
  x: number;
  y: number;
  vx: number;
  vy: number;
  sunk: boolean;
  isCue: boolean;
};

// Play surface in table units (2:1, the classic pool ratio). Screen mapping is the
// renderer's job - physics never sees pixels.
export const TABLE = { w: 200, h: 100 };
// Ball + pocket radii. Exposed as live bindings (not const) so the Normal/Big/Huge
// ball-size option can scale them - along with the rack, cushions and pocket capture -
// together at runtime via setBallSize(). Tests use the defaults (factor 1).
export const BASE_BALL_R = 2.55;
export const BASE_POCKET_R = 4.8;
export let BALL_R = BASE_BALL_R;
export let POCKET_R = BASE_POCKET_R;
// Cushion restitution (how bouncy the rails are) and rolling friction per second.
export const RAIL_BOUNCE = 0.86;
export const FRICTION = 1.9; // higher = balls stop sooner
export const STOP_EPS = 0.35; // below this speed a ball is parked
export const MAX_SHOT = 1300; // cap on launch speed (table units / s)

// The 6 pockets: 4 corners + 2 side pockets at the long-rail midpoints. The side
// pockets are recessed back INTO the rail (their centre sits past the cushion line) so
// a ball must be driven firmly and squarely to the rail to drop - a lazy straight roll
// stops at the jaws instead of being swallowed.
export const BASE_SIDE_RECESS = 2.2;
export let SIDE_RECESS = BASE_SIDE_RECESS;
export const POCKETS: { x: number; y: number }[] = [
  { x: 0, y: 0 },
  { x: TABLE.w / 2, y: -SIDE_RECESS },
  { x: TABLE.w, y: 0 },
  { x: 0, y: TABLE.h },
  { x: TABLE.w / 2, y: TABLE.h + SIDE_RECESS },
  { x: TABLE.w, y: TABLE.h },
];

// Scale ball + pocket sizes together (the pocket/ball ratio is preserved so potting
// still works) and reposition the recessed side pockets. Physics, the rack, cushions
// and rendering all read these live bindings, so one call resizes the whole game
// consistently. factor 1 = default (tests); the UI offers 1.5 / 2 / 2.5 (Normal / Big / Huge).
export function setBallSize(factor: number): void {
  const f = Math.max(0.5, Math.min(3, factor));
  // Pockets grow at 0.7x the ball's rate so big balls still drop, but the holes never
  // balloon past the rail into cartoon territory. (pf stays comfortably above the
  // f-scaled ball radius: e.g. at f=2, BALL_R=5.1 vs POCKET_R=8.16.)
  const pf = 1 + (f - 1) * 0.7;
  BALL_R = BASE_BALL_R * f;
  POCKET_R = BASE_POCKET_R * pf;
  SIDE_RECESS = BASE_SIDE_RECESS * pf;
  POCKETS[1].y = -SIDE_RECESS;
  POCKETS[4].y = TABLE.h + SIDE_RECESS;
}

export type StepEvents = {
  rails: number; // cushion bounces this step
  clicks: number[]; // impact speeds of ball-ball collisions
  pocketed: number[]; // ball ids that dropped this step
};

function speed(b: Ball): number {
  return Math.hypot(b.vx, b.vy);
}

// One integration sub-step of dt seconds. Kept small by stepWorld to avoid tunneling.
function substep(balls: Ball[], dt: number, ev: StepEvents): void {
  for (const b of balls) {
    if (b.sunk) continue;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    // Rolling friction: exponential decay, then hard-park below the threshold.
    const decay = Math.exp(-FRICTION * dt);
    b.vx *= decay;
    b.vy *= decay;
    if (speed(b) < STOP_EPS) {
      b.vx = 0;
      b.vy = 0;
    }
  }

  // Pockets: a ball whose centre falls inside a pocket mouth drops. Corners are
  // generous (a ball rolling down the rail into a corner is a real shot, and it keeps
  // the ball in bounds). Side pockets face INTO the table, so a ball skimming parallel
  // to the long rail must roll past - it only drops if actually heading into the mouth.
  const sideX = TABLE.w / 2;
  for (const b of balls) {
    if (b.sunk) continue;
    for (const p of POCKETS) {
      const d = Math.hypot(b.x - p.x, b.y - p.y);
      if (d >= POCKET_R) continue;
      if (p.x === sideX) {
        const sp = Math.hypot(b.vx, b.vy);
        const dy = p.y - b.y;
        // A side pocket faces INTO the table: entering the mouth means moving toward
        // the rail (the y direction), not skimming along it. Rail-parallel balls have
        // ~no y-velocity, so they roll past unless deep in the throat or nearly stopped.
        const intoMouth = (b.vy * dy) / (sp * (Math.abs(dy) || 1));
        if (sp > STOP_EPS * 2 && d > POCKET_R * 0.45 && intoMouth < 0.5) continue;
      }
      b.sunk = true;
      b.vx = 0;
      b.vy = 0;
      ev.pocketed.push(b.id);
      break;
    }
  }

  // Cushions: reflect off the 4 rails (skip if the ball is over a pocket gap so it
  // can fall rather than bounce out of the jaws).
  for (const b of balls) {
    if (b.sunk) continue;
    const nearPocket = POCKETS.some((p) => Math.hypot(b.x - p.x, b.y - p.y) < POCKET_R * 1.5);
    if (nearPocket) continue;
    if (b.x < BALL_R) {
      b.x = BALL_R;
      if (b.vx < 0) {
        b.vx = -b.vx * RAIL_BOUNCE;
        ev.rails++;
      }
    } else if (b.x > TABLE.w - BALL_R) {
      b.x = TABLE.w - BALL_R;
      if (b.vx > 0) {
        b.vx = -b.vx * RAIL_BOUNCE;
        ev.rails++;
      }
    }
    if (b.y < BALL_R) {
      b.y = BALL_R;
      if (b.vy < 0) {
        b.vy = -b.vy * RAIL_BOUNCE;
        ev.rails++;
      }
    } else if (b.y > TABLE.h - BALL_R) {
      b.y = TABLE.h - BALL_R;
      if (b.vy > 0) {
        b.vy = -b.vy * RAIL_BOUNCE;
        ev.rails++;
      }
    }
  }

  // Safety net: a ball that slipped past a rail - through a recessed pocket mouth or
  // shoved there by a collision near a corner (where cushion bounces are skipped) - is
  // bounced back onto the felt rather than left sitting on the wooden frame. Covers both
  // axes so a ball can never end up over the frame. A ball genuinely dropping into a
  // pocket is already sunk (captured within POCKET_R) before it reaches the frame edge,
  // so this never steals a real pot.
  for (const b of balls) {
    if (b.sunk) continue;
    if (b.x < 0) {
      b.x = BALL_R;
      b.vx = Math.abs(b.vx) * RAIL_BOUNCE;
      ev.rails++;
    } else if (b.x > TABLE.w) {
      b.x = TABLE.w - BALL_R;
      b.vx = -Math.abs(b.vx) * RAIL_BOUNCE;
      ev.rails++;
    }
    if (b.y < 0) {
      b.y = BALL_R;
      b.vy = Math.abs(b.vy) * RAIL_BOUNCE;
      ev.rails++;
    } else if (b.y > TABLE.h) {
      b.y = TABLE.h - BALL_R;
      b.vy = -Math.abs(b.vy) * RAIL_BOUNCE;
      ev.rails++;
    }
  }

  // Ball-ball: equal-mass elastic collision. Swap the velocity component along the
  // contact normal, keep the tangential part, and push apart to de-overlap.
  for (let i = 0; i < balls.length; i++) {
    const a = balls[i];
    if (a.sunk) continue;
    for (let j = i + 1; j < balls.length; j++) {
      const b = balls[j];
      if (b.sunk) continue;
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let dist = Math.hypot(dx, dy);
      const min = BALL_R * 2;
      if (dist === 0) {
        dx = 0.01;
        dy = 0;
        dist = 0.01;
      }
      if (dist < min) {
        const nx = dx / dist;
        const ny = dy / dist;
        // Separate the overlap equally.
        const overlap = (min - dist) / 2;
        a.x -= nx * overlap;
        a.y -= ny * overlap;
        b.x += nx * overlap;
        b.y += ny * overlap;
        // Relative velocity along the normal.
        const rvx = b.vx - a.vx;
        const rvy = b.vy - a.vy;
        const vn = rvx * nx + rvy * ny;
        if (vn < 0) {
          // moving toward each other -> exchange normal component
          a.vx += vn * nx;
          a.vy += vn * ny;
          b.vx -= vn * nx;
          b.vy -= vn * ny;
          ev.clicks.push(Math.abs(vn));
        }
      }
    }
  }
}

// Advance the whole world by dt, split into sub-steps sized to the fastest ball so
// nothing tunnels through a cushion or another ball in a single frame.
export function stepWorld(balls: Ball[], dt: number): StepEvents {
  const ev: StepEvents = { rails: 0, clicks: [], pocketed: [] };
  let max = 0;
  for (const b of balls) if (!b.sunk) max = Math.max(max, speed(b));
  // Cap travel per sub-step to a fraction of a ball radius.
  const steps = Math.min(32, Math.max(1, Math.ceil((max * dt) / (BALL_R * 0.5))));
  const h = dt / steps;
  for (let s = 0; s < steps; s++) substep(balls, h, ev);
  return ev;
}

// Every ball has stopped (or is sunk) - the cue is safe to take again.
export function allStopped(balls: Ball[]): boolean {
  return balls.every((b) => b.sunk || (b.vx === 0 && b.vy === 0));
}

// Turn an aim direction + power (0..1) into a launch velocity on the cue ball.
export function shoot(cue: Ball, dirX: number, dirY: number, power: number): void {
  const len = Math.hypot(dirX, dirY) || 1;
  const p = Math.max(0, Math.min(1, power));
  cue.vx = (dirX / len) * MAX_SHOT * p;
  cue.vy = (dirY / len) * MAX_SHOT * p;
}

// Trace the cue ball's aim line forward, reflecting off cushions, up to a distance.
// Returns the polyline points (table units) for the guide overlay. Pure geometry -
// ignores other balls (a simple, readable guide, not a full sim).
export function aimPath(
  cx: number,
  cy: number,
  dirX: number,
  dirY: number,
  maxLen: number,
  bounces = 1,
): { x: number; y: number }[] {
  const len = Math.hypot(dirX, dirY) || 1;
  let px = cx;
  let py = cy;
  let dx = dirX / len;
  let dy = dirY / len;
  const pts = [{ x: px, y: py }];
  let remaining = maxLen;
  let left = bounces;
  const lo = BALL_R;
  const hiX = TABLE.w - BALL_R;
  const hiY = TABLE.h - BALL_R;
  for (let guard = 0; guard < 8 && remaining > 0; guard++) {
    // Distance to each wall along the current direction.
    const tx = dx > 0 ? (hiX - px) / dx : dx < 0 ? (lo - px) / dx : Infinity;
    const ty = dy > 0 ? (hiY - py) / dy : dy < 0 ? (lo - py) / dy : Infinity;
    const t = Math.min(tx, ty, remaining);
    px += dx * t;
    py += dy * t;
    pts.push({ x: px, y: py });
    remaining -= t;
    if (t >= remaining && (tx > remaining && ty > remaining)) break;
    if (left <= 0) break;
    if (t === tx) dx = -dx;
    if (t === ty) dy = -dy;
    left--;
  }
  return pts;
}

// Kids-mode aim aid: fire a ray from the cue centre along the shot direction and
// find the first object ball it would strike. Returns the contact point (where the
// cue centre sits at impact), the struck ball, and the direction that ball is pushed
// (the classic "ghost ball" aid). Pure geometry - ignores cushions and later balls.
export function predictHit(
  cx: number,
  cy: number,
  dirX: number,
  dirY: number,
  balls: Ball[],
): { contactX: number; contactY: number; target: Ball; dirX: number; dirY: number } | null {
  const len = Math.hypot(dirX, dirY) || 1;
  const dx = dirX / len;
  const dy = dirY / len;
  const sum = BALL_R * 2;
  let bestT = Infinity;
  let best: Ball | null = null;
  for (const b of balls) {
    if (b.sunk || b.isCue) continue;
    const lx = b.x - cx;
    const ly = b.y - cy;
    const tca = lx * dx + ly * dy;
    if (tca < 0) continue; // behind the aim
    const d2 = lx * lx + ly * ly - tca * tca;
    if (d2 > sum * sum) continue; // ray misses this ball
    const t = tca - Math.sqrt(sum * sum - d2); // first contact along the ray
    if (t < 0) continue;
    if (t < bestT) {
      bestT = t;
      best = b;
    }
  }
  if (!best) return null;
  const contactX = cx + dx * bestT;
  const contactY = cy + dy * bestT;
  const nx = best.x - contactX;
  const ny = best.y - contactY;
  const nl = Math.hypot(nx, ny) || 1;
  return { contactX, contactY, target: best, dirX: nx / nl, dirY: ny / nl };
}

// Rack: cue ball on the head spot, 15 flag balls in the classic triangle at the foot.
export function rack(countryIndices: number[]): Ball[] {
  const balls: Ball[] = [];
  balls.push({
    id: 0,
    ci: -1,
    x: TABLE.w * 0.25,
    y: TABLE.h / 2,
    vx: 0,
    vy: 0,
    sunk: false,
    isCue: true,
  });
  const gap = BALL_R * 2 + 0.15;
  const apexX = TABLE.w * 0.7;
  let id = 1;
  let ci = 0;
  for (let row = 0; row < 5; row++) {
    for (let k = 0; k <= row; k++) {
      const x = apexX + row * gap * 0.87;
      const y = TABLE.h / 2 + (k - row / 2) * gap;
      balls.push({
        id: id++,
        ci: countryIndices[ci % countryIndices.length],
        x,
        y,
        vx: 0,
        vy: 0,
        sunk: false,
        isCue: false,
      });
      ci++;
    }
  }
  return balls;
}

// Place the cue on the head spot after a scratch. If that spot is occupied, nudge to the
// nearest clear position (spiral search) so the cue never respots overlapping a ball.
export function respotCue(balls: Ball[]): void {
  const cue = balls.find((b) => b.isCue);
  if (!cue) return;
  const sx = TABLE.w * 0.25;
  const sy = TABLE.h / 2;
  const min = BALL_R * 2 + 0.05;
  const clear = (x: number, y: number) =>
    balls.every((b) => b.isCue || b.sunk || Math.hypot(b.x - x, b.y - y) >= min);
  let bx = sx;
  let by = sy;
  if (!clear(sx, sy)) {
    let placed = false;
    for (let r = min; r <= TABLE.w && !placed; r += BALL_R) {
      for (let a = 0; a < 16 && !placed; a++) {
        const ang = (a / 16) * Math.PI * 2;
        const x = Math.min(TABLE.w - BALL_R, Math.max(BALL_R, sx + Math.cos(ang) * r));
        const y = Math.min(TABLE.h - BALL_R, Math.max(BALL_R, sy + Math.sin(ang) * r));
        if (clear(x, y)) {
          bx = x;
          by = y;
          placed = true;
        }
      }
    }
  }
  cue.x = bx;
  cue.y = by;
  cue.vx = 0;
  cue.vy = 0;
  cue.sunk = false;
}

// ---- AI shot planner ------------------------------------------------------------------
// This is a real look-ahead AI, not a geometry guess. For each candidate shot it clones
// the world and SIMULATES it to a full stop with the same physics the game runs - so it
// knows exactly where every ball (and the cue) lands. Two hard rules the owner asked for:
//   1. Never die - a shot that scratches the cue ball is rejected outright.
//   2. Don't waste shots - it prefers the line that runs the most balls in the fewest
//      turns, projected by a greedy run-out rollout several shots deep.

export type ShotPlan = {
  dirX: number;
  dirY: number;
  power: number;
  target: Ball;
  pocket: { x: number; y: number };
  straightness: number; // 0..1 (1 = dead-straight, easiest); low = risky cut
  viable: boolean; // true = simulated to sink a ball cleanly; false = a safety
  reason: string; // human-readable why - for the move log
};

const DIAG = Math.hypot(TABLE.w, TABLE.h);

type Cand = { target: Ball; pocket: { x: number; y: number }; dirX: number; dirY: number; align: number; dist: number };

// Clone the world, fire one shot, and run physics to a stop. Reports what dropped and
// the settled layout - the AI's "project where the balls land" step.
export function simulateShot(
  balls: Ball[],
  dirX: number,
  dirY: number,
  power: number,
): { balls: Ball[]; pottedNonCue: number; scratched: boolean } {
  const sim = balls.map((b) => ({ ...b }));
  const cue = sim.find((b) => b.isCue);
  if (!cue) return { balls: sim, pottedNonCue: 0, scratched: false };
  shoot(cue, dirX, dirY, power);
  let scratched = false;
  let pottedNonCue = 0;
  for (let i = 0; i < 60 * 10 && !allStopped(sim); i++) {
    const ev = stepWorld(sim, 1 / 60);
    for (const id of ev.pocketed) {
      const b = sim.find((x) => x.id === id);
      if (b?.isCue) scratched = true;
      else pottedNonCue++;
    }
  }
  return { balls: sim, pottedNonCue, scratched };
}

// Every clean pot available in a layout (ghost-ball geometry + clear line to the ball).
function viableShots(balls: Ball[]): Cand[] {
  const cue = balls.find((b) => b.isCue && !b.sunk);
  if (!cue) return [];
  const out: Cand[] = [];
  for (const t of balls) {
    if (t.isCue || t.sunk) continue;
    for (const p of POCKETS) {
      const gx = p.x - t.x;
      const gy = p.y - t.y;
      const gd = Math.hypot(gx, gy);
      if (gd < 1e-3) continue;
      const gux = gx / gd;
      const guy = gy / gd;
      const ghx = t.x - gux * BALL_R * 2; // ghost point one diameter behind T on the T->P line
      const ghy = t.y - guy * BALL_R * 2;
      const cx = ghx - cue.x;
      const cy = ghy - cue.y;
      const cd = Math.hypot(cx, cy);
      if (cd < 1e-3) continue;
      const cux = cx / cd;
      const cuy = cy / cd;
      const align = cux * gux + cuy * guy;
      if (align < 0.25) continue; // too thin a cut to trust
      const hit = predictHit(cue.x, cue.y, cux, cuy, balls);
      if (!hit || hit.target.id !== t.id) continue; // another ball blocks the line
      out.push({ target: t, pocket: p, dirX: cux, dirY: cuy, align, dist: cd + gd });
    }
  }
  return out;
}

// Controlled pace: enough to carry the ball its full path, more for thin cuts, capped.
function powerFor(dist: number, align: number): number {
  return Math.max(0.4, Math.min(1, 0.34 + dist / (DIAG * 1.25) + (1 - align) * 0.35));
}

// The best next-shot makeability in a layout (0 = nothing on) - used to value the leave.
function bestAlign(balls: Ball[]): number {
  let m = 0;
  for (const c of viableShots(balls)) if (c.align > m) m = c.align;
  return m;
}

// Greedy run-out projection: from a layout, keep taking the straightest pot and
// simulating it, up to `depth` shots deep. Returns how many balls the line runs and
// whether it ever scratches. This is the "think many shots ahead" that rewards clearing
// the rack in the fewest turns. Greedy (single line), so it stays fast - not a full tree.
function projectRunOut(balls: Ball[], depth: number): { potted: number; scratched: boolean } {
  let cur = balls;
  let potted = 0;
  for (let d = 0; d < depth; d++) {
    const cands = viableShots(cur);
    if (!cands.length) break;
    cands.sort((a, b) => b.align - a.align || a.dist - b.dist);
    const c = cands[0];
    const sim = simulateShot(cur, c.dirX, c.dirY, powerFor(c.dist, c.align));
    if (sim.scratched) return { potted, scratched: true };
    if (sim.pottedNonCue === 0) break; // the line missed - run ends here
    potted += sim.pottedNonCue;
    cur = sim.balls;
  }
  return { potted, scratched: false };
}

function nearestPocketTo(x: number, y: number): { x: number; y: number } {
  let best = POCKETS[0];
  let bd = Infinity;
  for (const p of POCKETS) {
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return best;
}

type Scored = ShotPlan & { _scratch: boolean; _pots: number; _ro: number };

// No clean pot (or every pot scratches): find the safest developing shot. Roll gently
// into a reachable ball at a few paces, simulate each, and keep the non-scratch option
// that leaves the best next shot. Never fires blindly into open space.
function bestSafety(balls: Ball[]): Scored | null {
  const cue = balls.find((b) => b.isCue && !b.sunk);
  if (!cue) return null;
  const targets = balls.filter((b) => !b.isCue && !b.sunk);
  if (!targets.length) return null;
  let best: Scored | null = null;
  let bestScore = -Infinity;
  for (const t of targets) {
    const dx = t.x - cue.x;
    const dy = t.y - cue.y;
    const d = Math.hypot(dx, dy) || 1;
    const dirX = dx / d;
    const dirY = dy / d;
    if (!predictHit(cue.x, cue.y, dirX, dirY, balls)) continue; // must actually reach a ball
    for (const pw of [0.3, 0.42, 0.55]) {
      const sim = simulateShot(balls, dirX, dirY, pw);
      let score = 0;
      if (sim.scratched) score -= 1000; // never die, even on a safety
      score += sim.pottedNonCue * 20; // a safe ball that happens to drop is a bonus
      score += bestAlign(sim.balls) * 6; // leave a makeable next shot
      score -= pw; // softest pace that works
      if (score > bestScore) {
        bestScore = score;
        best = {
          dirX,
          dirY,
          power: pw,
          target: t,
          pocket: nearestPocketTo(t.x, t.y),
          straightness: 0,
          viable: sim.pottedNonCue > 0,
          reason: "",
          _scratch: sim.scratched,
          _pots: sim.pottedNonCue,
          _ro: 0,
        };
      }
    }
  }
  return best;
}

// planShot picks the AI's next shot. Pass `rng` (e.g. Math.random) to make it CREATIVE:
// instead of always the single top-scored line, it picks at random among all the shots
// that are within a small margin of the best AND are safe pots - so it varies its path
// game to game without ever giving up safety or a real pot. Omit `rng` for deterministic
// play (used by the tests).
export function planShot(balls: Ball[], rng?: () => number): ShotPlan | null {
  const cue = balls.find((b) => b.isCue && !b.sunk);
  if (!cue) return null;
  const targets = balls.filter((b) => !b.isCue && !b.sunk);
  if (!targets.length) return null;

  // Only simulate the most promising pots (straightest first) to stay responsive.
  const rootCands = viableShots(balls)
    .sort((a, b) => b.align - a.align || a.dist - b.dist)
    .slice(0, 6);

  // Score every (shot, power) pair, keeping them all so we can pick among the near-best.
  const scored: (Scored & { score: number })[] = [];
  for (const c of rootCands) {
    const base = powerFor(c.dist, c.align);
    const powers = Array.from(new Set([base, Math.min(1, base + 0.13), Math.min(1, base + 0.28)]));
    for (const pw of powers) {
      const sim = simulateShot(balls, c.dirX, c.dirY, pw);
      let score = 0;
      let roPotted = 0;
      if (sim.scratched) score -= 1000; // rule 1: never die
      score += sim.pottedNonCue * 20; // pot balls now
      if (sim.pottedNonCue > 0 && !sim.scratched) {
        // rule 2: reward the line that runs the most balls in the fewest turns.
        const ro = projectRunOut(sim.balls, 6);
        roPotted = ro.potted;
        score += ro.potted * 8;
        if (ro.scratched) score -= 12; // a run-out that ends in a scratch is a worse line
      }
      // Defensive leave: never park the cue right at a pocket mouth (risky next shot, and
      // a hedge against any timestep drift under heavy lag).
      const scue = sim.balls.find((b) => b.isCue);
      if (scue && !scue.sunk) {
        let dmin = Infinity;
        for (const p of POCKETS) dmin = Math.min(dmin, Math.hypot(scue.x - p.x, scue.y - p.y));
        if (dmin < POCKET_R * 3) score -= (POCKET_R * 3 - dmin) * 0.3;
      }
      score += c.align * 3; // makeability of this shot
      score -= pw * 1.5; // controlled power - do not overhit
      scored.push({ dirX: c.dirX, dirY: c.dirY, power: pw, target: c.target, pocket: c.pocket, straightness: c.align, viable: true, reason: "", _scratch: sim.scratched, _pots: sim.pottedNonCue, _ro: roPotted, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);

  let best: (Scored & { score?: number }) | null = scored[0] ?? null;
  // Creativity: among safe pots within a margin of the best, choose one at random.
  if (rng && best && best._pots > 0 && !best._scratch) {
    const bs = best.score ?? -Infinity;
    const MARGIN = 6;
    const pool = scored.filter((s) => s._pots > 0 && !s._scratch && s.score >= bs - MARGIN);
    if (pool.length > 1) best = pool[Math.floor(rng() * pool.length)];
  }

  // If the best pot scratches or nothing pots cleanly, take the safest developing shot.
  if (!best || best._scratch || best._pots === 0) {
    const safe = bestSafety(balls);
    if (safe && (!best || best._scratch || (best._pots === 0 && !safe._scratch))) best = safe;
  }

  if (best) {
    // Build the human-readable reason from the chosen shot's own numbers.
    const pct = Math.round(best.straightness * 100);
    const pace = best.power < 0.55 ? "soft pace to hold position" : best.power > 0.82 ? "firm to carry the distance" : "controlled pace";
    if (best.viable) {
      best.reason = `Makeable pot (${pct}% straight)`;
      if (best._ro > 0) best.reason += `, sets up a ${best._ro + 1}-ball run`;
      best.reason += `; ${pace}`;
    } else {
      best.reason = "No clean pot - safe roll to leave a shot and avoid a scratch";
    }
    const { _scratch, _pots, _ro, score, ...plan } = best;
    void _scratch;
    void _pots;
    void _ro;
    void score;
    return plan;
  }

  // Last resort (no reachable ball found by any route): gentle roll at the nearest ball.
  let near = targets[0];
  let nd = Infinity;
  for (const t of targets) {
    const d = Math.hypot(t.x - cue.x, t.y - cue.y);
    if (d < nd) {
      nd = d;
      near = t;
    }
  }
  const dx = near.x - cue.x;
  const dy = near.y - cue.y;
  const dd = Math.hypot(dx, dy) || 1;
  return { dirX: dx / dd, dirY: dy / dd, power: 0.5, target: near, pocket: nearestPocketTo(near.x, near.y), straightness: 0, viable: false, reason: "Last resort - gentle contact to break the cluster" };
}
