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
export const BALL_R = 2.55;
export const POCKET_R = 4.8;
// Cushion restitution (how bouncy the rails are) and rolling friction per second.
export const RAIL_BOUNCE = 0.86;
export const FRICTION = 1.9; // higher = balls stop sooner
export const STOP_EPS = 0.35; // below this speed a ball is parked
export const MAX_SHOT = 1300; // cap on launch speed (table units / s)

// The 6 pockets: 4 corners + 2 side pockets at the long-rail midpoints. The side
// pockets are recessed back INTO the rail (their centre sits past the cushion line) so
// a ball must be driven firmly and squarely to the rail to drop - a lazy straight roll
// stops at the jaws instead of being swallowed.
export const SIDE_RECESS = 2.2;
export const POCKETS: { x: number; y: number }[] = [
  { x: 0, y: 0 },
  { x: TABLE.w / 2, y: -SIDE_RECESS },
  { x: TABLE.w, y: 0 },
  { x: 0, y: TABLE.h },
  { x: TABLE.w / 2, y: TABLE.h + SIDE_RECESS },
  { x: TABLE.w, y: TABLE.h },
];

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

  // Safety net: a ball that slipped through a recessed side-pocket mouth without
  // dropping is bounced back onto the felt rather than lost off-table past the rail.
  for (const b of balls) {
    if (b.sunk) continue;
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
