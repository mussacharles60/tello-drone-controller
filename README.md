# Tello Drone Controller

A desktop control console for the DJI/Ryze Tello mini drone — full manual
flight control, a live video feed, and local recording, built with
Electron and Node.js.

![platform](https://img.shields.io/badge/platform-Windows-blue)
![node](https://img.shields.io/badge/node-%3E%3D18-green)
![electron](https://img.shields.io/badge/electron-31-9feaf9)

## Features

- **Full manual flight control** — takeoff/land, directional movement
  (forward/back/left/right/up/down), rotation, and flips, via on-screen
  buttons or keyboard.
- **Live video feed** — the Tello's H.264 stream is decoded and displayed
  in real time using ffmpeg, re-muxed as MJPEG over a local HTTP server.
- **Video recording** — record the live feed straight to a local `.mp4`
  (stream-copied, no re-encoding), saved to your `Videos/TelloPro` folder.
  Recordings are automatically finalized into a normal, fully seekable
  file once you stop recording.
- **Keyboard shortcuts** — `W A S D` to move, `Q`/`E` to rotate, `↑`/`↓`
  for altitude, `Space` to takeoff/land.
- **Persisted trim settings** — your preferred move distance, rotation
  angle, and flight speed are remembered between launches, and speed is
  automatically re-applied to the drone on connect.
- **Safety features** — an Emergency Stop for cutting the motors
  instantly, and a Disconnect that's only available once the drone has
  landed (checked both in the UI and independently in the app's main
  process, using the drone's own reported altitude).
- **Built-in instructions** — a getting-started guide is shown on first
  launch, and is reachable any time via the Help button.
- **Windows installer** — packaged with `electron-builder`, with a
  standard install wizard that lets the user choose their own install
  location.

## Requirements

- [Node.js](https://nodejs.org/) 18 or newer
- [ffmpeg](https://ffmpeg.org/) installed and available on your system
  `PATH` (required only for the live video feed and recording — flight
  controls work without it)
- A DJI/Ryze Tello or Tello EDU drone

## Project structure

```
tello-drone-controller/
└── desktop/          # the Electron app (Tello Pro)
    ├── main.js        # main process: UDP link to the drone, video
    │                  #   pipeline, IPC handlers
    ├── preload.js      # safe IPC bridge exposed to the renderer
    ├── renderer/       # the UI (controller buttons + video preview)
    ├── build/          # app icon
    └── package.json
```

## Getting started

```bash
cd desktop
npm install
npm start
```

On launch, the app itself will walk you through connecting — the short
version:

1. Power on the Tello.
2. Join your computer's Wi-Fi to the drone's own network, shown in your
   Wi-Fi list as something like `TELLO-XXXXXX`. The Tello creates its own
   hotspot — it does **not** join your home router, and there's no
   internet access while connected to it.
3. Click **Connect** in the app.
4. Fly.

## Building a Windows installer

```bash
cd desktop
npm run dist
```

This produces an installer under `desktop/dist/`, with a normal install
wizard (not a silent one-click install) that lets the user pick where to
install the app.

## Known limitations

- The regular consumer Tello can only run as its own Wi-Fi access point —
  it cannot join your home router. Only the **Tello EDU** supports
  "station mode" for that.
- The Tello has no microphone, so recordings have no audio.
- Live video has roughly 1–2 seconds of latency, inherent to decoding
  H.264 through ffmpeg and re-encoding as MJPEG for preview — fine for
  situational awareness and framing shots, not for tight FPV-style
  flying.

## Author

Built by [Mussa Charles](https://github.com/) / Myssa Technologies
Company Ltd.

## License

MIT © 2026 Mussa Charles / Myssa Technologies Company Ltd. See LICENSE for the full text.