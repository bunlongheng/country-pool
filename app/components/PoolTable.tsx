"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { COUNTRIES } from "../data/countries";
import { sound } from "@/lib/sound";
import {
  BALL_R,
  POCKETS,
  POCKET_R,
  TABLE,
  aimPath,
  allStopped,
  rack,
  shoot,
  stepWorld,
  type Ball,
} from "@/lib/pool";
import type { BallRender, BallSkin } from "./PoolBalls";
import SoundToggle from "./SoundToggle";

// The WebGL ball layer is client-only (no SSR) and mounts over the felt canvas.
const PoolBalls = dynamic(() => import("./PoolBalls"), { ssr: false });

const OBJECT_BALLS = 15;
const MAX_DRAG = 190; // px of pull for full power

type Transform = { ox: number; oy: number; scale: number };

function pickCountries(n: number): number[] {
  const pool = COUNTRIES.map((_, i) => i);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}

function buildRack(): { balls: Ball[]; skins: BallSkin[] } {
  const balls = rack(pickCountries(OBJECT_BALLS));
  const skins: BallSkin[] = balls.map((b) => ({
    code: b.isCue ? "" : COUNTRIES[b.ci].code,
    hue: b.isCue ? 0 : COUNTRIES[b.ci].hue,
    isCue: b.isCue,
  }));
  return { balls, skins };
}

export default function PoolTable() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const feltRef = useRef<HTMLCanvasElement>(null);
  const [dims, setDims] = useState({ w: 0, h: 0 });

  // A rack lives in state (lazy-initialised once); racking again is an event
  // handler that replaces it - no setState-in-effect anywhere. The balls array
  // is mutated in place by the physics loop and reset when the loop re-binds.
  const [game, setGame] = useState(() => buildRack());

  const ballsRef = useRef<Ball[]>(game.balls);
  const renderRef = useRef<BallRender[]>([]);
  const distRef = useRef<number[]>([]);
  const trRef = useRef<Transform>({ ox: 0, oy: 0, scale: 1 });

  const aimRef = useRef<{ active: boolean; dirX: number; dirY: number; power: number }>({
    active: false,
    dirX: 1,
    dirY: 0,
    power: 0,
  });
  const [power, setPower] = useState(0);
  const [aiming, setAiming] = useState(false);

  const [score, setScore] = useState(0);
  const [potted, setPotted] = useState(0);
  const [shots, setShots] = useState(0);
  const [won, setWon] = useState(false);
  const scoreRef = useRef(0);
  const pottedRef = useRef(0);
  const wonRef = useRef(false);
  const [portrait, setPortrait] = useState(false);

  const resetGame = useCallback(() => {
    sound.unlock();
    scoreRef.current = 0;
    pottedRef.current = 0;
    wonRef.current = false;
    setScore(0);
    setPotted(0);
    setShots(0);
    setWon(false);
    setGame(buildRack());
  }, []);

  // Track container size (drives the table transform) and orientation.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setDims({ w: Math.round(r.width), h: Math.round(r.height) });
    });
    ro.observe(el);
    const mq = window.matchMedia("(orientation: portrait)");
    const onOri = () => setPortrait(mq.matches);
    onOri();
    mq.addEventListener("change", onOri);
    return () => {
      ro.disconnect();
      mq.removeEventListener("change", onOri);
    };
  }, []);

  const transform = useMemo<Transform>(() => {
    const margin = Math.max(18, Math.min(dims.w, dims.h) * 0.06);
    const scale = Math.min((dims.w - margin * 2) / TABLE.w, (dims.h - margin * 2) / TABLE.h);
    const s = Math.max(0.001, scale);
    const ox = (dims.w - TABLE.w * s) / 2;
    const oy = (dims.h - TABLE.h * s) / 2;
    return { ox, oy, scale: s };
  }, [dims]);
  useEffect(() => {
    trRef.current = transform;
  }, [transform]);

  // ---- The one animation loop: physics + sound + felt draw + render feed ----
  useEffect(() => {
    const felt = feltRef.current;
    if (!felt) return;
    const ctx = felt.getContext("2d");
    if (!ctx) return;

    // (Re)bind to the current rack and reset the per-ball render buffers.
    const balls = game.balls;
    ballsRef.current = balls;
    renderRef.current = balls.map(() => ({ x: 0, y: 0, r: 1, dx: 1, dy: 0, dist: 0, sunk: false }));
    distRef.current = balls.map(() => 0);

    let raf = 0;
    let last = performance.now();
    let wasMoving = false;

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(0.033, (now - last) / 1000);
      last = now;
      const { ox, oy, scale } = trRef.current;

      const moving = !allStopped(balls);
      if (moving) {
        const ev = stepWorld(balls, dt);
        if (ev.rails > 0) sound.rail();
        for (const imp of ev.clicks) sound.click(imp / 120);
        for (const id of ev.pocketed) {
          const b = balls.find((x) => x.id === id);
          if (!b) continue;
          if (b.isCue) {
            sound.scratch();
          } else {
            sound.pocket();
            pottedRef.current += 1;
            scoreRef.current += 1;
          }
        }
      }
      // Transition moving -> stopped: settle the turn.
      if (wasMoving && !moving) {
        const cue = balls.find((b) => b.isCue);
        if (cue && cue.sunk) {
          cue.sunk = false; // respot the cue on the head spot (scratch)
          cue.x = TABLE.w * 0.25;
          cue.y = TABLE.h / 2;
          cue.vx = cue.vy = 0;
        }
        setScore(scoreRef.current);
        setPotted(pottedRef.current);
        if (pottedRef.current >= OBJECT_BALLS && !wonRef.current) {
          wonRef.current = true;
          setWon(true);
          sound.win();
        }
      }
      wasMoving = moving;

      const rpx = BALL_R * scale;
      for (let i = 0; i < balls.length; i++) {
        const b = balls[i];
        const sp = Math.hypot(b.vx, b.vy);
        distRef.current[i] += sp * scale * dt;
        const r = renderRef.current[i];
        r.x = ox + b.x * scale;
        r.y = oy + b.y * scale;
        r.r = rpx;
        r.dist = distRef.current[i];
        if (sp > 1e-4) {
          r.dx = b.vx / sp;
          r.dy = b.vy / sp;
        }
        r.sunk = b.sunk;
      }

      drawFelt(ctx, felt, trRef.current, balls, aimRef.current, moving);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [game]);

  // ---- Drag-to-aim (slingshot: pull back from the cue, release to fire) ----
  const pointer = useCallback((e: React.PointerEvent) => {
    const el = wrapRef.current;
    if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }, []);

  const cueScreen = useCallback(() => {
    const cue = ballsRef.current.find((b) => b.isCue);
    const { ox, oy, scale } = trRef.current;
    if (!cue) return { x: 0, y: 0 };
    return { x: ox + cue.x * scale, y: oy + cue.y * scale };
  }, []);

  const onDown = useCallback((e: React.PointerEvent) => {
    sound.unlock();
    if (wonRef.current || !allStopped(ballsRef.current)) return;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    aimRef.current.active = true;
    setAiming(true);
  }, []);

  const onMove = useCallback(
    (e: React.PointerEvent) => {
      if (!aimRef.current.active) return;
      const p = pointer(e);
      const c = cueScreen();
      const pullX = c.x - p.x;
      const pullY = c.y - p.y;
      const len = Math.hypot(pullX, pullY) || 1;
      aimRef.current.dirX = pullX / len;
      aimRef.current.dirY = pullY / len;
      const pw = Math.max(0, Math.min(1, len / MAX_DRAG));
      aimRef.current.power = pw;
      setPower(pw);
    },
    [pointer, cueScreen],
  );

  const onUp = useCallback(() => {
    const a = aimRef.current;
    if (!a.active) return;
    a.active = false;
    setAiming(false);
    if (a.power > 0.04) {
      const cue = ballsRef.current.find((b) => b.isCue);
      if (cue) {
        shoot(cue, a.dirX, a.dirY, a.power);
        sound.cue(a.power);
        setShots((s) => s + 1);
      }
    }
    a.power = 0;
    setPower(0);
  }, []);

  const dpr = typeof window !== "undefined" ? Math.min(2, window.devicePixelRatio || 1) : 1;

  return (
    <div className="relative h-full w-full overflow-hidden" style={{ background: "var(--room)" }}>
      {/* HUD */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between px-[7%] pt-[max(10px,env(safe-area-inset-top))]">
        <span className="mt-1 font-display text-2xl leading-none tracking-tight text-[var(--brass)] sm:text-3xl">
          Country&nbsp;Pool
        </span>
        <div className="flex items-center gap-2 sm:gap-3">
          <Stat label="Score" value={score} accent />
          <Stat label="Potted" value={`${potted}/${OBJECT_BALLS}`} />
          <Stat label="Shots" value={shots} />
        </div>
      </div>

      {/* Table stack. Pointer handlers live on the WRAPPER, not the felt canvas:
          the r3f WebGL layer sits on top, so real touches/clicks land on it first -
          putting the handlers here catches the bubbled event whichever layer is hit,
          and touch-action:none stops the browser stealing the drag as a scroll. */}
      <div
        ref={wrapRef}
        className="absolute inset-0 z-10 touch-none"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        <canvas
          ref={feltRef}
          width={Math.round(dims.w * dpr)}
          height={Math.round(dims.h * dpr)}
          style={{ width: dims.w, height: dims.h }}
          className="pointer-events-none absolute inset-0 touch-none"
        />
        {dims.w > 0 && <PoolBalls skins={game.skins} data={renderRef} />}
      </div>

      {/* Power meter while aiming */}
      {aiming && (
        <div className="pointer-events-none absolute bottom-[max(16px,env(safe-area-inset-bottom))] left-1/2 z-20 w-56 -translate-x-1/2">
          <div className="mb-1 text-center font-display text-sm tracking-widest text-white/80">
            {power < 0.34 ? "SOFT" : power < 0.7 ? "FIRM" : "POWER"}
          </div>
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-white/15 ring-1 ring-white/20">
            <div
              className="h-full rounded-full"
              style={{
                width: `${power * 100}%`,
                background:
                  power < 0.34
                    ? "#8fe388"
                    : power < 0.7
                      ? "#ffcc4d"
                      : "linear-gradient(90deg,#ffcc4d,#ff5c47)",
              }}
            />
          </div>
        </div>
      )}

      {/* Idle hint */}
      {!aiming && !won && (
        <div className="pointer-events-none absolute bottom-[max(14px,env(safe-area-inset-bottom))] left-1/2 z-20 -translate-x-1/2 rounded-full bg-black/35 px-4 py-1.5 text-center text-[13px] font-medium text-white/70 backdrop-blur-sm">
          Pull back from the cue ball, aim the line, release to break
        </div>
      )}

      {/* Rotate hint on portrait */}
      {portrait && (
        <div className="pointer-events-none absolute right-3 top-16 z-20 rounded-full bg-[var(--brass)]/90 px-3 py-1.5 text-xs font-semibold text-[#231a08] shadow-lg">
          Rotate for the full table
        </div>
      )}

      {/* Win overlay */}
      {won && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-5 bg-black/70 backdrop-blur-md">
          <div className="font-display text-5xl tracking-tight text-[var(--brass)] sm:text-7xl">
            Rack Cleared
          </div>
          <div className="flex gap-8 text-center text-white">
            <div>
              <div className="font-display text-4xl sm:text-5xl">{score}</div>
              <div className="text-xs uppercase tracking-widest text-white/60">Score</div>
            </div>
            <div>
              <div className="font-display text-4xl sm:text-5xl">{shots}</div>
              <div className="text-xs uppercase tracking-widest text-white/60">Shots</div>
            </div>
          </div>
          <button
            onClick={resetGame}
            className="mt-2 rounded-full bg-[var(--brass)] px-8 py-3 font-display text-xl tracking-wide text-[#231a08] shadow-xl transition active:scale-95"
          >
            Rack Again
          </button>
        </div>
      )}

      <SoundToggle />
      <button
        onClick={resetGame}
        className="absolute bottom-[max(10px,env(safe-area-inset-bottom))] left-3 z-20 rounded-full bg-white/10 px-4 py-2 text-sm font-semibold text-white/85 ring-1 ring-white/15 backdrop-blur-sm transition active:scale-95"
      >
        New Rack
      </button>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string | number; accent?: boolean }) {
  return (
    <div className="min-w-[58px] rounded-xl bg-black/30 px-3 py-1.5 text-center ring-1 ring-white/10 backdrop-blur-sm">
      <div
        className={`font-display text-xl leading-none sm:text-2xl ${accent ? "text-[var(--brass)]" : "text-white"}`}
      >
        {value}
      </div>
      <div className="mt-0.5 text-[10px] uppercase tracking-widest text-white/50">{label}</div>
    </div>
  );
}

// ---- Felt / rails / pockets / aim guide, drawn in device pixels ----
function drawFelt(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  tr: Transform,
  balls: Ball[],
  aim: { active: boolean; dirX: number; dirY: number; power: number },
  moving: boolean,
) {
  const dpr = canvas.width / (canvas.getBoundingClientRect().width || canvas.width);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = canvas.width / dpr;
  const H = canvas.height / dpr;
  ctx.clearRect(0, 0, W, H);
  const { ox, oy, scale } = tr;
  const px = (x: number) => ox + x * scale;
  const py = (y: number) => oy + y * scale;
  const rail = Math.max(12, 10 * scale);

  // Wooden frame.
  const frame = ctx.createLinearGradient(0, oy - rail, 0, oy + TABLE.h * scale + rail);
  frame.addColorStop(0, "#5a3a1c");
  frame.addColorStop(0.5, "#7a4f27");
  frame.addColorStop(1, "#3f280f");
  roundRect(ctx, ox - rail, oy - rail, TABLE.w * scale + rail * 2, TABLE.h * scale + rail * 2, rail * 0.7);
  ctx.fillStyle = frame;
  ctx.fill();

  // Felt bed with a soft centre glow + vignette.
  const felt = ctx.createRadialGradient(
    px(TABLE.w / 2),
    py(TABLE.h / 2),
    scale * 6,
    px(TABLE.w / 2),
    py(TABLE.h / 2),
    scale * TABLE.w * 0.62,
  );
  felt.addColorStop(0, "#1f7a4d");
  felt.addColorStop(0.7, "#155f3b");
  felt.addColorStop(1, "#0e4a2d");
  roundRect(ctx, px(0), py(0), TABLE.w * scale, TABLE.h * scale, scale * 2);
  ctx.fillStyle = felt;
  ctx.fill();
  ctx.save();
  ctx.clip();

  // Head string + spots (subtle).
  ctx.strokeStyle = "rgba(255,255,255,0.10)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(px(TABLE.w * 0.25), py(0));
  ctx.lineTo(px(TABLE.w * 0.25), py(TABLE.h));
  ctx.stroke();
  dot(ctx, px(TABLE.w * 0.25), py(TABLE.h / 2), 2, "rgba(255,255,255,0.18)");
  dot(ctx, px(TABLE.w * 0.7), py(TABLE.h / 2), 2, "rgba(255,255,255,0.18)");

  // Soft shadows under live balls (grounding for the 3D layer).
  for (const b of balls) {
    if (b.sunk) continue;
    const sx = px(b.x) + scale * 0.6;
    const sy = py(b.y) + scale * 0.9;
    const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, BALL_R * scale * 1.15);
    g.addColorStop(0, "rgba(0,0,0,0.38)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(sx, sy, BALL_R * scale * 1.1, BALL_R * scale * 0.8, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // Pockets: dark mouth + brass jaw.
  for (const p of POCKETS) {
    const cx = px(p.x);
    const cy = py(p.y);
    ctx.beginPath();
    ctx.arc(cx, cy, POCKET_R * scale * 0.95, 0, Math.PI * 2);
    ctx.fillStyle = "#0a0a0a";
    ctx.fill();
    ctx.lineWidth = Math.max(1.5, scale * 0.7);
    ctx.strokeStyle = "rgba(196,150,74,0.85)";
    ctx.stroke();
  }

  // Brass sight diamonds along the rails.
  for (let i = 1; i < 4; i++) {
    if (i !== 2) {
      diamond(ctx, px((TABLE.w / 4) * i), oy - rail * 0.5, rail * 0.16);
      diamond(ctx, px((TABLE.w / 4) * i), oy + TABLE.h * scale + rail * 0.5, rail * 0.16);
    }
  }
  for (let i = 1; i < 4; i++) {
    diamond(ctx, ox - rail * 0.5, py((TABLE.h / 4) * i), rail * 0.16);
    diamond(ctx, ox + TABLE.w * scale + rail * 0.5, py((TABLE.h / 4) * i), rail * 0.16);
  }

  // Aim guide.
  const cue = balls.find((b) => b.isCue);
  if (cue && !cue.sunk && aim.active && !moving) {
    const pts = aimPath(cue.x, cue.y, aim.dirX, aim.dirY, TABLE.w * (0.4 + aim.power * 0.9), 1);
    const color =
      aim.power < 0.34 ? "rgba(143,227,136,0.95)" : aim.power < 0.7 ? "rgba(255,204,77,0.95)" : "rgba(255,92,71,0.97)";
    ctx.save();
    ctx.setLineDash([scale * 1.6, scale * 1.4]);
    ctx.lineWidth = Math.max(1.5, scale * 0.55);
    ctx.strokeStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.moveTo(px(pts[0].x), py(pts[0].y));
    for (let i = 1; i < pts.length; i++) ctx.lineTo(px(pts[i].x), py(pts[i].y));
    ctx.stroke();
    const end = pts[pts.length - 1];
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(px(end.x), py(end.y), BALL_R * scale, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    ctx.beginPath();
    ctx.arc(px(cue.x), py(cue.y), BALL_R * scale * 1.35, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function dot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
}
function diamond(ctx: CanvasRenderingContext2D, x: number, y: number, s: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(Math.PI / 4);
  ctx.fillStyle = "rgba(211,171,97,0.9)";
  ctx.fillRect(-s, -s, s * 2, s * 2);
  ctx.restore();
}
