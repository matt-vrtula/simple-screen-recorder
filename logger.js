// Collects console output and network traffic from one tab over the Chrome DevTools Protocol.
// All times are wall-clock ms (Date.now() scale) so the recorder can map them onto the video timeline.
const BODY_LIMIT = 256 * 1024;
const BODY_TYPES = new Set(['XHR', 'Fetch']);
const MAX_ENTRIES = 50_000;

class DevtoolsLogger {
  constructor(tabId) {
    this.target = { tabId };
    this.console = [];
    this.network = [];
    this.requests = new Map(); // CDP requestId -> current entry (a redirect starts a new entry)
    this.pendingBodies = new Set();
    this.clockOffset = null; // wall ms minus CDP monotonic ms
    this.detachReason = null;
    this.ondetach = null;
    this.onEvent = this.onEvent.bind(this);
    this.onDetach = this.onDetach.bind(this);
  }

  async start() {
    await chrome.debugger.attach(this.target, '1.3');
    chrome.debugger.onEvent.addListener(this.onEvent);
    chrome.debugger.onDetach.addListener(this.onDetach);
    await Promise.all([
      this.send('Runtime.enable'),
      this.send('Log.enable'),
      this.send('Page.enable'),
      this.send('Network.enable', { maxTotalBufferSize: 100e6, maxResourceBufferSize: 10e6 }),
    ]);
  }

  async stop() {
    chrome.debugger.onEvent.removeListener(this.onEvent);
    // Response bodies can only be read while attached.
    await Promise.race([Promise.allSettled([...this.pendingBodies]), new Promise((r) => setTimeout(r, 3000))]);
    chrome.debugger.onDetach.removeListener(this.onDetach);
    if (!this.detachReason) await chrome.debugger.detach(this.target).catch(() => {});
    return { console: this.console, network: this.network, detachReason: this.detachReason };
  }

  send(method, params) {
    return chrome.debugger.sendCommand(this.target, method, params);
  }

  onDetach(source, reason) {
    if (source.tabId !== this.target.tabId) return;
    this.detachReason = reason;
    this.pushConsole({ level: 'nav', text: `Logging stopped (${reason.replaceAll('_', ' ')})`, wall: Date.now() });
    this.ondetach?.(reason);
  }

  pushConsole(entry) {
    if (this.console.length < MAX_ENTRIES) this.console.push(entry);
  }

  wallFromMonotonic(seconds) {
    return this.clockOffset === null ? Date.now() : seconds * 1000 + this.clockOffset;
  }

  onEvent(source, method, p) {
    if (source.tabId !== this.target.tabId) return;
    switch (method) {
      case 'Runtime.consoleAPICalled': {
        const frame = p.stackTrace?.callFrames?.[0];
        this.pushConsole({
          level: CONSOLE_LEVELS[p.type] ?? 'log',
          text: formatConsoleArgs(p.args),
          wall: p.timestamp,
          source: frame ? `${frame.url}:${frame.lineNumber + 1}` : '',
          stack: ['error', 'assert', 'trace', 'warning'].includes(p.type) ? formatStack(p.stackTrace) : '',
        });
        break;
      }
      case 'Runtime.exceptionThrown': {
        const d = p.exceptionDetails;
        const [first, ...rest] = (d.exception?.description || d.text || 'Uncaught exception').split('\n');
        this.pushConsole({
          level: 'error',
          text: d.exception?.description ? `Uncaught ${first}` : first,
          wall: p.timestamp,
          source: d.url ? `${d.url}:${d.lineNumber + 1}` : '',
          stack: rest.join('\n').trim() || formatStack(d.stackTrace),
        });
        break;
      }
      case 'Log.entryAdded': {
        const e = p.entry;
        this.pushConsole({
          level: { verbose: 'debug', warning: 'warn' }[e.level] ?? e.level,
          text: e.text,
          wall: e.timestamp,
          source: e.url ? `${e.url}${e.lineNumber != null ? `:${e.lineNumber + 1}` : ''}` : e.source,
          stack: formatStack(e.stackTrace),
        });
        break;
      }
      case 'Page.frameNavigated':
        if (!p.frame.parentId) this.pushConsole({ level: 'nav', text: `Navigated to ${p.frame.url}`, wall: Date.now() });
        break;

      case 'Network.requestWillBeSent': {
        if (p.request.url.startsWith('data:')) break;
        this.clockOffset = p.wallTime * 1000 - p.timestamp * 1000;
        const previous = this.requests.get(p.requestId);
        if (previous && p.redirectResponse) {
          this.applyResponse(previous, p.redirectResponse, p.timestamp);
          previous.endWall = this.wallFromMonotonic(p.timestamp);
        }
        if (this.network.length >= MAX_ENTRIES) break;
        const entry = {
          url: p.request.url,
          method: p.request.method,
          type: p.type ?? 'Other',
          wall: p.wallTime * 1000,
          requestHeaders: p.request.headers,
          postData: p.request.postData?.slice(0, BODY_LIMIT),
          initiator: p.initiator?.type,
        };
        this.requests.set(p.requestId, entry);
        this.network.push(entry);
        break;
      }
      case 'Network.responseReceived': {
        const entry = this.requests.get(p.requestId);
        if (!entry) break;
        entry.type = p.type ?? entry.type;
        this.applyResponse(entry, p.response, p.timestamp);
        break;
      }
      case 'Network.requestServedFromCache': {
        const entry = this.requests.get(p.requestId);
        if (entry) entry.fromCache = true;
        break;
      }
      case 'Network.loadingFinished': {
        const entry = this.requests.get(p.requestId);
        if (!entry) break;
        entry.endWall = this.wallFromMonotonic(p.timestamp);
        entry.size = p.encodedDataLength;
        if (BODY_TYPES.has(entry.type) || /json|xml|text\/plain/.test(entry.mimeType ?? '')) this.fetchBody(entry, p.requestId);
        break;
      }
      case 'Network.loadingFailed': {
        const entry = this.requests.get(p.requestId);
        if (!entry) break;
        entry.endWall = this.wallFromMonotonic(p.timestamp);
        entry.failed = p.blockedReason ? `blocked: ${p.blockedReason}` : p.errorText;
        entry.canceled = p.canceled;
        break;
      }
    }
  }

  applyResponse(entry, r, timestamp) {
    entry.responseWall = this.wallFromMonotonic(timestamp);
    entry.status = r.status;
    entry.statusText = r.statusText;
    entry.mimeType = r.mimeType;
    entry.protocol = r.protocol;
    entry.responseHeaders = r.headers;
    entry.remote = r.remoteIPAddress ? `${r.remoteIPAddress}:${r.remotePort}` : undefined;
    if (r.fromDiskCache || r.fromPrefetchCache) entry.fromCache = true;
    if (r.fromServiceWorker) entry.fromServiceWorker = true;
  }

  fetchBody(entry, requestId) {
    const job = this.send('Network.getResponseBody', { requestId })
      .then(({ body, base64Encoded }) => {
        if (base64Encoded) return;
        entry.body = body.slice(0, BODY_LIMIT);
        if (body.length > BODY_LIMIT) entry.bodyTruncated = true;
      })
      .catch(() => {})
      .finally(() => this.pendingBodies.delete(job));
    this.pendingBodies.add(job);
  }
}

const CONSOLE_LEVELS = { error: 'error', assert: 'error', warning: 'warn', info: 'info', debug: 'debug' };

// Roughly what DevTools prints for console arguments, including %s/%d/%o/%c substitutions.
function formatConsoleArgs(args = []) {
  const rest = [...args];
  let head = '';
  if (rest[0]?.type === 'string' && /%[sdifoOc]/.test(rest[0].value)) {
    head = rest.shift().value.replace(/%([sdifoOc])/g, (m, f) => {
      if (!rest.length) return m;
      const arg = rest.shift();
      if (f === 'c') return '';
      if (f === 'd' || f === 'i') return String(Math.trunc(Number(arg.value)));
      if (f === 'f') return String(Number(arg.value));
      return formatRemote(arg);
    });
  }
  return [head, ...rest.map(formatRemote)].filter((s, i) => i > 0 || s !== '').join(' ');
}

function formatRemote(o) {
  if (!o) return '';
  if (o.type === 'string') return o.value;
  if (o.unserializableValue) return o.unserializableValue;
  if (o.type === 'undefined') return 'undefined';
  if (o.subtype === 'null') return 'null';
  if (o.type !== 'object' && o.type !== 'function' && 'value' in o) return String(o.value);
  if (o.subtype === 'error') return o.description;
  if (o.preview) return formatPreview(o.preview);
  return o.description ?? o.type;
}

function formatPreview(p) {
  const isArray = p.subtype === 'array' || p.subtype === 'typedarray';
  const props = (p.properties ?? []).map((x) => {
    const value = x.type === 'string' ? JSON.stringify(x.value) : x.value ?? x.subtype ?? x.type;
    return isArray ? value : `${x.name}: ${value}`;
  });
  const entries = (p.entries ?? []).map((e) => (e.key ? `${formatPreview(e.key)} => ` : '') + formatPreview(e.value));
  const body = [...props, ...entries].join(', ') + (p.overflow ? ', …' : '');
  if (isArray) return `${p.description?.replace(/\(\d+\)$/, '') === 'Array' ? '' : p.description + ' '}[${body}]`;
  if (p.type !== 'object') return p.description ?? '';
  return `${p.description && p.description !== 'Object' ? p.description + ' ' : ''}{${body}}`;
}

function formatStack(stackTrace) {
  if (!stackTrace?.callFrames?.length) return '';
  return stackTrace.callFrames
    .slice(0, 15)
    .map((f) => `    at ${f.functionName || '(anonymous)'} (${f.url}:${f.lineNumber + 1}:${f.columnNumber + 1})`)
    .join('\n');
}
