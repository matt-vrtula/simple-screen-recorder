const $ = (id) => document.getElementById(id);
const els = {
  options: $('options'),
  systemAudio: $('systemAudio'),
  mic: $('mic'),
  format: $('format'),
  logTab: $('logTab'),
  startBtn: $('startBtn'),
  pauseBtn: $('pauseBtn'),
  stopBtn: $('stopBtn'),
  status: $('status'),
  timer: $('timer'),
  preview: $('preview'),
  recordings: $('recordings'),
};

// MP4 first: unlike Chrome's WebM output it has a proper duration, so it seeks fine everywhere.
const FORMATS = [
  { mime: 'video/mp4;codecs=avc1,mp4a.40.2', ext: 'mp4', label: 'MP4 (H.264)' },
  { mime: 'video/webm;codecs=vp9,opus', ext: 'webm', label: 'WebM (VP9)' },
  { mime: 'video/webm;codecs=vp8,opus', ext: 'webm', label: 'WebM (VP8)' },
  { mime: 'video/webm', ext: 'webm', label: 'WebM' },
].filter((f) => MediaRecorder.isTypeSupported(f.mime));

let recorder = null;
let streams = [];
let audioCtx = null;
let chunks = [];
let elapsedMs = 0;
let segmentStart = 0;
let isPaused = false;
let tickHandle = null;
// Wall-clock spans that made it into the video: [{ wallStart, wallEnd, videoStart }], one per pause/resume.
let segments = [];
let logger = null;
let logTarget = null;
// Tab to log: a tab id, 0 for "don't log", or null to pick the most recently used tab.
let preferredTab = Number(new URLSearchParams(location.search).get('tab')) || null;

FORMATS.forEach((f, i) => els.format.add(new Option(f.label, i)));

els.startBtn.addEventListener('click', start);
els.stopBtn.addEventListener('click', stop);
els.pauseBtn.addEventListener('click', togglePause);
els.logTab.addEventListener('change', () => (preferredTab = Number(els.logTab.value)));
window.addEventListener('beforeunload', (e) => {
  if (recorder && recorder.state !== 'inactive') e.preventDefault();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'log-tab' && !recorder) {
    preferredTab = msg.tabId;
    refreshTabs();
  }
});
let refreshTimer;
const refreshSoon = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(refreshTabs, 300); };
chrome.tabs.onCreated.addListener(refreshSoon);
chrome.tabs.onRemoved.addListener(refreshSoon);
chrome.tabs.onUpdated.addListener((id, change) => (change.title || change.url) && refreshSoon());

refreshTabs();
renderRecordings();

async function refreshTabs() {
  if (recorder) return;
  const tabs = (await chrome.tabs.query({}))
    .filter((t) => /^(https?|file):/.test(t.url ?? ''))
    .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
  els.logTab.replaceChildren(
    new Option("Don't log", '0'),
    ...tabs.map((t) => new Option(truncate(t.title || t.url, 70), t.id)),
  );
  const wanted = preferredTab === 0 ? null : tabs.find((t) => t.id === preferredTab) ?? tabs[0];
  els.logTab.value = wanted ? String(wanted.id) : '0';
}

async function start() {
  const format = FORMATS[els.format.value];
  els.startBtn.disabled = true;
  els.options.classList.add('disabled');
  try {
    await startCapture(format);
  } finally {
    els.startBtn.disabled = false;
    if (!recorder) els.options.classList.remove('disabled');
  }
}

async function startCapture(format) {
  const notes = [];

  // Attach before capture starts: the "is debugging this browser" bar resizes the page, and that
  // must happen before the capture size is locked in.
  const tabId = Number(els.logTab.value);
  logger = null;
  logTarget = null;
  if (tabId) {
    try {
      const tab = await chrome.tabs.get(tabId);
      logger = new DevtoolsLogger(tabId);
      await logger.start();
      logger.ondetach = (reason) => setStatus(`Recording… (console/network logging stopped: ${reason.replaceAll('_', ' ')})`);
      logTarget = { title: tab.title, url: tab.url };
    } catch (err) {
      logger = null;
      notes.push(`console/network logging unavailable: ${err.message}`);
    }
  }

  let display;
  try {
    display = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: els.systemAudio.checked,
      systemAudio: 'include',
      selfBrowserSurface: 'exclude',
    });
  } catch (err) {
    await stopLogger();
    setStatus(err.name === 'NotAllowedError' ? 'Cancelled.' : `Could not start capture: ${err.message}`);
    return;
  }
  const displayVideo = display.getVideoTracks()[0];

  let mic = null;
  if (els.mic.checked) {
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (err) {
      notes.push(`microphone unavailable: ${err.name}`);
    }
  }
  if (els.systemAudio.checked && !display.getAudioTracks().length) {
    notes.push('no system audio: share a tab, or tick "Share audio" in the picker');
  }

  streams = [display, mic].filter(Boolean);
  setStatus('Starting…');
  const video = await fixedSizeVideoTrack(displayVideo);
  if (displayVideo.readyState === 'ended') {
    releaseStreams();
    await stopLogger();
    setStatus('Sharing stopped before recording started.');
    return;
  }
  const stream = buildStream(video, display, mic);
  streams.push(stream);

  try {
    recorder = new MediaRecorder(stream, {
      mimeType: format.mime,
      videoBitsPerSecond: 5_000_000,
      // Without this Chrome emits a keyframe only every ~100 frames, and screen capture only
      // produces frames when something changes, so keyframes can be minutes apart and seeking
      // gets slow or lands on garbage until the next keyframe.
      videoKeyFrameIntervalDuration: 2000,
    });
  } catch (err) {
    releaseStreams();
    await stopLogger();
    setStatus(`Could not start recorder (${err.message}). Try another format.`);
    return;
  }
  chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = () => finish(format);
  recorder.start(1000);

  // Chrome's own "Stop sharing" bar ends the video track.
  displayVideo.addEventListener('ended', stop);

  els.preview.srcObject = stream;
  els.preview.muted = true;
  els.preview.classList.add('live');
  els.preview.play();

  elapsedMs = 0;
  isPaused = false;
  segmentStart = Date.now();
  segments = [{ wallStart: segmentStart, wallEnd: null, videoStart: 0 }];
  tickHandle = setInterval(renderTimer, 250);
  renderTimer();

  setUi('recording');
  if (logTarget) notes.unshift(`logging “${truncate(logTarget.title, 40)}”`);
  setStatus(notes.length ? `Recording… (${notes.join('; ')})` : 'Recording…');
}

// Chrome's MP4 writer stores the H.264 frame size (SPS/PPS) of the first frame only. When the captured
// surface changes size, the encoder restarts at the new size and every later frame is decoded with the
// wrong one: grey blocky smears and a decode error after a second or so. Tab and window capture often
// send one frame at CSS-pixel size before switching to device pixels (display scaling), and windows
// get resized. So the recorder gets frames of one size only: wait for the source size to settle,
// lock it, and scale any later frame of a different size into that box (letterboxed).
async function fixedSizeVideoTrack(track) {
  if (!('MediaStreamTrackProcessor' in window)) return track;

  const processor = new MediaStreamTrackProcessor({ track });
  const generator = new MediaStreamTrackGenerator({ kind: 'video' });
  let box = null;
  let size = null;
  let settleTimer;
  let deadlinePassed = false;
  let canvas, ctx, onLocked;
  const locked = new Promise((resolve) => (onLocked = resolve));
  const lock = () => {
    if (box || !size) return;
    box = size;
    onLocked();
  };
  setTimeout(() => { deadlinePassed = true; lock(); }, 2000); // a source that keeps changing gets locked anyway
  track.addEventListener('ended', onLocked);

  processor.readable.pipeThrough(new TransformStream({
    transform(frame, controller) {
      const w = frame.displayWidth;
      const h = frame.displayHeight;
      if (!box) {
        if (!size || size.width !== w || size.height !== h) {
          size = { width: w, height: h };
          clearTimeout(settleTimer);
          settleTimer = setTimeout(lock, 500);
        }
        if (deadlinePassed) lock();
        controller.enqueue(frame);
        return;
      }
      if (w === box.width && h === box.height) {
        controller.enqueue(frame);
        return;
      }
      if (!canvas) {
        canvas = new OffscreenCanvas(box.width, box.height);
        ctx = canvas.getContext('2d');
      }
      const scale = Math.min(box.width / w, box.height / h);
      const dw = Math.round(w * scale);
      const dh = Math.round(h * scale);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, box.width, box.height);
      ctx.drawImage(frame, (box.width - dw) / 2, (box.height - dh) / 2, dw, dh);
      const out = new VideoFrame(canvas, { timestamp: frame.timestamp });
      frame.close();
      controller.enqueue(out);
    },
  })).pipeTo(generator.writable).catch(() => {});

  await locked;
  return generator;
}

// Mix display audio and mic into one track — MediaRecorder only records the first audio track.
function buildStream(video, display, mic) {
  const tracks = [video];
  const audioSources = [display, mic].filter((s) => s && s.getAudioTracks().length);

  if (audioSources.length === 1) {
    tracks.push(...audioSources[0].getAudioTracks());
  } else if (audioSources.length > 1) {
    audioCtx = new AudioContext();
    const dest = audioCtx.createMediaStreamDestination();
    audioSources.forEach((s) => audioCtx.createMediaStreamSource(s).connect(dest));
    tracks.push(...dest.stream.getAudioTracks());
  }
  return new MediaStream(tracks);
}

function togglePause() {
  const now = Date.now();
  if (recorder.state === 'recording') {
    recorder.pause();
    isPaused = true;
    elapsedMs += now - segmentStart;
    segments.at(-1).wallEnd = now;
    setUi('paused');
    setStatus('Paused.');
  } else if (recorder.state === 'paused') {
    recorder.resume();
    isPaused = false;
    segmentStart = now;
    segments.push({ wallStart: now, wallEnd: null, videoStart: elapsedMs });
    setUi('recording');
    setStatus('Recording…');
  }
}

function stop() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
}

async function stopLogger() {
  const result = logger ? await logger.stop() : null;
  logger = null;
  return result;
}

async function finish(format) {
  const now = Date.now();
  if (!isPaused) elapsedMs += now - segmentStart;
  segments.at(-1).wallEnd ??= now;
  recorder = null;
  clearInterval(tickHandle);
  renderTimer();
  releaseStreams();
  els.preview.srcObject = null;
  els.preview.classList.remove('live');
  setUi('idle');
  els.startBtn.disabled = true;
  setStatus('Saving…');

  try {
    const logs = await stopLogger();
    const blob = new Blob(chunks, { type: format.mime.split(';')[0] });
    chunks = [];
    const { console: consoleEntries, network } = placeOnTimeline(logs);
    const meta = {
      id: crypto.randomUUID(),
      createdAt: segments[0].wallStart,
      title: logTarget?.title || 'Screen recording',
      pageUrl: logTarget?.url ?? null,
      durationMs: elapsedMs,
      size: blob.size,
      mime: blob.type,
      ext: format.ext,
      logged: Boolean(logs),
      detachReason: logs?.detachReason ?? null,
      consoleCount: consoleEntries.length,
      errorCount: consoleEntries.filter((e) => e.level === 'error').length,
      networkCount: network.length,
      failedCount: network.filter(isFailed).length,
    };
    await RecordingsDB.save(meta, { video: blob, console: consoleEntries, network, segments });
    await chrome.tabs.create({ url: `player.html?id=${meta.id}` });
    setStatus(`Saved — ${formatSize(blob.size)}. Opened it in the player.`);
    renderRecordings();
  } catch (err) {
    setStatus(`Could not save the recording: ${err.message}`);
  } finally {
    els.startBtn.disabled = false;
    els.options.classList.remove('disabled');
    refreshTabs();
  }
}

// Convert wall-clock times into video time (ms), skipping paused spans. Entries from before the
// recording started (e.g. console messages replayed when logging attached) are dropped.
function placeOnTimeline(logs) {
  if (!logs) return { console: [], network: [] };
  const toVideo = (wall) => {
    if (wall == null || wall < segments[0].wallStart) return null;
    for (const s of segments) {
      if (wall < s.wallStart) return s.videoStart; // happened while paused
      if (wall <= s.wallEnd) return s.videoStart + (wall - s.wallStart);
    }
    return elapsedMs;
  };
  const consoleEntries = logs.console
    .map((e) => ({ ...e, t: toVideo(e.wall) }))
    .filter((e) => e.t !== null)
    .sort((a, b) => a.t - b.t);
  const network = logs.network
    .map((e) => ({ ...e, t: toVideo(e.wall), tResponse: toVideo(e.responseWall), tEnd: toVideo(e.endWall) }))
    .filter((e) => e.t !== null)
    .sort((a, b) => a.t - b.t);
  return { console: consoleEntries, network };
}

function isFailed(e) {
  return Boolean(e.failed && !e.canceled) || e.status >= 400;
}

function releaseStreams() {
  streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  streams = [];
  audioCtx?.close();
  audioCtx = null;
}

async function renderRecordings() {
  const list = await RecordingsDB.list().catch(() => []);
  els.recordings.replaceChildren(...list.map((m) => {
    const li = document.createElement('li');
    const info = document.createElement('div');
    const title = document.createElement('a');
    title.href = `player.html?id=${m.id}`;
    title.target = '_blank';
    title.textContent = m.title;
    const details = document.createElement('small');
    const parts = [new Date(m.createdAt).toLocaleString(), formatDuration(m.durationMs), formatSize(m.size)];
    if (m.logged) parts.push(`${m.consoleCount} console (${m.errorCount} errors)`, `${m.networkCount} requests (${m.failedCount} failed)`);
    details.textContent = parts.join(' · ');
    info.append(title, details);
    const del = document.createElement('button');
    del.textContent = 'Delete';
    del.addEventListener('click', async () => {
      if (!confirm(`Delete “${m.title}”?`)) return;
      await RecordingsDB.remove(m.id);
      renderRecordings();
    });
    li.append(info, del);
    return li;
  }));
  $('recordingsSection').hidden = !list.length;
}

function setUi(state) {
  const active = state !== 'idle';
  document.body.classList.toggle('recording', state === 'recording');
  document.body.classList.toggle('paused', state === 'paused');
  els.options.classList.toggle('disabled', active);
  els.startBtn.hidden = active;
  els.pauseBtn.hidden = !active;
  els.stopBtn.hidden = !active;
  els.pauseBtn.textContent = state === 'paused' ? 'Resume' : 'Pause';

  const badge = { recording: 'REC', paused: '❚❚', idle: '' }[state];
  chrome.action.setBadgeText({ text: badge });
  chrome.action.setBadgeBackgroundColor({ color: state === 'paused' ? '#f59e0b' : '#dc2626' });
  document.title = active ? `● ${badge} – Screen Recorder` : 'Screen Recorder';
}

function renderTimer() {
  els.timer.textContent = formatDuration(elapsedMs + (recorder?.state === 'recording' ? Date.now() - segmentStart : 0));
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const hh = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
}

function formatSize(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function setStatus(text) {
  els.status.textContent = text;
}

function truncate(text, n) {
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
}
