import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BALL_R,
  POCKET_R,
  SIDE_RECESS,
  BASE_BALL_R,
  BASE_POCKET_R,
  BASE_SIDE_RECESS,
  TABLE,
  MAX_SHOT,
  allStopped,
  aimPath,
  predictHit,
  rack,
  setBallSize,
  shoot,
  stepWorld,
  type Ball,
} from "../lib/pool.ts";

function cue(over: Partial<Ball> = {}): Ball {
  return { id: 0, ci: -1, x: 50, y: 50, vx: 0, vy: 0, sunk: false, isCue: true, ...over };
}

test("shoot sets a launch velocity capped at MAX_SHOT and aimed along the direction", () => {
  const b = cue();
  shoot(b, 1, 0, 1);
  assert.equal(Math.round(Math.hypot(b.vx, b.vy)), MAX_SHOT);
  assert.ok(b.vx > 0 && Math.abs(b.vy) < 1e-9, "should travel +x");
  const half = cue();
  shoot(half, 0, 1, 0.5);
  assert.ok(Math.abs(Math.hypot(half.vx, half.vy) - MAX_SHOT * 0.5) < 1e-6);
});

test("friction brings a rolling ball to a full stop in a sane time", () => {
  const b = cue({ x: 20, y: 50 });
  shoot(b, 1, 0, 0.5);
  let t = 0;
  const dt = 1 / 60;
  while (!allStopped([b]) && t < 30) {
    stepWorld([b], dt);
    t += dt;
  }
  assert.ok(allStopped([b]), "ball must stop");
  assert.ok(t < 20, `stopped too slowly: ${t.toFixed(1)}s`);
  assert.equal(b.vx, 0);
});

test("a ball never leaves the table - cushions keep it in bounds", () => {
  const b = cue({ x: 30, y: 30 });
  shoot(b, 1, 0.6, 1);
  const dt = 1 / 60;
  for (let i = 0; i < 60 * 12; i++) {
    stepWorld([b], dt);
    assert.ok(b.x >= BALL_R - 0.5 && b.x <= TABLE.w - BALL_R + 0.5, `x out of bounds: ${b.x}`);
    assert.ok(b.y >= BALL_R - 0.5 && b.y <= TABLE.h - BALL_R + 0.5, `y out of bounds: ${b.y}`);
  }
});

test("a ball rolled into a corner pocket is sunk", () => {
  const b = cue({ x: TABLE.w * 0.5, y: 50 });
  // Aim straight at the top-left corner pocket (0,0).
  shoot(b, -b.x, -(b.y - 0), 1);
  let sunk = false;
  const dt = 1 / 60;
  for (let i = 0; i < 60 * 10 && !sunk; i++) {
    const ev = stepWorld([b], dt);
    if (ev.pocketed.includes(0)) sunk = true;
  }
  assert.ok(sunk, "ball aimed at the corner should drop");
  assert.ok(b.sunk);
});

test("a ball skimming parallel to the rail rolls PAST the side pocket (not sunk)", () => {
  // Rolling straight along the top rail toward the far end, level with the side pocket.
  const b = cue({ x: TABLE.w * 0.2, y: BALL_R, vx: 140, vy: 0 });
  const dt = 1 / 240;
  let sunk = false;
  for (let i = 0; i < 240 * 4 && !sunk; i++) {
    if (stepWorld([b], dt).pocketed.includes(0)) sunk = true;
  }
  assert.ok(!sunk, "a rail-parallel skim must not drop into the side pocket");
});

test("a ball aimed into the side pocket drops", () => {
  // Sitting just inside the mouth of the top side pocket, driven straight at it.
  const b = cue({ x: TABLE.w / 2, y: 14, vx: 0, vy: -120 });
  const dt = 1 / 240;
  let sunk = false;
  for (let i = 0; i < 240 * 2 && !sunk; i++) {
    if (stepWorld([b], dt).pocketed.includes(0)) sunk = true;
  }
  assert.ok(sunk, "a ball driven into the side pocket should drop");
});

test("head-on elastic collision transfers momentum (cue stops, target moves)", () => {
  const a = cue({ x: 40, y: 50, vx: 60, vy: 0 });
  const target = cue({ id: 1, ci: 3, isCue: false, x: 40 + BALL_R * 2 + 0.05, y: 50 });
  // A few small steps to resolve the contact.
  for (let i = 0; i < 5; i++) stepWorld([a, target], 1 / 240);
  assert.ok(target.vx > 30, `target should take most of the speed, got ${target.vx.toFixed(1)}`);
  assert.ok(a.vx < 20, `cue should shed most of its speed, got ${a.vx.toFixed(1)}`);
});

test("two overlapping balls are pushed apart", () => {
  const a = cue({ x: 50, y: 50 });
  const b = cue({ id: 1, ci: 2, isCue: false, x: 51, y: 50 });
  stepWorld([a, b], 1 / 60);
  assert.ok(Math.hypot(b.x - a.x, b.y - a.y) >= BALL_R * 2 - 0.6, "should de-overlap toward 2R");
});

test("aimPath starts at the cue and reflects off a cushion", () => {
  const pts = aimPath(TABLE.w - 20, 50, 1, 0, 200, 1);
  assert.ok(pts.length >= 3, "should hit a wall and turn");
  assert.ok(Math.abs(pts[0].x - (TABLE.w - 20)) < 1e-9 && Math.abs(pts[0].y - 50) < 1e-9);
  const maxX = Math.max(...pts.map((p) => p.x));
  assert.ok(maxX <= TABLE.w - BALL_R + 1e-6, "never crosses the rail");
});

test("predictHit finds the ball dead ahead and points it straight on", () => {
  const target = cue({ id: 1, ci: 2, isCue: false, x: 80, y: 50 });
  const other = cue({ id: 2, ci: 3, isCue: false, x: 80, y: 20 });
  const hit = predictHit(20, 50, 1, 0, [target, other]);
  assert.ok(hit, "should find a hit");
  assert.equal(hit!.target.id, 1); // the one in the aim line
  assert.ok(hit!.contactX < target.x, "contact is before the ball centre");
  assert.ok(hit!.dirX > 0.99, "a centre-ball hit pushes it straight ahead");
});

test("predictHit returns null when the aim line misses every ball", () => {
  const target = cue({ id: 1, ci: 2, isCue: false, x: 80, y: 90 });
  assert.equal(predictHit(20, 10, 1, 0, [target]), null);
});

test("rack lays out 1 cue + 15 object balls, all on the table", () => {
  const balls = rack(Array.from({ length: 15 }, (_, i) => i));
  assert.equal(balls.length, 16);
  assert.equal(balls.filter((b) => b.isCue).length, 1);
  assert.equal(balls.filter((b) => !b.isCue).length, 15);
  for (const b of balls) {
    assert.ok(b.x > 0 && b.x < TABLE.w && b.y > 0 && b.y < TABLE.h, `ball ${b.id} off table`);
  }
});

test("setBallSize scales ball fully, pocket at 0.7x, clamps, and keeps pockets > balls", () => {
  try {
    setBallSize(2);
    assert.ok(Math.abs(BALL_R - BASE_BALL_R * 2) < 1e-9, `BALL_R=${BALL_R}`);
    assert.ok(Math.abs(POCKET_R - BASE_POCKET_R * (1 + (2 - 1) * 0.7)) < 1e-9, `POCKET_R=${POCKET_R}`);
    assert.ok(Math.abs(SIDE_RECESS - BASE_SIDE_RECESS * (1 + (2 - 1) * 0.7)) < 1e-9, `SIDE_RECESS=${SIDE_RECESS}`);
    assert.ok(POCKET_R > BALL_R, "pocket must stay larger than the ball so it can drop");
    setBallSize(99); // clamps to 3
    assert.ok(Math.abs(BALL_R - BASE_BALL_R * 3) < 1e-9, `clamped BALL_R=${BALL_R}`);
  } finally {
    setBallSize(1); // reset the shared global for other tests
  }
});

test("resizable balls still pot: cue driven into the top-left corner drops at every size", () => {
  for (const f of [1.5, 2, 2.5]) {
    try {
      setBallSize(f);
      const b = cue({ x: TABLE.w * 0.5, y: 50 });
      shoot(b, -b.x, -b.y, 1);
      let sunk = false;
      for (let i = 0; i < 60 * 10 && !sunk; i++) {
        if (stepWorld([b], 1 / 60).pocketed.includes(0)) sunk = true;
      }
      assert.ok(sunk, `corner pot should drop at size ${f}`);
    } finally {
      setBallSize(1);
    }
  }
});
