const $ = (id) => document.getElementById(id);
const els = {
  title: $('title'),
  subtitle: $('subtitle'),
  video: $('video'),
  playBtn: $('playBtn'),
  slider: $('slider'),
  markers: $('markers'),
  time: $('time'),
  speed: $('speed'),
  filter: $('filter'),
  netType: $('netType'),
  failedOnly: $('failedOnly'),
  follow: $('follow'),
  consoleList: $('consoleList'),
  networkList: $('networkList'),
  consoleCount: $('consoleCount'),
  networkCount: $('networkCount'),
  empty: $('empty'),
  presetChips: $('presetChips'),
};

const ICONS = { error: '✖', warn: '⚠', info: 'ℹ', debug: '·', log: '', nav: '➜' };
const KNOWN_TYPES = ['XHR', 'Fetch', 'Document', 'Script', 'Stylesheet', 'Image', 'Media', 'Font'];

let rec = null;
let durationS = 0;
let activeTab = 'console';
let scrubbing = false;
const filterText = { console: '', network: '' };
const lists = {
  console: { el: els.consoleList, rows: [], current: null },
  network: { el: els.networkList, rows: [], current: null },
};

init().catch((err) => showError(`Could not open the recording: ${err.message}`));

async function init() {
  const id = new URLSearchParams(location.search).get('id');
  rec = id ? await RecordingsDB.get(id) : null;
  if (!rec) return showError('Recording not found. It may have been deleted.');
  const { meta } = rec;

  document.title = `${meta.title} – Recording`;
  els.title.textContent = meta.title;
  els.subtitle.textContent = [
    new Date(meta.createdAt).toLocaleString(),
    meta.pageUrl,
    !meta.logged && 'console & network were not logged',
    meta.detachReason && `logging stopped early (${meta.detachReason.replaceAll('_', ' ')})`,
  ].filter(Boolean).join(' · ');
  $('exportHar').disabled = !meta.logged;
  $('exportConsole').disabled = !meta.logged;

  durationS = meta.durationMs / 1000;
  els.video.src = URL.createObjectURL(rec.video);
  await once(els.video, 'loadedmetadata');
  // Chrome's WebM recordings have no duration; seeking far ahead makes the browser work it out.
  if (!Number.isFinite(els.video.duration)) {
    els.video.currentTime = 1e101;
    await once(els.video, 'durationchange');
    els.video.currentTime = 0;
  }
  if (Number.isFinite(els.video.duration) && els.video.duration > 0) durationS = els.video.duration;
  els.slider.max = durationS;

  // The video can end a few ms before the recorder's clock does; keep the last events reachable.
  const endMs = durationS * 1000;
  const clamp = (t) => (t == null ? t : Math.min(t, endMs));
  rec.console.forEach((e) => (e.t = clamp(e.t)));
  rec.network.forEach((e) => Object.assign(e, { t: clamp(e.t), tResponse: clamp(e.tResponse), tEnd: clamp(e.tEnd) }));

  buildConsole();
  buildNetwork();
  renderCounts();
  renderMarkers();
  wire();
  setupSplitter();
  applyFilters();
  loadPresets();
}

// ---- resizable video / log panels ----

// Side by side, the divider sets the video column's share of the width; stacked (narrow window),
// it sets the video height. Both are remembered for the next recording opened in this browser.
function setupSplitter() {
  const app = $('app');
  const bar = $('splitter');
  const narrow = matchMedia('(max-width: 960px)');
  const DEFAULT_SPLIT = 1 / 2.4; // matches the 1fr / 1.4fr columns in player.css
  let split = Number(readPref('player.split')) || null;
  let videoHeight = Number(readPref('player.videoHeight')) || null;

  const apply = () => {
    const stacked = narrow.matches;
    app.style.gridTemplateColumns = !stacked && split ? `minmax(240px, ${split}fr) 8px minmax(320px, ${1 - split}fr)` : '';
    els.video.style.height = stacked && videoHeight ? `${videoHeight}px` : '';
    els.video.style.maxHeight = stacked && videoHeight ? 'none' : '';
    bar.setAttribute('aria-orientation', stacked ? 'horizontal' : 'vertical');
    bar.setAttribute('aria-valuenow', String(Math.round((split ?? DEFAULT_SPLIT) * 100)));
    if (els.follow.checked) scrollToCurrent();
  };
  const setSplit = (value) => {
    split = Math.min(0.85, Math.max(0.15, value));
    writePref('player.split', split);
    apply();
  };
  const setVideoHeight = (value) => {
    videoHeight = Math.round(Math.min(innerHeight * 0.9, Math.max(120, value)));
    writePref('player.videoHeight', videoHeight);
    apply();
  };

  bar.addEventListener('pointerdown', (down) => {
    down.preventDefault();
    bar.setPointerCapture(down.pointerId);
    document.body.classList.add('resizing');
    const stacked = narrow.matches;
    document.body.classList.toggle('stacked', stacked);
    const width = app.getBoundingClientRect().width - bar.offsetWidth;
    const startSplit = document.querySelector('.stage').getBoundingClientRect().width / width;
    const startHeight = els.video.getBoundingClientRect().height;
    const move = (ev) => {
      if (stacked) setVideoHeight(startHeight + ev.clientY - down.clientY);
      else setSplit(startSplit + (ev.clientX - down.clientX) / width);
    };
    const up = () => {
      document.body.classList.remove('resizing');
      bar.removeEventListener('pointermove', move);
    };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', up, { once: true });
    bar.addEventListener('pointercancel', up, { once: true });
  });

  bar.addEventListener('dblclick', () => {
    split = videoHeight = null;
    writePref('player.split', null);
    writePref('player.videoHeight', null);
    apply();
  });

  bar.addEventListener('keydown', (ev) => {
    const step = ev.shiftKey ? 5 : 1;
    if (narrow.matches) {
      const h = els.video.getBoundingClientRect().height;
      if (ev.key === 'ArrowUp') setVideoHeight(h - 20 * step);
      else if (ev.key === 'ArrowDown') setVideoHeight(h + 20 * step);
      else return;
    } else {
      const current = split ?? DEFAULT_SPLIT;
      if (ev.key === 'ArrowLeft') setSplit(current - 0.02 * step);
      else if (ev.key === 'ArrowRight') setSplit(current + 0.02 * step);
      else return;
    }
    ev.preventDefault();
    ev.stopPropagation(); // don't also seek the video
  });

  narrow.addEventListener('change', apply);
  apply();
}

function readPref(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function writePref(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(value));
  } catch {}
}

// ---- building the lists ----

function buildConsole() {
  const frag = document.createDocumentFragment();
  lists.console.rows = rec.console.map((e) => {
    const row = el('div', `row con ${e.level}`);
    const [first, ...more] = e.text.split('\n');
    const src = el('span', 'src', shortSource(e.source));
    src.title = e.source ?? '';
    row.append(timeButton(e.t), el('span', 'icon', ICONS[e.level] ?? ''), el('span', 'msg', first), src);
    const r = { el: row, item: e, t: e.t, search: `${e.text} ${e.source ?? ''}`.toLowerCase() };
    const extra = [more.join('\n'), e.stack].filter(Boolean).join('\n');
    if (extra) {
      row.classList.add('expandable');
      row.addEventListener('click', () => toggleDetails(r, () => {
        const d = el('div', 'details');
        d.append(el('pre', '', extra));
        return d;
      }));
    }
    frag.append(row);
    return r;
  });
  els.consoleList.append(frag);
}

function buildNetwork() {
  const frag = document.createDocumentFragment();
  lists.network.rows = rec.network.map((e) => {
    const row = el('div', `row net${isBad(e) ? ' bad' : ''}`);
    const url = safeUrl(e.url);
    const name = el('span', '', url ? (url.pathname.split('/').filter(Boolean).pop() ?? '') + url.search || url.host : e.url);
    if (url) name.append(el('span', 'host', ` ${url.host}`));
    name.title = e.url;
    const status = el('span');
    row.append(
      timeButton(e.t),
      el('span', '', e.method),
      status,
      name,
      el('span', '', e.type),
      el('span', 'num', e.size != null ? formatBytes(e.size) : ''),
      el('span', 'num', e.endWall != null ? formatMs(e.endWall - e.wall) : ''),
    );
    const r = { el: row, item: e, t: e.t, statusEl: status, search: `${e.method} ${e.url} ${e.status ?? ''} ${e.failed ?? ''} ${e.type} ${e.mimeType ?? ''}`.toLowerCase() };
    row.addEventListener('click', () => toggleDetails(r, networkDetails));
    frag.append(row);
    return r;
  });
  els.networkList.append(frag);
}

function timeButton(t) {
  const b = el('button', 't', formatTime(t));
  b.title = 'Jump to this moment';
  b.addEventListener('click', (ev) => {
    ev.stopPropagation();
    seek(t / 1000);
  });
  return b;
}

function toggleDetails(r, build) {
  if (getSelection().toString()) return; // selecting text, not toggling
  if (r.details) {
    r.details.remove();
    r.details = null;
    r.el.classList.remove('open');
    return;
  }
  r.details = build(r.item);
  r.el.after(r.details);
  r.el.classList.add('open');
}

function networkDetails(e) {
  const d = el('div', 'details');
  d.append(el('h3', '', 'General'), table([
    ['URL', e.url],
    ['Method', e.method],
    ['Status', e.failed ? `${e.failed}${e.canceled ? ' (canceled)' : ''}` : e.status != null ? `${e.status} ${e.statusText ?? ''}` : 'no response while recording'],
    ['Type', e.type],
    ['MIME type', e.mimeType],
    ['Protocol', e.protocol],
    ['Remote address', e.remote],
    ['Started', `${formatTime(e.t)} into the video (${new Date(e.wall).toLocaleTimeString()})`],
    ['Duration', e.endWall != null ? formatMs(e.endWall - e.wall) : 'did not finish while recording'],
    ['Transferred', e.size != null ? formatBytes(e.size) : undefined],
    ['Served from', e.fromServiceWorker ? 'service worker' : e.fromCache ? 'cache' : undefined],
    ['Initiator', e.initiator],
  ]));
  if (e.requestHeaders) d.append(el('h3', '', 'Request headers'), table(sortedEntries(e.requestHeaders)));
  if (e.postData) d.append(el('h3', '', 'Request payload'), el('pre', '', pretty(e.postData)));
  if (e.responseHeaders) d.append(el('h3', '', 'Response headers'), table(sortedEntries(e.responseHeaders)));
  if (e.body != null) d.append(el('h3', '', `Response body${e.bodyTruncated ? ' (first 256 KB)' : ''}`), el('pre', '', pretty(e.body)));

  const buttons = el('div', 'buttons');
  buttons.append(copyButton('Copy URL', () => e.url), copyButton('Copy as cURL', () => toCurl(e)));
  d.append(buttons);
  return d;
}

function copyButton(label, text) {
  const b = el('button', '', label);
  b.addEventListener('click', async () => {
    await navigator.clipboard.writeText(text());
    b.textContent = 'Copied';
    setTimeout(() => (b.textContent = label), 1200);
  });
  return b;
}

function table(rows) {
  const t = document.createElement('table');
  for (const [k, v] of rows) {
    if (v == null || v === '') continue;
    const tr = t.insertRow();
    tr.insertCell().textContent = k;
    tr.insertCell().textContent = v;
  }
  return t;
}

function renderCounts() {
  const errors = rec.console.filter((e) => e.level === 'error').length;
  const failed = rec.network.filter(isBad).length;
  els.consoleCount.replaceChildren(String(rec.console.length));
  if (errors) els.consoleCount.append(' · ', el('span', 'bad', `${errors} ✖`));
  els.networkCount.replaceChildren(String(rec.network.length));
  if (failed) els.networkCount.append(' · ', el('span', 'bad', `${failed} failed`));
}

function renderMarkers() {
  const marks = [
    ...rec.console.filter((e) => e.level === 'error' || e.level === 'warn').map((e) => [e.t, e.level]),
    ...rec.network.filter(isBad).map((e) => [e.t, 'error']),
  ];
  els.markers.replaceChildren(...marks.map(([t, level]) => {
    const m = el('div', `marker ${level}`);
    m.style.left = `${Math.min(100, (t / 1000 / durationS) * 100)}%`;
    return m;
  }));
}

// ---- playback sync ----

function wire() {
  const v = els.video;
  els.playBtn.addEventListener('click', togglePlay);
  v.addEventListener('click', togglePlay);
  v.addEventListener('play', () => { renderPlayButton(); requestAnimationFrame(loop); });
  v.addEventListener('pause', () => { renderPlayButton(); sync(); });
  v.addEventListener('ended', renderPlayButton);
  v.addEventListener('seeked', sync);
  v.addEventListener('timeupdate', () => v.paused && sync());

  els.slider.addEventListener('input', () => {
    scrubbing = true;
    seek(Number(els.slider.value));
  });
  els.slider.addEventListener('change', () => (scrubbing = false));
  els.speed.addEventListener('change', () => (v.playbackRate = Number(els.speed.value)));

  document.querySelectorAll('[role="tab"]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  els.filter.addEventListener('input', () => {
    filterText[activeTab] = els.filter.value;
    applyFilters();
  });
  $('savePreset').addEventListener('click', () => openPresetDialog(filterText.network.trim()));
  $('editPresets').addEventListener('click', () => openPresetDialog());
  $('addPreset').addEventListener('click', () => {
    $('presetRows').append(presetRow({ name: '', filter: '' }));
    $('presetRows').lastElementChild.querySelector('input').focus();
  });
  $('presetDialog').addEventListener('close', () => $('presetDialog').returnValue === 'save' && savePresetDialog());
  els.netType.addEventListener('change', applyFilters);
  els.failedOnly.addEventListener('change', applyFilters);
  document.querySelectorAll('[data-level]').forEach((c) => c.addEventListener('change', applyFilters));
  els.follow.addEventListener('change', () => els.follow.checked && scrollToCurrent());
  // Scrolling the list yourself turns following off, so playback doesn't yank it back.
  [els.consoleList, els.networkList].forEach((l) => l.addEventListener('wheel', () => (els.follow.checked = false), { passive: true }));

  document.addEventListener('keydown', (ev) => {
    if (ev.target.closest('input, select, textarea, button, dialog') || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (ev.key === ' ' || ev.key === 'k') { ev.preventDefault(); togglePlay(); }
    if (ev.key === 'ArrowLeft') { ev.preventDefault(); seek(v.currentTime - (ev.shiftKey ? 5 : 1)); }
    if (ev.key === 'ArrowRight') { ev.preventDefault(); seek(v.currentTime + (ev.shiftKey ? 5 : 1)); }
  });

  $('downloadVideo').addEventListener('click', () => download(rec.video, `${baseName()}.${rec.meta.ext}`));
  $('exportHar').addEventListener('click', () => download(new Blob([JSON.stringify(toHar(), null, 2)], { type: 'application/json' }), `${baseName()}.har`));
  $('exportConsole').addEventListener('click', () => download(new Blob([consoleText()], { type: 'text/plain' }), `${baseName()}-console.txt`));
}

function togglePlay() {
  const v = els.video;
  if (v.paused) {
    if (v.ended || v.currentTime >= durationS - 0.05) v.currentTime = 0;
    v.play();
  } else {
    v.pause();
  }
}

function renderPlayButton() {
  const playing = !els.video.paused;
  els.playBtn.textContent = playing ? '❚❚' : '▶';
  els.playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
}

function seek(seconds) {
  els.video.currentTime = Math.max(0, Math.min(seconds, durationS));
  sync();
}

function loop() {
  sync();
  if (!els.video.paused) requestAnimationFrame(loop);
}

function sync() {
  const now = els.video.currentTime * 1000;
  if (!scrubbing) els.slider.value = els.video.currentTime;
  els.time.textContent = `${formatTime(now)} / ${formatTime(durationS * 1000)}`;

  for (const [kind, list] of Object.entries(lists)) {
    let current = null;
    for (const r of list.rows) {
      const future = r.t > now + 1;
      if (r.future !== future) {
        r.future = future;
        r.el.classList.toggle('future', future);
      }
      if (!future && !r.hidden) current = r;
      if (r.statusEl) {
        const s = statusAt(r.item, now);
        if (s !== r.status) {
          r.status = s;
          r.statusEl.textContent = s;
          r.statusEl.className = s === 'pending' ? 'pending' : '';
        }
      }
    }
    if (current !== list.current) {
      list.current?.el.classList.remove('current');
      current?.el.classList.add('current');
      list.current = current;
      if (kind === activeTab && els.follow.checked) scrollToCurrent();
    }
  }
}

function scrollToCurrent() {
  lists[activeTab].current?.el.scrollIntoView({ block: 'nearest' });
}

// A request's status column shows "pending" until playback reaches its response.
function statusAt(e, now) {
  const doneAt = e.tResponse ?? e.tEnd;
  if (e.t <= now + 1 && doneAt != null && doneAt > now + 1) return 'pending';
  if (e.failed) return e.canceled ? '(canceled)' : '(failed)';
  return e.status != null ? String(e.status) : '(pending)';
}

// ---- tabs & filters ----

function showTab(tab) {
  activeTab = tab;
  document.querySelectorAll('[role="tab"]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  document.querySelectorAll('[data-list]').forEach((l) => (l.hidden = l.dataset.list !== tab));
  document.querySelectorAll('[data-for]').forEach((f) => (f.hidden = f.dataset.for !== tab));
  els.filter.value = filterText[tab];
  renderEmpty();
  if (els.follow.checked) scrollToCurrent();
}

// Filter text: every word must match, "-word" excludes, "a|b" matches either (all case-insensitive).
function compileFilter(text) {
  const terms = text.toLowerCase().split(/\s+/).filter((w) => w && w !== '-').map((word) => {
    const exclude = word.startsWith('-');
    const options = (exclude ? word.slice(1) : word).split('|').filter(Boolean);
    return { exclude, options };
  });
  return (search) => terms.every(({ exclude, options }) => options.some((o) => search.includes(o)) !== exclude);
}

function applyFilters() {
  const consoleMatch = compileFilter(filterText.console);
  const levels = new Set([...document.querySelectorAll('[data-level]:checked')].map((c) => c.dataset.level));
  for (const r of lists.console.rows) {
    const level = ['error', 'warn', 'debug'].includes(r.item.level) ? r.item.level : 'info';
    setHidden(r, !levels.has(level) || !consoleMatch(r.search));
  }
  const networkMatch = compileFilter(filterText.network);
  const type = els.netType.value;
  for (const r of lists.network.rows) {
    const t = r.item.type;
    const typeOk = !type || (type === 'other' ? !KNOWN_TYPES.includes(t) : type.split(',').includes(t));
    setHidden(r, !typeOk || (els.failedOnly.checked && !isBad(r.item)) || !networkMatch(r.search));
  }
  lists.console.current = lists.network.current = null;
  document.querySelectorAll('.row.current').forEach((r) => r.classList.remove('current'));
  sync();
  renderEmpty();
  renderPresets();
}

// ---- network filter presets (shared by all player tabs, synced with the Chrome profile) ----

const PRESETS_KEY = 'networkFilterPresets';
const DEFAULT_PRESETS = [
  { name: 'API calls', filter: '/api/' },
  { name: 'No trackers', filter: '-google -doubleclick -facebook -hotjar' },
];
let presets = DEFAULT_PRESETS;

async function loadPresets() {
  try {
    const stored = (await chrome.storage.sync.get(PRESETS_KEY))[PRESETS_KEY];
    if (Array.isArray(stored)) presets = stored;
  } catch {}
  chrome.storage.onChanged.addListener((changes) => {
    if (!changes[PRESETS_KEY]) return;
    presets = changes[PRESETS_KEY].newValue ?? DEFAULT_PRESETS;
    renderPresets();
  });
  renderPresets();
}

function renderPresets() {
  const current = filterText.network.trim();
  els.presetChips.replaceChildren(...presets.map((p) => {
    const match = compileFilter(p.filter);
    const count = lists.network.rows.filter((r) => match(r.search)).length;
    const active = current === p.filter.trim();
    const chip = el('button', 'chip', p.name);
    chip.type = 'button';
    chip.title = `${p.filter}\n${active ? 'Click to clear' : 'Click to filter'}`;
    chip.setAttribute('aria-pressed', String(active));
    chip.append(el('span', 'n', String(count)));
    chip.addEventListener('click', () => setNetworkFilter(active ? '' : p.filter));
    return chip;
  }));
  $('savePreset').disabled = !current || presets.some((p) => p.filter.trim() === current);
}

function setNetworkFilter(text) {
  filterText.network = text;
  if (activeTab === 'network') els.filter.value = text;
  applyFilters();
}

function openPresetDialog(newFilter) {
  const rows = $('presetRows');
  rows.replaceChildren(...presets.map(presetRow));
  if (newFilter != null) rows.append(presetRow({ name: '', filter: newFilter }));
  const dialog = $('presetDialog');
  dialog.showModal();
  (newFilter != null ? rows.lastElementChild.querySelector('input') : rows.querySelector('input'))?.focus();
}

function presetRow(p) {
  const row = el('div', 'preset-row');
  const name = el('input');
  name.type = 'text';
  name.value = p.name;
  name.placeholder = 'Name';
  name.setAttribute('aria-label', 'Preset name');
  const filter = el('input');
  filter.type = 'text';
  filter.value = p.filter;
  filter.placeholder = 'e.g. /api/ -google';
  filter.setAttribute('aria-label', 'Filter text');
  const remove = el('button', 'icon-btn small', '✕');
  remove.type = 'button';
  remove.title = 'Delete preset';
  remove.addEventListener('click', () => row.remove());
  row.append(name, filter, remove);
  return row;
}

async function savePresetDialog() {
  const next = [...$('presetRows').children]
    .map((row) => {
      const [name, filter] = row.querySelectorAll('input');
      return { name: name.value.trim(), filter: filter.value.trim() };
    })
    .filter((p) => p.filter)
    .map((p) => ({ name: p.name || p.filter, filter: p.filter }));
  presets = next;
  renderPresets();
  try { await chrome.storage.sync.set({ [PRESETS_KEY]: next }); } catch {}
}

function setHidden(r, hidden) {
  r.hidden = Boolean(hidden);
  r.el.classList.toggle('hidden', r.hidden);
  r.details?.classList.toggle('hidden', r.hidden);
}

function renderEmpty() {
  const rows = lists[activeTab].rows;
  let text = '';
  if (!rec.meta.logged) text = 'Console and network were not logged for this recording.';
  else if (!rows.length) text = activeTab === 'console' ? 'No console messages while recording.' : 'No network requests while recording.';
  else if (rows.every((r) => r.hidden)) text = 'Nothing matches the filters.';
  els.empty.textContent = text;
  els.empty.hidden = !text;
}

// ---- exports ----

function toHar() {
  const headers = (h) => Object.entries(h ?? {}).map(([name, value]) => ({ name, value: String(value) }));
  const header = (h, name) => Object.entries(h ?? {}).find(([k]) => k.toLowerCase() === name)?.[1];
  return {
    log: {
      version: '1.2',
      creator: { name: 'Simple Screen Recorder', version: chrome.runtime.getManifest().version },
      pages: [],
      entries: rec.network.map((e) => {
        const wait = e.responseWall != null ? Math.max(0, e.responseWall - e.wall) : 0;
        const receive = e.endWall != null ? Math.max(0, e.endWall - (e.responseWall ?? e.wall)) : 0;
        const url = safeUrl(e.url);
        return {
          startedDateTime: new Date(e.wall).toISOString(),
          time: wait + receive,
          request: {
            method: e.method,
            url: e.url,
            httpVersion: e.protocol ?? '',
            cookies: [],
            headers: headers(e.requestHeaders),
            queryString: url ? [...url.searchParams].map(([name, value]) => ({ name, value })) : [],
            ...(e.postData && { postData: { mimeType: header(e.requestHeaders, 'content-type') ?? '', text: e.postData } }),
            headersSize: -1,
            bodySize: e.postData ? e.postData.length : 0,
          },
          response: {
            status: e.status ?? 0,
            statusText: e.statusText ?? e.failed ?? '',
            httpVersion: e.protocol ?? '',
            cookies: [],
            headers: headers(e.responseHeaders),
            content: { size: e.size ?? 0, mimeType: e.mimeType ?? '', ...(e.body != null && { text: e.body }) },
            redirectURL: header(e.responseHeaders, 'location') ?? '',
            headersSize: -1,
            bodySize: e.size ?? -1,
          },
          cache: {},
          timings: { send: 0, wait, receive },
          _resourceType: e.type?.toLowerCase(),
          ...(e.failed && { _error: e.failed }),
        };
      }),
    },
  };
}

function consoleText() {
  return rec.console.map((e) => {
    const line = `[${formatTime(e.t)}] ${e.level.toUpperCase().padEnd(5)} ${e.text}${e.source ? `  (${e.source})` : ''}`;
    return e.stack ? `${line}\n${e.stack}` : line;
  }).join('\n') + '\n';
}

function toCurl(e) {
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const parts = [`curl ${q(e.url)}`];
  if (e.method !== 'GET' && !(e.method === 'POST' && e.postData)) parts.push(`-X ${e.method}`);
  for (const [k, v] of Object.entries(e.requestHeaders ?? {})) parts.push(`-H ${q(`${k}: ${v}`)}`);
  if (e.postData) parts.push(`--data-raw ${q(e.postData)}`);
  return parts.join(' \\\n  ');
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

function baseName() {
  const d = new Date(rec.meta.createdAt);
  const p = (n) => String(n).padStart(2, '0');
  return `screen-recording-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

// ---- helpers ----

function isBad(e) {
  return Boolean(e.failed && !e.canceled) || e.status >= 400;
}

function el(tag, className = '', text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function once(target, event, timeout = 5000) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeout);
    target.addEventListener(event, () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

function safeUrl(s) {
  try { return new URL(s); } catch { return null; }
}

function shortSource(src) {
  if (!src) return '';
  const m = src.match(/^(.*?)(:\d+)?$/);
  const url = safeUrl(m[1]);
  return url ? `${url.pathname.split('/').filter(Boolean).pop() || url.host}${m[2] ?? ''}` : src;
}

function sortedEntries(obj) {
  return Object.entries(obj).sort(([a], [b]) => a.localeCompare(b));
}

function pretty(text) {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

function formatTime(ms) {
  const s = Math.max(0, ms) / 1000;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
}

function formatMs(ms) {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function showError(text) {
  $('app').replaceChildren(el('p', 'notfound', text));
}
