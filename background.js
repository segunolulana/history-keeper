// background.js — MV3 service worker.
// Design rule: assume this worker can be killed at any moment (Android will).
// Every event handler persists its state to IndexedDB/storage immediately,
// and every startup reconciles reality (open tabs) against the persistent ledger.

import {
  putVisits, ledgerTouch, ledgerGetAll, ledgerReplace, buryTabs,
} from './db.js';

const DAY = 24 * 60 * 60 * 1000;
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

async function ensureAlarms() {
  const s = await getSettings();
  await chrome.alarms.create('syncHistory', { periodInMinutes: s.syncMinutes });
  await chrome.alarms.create('tabSweep', { periodInMinutes: 60 * 24 }); // daily
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
  await sweep(false);      // startup sweep (auto-close only if enabled)
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'syncHistory') await syncHistory();
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

// Rebuild the ledger from reality. Called on every startup and before sweeps.
// For each open tab, last-active = the most recent of:
//   1. the browser's own tab.lastAccessed (Chromium 121+, survives restore)
//   2. our persisted ledger entry for that URL
//   3. "now" if the tab is brand new to us (fresh start, fair timer)
async function reconcileTabs() {
  const tabs = await chrome.tabs.query({});
  const ledger = await ledgerGetAll();
  const byUrl = new Map(ledger.map((e) => [e.url, e]));
  const next = [];
  for (const tab of tabs) {
    if (!tab.url || tab.url.startsWith('chrome') || tab.url.startsWith('browser')) continue;
    const known = byUrl.get(tab.url);
    const lastActive = Math.max(
      known ? known.lastActive : 0,
      tab.lastAccessed || 0,
    ) || Date.now();
    next.push({ url: tab.url, title: tab.title || (known && known.title) || '', lastActive });
  }
  // Replace wholesale: entries for URLs no longer open are dropped.
  await ledgerReplace(next);
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
  if (!stale.length) return 0;
  if (s.autoClose || forceManual) return closeTabs(stale);
  // Auto-close off: surface a badge count instead of acting.
  chrome.action.setBadgeText({ text: String(stale.length) });
  return 0;
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
      default: sendResponse(null);
    }
  })();
  return true; // keep the channel open for the async response
});
