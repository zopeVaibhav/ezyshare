// Shared helpers for talking to the local ezyshare daemon.
export const DAEMON = 'http://127.0.0.1:8787';

export async function api(path, options = {}) {
  const res = await fetch(`${DAEMON}${path}`, {
    ...options,
    headers: { 'x-ezyshare': '1', 'content-type': 'application/json', ...(options.headers || {}) },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).error || detail; } catch { /* not json */ }
    throw new Error(detail);
  }
  return res.json();
}

export function sendLink(peerId, url, title) {
  return api('/api/send', { method: 'POST', body: JSON.stringify({ peerId, url, title }) });
}
