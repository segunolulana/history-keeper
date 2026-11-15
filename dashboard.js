// dashboard.js — runs in a normal extension page, so Blob + object URLs work
// here (they don't in the MV3 service worker). Exports happen on this side.

import { getVisitsSince, getStats, getGraveyard } from './db.js';

const DAY = 24 * 60 * 60 * 1000;
const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCSV(header, rows) {
  return [header.join(','), ...rows.map((r) => r.map(csvEscape).join(','))].join('\n');
}

async function download(filename, text) {
  const blob = new Blob(['\uFEFF' + text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({ url, filename, saveAs: false });
    toast(`Saved ${filename} to Downloads`);
  } catch (e) {
    // Fallback if downloads API is restricted: anchor click.
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    toast(`Saved ${filename}`);
  }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function exportHistory(rangeDays) {
  const since = rangeDays === 'all' ? null : Date.now() - Number(rangeDays) * DAY;
  const visits = await getVisitsSince(since);
  if (!visits.length) { toast('No visits in that range yet'); return; }
  visits.sort((a, b) => a.visitTime - b.visitTime);
  const csv = toCSV(
    ['visit_time_iso', 'visit_time_ms', 'title', 'url', 'transition'],
    visits.map((v) => [new Date(v.visitTime).toISOString(), v.visitTime, v.title, v.url, v.transition])
  );
  const label = rangeDays === 'all' ? 'all' : `last-${rangeDays}d`;
  await download(`history-${label}-${new Date().toISOString().slice(0, 10)}.csv`, csv);
}

async function exportGraveyard() {
  const rows = await getGraveyard();
  if (!rows.length) { toast('No closed tabs logged yet'); return; }
  const csv = toCSV(
    ['closed_at_iso', 'last_active_iso', 'title', 'url'],
    rows.map((r) => [new Date(r.closedAt).toISOString(), new Date(r.lastActive).toISOString(), r.title, r.url])
  );
  await download(`closed-tabs-${new Date().toISOString().slice(0, 10)}.csv`, csv);
}

// ---------------------------------------------------------------------------
// Stale tabs
// ---------------------------------------------------------------------------

let staleTabs = [];

function ageOf(ms) {
  const d = Math.floor((Date.now() - ms) / DAY);
  if (d >= 60) return `${Math.floor(d / 30)} months ago`;
  if (d >= 1) return `${d} day${d > 1 ? 's' : ''} ago`;
  return 'today';
}

async function refreshStale() {
  staleTabs = (await chrome.runtime.sendMessage({ type: 'getStaleTabs' })) || [];
  const list = $('#stale-list');
  list.innerHTML = '';
  if (!staleTabs.length) {
    list.innerHTML = '<li class="empty">Nothing stale right now. Clean slate.</li>';
  }
  for (const t of staleTabs) {
    const li = document.createElement('li');
    const label = document.createElement('label');
    const cb = Object.assign(document.createElement('input'), { type: 'checkbox' });
    cb.dataset.tabId = t.tabId;
    cb.addEventListener('change', updateButtons);
    const meta = document.createElement('div');
    meta.className = 'stale-meta';
    const title = document.createElement('div');
    title.className = 'stale-title';
    title.textContent = t.title;
    const age = document.createElement('div');
    age.className = 'stale-age';
    age.textContent = `Last visited ${ageOf(t.lastActive)}${t.source === 'seeded' ? ' (estimated from history)' : ''}`;
    meta.append(title, age);
    label.append(cb, meta);
    li.append(label);
    list.append(li);
  }
  updateButtons();
}

function selectedTabs() {
  const ids = [...document.querySelectorAll('#stale-list input:checked')].map((c) => Number(c.dataset.tabId));
  return staleTabs.filter((t) => ids.includes(t.tabId));
}

function updateButtons() {
  $('#close-selected').disabled = selectedTabs().length === 0;
  $('#close-all').disabled = staleTabs.length === 0;
}

async function closeTabs(tabs) {
  if (!tabs.length) return;
  const n = await chrome.runtime.sendMessage({ type: 'closeTabs', tabs });
  toast(`Closed ${n} tab${n === 1 ? '' : 's'} — saved to log`);
  refreshStale();
}

// ---------------------------------------------------------------------------
// Settings + stats
// ---------------------------------------------------------------------------

const DEFAULTS = { thresholdDays: 90, autoClose: false, keepPinned: true };

async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  const s = { ...DEFAULTS, ...(settings || {}) };
  $('#thresholdDays').value = s.thresholdDays;
  $('#autoClose').checked = s.autoClose;
  $('#keepPinned').checked = s.keepPinned;
}

async function saveSettings() {
  const settings = {
    thresholdDays: Math.max(1, Number($('#thresholdDays').value) || 90),
    autoClose: $('#autoClose').checked,
    keepPinned: $('#keepPinned').checked,
  };
  await chrome.storage.local.set({ settings });
  toast('Settings saved');
  refreshStale();
}

async function refreshStats() {
  const { count, oldest } = await getStats();
  $('#stats').textContent = count
    ? `${count.toLocaleString()} visits archived · oldest ${new Date(oldest).toLocaleDateString()}`
    : 'Archive is empty — first sync runs automatically.';
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

function agoShort(ms, now) {
  if (!ms) return '—';
  const d = (now - ms) / DAY;
  if (d < 0) return `in ${(-d * 24).toFixed(1)}h`;
  if (d < 1) return `${(d * 24).toFixed(1)}h`;
  return `${Math.floor(d)}d`;
}

async function refreshDiagnostics() {
  const d = await chrome.runtime.sendMessage({ type: 'diagnostics' });
  if (!d) return;
  const n = d.now;
  $('#diag-summary').textContent = [
    `tabs.query: ${d.tabCount} tabs, ${d.withUrl} with url, ${d.withLastAccessed} with lastAccessed`,
    `ledger: ${d.ledgerSize} entries · threshold ${d.settings.thresholdDays}d · autoClose ${d.settings.autoClose}`,
    `last sweep: ${agoShort(d.lastSweep, n)} ago · last sync: ${agoShort(d.lastSync, n)} ago`,
    ...d.alarms.map((a) => `alarm ${a.name}: every ${a.period}m, next ${agoShort(a.next, n)}`),
    `${navigator.userAgent}`,
    '',
    'per tab: ledger / lastAccessed / history (age), source',
  ].join('\n');
  const ul = $('#diag-tabs');
  ul.innerHTML = '';
  const rows = [...d.tabs].sort((a, b) => (a.ledger || n) - (b.ledger || n));
  for (const t of rows) {
    const li = document.createElement('li');
    const title = document.createElement('div');
    title.className = 'stale-title';
    title.textContent = (t.active ? '● ' : '') + (t.pinned ? '📌 ' : '') + t.title;
    const meta = document.createElement('div');
    meta.className = 'stale-age';
    meta.textContent = `${agoShort(t.ledger, n)} / ${agoShort(t.lastAccessed, n)} / ${agoShort(t.history, n)} · ${t.source || 'not in ledger'}`;
    li.append(title, meta);
    ul.append(li);
  }
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

// ---------------------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------------------

document.querySelectorAll('[data-range]').forEach((b) =>
  b.addEventListener('click', () => exportHistory(b.dataset.range))
);
$('#export-graveyard').addEventListener('click', exportGraveyard);
$('#close-selected').addEventListener('click', () => closeTabs(selectedTabs()));
$('#close-all').addEventListener('click', () => closeTabs(staleTabs));
$('#sync-now').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'syncNow' });
  toast('History synced');
  refreshStats();
});
$('#diag').addEventListener('toggle', () => { if ($('#diag').open) refreshDiagnostics(); });
['thresholdDays', 'autoClose', 'keepPinned'].forEach((id) =>
  $('#' + id).addEventListener('change', saveSettings)
);

loadSettings();
refreshStats();
refreshStale();
