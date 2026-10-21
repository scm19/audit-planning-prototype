// Manager decisions per assessment version: {disposition, note}. Saves are serialized per row so
// the last edit wins; notes are debounced. Decisions never change the agent's rows.

const NOTE_DEBOUNCE_MS = 700;

export class DecisionStore {
  constructor(api, onChange) {
    this.api = api;
    this.onChange = onChange;
    this.byAid = new Map();
  }

  /** Merge the server's decisions for a version, keeping any local edit that is still pending. */
  load(aid, serverMap) {
    const m = this.byAid.get(aid) || new Map();
    for (const [rowId, d] of Object.entries(serverMap || {})) {
      const cur = m.get(rowId);
      if (cur && (cur.timer || cur.inflight || cur.dirty || cur.status === 'unsaved' || cur.status === 'error')) continue;
      m.set(rowId, {
        disposition: d?.disposition ?? null, note: d?.note ?? '', updated_at: d?.updated_at ?? null,
        status: 'saved', timer: null, inflight: null, dirty: false, error: null,
      });
    }
    this.byAid.set(aid, m);
  }

  get(aid, rowId) {
    return this.byAid.get(aid)?.get(rowId) || { disposition: null, note: '', status: 'idle' };
  }

  all(aid) {
    return this.byAid.get(aid) || new Map();
  }

  entry(aid, rowId) {
    let m = this.byAid.get(aid);
    if (!m) { m = new Map(); this.byAid.set(aid, m); }
    let e = m.get(rowId);
    if (!e) {
      e = { disposition: null, note: '', updated_at: null, status: 'idle', timer: null, inflight: null, dirty: false, error: null };
      m.set(rowId, e);
    }
    return e;
  }

  setDisposition(aid, rowId, disposition) {
    const e = this.entry(aid, rowId);
    e.disposition = disposition;
    e.status = 'unsaved';
    this.onChange(aid, rowId, e);
    return this.flush(aid, rowId);
  }

  setNote(aid, rowId, note) {
    const e = this.entry(aid, rowId);
    if (e.note === note) return;
    e.note = note;
    e.status = 'unsaved';
    this.onChange(aid, rowId, e);
    clearTimeout(e.timer);
    e.timer = setTimeout(() => { e.timer = null; this.flush(aid, rowId); }, NOTE_DEBOUNCE_MS);
  }

  flush(aid, rowId) {
    const e = this.entry(aid, rowId);
    clearTimeout(e.timer);
    e.timer = null;
    if (e.inflight) { e.dirty = true; return e.inflight; }
    e.status = 'saving';
    e.error = null;
    this.onChange(aid, rowId, e);
    const body = { disposition: e.disposition ?? null, note: e.note ?? '' };
    e.inflight = this.api.putDecision(aid, rowId, body)
      .then(saved => {
        e.updated_at = saved?.updated_at || new Date().toISOString();
        if (!e.dirty) e.status = 'saved';
      })
      .catch(err => {
        e.status = 'error';
        e.error = err.message || String(err);
      })
      .finally(() => {
        e.inflight = null;
        this.onChange(aid, rowId, e);
        if (e.dirty) { e.dirty = false; return this.flush(aid, rowId); }
        return undefined;
      });
    return e.inflight;
  }

  pending() {
    const out = [];
    for (const [aid, m] of this.byAid) {
      for (const [rowId, e] of m) {
        if (e.timer || e.inflight || e.dirty || e.status === 'unsaved') out.push([aid, rowId, e]);
      }
    }
    return out;
  }

  async flushAll() {
    await Promise.all(this.pending().map(([aid, rowId]) => this.flush(aid, rowId)));
  }

  /** Best effort on page hide: fire keepalive PUTs for unsaved edits. */
  flushOnUnload() {
    for (const [aid, rowId, e] of this.pending()) {
      if (e.inflight && !e.dirty) continue;
      this.api.putDecision(aid, rowId, { disposition: e.disposition ?? null, note: e.note ?? '' }, { keepalive: true })
        .catch(() => {});
    }
  }
}
