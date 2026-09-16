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
const dgram = require('dgram');
const { spawn } = require('child_process');
const http = require('http');

// ----- Configuration ---------------------------------------------------

const TELLO_IP = '192.168.10.1';
const COMMAND_PORT = 8889;
const STATE_PORT = 8890;
const LOCAL_COMMAND_PORT = 9000;
const COMMAND_TIMEOUT_MS = 7000;
const VIDEO_UDP_PORT = 11111;
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

function startVideo() {
  if (ffmpegProc) return { url: `http://localhost:${VIDEO_HTTP_PORT}/stream` };

  ffmpegProc = spawn('ffmpeg', [
    '-fflags', 'nobuffer',
    '-flags', 'low_delay',
    '-i', `udp://0.0.0.0:${VIDEO_UDP_PORT}`,
    '-f', 'mpjpeg',
    '-q:v', '5',
    '-r', '15',
    'pipe:1',
  ]);

  ffmpegProc.stdout.on('data', (chunk) => {
    for (const res of mjpegClients) res.write(chunk);
  });
  ffmpegProc.stderr.on('data', () => {
    // ffmpeg's progress noise goes to stderr; suppressed here.
  });
  ffmpegProc.on('error', (err) => {
    log(`failed to start ffmpeg — is it installed and on your PATH? (${err.message})`);
    ffmpegProc = null;
  });
  ffmpegProc.on('close', (code) => {
    log(`ffmpeg exited (code ${code}).`);
    ffmpegProc = null;
  });

  videoServer = http.createServer((req, res) => {
    if (req.url === '/stream') {
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
  videoServer.listen(VIDEO_HTTP_PORT);

  return { url: `http://localhost:${VIDEO_HTTP_PORT}/stream` };
}

function stopVideo() {
  if (ffmpegProc) {
    ffmpegProc.kill('SIGINT');
    ffmpegProc = null;
  }
  for (const res of mjpegClients) res.end();
  mjpegClients.length = 0;
  if (videoServer) {
    videoServer.close();
    videoServer = null;
  }
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