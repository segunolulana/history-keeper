// background.js — MV3 service worker.
// Design rule: assume this worker can be killed at any moment (Android will).
// Every event handler persists its state to IndexedDB/storage immediately,
// and every startup reconciles reality (open tabs) against the persistent records.

import {
  putVisits, tabsGetAll, tabsWrite, getLastVisits, buryTabs,
} from './db.js';

const DAY = 24 * 60 * 60 * 1000;
const REMOVED_KEEP = 30 * DAY; // drop records of tabs the browser said were closed after a month
const DEFAULTS = {
  thresholdDays: 90,      // close tabs untouched for this long
  autoClose: false,       // manual mode by default — you approve closures
  keepPinned: true,       // never reap pinned tabs
  syncMinutes: 30,        // history sync cadence
};

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...(settings || {}) };
}

// ---------------------------------------------------------------------------
// Alarms + lifecycle. Alarms persist across restarts and wake the worker.
// ---------------------------------------------------------------------------

// Only create alarms that are missing. Re-creating an alarm resets its timer,
// so recreating the daily one on every browser start (frequent on Android)
// meant it could never fire.
async function ensureAlarms() {
  const s = await getSettings();
  const want = { syncHistory: s.syncMinutes, tabSweep: 60 * 24 };
  for (const [name, periodInMinutes] of Object.entries(want)) {
    const existing = await chrome.alarms.get(name);
    if (!existing || existing.periodInMinutes !== periodInMinutes) {
      await chrome.alarms.create(name, { periodInMinutes });
    }
  }
}

// Belt and braces: the 30-min sync alarm also runs the daily sweep if it is
// overdue, in case the daily alarm or onStartup never fires on this browser.
async function sweepIfDue() {
  const { lastSweep } = await chrome.storage.local.get('lastSweep');
  if (!lastSweep || Date.now() - lastSweep >= DAY) await sweep(false);
}

chrome.runtime.onInstalled.addListener(async () => {
  await ensureAlarms();
  await syncHistory();
  await reconcileTabs();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarms();
  await reconcileTabs();   // recover from browser kill: rebuild by URL
  await syncHistory();
  await sweepIfDue();      // startup sweep (auto-close only if enabled)
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'syncHistory') { await syncHistory(); await sweepIfDue(); }
  if (alarm.name === 'tabSweep') await sweep(false);
});

// Open the dashboard when the toolbar icon is tapped.
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
});

// ---------------------------------------------------------------------------
// HISTORY ARCHIVING
// Chromium expires history at ~90 days; we copy every visit into IndexedDB
// before that happens. Idempotent: keyed by [url, visitTime].
// ---------------------------------------------------------------------------

async function syncHistory() {
  try {
    const { lastSync, visitLinksBackfilled } = await chrome.storage.local.get(['lastSync', 'visitLinksBackfilled']);
    // First run: grab everything still inside the browser's retention window.
    // Overlap re-reads 1h to be safe against clock skew; dedup is free.
    // One-off backfill: visits archived before we stored visit IDs are re-read
    // (same [url, visitTime] key, so they're overwritten, not duplicated).
    const start = visitLinksBackfilled
      ? (lastSync || Date.now() - 95 * DAY) - 60 * 60 * 1000
      : 0;

    const items = await chrome.history.search({
      text: '', startTime: start, endTime: Date.now(), maxResults: 100000,
    });

    const rows = [];
    for (const item of items) {
      const visits = await chrome.history.getVisits({ url: item.url });
      for (const v of visits) {
        if (v.visitTime >= start) {
          const row = {
            url: item.url,
            title: item.title || '',
            visitTime: Math.round(v.visitTime),
            transition: v.transition || '',
          };
          // visitId + referringVisitId link visits into chains: the page you
          // came from (breadcrumbs) and the links you followed from a page.
          // Fields are omitted when absent so the indexes skip the row.
          if (v.visitId && v.visitId !== '0') row.visitId = String(v.visitId);
          if (v.referringVisitId && v.referringVisitId !== '0') row.referringVisitId = String(v.referringVisitId);
          rows.push(row);
        }
      }
    }
    await putVisits(rows);
    await chrome.storage.local.set({ lastSync: Date.now(), visitLinksBackfilled: true });
  } catch (e) {
    console.error('syncHistory failed', e);
  }
}

// ---------------------------------------------------------------------------
// TAB RECORDS
// Some Android browsers (e.g. Quetta) only show *loaded* tabs to extensions;
// tabs restored lazily after a restart are invisible until you open them.
// So we keep one persistent record per logical tab, remember it while it's
// invisible, and show it as stale once it hasn't been visited for the
// threshold. Unloaded stale tabs can't be closed by us, so the user closes
// them in the tab switcher and removes them on the dashboard.
//
// Identity: within a browser session a tab is its tabId (session `bindings`),
// so navigating to another URL in the same tab updates the same record
// (previous pages go into `trail`). After a restart tab IDs change, so a tab
// we haven't seen this session is re-attached to an unbound record with the
// same current URL — unless it was opened as a brand-new tab this session
// (`fresh`), which always gets its own record so it can't take over the
// record of a hidden tab on the same page.
//
// Record: { id, url, title, trail[], firstSeen, lastActive, lastSeen,
//           source: 'observed'|'seeded', pinned, removedAt, migrated? }
// ---------------------------------------------------------------------------

function isTracked(url) {
  return !!url && /^(https?|file|ftp):/i.test(url);
}

// Session state, cleared when the browser restarts:
//   bindings: tabId -> record id      fresh: tabIds opened as new tabs
//   gone:     tabIds already removed  stats: counters for Diagnostics
let memSession = null;
async function loadSession() {
  let s;
  try { ({ sess: s } = await chrome.storage.session.get('sess')); } catch { s = memSession; }
  s = s ? structuredClone(s) : {};
  return { bindings: s.bindings || {}, fresh: s.fresh || {}, gone: s.gone || {}, stats: s.stats || {} };
}
async function saveSession(s) {
  memSession = s;
  try { await chrome.storage.session.set({ sess: s }); } catch { /* memory only */ }
}

// All record mutations run one at a time: tab events arrive in bursts
// (created + updated + activated) and would otherwise race into duplicates.
// Errors are logged here; callers that don't care may ignore the rejection.
let chain = Promise.resolve();
function withRecords(fn) {
  const run = async () => {
    const list = await tabsGetAll();
    const ctx = {
      records: new Map(list.map((r) => [r.id, r])),
      sess: await loadSession(),
      dirty: new Set(), deleted: new Set(), sessChanged: false, seeding: false,
    };
    const out = await fn(ctx);
    const puts = [...ctx.dirty]
      .filter((id) => !ctx.deleted.has(id) && ctx.records.has(id))
      .map((id) => ctx.records.get(id));
    if (puts.length || ctx.deleted.size) await tabsWrite(puts, [...ctx.deleted]);
    if (ctx.sessChanged) await saveSession(ctx.sess);
    return out;
  };
  const p = chain.then(run, run);
  chain = p.catch((e) => console.error('tab records', e));
  return p;
}
const ignore = () => {}; // rejection already logged by withRecords

function bump(ctx, key) {
  ctx.sess.stats[key] = (ctx.sess.stats[key] || 0) + 1;
  ctx.sessChanged = true;
}

// Which of two candidate records a restored tab should re-attach to:
// prefer ones not marked closed, then the most recently visited.
function preferable(a, b) {
  const ka = [a.removedAt ? 0 : 1, a.lastActive];
  const kb = [b.removedAt ? 0 : 1, b.lastActive];
  return ka[0] !== kb[0] ? ka[0] > kb[0] : ka[1] > kb[1];
}

// Find (or create) the record for a live tab and refresh it from the tab.
//   activity: the user is visiting it right now
//   estimate: history/lastAccessed guess (reconcile only; undefined otherwise)
function resolve(ctx, tab, { activity = false, estimate } = {}) {
  const { bindings, fresh, gone } = ctx.sess;
  if (gone[tab.id]) return null; // stale event for a tab that's already closed
  const now = Date.now();
  let rec = ctx.records.get(bindings[tab.id]);
  if (!rec) {
    if (!fresh[tab.id]) {
      const bound = new Set(Object.values(bindings));
      for (const r of ctx.records.values()) {
        if (r.url !== tab.url || bound.has(r.id) || ctx.deleted.has(r.id)) continue;
        if (!rec || preferable(r, rec)) rec = r;
      }
      if (rec) bump(ctx, 'reattached');
    }
    if (!rec) {
      // A tab the browser shows us for the first time was almost always just
      // opened or visited, so it starts at "now". Only the very first
      // reconcile after install/upgrade estimates ages from history.
      const est = ctx.seeding && !fresh[tab.id] ? estimate : null;
      rec = {
        id: crypto.randomUUID(), url: tab.url, title: tab.title || '', trail: [],
        firstSeen: now, lastActive: est || now, lastSeen: now,
        source: est ? 'seeded' : 'observed', pinned: !!tab.pinned, removedAt: null,
      };
      ctx.records.set(rec.id, rec);
      bump(ctx, fresh[tab.id] ? 'newRecordFresh' : 'newRecordOther');
    }
    bindings[tab.id] = rec.id;
    ctx.sessChanged = true;
  }
  if (rec.url !== tab.url) { // navigated within the same tab
    rec.trail = [{ url: rec.url, title: rec.title, at: now }, ...(rec.trail || [])].slice(0, 20);
    rec.url = tab.url;
  }
  if (tab.title) rec.title = tab.title;
  rec.pinned = !!tab.pinned;
  rec.lastSeen = now;
  rec.removedAt = null;
  // Records carried over from the v1 ledger were stamped at install time;
  // re-estimate them once from history.
  if (rec.migrated && estimate !== undefined) {
    if (estimate) { rec.lastActive = estimate; rec.source = 'seeded'; }
    delete rec.migrated;
  }
  if (activity) { rec.lastActive = now; rec.source = 'observed'; delete rec.migrated; }
  ctx.dirty.add(rec.id);
  return rec;
}

async function trackTab(tab, activity) {
  if (!tab || !isTracked(tab.url)) return;
  await withRecords((ctx) => { resolve(ctx, tab, { activity }); }).catch(ignore);
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return; } // tab may already be gone
  await trackTab(tab, true);
});

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (!(change.url || change.status === 'complete' || change.title || change.pinned !== undefined)) return;
  // A navigation or finished load in the tab you're looking at is a visit.
  trackTab(tab, !!tab.active && (!!change.url || change.status === 'complete'));
});

// A tab opened from another tab, or as a blank new tab, is brand new: mark it
// fresh so it never takes over an existing record. A tab created directly
// with a URL and no opener may be a restored one, so it can be re-attached.
// Not counted as a visit: session restore can fire onCreated for every tab.
chrome.tabs.onCreated.addListener((tab) => {
  const isNew = tab.openerTabId != null || !isTracked(tab.pendingUrl || tab.url);
  withRecords((ctx) => {
    bump(ctx, isNew ? 'createdNew' : 'createdWithUrl');
    if (isNew) ctx.sess.fresh[tab.id] = true;
    if (isTracked(tab.url)) resolve(ctx, tab, {});
  }).catch(ignore);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  withRecords((ctx) => {
    const { bindings, fresh, gone } = ctx.sess;
    gone[tabId] = true;
    delete fresh[tabId];
    ctx.sessChanged = true;
    const id = bindings[tabId];
    if (!id) return;
    delete bindings[tabId];
    // Also when a whole window closes. If the browser was quitting instead,
    // restored tabs re-attach by URL, which clears removedAt again.
    const r = ctx.records.get(id);
    if (r) { r.removedAt = Date.now(); ctx.dirty.add(id); }
  }).catch(ignore);
});

chrome.tabs.onReplaced.addListener((added, removed) => {
  withRecords((ctx) => {
    const { bindings, fresh } = ctx.sess;
    if (bindings[removed]) { bindings[added] = bindings[removed]; delete bindings[removed]; }
    if (fresh[removed]) { fresh[added] = true; delete fresh[removed]; }
    ctx.sessChanged = true;
  }).catch(ignore);
});

// Sync records with the tabs the browser currently shows us, and expire old
// records. The tab query runs inside the lock so a tab closed meanwhile
// can't be resurrected.
async function reconcileTabs() {
  const s = await getSettings();
  const { seededV2 } = await chrome.storage.local.get('seededV2');
  return withRecords(async (ctx) => {
    const allTabs = await chrome.tabs.query({});
    const tabs = allTabs.filter((t) => isTracked(t.url));
    const visits = await getLastVisits([...new Set(tabs.map((t) => t.url))]);
    const estimate = (t) => Math.max(visits.get(t.url) || 0, t.lastAccessed || 0) || null;
    ctx.seeding = !seededV2;

    const { bindings, fresh } = ctx.sess;
    const liveAll = new Set(allTabs.map((t) => String(t.id)));
    const liveTracked = new Set(tabs.map((t) => String(t.id)));
    for (const k of Object.keys(bindings)) {
      if (!liveTracked.has(k)) { delete bindings[k]; ctx.sessChanged = true; }
    }
    for (const k of Object.keys(fresh)) {
      if (!liveAll.has(k)) { delete fresh[k]; ctx.sessChanged = true; }
    }
    for (const t of tabs) resolve(ctx, t, { estimate: estimate(t) });

    // Housekeeping:
    // - records of tabs the browser said were closed: dropped after a month
    // - records not seen for 2x the threshold: they've been on the stale list
    //   for at least a full threshold, so assume the tab is gone (logged)
    const now = Date.now();
    const bound = new Set(Object.values(bindings));
    const expired = [];
    for (const r of ctx.records.values()) {
      if (r.removedAt) {
        if (now - r.removedAt > REMOVED_KEEP) ctx.deleted.add(r.id);
      } else if (!bound.has(r.id) && now - (r.lastSeen || 0) > 2 * s.thresholdDays * DAY) {
        expired.push(r);
        ctx.deleted.add(r.id);
      }
    }
    if (expired.length) await buryTabs(expired.map((r) => ({ ...r, how: 'expired' })));
    if (ctx.seeding) await chrome.storage.local.set({ seededV2: true });

    return {
      allTabs,
      tabs,
      bindings: { ...bindings },
      records: [...ctx.records.values()].filter((r) => !ctx.deleted.has(r.id)),
      stats: { ...ctx.sess.stats },
    };
  });
}

// ---------------------------------------------------------------------------
// THE REAPER
// ---------------------------------------------------------------------------

async function findStaleTabs() {
  const s = await getSettings();
  const cutoff = Date.now() - s.thresholdDays * DAY;
  const { tabs, bindings, records } = await reconcileTabs();
  const tabById = new Map(tabs.map((t) => [String(t.id), t]));
  const liveByRec = new Map();
  for (const [tid, rid] of Object.entries(bindings)) {
    const t = tabById.get(tid);
    if (t) liveByRec.set(rid, t);
  }
  const stale = [];
  for (const r of records) {
    if (r.removedAt || r.lastActive >= cutoff) continue;
    const t = liveByRec.get(r.id);
    if (t && t.active) continue;                              // never close the tab in use
    if (s.keepPinned && (t ? t.pinned : r.pinned)) continue;
    stale.push({
      id: r.id, tabId: t ? t.id : null, loaded: !!t,
      url: r.url, title: r.title || r.url,
      lastActive: r.lastActive, source: r.source, trail: (r.trail || []).length,
    });
  }
  stale.sort((a, b) => a.lastActive - b.lastActive);
  return stale;
}

// Loaded tabs are closed one by one (a single bad id would make a batched
// tabs.remove fail entirely); unloaded ones, which we can't close, are
// removed from the list. Only what actually went away is logged and forgotten.
async function closeRecords(items) {
  const done = [];
  let closed = 0, dismissed = 0, failed = 0;
  for (const i of items) {
    if (i.tabId == null) { done.push({ ...i, how: 'dismissed' }); dismissed++; continue; }
    try {
      await chrome.tabs.remove(i.tabId);
      done.push({ ...i, how: 'closed' }); closed++;
    } catch (e) {
      let stillOpen = false;
      try { stillOpen = !!(await chrome.tabs.get(i.tabId)); } catch { /* gone */ }
      if (stillOpen) { failed++; console.error('close failed', i.url, e); }
      else { done.push({ ...i, how: 'already closed' }); closed++; }
    }
  }
  if (done.length) {
    await buryTabs(done);
    const ids = new Set(done.map((i) => i.id));
    await withRecords((ctx) => {
      ids.forEach((id) => ctx.deleted.add(id));
      for (const [tid, rid] of Object.entries(ctx.sess.bindings)) {
        if (ids.has(rid)) { delete ctx.sess.bindings[tid]; ctx.sessChanged = true; }
      }
    });
  }
  return { closed, dismissed, failed };
}

async function sweep(forceManual) {
  const s = await getSettings();
  let stale = await findStaleTabs();
  await chrome.storage.local.set({ lastSweep: Date.now() });
  let closed = 0;
  if (s.autoClose || forceManual) {
    const closable = stale.filter((t) => t.loaded); // can only close what we can see
    if (closable.length) closed = (await closeRecords(closable)).closed;
    stale = await findStaleTabs();
  }
  await setBadge(stale.length);
  return closed;
}

async function setBadge(n) {
  try { await chrome.action.setBadgeText({ text: n ? String(n) : '' }); } catch { /* no badge on some mobile builds */ }
}

// Snapshot for the dashboard's diagnostics panel.
async function getDiagnostics() {
  const now = Date.now();
  const s = await getSettings();
  const { allTabs, bindings, records, stats } = await reconcileTabs();
  const byId = new Map(records.map((r) => [r.id, r]));
  const lastVisits = await getLastVisits([...new Set(allTabs.map((t) => t.url).filter(Boolean))]);
  const alarms = await chrome.alarms.getAll();
  const { lastSweep, lastSync } = await chrome.storage.local.get(['lastSweep', 'lastSync']);
  return {
    now,
    settings: s,
    tabCount: allTabs.length,
    withUrl: allTabs.filter((t) => t.url).length,
    withLastAccessed: allTabs.filter((t) => t.lastAccessed).length,
    recordCount: records.filter((r) => !r.removedAt).length,
    loadedCount: new Set(Object.values(bindings)).size,
    removedCount: records.filter((r) => r.removedAt).length,
    stats,
    lastSweep: lastSweep || null,
    lastSync: lastSync || null,
    alarms: alarms.map((a) => ({ name: a.name, next: a.scheduledTime, period: a.periodInMinutes })),
    tabs: allTabs.map((t) => {
      const r = byId.get(bindings[t.id]);
      return {
        title: t.title || t.url || '(no url)',
        active: !!t.active,
        pinned: !!t.pinned,
        ledger: r ? r.lastActive : null,
        source: r ? r.source + (r.trail && r.trail.length ? ` +${r.trail.length} pages` : '') : null,
        lastAccessed: t.lastAccessed || null,
        history: lastVisits.get(t.url) || null,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Messages from the dashboard page
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'getStaleTabs': {
        const stale = await findStaleTabs();
        await setBadge(stale.length);
        sendResponse(stale);
        break;
      }
      case 'closeTabs':    sendResponse(await closeRecords(msg.tabs)); break;
      case 'sweepNow':     sendResponse(await sweep(true)); break;
      case 'syncNow':      await syncHistory(); sendResponse(true); break;
      case 'diagnostics':  sendResponse(await getDiagnostics()); break;
      default: sendResponse(null);
    }
  })();
  return true; // keep the channel open for the async response
});
