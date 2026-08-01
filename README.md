# Country Pool

Play pool where every ball is a glossy 3D country flag - a landscape-first billiards table rendered with WebGL.

![Country Pool table with glossy 3D flag balls racked on emerald felt](docs/screenshots/rack.png)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)
![React](https://img.shields.io/badge/React-19-149eca?logo=react)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript)
![three.js](https://img.shields.io/badge/three.js-0.185-000000?logo=three.js)
![Tests](https://img.shields.io/badge/tests-12%20passing-3fb950)

## Contents

- [Features](#features)
- [Architecture](#architecture)
- [How it works](#how-it-works)
- [Tech stack](#tech-stack)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Project layout](#project-layout)
- [License](#license)

## Features

- 15 object balls, each a real national flag on a glossy 3D WebGL sphere, plus a pearl-white cue ball.
- Drag-to-aim slingshot control: pull back from the cue ball, a colour-coded guide line (green -> amber -> red by power) shows the shot line and its first cushion bounce, release to break. Above 90% power, fire wraps the cue ball and the meter blinks red.
- Full 2D pool physics: elastic ball-on-ball collisions, cushion bounces, six pockets (recessed, realistic side pockets that reject lazy rail rolls), sub-stepped integration so nothing tunnels at speed.
- Pot an object flag and the pocket blinks green; scratch the cue and it blinks red, then the cue respots on the head string. Clear the rack to win with a fanfare.
- The HUD tracks **Shots** (strokes taken) and **Died** (scratches) - lower is better.
- **Kids mode**: a ghost-ball aim assist that shows the contact point and the struck ball's direction.
- **Settings** (all persisted to localStorage): **Ball Size** (Normal / Big / Huge, resizes the real physics), **Table Style** (8 sports - pool, soccer, football, basketball, baseball, tennis, ping pong, swim lanes - each with real markings), **Cloth Color** (10 felt shades), and **Table Frame** (Auto / Wood / Walnut / Leather / Black / Metal / Aluminum, with matching pocket rims and gloss).
- Synthesised sound effects (cue crack scaled by power + a fire boom, ball clicks by impact, rail thud, pocket drop, scratch, win) plus a looping background theme; one mute toggle silences both.
- Landscape-first table that fills the screen, with a rotate hint on portrait and iOS safe-area insets.

## Architecture

A pure, deterministic physics core drives everything; rendering is split cleanly from simulation. The physics runs in abstract table units and writes a per-frame render buffer. A transparent react-three-fiber canvas reads that buffer to place glossy flag spheres, while a 2D canvas underneath paints the themed felt, framed rails, pockets, ball shadows and the aim guide. Table theming (surfaces, cloth colours, rail materials) lives in a pure data module. React state is touched only when a turn settles, never per frame.

```mermaid
flowchart LR
    P[pool.ts<br/>physics core] -->|render buffer| B[PoolBalls<br/>r3f WebGL balls]
    P -->|balls state| F[PoolTable<br/>2D felt + aim + loop]
    D[surfaces.ts<br/>themes + cloths + rails] -->|paint data| F
    I[pointer drag] -->|shoot| P
    S[sound.ts<br/>Web Audio + theme.mp3] -.->|impact events| F
    F --> C[canvas felt]
    B --> G[WebGL overlay]
```

| Layer | File | Role |
|-------|------|------|
| Physics | `lib/pool.ts` | Pure, DOM-free: balls, collisions, cushions, pockets, aim geometry, rack, ball sizing |
| Themes | `app/data/surfaces.ts` | Pure paint data: 8 sport surfaces, 10 cloth colours, rail materials + gloss |
| Sound | `lib/sound.ts` | Runtime-synthesised SFX + a looping theme (`public/theme.mp3`), graceful no-op fallback |
| Game loop | `app/components/PoolTable.tsx` | Single rAF loop, felt/aim canvas, drag-to-aim input, HUD, settings |
| 3D balls | `app/components/PoolBalls.tsx` | react-three-fiber overlay, glossy spheres from the render buffer |
| Lighting | `app/components/Studio.tsx` | r3f lights + environment for the clearcoat sheen |

## How it works

```mermaid
sequenceDiagram
    participant U as Player
    participant T as PoolTable
    participant Po as pool.ts
    participant B as PoolBalls (WebGL)
    U->>T: pointer down + drag from cue
    T->>Po: aimPath(dir, power) for the guide line
    U->>T: release
    T->>Po: shoot(cue, dir, power)
    loop every animation frame until all balls stop
        T->>Po: stepWorld(balls, dt)
        Po-->>T: collision + pocket events (sound)
        T->>B: write render buffer (positions, roll)
    end
    T->>U: update potted / shots / deaths
```

## Tech stack

- Next.js 16 (App Router, static prerender) + React 19, TypeScript strict.
- three.js 0.185 with react-three-fiber and drei for the glossy MeshPhysicalMaterial balls.
- HTML5 Canvas 2D for the themed felt, framed rails, pockets and aim guide.
- Web Audio API for synthesised sound effects, plus a native `<audio>` element for the looping theme (`public/theme.mp3`, served same-origin).
- Tailwind CSS 4 for the HUD, settings tabs and overlays.
- node:test for the physics unit suite; ESLint 9. Deployed on Vercel.

## Quick start

```bash
git clone https://github.com/bunlongheng/country-pool.git
cd country-pool
npm install
npm run dev
```

Open http://localhost:3031 and turn the device to landscape. Pull back from the white cue ball, aim the line, and release to break. Tap the gear to open Settings. `npm test` runs the physics suite.

## Configuration

No environment variables required.

## Project layout

```
country-pool/
├── app/
│   ├── components/
│   │   ├── PoolTable.tsx    # game loop, felt canvas, drag-to-aim, HUD, settings
│   │   ├── PoolBalls.tsx    # react-three-fiber glossy flag-ball overlay
│   │   └── Studio.tsx       # r3f lighting + environment
│   ├── data/
│   │   ├── countries.ts     # 194 countries (code, name, hue)
│   │   └── surfaces.ts      # 8 sport surfaces, 10 cloth colours, rail materials
│   ├── layout.tsx           # self-hosted fonts, metadata
│   ├── page.tsx
│   └── globals.css
├── lib/
│   ├── pool.ts              # pure physics core (unit-tested)
│   └── sound.ts             # Web Audio synth + theme playback
├── tests/pool.test.ts       # 12 node:test unit tests
├── public/
│   ├── flags/               # 194 flag PNGs
│   └── theme.mp3            # looping background theme
└── next.config.ts           # CSP + security headers
```

## License

[MIT](LICENSE) (c) Bunlong Heng - covers the code. `public/theme.mp3` is not covered by the MIT license.
