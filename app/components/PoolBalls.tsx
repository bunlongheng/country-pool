"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useTexture } from "@react-three/drei";
import { Suspense, useMemo, useRef, type RefObject } from "react";
import * as THREE from "three";
import Studio from "./Studio";
import type { Face } from "../data/themes";

// Scratch objects reused across balls/frames - avoids per-frame GC churn in useFrame.
const _axis = new THREE.Vector3();
const _quat = new THREE.Quaternion();
// One shared sphere geometry for all 16 balls (instead of 16 identical copies).
const SPHERE = new THREE.SphereGeometry(1, 48, 48);

// Per-frame render data written by the physics loop (CSS pixels, screen space).
export type BallRender = {
  x: number;
  y: number;
  r: number;
  dx: number; // unit travel direction (screen)
  dy: number;
  dist: number; // accumulated distance travelled (px) - drives roll
  sunk: boolean;
};

// Static per-ball identity, index-aligned with the render array. The face + name come
// from the selected ball theme (country flag, US-state flag, fruit/veg emoji, colour).
export type BallSkin = { face: Face; hue: number; name: string; isCue: boolean };

// Shared position + roll integration for every ball kind (cue, image, emoji, colour).
function useBallFrame(ref: RefObject<THREE.Mesh | null>, index: number, data: RefObject<BallRender[]>) {
  const prev = useRef(0);
  const { size } = useThree();
  useFrame(() => {
    const m = ref.current;
    const d = data.current?.[index];
    if (!m) return;
    if (!d || d.sunk) {
      m.visible = false;
      return;
    }
    m.visible = true;
    m.position.set(d.x - size.width / 2, -(d.y - size.height / 2), 0);
    m.scale.setScalar(Math.max(0.001, d.r));
    const len = Math.hypot(d.dx, d.dy);
    if (len > 1e-5) {
      _axis.set(-d.dy / len, -d.dx / len, 0);
      const dRoll = (d.dist - prev.current) / Math.max(1, d.r);
      m.quaternion.premultiply(_quat.setFromAxisAngle(_axis, dRoll));
    }
    prev.current = d.dist;
  });
}

const glossy = { roughness: 0.12, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: 1.2 };

// A ball wearing a flag / state image texture.
function ImageBall({ src, hue, index, data }: { src: string; hue: number; index: number; data: RefObject<BallRender[]> }) {
  const tex = useTexture(src, (t) => {
    const tx = (Array.isArray(t) ? t[0] : t) as THREE.Texture;
    tx.colorSpace = THREE.SRGBColorSpace;
    tx.anisotropy = 8;
  });
  const ref = useRef<THREE.Mesh>(null);
  const emissive = useMemo(() => new THREE.Color().setHSL(hue / 360, 0.85, 0.5), [hue]);
  useBallFrame(ref, index, data);
  return (
    <mesh ref={ref} visible={false}>
      <primitive object={SPHERE} attach="geometry" />
      <meshPhysicalMaterial map={tex} {...glossy} emissive={emissive} emissiveIntensity={0.05} />
    </mesh>
  );
}

// Draw an emoji glyph centred on a coloured disc and hand it back as a texture.
function emojiTexture(glyph: string, hue: number): THREE.CanvasTexture | null {
  if (typeof document === "undefined") return null;
  const S = 256;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  // Soft coloured backdrop (lighter centre) so the glyph reads on a glossy sphere.
  const g = ctx.createRadialGradient(S * 0.4, S * 0.36, S * 0.1, S * 0.5, S * 0.5, S * 0.62);
  g.addColorStop(0, `hsl(${hue} 70% 82%)`);
  g.addColorStop(1, `hsl(${hue} 60% 62%)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  ctx.font = `${Math.round(S * 0.62)}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(glyph, S / 2, S * 0.54);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// A ball wearing a fruit / vegetable emoji.
function EmojiBall({ glyph, hue, index, data }: { glyph: string; hue: number; index: number; data: RefObject<BallRender[]> }) {
  const ref = useRef<THREE.Mesh>(null);
  const tex = useMemo(() => emojiTexture(glyph, hue), [glyph, hue]);
  useBallFrame(ref, index, data);
  return (
    <mesh ref={ref} visible={false}>
      <primitive object={SPHERE} attach="geometry" />
      <meshPhysicalMaterial map={tex ?? undefined} {...glossy} />
    </mesh>
  );
}

// A plain glossy colour ball (the Colors category).
function ColorBall({ hue, index, data }: { hue: number; index: number; data: RefObject<BallRender[]> }) {
  const ref = useRef<THREE.Mesh>(null);
  const color = useMemo(() => new THREE.Color().setHSL(hue / 360, 0.72, 0.5), [hue]);
  useBallFrame(ref, index, data);
  return (
    <mesh ref={ref} visible={false}>
      <primitive object={SPHERE} attach="geometry" />
      <meshPhysicalMaterial color={color} {...glossy} />
    </mesh>
  );
}

function CueBall({ index, data }: { index: number; data: RefObject<BallRender[]> }) {
  const ref = useRef<THREE.Mesh>(null);
  useBallFrame(ref, index, data);
  return (
    <mesh ref={ref} visible={false}>
      <primitive object={SPHERE} attach="geometry" />
      <meshPhysicalMaterial color="#fdfdf6" roughness={0.08} metalness={0} clearcoat={1} clearcoatRoughness={0.03} envMapIntensity={1.35} />
    </mesh>
  );
}

export default function PoolBalls({
  skins,
  data,
}: {
  skins: BallSkin[];
  data: RefObject<BallRender[]>;
}) {
  return (
    <Canvas
      orthographic
      camera={{ position: [0, 0, 100], zoom: 1, near: 0.1, far: 1000 }}
      gl={{ alpha: true, antialias: true }}
      dpr={[1, 2]}
      className="pointer-events-none absolute inset-0"
    >
      <Suspense fallback={null}>
        <Studio />
        {skins.map((s, i) => {
          if (s.isCue) return <CueBall key={i} index={i} data={data} />;
          if (s.face.kind === "image") return <ImageBall key={i} src={s.face.src} hue={s.hue} index={i} data={data} />;
          if (s.face.kind === "emoji") return <EmojiBall key={i} glyph={s.face.glyph} hue={s.hue} index={i} data={data} />;
          return <ColorBall key={i} hue={s.hue} index={i} data={data} />;
        })}
      </Suspense>
    </Canvas>
  );
}
