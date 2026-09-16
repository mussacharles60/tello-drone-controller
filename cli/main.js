/**
 * tello-control.js
 *
 * Control a DJI/Ryze Tello (or Tello EDU) mini drone from Node.js over UDP.
 *
 * HOW IT WORKS
 * The Tello exposes a simple text-based UDP command protocol:
 *   - Commands are sent to the drone at 192.168.10.1:8889
 *   - The drone replies (usually "ok" or "error") on the same socket
 *   - State telemetry is broadcast by the drone on UDP port 8890
 *   - Video stream (if enabled) comes on UDP port 11111 (not handled here;
 *     that needs an H.264 decoder — out of scope for a control script)
 *
 * SETUP
 *   1. Power on the Tello and connect your computer's Wi-Fi to the drone's
 *      own network (looks like "TELLO-XXXXXX"). There is no separate
 *      router — you must be joined to the drone's AP directly.
 *   2. npm init -y   (if you don't already have a package.json)
 *   3. No extra dependencies needed — this uses Node's built-in `dgram`
 *      and `readline` modules only.
 *   4. Run:  node tello-control.js
 *
 * USAGE
 *   Once running, you get an interactive prompt. Type Tello SDK commands
 *   directly (e.g. "takeoff", "up 50", "cw 90", "land"), or use the
 *   higher-level helper commands listed below.
 *
 * Helper (script-level) commands, on top of raw SDK commands:
 *   help                 - show this command list
 *   status               - print last known telemetry snapshot
 *   square [cm]          - fly a square pattern (default 80cm sides)
 *   exit / quit          - land (if flying) and close the program
 *
 * Full raw SDK command reference (subset, most commonly used):
 *   command              - enter SDK mode (sent automatically on connect)
 *   takeoff / land
 *   up/down/left/right/forward/back <20-500 cm>
 *   cw/ccw <1-360 degrees>            - rotate clockwise / counter-clockwise
 *   flip <l|r|f|b>                    - flip left/right/forward/back
 *   speed <10-100>                    - set speed cm/s
 *   rc <lr> <fb> <ud> <yaw>           - remote-control style stick input, -100..100
 *   emergency                         - cut motors immediately (drone will fall)
 *   battery?                          - query battery %
 *   time?                             - query flight time
 *   wifi?                             - query wifi signal
 *
 * SAFETY
 *   - Fly in a large, open, indoor space or calm outdoor area, clear of
 *     people, pets, and obstacles.
 *   - Keep the "emergency" command handy (typed + Enter) to instantly cut
 *     motors if something goes wrong.
 *   - Battery below ~10% can cause an automatic, uncontrolled landing.
 */

'use strict';

const dgram = require('dgram');
const readline = require('readline');
const { spawn } = require('child_process');
const http = require('http');

// ----- Configuration -----------------------------------------------------

const TELLO_IP = '192.168.10.1';
const COMMAND_PORT = 8889;   // send commands here, receive acks here
const STATE_PORT = 8890;     // drone broadcasts telemetry here
const LOCAL_COMMAND_PORT = 9000; // local port we bind for sending/receiving acks
const COMMAND_TIMEOUT_MS = 7000; // Tello SDK docs recommend up to 7s for e.g. "takeoff"
const VIDEO_UDP_PORT = 11111;    // Tello broadcasts raw H.264 here after "streamon"
const VIDEO_HTTP_PORT = 3005;    // local HTTP server serving the re-muxed MJPEG stream

// ----- Sockets -------------------------------------------------------------

const commandSocket = dgram.createSocket('udp4');
const stateSocket = dgram.createSocket('udp4');

let lastState = {};       // parsed telemetry, updated continuously
let pendingCommand = null; // { resolve, reject, timer, cmd }

// ----- Command socket: send commands, receive "ok"/"error" replies --------

commandSocket.on('message', (msg) => {
  const response = msg.toString().trim();
  if (pendingCommand) {
    clearTimeout(pendingCommand.timer);
    const { resolve, cmd } = pendingCommand;
    pendingCommand = null;
    resolve({ cmd, response });
  } else {
    // Unsolicited message (shouldn't normally happen)
    console.log(`[tello] (unrequested) ${response}`);
  }
});

commandSocket.on('error', (err) => {
  console.error('[tello] command socket error:', err.message);
});

function sendCommand(cmd) {
  return new Promise((resolve, reject) => {
    if (pendingCommand) {
      reject(new Error(`Cannot send "${cmd}" — still waiting on reply to "${pendingCommand.cmd}"`));
      return;
    }

    const timer = setTimeout(() => {
      pendingCommand = null;
      reject(new Error(`Timed out waiting for response to "${cmd}"`));
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

// ----- State socket: parse telemetry broadcast every ~100ms ---------------
// Format example:
// "pitch:0;roll:0;yaw:0;vgx:0;vgy:0;vgz:0;templ:60;temph:62;tof:10;h:0;
//  bat:87;baro:180.5;time:0;agx:-5.0;agy:2.0;agz:-998.0;"

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
});

stateSocket.on('error', (err) => {
  console.error('[tello] state socket error:', err.message);
});

// ----- Bring up sockets -----------------------------------------------------

function startSockets() {
  return new Promise((resolve, reject) => {
    let ready = 0;
    const done = () => {
      ready += 1;
      if (ready === 2) resolve();
    };

    commandSocket.once('error', reject);
    stateSocket.once('error', reject);

    commandSocket.bind(LOCAL_COMMAND_PORT, '0.0.0.0', () => {
      const addr = commandSocket.address();
      console.log(`[tello] command socket bound on ${addr.address}:${addr.port}`);
      done();
    });
    stateSocket.bind(STATE_PORT, '0.0.0.0', () => {
      const addr = stateSocket.address();
      console.log(`[tello] state socket bound on ${addr.address}:${addr.port}`);
      done();
    });
  });
}

// Some Tello units miss the very first UDP packet after waking from standby,
// or a host-side firewall silently eats the first reply while a permission
// prompt is being resolved. Retry the initial handshake a couple of times
// before giving up.
async function sendCommandWithRetry(cmd, attempts = 3, gapMs = 800) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await sendCommand(cmd);
    } catch (err) {
      lastErr = err;
      console.warn(`[tello] attempt ${i + 1}/${attempts} for "${cmd}" failed: ${err.message}`);
      if (i < attempts - 1) await sleep(gapMs);
    }
  }
  throw lastErr;
}

// ----- High-level helpers ---------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function flySquare(sideCm = 80) {
  console.log(`[tello] flying a ${sideCm}cm square...`);
  await sendCommand('takeoff');
  await sleep(3000);
  for (let i = 0; i < 4; i += 1) {
    console.log(`[tello] leg ${i + 1}/4`);
    await sendCommand(`forward ${sideCm}`);
    await sleep(2500);
    await sendCommand('cw 90');
    await sleep(1500);
  }
  await sendCommand('land');
  console.log('[tello] square complete.');
}

function printStatus() {
  if (Object.keys(lastState).length === 0) {
    console.log('[tello] no telemetry received yet — check the wifi connection.');
    return;
  }
  console.log('[tello] last telemetry:');
  console.log(`  battery:     ${lastState.bat}%`);
  console.log(`  height:      ${lastState.h} cm`);
  console.log(`  temp:        ${lastState.templ}-${lastState.temph} C`);
  console.log(`  flight time: ${lastState.time}s`);
  console.log(`  attitude:    pitch=${lastState.pitch} roll=${lastState.roll} yaw=${lastState.yaw}`);
}

function printHelp() {
  console.log(`
Script commands:
  help                 show this list
  status               show last known telemetry
  square [cm]          fly a square pattern (default 80cm)
  video                start live video (sends streamon, opens http://localhost:3005/)
  videostop            stop live video (sends streamoff)
  exit / quit          land (if airborne), stop video, then close

Raw Tello SDK commands (sent as-is), e.g.:
  takeoff | land | up 50 | down 50 | left 50 | right 50
  forward 100 | back 100 | cw 90 | ccw 90
  flip f | flip b | flip l | flip r
  speed 50 | battery? | time? | wifi?
  emergency            (cuts motors immediately — use with care)
`);
}

// ----- Live video (H.264 -> ffmpeg -> MJPEG over HTTP) ----------------------
//
// The Tello broadcasts raw H.264 video (once "streamon" is sent) on UDP port
// 11111. Node has no built-in decoder, so we shell out to ffmpeg: it reads
// the UDP stream and re-muxes it as "mpjpeg" (multipart JPEG), which is the
// exact format browsers expect for a `multipart/x-mixed-replace` <img> feed.
// ffmpeg's default boundary tag for this muxer is "ffmpeg", so as long as our
// HTTP header advertises the same boundary we can just pipe its stdout
// straight through with zero re-parsing.

let ffmpegProc = null;
let videoServer = null;
const mjpegClients = [];

function startVideo() {
  if (ffmpegProc) {
    console.log('[tello] video already running.');
    return;
  }

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
    // ffmpeg logs a lot of progress noise to stderr; suppressed by default.
    // Uncomment the next line if you need to debug the ffmpeg pipeline:
    // process.stderr.write(chunk);
  });

  ffmpegProc.on('error', (err) => {
    console.error('[tello] failed to start ffmpeg — is it installed and on your PATH?', err.message);
    ffmpegProc = null;
  });

  ffmpegProc.on('close', (code) => {
    console.log(`[tello] ffmpeg exited (code ${code}).`);
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
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body style="margin:0;background:#000"><img src="/stream" style="width:100%"></body></html>');
    }
  });

  videoServer.listen(VIDEO_HTTP_PORT, () => {
    console.log(`[tello] video server ready — open http://localhost:${VIDEO_HTTP_PORT}/ in a browser`);
  });
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
  console.log('[tello] video stopped.');
}



async function main() {
  console.log(`[tello] binding local sockets (command:${LOCAL_COMMAND_PORT}, state:${STATE_PORT})...`);
  await startSockets();

  console.log('[tello] entering SDK mode...');
  try {
    const { response } = await sendCommandWithRetry('command');
    console.log(`[tello] handshake response: "${response}"`);
    if (response.toLowerCase() !== 'ok') {
      console.warn('[tello] unexpected handshake response — check that you are connected to the drone\'s wifi.');
    }
  } catch (err) {
    console.error('[tello] failed to enter SDK mode after retries:', err.message);
    console.error('[tello] this almost always means UDP replies aren\'t reaching this machine. Check:');
    console.error('  1. `ping 192.168.10.1` works');
    console.error('  2. your OS firewall allowed Node.js to accept incoming connections (look for a popup)');
    console.error('  3. no VPN or second network adapter (Ethernet) is active alongside the Tello wifi');
    process.exit(1);
  }

  try {
    const { response } = await sendCommand('battery?');
    console.log(`[tello] battery: ${response}%`);
  } catch (err) {
    console.warn('[tello] could not read battery:', err.message);
  }

  printHelp();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'tello> ' });
  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    const [word, ...rest] = input.split(/\s+/);
    const lower = word.toLowerCase();

    try {
      if (lower === 'help') {
        printHelp();
      } else if (lower === 'status') {
        printStatus();
      } else if (lower === 'square') {
        const size = rest[0] ? Number(rest[0]) : 80;
        await flySquare(size);
      } else if (lower === 'video') {
        await sendCommand('streamon');
        startVideo();
      } else if (lower === 'videostop') {
        stopVideo();
        await sendCommand('streamoff');
      } else if (lower === 'exit' || lower === 'quit') {
        rl.close();
        return;
      } else {
        const { response } = await sendCommand(input);
        console.log(`[tello] -> ${response}`);
      }
    } catch (err) {
      console.error(`[tello] error: ${err.message}`);
    }

    rl.prompt();
  });

  rl.on('close', async () => {
    console.log('\n[tello] shutting down — sending land as a safety precaution...');
    stopVideo();
    try {
      await sendCommand('land');
    } catch (err) {
      // Ignore — likely already landed or not flying.
    }
    commandSocket.close();
    stateSocket.close();
    process.exit(0);
  });
}

process.on('SIGINT', () => {
  // Let the readline 'close' handler do the graceful landing/shutdown.
  process.stdin.emit('keypress', '', { name: 'return' });
  process.exit(0);
});

main().catch((err) => {
  console.error('[tello] fatal error:', err);
  process.exit(1);
});