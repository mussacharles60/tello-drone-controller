'use strict';

const els = {
  connDot: document.getElementById('conn-dot'),
  connLabel: document.getElementById('conn-label'),
  connectBtn: document.getElementById('connect-btn'),
  batVal: document.getElementById('bat-val'),
  altVal: document.getElementById('alt-val'),
  timeVal: document.getElementById('time-val'),
  pitchVal: document.getElementById('pitch-val'),
  rollVal: document.getElementById('roll-val'),
  yawVal: document.getElementById('yaw-val'),
  tempVal: document.getElementById('temp-val'),
  videoImg: document.getElementById('video-img'),
  videoPlaceholder: document.getElementById('video-placeholder'),
  videoToggle: document.getElementById('video-toggle'),
  recordToggle: document.getElementById('record-toggle'),
  recordTime: document.getElementById('record-time'),
  squareBtn: document.getElementById('square-btn'),
  flightToggle: document.getElementById('flight-toggle'),
  emergencyBtn: document.getElementById('emergency-btn'),
  distanceSlider: document.getElementById('distance-slider'),
  distanceOut: document.getElementById('distance-out'),
  angleSlider: document.getElementById('angle-slider'),
  angleOut: document.getElementById('angle-out'),
  speedSlider: document.getElementById('speed-slider'),
  speedOut: document.getElementById('speed-out'),
  log: document.getElementById('log'),
};

let connected = false;
let flying = false;
let videoOn = false;
let recordingOn = false;
let recordTimer = null;
let recordStartedAt = null;

function setEnabled(flying_) {
  document.querySelectorAll('.pad-btn').forEach((b) => { b.disabled = !connected; });
  document.querySelectorAll('[data-flip]').forEach((b) => { b.disabled = !connected || !flying_; });
  els.flightToggle.disabled = !connected;
  els.emergencyBtn.disabled = !connected;
  els.squareBtn.disabled = !connected;
}

function logLine(msg) {
  els.log.textContent = msg;
}

window.tello.onLog((msg) => logLine(msg));

window.tello.onState((state) => {
  if (typeof state.bat === 'number') els.batVal.textContent = state.bat;
  if (typeof state.h === 'number') els.altVal.textContent = state.h;
  if (typeof state.time === 'number') els.timeVal.textContent = state.time;
  if (typeof state.pitch === 'number') els.pitchVal.textContent = state.pitch;
  if (typeof state.roll === 'number') els.rollVal.textContent = state.roll;
  if (typeof state.yaw === 'number') els.yawVal.textContent = state.yaw;
  if (typeof state.templ === 'number' && typeof state.temph === 'number') {
    els.tempVal.textContent = `${state.templ}-${state.temph}`;
  }
});

// ---- Connect ----

els.connectBtn.addEventListener('click', async () => {
  els.connectBtn.disabled = true;
  els.connectBtn.textContent = 'Connecting…';
  try {
    await window.tello.connect();
    connected = true;
    els.connDot.classList.add('live');
    els.connLabel.textContent = 'connected';
    els.connectBtn.textContent = 'Connected';
    setEnabled(flying);
  } catch (err) {
    els.connLabel.textContent = 'connection failed';
    els.connectBtn.textContent = 'Retry Connect';
    els.connectBtn.disabled = false;
    logLine(`connect failed: ${err.message}`);
  }
});

// ---- Takeoff / land ----

els.flightToggle.addEventListener('click', async () => {
  els.flightToggle.disabled = true;
  try {
    if (!flying) {
      await window.tello.command('takeoff');
      flying = true;
      els.flightToggle.textContent = 'LAND';
      els.flightToggle.classList.add('flying');
    } else {
      await window.tello.command('land');
      flying = false;
      els.flightToggle.textContent = 'TAKEOFF';
      els.flightToggle.classList.remove('flying');
    }
  } catch (err) {
    logLine(`error: ${err.message}`);
  } finally {
    els.flightToggle.disabled = false;
    setEnabled(flying);
  }
});

// ---- Emergency ----

els.emergencyBtn.addEventListener('click', async () => {
  if (!confirm('This cuts the motors immediately and the drone will drop. Continue?')) return;
  await window.tello.emergency();
  flying = false;
  els.flightToggle.textContent = 'TAKEOFF';
  els.flightToggle.classList.remove('flying');
  setEnabled(flying);
});

// ---- Movement pad ----

function currentDistance() { return Number(els.distanceSlider.value); }
function currentAngle() { return Number(els.angleSlider.value); }

document.querySelectorAll('.pad-btn[data-cmd]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const base = btn.dataset.cmd;
    let cmd;
    if (base === 'cw' || base === 'ccw') {
      cmd = `${base} ${currentAngle()}`;
    } else {
      cmd = `${base} ${currentDistance()}`;
    }
    try {
      await window.tello.command(cmd);
    } catch (err) {
      logLine(`error: ${err.message}`);
    }
  });
});

document.querySelectorAll('[data-flip]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    try {
      await window.tello.command(`flip ${btn.dataset.flip}`);
    } catch (err) {
      logLine(`error: ${err.message}`);
    }
  });
});

// ---- Trim sliders ----

els.distanceSlider.addEventListener('input', () => {
  els.distanceOut.textContent = `${els.distanceSlider.value}cm`;
});
els.angleSlider.addEventListener('input', () => {
  els.angleOut.textContent = `${els.angleSlider.value}°`;
});
els.speedSlider.addEventListener('change', async () => {
  els.speedOut.textContent = els.speedSlider.value;
  try {
    await window.tello.command(`speed ${els.speedSlider.value}`);
  } catch (err) {
    logLine(`error: ${err.message}`);
  }
});
els.speedSlider.addEventListener('input', () => {
  els.speedOut.textContent = els.speedSlider.value;
});

// ---- Video ----

els.videoToggle.addEventListener('click', async () => {
  if (!videoOn) {
    els.videoToggle.disabled = true;
    try {
      const { url } = await window.tello.startVideo();
      els.videoImg.src = `${url}?t=${Date.now()}`;
      els.videoImg.classList.add('active');
      els.videoPlaceholder.classList.add('hidden');
      videoOn = true;
      els.videoToggle.textContent = 'Stop Video';
      els.recordToggle.disabled = false;
    } catch (err) {
      logLine(`video error: ${err.message}`);
    } finally {
      els.videoToggle.disabled = false;
    }
  } else {
    if (recordingOn) await stopRecordingUI();
    await window.tello.stopVideo();
    els.videoImg.classList.remove('active');
    els.videoImg.src = '';
    els.videoPlaceholder.classList.remove('hidden');
    videoOn = false;
    els.videoToggle.textContent = 'Start Video';
    els.recordToggle.disabled = true;
  }
});

// ---- Recording ----

function formatElapsed(ms) {
  const totalSec = Math.floor(ms / 1000);
  const m = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const s = String(totalSec % 60).padStart(2, '0');
  return `${m}:${s}`;
}

async function startRecordingUI() {
  els.recordToggle.disabled = true;
  try {
    await window.tello.startRecording();
    recordingOn = true;
    recordStartedAt = Date.now();
    els.recordToggle.classList.add('active');
    recordTimer = setInterval(() => {
      els.recordTime.textContent = formatElapsed(Date.now() - recordStartedAt);
    }, 500);
  } catch (err) {
    logLine(`recording error: ${err.message}`);
  } finally {
    els.recordToggle.disabled = false;
  }
}

async function stopRecordingUI() {
  els.recordToggle.disabled = true;
  try {
    await window.tello.stopRecording();
  } catch (err) {
    logLine(`recording error: ${err.message}`);
  } finally {
    recordingOn = false;
    els.recordToggle.classList.remove('active');
    els.recordToggle.disabled = !videoOn;
    if (recordTimer) {
      clearInterval(recordTimer);
      recordTimer = null;
    }
    els.recordTime.textContent = '';
  }
}

els.recordToggle.addEventListener('click', () => {
  if (!recordingOn) startRecordingUI();
  else stopRecordingUI();
});

// ---- Auto: square ----

els.squareBtn.addEventListener('click', async () => {
  els.squareBtn.disabled = true;
  try {
    await window.tello.flySquare(currentDistance());
  } catch (err) {
    logLine(`square error: ${err.message}`);
  } finally {
    els.squareBtn.disabled = false;
  }
});

// ---- Keyboard controls ----

const KEY_CMD = {
  KeyW: () => `forward ${currentDistance()}`,
  KeyS: () => `back ${currentDistance()}`,
  KeyA: () => `left ${currentDistance()}`,
  KeyD: () => `right ${currentDistance()}`,
  KeyQ: () => `ccw ${currentAngle()}`,
  KeyE: () => `cw ${currentAngle()}`,
  ArrowUp: () => `up ${currentDistance()}`,
  ArrowDown: () => `down ${currentDistance()}`,
};

let keyBusy = false;
window.addEventListener('keydown', async (e) => {
  if (e.repeat) return;

  if (e.code === 'Space') {
    e.preventDefault();
    if (connected && !els.flightToggle.disabled) els.flightToggle.click();
    return;
  }

  const builder = KEY_CMD[e.code];
  if (!builder || !connected || !flying || keyBusy) return;
  keyBusy = true;
  try {
    await window.tello.command(builder());
  } catch (err) {
    logLine(`error: ${err.message}`);
  } finally {
    keyBusy = false;
  }
});

setEnabled(false);
