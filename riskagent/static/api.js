// Thin client for the same-origin JSON API.

export class ApiError extends Error {
  constructor(message, status = 0, detail = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }
}

async function request(method, path, { body, timeout = 30000, accept = 'json', keepalive = false, signal = null } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let stopped = false;
  if (signal) signal.addEventListener('abort', () => { stopped = true; ctrl.abort(); }, { once: true });
  const headers = { Accept: accept === 'text' ? 'text/markdown, text/plain, */*' : 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  try {
    let res;
    try {
      res = await fetch(path, {
        method, headers, keepalive, signal: ctrl.signal,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      if (e.name === 'AbortError' && stopped) { const err = new ApiError('Stopped waiting for the reply.', 0, 'stopped'); err.stopped = true; throw err; }
      if (e.name === 'AbortError') throw new ApiError(`The server did not respond within ${Math.round(timeout / 1000)} seconds.`, 0);
      throw new ApiError('Could not reach the local server. Check that it is still running.', 0);
    }
    const text = await res.text();
    if (!res.ok) {
      let detail = text;
      try {
        const j = JSON.parse(text);
        detail = j.detail ?? j.error ?? j.message ?? text;
      } catch { /* plain text error */ }
      if (Array.isArray(detail)) detail = detail.map(d => d.msg || JSON.stringify(d)).join('; ');
      else if (detail && typeof detail !== 'string') detail = JSON.stringify(detail);
      throw new ApiError(detail || `${res.status} ${res.statusText}`, res.status, detail);
    }
    if (accept === 'text') return text;
    if (!text) return null;
    try { return JSON.parse(text); } catch { throw new ApiError('The server returned a response that is not JSON.', res.status); }
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (e.name === 'AbortError') throw new ApiError(`The server did not respond within ${Math.round(timeout / 1000)} seconds.`, 0);
    throw new ApiError(e.message || String(e), 0);
  } finally {
    clearTimeout(timer);
  }
}

const enc = encodeURIComponent;
export const CHAT_TIMEOUT_MS = 240000;

export const api = {
  meta: () => request('GET', '/api/meta'),
  searchOrgs: q => request('GET', `/api/orgs/search?q=${enc(q)}`),
  orgYears: orgId => request('GET', `/api/orgs/${enc(orgId)}/years`),
  listEngagements: () => request('GET', '/api/engagements'),
  createEngagement: body => request('POST', '/api/engagements', { body }),
  getEngagement: (id, threadId = null) => request('GET', `/api/engagements/${enc(id)}${threadId ? `?thread_id=${enc(threadId)}` : ''}`),
  progress: id => request('GET', `/api/engagements/${enc(id)}/progress`),
  chat: (id, message, signal, threadId = null, assessmentId = null) => request('POST', `/api/engagements/${enc(id)}/chat`, { body: { message, ...(threadId ? { thread_id: threadId } : {}), ...(assessmentId ? { assessment_id: assessmentId } : {}) }, timeout: CHAT_TIMEOUT_MS, signal }),
  // Threads (UX sandbox; see docs/UX_REQUIREMENTS.md). The real backend answers 404/405 until built.
  createThread: (id, title = null) => request('POST', `/api/engagements/${enc(id)}/threads`, { body: title ? { title } : {} }),
  renameThread: (threadId, title) => request('PUT', `/api/threads/${enc(threadId)}`, { body: { title } }),
  assess: (id, signal) => request('POST', `/api/engagements/${enc(id)}/assess`, { body: {}, timeout: CHAT_TIMEOUT_MS, signal }),
  getAssessment: aid => request('GET', `/api/assessments/${enc(aid)}`),
  evidence: (aid, rowId) => request('GET', `/api/assessments/${enc(aid)}/evidence/${enc(rowId)}`),
  finding: (aid, reportId, ref) => request('GET', `/api/assessments/${enc(aid)}/finding/${enc(reportId)}/${enc(ref)}`),
  decisions: aid => request('GET', `/api/assessments/${enc(aid)}/decisions`),
  putDecision: (aid, rowId, body, opts = {}) =>
    request('PUT', `/api/assessments/${enc(aid)}/decisions/${enc(rowId)}`, { body, ...opts }),
  exportNote: aid => request('GET', `/api/assessments/${enc(aid)}/export`, { accept: 'text', timeout: 60000 }),
  reveal: (id, aid) => request('POST', `/api/engagements/${enc(id)}/reveal`, { body: { assessment_id: aid }, timeout: 60000 }),
  getReveal: async id => {
    try { return await request('GET', `/api/engagements/${enc(id)}/reveal`); } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  },
};
