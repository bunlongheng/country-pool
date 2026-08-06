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
  planShot,
  simulateShot,
  predictHit,
  rack,
  respotCue,
  setBallSize,
  shoot,
  stepWorld,
  POCKETS,
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

test("no ball is ever shoved over the frame - full-rack breaks stay on the felt", () => {
  // Collisions near a corner (where cushion bounces are skipped) used to push a ball
  // clean past the rail onto the wooden frame. Break a full rack from many angles and
  // assert every live ball stays inside the play surface on every frame.
  const dt = 1 / 60;
  for (let a = 0; a < 24; a++) {
    const balls = rack(Array.from({ length: 15 }, (_, i) => i));
    const c = balls.find((b) => b.isCue)!;
    const ang = (a / 24) * Math.PI * 2;
    shoot(c, Math.cos(ang) + 1e-3, Math.sin(ang) + 1e-3, 1);
    for (let i = 0; i < 60 * 15 && !allStopped(balls); i++) {
      stepWorld(balls, dt);
      for (const b of balls) {
        if (b.sunk) continue;
        assert.ok(b.x >= 0 && b.x <= TABLE.w, `ball ${b.id} over frame in x: ${b.x.toFixed(2)}`);
        assert.ok(b.y >= 0 && b.y <= TABLE.h, `ball ${b.id} over frame in y: ${b.y.toFixed(2)}`);
      }
    }
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

test("planShot lines up a dead-straight pot and, when fired, actually sinks the ball", () => {
  // Cue at left-middle, one object ball directly between it and the top-left corner
  // pocket (all three collinear) => a straight-in shot the AI must pick.
  const cueBall = cue({ id: 0, x: 40, y: 25 });
  const target = cue({ id: 1, ci: 5, isCue: false, x: 20, y: 12.5 });
  const balls = [cueBall, target];
  const plan = planShot(balls);
  assert.ok(plan, "should find a shot");
  assert.equal(plan!.target.id, 1);
  assert.ok(plan!.viable, "a clear straight line is a viable pot");
  assert.ok(plan!.straightness > 0.95, `near dead-straight, got ${plan!.straightness}`);
  assert.ok(plan!.reason.length > 0, "every plan carries a human-readable reason");
  // Fire the plan and simulate: the target should drop into the corner.
  shoot(cueBall, plan!.dirX, plan!.dirY, plan!.power);
  let sunk = false;
  for (let i = 0; i < 60 * 10 && !sunk; i++) {
    if (stepWorld(balls, 1 / 60).pocketed.includes(1)) sunk = true;
  }
  assert.ok(sunk, "the AI's straight shot should pot the target");
});

test("planShot returns null when only the cue ball is left", () => {
  assert.equal(planShot([cue({ id: 0 })]), null);
});

test("simulateShot flags a scratch when the cue is driven into a pocket", () => {
  const cueBall = cue({ id: 0, x: TABLE.w * 0.5, y: 50 });
  const res = simulateShot([cueBall], -cueBall.x, -cueBall.y, 1); // straight into top-left corner
  assert.equal(res.scratched, true);
  assert.equal(res.pottedNonCue, 0);
});

test("planShot never picks a shot that scratches on a full rack (rule: no die)", () => {
  const balls = rack(Array.from({ length: 15 }, (_, i) => i));
  const plan = planShot(balls);
  assert.ok(plan, "should always have a shot on a full rack");
  const res = simulateShot(balls, plan!.dirX, plan!.dirY, plan!.power);
  assert.equal(res.scratched, false, "the AI must not choose a scratching shot");
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

test("respotCue always returns the pocketed cue to the table, clear of every other ball", () => {
  const cueBall = cue({ id: 0, x: TABLE.w * 0.5, y: 50, sunk: true });
  // Crowd the head spot so the direct placement is blocked and the search ring must run.
  const blockers: Ball[] = [];
  for (let k = 0; k < 6; k++) {
    blockers.push(
      cue({
        id: k + 1,
        ci: k,
        isCue: false,
        x: TABLE.w * 0.25 + (k % 3) * BALL_R,
        y: TABLE.h / 2 + Math.floor(k / 3) * BALL_R,
      }),
    );
  }
  const balls = [cueBall, ...blockers];
  respotCue(balls);
  assert.equal(cueBall.sunk, false, "cue must no longer be sunk");
  assert.ok(
    cueBall.x >= 0 && cueBall.x <= TABLE.w && cueBall.y >= 0 && cueBall.y <= TABLE.h,
    `cue must land on the table, got (${cueBall.x.toFixed(1)}, ${cueBall.y.toFixed(1)})`,
  );
  for (const b of blockers) {
    assert.ok(
      Math.hypot(b.x - cueBall.x, b.y - cueBall.y) >= BALL_R * 2,
      `respotted cue must not overlap ball ${b.id}`,
    );
  }
});

test("a cue scratched into a pocket is always recoverable by respotCue (mobile catch-up scratch)", () => {
  // A big catch-up dt (phone backgrounds then resumes) can drive the cue from launch
  // into a pocket within a single step, so the UI never sees a 'moving' frame. Whatever
  // the trigger, the pocketed cue must come back onto the felt. See issue #1.
  const cueBall = cue({ id: 0, x: TABLE.w * 0.5, y: 50 });
  const other = cue({ id: 1, ci: 2, isCue: false, x: 30, y: 80 });
  const balls = [cueBall, other];
  shoot(cueBall, POCKETS[0].x - cueBall.x, POCKETS[0].y - cueBall.y, 1); // fire at the corner
  for (let i = 0; i < 1200 && !cueBall.sunk; i++) stepWorld(balls, 1 / 120);
  assert.equal(cueBall.sunk, true, "cue should have scratched into the corner pocket");
  respotCue(balls);
  assert.equal(cueBall.sunk, false, "respot must bring the scratched cue back into play");
  if (!other.sunk) {
    assert.ok(
      Math.hypot(other.x - cueBall.x, other.y - cueBall.y) >= BALL_R * 2,
      "respotted cue must not overlap the remaining ball",
    );
  }
});
