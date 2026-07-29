"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
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

const readBest = () =>
  typeof window !== "undefined" ? Number(window.localStorage?.getItem("cp-best") || 0) : 0;

export default function PoolTable() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const feltRef = useRef<HTMLCanvasElement>(null);
  const [dims, setDims] = useState({ w: 0, h: 0 });

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
  const [pottedCodes, setPottedCodes] = useState<string[]>([]);
  const [shots, setShots] = useState(0);
  const [run, setRun] = useState(0); // current break (consecutive pots)
  const [best, setBest] = useState(readBest);
  const [won, setWon] = useState(false);
  const scoreRef = useRef(0);
  const pottedRef = useRef(0);
  const runRef = useRef(0);
  const bestRef = useRef(readBest());
  const potsShotRef = useRef(0);
  const wonRef = useRef(false);
  const [portrait, setPortrait] = useState(false);

  const muted = useSyncExternalStore(
    (cb) => sound.subscribe(cb),
    () => sound.isMuted(),
    () => false,
  );

  const resetGame = useCallback(() => {
    sound.unlock();
    scoreRef.current = 0;
    pottedRef.current = 0;
    runRef.current = 0;
    potsShotRef.current = 0;
    wonRef.current = false;
    setScore(0);
    setPotted(0);
    setPottedCodes([]);
    setShots(0);
    setRun(0);
    setWon(false);
    setGame(buildRack());
  }, []);

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
    const margin = Math.max(20, Math.min(dims.w, dims.h) * 0.07);
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
            potsShotRef.current += 1;
          }
        }
      }
      // Transition moving -> stopped: settle the turn + score the break.
      if (wasMoving && !moving) {
        const cue = balls.find((b) => b.isCue);
        const scratched = !!(cue && cue.sunk);
        if (scratched) {
          cue!.sunk = false; // respot the cue on the head spot
          cue!.x = TABLE.w * 0.25;
          cue!.y = TABLE.h / 2;
          cue!.vx = cue!.vy = 0;
          runRef.current = 0; // a scratch ends the break
        } else if (potsShotRef.current > 0) {
          runRef.current += potsShotRef.current; // continue the break
        } else {
          runRef.current = 0; // a miss ends the break
        }
        if (runRef.current > bestRef.current) {
          bestRef.current = runRef.current;
          try {
            window.localStorage?.setItem("cp-best", String(bestRef.current));
          } catch {}
        }
        setScore(scoreRef.current);
        setPotted(pottedRef.current);
        setPottedCodes(balls.filter((b) => b.sunk && !b.isCue).map((b) => COUNTRIES[b.ci].code));
        setRun(runRef.current);
        setBest(bestRef.current);
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
        potsShotRef.current = 0;
        shoot(cue, a.dirX, a.dirY, a.power);
        sound.cue(a.power);
        setShots((s) => s + 1);
      }
    }
    a.power = 0;
    setPower(0);
  }, []);

  const dpr = typeof window !== "undefined" ? Math.min(2, window.devicePixelRatio || 1) : 1;
  const pct = Math.round(power * 100);

  return (
    <div className="relative h-full w-full overflow-hidden" style={{ background: "var(--room)" }}>
      {/* Ornate gold title */}
      <div className="pointer-events-none absolute inset-x-0 top-[max(6px,env(safe-area-inset-top))] z-20 flex flex-col items-center">
        <h1 className="title-gold font-display text-3xl font-bold leading-none tracking-tight sm:text-4xl">
          Country Pool
        </h1>
        <div className="mt-0.5 text-[10px] tracking-[0.4em] text-[#d9b25a]/80">★ ★ ★</div>
      </div>

      {/* Player card (top-left) */}
      <div className="absolute left-2 top-[max(8px,env(safe-area-inset-top))] z-20 flex items-center gap-2 rounded-full bg-black/45 py-1 pl-1 pr-3 ring-1 ring-[#d9b25a]/30 backdrop-blur">
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-b from-[#2b8a76] to-[#0e4a42] text-base ring-1 ring-[#d9b25a]/50">
          🌍
        </div>
        <div className="leading-tight">
          <div className="text-[12px] font-semibold text-white">Player</div>
          <div className="text-[11px] font-bold text-[#e8c266]">🏆 {best}</div>
        </div>
      </div>

      {/* Rack progress (top-right) */}
      <div className="absolute right-2 top-[max(8px,env(safe-area-inset-top))] z-20 flex items-center gap-2 rounded-full bg-black/45 py-1 pl-3 pr-1 ring-1 ring-[#d9b25a]/30 backdrop-blur">
        <div className="leading-tight text-right">
          <div className="text-[10px] uppercase tracking-widest text-white/55">Rack</div>
          <div className="text-[12px] font-bold text-white">{potted}/{OBJECT_BALLS}</div>
        </div>
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-b from-[#3a2a14] to-black text-base ring-1 ring-[#d9b25a]/50">
          🎱
        </div>
      </div>

      {/* Table stack. Handlers on the wrapper so the drag works over the WebGL layer. */}
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

      {/* Vertical power meter (left) */}
      <div className="pointer-events-none absolute left-2 top-1/2 z-20 flex -translate-y-1/2 flex-col items-center gap-1 sm:left-3">
        <div className="font-display text-sm font-bold text-white">{pct}%</div>
        <div
          className="relative h-36 w-3.5 overflow-hidden rounded-full ring-1 ring-black/50 sm:h-44"
          style={{
            background: "linear-gradient(180deg,#5be36a 0%,#e8d24d 45%,#ff8a3c 72%,#ff4a44 100%)",
            opacity: aiming ? 1 : 0.5,
          }}
        >
          {/* dim mask above the current power level */}
          <div
            className="absolute inset-x-0 top-0 bg-black/60 transition-[height] duration-75"
            style={{ height: `${100 - pct}%` }}
          />
          {/* marker */}
          <div
            className="absolute -left-1 -right-1 h-0.5 bg-white shadow transition-[bottom] duration-75"
            style={{ bottom: `calc(${pct}% - 1px)` }}
          />
        </div>
      </div>

      {/* Right control rail (real controls only) */}
      <div className="absolute right-2 top-1/2 z-20 flex -translate-y-1/2 flex-col items-center gap-3 sm:right-3">
        <RailButton label="Sound" onClick={() => { sound.unlock(); sound.toggle(); }}>
          {muted ? (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5 6 9H2v6h4l5 4z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>
          )}
        </RailButton>
        <RailButton label="Rack" onClick={resetGame}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>
        </RailButton>
      </div>

      {/* Bottom stats bar */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center pb-[max(6px,env(safe-area-inset-bottom))]">
        <div className="flex items-center gap-3 rounded-t-2xl border-x border-t border-[#d9b25a]/25 bg-black/55 px-4 py-1.5 backdrop-blur sm:gap-5 sm:px-6">
          <div className="text-center">
            <div className="text-[9px] uppercase tracking-widest text-white/45">Break</div>
            <div className="font-display text-lg font-bold leading-none text-[#e8c266]">{run}</div>
          </div>
          <div className="flex max-w-[34vw] items-center gap-1 overflow-hidden">
            {pottedCodes.slice(-6).map((code, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={code + i}
                src={`/flags/${code}.png`}
                alt=""
                className="h-6 w-6 shrink-0 rounded-full object-cover ring-1 ring-white/40"
              />
            ))}
            {pottedCodes.length > 6 && (
              <span className="text-[11px] font-semibold text-white/60">+{pottedCodes.length - 6}</span>
            )}
          </div>
          <div className="text-center">
            <div className="text-[9px] uppercase tracking-widest text-white/45">Score</div>
            <div className="title-gold font-display text-2xl font-bold leading-none">{score}</div>
          </div>
          <div className="text-center">
            <div className="text-[9px] uppercase tracking-widest text-white/45">Best</div>
            <div className="font-display text-lg font-bold leading-none text-white">{best}</div>
          </div>
        </div>
      </div>

      {/* Idle hint */}
      {!aiming && !won && shots === 0 && (
        <div className="pointer-events-none absolute bottom-16 left-1/2 z-20 -translate-x-1/2 rounded-full bg-black/40 px-4 py-1.5 text-center text-[13px] font-medium text-white/75 backdrop-blur-sm">
          Pull back from the cue ball, aim, release to break
        </div>
      )}

      {/* Rotate hint on portrait */}
      {portrait && (
        <div className="pointer-events-none absolute left-1/2 top-14 z-20 -translate-x-1/2 rounded-full bg-[#d9b25a]/90 px-3 py-1.5 text-xs font-semibold text-[#231a08] shadow-lg">
          Rotate for the full table
        </div>
      )}

      {/* Win overlay */}
      {won && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-5 bg-black/70 backdrop-blur-md">
          <div className="title-gold font-display text-5xl font-bold tracking-tight sm:text-7xl">
            Rack Cleared
          </div>
          <div className="flex gap-8 text-center text-white">
            <Big label="Score" value={score} />
            <Big label="Best Break" value={best} />
            <Big label="Shots" value={shots} />
          </div>
          <button
            onClick={resetGame}
            className="mt-2 rounded-full bg-gradient-to-b from-[#f3d888] to-[#c99b3c] px-8 py-3 font-display text-xl font-bold tracking-wide text-[#231a08] shadow-xl ring-1 ring-[#f3d888] transition active:scale-95"
          >
            Rack Again
          </button>
        </div>
      )}
    </div>
  );
}

function RailButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button onClick={onClick} className="flex flex-col items-center gap-1 active:scale-95">
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-gradient-to-b from-[#26201a] to-black text-white/85 ring-1 ring-[#d9b25a]/40 shadow-lg">
        {children}
      </span>
      <span className="text-[9px] uppercase tracking-widest text-white/55">{label}</span>
    </button>
  );
}

function Big({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <div className="font-display text-4xl font-bold sm:text-5xl">{value}</div>
      <div className="text-xs uppercase tracking-widest text-white/60">{label}</div>
    </div>
  );
}

// ---- Felt / rails / pockets / aim guide / cue, drawn in device pixels ----
function drawFelt(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  tr: Transform,
  balls: Ball[],
  aim: { active: boolean; dirX: number; dirY: number; power: number },
  moving: boolean,
) {
  if (!canvas.width || !canvas.height) return; // not sized yet (avoids non-finite gradients)
  const rectW = canvas.getBoundingClientRect().width;
  const dpr = rectW ? canvas.width / rectW : 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = canvas.width / dpr;
  const H = canvas.height / dpr;
  ctx.clearRect(0, 0, W, H);
  const { ox, oy, scale } = tr;
  const px = (x: number) => ox + x * scale;
  const py = (y: number) => oy + y * scale;
  const rail = Math.max(16, 13 * scale);
  const gold = "#d9b25a";

  // Warm room glow behind the table.
  const glow = ctx.createRadialGradient(W / 2, H * 0.42, scale * 10, W / 2, H * 0.42, Math.max(W, H) * 0.7);
  glow.addColorStop(0, "rgba(120,80,30,0.20)");
  glow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // Wooden frame with a gold outer edge.
  roundRect(ctx, ox - rail, oy - rail, TABLE.w * scale + rail * 2, TABLE.h * scale + rail * 2, rail * 0.8);
  ctx.fillStyle = gold;
  ctx.fill();
  const wood = ctx.createLinearGradient(0, oy - rail, 0, oy + TABLE.h * scale + rail);
  wood.addColorStop(0, "#6b4525");
  wood.addColorStop(0.5, "#5a3a1f");
  wood.addColorStop(1, "#3a2412");
  roundRect(ctx, ox - rail * 0.82, oy - rail * 0.82, TABLE.w * scale + rail * 1.64, TABLE.h * scale + rail * 1.64, rail * 0.6);
  ctx.fillStyle = wood;
  ctx.fill();

  // Gold rail bolts.
  ctx.fillStyle = gold;
  const boltR = Math.max(1.5, scale * 0.5);
  for (let i = 1; i < 4; i++) {
    if (i !== 2) {
      bolt(ctx, px((TABLE.w / 4) * i), oy - rail * 0.5, boltR);
      bolt(ctx, px((TABLE.w / 4) * i), oy + TABLE.h * scale + rail * 0.5, boltR);
    }
  }
  for (let i = 1; i < 4; i++) {
    bolt(ctx, ox - rail * 0.5, py((TABLE.h / 4) * i), boltR);
    bolt(ctx, ox + TABLE.w * scale + rail * 0.5, py((TABLE.h / 4) * i), boltR);
  }

  // Gold inner trim + teal felt bed.
  roundRect(ctx, px(0) - scale * 1.4, py(0) - scale * 1.4, TABLE.w * scale + scale * 2.8, TABLE.h * scale + scale * 2.8, scale * 2.6);
  ctx.fillStyle = gold;
  ctx.fill();

  const felt = ctx.createRadialGradient(
    px(TABLE.w / 2),
    py(TABLE.h / 2),
    scale * 6,
    px(TABLE.w / 2),
    py(TABLE.h / 2),
    scale * TABLE.w * 0.62,
  );
  felt.addColorStop(0, "#2b8a76");
  felt.addColorStop(0.68, "#17685c");
  felt.addColorStop(1, "#0d443d");
  roundRect(ctx, px(0), py(0), TABLE.w * scale, TABLE.h * scale, scale * 2);
  ctx.fillStyle = felt;
  ctx.fill();
  ctx.save();
  ctx.clip();

  // Head string + spots.
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(px(TABLE.w * 0.25), py(0));
  ctx.lineTo(px(TABLE.w * 0.25), py(TABLE.h));
  ctx.stroke();
  dot(ctx, px(TABLE.w * 0.25), py(TABLE.h / 2), 2, "rgba(255,255,255,0.16)");
  dot(ctx, px(TABLE.w * 0.7), py(TABLE.h / 2), 2, "rgba(255,255,255,0.16)");

  // Ball shadows (grounding for the 3D layer).
  for (const b of balls) {
    if (b.sunk) continue;
    const sx = px(b.x) + scale * 0.7;
    const sy = py(b.y) + scale * 1.0;
    const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, BALL_R * scale * 1.2);
    g.addColorStop(0, "rgba(0,0,0,0.42)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(sx, sy, BALL_R * scale * 1.15, BALL_R * scale * 0.82, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // Pockets: dark mouth + polished gold jaw.
  for (const p of POCKETS) {
    const cx = px(p.x);
    const cy = py(p.y);
    const jaw = ctx.createRadialGradient(cx, cy, POCKET_R * scale * 0.5, cx, cy, POCKET_R * scale * 1.15);
    jaw.addColorStop(0, "#f0d896");
    jaw.addColorStop(0.6, "#c9992f");
    jaw.addColorStop(1, "#7a5a1e");
    ctx.beginPath();
    ctx.arc(cx, cy, POCKET_R * scale * 1.05, 0, Math.PI * 2);
    ctx.fillStyle = jaw;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, POCKET_R * scale * 0.72, 0, Math.PI * 2);
    ctx.fillStyle = "#080808";
    ctx.fill();
  }

  // Aim guide: white dotted line + green target reticle + cue stick.
  const cue = balls.find((b) => b.isCue);
  if (cue && !cue.sunk && aim.active && !moving) {
    const pts = aimPath(cue.x, cue.y, aim.dirX, aim.dirY, TABLE.w * (0.4 + aim.power * 0.9), 1);
    // Walk the polyline placing evenly spaced dots.
    const step = scale * 3.2;
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    let carry = BALL_R * scale + step;
    for (let i = 1; i < pts.length; i++) {
      const ax = px(pts[i - 1].x), ay = py(pts[i - 1].y);
      const bx = px(pts[i].x), by = py(pts[i].y);
      const segLen = Math.hypot(bx - ax, by - ay);
      let d = carry;
      while (d < segLen) {
        const t = d / segLen;
        dot(ctx, ax + (bx - ax) * t, ay + (by - ay) * t, Math.max(1, scale * 0.5), "rgba(255,255,255,0.92)");
        d += step;
      }
      carry = d - segLen;
    }
    // Green target reticle at the end.
    const end = pts[pts.length - 1];
    ctx.strokeStyle = "rgba(90,235,120,0.95)";
    ctx.lineWidth = Math.max(1.5, scale * 0.5);
    ctx.shadowColor = "rgba(90,235,120,0.8)";
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(px(end.x), py(end.y), BALL_R * scale, 0, Math.PI * 2);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Cue stick behind the ball, pulled back with power.
    drawCue(ctx, px(cue.x), py(cue.y), -aim.dirX, -aim.dirY, aim.power, scale);
  }
}

function drawCue(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  bx: number,
  by: number,
  power: number,
  scale: number,
) {
  const gap = BALL_R * scale + scale * 1.5 + power * scale * 10;
  const len = scale * 90;
  const tipX = cx + bx * gap;
  const tipY = cy + by * gap;
  const buttX = tipX + bx * len;
  const buttY = tipY + by * len;
  const perpX = -by;
  const perpY = bx;
  const wt = Math.max(1.4, scale * 0.7);
  const wb = Math.max(2.4, scale * 1.5);
  const grad = ctx.createLinearGradient(tipX, tipY, buttX, buttY);
  grad.addColorStop(0, "#f0dca6");
  grad.addColorStop(0.12, "#e8c98f");
  grad.addColorStop(0.6, "#b8894f");
  grad.addColorStop(1, "#6b4a2a");
  ctx.beginPath();
  ctx.moveTo(tipX + perpX * wt, tipY + perpY * wt);
  ctx.lineTo(buttX + perpX * wb, buttY + perpY * wb);
  ctx.lineTo(buttX - perpX * wb, buttY - perpY * wb);
  ctx.lineTo(tipX - perpX * wt, tipY - perpY * wt);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.shadowColor = "rgba(0,0,0,0.45)";
  ctx.shadowBlur = 6;
  ctx.shadowOffsetY = 2;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  // Blue chalk tip.
  dot(ctx, tipX, tipY, wt * 1.05, "#3a7bd0");
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
function bolt(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}
