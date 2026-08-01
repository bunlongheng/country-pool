"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useTexture } from "@react-three/drei";
import { Suspense, useMemo, useRef, type RefObject } from "react";
import * as THREE from "three";
import Studio from "./Studio";

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

// Static per-ball identity, index-aligned with the render array.
export type BallSkin = { code: string; hue: number; isCue: boolean };

function FlagBall({
  code,
  hue,
  index,
  data,
}: {
  code: string;
  hue: number;
  index: number;
  data: RefObject<BallRender[]>;
}) {
  // Configure the texture in the loader callback (the sanctioned place to touch
  // it), not by mutating the hook's return value afterwards.
  const tex = useTexture(`/flags/${code}.png`, (t) => {
    const tx = (Array.isArray(t) ? t[0] : t) as THREE.Texture;
    tx.colorSpace = THREE.SRGBColorSpace;
    tx.anisotropy = 8;
  });
  const ref = useRef<THREE.Mesh>(null);
  const prev = useRef(0);
  const { size } = useThree();
  const emissive = useMemo(() => new THREE.Color().setHSL(hue / 360, 0.85, 0.5), [hue]);

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

  return (
    <mesh ref={ref} visible={false}>
      <primitive object={SPHERE} attach="geometry" />
      <meshPhysicalMaterial
        map={tex}
        roughness={0.12}
        metalness={0}
        clearcoat={1}
        clearcoatRoughness={0.05}
        envMapIntensity={1.2}
        emissive={emissive}
        emissiveIntensity={0.05}
      />
    </mesh>
  );
}

function CueBall({ index, data }: { index: number; data: RefObject<BallRender[]> }) {
  const ref = useRef<THREE.Mesh>(null);
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

  return (
    <mesh ref={ref} visible={false}>
      <primitive object={SPHERE} attach="geometry" />
      <meshPhysicalMaterial
        color="#fdfdf6"
        roughness={0.08}
        metalness={0}
        clearcoat={1}
        clearcoatRoughness={0.03}
        envMapIntensity={1.35}
      />
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
        {skins.map((s, i) =>
          s.isCue ? (
            <CueBall key={i} index={i} data={data} />
          ) : (
            <FlagBall key={i} code={s.code} hue={s.hue} index={i} data={data} />
          ),
        )}
      </Suspense>
    </Canvas>
  );
}
