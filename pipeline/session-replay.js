import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// Steel's documented /hls endpoint authenticates with steel-api-key. A read-only
// inspection of an existing released session (2026-09-13) confirmed signed MP4
// initialization and M4S segments at fly.storage.tigris.dev. Do not expand this
// allowlist speculatively or forward the Steel key to the storage host.
const PLAYBACK_HOSTS = new Set(['api.steel.dev', 'fly.storage.tigris.dev']);
const RETAIN_MS = 24 * 60 * 60_000;
const MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;
const MAX_RESOURCES = 10_000;
const assets = {
  player: [new URL('./replay-player.html', import.meta.url), 'text/html; charset=utf-8'],
  'player.js': [new URL('./replay-player.js', import.meta.url), 'text/javascript; charset=utf-8'],
  'hls.js': [new URL('./node_modules/hls.js/dist/hls.min.js', import.meta.url), 'text/javascript; charset=utf-8'],
};

function headers(res) {
  res.setHeader('cache-control', 'private, no-store');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-content-type-options', 'nosniff');
}
function fail(res, status, message) {
  if (res.headersSent) { res.destroy(); return; }
  headers(res);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}

export function recordingMediaUrl(value, sessionId, base) {
  const url = new URL(value, base);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !PLAYBACK_HOSTS.has(url.hostname)) {
    throw new Error('Unsupported recording source');
  }
  if (url.hostname === 'api.steel.dev' && !url.pathname.startsWith(`/v1/sessions/${encodeURIComponent(sessionId)}/`)) {
    throw new Error('Recording source belongs to another session');
  }
  for (const name of url.searchParams.keys()) {
    if (/api.?key|^authorization$|^auth$|^token$/i.test(name)) throw new Error('Unexpected recording credentials');
  }
  return url.href;
}

// Every URI becomes an opaque local resource. Neither arbitrary query URLs nor
// session IDs supplied by the browser can turn this into an authenticated proxy.
export function rewritePlaylist(source, register) {
  if (!source.trimStart().startsWith('#EXTM3U')) throw new Error('Recording playlist is not ready');
  return source.split(/\r?\n/).map(line => {
    if (!line.trim()) return line;
    if (!line.startsWith('#')) return register(line.trim());
    return line.replace(/\bURI="([^"]+)"/g, (_match, uri) => `URI="${register(uri)}"`);
  }).join('\n');
}

/** In-memory replay capability registry. No recordings are downloaded or saved. */
export function createReplayService({ apiKey, baseUrl, fetchImpl = fetch, now = Date.now, retainMs = RETAIN_MS } = {}) {
  const entries = new Map();
  const sessions = new Map();
  const assetCache = new Map();
  function prune() {
    for (const [token, entry] of entries) {
      if (now() >= entry.expiresAt) { entries.delete(token); sessions.delete(entry.sessionId); }
    }
  }
  function register({ sessionId, attempt, phase }) {
    if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(sessionId)) return null;
    prune();
    let token = sessions.get(sessionId);
    if (!token) {
      token = randomBytes(24).toString('hex');
      const initial = `https://api.steel.dev/v1/sessions/${encodeURIComponent(sessionId)}/hls`;
      entries.set(token, { sessionId, expiresAt: now() + retainMs, urls: [initial], ids: new Map([[initial, 0]]) });
      sessions.set(sessionId, token);
    }
    const origin = typeof baseUrl === 'function' ? baseUrl() : baseUrl;
    return { sessionId, attempt, phase, url: `${origin}/replays/${token}/player` };
  }
  async function upstream(url, entry, range, signal) {
    for (let redirects = 0; redirects <= 3; redirects++) {
      url = recordingMediaUrl(url, entry.sessionId);
      const auth = new URL(url).hostname === 'api.steel.dev';
      if (auth && !apiKey) throw new Error('Recording access is not configured');
      const response = await fetchImpl(url, {
        headers: { ...(auth ? { 'steel-api-key': apiKey } : {}), ...(range ? { range } : {}) },
        redirect: 'manual', signal,
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw new Error('Recording redirect has no destination');
        url = recordingMediaUrl(location, entry.sessionId, url);
        continue;
      }
      return { response, url };
    }
    throw new Error('Too many recording redirects');
  }
  async function handle(req, res, requestUrl) {
    if (!requestUrl.pathname.startsWith('/replays/')) return false;
    prune();
    const match = /^\/replays\/([a-f0-9]{48})\/(player|player\.js|hls\.js|media\/(\d+))$/.exec(requestUrl.pathname);
    const entry = match && entries.get(match[1]);
    if (!entry) { fail(res, 404, 'This recording link expired or the bridge restarted.'); return true; }
    if (req.method !== 'GET') { fail(res, 405, 'Recording playback uses GET.'); return true; }
    headers(res);
    const route = match[2];
    if (assets[route]) {
      try {
        const [path, contentType] = assets[route];
        if (!assetCache.has(route)) assetCache.set(route, await readFile(path));
        if (route === 'player') res.setHeader('content-security-policy',
          "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; media-src 'self' blob:; img-src 'none'; base-uri 'none'; form-action 'none'");
        res.writeHead(200, { 'content-type': contentType });
        res.end(assetCache.get(route));
      } catch { fail(res, 503, 'Recording player dependency is unavailable. Run npm ci in pipeline.'); }
      return true;
    }
    const resource = entry.urls[Number(match[3])];
    if (!resource) { fail(res, 404, 'Unknown recording resource.'); return true; }
    const range = req.headers.range;
    if (range && !/^bytes=\d*-\d*$/.test(range)) { fail(res, 416, 'Unsupported byte range.'); return true; }
    const controller = new AbortController();
    const disconnect = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', disconnect);
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
      const { response, url } = await upstream(resource, entry, range, signal);
      if (!response.ok) {
        await response.body?.cancel();
        fail(res, [404, 409, 425].includes(response.status) ? 425 : 502,
          'Recording is still processing or unavailable. Try again in a moment.');
        return true;
      }
      const type = response.headers.get('content-type') ?? '';
      if (/mpegurl/i.test(type) || /\/(?:hls|[^/]+\.m3u8)(?:\?|$)/i.test(url)) {
        let text = '';
        let bytes = 0;
        for await (const chunk of response.body) {
          bytes += chunk.byteLength;
          if (bytes > MAX_PLAYLIST_BYTES) throw new Error('Recording playlist is too large');
          text += Buffer.from(chunk).toString('utf8');
        }
        const rewritten = rewritePlaylist(text, source => {
          const resolved = recordingMediaUrl(source, entry.sessionId, url);
          let id = entry.ids.get(resolved);
          if (id === undefined) {
            if (entry.urls.length >= MAX_RESOURCES) throw new Error('Too many recording resources');
            id = entry.urls.push(resolved) - 1;
            entry.ids.set(resolved, id);
          }
          return `/replays/${match[1]}/media/${id}`;
        });
        res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
        res.end(rewritten);
      } else {
        if (!/^(video\/|audio\/|application\/(octet-stream|mp4))/.test(type)) {
          await response.body?.cancel();
          throw new Error('Unsupported recording media');
        }
        const forwarded = { 'content-type': type };
        for (const name of ['content-length', 'content-range', 'accept-ranges']) {
          const value = response.headers.get(name);
          if (value) forwarded[name] = value;
        }
        res.writeHead(response.status, forwarded);
        if (response.body) await pipeline(Readable.fromWeb(response.body), res);
        else res.end();
      }
    } catch {
      // Provider error bodies and exception URLs can contain signed resources.
      if (!controller.signal.aborted) fail(res, 502, 'Recording could not be loaded. Retry in a moment.');
    } finally { res.off('close', disconnect); }
    return true;
  }
  return { register, handle };
}
