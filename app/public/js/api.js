// API-Client + WebSocket-Push

const listeners = new Set();

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function api(path, { method = 'GET', body, query } = {}) {
  let url = `/api${path}`;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') qs.set(k, v);
    const s = qs.toString();
    if (s) url += `?${s}`;
  }
  const opts = { method, headers: { 'X-Requested-With': 'webmail' }, credentials: 'same-origin' };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, opts);
  } catch (err) {
    throw new ApiError(0, 'Server nicht erreichbar');
  }
  let data = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) data = await res.json();
  if (res.status === 401 && path !== '/login' && path !== '/me') {
    for (const l of listeners) l({ t: 'unauthorized' });
  }
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || `Fehler ${res.status}`);
  return data;
}

export const get = (p, query) => api(p, { query });
export const post = (p, body) => api(p, { method: 'POST', body: body || {} });
export const patch = (p, body) => api(p, { method: 'PATCH', body: body || {} });
export const put = (p, body) => api(p, { method: 'PUT', body: body || {} });
export const del = (p, query) => api(p, { method: 'DELETE', query });

// ------------------------------------------------------------------ Push
let ws = null;
let retry = 1000;
let stopped = true;

export function onEvent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function connectPush() {
  stopped = false;
  const open = () => {
    if (stopped) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      retry = 1000;
      for (const l of listeners) l({ t: 'connected' });
    };
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      for (const l of listeners) l(msg);
    };
    ws.onclose = () => {
      for (const l of listeners) l({ t: 'disconnected' });
      if (stopped) return;
      setTimeout(open, retry);
      retry = Math.min(retry * 2, 30000);
    };
  };
  open();
}

export function disconnectPush() {
  stopped = true;
  if (ws) ws.close();
}
