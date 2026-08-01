"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import dynamic from "next/dynamic";
import { COUNTRIES } from "../data/countries";
import { SURFACES, surfaceByKey, railFor, CLOTHS, clothFor, type Surface } from "../data/surfaces";
import { sound } from "@/lib/sound";
import {
  BALL_R,
  POCKETS,
  POCKET_R,
  TABLE,
  aimPath,
  allStopped,
  predictHit,
  rack,
  setBallSize,
  shoot,
  stepWorld,
  type Ball,
} from "@/lib/pool";
import type { BallRender, BallSkin } from "./PoolBalls";

// The WebGL ball layer is client-only (no SSR) and mounts over the felt canvas.
const PoolBalls = dynamic(() => import("./PoolBalls"), { ssr: false });

const OBJECT_BALLS = 15;
const MAX_DRAG = 190; // px of pull for full power
// Reserved HUD bands (px) above and below the felt so nothing ever overlaps the table.
const HUD_TOP = 40;
const HUD_BOTTOM = 44;
const FLASH_DUR = 0.72; // seconds a pocket blinks green (2 pulses) after a ball drops
const CUE_FLASH_DUR = 0.55; // seconds the cue ball blinks white (1 pulse) after a respawn

// The pocket index closest to a point - which hole a dropped ball fell into.
function nearestPocket(x: number, y: number): number {
  let bi = 0;
  let bd = Infinity;
  for (let i = 0; i < POCKETS.length; i++) {
    const d = Math.hypot(x - POCKETS[i].x, y - POCKETS[i].y);
    if (d < bd) {
      bd = d;
      bi = i;
    }
  }
  return bi;
}

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

const readSurface = () =>
  typeof window !== "undefined" ? window.localStorage?.getItem("cp-surface") || "pool" : "pool";

// Ball-size option (scales physics + render together). Sizes run bigger for visibility.
const BALL_SIZES = [
  { label: "Normal", factor: 1.5 },
  { label: "Big", factor: 2 },
  { label: "Huge", factor: 2.5 },
];
const readBallSize = () =>
  (typeof window !== "undefined" && Number(window.localStorage?.getItem("cp-ballsize"))) || 1.5;

const readCloth = () =>
  typeof window !== "undefined" ? window.localStorage?.getItem("cp-cloth") || "classic" : "classic";

// Shared styling for the settings dropdowns.
const SELECT_CLS =
  "w-full appearance-none rounded-xl bg-gradient-to-b from-[#26201a] to-black px-4 py-2.5 font-display text-base font-bold text-white ring-1 ring-[#d9b25a]/40 outline-none focus:ring-[#d9b25a]";

export default function PoolTable() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const feltRef = useRef<HTMLCanvasElement>(null);
  const [dims, setDims] = useState({ w: 0, h: 0 });

  const [ballSize, setBallSizeState] = useState(() => {
    const f = readBallSize();
    setBallSize(f); // apply to physics BEFORE the first rack is built
    return f;
  });

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
  const [confirmReset, setConfirmReset] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [surfaceKey, setSurfaceKey] = useState(readSurface);
  const surfaceRef = useRef<Surface>(surfaceByKey(surfaceKey));
  const [clothKey, setClothKey] = useState(readCloth);
  const clothRef = useRef<[string, string, string] | null>(clothFor(clothKey));
  const pocketFlashRef = useRef<number[]>(POCKETS.map(() => 0)); // per-pocket blink timer
  const cueFlashRef = useRef(0); // cue-ball white blink timer (set on respawn)

  const pickCloth = useCallback((key: string) => {
    sound.unlock();
    setClothKey(key);
    clothRef.current = clothFor(key);
    try {
      window.localStorage?.setItem("cp-cloth", key);
    } catch {}
  }, []);

  const pickSurface = useCallback((key: string) => {
    sound.unlock();
    setSurfaceKey(key);
    surfaceRef.current = surfaceByKey(key);
    try {
      window.localStorage?.setItem("cp-surface", key);
    } catch {}
  }, []);

  const [potted, setPotted] = useState(0);
  const [pottedCodes, setPottedCodes] = useState<{ id: number; code: string }[]>([]);
  const pottedListRef = useRef<{ id: number; code: string }[]>([]); // pot-order, for the tray
  const [shots, setShots] = useState(0);
  const [deaths, setDeaths] = useState(0); // times the cue ball was scratched
  const [won, setWon] = useState(false);
  const pottedRef = useRef(0);
  const deathsRef = useRef(0);
  const potsShotRef = useRef(0);
  const wonRef = useRef(false);
  const [portrait, setPortrait] = useState(false);
  const [kids, setKids] = useState(false);
  const kidsRef = useRef(false);
  const toggleKids = useCallback(() => {
    sound.unlock();
    const v = !kidsRef.current;
    kidsRef.current = v;
    setKids(v);
  }, []);

  const muted = useSyncExternalStore(
    (cb) => sound.subscribe(cb),
    () => sound.isMuted(),
    () => false,
  );

  const resetGame = useCallback(() => {
    sound.unlock();
    pottedRef.current = 0;
    deathsRef.current = 0;
    potsShotRef.current = 0;
    wonRef.current = false;
    pottedListRef.current = [];
    pocketFlashRef.current = POCKETS.map(() => 0);
    setConfirmReset(false);
    setPotted(0);
    setPottedCodes([]);
    setShots(0);
    setDeaths(0);
    setWon(false);
    setGame(buildRack());
  }, []);

  const pickBallSize = useCallback(
    (factor: number) => {
      sound.unlock();
      setBallSize(factor); // resize physics + pockets
      setBallSizeState(factor);
      try {
        window.localStorage?.setItem("cp-ballsize", String(factor));
      } catch {}
      resetGame(); // re-rack so the whole game reflows cleanly at the new size
    },
    [resetGame],
  );

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
    // The felt lives between the reserved HUD bands. drawFelt paints a wooden rail of
    // ~13*scale beyond the table on every side, so fit the WHOLE footprint (table +
    // frame) - otherwise the rail and bolts clip off-screen (was chopped on iPad).
    const region = Math.max(1, dims.h - HUD_TOP - HUD_BOTTOM);
    const pad = 8; // breathing room + covers the 16px rail floor at small scales
    const FRAME = 26; // rail units reserved on both axes (13 per side)
    const scale = Math.max(
      0.001,
      Math.min((dims.w - pad * 2) / (TABLE.w + FRAME), (region - pad * 2) / (TABLE.h + FRAME)),
    );
    const ox = (dims.w - TABLE.w * scale) / 2;
    const oy = HUD_TOP + (region - TABLE.h * scale) / 2;
    return { ox, oy, scale };
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
          pocketFlashRef.current[nearestPocket(b.x, b.y)] = FLASH_DUR;
          if (b.isCue) {
            sound.scratch();
            deathsRef.current += 1; // a scratch = a "death"
          } else {
            sound.pocket();
            pottedRef.current += 1;
            potsShotRef.current += 1;
            pottedListRef.current.push({ id: b.id, code: COUNTRIES[b.ci].code });
          }
        }
      }
      // Transition moving -> stopped: settle the turn.
      if (wasMoving && !moving) {
        const cue = balls.find((b) => b.isCue);
        if (cue && cue.sunk) {
          cue.sunk = false; // respot the cue on the head spot
          cue.x = TABLE.w * 0.25;
          cue.y = TABLE.h / 2;
          cue.vx = cue.vy = 0;
          cueFlashRef.current = CUE_FLASH_DUR; // blink the respawned cue ball white
        }
        setPotted(pottedRef.current);
        setPottedCodes([...pottedListRef.current]);
        setDeaths(deathsRef.current);
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

      const flash = pocketFlashRef.current;
      for (let i = 0; i < flash.length; i++) if (flash[i] > 0) flash[i] = Math.max(0, flash[i] - dt);
      if (cueFlashRef.current > 0) cueFlashRef.current = Math.max(0, cueFlashRef.current - dt);

      drawFelt(ctx, felt, trRef.current, balls, aimRef.current, moving, kidsRef.current, flash, surfaceRef.current, cueFlashRef.current, clothRef.current);
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
      {/* Table stack sits between the HUD bands. Handlers on the wrapper so the drag
          works over the WebGL layer. */}
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

      {/* TOP HUD band - above the felt, so it never covers the table */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-center justify-between gap-2 pl-[max(10px,env(safe-area-inset-left))] pr-[max(10px,env(safe-area-inset-right))]"
        style={{ height: HUD_TOP, paddingTop: "env(safe-area-inset-top)" }}
      >
        {/* Center slot: idle hint before the first shot, otherwise the power meter */}
        <div className="flex min-w-0 flex-1 items-center justify-center gap-2">
          {!aiming && shots === 0 ? (
            <span className="truncate text-[12px] font-medium text-white/65 sm:text-[13px]">
              Pull back from the cue ball, aim, release
            </span>
          ) : (
            <>
              <span className="hidden text-[11px] font-bold uppercase tracking-widest text-white/55 sm:inline">
                {power < 0.34 ? "Soft" : power < 0.7 ? "Firm" : "Power"}
              </span>
              <div
                className={`relative h-2.5 w-32 overflow-hidden rounded-full ring-1 ring-black/50 sm:w-48 ${power > 0.9 ? "cp-fire-blink" : ""}`}
                style={{
                  background: "linear-gradient(90deg,#5be36a 0%,#e8d24d 50%,#ff8a3c 74%,#ff4a44 100%)",
                  opacity: aiming ? 1 : 0.5,
                }}
              >
                <div className="absolute inset-y-0 right-0 bg-black/65" style={{ width: `${100 - pct}%` }} />
              </div>
              <span className={`w-9 text-right font-display text-sm font-bold ${power > 0.9 ? "cp-fire-text" : "text-white"}`}>{pct}%</span>
            </>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5 rounded-full bg-black/40 px-2.5 py-1 ring-1 ring-[#d9b25a]/30">
          <span className="text-sm">🎱</span>
          <span className="text-[12px] font-bold text-white">
            {potted}/{OBJECT_BALLS}
          </span>
        </div>
      </div>

      {/* BOTTOM HUD band - below the felt */}
      <div
        className="absolute inset-x-0 bottom-0 z-20 flex items-center justify-between gap-2 pl-[max(10px,env(safe-area-inset-left))] pr-[max(10px,env(safe-area-inset-right))]"
        style={{ height: HUD_BOTTOM, paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="flex min-w-0 items-center gap-1 overflow-hidden pl-0.5">
          {pottedCodes.slice(-12).map(({ id, code }) => (
            <PottedBall key={id} code={code} />
          ))}
        </div>

        <div className="shrink-0 text-center">
          <div className="text-[8px] uppercase tracking-widest text-white/45">Shots</div>
          <div className="title-gold font-display text-2xl font-bold leading-none">{shots}</div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <Chip label="Died" value={deaths} accent />
          <span className="text-base">💀</span>
          <IconBtn onClick={() => { sound.unlock(); setShowSettings(true); }} active={showSettings} title="Table surface">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
          </IconBtn>
          <IconBtn onClick={toggleKids} active={kids} title="Kids mode - show where the ball will go">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3" /><circle cx="12" cy="12" r="2.4" /></svg>
          </IconBtn>
          <IconBtn onClick={() => { sound.unlock(); sound.toggle(); }} title="Sound">
            {muted ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5 6 9H2v6h4l5 4z" /><line x1="23" y1="9" x2="17" y2="15" /><line x1="17" y1="9" x2="23" y2="15" /></svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5 6 9H2v6h4l5 4z" /><path d="M15.54 8.46a5 5 0 0 1 0 7.07" /><path d="M19.07 4.93a10 10 0 0 1 0 14.14" /></svg>
            )}
          </IconBtn>
          <IconBtn onClick={() => { sound.unlock(); setConfirmReset(true); }} title="New rack">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></svg>
          </IconBtn>
        </div>
      </div>

      {/* Rotate hint on portrait (kept off the felt, in the top band area) */}
      {portrait && (
        <div
          className="pointer-events-none absolute left-1/2 z-30 -translate-x-1/2 rounded-full bg-[#d9b25a]/95 px-3 py-1 text-xs font-semibold text-[#231a08] shadow-lg"
          style={{ top: HUD_TOP + 6 }}
        >
          Rotate to landscape for the full table
        </div>
      )}

      {/* Surface picker */}
      {showSettings && (
        <div
          className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-5 bg-black/70 px-6 backdrop-blur-md"
          onClick={() => setShowSettings(false)}
        >
          <div className="title-gold font-display text-3xl font-bold sm:text-4xl">Settings</div>

          <div className="flex w-full max-w-xs flex-col gap-4" onClick={(e) => e.stopPropagation()}>
            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] font-bold uppercase tracking-widest text-white/55">Ball Size</span>
              <select value={ballSize} onChange={(e) => pickBallSize(Number(e.target.value))} className={SELECT_CLS}>
                {BALL_SIZES.map((b) => (
                  <option key={b.label} value={b.factor}>{b.label}</option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] font-bold uppercase tracking-widest text-white/55">Table Style</span>
              <select value={surfaceKey} onChange={(e) => pickSurface(e.target.value)} className={SELECT_CLS}>
                {SURFACES.map((s) => (
                  <option key={s.key} value={s.key}>{s.emoji}  {s.label}</option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] font-bold uppercase tracking-widest text-white/55">Cloth Color</span>
              <select value={clothKey} onChange={(e) => pickCloth(e.target.value)} className={SELECT_CLS}>
                {CLOTHS.map((c) => (
                  <option key={c.key} value={c.key}>{c.label}</option>
                ))}
              </select>
            </label>
          </div>

          <button
            onClick={() => setShowSettings(false)}
            className="rounded-full bg-white/10 px-7 py-2.5 font-display text-base font-semibold text-white ring-1 ring-white/25 transition active:scale-95"
          >
            Done
          </button>
        </div>
      )}

      {/* Reset confirmation */}
      {confirmReset && (
        <div className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-5 bg-black/70 px-6 backdrop-blur-md">
          <div className="title-gold font-display text-3xl font-bold sm:text-4xl">New Rack?</div>
          <p className="max-w-xs text-center text-sm text-white/70">
            This starts a fresh rack and resets your shots and deaths.
          </p>
          <div className="flex gap-3">
            <button
              onClick={() => setConfirmReset(false)}
              className="rounded-full bg-white/10 px-7 py-3 font-display text-lg font-semibold text-white ring-1 ring-white/25 transition active:scale-95"
            >
              Cancel
            </button>
            <button
              onClick={resetGame}
              className="rounded-full bg-gradient-to-b from-[#f3d888] to-[#c99b3c] px-7 py-3 font-display text-lg font-bold text-[#231a08] shadow-xl ring-1 ring-[#f3d888] transition active:scale-95"
            >
              New Rack
            </button>
          </div>
        </div>
      )}

      {/* Win overlay */}
      {won && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-5 bg-black/70 backdrop-blur-md">
          <div className="title-gold font-display text-5xl font-bold tracking-tight sm:text-7xl">
            Rack Cleared
          </div>
          <div className="flex gap-10 text-center text-white">
            <Big label="Shots" value={shots} />
            <Big label="Died" value={deaths} />
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

// A potted country ball in the tray - a glossy sphere matching the WebGL balls on the
// felt, that rolls in from the right when it drops (fresh mount = fresh CSS animation).
function PottedBall({ code }: { code: string }) {
  return (
    <span
      className="relative h-6 w-6 shrink-0 overflow-hidden rounded-full shadow-md ring-1 ring-black/50"
      style={{ animation: "cp-roll-in 0.7s cubic-bezier(.34,1.12,.5,1) both" }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`/flags/${code}.png`} alt="" className="absolute inset-0 h-full w-full object-cover" />
      {/* Spherical highlight (top-left) + shading (bottom-right) = the 3D ball look. */}
      <span
        className="pointer-events-none absolute inset-0 rounded-full"
        style={{
          background:
            "radial-gradient(circle at 34% 26%, rgba(255,255,255,.8) 0%, rgba(255,255,255,.2) 16%, rgba(255,255,255,0) 40%), radial-gradient(circle at 70% 80%, rgba(0,0,0,.5) 0%, rgba(0,0,0,0) 55%)",
        }}
      />
    </span>
  );
}

function Chip({ label, value, accent }: { label: string; value: string | number; accent?: boolean }) {
  return (
    <div className="shrink-0 rounded-lg bg-black/40 px-2.5 py-0.5 text-center ring-1 ring-white/10">
      <div className={`font-display text-base font-bold leading-none ${accent ? "text-[#e8c266]" : "text-white"}`}>
        {value}
      </div>
      <div className="text-[8px] uppercase tracking-widest text-white/45">{label}</div>
    </div>
  );
}

function IconBtn({
  onClick,
  children,
  active,
  title,
}: {
  onClick: () => void;
  children: React.ReactNode;
  active?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={`flex h-9 w-9 items-center justify-center rounded-full shadow ring-1 transition active:scale-95 ${
        active
          ? "bg-[#5be36a] text-[#0a2a12] ring-[#5be36a]"
          : "bg-gradient-to-b from-[#26201a] to-black text-white/85 ring-[#d9b25a]/40"
      }`}
    >
      {children}
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
  kids: boolean,
  flash: number[],
  surface: Surface,
  cueFlash: number,
  cloth: [string, string, string] | null,
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
  const mat = railFor(surface.key); // themed frame material (wood / metal / leather ...)

  // Warm room glow behind the table.
  const glow = ctx.createRadialGradient(W / 2, H * 0.42, scale * 10, W / 2, H * 0.42, Math.max(W, H) * 0.7);
  glow.addColorStop(0, "rgba(120,80,30,0.20)");
  glow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // Frame with a bright themed outer edge.
  roundRect(ctx, ox - rail, oy - rail, TABLE.w * scale + rail * 2, TABLE.h * scale + rail * 2, rail * 0.8);
  ctx.fillStyle = mat.edge;
  ctx.fill();
  const frameGrad = ctx.createLinearGradient(0, oy - rail, 0, oy + TABLE.h * scale + rail);
  frameGrad.addColorStop(0, mat.frame[0]);
  frameGrad.addColorStop(0.5, mat.frame[1]);
  frameGrad.addColorStop(1, mat.frame[2]);
  const fx = ox - rail * 0.82;
  const fy = oy - rail * 0.82;
  const fw = TABLE.w * scale + rail * 1.64;
  const fh = TABLE.h * scale + rail * 1.64;
  roundRect(ctx, fx, fy, fw, fh, rail * 0.6);
  ctx.fillStyle = frameGrad;
  ctx.fill();

  // Gloss: an overhead-light sheen (bright top edge, shadowed bottom) across the frame.
  // The felt drawn next covers the centre, so this reads as a lit, glossy rail bevel.
  if (mat.gloss > 0) {
    const sheen = ctx.createLinearGradient(0, fy, 0, fy + fh);
    sheen.addColorStop(0, `rgba(255,255,255,${0.6 * mat.gloss})`);
    sheen.addColorStop(0.14, `rgba(255,255,255,${0.14 * mat.gloss})`);
    sheen.addColorStop(0.5, "rgba(255,255,255,0)");
    sheen.addColorStop(0.85, `rgba(0,0,0,${0.16 * mat.gloss})`);
    sheen.addColorStop(1, `rgba(0,0,0,${0.34 * mat.gloss})`);
    roundRect(ctx, fx, fy, fw, fh, rail * 0.6);
    ctx.fillStyle = sheen;
    ctx.fill();
  }

  // Themed rail bolts.
  ctx.fillStyle = mat.bolt;
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

  // Themed inner trim + felt bed.
  roundRect(ctx, px(0) - scale * 1.4, py(0) - scale * 1.4, TABLE.w * scale + scale * 2.8, TABLE.h * scale + scale * 2.8, scale * 2.6);
  ctx.fillStyle = mat.edge;
  ctx.fill();

  const felt = ctx.createRadialGradient(
    px(TABLE.w / 2),
    py(TABLE.h / 2),
    scale * 6,
    px(TABLE.w / 2),
    py(TABLE.h / 2),
    scale * TABLE.w * 0.62,
  );
  const feltStops = cloth ?? surface.felt; // cloth colour overrides the surface felt
  felt.addColorStop(0, feltStops[0]);
  felt.addColorStop(0.68, feltStops[1]);
  felt.addColorStop(1, feltStops[2]);
  roundRect(ctx, px(0), py(0), TABLE.w * scale, TABLE.h * scale, scale * 2);
  ctx.fillStyle = felt;
  ctx.fill();
  ctx.save();
  ctx.clip();

  // Soft overhead light on the felt - brighter at the top, shadowed at the bottom.
  const feltLight = ctx.createLinearGradient(0, py(0), 0, py(TABLE.h));
  feltLight.addColorStop(0, "rgba(255,255,255,0.11)");
  feltLight.addColorStop(0.4, "rgba(255,255,255,0.02)");
  feltLight.addColorStop(1, "rgba(0,0,0,0.12)");
  ctx.fillStyle = feltLight;
  ctx.fillRect(px(0), py(0), TABLE.w * scale, TABLE.h * scale);

  // Sport-specific markings for the chosen surface.
  surface.draw({ ctx, px, py, scale });

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

  // Pockets: dark mouth + polished gold jaw. A freshly-used pocket blinks green twice.
  for (let i = 0; i < POCKETS.length; i++) {
    const p = POCKETS[i];
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
    const f = flash[i];
    if (f > 0) {
      const a = Math.abs(Math.sin((1 - f / FLASH_DUR) * Math.PI * 2)); // 2 pulses
      ctx.save();
      ctx.strokeStyle = `rgba(74,235,120,${0.95 * a})`;
      ctx.shadowColor = `rgba(74,235,120,${a})`;
      ctx.shadowBlur = 16 * a + 3;
      ctx.lineWidth = Math.max(2, scale * 0.9);
      ctx.beginPath();
      ctx.arc(cx, cy, POCKET_R * scale * 0.95, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  // Cue ball just respawned (scratch): one white pulse behind the WebGL ball.
  const cue = balls.find((b) => b.isCue);
  if (cueFlash > 0 && cue && !cue.sunk) {
    const a = Math.sin((1 - cueFlash / CUE_FLASH_DUR) * Math.PI); // single 0 -> 1 -> 0 pulse
    const cx = px(cue.x);
    const cy = py(cue.y);
    const r = BALL_R * scale * (1.5 + a * 1.1);
    const g = ctx.createRadialGradient(cx, cy, BALL_R * scale * 0.4, cx, cy, r);
    g.addColorStop(0, `rgba(255,255,255,${0.95 * a})`);
    g.addColorStop(0.6, `rgba(255,255,255,${0.4 * a})`);
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.save();
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Aim guide: dotted line + target marker + cue stick. Kids mode adds a ghost ball
  // at the contact point and an arrow for the struck ball's direction.
  if (cue && !cue.sunk && aim.active && !moving) {
    const hit = kids ? predictHit(cue.x, cue.y, aim.dirX, aim.dirY, balls) : null;
    const reach = hit
      ? Math.hypot(hit.contactX - cue.x, hit.contactY - cue.y)
      : TABLE.w * (0.4 + aim.power * 0.9);
    const pts = aimPath(cue.x, cue.y, aim.dirX, aim.dirY, reach, hit ? 0 : 1);

    // Walk the polyline placing evenly spaced dots (green + bolder in kids mode).
    const dotCol = kids ? "rgba(126,240,150,0.98)" : "rgba(255,255,255,0.92)";
    const dotR = Math.max(1, scale * (kids ? 0.62 : 0.5));
    const step = scale * (kids ? 2.8 : 3.2);
    let carry = BALL_R * scale + step;
    for (let i = 1; i < pts.length; i++) {
      const ax = px(pts[i - 1].x), ay = py(pts[i - 1].y);
      const bx = px(pts[i].x), by = py(pts[i].y);
      const segLen = Math.hypot(bx - ax, by - ay);
      let d = carry;
      while (d < segLen) {
        const t = d / segLen;
        dot(ctx, ax + (bx - ax) * t, ay + (by - ay) * t, dotR, dotCol);
        d += step;
      }
      carry = d - segLen;
    }

    if (hit) {
      // Ghost cue ball at the contact point.
      ctx.save();
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = Math.max(1.4, scale * 0.5);
      ctx.beginPath();
      ctx.arc(px(hit.contactX), py(hit.contactY), BALL_R * scale, 0, Math.PI * 2);
      ctx.stroke();
      // Arrow showing where the struck ball will travel.
      const tx = px(hit.target.x), ty = py(hit.target.y);
      const alen = BALL_R * scale * 3.4;
      drawArrow(ctx, tx, ty, tx + hit.dirX * alen, ty + hit.dirY * alen, "rgba(255,210,80,0.98)", scale);
      ctx.restore();
    } else {
      // Green target reticle at the end (normal mode).
      const end = pts[pts.length - 1];
      ctx.strokeStyle = "rgba(90,235,120,0.95)";
      ctx.lineWidth = Math.max(1.5, scale * 0.5);
      ctx.shadowColor = "rgba(90,235,120,0.8)";
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(px(end.x), py(end.y), BALL_R * scale, 0, Math.PI * 2);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // Near max power: fire + smoke billow out behind the cue ball like a thruster.
    if (aim.power > 0.9) drawFire(ctx, px(cue.x), py(cue.y), -aim.dirX, -aim.dirY, aim.power, scale);

    // Cue stick behind the ball, pulled back with power.
    drawCue(ctx, px(cue.x), py(cue.y), -aim.dirX, -aim.dirY, aim.power, scale);
  }
}

function drawArrow(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: string,
  scale: number,
) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(1.6, scale * 0.6);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const h = Math.max(4, scale * 1.7);
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - h * Math.cos(ang - 0.42), y2 - h * Math.sin(ang - 0.42));
  ctx.lineTo(x2 - h * Math.cos(ang + 0.42), y2 - h * Math.sin(ang + 0.42));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// Fire that WRAPS the back of the cue ball at high power - short flame tongues hugging
// the rear arc (the WebGL ball draws on top, so they lick around its edge), like a
// fireball charging up. (bx,by) points BEHIND the ball. Small, flickering, additive.
function drawFire(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  bx: number,
  by: number,
  power: number,
  scale: number,
) {
  const intensity = Math.min(1, Math.max(0, (power - 0.9) / 0.1));
  if (intensity <= 0) return;
  const t = (typeof performance !== "undefined" ? performance.now() : 0) / 1000;
  const R = BALL_R * scale;
  const back = Math.atan2(by, bx); // angle pointing behind the ball

  ctx.save();
  ctx.globalCompositeOperation = "lighter";

  // Warm glow hugging the ball's rear.
  const gx = cx + bx * R * 0.55;
  const gy = cy + by * R * 0.55;
  const gr = R * (1.5 + intensity * 0.4);
  const glow = ctx.createRadialGradient(gx, gy, R * 0.25, gx, gy, gr);
  glow.addColorStop(0, `rgba(255,185,80,${0.5 * intensity})`);
  glow.addColorStop(0.6, `rgba(255,90,25,${0.2 * intensity})`);
  glow.addColorStop(1, "rgba(255,40,0,0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(gx, gy, gr, 0, Math.PI * 2);
  ctx.fill();

  // Short flame tongues fanned around the rear arc, hugging the ball edge.
  const N = 9;
  const spread = 2.3; // ~130deg of wrap around the back
  for (let i = 0; i < N; i++) {
    const a = back + (i / (N - 1) - 0.5) * spread;
    const flick = 0.7 + 0.3 * Math.sin(t * 20 + i * 1.7);
    const wob = Math.sin(t * 14 + i * 2.1) * 0.1;
    const r0 = R * 0.88; // root sits just inside the ball edge
    const r1 = R * (1.05 + (0.35 + 0.2 * intensity) * flick); // short tips
    const rootX = cx + Math.cos(a) * r0;
    const rootY = cy + Math.sin(a) * r0;
    const tipX = cx + Math.cos(a + wob) * r1;
    const tipY = cy + Math.sin(a + wob) * r1;
    const w = R * 0.16;
    const nx = Math.cos(a + Math.PI / 2) * w;
    const ny = Math.sin(a + Math.PI / 2) * w;
    const fg = ctx.createLinearGradient(rootX, rootY, tipX, tipY);
    fg.addColorStop(0, `rgba(255,240,165,${0.85 * intensity})`);
    fg.addColorStop(0.55, `rgba(255,135,30,${0.6 * intensity})`);
    fg.addColorStop(1, "rgba(200,30,0,0)");
    ctx.fillStyle = fg;
    ctx.beginPath();
    ctx.moveTo(rootX + nx, rootY + ny);
    ctx.quadraticCurveTo((rootX + tipX) / 2 + nx, (rootY + tipY) / 2 + ny, tipX, tipY);
    ctx.quadraticCurveTo((rootX + tipX) / 2 - nx, (rootY + tipY) / 2 - ny, rootX - nx, rootY - ny);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
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
