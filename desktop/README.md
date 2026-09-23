# Tello Pro

Electron control console for the DJI/Ryze Tello — controller buttons +
live video preview, in one app.

## Setup

1. Install dependencies:
   ffmpeg is bundled with the app via `ffmpeg-static` — no separate
   install needed, on any platform.

   ```
   npm install
   ```

2. Connect your computer's Wi-Fi to the drone's own network
   (`TELLO-XXXXXX`) — there's no router involved, you join the drone directly.

3. Run:
   ```
   npm start
   ```

## Using it

- **Connect** — click it first; it enters SDK mode and starts pulling telemetry.
- **Takeoff / Land** — big toggle button, or hit Space.
- **Move / Rotate** — the D-pad, or W A S D to move and Q E to rotate.
  Distance and angle per press are set by the Trim sliders.
- **Up / Down** — buttons, or Arrow Up / Arrow Down.
- **Flip** — four buttons, only enabled mid-flight.
- **Speed** — sets the drone's base flight speed (10–100 cm/s).
- **Start Video** — sends `streamon` and opens the live feed in the main
  pane. There's a second or two of latency — that's inherent to decoding
  H.264 through ffmpeg and re-encoding as MJPEG, not a bug.
- **Emergency Stop** — cuts the motors immediately. The drone will drop
  wherever it is. Only use it if something's actually gone wrong.
- **Auto: Fly Square** — takes off, flies a square pattern sized by the
  Distance slider, and lands.

## Safety

Fly in a large, open space clear of people, pets, and obstacles. Keep an
eye on the battery readout in the top bar — below ~10% the Tello can
auto-land unexpectedly.
