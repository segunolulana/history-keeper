// db.js — shared IndexedDB layer.
// Used by both background.js (service worker) and dashboard.js (page).
// Everything is persisted immediately; nothing important lives in memory.

const DB_NAME = 'history-keeper';
const DB_VERSION = 1;

export function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // One row per visit. Composite key = [url, visitTime] so re-syncs are idempotent.
      if (!db.objectStoreNames.contains('visits')) {
        const visits = db.createObjectStore('visits', { keyPath: ['url', 'visitTime'] });
        visits.createIndex('byTime', 'visitTime');
      }
      // One row per URL: latest title + counters (handy for stats and dedup).
      if (!db.objectStoreNames.contains('urls')) {
        db.createObjectStore('urls', { keyPath: 'url' });
      }
      // Ledger of open tabs: when each URL was last active. Survives browser kills.
      if (!db.objectStoreNames.contains('tabLedger')) {
        db.createObjectStore('tabLedger', { keyPath: 'url' });
      }
      // Tabs the reaper closed — nothing is ever silently lost.
      if (!db.objectStoreNames.contains('graveyard')) {
        const g = db.createObjectStore('graveyard', { autoIncrement: true });
        g.createIndex('byClosedAt', 'closedAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const out = fn(s);
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

// ---------- visits ----------

export async function putVisits(rows) {
  if (!rows.length) return 0;
  const db = await openDB();
  await tx(db, 'visits', 'readwrite', (s) => rows.forEach((r) => s.put(r)));
  // Update per-URL metadata in a second pass.
  const byUrl = new Map();
  for (const r of rows) {
    const cur = byUrl.get(r.url);
    if (!cur || r.visitTime > cur.lastVisit) {
      byUrl.set(r.url, { url: r.url, title: r.title || (cur && cur.title) || '', lastVisit: r.visitTime });
    }
  }
  await tx(db, 'urls', 'readwrite', (s) => byUrl.forEach((v) => s.put(v)));
  return rows.length;
}

export async function getVisitsSince(sinceMs) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction('visits', 'readonly');
    const idx = t.objectStore('visits').index('byTime');
    const range = sinceMs ? IDBKeyRange.lowerBound(sinceMs) : null;
    const out = [];
    const cur = idx.openCursor(range);
    cur.onsuccess = () => {
      const c = cur.result;
      if (c) { out.push(c.value); c.continue(); } else resolve(out);
    };
    cur.onerror = () => reject(cur.error);
  });
}

export async function countVisits() {
  const db = await openDB();
  return tx(db, 'visits', 'readonly', (s) => s.count()).then((r) => (typeof r === 'number' ? r : r));
}

export async function getStats() {
  const db = await openDB();
  const count = await new Promise((res, rej) => {
    const r = db.transaction('visits').objectStore('visits').count();
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const oldest = await new Promise((res) => {
    const c = db.transaction('visits').objectStore('visits').index('byTime').openCursor();
    c.onsuccess = () => res(c.result ? c.result.value.visitTime : null);
    c.onerror = () => res(null);
  });
  return { count, oldest };
}

// ---------- tab ledger ----------

export async function ledgerTouch(url, title, when = Date.now()) {
  if (!url || url.startsWith('chrome') || url.startsWith('browser')) return;
  const db = await openDB();
  await tx(db, 'tabLedger', 'readwrite', (s) => s.put({ url, title: title || '', lastActive: when }));
}

export async function ledgerGetAll() {
  const db = await openDB();
  return new Promise((res, rej) => {
    const r = db.transaction('tabLedger').objectStore('tabLedger').getAll();
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}

export async function ledgerReplace(entries) {
  const db = await openDB();
  await tx(db, 'tabLedger', 'readwrite', (s) => {
    s.clear();
    entries.forEach((e) => s.put(e));
  });
}

// ---------- graveyard ----------

export async function buryTabs(tabs) {
  if (!tabs.length) return;
  const db = await openDB();
  const now = Date.now();
  await tx(db, 'graveyard', 'readwrite', (s) =>
    tabs.forEach((t) => s.put({ url: t.url, title: t.title || '', lastActive: t.lastActive, closedAt: now }))
  );
}

export async function getGraveyard() {
  const db = await openDB();
  return new Promise((res, rej) => {
    const r = db.transaction('graveyard').objectStore('graveyard').getAll();
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
