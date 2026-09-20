/**
 * main.js — Electron main process.
 *
 * Owns the actual Tello link (UDP command + state sockets) and the video
 * pipeline (ffmpeg re-muxing H.264 -> MJPEG over a tiny local HTTP server).
 * The renderer never talks UDP directly — it goes through IPC, which keeps
 * the network/child-process code out of the browser context.
 */

'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const dgram = require('dgram');
const { spawn, spawnSync } = require('child_process');
const http = require('http');

// ----- Configuration ---------------------------------------------------

const TELLO_IP = '192.168.10.1';
const COMMAND_PORT = 8889;
const STATE_PORT = 8890;
const LOCAL_COMMAND_PORT = 9000;
const COMMAND_TIMEOUT_MS = 7000;
const DRONE_VIDEO_PORT = 11111;   // Tello always sends its video here
const LIVE_RELAY_PORT = 11112;    // local: live-preview ffmpeg reads here
const RECORD_RELAY_PORT = 11113;  // local: recording ffmpeg reads here
const VIDEO_HTTP_PORT = 3005;

// ----- State -------------------------------------------------------------

let mainWindow = null;
const commandSocket = dgram.createSocket('udp4');
const stateSocket = dgram.createSocket('udp4');
let socketsReady = false;
let pendingCommand = null;
let lastState = {};

let ffmpegProc = null;
let videoServer = null;
const mjpegClients = [];

let relaySocket = null;     // receives raw drone video, fans it out locally
let forwardSocket = null;   // used to re-send packets to the local relay ports
let recordProc = null;
let recording = false;
let currentRecordingPath = null;

// ----- Logging helper: mirrors to the renderer's on-screen console -------

function log(msg) {
  console.log(`[tello] ${msg}`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('tello:log', msg);
  }
}

// ----- Command socket ------------------------------------------------------

commandSocket.on('message', (msg) => {
  const response = msg.toString().trim();
  if (pendingCommand) {
    clearTimeout(pendingCommand.timer);
    const { resolve, cmd } = pendingCommand;
    pendingCommand = null;
    resolve({ cmd, response });
  } else {
    log(`(unrequested) ${response}`);
  }
});
commandSocket.on('error', (err) => log(`command socket error: ${err.message}`));

function sendCommand(cmd) {
  return new Promise((resolve, reject) => {
    if (pendingCommand) {
      reject(new Error(`busy — still waiting on reply to "${pendingCommand.cmd}"`));
      return;
    }
    const timer = setTimeout(() => {
      pendingCommand = null;
      reject(new Error(`timed out waiting for response to "${cmd}"`));
    }, COMMAND_TIMEOUT_MS);

    pendingCommand = { resolve, reject, timer, cmd };
    const buf = Buffer.from(cmd, 'utf8');
    commandSocket.send(buf, 0, buf.length, COMMAND_PORT, TELLO_IP, (err) => {
      if (err) {
        clearTimeout(timer);
        pendingCommand = null;
        reject(err);
      }
    });
  });
}

async function sendCommandWithRetry(cmd, attempts = 3, gapMs = 800) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await sendCommand(cmd);
    } catch (err) {
      lastErr = err;
      log(`attempt ${i + 1}/${attempts} for "${cmd}" failed: ${err.message}`);
      if (i < attempts - 1) await sleep(gapMs);
    }
  }
  throw lastErr;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ----- State (telemetry) socket ------------------------------------------

function parseState(str) {
  const out = {};
  str.trim().split(';').forEach((pair) => {
    if (!pair) return;
    const [key, val] = pair.split(':');
    if (key === undefined || val === undefined) return;
    const num = Number(val);
    out[key] = Number.isNaN(num) ? val : num;
  });
  return out;
}

stateSocket.on('message', (msg) => {
  lastState = parseState(msg.toString());
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('tello:state', lastState);
  }
});
stateSocket.on('error', (err) => log(`state socket error: ${err.message}`));

function startSockets() {
  if (socketsReady) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let readyCount = 0;
    const done = () => {
      readyCount += 1;
      if (readyCount === 2) {
        socketsReady = true;
        resolve();
      }
    };
    commandSocket.once('error', reject);
    stateSocket.once('error', reject);
    commandSocket.bind(LOCAL_COMMAND_PORT, '0.0.0.0', done);
    stateSocket.bind(STATE_PORT, '0.0.0.0', done);
  });
}

// ----- Video pipeline: ffmpeg (H.264 -> mpjpeg) -> local HTTP server -----

function checkFfmpegAvailable() {
  const result = spawnSync('ffmpeg', ['-version']);
  if (result.error) {
    return { ok: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    return { ok: false, detail: `exited with code ${result.status}` };
  }
  const firstLine = (result.stdout || '').toString().split('\n')[0];
  return { ok: true, detail: firstLine };
}

function startVideo() {
  if (ffmpegProc) return { url: `http://localhost:${VIDEO_HTTP_PORT}/stream` };

  const check = checkFfmpegAvailable();
  if (!check.ok) {
    log(`ffmpeg not found on PATH (${check.detail}). Install it and make sure "ffmpeg -version" works from a terminal, then restart this app.`);
    throw new Error('ffmpeg not found on PATH');
  }
  log(`ffmpeg found: ${check.detail}`);

  // The relay is a plain UDP socket bound to the port the Tello actually
  // sends video to. It doesn't decode anything — it just re-sends every
  // packet it receives to whichever local ports need a copy (live preview,
  // and recording once that's turned on). This is what lets both run off
  // a single real video source instead of fighting over the same port.
  relaySocket = dgram.createSocket('udp4');
  forwardSocket = dgram.createSocket('udp4');

  relaySocket.on('message', (packet) => {
    forwardSocket.send(packet, LIVE_RELAY_PORT, '127.0.0.1');
    if (recording) {
      forwardSocket.send(packet, RECORD_RELAY_PORT, '127.0.0.1');
    }
  });
  relaySocket.on('error', (err) => log(`video relay error: ${err.message}`));
  relaySocket.bind(DRONE_VIDEO_PORT, '0.0.0.0', () => {
    log(`video relay listening on UDP ${DRONE_VIDEO_PORT}, forwarding to local port ${LIVE_RELAY_PORT}`);
  });

  let firstFrameSeen = false;

  ffmpegProc = spawn('ffmpeg', [
    '-buffer_size', '2000000',
    '-i', `udp://127.0.0.1:${LIVE_RELAY_PORT}`,
    '-pix_fmt', 'yuv420p',
    '-f', 'mpjpeg',
    '-q:v', '5',
    '-r', '15',
    'pipe:1',
  ]);
  log(`ffmpeg (live preview) spawned (pid ${ffmpegProc.pid})`);

  ffmpegProc.stdout.on('data', (chunk) => {
    if (!firstFrameSeen) {
      firstFrameSeen = true;
      log('video: receiving frames from ffmpeg — feed should be live now.');
    }
    for (const res of mjpegClients) res.write(chunk);
  });
  ffmpegProc.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    console.error(`[ffmpeg] ${text}`);
    const lastLine = text.trim().split('\n').pop();
    if (lastLine) log(`ffmpeg: ${lastLine}`);
  });
  ffmpegProc.on('error', (err) => {
    log(`failed to start ffmpeg — is it installed and on your PATH? (${err.message})`);
    ffmpegProc = null;
  });
  ffmpegProc.on('close', (code) => {
    log(`ffmpeg (live preview) exited (code ${code}).`);
    if (!firstFrameSeen) {
      log('ffmpeg closed before any video frames arrived — see the terminal for the full ffmpeg log above.');
    }
    ffmpegProc = null;
  });

  if (!videoServer) {
    videoServer = http.createServer((req, res) => {
      if (req.url.split('?')[0] === '/stream') {
        res.writeHead(200, {
          'Content-Type': 'multipart/x-mixed-replace;boundary=ffmpeg',
          'Cache-Control': 'no-cache',
          Connection: 'close',
          Pragma: 'no-cache',
        });
        mjpegClients.push(res);
        req.on('close', () => {
          const idx = mjpegClients.indexOf(res);
          if (idx !== -1) mjpegClients.splice(idx, 1);
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    videoServer.on('error', (err) => {
      log(`video HTTP server error: ${err.message} — is port ${VIDEO_HTTP_PORT} already in use?`);
    });
    videoServer.listen(VIDEO_HTTP_PORT, () => {
      log(`video server listening at http://localhost:${VIDEO_HTTP_PORT}/stream`);
    });
  }

  return { url: `http://localhost:${VIDEO_HTTP_PORT}/stream` };
}

function stopVideo() {
  if (recording) stopRecording();

  if (ffmpegProc) {
    ffmpegProc.kill('SIGINT');
    ffmpegProc = null;
  }
  if (relaySocket) {
    relaySocket.close();
    relaySocket = null;
  }
  if (forwardSocket) {
    forwardSocket.close();
    forwardSocket = null;
  }
  for (const res of mjpegClients) res.end();
  mjpegClients.length = 0;
  if (videoServer) {
    videoServer.close();
    videoServer = null;
  }
}

// ----- Recording: a second ffmpeg reading the relayed copy, stream-copied
// straight into an .mp4 file (no re-encoding — cheap and lossless). -----

function startRecording() {
  if (recording) return { path: currentRecordingPath };
  if (!ffmpegProc || !relaySocket) {
    throw new Error('start video before recording');
  }

  const dir = path.join(app.getPath('videos'), 'TelloPro');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  currentRecordingPath = path.join(dir, `tello-${stamp}.mp4`);

  recording = true; // relay starts forwarding to RECORD_RELAY_PORT immediately

  recordProc = spawn('ffmpeg', [
    '-y',
    '-buffer_size', '2000000',
    '-use_wallclock_as_timestamps', '1',
    '-fflags', '+genpts',
    '-i', `udp://127.0.0.1:${RECORD_RELAY_PORT}`,
    '-c', 'copy',
    '-movflags', '+frag_keyframe+empty_moov',
    '-f', 'mp4',
    currentRecordingPath,
  ]);
  log(`recording started -> ${currentRecordingPath}`);

  recordProc.stderr.on('data', (chunk) => {
    console.error(`[ffmpeg:record] ${chunk.toString()}`);
  });
  recordProc.on('error', (err) => {
    log(`recording failed to start: ${err.message}`);
    recording = false;
    recordProc = null;
  });
    recordProc.on('close', (code) => {
    const rawPath = currentRecordingPath;
    log(`recording stopped (code ${code}) — finalizing ${rawPath}...`);

    const tmpPath = rawPath.replace(/\.mp4$/, '.raw.mp4');
    try {
      fs.renameSync(rawPath, tmpPath);
    } catch (err) {
      log(`could not finalize recording: ${err.message}`);
      recordProc = null;
      return;
    }

    // Fragmented mp4 (frag_keyframe+empty_moov) survives an abrupt kill, but
    // players see it as "streaming" data with no upfront index — that's the
    // "Buffer remaining" behavior. This remux is a fast, lossless pass
    // (still -c copy, no re-encoding) that rebuilds a normal index
    // (faststart) so the finished file plays like any other local video.
    const finalizeProc = spawn('ffmpeg', [
      '-y',
      '-i', tmpPath,
      '-c', 'copy',
      '-movflags', '+faststart',
      rawPath,
    ]);
    finalizeProc.stderr.on('data', (chunk) => {
      console.error(`[ffmpeg:finalize] ${chunk.toString()}`);
    });
    finalizeProc.on('error', (err) => {
      log(`finalize step failed to start (${err.message}); raw file kept at ${tmpPath}`);
      recordProc = null;
    });
    finalizeProc.on('close', (fcode) => {
      if (fcode === 0) {
        fs.unlink(tmpPath, () => {});
        log(`recording saved -> ${rawPath}`);
      } else {
        log(`finalize step exited with code ${fcode}; raw file kept at ${tmpPath}`);
      }
      recordProc = null;
    });
  });

  return { path: currentRecordingPath };
}

function stopRecording() {
  if (!recording) return null;
  recording = false;
  const savedPath = currentRecordingPath;
  if (recordProc) {
    // Ask ffmpeg to quit gracefully so it finalizes the mp4 properly;
    // fall back to a hard kill if it doesn't exit on its own.
    try {
      recordProc.stdin.write('q');
    } catch (err) {
      // stdin may already be closed
    }
    const proc = recordProc;
    setTimeout(() => {
      if (proc && !proc.killed) proc.kill('SIGINT');
    }, 2000);
  }
  return { path: savedPath };
}

// ----- IPC surface exposed to the renderer (via preload.js) --------------

ipcMain.handle('tello:connect', async () => {
  await startSockets();
  const result = await sendCommandWithRetry('command');
  try {
    const bat = await sendCommand('battery?');
    log(`battery: ${bat.response}%`);
  } catch (err) {
    log(`could not read battery: ${err.message}`);
  }
  return result;
});

ipcMain.handle('tello:command', async (_event, cmd) => sendCommand(cmd));

ipcMain.handle('tello:emergency', async () => sendCommand('emergency'));

ipcMain.handle('tello:video:start', async () => {
  await sendCommand('streamon');
  return startVideo();
});

ipcMain.handle('tello:video:stop', async () => {
  stopVideo();
  try {
    await sendCommand('streamoff');
  } catch (err) {
    // ignore — stream may already be off
  }
});

ipcMain.handle('tello:video:record:start', async () => startRecording());

ipcMain.handle('tello:video:record:stop', async () => stopRecording());

ipcMain.handle('tello:auto:square', async (_event, sideCm) => {
  const size = sideCm || 80;
  await sendCommand('takeoff');
  await sleep(3000);
  for (let i = 0; i < 4; i += 1) {
    await sendCommand(`forward ${size}`);
    await sleep(2500);
    await sendCommand('cw 90');
    await sleep(1500);
  }
  await sendCommand('land');
});

// ----- Window lifecycle ----------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#0A0D0B',
    title: 'Tello Pro',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

let shuttingDown = false;
app.on('before-quit', async (event) => {
  if (shuttingDown) return;
  shuttingDown = true;
  event.preventDefault();
  stopVideo();
  try {
    if (socketsReady) await sendCommand('land');
  } catch (err) {
    // ignore — likely already landed or never took off
  }
  commandSocket.close();
  stateSocket.close();
  app.exit(0);
});