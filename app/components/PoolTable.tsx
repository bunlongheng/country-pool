"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import dynamic from "next/dynamic";
import { THEMES, RANDOM_KEY, DEFAULT_THEME, pickItems, type Face } from "../data/themes";
import { RAIL_OPTIONS, railByKey, CLOTHS, clothFor, STICKS, stickByKey, type RailMaterial, type StickMaterial } from "../data/surfaces";
import { sound } from "@/lib/sound";
import {
  BALL_R,
  POCKETS,
  POCKET_R,
  TABLE,
  aimPath,
  allStopped,
  planShot,
  predictHit,
  rack,
  respotCue,
  setBallSize,
  shoot,
  stepWorld,
  type Ball,
} from "@/lib/pool";
import type { BallRender, BallSkin } from "./PoolBalls";

// The WebGL ball layer is client-only (no SSR) and mounts over the felt canvas.
const PoolBalls = dynamic(() => import("./PoolBalls"), { ssr: false });

const OBJECT_BALLS = 15;
const MAX_SHOTS = 30; // clear the rack within this many shots, or lose
const MAX_DEATHS = 5; // scratch this many times and you lose
const MAX_DRAG = 190; // px of pull for full power
// Reserved HUD bands (px) above and below the felt so nothing ever overlaps the table.
const HUD_TOP = 40;
const HUD_BOTTOM = 58;
const FLASH_DUR = 0.72; // seconds a pocket blinks green (2 pulses) after a ball drops
const CUE_FLASH_DUR = 0.55; // seconds the cue ball blinks white (1 pulse) after a respawn
const REPLAY_FPS = 20; // recorded frames per second of motion (sampled every 3rd tick)
const MAX_FRAMES = 12000; // ~10 min of motion; guards memory (only 1 game is ever kept)
const REPLAY_SPEEDS = [0.25, 0.5, 1]; // slow-mo playback speeds for the rewind scrubber
let REDUCE_MOTION = false; // set from matchMedia; skips the canvas fire for motion-sensitive users

// One recorded shot for the end-of-rack move log.
type MoveEntry = {
  n: number; // shot number
  who: "AI" | "You";
  target: string; // country aimed at (AI) or "-"
  pocket: string; // pocket label (AI) or "-"
  precision: number | null; // straightness 0..1 (AI pot) or null
  power: number; // 0..1
  reason: string;
  result: string; // "potted N" | "missed" | "scratch" | "" (pending)
  potBase: number; // pots before this shot, to attribute the result at settle
  deathBase: number;
  ox: number; // cue position + aim direction at the shot (to redraw the helper line in replay)
  oy: number;
  dirX: number;
  dirY: number;
};

// A human name for a pocket, from its table coords (for the move log).
function pocketLabel(p: { x: number; y: number }): string {
  const left = p.x < TABLE.w * 0.25;
  const right = p.x > TABLE.w * 0.75;
  const top = p.y < TABLE.h * 0.5;
  if (!left && !right) return top ? "top side" : "bottom side";
  return `${top ? "top" : "bottom"}-${left ? "left" : "right"}`;
}

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

// Build a fresh rack in the chosen category. The rack's balls index into `items`, and
// each skin carries the item's face + name so the rest of the game can look them up by
// ball id (skins are index-aligned with balls; ball.id === its array index).
function buildRack(themeKey: string): { balls: Ball[]; skins: BallSkin[] } {
  const items = pickItems(themeKey, OBJECT_BALLS);
  const balls = rack(items.map((_, i) => i));
  const skins: BallSkin[] = balls.map((b) =>
    b.isCue
      ? { face: { kind: "color" }, hue: 0, name: "Cue", isCue: true }
      : { face: items[b.ci].face, hue: items[b.ci].hue, name: items[b.ci].name, isCue: false },
  );
  return { balls, skins };
}

const readBallType = () =>
  (typeof window !== "undefined" ? window.localStorage?.getItem("cp-balltype") : null) || DEFAULT_THEME;

// Ball-size option (scales physics + render together). Sizes run bigger for visibility.
const BALL_SIZES = [
  { label: "Normal", factor: 1.5 },
  { label: "Big", factor: 2 },
  { label: "Huge", factor: 2.5 },
];
const readBallSize = () =>
  (typeof window !== "undefined" && Number(window.localStorage?.getItem("cp-ballsize"))) || 1.5;

const readCloth = () =>
  typeof window !== "undefined" ? window.localStorage?.getItem("cp-cloth") || "green" : "green";

const readRail = () =>
  typeof window !== "undefined" ? window.localStorage?.getItem("cp-rail") || "wood" : "wood";

const readStick = () =>
  typeof window !== "undefined" ? window.localStorage?.getItem("cp-stick") || "wood" : "wood";

// Shared styling for a settings quick-tab button (active = green, else dark).
const tabCls = (active: boolean) =>
  "flex items-center gap-1.5 rounded-xl px-3 py-2 font-display text-sm font-bold ring-1 transition active:scale-95 " +
  (active
    ? "bg-[#5be36a] text-[#0a2a12] ring-[#5be36a] shadow-lg"
    : "bg-gradient-to-b from-[#26201a] to-black text-white/85 ring-[#d9b25a]/40");

export default function PoolTable() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const feltRef = useRef<HTMLCanvasElement>(null);
  const [dims, setDims] = useState({ w: 0, h: 0 });

  const [ballSize, setBallSizeState] = useState(() => {
    const f = readBallSize();
    setBallSize(f); // apply to physics BEFORE the first rack is built
    return f;
  });

  const [ballType, setBallType] = useState(readBallType);
  const ballTypeRef = useRef(ballType);
  const [game, setGame] = useState(() => buildRack(readBallType()));
  const skinsRef = useRef<BallSkin[]>(game.skins);

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
  const [clothKey, setClothKey] = useState(readCloth);
  const clothRef = useRef<[string, string, string]>(clothFor(clothKey));
  const [railKey, setRailKey] = useState(readRail);
  const railRef = useRef<RailMaterial>(railByKey(railKey));
  const [stickKey, setStickKey] = useState(readStick);
  const stickRef = useRef<StickMaterial>(stickByKey(stickKey));
  const pocketFlashRef = useRef<number[]>(POCKETS.map(() => 0)); // per-pocket blink timer
  const cueFlashRef = useRef(0); // cue-ball white blink timer (set on respawn)
  const dirtyRef = useRef(true); // request one felt repaint next frame (settings/resize/settle)

  const pickCloth = useCallback((key: string) => {
    sound.unlock();
    setClothKey(key);
    clothRef.current = clothFor(key);
    dirtyRef.current = true;
    try {
      window.localStorage?.setItem("cp-cloth", key);
    } catch {}
  }, []);

  const pickRail = useCallback((key: string) => {
    sound.unlock();
    setRailKey(key);
    railRef.current = railByKey(key);
    dirtyRef.current = true;
    try {
      window.localStorage?.setItem("cp-rail", key);
    } catch {}
  }, []);

  const pickStick = useCallback((key: string) => {
    sound.unlock();
    setStickKey(key);
    stickRef.current = stickByKey(key);
    dirtyRef.current = true;
    try {
      window.localStorage?.setItem("cp-stick", key);
    } catch {}
  }, []);

  // Shuffle cloth colour + frame + stick at once (mid-game safe - pure paint).
  const pickRandom = useCallback(() => {
    const rc = CLOTHS[Math.floor(Math.random() * CLOTHS.length)].key;
    const rf = RAIL_OPTIONS[Math.floor(Math.random() * RAIL_OPTIONS.length)].key;
    const rk = STICKS[Math.floor(Math.random() * STICKS.length)].key;
    pickCloth(rc);
    pickRail(rf);
    pickStick(rk);
  }, [pickCloth, pickRail, pickStick]);

  const [potted, setPotted] = useState(0); // balls potted this rack (shown as "Score")
  const [pottedCodes, setPottedCodes] = useState<{ id: number; face: Face; hue: number; name: string }[]>([]);
  const pottedListRef = useRef<{ id: number; face: Face; hue: number; name: string }[]>([]); // pot-order, for the tray
  const [shots, setShots] = useState(0);
  const shotsRef = useRef(0);
  const [deaths, setDeaths] = useState(0); // times the cue ball was scratched
  const [damageKey, setDamageKey] = useState(0); // bumps to replay the red screen flash
  const [won, setWon] = useState(false);
  const [lost, setLost] = useState(false); // out of shots, or too many scratches
  const pottedRef = useRef(0);
  const deathsRef = useRef(0);
  const wonRef = useRef(false);
  const lostRef = useRef(false);
  // Rack timer: clock starts on the first shot, stops when the rack is won or lost.
  const [startAt, setStartAt] = useState<number | null>(null); // epoch ms of the first shot
  const [endAt, setEndAt] = useState<number | null>(null); // epoch ms when the rack ended
  const startAtRef = useRef<number | null>(null);
  const endAtRef = useRef<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0); // live rack duration, updated off-render
  const [moveLog, setMoveLog] = useState<MoveEntry[]>([]); // every shot + reason, shown at the end
  const moveLogRef = useRef<MoveEntry[]>([]);
  // Full-game recorder -> slow-mo rewind. Only the current game is kept (cleared on reset).
  const framesRef = useRef<Float32Array[]>([]); // per-frame [x,y,sunk] * ballCount, table units
  const frameShotRef = useRef<number[]>([]); // shot number each frame belongs to (for replay context)
  const [replayShot, setReplayShot] = useState(0); // shot number at the current replay frame
  const [replay, setReplay] = useState(false);
  const replayRef = useRef(false);
  const replayHeadRef = useRef(0); // float playhead (frame index)
  const replayPlayingRef = useRef(true);
  const replaySpeedRef = useRef(0.5);
  const replayStopRef = useRef(0); // frame index to stop playback at (one move, or the reel end)
  const [replayIdx, setReplayIdx] = useState(0); // current frame (drives the scrubber)
  const [frameCount, setFrameCount] = useState(0);
  const [replayPlaying, setReplayPlaying] = useState(true);
  const [replaySpeed, setReplaySpeed] = useState(0.5);
  const [segments, setSegments] = useState<{ shot: number; start: number; end: number }[]>([]); // one per move
  const [replayTray, setReplayTray] = useState<{ id: number; face: Face; hue: number; name: string }[]>([]); // potted-so-far at the replay frame
  const replayTrayLenRef = useRef(-1); // last tray length pushed, to avoid per-frame re-renders
  const replayGuideRef = useRef<{ ox: number; oy: number; dirX: number; dirY: number; power: number } | null>(null); // the shot's original helper line
  // Pause/resume: freezes physics, the AI, and the timer (paused time is not counted).
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const pausedMsRef = useRef(0); // total time spent paused this rack
  const pauseStartRef = useRef<number | null>(null); // when the current pause began
  const [portrait, setPortrait] = useState(false);
  const [kids, setKids] = useState(false);
  const kidsRef = useRef(false);
  const toggleKids = useCallback(() => {
    sound.unlock();
    const v = !kidsRef.current;
    kidsRef.current = v;
    dirtyRef.current = true;
    setKids(v);
  }, []);

  // ---- AI mode: the computer plans + plays every shot for you, and shows its aim line +
  // power BEFORE striking so you can learn the line it picked. It always takes the
  // straightest, closest makeable pot, so it clears the rack in as few shots as it can. ----
  const [ai, setAi] = useState(false);
  const aiRef = useRef(false);
  const aiTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aiShootRef = useRef<() => void>(() => {});
  const [aiPlan, setAiPlan] = useState<{ country: string; pocket: string; precision: number; power: number; viable: boolean; reason: string } | null>(null);

  const aiShoot = useCallback(() => {
    if (aiTimerRef.current) {
      clearTimeout(aiTimerRef.current);
      aiTimerRef.current = null;
    }
    if (!aiRef.current || wonRef.current || lostRef.current || pausedRef.current) return;
    const balls = ballsRef.current;
    if (!allStopped(balls)) return;
    const plan = planShot(balls, Math.random); // rng = vary the line game to game
    if (!plan) return;
    // Phase 1 - THINKING: line the shot up on screen (aim guide + cue + power) and name
    // the target, so the plan is visible before the strike.
    aimRef.current.dirX = plan.dirX;
    aimRef.current.dirY = plan.dirY;
    aimRef.current.power = plan.power;
    aimRef.current.active = true;
    setAiming(true);
    setPower(plan.power);
    setAiPlan({
      country: skinsRef.current[plan.target.id]?.name ?? "the ball",
      pocket: pocketLabel(plan.pocket),
      precision: plan.straightness,
      power: plan.power,
      viable: plan.viable,
      reason: plan.reason,
    });
    dirtyRef.current = true;
    // Phase 2 - STRIKE: fire after a beat so the line is watchable/learnable.
    aiTimerRef.current = setTimeout(() => {
      aiTimerRef.current = null;
      aimRef.current.active = false;
      setAiming(false);
      dirtyRef.current = true;
      if (!aiRef.current || wonRef.current || lostRef.current) return;
      const cue = ballsRef.current.find((b) => b.isCue);
      if (cue) {
        shoot(cue, plan.dirX, plan.dirY, plan.power);
        sound.cue(plan.power);
        shotsRef.current += 1;
        setShots(shotsRef.current);
        if (shotsRef.current === 1) {
          startAtRef.current = Date.now(); // clock starts on the first shot of the rack
          setStartAt(startAtRef.current);
        }
        // Record the move + reason for the end-of-rack log (result filled in at settle).
        moveLogRef.current.push({
          n: shotsRef.current,
          who: "AI",
          target: skinsRef.current[plan.target.id]?.name ?? "-",
          pocket: pocketLabel(plan.pocket),
          precision: plan.viable ? plan.straightness : null,
          power: plan.power,
          reason: plan.reason,
          result: "",
          potBase: pottedRef.current,
          deathBase: deathsRef.current,
          ox: cue.x,
          oy: cue.y,
          dirX: plan.dirX,
          dirY: plan.dirY,
        });
        setMoveLog([...moveLogRef.current]);
      }
      aimRef.current.power = 0;
      setPower(0);
    }, 1100);
  }, []);
  useEffect(() => {
    aiShootRef.current = aiShoot;
  }, [aiShoot]);

  const toggleAI = useCallback(() => {
    sound.unlock();
    const v = !aiRef.current;
    aiRef.current = v;
    setAi(v);
    if (v) {
      aiTimerRef.current = setTimeout(() => aiShootRef.current(), 500); // start playing
    } else {
      if (aiTimerRef.current) {
        clearTimeout(aiTimerRef.current);
        aiTimerRef.current = null;
      }
      aimRef.current.active = false;
      setAiming(false);
      setAiPlan(null);
      dirtyRef.current = true;
    }
  }, []);

  // Stop the AI timer on unmount so a queued shot never fires into a dead component.
  useEffect(
    () => () => {
      if (aiTimerRef.current) clearTimeout(aiTimerRef.current);
    },
    [],
  );

  // Tick the live rack timer while a rack is in progress (freezes on won/lost/paused).
  // Computed here (not during render) so it stays clear of the pure-render rules.
  useEffect(() => {
    if (startAt == null || won || lost || paused) return;
    const compute = () => setElapsedMs(Date.now() - startAt - pausedMsRef.current);
    compute();
    const iv = setInterval(compute, 250);
    return () => clearInterval(iv);
  }, [startAt, won, lost, paused]);

  // Pause/resume the game (physics, AI, and the timer all freeze together).
  const togglePause = useCallback(() => {
    if (wonRef.current || lostRef.current || startAtRef.current == null) return; // nothing running
    const v = !pausedRef.current;
    pausedRef.current = v;
    setPaused(v);
    dirtyRef.current = true;
    if (v) {
      pauseStartRef.current = Date.now();
      if (aiTimerRef.current) {
        clearTimeout(aiTimerRef.current); // hold the AI while paused
        aiTimerRef.current = null;
      }
      // Freeze the AI's next planned shot on screen (aim line + narration) so it can be
      // studied for as long as you like while paused - that is the point of pausing here.
      if (aiRef.current && allStopped(ballsRef.current)) {
        const plan = planShot(ballsRef.current, Math.random);
        if (plan) {
          aimRef.current.dirX = plan.dirX;
          aimRef.current.dirY = plan.dirY;
          aimRef.current.power = plan.power;
          aimRef.current.active = true;
          setAiPlan({ country: skinsRef.current[plan.target.id]?.name ?? "the ball", pocket: pocketLabel(plan.pocket), precision: plan.straightness, power: plan.power, viable: plan.viable, reason: plan.reason });
        }
      }
    } else {
      if (pauseStartRef.current != null) {
        pausedMsRef.current += Date.now() - pauseStartRef.current; // exclude paused time
        pauseStartRef.current = null;
      }
      // Resume the AI if it was driving and the table is at rest.
      if (aiRef.current && allStopped(ballsRef.current)) {
        aiTimerRef.current = setTimeout(() => aiShootRef.current(), 400);
      }
    }
  }, []);

  // ---- Slow-mo replay: a World-Cup-style highlight reel, one segment per move ----
  const enterReplay = useCallback(() => {
    const fs = frameShotRef.current;
    if (!fs.length) return;
    // Group contiguous frames of the same shot into per-move segments (Move 1, Move 2 ...).
    const segs: { shot: number; start: number; end: number }[] = [];
    for (let i = 0; i < fs.length; i++) {
      const last = segs[segs.length - 1];
      if (last && last.shot === fs[i]) last.end = i;
      else segs.push({ shot: fs[i], start: i, end: i });
    }
    setSegments(segs);
    setFrameCount(framesRef.current.length);
    replayTrayLenRef.current = -1; // recompute the tray on the first replay frame
    setReplayTray([]);
    replayHeadRef.current = 0;
    replayStopRef.current = framesRef.current.length - 1; // play the whole reel
    replayPlayingRef.current = true;
    replaySpeedRef.current = 0.5; // default to slow-mo
    setReplaySpeed(0.5);
    setReplayPlaying(true);
    setReplayIdx(0);
    replayRef.current = true;
    setReplay(true);
    dirtyRef.current = true;
  }, []);

  const exitReplay = useCallback(() => {
    replayRef.current = false;
    replayGuideRef.current = null;
    setReplay(false);
    dirtyRef.current = true;
  }, []);

  // Jump to a move and play on through the following moves (auto-advance 1 -> 2 -> ...).
  const playMove = useCallback((seg: { shot: number; start: number; end: number }) => {
    replayHeadRef.current = seg.start;
    replayStopRef.current = framesRef.current.length - 1; // continue into the next moves
    replayPlayingRef.current = true;
    setReplayPlaying(true);
    setReplayIdx(seg.start);
    setReplayShot(seg.shot);
    dirtyRef.current = true;
  }, []);

  // Play the whole reel from the start (or resume/pause).
  const toggleReplayPlay = useCallback(() => {
    const v = !replayPlayingRef.current;
    if (v) {
      replayStopRef.current = framesRef.current.length - 1; // full reel
      if (replayHeadRef.current >= framesRef.current.length - 1) replayHeadRef.current = 0; // from start if ended
    }
    replayPlayingRef.current = v;
    setReplayPlaying(v);
  }, []);

  const scrubReplay = useCallback((idx: number) => {
    replayHeadRef.current = idx;
    replayStopRef.current = framesRef.current.length - 1; // scrubbing frees the stop to the reel end
    replayPlayingRef.current = false;
    setReplayPlaying(false);
    setReplayIdx(idx);
    dirtyRef.current = true;
  }, []);

  const setSpeed = useCallback((s: number) => {
    replaySpeedRef.current = s;
    setReplaySpeed(s);
  }, []);

  const muted = useSyncExternalStore(
    (cb) => sound.subscribe(cb),
    () => sound.isMuted(),
    () => false,
  );

  const resetGame = useCallback(() => {
    sound.unlock();
    if (aiTimerRef.current) {
      clearTimeout(aiTimerRef.current);
      aiTimerRef.current = null;
    }
    setAiPlan(null);
    pottedRef.current = 0;
    deathsRef.current = 0;
    shotsRef.current = 0;
    wonRef.current = false;
    lostRef.current = false;
    pottedListRef.current = [];
    pocketFlashRef.current = POCKETS.map(() => 0);
    // Fresh rack = a fresh look: random cloth colour.
    const rc = CLOTHS[Math.floor(Math.random() * CLOTHS.length)].key;
    setClothKey(rc);
    clothRef.current = clothFor(rc);
    try {
      window.localStorage?.setItem("cp-cloth", rc);
    } catch {}
    setConfirmReset(false);
    setPotted(0);
    setPottedCodes([]);
    setShots(0);
    setDeaths(0);
    setWon(false);
    setLost(false);
    // Reset the rack timer + pause state.
    startAtRef.current = null;
    endAtRef.current = null;
    pausedMsRef.current = 0;
    pauseStartRef.current = null;
    pausedRef.current = false;
    setStartAt(null);
    setEndAt(null);
    setPaused(false);
    setElapsedMs(0);
    moveLogRef.current = [];
    setMoveLog([]);
    // Drop the previous game's recording - only the current game is ever kept.
    framesRef.current = [];
    frameShotRef.current = [];
    replayRef.current = false;
    setReplay(false);
    setFrameCount(0);
    setSegments([]);
    setReplayTray([]);
    replayTrayLenRef.current = -1;
    dirtyRef.current = true;
    setGame(buildRack(ballTypeRef.current));
    // Keep auto-playing the new rack if AI mode is on.
    if (aiRef.current) aiTimerRef.current = setTimeout(() => aiShootRef.current(), 900);
  }, []);

  // Switch the ball category (Countries / Colors / Fruits / Veggies / US States / Random).
  // Persists the choice and racks fresh in the new category.
  const pickBallType = useCallback(
    (key: string) => {
      sound.unlock();
      setBallType(key);
      ballTypeRef.current = key;
      try {
        window.localStorage?.setItem("cp-balltype", key);
      } catch {}
      resetGame();
    },
    [resetGame],
  );

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
    dirtyRef.current = true; // resize/orientation -> repaint the felt
  }, [transform]);

  // Motion-sensitivity: skip the canvas fire when the user prefers reduced motion.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const set = () => {
      REDUCE_MOTION = mq.matches;
    };
    set();
    mq.addEventListener("change", set);
    return () => mq.removeEventListener("change", set);
  }, []);

  // Escape closes the Settings / New-rack dialogs.
  useEffect(() => {
    if (!showSettings && !confirmReset) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setShowSettings(false);
        setConfirmReset(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showSettings, confirmReset]);

  // ---- The one animation loop: physics + sound + felt draw + render feed ----
  useEffect(() => {
    const felt = feltRef.current;
    if (!felt) return;
    const ctx = felt.getContext("2d");
    if (!ctx) return;

    const balls = game.balls;
    ballsRef.current = balls;
    skinsRef.current = game.skins; // keep the name/face lookup aligned with the current rack
    renderRef.current = balls.map(() => ({ x: 0, y: 0, r: 1, dx: 1, dy: 0, dist: 0, sunk: false }));
    distRef.current = balls.map(() => 0);

    let raf = 0;
    let last = performance.now();
    let wasMoving = false;
    let recCounter = 0; // samples motion into framesRef every 3rd frame (~20fps)
    // Fixed physics timestep: step the world in exact 1/60 chunks (accumulator pattern)
    // instead of the raw frame delta. This makes physics deterministic and frame-rate
    // independent - and, crucially, IDENTICAL to the AI's simulateShot (also 1/60), so a
    // shot the AI projects as safe cannot scratch for real due to timestep drift.
    const STEP = 1 / 60;
    let acc = 0;

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const frameDt = Math.min(0.05, (now - last) / 1000); // real frame delta (visual timers)
      last = now;
      acc += frameDt; // clamp big stalls; drop excess time
      const { ox, oy, scale } = trRef.current;

      // Replay mode: drive the balls straight from the recording (no physics). Playback
      // stops at replayStopRef (a single move's end, or the end of the whole reel).
      if (replayRef.current && framesRef.current.length) {
        const frames = framesRef.current;
        if (replayPlayingRef.current) {
          replayHeadRef.current += replaySpeedRef.current * REPLAY_FPS * frameDt;
          const stop = Math.min(frames.length - 1, replayStopRef.current);
          if (replayHeadRef.current >= stop) {
            replayHeadRef.current = stop;
            replayPlayingRef.current = false;
            setReplayPlaying(false);
          }
        }
        const idx = Math.max(0, Math.min(frames.length - 1, Math.floor(replayHeadRef.current)));
        const f = frames[idx];
        const sunkIds = new Set<number>();
        for (let i = 0; i < balls.length; i++) {
          balls[i].x = f[i * 3];
          balls[i].y = f[i * 3 + 1];
          balls[i].sunk = f[i * 3 + 2] > 0.5;
          balls[i].vx = 0;
          balls[i].vy = 0;
          if (balls[i].sunk && !balls[i].isCue) sunkIds.add(balls[i].id);
        }
        // Tray must match the frame: only the balls potted so far (in pot order).
        const tray = pottedListRef.current.filter((e) => sunkIds.has(e.id));
        if (tray.length !== replayTrayLenRef.current) {
          replayTrayLenRef.current = tray.length;
          setReplayTray(tray);
        }
        const sn = frameShotRef.current[idx] ?? 0;
        setReplayIdx(idx); // React dedupes identical values, so this is cheap
        setReplayShot(sn);
        // Show the original helper line used for this shot.
        const mv = moveLogRef.current.find((m) => m.n === sn);
        replayGuideRef.current = mv ? { ox: mv.ox, oy: mv.oy, dirX: mv.dirX, dirY: mv.dirY, power: mv.power } : null;
        dirtyRef.current = true;
      }

      if (pausedRef.current || replayRef.current) acc = 0; // freeze physics while paused/replaying
      if (!pausedRef.current && !replayRef.current && !allStopped(balls)) {
        let steps = 0;
        while (acc >= STEP && steps < 8) {
          const ev = stepWorld(balls, STEP);
          if (ev.rails > 0) sound.rail();
          for (const imp of ev.clicks) sound.click(imp / 120);
          for (const id of ev.pocketed) {
            const b = balls.find((x) => x.id === id);
            if (!b) continue;
            pocketFlashRef.current[nearestPocket(b.x, b.y)] = b.isCue ? -FLASH_DUR : FLASH_DUR; // scratch = red
            if (b.isCue) {
              sound.scratch();
              deathsRef.current += 1; // a scratch = a "death"
              setDamageKey((k) => k + 1); // FPS-style red screen flash
            } else {
              sound.pocket();
              const sk = skinsRef.current[b.id];
              if (sk) sound.announce(sk.name); // say the item that just dropped (teaches the category)
              pottedRef.current += 1;
              pottedListRef.current.push({ id: b.id, face: sk?.face ?? { kind: "color" }, hue: sk?.hue ?? 0, name: sk?.name ?? "" });
              setPotted(pottedRef.current); // update Score immediately
              setPottedCodes([...pottedListRef.current]); // roll the flag into the tray immediately
            }
          }
          acc -= STEP;
          steps++;
          if (allStopped(balls)) break;
        }
      } else {
        acc = 0;
      }
      const moving = !allStopped(balls);
      // Record the motion for slow-mo replay (sample ~20fps; skip while paused/replaying).
      if (moving && !replayRef.current && !pausedRef.current) {
        recCounter++;
        if (recCounter % 3 === 0 && framesRef.current.length < MAX_FRAMES) {
          const f = new Float32Array(balls.length * 3);
          for (let i = 0; i < balls.length; i++) {
            f[i * 3] = balls[i].x;
            f[i * 3 + 1] = balls[i].y;
            f[i * 3 + 2] = balls[i].sunk ? 1 : 0;
          }
          framesRef.current.push(f);
          frameShotRef.current.push(shotsRef.current); // tag this frame with its move number
        }
      }
      // Transition moving -> stopped: settle the turn.
      if (wasMoving && !moving && !replayRef.current) {
        dirtyRef.current = true; // one final repaint of the resting table
        const cue = balls.find((b) => b.isCue);
        if (cue && cue.sunk) {
          respotCue(balls); // head spot, nudged clear so it never overlaps another ball
          cueFlashRef.current = CUE_FLASH_DUR; // blink the respawned cue ball white
        }
        setPotted(pottedRef.current);
        setPottedCodes([...pottedListRef.current]);
        setDeaths(deathsRef.current);
        // Finalize the last move's result now that the table has settled.
        const lastMove = moveLogRef.current[moveLogRef.current.length - 1];
        if (lastMove && lastMove.result === "") {
          const dropped = pottedRef.current - lastMove.potBase;
          const scratched = deathsRef.current - lastMove.deathBase > 0;
          lastMove.result = scratched ? "scratch" : dropped > 0 ? `potted ${dropped}` : "missed";
          setMoveLog([...moveLogRef.current]);
        }
        if (pottedRef.current >= OBJECT_BALLS && !wonRef.current) {
          wonRef.current = true;
          setWon(true);
          endAtRef.current = Date.now();
          setEndAt(endAtRef.current);
          if (startAtRef.current != null) setElapsedMs(endAtRef.current - startAtRef.current - pausedMsRef.current);
          setFrameCount(framesRef.current.length); // recording is complete -> enable replay
          sound.win();
        } else if (!wonRef.current && !lostRef.current && (shotsRef.current >= MAX_SHOTS || deathsRef.current >= MAX_DEATHS)) {
          // Out of shots, or scratched too many times -> game over.
          lostRef.current = true;
          setLost(true);
          endAtRef.current = Date.now();
          setEndAt(endAtRef.current);
          if (startAtRef.current != null) setElapsedMs(endAtRef.current - startAtRef.current - pausedMsRef.current);
          setFrameCount(framesRef.current.length); // recording is complete -> enable replay
          sound.gameOver(); // cut the jazz, play the game-over motif
        }
        // AI mode: once the table has settled, queue the computer's next shot.
        if (aiRef.current && !wonRef.current && !lostRef.current) {
          if (aiTimerRef.current) clearTimeout(aiTimerRef.current);
          aiTimerRef.current = setTimeout(() => aiShootRef.current(), 750);
        }
      }
      wasMoving = moving;

      const rpx = BALL_R * scale;
      for (let i = 0; i < balls.length; i++) {
        const b = balls[i];
        const sp = Math.hypot(b.vx, b.vy);
        distRef.current[i] += sp * scale * frameDt;
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
      for (let i = 0; i < flash.length; i++) {
        if (flash[i] > 0) flash[i] = Math.max(0, flash[i] - frameDt);
        else if (flash[i] < 0) flash[i] = Math.min(0, flash[i] + frameDt);
      }
      if (cueFlashRef.current > 0) cueFlashRef.current = Math.max(0, cueFlashRef.current - frameDt);

      // Only repaint the felt when something is actually changing (balls moving, aiming,
      // a pocket/cue flash live) or a one-off redraw was requested (settings, resize,
      // settle). At idle this skips ~25 gradient allocations + a layout read per frame.
      const anyFlash = cueFlashRef.current > 0 || flash.some((f) => f !== 0);
      const active = moving || aimRef.current.active || anyFlash;
      if (active || dirtyRef.current) {
        drawFelt(ctx, felt, trRef.current, balls, aimRef.current, moving, kidsRef.current, flash, cueFlashRef.current, clothRef.current, railRef.current, stickRef.current, replayGuideRef.current);
        if (!active) dirtyRef.current = false;
      }
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
    // Ignore taps while replaying/paused, while the AI is playing, or when the game is over.
    if (replayRef.current || pausedRef.current || aiRef.current || wonRef.current || lostRef.current || !allStopped(ballsRef.current)) return;
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
    dirtyRef.current = true; // clear the aim guide/cue after release
    // Require a real drag (>12% of full pull, ~23px) so a tap or tiny nudge never fires.
    if (a.power > 0.12) {
      const cue = ballsRef.current.find((b) => b.isCue);
      if (cue) {
        shoot(cue, a.dirX, a.dirY, a.power);
        sound.cue(a.power);
        shotsRef.current += 1;
        setShots(shotsRef.current);
        if (shotsRef.current === 1) {
          startAtRef.current = Date.now(); // clock starts on the first shot of the rack
          setStartAt(startAtRef.current);
        }
        moveLogRef.current.push({
          n: shotsRef.current,
          who: "You",
          target: "-",
          pocket: "-",
          precision: null,
          power: a.power,
          reason: "Your shot",
          result: "",
          potBase: pottedRef.current,
          deathBase: deathsRef.current,
          ox: cue.x,
          oy: cue.y,
          dirX: a.dirX,
          dirY: a.dirY,
        });
        setMoveLog([...moveLogRef.current]);
      }
    }
    a.power = 0;
    setPower(0);
  }, []);

  const dpr = typeof window !== "undefined" ? Math.min(2, window.devicePixelRatio || 1) : 1;
  const pct = Math.round(power * 100);
  const durMs = Math.max(0, elapsedMs); // live rack duration (excludes paused time)
  const replayMove = replay ? moveLog.find((m) => m.n === replayShot) ?? null : null; // current-move context

  return (
    <div className="relative h-full w-full overflow-hidden" style={{ background: "var(--room)" }}>
      {/* Table stack sits between the HUD bands. Handlers on the wrapper so the drag
          works over the WebGL layer. */}
      <div
        ref={wrapRef}
        className="absolute inset-0 z-10 touch-none"
        role="application"
        aria-label="Pool table - drag back from the cue ball to aim and release to shoot"
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

      </div>

      {/* BOTTOM HUD band - below the felt: tray left, 3 stats centered, controls right */}
      <div
        className="absolute inset-x-0 bottom-0 z-20 flex items-center gap-2 pl-[max(20px,env(safe-area-inset-left))] pr-[max(20px,env(safe-area-inset-right))]"
        style={{ height: HUD_BOTTOM, paddingBottom: "max(10px,env(safe-area-inset-bottom))" }}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
          {(replay ? replayTray : pottedCodes)
            .slice(-12)
            .reverse()
            .map(({ id, face, hue, name }) => (
              <PottedBall key={id} face={face} hue={hue} name={name} />
            ))}
        </div>

        <div className="flex shrink-0 items-center gap-6 sm:gap-8">
          <Stat label="Score" value={replay ? replayTray.length : potted} />
          <Stat label="Shots" value={shots} />
          <Stat label="Died" value={deaths} />
          <Stat label="Time" value={fmtDur(durMs)} />
        </div>

        <div className="flex flex-1 shrink-0 items-center justify-end gap-1.5">
          <IconBtn onClick={() => { sound.unlock(); setShowSettings(true); }} active={showSettings} title="Table surface">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
          </IconBtn>
          <IconBtn onClick={toggleAI} active={ai} title="AI mode - let the computer play and learn its shots">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="8" width="16" height="11" rx="2.5" /><path d="M12 8V4M12 4h-1.5M12 4h1.5" /><circle cx="9" cy="13.5" r="1.2" /><circle cx="15" cy="13.5" r="1.2" /><path d="M2 13h2M20 13h2" /></svg>
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
          <IconBtn onClick={togglePause} active={paused} title={paused ? "Resume" : "Pause"}>
            {paused ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M8 5v14l11-7z" /></svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
            )}
          </IconBtn>
          <IconBtn onClick={() => { sound.unlock(); setConfirmReset(true); }} title="New rack">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></svg>
          </IconBtn>
        </div>
      </div>

      {/* AI "thinking" banner: names the shot the computer is lining up, with its cut
          precision + power, so you can learn the line before it strikes. */}
      {ai && aiPlan && !won && !lost && (
        <div
          className="pointer-events-none absolute left-1/2 z-30 flex max-w-[92%] -translate-x-1/2 flex-col items-center gap-0.5 rounded-2xl bg-black/78 px-4 py-2 text-center text-xs font-semibold text-white shadow-lg ring-1 ring-white/15 backdrop-blur"
          style={{ top: HUD_TOP + 6 }}
        >
          <div className="flex items-center gap-1.5">
            <span aria-hidden="true">🤖</span>
            {aiPlan.viable ? (
              <span>
                Potting <b className="text-[#f3d888]">{aiPlan.country}</b> into <b className="text-[#f3d888]">{aiPlan.pocket}</b> - precision {Math.round(aiPlan.precision * 100)}% - power {Math.round(aiPlan.power * 100)}%
              </span>
            ) : (
              <span>
                Safety off <b className="text-[#f3d888]">{aiPlan.country}</b> - power {Math.round(aiPlan.power * 100)}%
              </span>
            )}
          </div>
          <div className="text-[11px] font-normal text-white/60">{aiPlan.reason}</div>
        </div>
      )}

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
          role="dialog"
          aria-modal="true"
          aria-label="Settings"
          className="absolute inset-0 z-40 overflow-y-auto bg-black/70 backdrop-blur-md"
          onClick={() => setShowSettings(false)}
        >
          <div className="flex min-h-full flex-col items-center justify-center gap-4 px-6 py-8">
          <div className="title-gold font-display text-3xl font-bold leading-tight sm:text-4xl">Settings</div>

          <div className="flex w-full max-w-md flex-col gap-4" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={pickRandom}
              className="flex items-center justify-center gap-2 rounded-xl bg-gradient-to-b from-[#f3d888] to-[#c99b3c] px-4 py-2.5 font-display text-base font-bold text-[#231a08] shadow-lg ring-1 ring-[#f3d888] transition active:scale-95"
            >
              <span className="text-lg" aria-hidden="true">🎲</span> Randomize
            </button>
            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] font-bold uppercase tracking-widest text-white/55">Ball Type</span>
              <div className="grid grid-cols-3 gap-1.5">
                {THEMES.map((t) => (
                  <button key={t.key} onClick={() => pickBallType(t.key)} className={tabCls(t.key === ballType) + " flex-col !gap-1 px-1 py-2"}>
                    <span className="text-lg leading-none" aria-hidden="true">{t.icon}</span>
                    <span className="text-[10px] leading-tight">{t.label}</span>
                  </button>
                ))}
                <button onClick={() => pickBallType(RANDOM_KEY)} className={tabCls(ballType === RANDOM_KEY) + " flex-col !gap-1 px-1 py-2"}>
                  <span className="text-lg leading-none" aria-hidden="true">🎲</span>
                  <span className="text-[10px] leading-tight">Random</span>
                </button>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] font-bold uppercase tracking-widest text-white/55">Ball Size</span>
              <div className="flex gap-2">
                {BALL_SIZES.map((b) => (
                  <button key={b.label} onClick={() => pickBallSize(b.factor)} className={tabCls(b.factor === ballSize) + " flex-1 justify-center"}>
                    <span className="inline-block rounded-full bg-current" style={{ width: 5 + b.factor * 4, height: 5 + b.factor * 4 }} />
                    {b.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] font-bold uppercase tracking-widest text-white/55">Cloth Color</span>
              <div className="flex flex-wrap justify-center gap-2">
                {CLOTHS.map((c) => (
                  <button
                    key={c.key}
                    onClick={() => pickCloth(c.key)}
                    title={c.label}
                    aria-label={c.label}
                    className={`h-7 w-7 shrink-0 rounded-full ring-2 transition active:scale-90 ${
                      c.key === clothKey ? "scale-110 ring-[#5be36a]" : "ring-white/25"
                    }`}
                    style={{ background: `radial-gradient(circle at 34% 28%, ${c.felt[0]}, ${c.felt[2]})` }}
                  />
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] font-bold uppercase tracking-widest text-white/55">Table Frame</span>
              <div className="grid grid-cols-6 gap-1.5">
                {RAIL_OPTIONS.map((r) => (
                  <button key={r.key} onClick={() => pickRail(r.key)} className={tabCls(r.key === railKey) + " flex-col !gap-1 px-1 py-2"}>
                    <span
                      className="inline-block h-5 w-5 shrink-0 rounded-full ring-1 ring-white/30"
                      style={{ background: `linear-gradient(145deg, ${r.mat.edge}, ${r.mat.frame[2]})` }}
                    />
                    <span className="text-[9px] leading-tight">{r.label}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] font-bold uppercase tracking-widest text-white/55">Stick</span>
              <div className="grid grid-cols-5 gap-1.5">
                {STICKS.map((s) => (
                  <button key={s.key} onClick={() => pickStick(s.key)} className={tabCls(s.key === stickKey) + " flex-col !gap-1 px-1 py-2"}>
                    <span
                      className="inline-block h-5 w-5 shrink-0 rounded-full ring-1 ring-white/30"
                      style={{ background: `linear-gradient(145deg, ${s.mat.shaft[0]}, ${s.mat.shaft[2]})` }}
                    />
                    <span className="text-[9px] leading-tight">{s.label}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <button
            onClick={() => setShowSettings(false)}
            className="rounded-full bg-white/10 px-7 py-2.5 font-display text-base font-semibold text-white ring-1 ring-white/25 transition active:scale-95"
          >
            Done
          </button>
          </div>
        </div>
      )}

      {/* Reset confirmation */}
      {confirmReset && (
        <div role="dialog" aria-modal="true" aria-label="New rack confirmation" className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-5 bg-black/70 px-6 backdrop-blur-md">
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

      {/* Scratch = a red FPS-style damage flash across the whole screen (keyed so it
          replays on every scratch). */}
      {damageKey > 0 && (
        <div
          key={damageKey}
          className="cp-damage pointer-events-none fixed inset-0 z-50"
          style={{ background: "radial-gradient(ellipse at center, rgba(200,0,0,0) 30%, rgba(210,25,25,0.9) 100%)" }}
        />
      )}

      {/* Paused: a compact pill (NOT a full overlay) so the felt, ball positions, and the
          AI's planned aim line stay visible - the whole point is to study them while paused. */}
      {paused && !won && !lost && (
        <div className="pointer-events-none absolute inset-x-0 z-30 flex justify-center px-4" style={{ bottom: HUD_BOTTOM + 12 }}>
          <div className="pointer-events-auto flex items-center gap-3 rounded-full bg-black/70 px-4 py-2 text-white shadow-xl ring-1 ring-white/15 backdrop-blur-sm">
            <span className="font-display title-gold text-lg font-bold leading-none">Paused</span>
            <span className="text-xs font-semibold uppercase tracking-widest text-white/60">{fmtDur(durMs)}</span>
            <button
              onClick={togglePause}
              aria-label="Resume"
              className="flex items-center gap-1.5 rounded-full bg-gradient-to-b from-[#f3d888] to-[#c99b3c] px-4 py-1.5 font-display text-sm font-bold tracking-wide text-[#231a08] ring-1 ring-[#f3d888] transition active:scale-95"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M8 5v14l11-7z" /></svg>
              Resume
            </button>
          </div>
        </div>
      )}

      {/* Win overlay: confetti + Pool Champion */}
      {won && !replay && (
        <div role="dialog" aria-modal="true" aria-label="You win" className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-4 overflow-y-auto bg-black/70 py-6 backdrop-blur-md">
          <Confetti />
          <div className="title-gold z-10 font-display text-5xl font-bold tracking-tight sm:text-7xl">
            Pool Champion
          </div>
          <div className="z-10 flex gap-10 text-center text-white">
            <Big label="Shots" value={shots} />
            <Big label="Died" value={deaths} />
            <Big label="Time" value={fmtDur(durMs)} />
          </div>
          {startAt != null && endAt != null && (
            <div className="z-10 -mt-2 text-xs font-medium uppercase tracking-widest text-white/60">
              Started {fmtClock(startAt)} - Finished {fmtClock(endAt)}
            </div>
          )}
          {moveLog.length > 0 && <MoveLogPanel log={moveLog} />}
          <div className="z-10 mt-2 flex flex-wrap items-center justify-center gap-3">
            {frameCount > 0 && <ReplayCta onClick={enterReplay} />}
            <button
              onClick={resetGame}
              className="rounded-full bg-gradient-to-b from-[#f3d888] to-[#c99b3c] px-8 py-3 font-display text-xl font-bold tracking-wide text-[#231a08] shadow-xl ring-1 ring-[#f3d888] transition active:scale-95"
            >
              Rack Again
            </button>
          </div>
        </div>
      )}

      {/* Lose overlay */}
      {lost && !replay && (
        <div role="dialog" aria-modal="true" aria-label="Game over" className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-4 overflow-y-auto bg-black/80 py-6 backdrop-blur-md">
          <div className="font-display text-5xl font-bold tracking-tight text-[#ff5a4a] drop-shadow-lg sm:text-7xl">
            Game Over
          </div>
          <p className="text-sm font-semibold uppercase tracking-widest text-white/70">
            {deaths >= MAX_DEATHS ? "Too many scratches" : "Out of shots"}
          </p>
          <div className="flex gap-10 text-center text-white">
            <Big label="Score" value={potted} />
            <Big label="Shots" value={shots} />
            <Big label="Died" value={deaths} />
            <Big label="Time" value={fmtDur(durMs)} />
          </div>
          {startAt != null && endAt != null && (
            <div className="-mt-2 text-xs font-medium uppercase tracking-widest text-white/60">
              Started {fmtClock(startAt)} - Ended {fmtClock(endAt)}
            </div>
          )}
          {moveLog.length > 0 && <MoveLogPanel log={moveLog} />}
          <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
            {frameCount > 0 && <ReplayCta onClick={enterReplay} />}
            <button
              onClick={resetGame}
              className="rounded-full bg-gradient-to-b from-[#f3d888] to-[#c99b3c] px-8 py-3 font-display text-xl font-bold tracking-wide text-[#231a08] shadow-xl ring-1 ring-[#f3d888] transition active:scale-95"
            >
              Try Again
            </button>
          </div>
        </div>
      )}

      {/* Slow-mo replay. Responsive: on a narrow/portrait phone it sits in the empty band
          BELOW the table (compact + horizontal) so it never covers the table; on landscape/
          desktop it is a left vertical panel. The game plays underneath, fully visible. */}
      {replay && frameCount > 0 && (
        portrait ? (
          <div className="pointer-events-none absolute inset-x-0 z-40 px-2" style={{ bottom: HUD_BOTTOM + 8 }}>
            <div className="pointer-events-auto mx-auto flex w-full max-w-xl flex-col gap-1.5 rounded-2xl bg-black/85 px-3.5 pb-3 pt-3.5 shadow-2xl ring-1 ring-white/15 backdrop-blur-md">
              <div className="flex items-center gap-2">
                <span className="title-gold shrink-0 font-display text-base font-bold leading-tight">Replay</span>
                {replayMove && (
                  <span className="min-w-0 flex-1 truncate text-[11px] text-white/70">
                    <b className="text-[#f3d888]">Move {replayMove.n}{replayMove.result ? ` - ${replayMove.result}` : ""}</b>
                    {replayMove.who === "AI" ? ` - ${replayMove.target} ${replayMove.pocket}` : " - your shot"}
                  </span>
                )}
                <span className="shrink-0 font-display text-xs font-bold tabular-nums text-white/60">{fmtDur((replayIdx / REPLAY_FPS) * 1000)}</span>
              </div>
              {replayMove?.who === "AI" && <div className="truncate text-[11px] text-white/55">{replayMove.reason}</div>}
              <div className="flex gap-1.5 overflow-x-auto pb-0.5">
                {segments.map((seg) => (
                  <button
                    key={seg.shot}
                    onClick={() => playMove(seg)}
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold transition active:scale-95 ${
                      replayShot === seg.shot ? "bg-[#f3d888] text-[#231a08]" : "bg-white/10 text-white/75 ring-1 ring-white/20"
                    }`}
                  >
                    {seg.shot}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={toggleReplayPlay}
                  aria-label={replayPlaying ? "Pause" : "Play all"}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-b from-[#f3d888] to-[#c99b3c] text-[#231a08] ring-1 ring-[#f3d888] transition active:scale-95"
                >
                  {replayPlaying ? (
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
                  ) : (
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M8 5v14l11-7z" /></svg>
                  )}
                </button>
                <input
                  type="range"
                  min={0}
                  max={Math.max(0, frameCount - 1)}
                  value={replayIdx}
                  onChange={(e) => scrubReplay(Number(e.target.value))}
                  aria-label="Rewind / scrub"
                  className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-white/25 accent-[#f3d888]"
                />
                <div className="flex shrink-0 gap-1">
                  {REPLAY_SPEEDS.map((s) => (
                    <button
                      key={s}
                      onClick={() => setSpeed(s)}
                      className={`rounded-full px-1.5 py-0.5 text-[11px] font-bold transition active:scale-95 ${
                        replaySpeed === s ? "bg-[#f3d888] text-[#231a08]" : "bg-white/10 text-white/70 ring-1 ring-white/20"
                      }`}
                    >
                      {s}x
                    </button>
                  ))}
                </div>
                <button
                  onClick={exitReplay}
                  className="shrink-0 rounded-full bg-white/10 px-3 py-1.5 text-sm font-semibold text-white ring-1 ring-white/25 transition active:scale-95"
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="pointer-events-none absolute inset-y-0 left-0 z-40 flex max-h-full flex-col p-2" style={{ paddingTop: "max(8px,env(safe-area-inset-top))" }}>
            <div className="pointer-events-auto flex max-h-full w-[190px] flex-col gap-2 overflow-hidden rounded-2xl bg-black/80 px-3.5 pb-3.5 pt-4 shadow-2xl ring-1 ring-white/15 backdrop-blur-md sm:w-[210px]">
              <div className="flex items-center justify-between pb-0.5">
                <span className="title-gold font-display text-lg font-bold leading-tight">Replay</span>
                <span className="font-display text-xs font-bold tabular-nums text-white/60">{fmtDur((replayIdx / REPLAY_FPS) * 1000)}</span>
              </div>

              {replayMove && (
                <div className="rounded-xl bg-white/5 p-2 ring-1 ring-white/10">
                  <div className="text-[10px] font-bold uppercase tracking-widest text-[#f3d888]">
                    Move {replayMove.n}
                    {replayMove.result ? ` - ${replayMove.result}` : ""}
                  </div>
                  <div className="text-[13px] font-semibold leading-tight text-white">
                    {replayMove.who === "AI" ? `${replayMove.target} - ${replayMove.pocket}` : "Your shot"}
                  </div>
                  <div className="text-[10px] text-white/50">
                    {replayMove.precision != null ? `${Math.round(replayMove.precision * 100)}% straight - ` : ""}
                    {Math.round(replayMove.power * 100)}% power
                  </div>
                  {replayMove.who === "AI" && <div className="mt-0.5 text-[11px] leading-snug text-white/65">{replayMove.reason}</div>}
                </div>
              )}

              <div className="flex min-h-0 flex-1 flex-wrap content-start gap-1.5 overflow-y-auto">
                {segments.map((seg) => (
                  <button
                    key={seg.shot}
                    onClick={() => playMove(seg)}
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sm font-bold transition active:scale-95 ${
                      replayShot === seg.shot ? "bg-[#f3d888] text-[#231a08]" : "bg-white/10 text-white/75 ring-1 ring-white/15"
                    }`}
                  >
                    {seg.shot}
                  </button>
                ))}
              </div>

              <input
                type="range"
                min={0}
                max={Math.max(0, frameCount - 1)}
                value={replayIdx}
                onChange={(e) => scrubReplay(Number(e.target.value))}
                aria-label="Rewind / scrub"
                className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-white/25 accent-[#f3d888]"
              />

              <div className="flex items-center gap-1.5">
                <button
                  onClick={toggleReplayPlay}
                  aria-label={replayPlaying ? "Pause" : "Play all"}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-b from-[#f3d888] to-[#c99b3c] text-[#231a08] ring-1 ring-[#f3d888] transition active:scale-95"
                >
                  {replayPlaying ? (
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
                  ) : (
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M8 5v14l11-7z" /></svg>
                  )}
                </button>
                <div className="flex flex-1 flex-wrap items-center justify-end gap-1">
                  {REPLAY_SPEEDS.map((s) => (
                    <button
                      key={s}
                      onClick={() => setSpeed(s)}
                      className={`rounded-full px-2 py-0.5 text-[11px] font-bold transition active:scale-95 ${
                        replaySpeed === s ? "bg-[#f3d888] text-[#231a08]" : "bg-white/10 text-white/70 ring-1 ring-white/20"
                      }`}
                    >
                      {s}x
                    </button>
                  ))}
                </div>
              </div>

              <button
                onClick={exitReplay}
                className="w-full rounded-full bg-white/10 px-4 py-1.5 text-sm font-semibold text-white ring-1 ring-white/25 transition active:scale-95"
              >
                Done
              </button>
            </div>
          </div>
        )
      )}
    </div>
  );
}

// "Watch replay" call-to-action on the end screen.
function ReplayCta({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="z-10 flex items-center gap-2 rounded-full bg-white/10 px-6 py-3 font-display text-lg font-bold tracking-wide text-white ring-1 ring-white/30 transition active:scale-95"
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /><path d="M11 9v6l5-3z" fill="currentColor" stroke="none" /></svg>
      Slow-mo replay
    </button>
  );
}

// End-of-rack move log: every shot with the AI's reason, so you can review the game.
function MoveLogPanel({ log }: { log: MoveEntry[] }) {
  return (
    <div className="z-10 w-full max-w-lg px-4">
      <div className="mb-1.5 text-center text-[11px] font-bold uppercase tracking-widest text-white/50">Move log</div>
      <div className="max-h-[34vh] overflow-y-auto rounded-xl bg-black/40 ring-1 ring-white/10">
        {log.map((m) => {
          const color = m.result.startsWith("potted") ? "text-[#5be36a]" : m.result === "scratch" ? "text-[#ff5a4a]" : "text-white/45";
          return (
            <div key={m.n} className="flex items-start gap-2 border-b border-white/5 px-3 py-1.5 text-left text-xs last:border-b-0">
              <span className="w-5 shrink-0 pt-0.5 text-white/35">{m.n}</span>
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-white">
                  {m.who === "AI" ? `${m.target} - ${m.pocket}` : "Your shot"}
                  <span className="font-normal text-white/45">
                    {m.precision != null ? ` - ${Math.round(m.precision * 100)}% straight` : ""} - {Math.round(m.power * 100)}% power
                  </span>
                </div>
                <div className="text-white/55">{m.reason}</div>
              </div>
              <span className={`shrink-0 pt-0.5 text-right font-semibold ${color}`}>{m.result || "..."}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Falling confetti for the win screen - deterministic per index (no Math.random).
function Confetti() {
  const colors = ["#f3d888", "#5be36a", "#2f7fc4", "#ff5a4a", "#b06adf", "#e0913f"];
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {Array.from({ length: 40 }).map((_, i) => {
        const left = (i * 97) % 100;
        const delay = ((i * 53) % 100) / 100;
        const dur = 2.2 + (((i * 29) % 100) / 100) * 1.8;
        const size = 6 + ((i * 13) % 6);
        return (
          <span
            key={i}
            className="absolute top-0 block"
            style={{
              left: `${left}%`,
              width: size,
              height: size * 1.6,
              background: colors[i % colors.length],
              borderRadius: 2,
              animation: `cp-confetti ${dur}s linear ${delay}s infinite`,
            }}
          />
        );
      })}
    </div>
  );
}

// A potted ball in the tray - a glossy sphere matching the WebGL balls on the felt,
// that rolls in from the right when it drops (fresh mount = fresh CSS animation). Renders
// whatever face the ball wore: a flag/state image, a fruit/veg emoji, or a solid colour.
function PottedBall({ face, hue, name }: { face: Face; hue: number; name: string }) {
  return (
    <span
      className="relative h-6 w-6 shrink-0 overflow-hidden rounded-full shadow-md ring-1 ring-black/50"
      style={{ animation: "cp-roll-in 0.7s cubic-bezier(.34,1.12,.5,1) both" }}
      title={name}
      aria-label={name}
    >
      {face.kind === "image" ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={face.src} alt="" className="absolute inset-0 h-full w-full object-cover" />
      ) : face.kind === "emoji" ? (
        <span
          className="absolute inset-0 flex items-center justify-center text-[13px] leading-none"
          style={{ background: `radial-gradient(circle at 38% 32%, hsl(${hue} 70% 80%), hsl(${hue} 60% 60%))` }}
        >
          {face.glyph}
        </span>
      ) : (
        <span className="absolute inset-0" style={{ background: `hsl(${hue} 72% 50%)` }} />
      )}
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

// Format an elapsed span as M:SS (or MM:SS) and a clock time as e.g. "3:45 PM".
function fmtDur(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
function fmtClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// One HUD stat: label above a big gold number (Score / Shots / Died all match).
function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="shrink-0 text-center">
      <div className="text-[10px] uppercase tracking-widest text-white/60">{label}</div>
      <div className="title-gold font-display text-2xl font-bold leading-none">{value}</div>
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
  cueFlash: number,
  cloth: [string, string, string],
  mat: RailMaterial,
  stick: StickMaterial,
  replayGuide: { ox: number; oy: number; dirX: number; dirY: number; power: number } | null,
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
  felt.addColorStop(0, cloth[0]);
  felt.addColorStop(0.68, cloth[1]);
  felt.addColorStop(1, cloth[2]);
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

  // Standard pool markings: the head string + head/foot spots.
  ctx.strokeStyle = "rgba(255,255,255,0.09)";
  ctx.lineWidth = Math.max(0.8, scale * 0.22);
  ctx.beginPath();
  ctx.moveTo(px(TABLE.w * 0.25), py(0));
  ctx.lineTo(px(TABLE.w * 0.25), py(TABLE.h));
  ctx.stroke();
  dot(ctx, px(TABLE.w * 0.25), py(TABLE.h / 2), Math.max(1, scale * 0.6), "rgba(255,255,255,0.16)");
  dot(ctx, px(TABLE.w * 0.7), py(TABLE.h / 2), Math.max(1, scale * 0.6), "rgba(255,255,255,0.16)");

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

  // Pockets: dark mouth + polished jaw, CLIPPED to the outer frame so a big hole never
  // bulges past the table edge. A freshly-used pocket blinks green (red on a scratch).
  ctx.save();
  roundRect(ctx, ox - rail, oy - rail, TABLE.w * scale + rail * 2, TABLE.h * scale + rail * 2, rail * 0.8);
  ctx.clip();
  for (let i = 0; i < POCKETS.length; i++) {
    const p = POCKETS[i];
    const cx = px(p.x);
    const cy = py(p.y);
    const jaw = ctx.createRadialGradient(cx, cy, POCKET_R * scale * 0.5, cx, cy, POCKET_R * scale * 1.15);
    jaw.addColorStop(0, mat.edge); // rim matches the chosen frame material
    jaw.addColorStop(0.6, mat.frame[1]);
    jaw.addColorStop(1, mat.frame[2]);
    ctx.beginPath();
    ctx.arc(cx, cy, POCKET_R * scale * 1.05, 0, Math.PI * 2);
    ctx.fillStyle = jaw;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, POCKET_R * scale * 0.72, 0, Math.PI * 2);
    ctx.fillStyle = "#080808";
    ctx.fill();
    const f = flash[i];
    if (f !== 0) {
      const mag = Math.abs(f);
      const pulses = f < 0 ? 3 : 2; // scratch = red x3, pot = green x2
      const a = Math.abs(Math.sin((1 - mag / FLASH_DUR) * Math.PI * pulses));
      const col = f < 0 ? "255,60,45" : "74,235,120"; // scratch (cue) = red, pot = green
      ctx.save();
      ctx.strokeStyle = `rgba(${col},${0.95 * a})`;
      ctx.shadowColor = `rgba(${col},${a})`;
      ctx.shadowBlur = 16 * a + 3;
      ctx.lineWidth = Math.max(2, scale * 0.9);
      ctx.beginPath();
      ctx.arc(cx, cy, POCKET_R * scale * 0.95, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }
  ctx.restore(); // end pocket clip

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

  // Aim guide: dotted trajectory + target reticle by default. Kids mode also predicts
  // the first ball it will hit, drawing a ghost contact ball + a struck-ball arrow.
  if (cue && !cue.sunk && aim.active && !moving) {
    {
      const hit = kids ? predictHit(cue.x, cue.y, aim.dirX, aim.dirY, balls) : null;
      const reach = hit
        ? Math.hypot(hit.contactX - cue.x, hit.contactY - cue.y)
        : TABLE.w * (0.4 + aim.power * 0.9);
      const pts = aimPath(cue.x, cue.y, aim.dirX, aim.dirY, reach, hit ? 0 : 1);

      // Dotted trajectory.
      const dotR = Math.max(1, scale * 0.55);
      const step = scale * 3;
      let carry = BALL_R * scale + step;
      for (let i = 1; i < pts.length; i++) {
        const ax = px(pts[i - 1].x), ay = py(pts[i - 1].y);
        const bx = px(pts[i].x), by = py(pts[i].y);
        const segLen = Math.hypot(bx - ax, by - ay);
        let d = carry;
        while (d < segLen) {
          const t = d / segLen;
          dot(ctx, ax + (bx - ax) * t, ay + (by - ay) * t, dotR, "rgba(255,255,255,0.9)");
          d += step;
        }
        carry = d - segLen;
      }

      if (hit) {
        // Ghost cue ball at the contact point (kids mode).
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
        // Green target reticle at the end of the ray.
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
    }

    // Near max power: fire billows out behind the cue ball like a thruster.
    if (aim.power > 0.9 && !REDUCE_MOTION) drawFire(ctx, px(cue.x), py(cue.y), -aim.dirX, -aim.dirY, aim.power, scale);

    // Cue stick behind the ball, pulled back with power (always shown).
    drawCue(ctx, px(cue.x), py(cue.y), -aim.dirX, -aim.dirY, aim.power, scale, stick);
  }

  // Replay: redraw the ORIGINAL helper line used for the shot being played (gold, from
  // the cue's position at the moment of that shot) so you can see the intended line.
  if (replayGuide) {
    const reach = TABLE.w * (0.4 + replayGuide.power * 0.9);
    const pts = aimPath(replayGuide.ox, replayGuide.oy, replayGuide.dirX, replayGuide.dirY, reach, 1);
    const dotR = Math.max(1, scale * 0.55);
    const step = scale * 3;
    let carry = BALL_R * scale + step;
    for (let i = 1; i < pts.length; i++) {
      const ax = px(pts[i - 1].x), ay = py(pts[i - 1].y);
      const bx = px(pts[i].x), by = py(pts[i].y);
      const segLen = Math.hypot(bx - ax, by - ay);
      let d = carry;
      while (d < segLen) {
        const t = d / segLen;
        dot(ctx, ax + (bx - ax) * t, ay + (by - ay) * t, dotR, "rgba(243,216,136,0.95)");
        d += step;
      }
      carry = d - segLen;
    }
    const end = pts[pts.length - 1];
    ctx.strokeStyle = "rgba(243,216,136,0.95)";
    ctx.lineWidth = Math.max(1.5, scale * 0.5);
    ctx.shadowColor = "rgba(243,216,136,0.8)";
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(px(end.x), py(end.y), BALL_R * scale, 0, Math.PI * 2);
    ctx.stroke();
    ctx.shadowBlur = 0;
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
  stick: StickMaterial,
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
  // Shaft gradient runs light at the tip -> dark at the butt, per stick material.
  const grad = ctx.createLinearGradient(tipX, tipY, buttX, buttY);
  grad.addColorStop(0, stick.shaft[0]);
  grad.addColorStop(0.55, stick.shaft[1]);
  grad.addColorStop(1, stick.shaft[2]);
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
  // Grip wrap near the butt.
  const g0X = buttX - bx * len * 0.32;
  const g0Y = buttY - by * len * 0.32;
  const gwT = wb * 0.92;
  const gwB = wb;
  ctx.beginPath();
  ctx.moveTo(g0X + perpX * gwT, g0Y + perpY * gwT);
  ctx.lineTo(buttX + perpX * gwB, buttY + perpY * gwB);
  ctx.lineTo(buttX - perpX * gwB, buttY - perpY * gwB);
  ctx.lineTo(g0X - perpX * gwT, g0Y - perpY * gwT);
  ctx.closePath();
  ctx.fillStyle = stick.wrap;
  ctx.fill();
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
