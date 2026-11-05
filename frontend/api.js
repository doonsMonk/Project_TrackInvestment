// Thin fetch wrapper for the JSON API. Errors surface as ApiError with a readable message.

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the local server. Is it running?');
  }
  if (!res.ok) {
    // 423 = vault locked, 409 = no password set yet: let the app switch to the lock / setup screen.
    if ((res.status === 423 || res.status === 409) && !url.startsWith('/api/auth/')) {
      window.dispatchEvent(new CustomEvent('vault-state', { detail: { status: res.status } }));
    }
    let message = res.statusText || `HTTP ${res.status}`;
    try {
      const data = await res.json();
      if (typeof data.detail === 'string') message = data.detail;
      else if (Array.isArray(data.detail)) {
        message = data.detail.map((d) => `${(d.loc || []).slice(-1)[0]}: ${d.msg}`).join('; ');
      }
    } catch { /* non-JSON error body */ }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return null;
  return res.json();
}

export const api = {
  get: (url) => request('GET', url),
  post: (url, body) => request('POST', url, body ?? {}),
  put: (url, body) => request('PUT', url, body),
  patch: (url, body) => request('PATCH', url, body),
  del: (url) => request('DELETE', url),
};
