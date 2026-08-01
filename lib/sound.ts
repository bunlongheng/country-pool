// Sound engine for Country Pool. The sound EFFECTS (cue, clicks, rail, pocket, scratch,
// win) are synthesised at runtime with Web Audio - no SFX files. The background music is
// a single local file (public/theme.mp3) played through a native <audio> element, served
// same-origin so the CSP stays 'self'. Every call is wrapped so audio can never throw or
// break play, and the mute toggle silences both the synth and the theme.

const STORE_KEY = "cp-muted";

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let muted = false;
const listeners = new Set<(m: boolean) => void>();

if (typeof window !== "undefined") {
  muted = window.localStorage?.getItem(STORE_KEY) === "1";
}

function ensure(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    if (!ctx) {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.9;
      master.connect(ctx.destination);
    }
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function tone(o: {
  type: OscillatorType;
  from: number;
  to?: number;
  dur: number;
  gain: number;
  delay?: number;
}) {
  const c = ensure();
  if (!c || !master) return;
  const t0 = c.currentTime + (o.delay ?? 0);
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = o.type;
  osc.frequency.setValueAtTime(o.from, t0);
  if (o.to !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.to), t0 + o.dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(o.gain, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
  osc.connect(g);
  g.connect(master);
  osc.start(t0);
  osc.stop(t0 + o.dur + 0.02);
}

// A short filtered noise burst - the "knock" body of a ball impact.
function knock(dur: number, gain: number, freq: number) {
  const c = ensure();
  if (!c || !master) return;
  const t0 = c.currentTime;
  const len = Math.floor(c.sampleRate * dur);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = c.createBufferSource();
  src.buffer = buf;
  const filt = c.createBiquadFilter();
  filt.type = "bandpass";
  filt.frequency.value = freq;
  filt.Q.value = 1.4;
  const g = c.createGain();
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(filt);
  filt.connect(g);
  g.connect(master);
  src.start(t0);
  src.stop(t0 + dur + 0.02);
}

// --- Background music: the theme clip, served as a local file so the CSP stays
// 'self'. Started on the first user gesture, looped, and silenced by the same mute
// toggle as the sound effects. A native <audio> element (not WebAudio) keeps it simple
// and reliable across browsers.
let theme: HTMLAudioElement | null = null;

function startTheme() {
  if (typeof window === "undefined") return;
  try {
    if (!theme) {
      theme = new Audio("/theme.mp3");
      theme.loop = true;
      theme.preload = "auto";
      theme.volume = 0.55;
    }
    theme.muted = muted;
    if (theme.paused) void theme.play().catch(() => {}); // ignore autoplay block
  } catch {
    /* audio unavailable - the synthesised effects still play */
  }
}

export const sound = {
  unlock() {
    ensure();
    startTheme(); // begin the theme music on the first user interaction
  },
  // The cue striking the ball - sharp crack, power 0..1 shapes it. Loudness rises on a
  // steep (quadratic) curve so a soft tap is quiet and a full shot cracks hard; above
  // 90% (fire mode) a deep boom + whoosh layer on so max power is unmistakably louder.
  cue(power = 1) {
    const p = Math.max(0, Math.min(1, power));
    const v = 0.18 + p * p * 1.05; // ~0.18 soft -> ~1.2 at full
    knock(0.05, 0.5 * v, 2200 + p * 900);
    tone({ type: "triangle", from: 180, to: 90, dur: 0.06, gain: 0.16 * v });
    const fire = Math.max(0, (p - 0.9) / 0.1);
    if (fire > 0) {
      knock(0.12, 0.55 * fire, 140); // low thud
      tone({ type: "sawtooth", from: 95, to: 40, dur: 0.24, gain: 0.32 * fire }); // boom
      tone({ type: "square", from: 820, to: 200, dur: 0.14, gain: 0.12 * fire, delay: 0.01 }); // whoosh
    }
  },
  // Ball-on-ball click. Loudness + pitch scale with impact speed (0..1-ish).
  click(impact: number) {
    const v = Math.max(0.06, Math.min(1, impact));
    knock(0.04, 0.28 * v, 1500 + v * 2200);
  },
  // A cushion thud - duller and lower than a ball click.
  rail() {
    knock(0.06, 0.16, 320);
  },
  // A ball dropping into a pocket: click, then a hollow wooden roll-away.
  pocket() {
    knock(0.05, 0.3, 900);
    tone({ type: "sine", from: 300, to: 90, dur: 0.32, gain: 0.2, delay: 0.03 });
    tone({ type: "sine", from: 150, to: 60, dur: 0.4, gain: 0.14, delay: 0.06 });
  },
  // Table cleared - a warm little fanfare.
  win() {
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((f, i) =>
      tone({ type: "triangle", from: f, dur: 0.2, gain: 0.22, delay: i * 0.13 }),
    );
  },
  // Scratch (cue ball pocketed) - a short descending "aww".
  scratch() {
    tone({ type: "sawtooth", from: 440, to: 150, dur: 0.32, gain: 0.16 });
  },

  isMuted() {
    return muted;
  },
  setMuted(m: boolean) {
    muted = m;
    if (master && ctx) master.gain.setTargetAtTime(m ? 0 : 0.9, ctx.currentTime, 0.01);
    if (theme) theme.muted = m;
    if (typeof window !== "undefined") window.localStorage?.setItem(STORE_KEY, m ? "1" : "0");
    listeners.forEach((fn) => fn(m));
  },
  toggle() {
    ensure();
    this.setMuted(!muted);
    return muted;
  },
  subscribe(fn: (m: boolean) => void) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
