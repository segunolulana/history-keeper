// db.js — shared IndexedDB layer.
// Used by both background.js (service worker) and dashboard.js (page).
// Everything is persisted immediately; nothing important lives in memory.

const DB_NAME = 'history-keeper';
const DB_VERSION = 3;

// One shared connection per context, reopened if it gets closed.
let dbPromise = null;

export function openDB() {
  if (!dbPromise) {
    dbPromise = connect().catch((e) => { dbPromise = null; throw e; });
  }
  return dbPromise;
}

function connect() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      const upgradeTx = req.transaction;
      // One row per visit. Composite key = [url, visitTime] so re-syncs are idempotent.
      if (!db.objectStoreNames.contains('visits')) {
        const visits = db.createObjectStore('visits', { keyPath: ['url', 'visitTime'] });
        visits.createIndex('byTime', 'visitTime');
      }
      // One row per URL: latest title + counters (handy for stats and dedup).
      if (!db.objectStoreNames.contains('urls')) {
        db.createObjectStore('urls', { keyPath: 'url' });
      }
      // One record per logical tab, kept even while the browser hides the tab
      // from extensions (unloaded tabs on Android). See background.js.
      if (!db.objectStoreNames.contains('tabs')) {
        const tabs = db.createObjectStore('tabs', { keyPath: 'id' });
        // v1 -> v2: convert the old URL-keyed ledger into tab records.
        if (ev.oldVersion >= 1 && db.objectStoreNames.contains('tabLedger')) {
          const r = upgradeTx.objectStore('tabLedger').getAll();
          r.onsuccess = () => {
            for (const e of r.result) {
              tabs.put({
                id: crypto.randomUUID(), url: e.url, title: e.title || '', trail: [],
                firstSeen: e.lastActive, lastActive: e.lastActive, lastSeen: e.lastSeen || e.lastActive,
                source: e.source || 'seeded', pinned: false, removedAt: null, migrated: true,
              });
            }
            db.deleteObjectStore('tabLedger');
          };
        }
      }
      // v3: indexes for history search (visit chains).
      const visitStore = upgradeTx.objectStore('visits');
      if (!visitStore.indexNames.contains('byVisitId')) visitStore.createIndex('byVisitId', 'visitId');
      if (!visitStore.indexNames.contains('byReferrer')) visitStore.createIndex('byReferrer', 'referringVisitId');
      // Tabs the reaper closed — nothing is ever silently lost.
      if (!db.objectStoreNames.contains('graveyard')) {
        const g = db.createObjectStore('graveyard', { autoIncrement: true });
        g.createIndex('byClosedAt', 'closedAt');
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; }; // don't block a newer version's upgrade
      db.onclose = () => { dbPromise = null; };
      resolve(db);
    };
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

// Newest-first text search over the archive. Every whitespace-separated
// term must appear in the title or URL. Optional [from, to) time window.
// Stops after `limit` matches so huge archives stay responsive.
export async function searchVisits({ text = '', from = null, to = null, limit = 200 } = {}) {
  const terms = text.toLowerCase().split(/\s+/).filter(Boolean);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const idx = db.transaction('visits').objectStore('visits').index('byTime');
    let range = null;
    if (from != null && to != null) range = IDBKeyRange.bound(from, to, false, true);
    else if (from != null) range = IDBKeyRange.lowerBound(from);
    else if (to != null) range = IDBKeyRange.upperBound(to, true);
    const out = [];
    let more = false;
    const cur = idx.openCursor(range, 'prev');
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return resolve({ visits: out, more });
      const v = c.value;
      const hay = (v.title + ' ' + v.url).toLowerCase();
      if (terms.every((t) => hay.includes(t))) {
        if (out.length >= limit) { more = true; return resolve({ visits: out, more }); }
        out.push(v);
      }
      c.continue();
    };
    cur.onerror = () => reject(cur.error);
  });
}

export async function getVisitById(visitId) {
  if (!visitId) return null;
  const db = await openDB();
  return new Promise((res, rej) => {
    const r = db.transaction('visits').objectStore('visits').index('byVisitId').get(visitId);
    r.onsuccess = () => res(r.result || null); r.onerror = () => rej(r.error);
  });
}

// Visits whose referrer is `visitId`: the links followed from that page.
export async function getChildVisits(visitId) {
  if (!visitId) return [];
  const db = await openDB();
  return new Promise((res, rej) => {
    const r = db.transaction('visits').objectStore('visits').index('byReferrer').getAll(visitId);
    r.onsuccess = () => res(r.result.sort((a, b) => a.visitTime - b.visitTime));
    r.onerror = () => rej(r.error);
  });
}

// Walk referrers back from `visit`. Returns { crumbs (oldest first, ending
// with `visit`), brokenAt } where brokenAt is set if the chain points at a
// visit that isn't in the archive (e.g. older than the backfill).
export async function getBreadcrumbs(visit, maxSteps = 50) {
  const crumbs = [visit];
  const seen = new Set([visit.visitId]);
  let cur = visit;
  let brokenAt = null;
  for (let i = 0; i < maxSteps && cur.referringVisitId; i++) {
    if (seen.has(cur.referringVisitId)) break; // cycle guard
    const parent = await getVisitById(cur.referringVisitId);
    if (!parent) { brokenAt = cur.referringVisitId; break; }
    seen.add(parent.visitId);
    crumbs.unshift(parent);
    cur = parent;
  }
  return { crumbs, brokenAt };
}

// How many archived visits carry link info (for an honest hint in the UI).
export async function countLinkedVisits() {
  const db = await openDB();
  const os = db.transaction('visits').objectStore('visits');
  const count = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  const [total, withId, withRef] = await Promise.all([
    count(os.count()), count(os.index('byVisitId').count()), count(os.index('byReferrer').count()),
  ]);
  return { total, withId, withRef };
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

// ---------- tab records ----------

export async function tabsGetAll() {
  const db = await openDB();
  return new Promise((res, rej) => {
    const r = db.transaction('tabs').objectStore('tabs').getAll();
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}

export async function tabsWrite(puts = [], deletes = []) {
  const db = await openDB();
  await tx(db, 'tabs', 'readwrite', (s) => {
    puts.forEach((r) => s.put(r));
    deletes.forEach((id) => s.delete(id));
  });
}

// url -> last archived visit time (from the `urls` store, which outlives
// the browser's own ~90-day history retention).
export async function getLastVisits(urls) {
  const db = await openDB();
  const out = new Map();
  await tx(db, 'urls', 'readonly', (s) => {
    for (const u of urls) {
      const r = s.get(u);
      r.onsuccess = () => { if (r.result) out.set(u, r.result.lastVisit); };
    }
  });
  return out;
}

// ---------- graveyard ----------

export async function buryTabs(tabs) {
  if (!tabs.length) return;
  const db = await openDB();
  const now = Date.now();
  await tx(db, 'graveyard', 'readwrite', (s) =>
    tabs.forEach((t) => s.put({
      url: t.url, title: t.title || '', lastActive: t.lastActive, closedAt: now, how: t.how || 'closed',
    }))
  );
}

export async function getGraveyard() {
  const db = await openDB();
  return new Promise((res, rej) => {
    const r = db.transaction('graveyard').objectStore('graveyard').getAll();
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
