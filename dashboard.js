// dashboard.js — runs in a normal extension page, so Blob + object URLs work
// here (they don't in the MV3 service worker). Exports happen on this side.

import {
  getVisitsSince, getStats, getGraveyard,
  searchVisits, getBreadcrumbs, getChildVisits, countLinkedVisits,
} from './db.js';

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
    ['closed_at_iso', 'last_active_iso', 'how', 'title', 'url'],
    rows.map((r) => [new Date(r.closedAt).toISOString(), new Date(r.lastActive).toISOString(), r.how || 'closed', r.title, r.url])
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
    cb.dataset.id = t.id;
    cb.addEventListener('change', updateButtons);
    const meta = document.createElement('div');
    meta.className = 'stale-meta';
    const title = document.createElement('div');
    title.className = 'stale-title';
    title.textContent = t.title;
    const age = document.createElement('div');
    age.className = 'stale-age';
    const bits = [`Last visited ${ageOf(t.lastActive)}${t.source === 'seeded' ? ' (estimated)' : ''}`];
    if (t.trail) bits.push(`+${t.trail} earlier page${t.trail > 1 ? 's' : ''} in this tab`);
    age.textContent = bits.join(' · ');
    const where = document.createElement('div');
    where.className = 'stale-age';
    let host = t.url;
    try { host = new URL(t.url).host; } catch { /* keep raw */ }
    where.textContent = host;
    if (!t.loaded) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'not loaded';
      where.append(' ', tag);
    }
    meta.append(title, age, where);
    label.append(cb, meta);
    li.append(label);
    list.append(li);
  }
  updateButtons();
}

function selectedTabs() {
  const ids = new Set([...document.querySelectorAll('#stale-list input:checked')].map((c) => c.dataset.id));
  return staleTabs.filter((t) => ids.has(t.id));
}

function updateButtons() {
  $('#close-selected').disabled = selectedTabs().length === 0;
  $('#close-all').disabled = staleTabs.length === 0;
}

async function closeTabs(tabs) {
  if (!tabs.length) return;
  const r = await chrome.runtime.sendMessage({ type: 'closeTabs', tabs });
  const parts = [];
  if (r && r.closed) parts.push(`closed ${r.closed}`);
  if (r && r.dismissed) parts.push(`removed ${r.dismissed} from list`);
  if (r && r.failed) parts.push(`${r.failed} couldn't be closed`);
  toast(`${parts.join(', ') || 'Nothing changed'} — saved to log`);
  refreshStale();
}

// ---------------------------------------------------------------------------
// History search
// Search the archive; from any result you can narrow to the day of that
// visit, see the path of pages that led to it (breadcrumbs, via each visit's
// referrer) and the links you followed from it (visits referring to it).
// ---------------------------------------------------------------------------

const SEARCH_LIMIT = 200;
let searchDay = null;      // { from, to, label } or null
let searchTimer;
let searchSeq = 0;         // ignore results of superseded searches

function startOfDay(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
function nextDay(ms) { const d = new Date(ms); d.setDate(d.getDate() + 1); return d.getTime(); }
const fmtDate = (ms) => new Date(ms).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const fmtTime = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const fmtWhen = (ms) => (searchDay ? fmtTime(ms) : `${new Date(ms).toLocaleDateString()} ${fmtTime(ms)}`);

function hostOf(url) { try { return new URL(url).host; } catch { return url; } }

function pageLink(v) {
  const a = document.createElement('a');
  a.className = 'hs-title';
  a.textContent = v.title || v.url;
  if (/^(https?|ftp|file):/i.test(v.url)) { a.href = v.url; a.target = '_blank'; a.rel = 'noopener'; }
  a.title = v.url;
  return a;
}

function metaLine(v, when) {
  const m = document.createElement('div');
  m.className = 'stale-age';
  m.textContent = [hostOf(v.url), when, v.transition].filter(Boolean).join(' · ');
  return m;
}

function smallBtn(label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chip-btn';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

// A compact row used inside breadcrumb / links panels.
function miniVisit(v, { current = false } = {}) {
  const li = document.createElement('li');
  if (current) li.className = 'current';
  li.append(pageLink(v), metaLine(v, `${new Date(v.visitTime).toLocaleDateString()} ${fmtTime(v.visitTime)}`));
  return li;
}

function note(text) {
  const p = document.createElement('p');
  p.className = 'hint';
  p.textContent = text;
  return p;
}

async function showBreadcrumbs(v, panel) {
  panel.replaceChildren(note('Loading…'));
  const { crumbs, brokenAt } = await getBreadcrumbs(v);
  const ol = document.createElement('ol');
  ol.className = 'crumbs';
  crumbs.forEach((c, i) => ol.append(miniVisit(c, { current: i === crumbs.length - 1 })));
  const out = [];
  if (!v.visitId) out.push(note('No link info for this visit (archived before link tracking, or not recorded by the browser).'));
  else if (crumbs.length === 1 && !brokenAt) out.push(note(`Not reached from another page${v.transition ? ` (${v.transition})` : ''}.`));
  if (brokenAt) out.push(note('Earlier pages in this path are no longer in history.'));
  panel.replaceChildren(...out, ...(crumbs.length > 1 ? [ol] : []));
}

async function showLinks(v, panel) {
  panel.replaceChildren(note('Loading…'));
  if (!v.visitId) {
    panel.replaceChildren(note('No link info for this visit (archived before link tracking, or not recorded by the browser).'));
    return;
  }
  const kids = await getChildVisits(v.visitId);
  if (!kids.length) { panel.replaceChildren(note('No links followed from this page.')); return; }
  const ul = document.createElement('ul');
  ul.className = 'crumbs';
  kids.forEach((k) => ul.append(miniVisit(k)));
  panel.replaceChildren(note(`${kids.length} link${kids.length > 1 ? 's' : ''} followed from this page:`), ul);
}

function renderResult(v) {
  const li = document.createElement('li');
  const panel = document.createElement('div');
  panel.className = 'hs-panel';
  panel.hidden = true;
  let open = null;
  const toggle = (which, fn) => () => {
    if (open === which) { panel.hidden = true; open = null; return; }
    open = which; panel.hidden = false; fn(v, panel);
  };
  const actions = document.createElement('div');
  actions.className = 'hs-actions';
  if (!searchDay) actions.append(smallBtn('That day', () => setSearchDay(v.visitTime)));
  actions.append(smallBtn('Path here', toggle('crumbs', showBreadcrumbs)), smallBtn('Links clicked', toggle('links', showLinks)));
  li.append(pageLink(v), metaLine(v, fmtWhen(v.visitTime)), actions, panel);
  return li;
}

function setSearchDay(ms) {
  if (ms == null) { searchDay = null; } else {
    const from = startOfDay(ms);
    searchDay = { from, to: nextDay(from), label: fmtDate(from) };
  }
  $('#hs-day').hidden = !searchDay;
  $('#hs-day-label').textContent = searchDay ? `Only ${searchDay.label}` : '';
  runSearch();
  $('#hs-q').scrollIntoView({ block: 'start', behavior: 'smooth' });
}

async function runSearch() {
  const seq = ++searchSeq;
  const text = $('#hs-q').value.trim();
  const { visits, more } = await searchVisits({
    text, from: searchDay && searchDay.from, to: searchDay && searchDay.to,
    limit: text || searchDay ? SEARCH_LIMIT : 30,
  });
  if (seq !== searchSeq) return;
  const list = $('#hs-results');
  list.replaceChildren(...visits.map(renderResult));
  let info;
  if (!visits.length) info = text ? 'No matches.' : 'Nothing archived for this day.';
  else if (!text && !searchDay) info = 'Most recent visits. Type to search.';
  else info = `${visits.length}${more ? '+' : ''} visit${visits.length === 1 ? '' : 's'}${more ? ' — refine to see older ones' : ''}`;
  try {
    const { total, withId } = await countLinkedVisits();
    if (seq === searchSeq && total && withId < total) {
      info += ` · link info for ${withId.toLocaleString()} of ${total.toLocaleString()} visits`;
    }
  } catch { /* optional */ }
  if (seq === searchSeq) $('#hs-info').textContent = info;
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
    `tracked tabs: ${d.recordCount} (${d.loadedCount} loaded now) · ${d.removedCount} closed by browser event`,
    `threshold ${d.settings.thresholdDays}d · autoClose ${d.settings.autoClose}`,
    `this session: ${Object.entries(d.stats || {}).map(([k, v]) => `${k} ${v}`).join(', ') || 'no tab events yet'}`,
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
$('#hs-q').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 200); });
$('#hs-day-clear').addEventListener('click', () => setSearchDay(null));
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

// Search starts collapsed; its open/closed state is remembered per device.
let searchLoaded = false;
$('#hs').addEventListener('toggle', () => {
  const open = $('#hs').open;
  try { localStorage.setItem('hsOpen', open ? '1' : '0'); } catch { /* storage unavailable */ }
  if (open && !searchLoaded) { searchLoaded = true; runSearch(); }
});
try { if (localStorage.getItem('hsOpen') === '1') $('#hs').open = true; } catch { /* storage unavailable */ }

loadSettings();
refreshStats();
refreshStale();
