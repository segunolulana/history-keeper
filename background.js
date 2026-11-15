// background.js — MV3 service worker.
// Design rule: assume this worker can be killed at any moment (Android will).
// Every event handler persists its state to IndexedDB/storage immediately,
// and every startup reconciles reality (open tabs) against the persistent ledger.

import {
  putVisits, ledgerTouch, ledgerGetAll, ledgerMerge, getLastVisits, buryTabs,
} from './db.js';

const DAY = 24 * 60 * 60 * 1000;
const LEDGER_PRUNE_AFTER = 7 * DAY; // forget URLs that haven't been open for a week
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
    const { lastSync } = await chrome.storage.local.get('lastSync');
    // First run: grab everything still inside the browser's retention window.
    // Overlap re-reads 1h to be safe against clock skew; dedup is free.
    const start = (lastSync || Date.now() - 95 * DAY) - 60 * 60 * 1000;

    const items = await chrome.history.search({
      text: '', startTime: start, endTime: Date.now(), maxResults: 100000,
    });

    const rows = [];
    for (const item of items) {
      const visits = await chrome.history.getVisits({ url: item.url });
      for (const v of visits) {
        if (v.visitTime >= start) {
          rows.push({
            url: item.url,
            title: item.title || '',
            visitTime: Math.round(v.visitTime),
            transition: v.transition || '',
          });
        }
      }
    }
    await putVisits(rows);
    await chrome.storage.local.set({ lastSync: Date.now() });
  } catch (e) {
    console.error('syncHistory failed', e);
  }
}

// ---------------------------------------------------------------------------
// TAB LEDGER
// The fix for Tab Wrangler's "amnesia": every activation is written to disk
// the moment it happens, keyed by URL (tab IDs die on restart, URLs don't).
// ---------------------------------------------------------------------------

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab && tab.url) await ledgerTouch(tab.url, tab.title);
  } catch { /* tab may already be gone */ }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // A URL change or a page finishing a load counts as activity for that tab.
  if ((changeInfo.url || changeInfo.status === 'complete') && tab && tab.url && tab.active) {
    await ledgerTouch(tab.url, tab.title);
  }
});

// Reconcile the ledger with the tabs that are actually open.
// - Tabs we've observed keep their recorded lastActive.
// - Tabs we've never observed get an *estimate*: the newest of the URL's last
//   archived history visit and the browser's tab.lastAccessed. Previously they
//   got "now", so nothing could go stale until `threshold` days after install.
// - Entries without a `source` predate this logic and were stamped "now" at
//   install; they are re-estimated once.
// - Merge, never clear: a partial tabs.query can't reset everyone's timer.
function isTracked(url) {
  return url && !url.startsWith('chrome') && !url.startsWith('browser');
}

async function reconcileTabs() {
  const now = Date.now();
  const tabs = (await chrome.tabs.query({})).filter((t) => isTracked(t.url));
  const ledger = await ledgerGetAll();
  const byUrl = new Map(ledger.map((e) => [e.url, e]));
  const lastVisits = await getLastVisits([...new Set(tabs.map((t) => t.url))]);

  const out = new Map();
  for (const tab of tabs) {
    if (out.has(tab.url)) continue;
    const known = byUrl.get(tab.url);
    let entry;
    if (known && known.source) {
      entry = { ...known, lastSeen: now };
    } else {
      const estimate = Math.max(lastVisits.get(tab.url) || 0, tab.lastAccessed || 0) || now;
      entry = {
        url: tab.url,
        title: tab.title || (known && known.title) || '',
        lastActive: estimate,
        source: 'seeded',
        lastSeen: now,
      };
    }
    out.set(tab.url, entry);
  }
  const prune = ledger
    .filter((e) => !out.has(e.url) && now - (e.lastSeen || 0) > LEDGER_PRUNE_AFTER)
    .map((e) => e.url);
  const next = [...out.values()];
  await ledgerMerge(next, prune);
  return next;
}

// ---------------------------------------------------------------------------
// THE REAPER
// ---------------------------------------------------------------------------

async function findStaleTabs() {
  const s = await getSettings();
  const cutoff = Date.now() - s.thresholdDays * DAY;
  const ledger = await reconcileTabs(); // always sweep against fresh truth
  const byUrl = new Map(ledger.map((e) => [e.url, e]));
  const tabs = await chrome.tabs.query({});
  const stale = [];
  for (const tab of tabs) {
    if (!tab.url) continue;
    if (tab.active) continue;                       // never close the tab in use
    if (s.keepPinned && tab.pinned) continue;
    const entry = byUrl.get(tab.url);
    if (entry && entry.lastActive < cutoff) {
      stale.push({
        tabId: tab.id, url: tab.url,
        title: tab.title || entry.title || tab.url,
        lastActive: entry.lastActive,
        source: entry.source,
      });
    }
  }
  return stale;
}

async function closeTabs(list) {
  if (!list.length) return 0;
  await buryTabs(list); // save to graveyard BEFORE closing
  try { await chrome.tabs.remove(list.map((t) => t.tabId)); } catch (e) { console.error(e); }
  return list.length;
}

async function sweep(forceManual) {
  const s = await getSettings();
  const stale = await findStaleTabs();
  await chrome.storage.local.set({ lastSweep: Date.now() });
  if (stale.length && (s.autoClose || forceManual)) {
    const n = await closeTabs(stale);
    await setBadge(0);
    return n;
  }
  // Auto-close off: surface a badge count instead of acting.
  await setBadge(stale.length);
  return 0;
}

async function setBadge(n) {
  try { await chrome.action.setBadgeText({ text: n ? String(n) : '' }); } catch { /* no badge on some mobile builds */ }
}

// Snapshot for the dashboard's diagnostics panel, so we can see on-device
// which signal (tabs.query, lastAccessed, history, alarms) is misbehaving.
async function getDiagnostics() {
  const now = Date.now();
  const s = await getSettings();
  const all = await chrome.tabs.query({});
  const ledger = await ledgerGetAll();
  const byUrl = new Map(ledger.map((e) => [e.url, e]));
  const lastVisits = await getLastVisits([...new Set(all.map((t) => t.url).filter(Boolean))]);
  const alarms = await chrome.alarms.getAll();
  const { lastSweep, lastSync } = await chrome.storage.local.get(['lastSweep', 'lastSync']);
  return {
    now,
    settings: s,
    tabCount: all.length,
    withUrl: all.filter((t) => t.url).length,
    withLastAccessed: all.filter((t) => t.lastAccessed).length,
    ledgerSize: ledger.length,
    lastSweep: lastSweep || null,
    lastSync: lastSync || null,
    alarms: alarms.map((a) => ({ name: a.name, next: a.scheduledTime, period: a.periodInMinutes })),
    tabs: all.map((t) => {
      const e = byUrl.get(t.url);
      return {
        title: t.title || t.url || '(no url)',
        active: !!t.active,
        pinned: !!t.pinned,
        ledger: e ? e.lastActive : null,
        source: e ? (e.source || 'legacy') : null,
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
      case 'getStaleTabs': sendResponse(await findStaleTabs()); break;
      case 'closeTabs':    sendResponse(await closeTabs(msg.tabs)); break;
      case 'sweepNow':     sendResponse(await sweep(true)); break;
      case 'syncNow':      await syncHistory(); sendResponse(true); break;
      case 'diagnostics':  sendResponse(await getDiagnostics()); break;
      default: sendResponse(null);
    }
  })();
  return true; // keep the channel open for the async response
});
