// Server Manager — interface.
'use strict';

const api = window.sm;
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let A = null;              // state from the main process
let SET = { host: '' };
let range = 24;            // graph hours: 24 or 6

const LABEL = { offline: 'Offline', starting: 'Starting', updating: 'Updating', online: 'Online', saving: 'Saving', backup: 'Creating backup', stopping: 'Shutting down', restarting: 'Restarting', error: 'Error', unavailable: 'Unavailable' };
const BUSY = new Set(['starting', 'updating', 'saving', 'backup', 'stopping', 'restarting']);
const CONFIRM = {
  shutdown: ['Shut down the server?', 'Players get a warning 60 and 10 seconds before. The world is saved and checked first; if the save cannot be verified, the server keeps running.', 'Shut down'],
  restart: ['Restart the server?', 'Players get a warning, the world is saved and checked, then the server stops and starts again. Players can reconnect after a few minutes.', 'Restart'],
  update: ['Install the game update?', 'Players are warned, the world is saved, a checked backup is made, then the server restarts and installs the update.', 'Install'],
};

// static icons
$('#openSettings').innerHTML = I.server;
$('#back').innerHTML = I.back;
$('#range').innerHTML = I.chart;
$('#icoCpu').innerHTML = I.cpu;
$('#icoMem').innerHTML = I.memory;
$('#power').innerHTML = I.power;
const DOCK_ICON = { start: I.play, save: I.save, restart: I.restart, backup: I.backup };
document.querySelectorAll('.dbtn').forEach(b => { b.querySelector('.di').innerHTML = DOCK_ICON[b.dataset.act]; });

// ------------------------------------------------------------------ helpers
function clock(t) {
  if (!t) return '';
  const d = new Date(t), now = new Date();
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return 'today, ' + hm;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'yesterday, ' + hm;
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ', ' + hm;
}
function since(t) {
  const m = Math.max(0, Math.floor((Date.now() - t) / 60000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
const connected = () => A && A.conn === 'ok';
const status = () => connected() ? A.status : 'unavailable';
function allowed(k) {
  if (!connected() || A.pending || A.operation) return false;
  if (k === 'start') return A.status === 'offline' || A.status === 'error';
  if (k === 'verify' || k === 'checkupdate') return true;
  return A.status === 'online';
}
const powerAction = () => connected() && (A.status === 'offline' || A.status === 'error') ? 'start' : 'shutdown';

// ------------------------------------------------------------------ graph
function graph() {
  const box = $('#graph');
  const w = Math.max(200, box.clientWidth), h = box.clientHeight || 150;
  const top = 10, base = h - 22;
  const max = Math.max(1, (A && A.maxPlayers) || 5);
  const now = Date.now(), from = now - range * 3600e3, N = range === 24 ? 24 : 18;
  const hist = ((A && A.history) || []).filter(p => Number.isFinite(p.t)).sort((a, b) => a.t - b.t);
  const pts = [];
  let i = 0, last = null;
  while (i < hist.length && hist[i].t <= from) { last = hist[i].v; i++; }
  for (let b = 0; b <= N; b++) {
    const end = from + (b / N) * (now - from);
    let peak = last;
    while (i < hist.length && hist[i].t <= end) { last = hist[i].v; if (last != null && (peak == null || last > peak)) peak = last; i++; }
    pts.push(peak);
  }
  if (A && A.players != null) pts[N] = A.players;
  const x = b => 6 + (b / N) * (w - 16);
  const y = v => base - (Math.min(v, max) / max) * (base - top);
  let line = '', area = '', run = [];
  const flush = () => {
    if (run.length > 1) {
      const d = run.map(([b, v], j) => `${j ? 'L' : 'M'}${x(b).toFixed(1)} ${y(v).toFixed(1)}`).join('');
      line += `<path class="line" d="${d}"/>`;
      area += `<path class="area" d="${d}L${x(run[run.length - 1][0]).toFixed(1)} ${base}L${x(run[0][0]).toFixed(1)} ${base}Z"/>`;
    }
    run = [];
  };
  pts.forEach((v, b) => { if (v == null) flush(); else run.push([b, v]); });
  flush();
  const lastV = pts[N];
  const end = lastV != null ? `<circle class="end" cx="${x(N).toFixed(1)}" cy="${y(lastV).toFixed(1)}" r="6"/>` : '';
  const ticks = Array.from({ length: 31 }, (_, k) => `<path class="tick" d="M${(6 + k / 30 * (w - 16)).toFixed(1)} ${h - 12}v7"/>`).join('');
  const empty = !line ? `<text class="empty" x="${w / 2}" y="${base / 2 + 10}" text-anchor="middle">No player data for this period yet</text>` : '';
  box.innerHTML = `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-label="Players over the last ${range} hours">
    <defs><linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#E99A40" stop-opacity=".2"/><stop offset="1" stop-color="#E99A40" stop-opacity="0"/></linearGradient></defs>
    ${area}${line}${end}${ticks}${empty}</svg>`;
}
new ResizeObserver(() => graph()).observe($('#graph'));

// ------------------------------------------------------------------ main view
const pretty = m => String(m || '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
function render() {
  const st = status();
  const name = (A && A.name) || 'ARK server';
  $('#name').textContent = name; $('#name2').textContent = name;
  $('#map').textContent = A && A.map ? `${pretty(A.map)} · Private LAN` : 'Private LAN';
  const busy = BUSY.has(st) || !!(A && (A.pending || A.operation));
  const dot = $('#dot');
  dot.className = 'dot' + (st === 'online' && !busy ? ' on' : busy ? ' busy' : st === 'error' ? ' bad' : '');
  $('#state').textContent = !A || A.conn === 'connecting' ? 'Connecting'
    : A.conn === 'unset' ? 'Not connected'
    : A.conn !== 'ok' ? 'Offline'
    : LABEL[st] || st;

  const max = (A && A.maxPlayers) || 5;
  $('#players').textContent = A && A.players != null ? A.players : '–';
  $('#playersOf').textContent = `/ ${max}`;

  const msg = $('#message');
  msg.classList.remove('bad');
  if (!A || A.conn === 'unset') msg.textContent = 'Set up the connection to the NAS in Settings.';
  else if (A.conn !== 'ok') { msg.textContent = A.error || 'The NAS does not answer'; msg.classList.add('bad'); }
  else if (st === 'error') { msg.textContent = A.message || 'See the NAS log in Settings'; msg.classList.add('bad'); }
  else if (busy && A.message) msg.textContent = A.message;
  else if (st === 'online' && A.auto && A.auto.shutdown && A.auto.idleSince && A.players === 0) {
    const left = Math.max(0, Math.ceil((A.auto.idleSince + A.auto.idleMinutes * 60000 - Date.now()) / 60000));
    msg.textContent = `Nobody online · shuts down in ${left} min`;
  } else if (st === 'online' && A.started) msg.textContent = `Up ${since(A.started)} · ${A.connect}`;
  else msg.textContent = '';

  $('#activity').textContent = st === 'online' && !busy ? (A.players > 0 ? 'Active' : 'Quiet') : busy ? LABEL[st] : st === 'offline' ? 'Off' : '';
  $('#graphLabel').textContent = `Server activity · ${range} h`;
  graph();

  // metrics: ARK's share of the NAS
  const cpu = A && A.cpu != null ? A.cpu / (A.cpus || 4) : null;
  $('#cpu').textContent = cpu != null ? `${Math.round(cpu)}%` : '–';
  $('#cpuBar').style.width = cpu != null ? Math.min(100, cpu) + '%' : '0';
  $('#cpuHint').textContent = A && A.nasLoad != null ? `${A.cpus || 4} cores · NAS load ${A.nasLoad.toFixed(1)}` : '';
  const mem = A && A.memGb, tot = A && A.nasMemTotalGb;
  $('#mem').textContent = mem != null ? mem.toFixed(1) : '–';
  $('#memOf').textContent = tot ? `/ ${Math.round(tot)} GB` : 'GB';
  $('#memBar').style.width = mem != null && tot ? Math.min(100, mem / tot * 100) + '%' : '0';
  $('#memHint').textContent = A && A.nasMemUsedGb != null ? `NAS in use: ${A.nasMemUsedGb.toFixed(1)} GB` : '';

  // world save
  const card = $('#savedCard');
  card.classList.remove('bad', 'none');
  let title, sub, icon = I.shield, check = I.check;
  if (st === 'saving' || (A && A.pending === 'save')) { title = 'Saving the world'; sub = A.message || 'Waiting for the save file'; icon = I.shield; check = I.clock; }
  else if (A && A.lastOp === 'save' && A.lastResult === 'error') { title = 'Save failed'; sub = A.lastMessage; icon = I.shieldx; check = I.alert; card.classList.add('bad'); }
  else if (A && A.lastSave) { title = 'World saved'; sub = `Last save ${clock(A.lastSave)}`; }
  else { title = connected() ? 'No save yet' : 'World save'; sub = connected() ? 'ARK has not written the world file yet' : '–'; check = I.clock; card.classList.add('none'); }
  $('#savedTitle').textContent = title;
  $('#savedSub').textContent = sub;
  $('#savedIcon').innerHTML = icon;
  $('#savedCheck').innerHTML = check;

  // dock
  document.querySelectorAll('.dbtn').forEach(b => {
    b.disabled = !allowed(b.dataset.act);
    b.classList.toggle('on', !!(A && A.pending === b.dataset.act));
  });
  const p = $('#power'), pa = powerAction();
  p.dataset.act = pa;
  p.disabled = !allowed(pa);
  p.classList.toggle('on', !!(A && (A.pending === 'shutdown' || A.pending === 'start' || st === 'stopping')));
  $('#powerLabel').textContent = pa === 'start' ? 'Start' : 'Shut down';
  p.setAttribute('aria-label', pa === 'start' ? 'Start server' : 'Shut down safely');

  if (!$('#settings').classList.contains('hidden')) renderSettings();
}

// ------------------------------------------------------------------ actions
function ask(action) {
  return new Promise(resolve => {
    const [t, x, ok] = CONFIRM[action];
    $('#sheetTitle').textContent = t; $('#sheetText').textContent = x; $('#sheetYes').textContent = ok;
    $('#sheet').classList.remove('hidden');
    const done = v => { $('#sheet').classList.add('hidden'); $('#sheetYes').onclick = $('#sheetNo').onclick = null; resolve(v); };
    $('#sheetYes').onclick = () => done(true);
    $('#sheetNo').onclick = () => done(false);
  });
}
async function act(action) {
  if (!allowed(action)) return;
  const needs = !!CONFIRM[action];
  if (needs && !(await ask(action))) return;
  const r = await api.invoke('run', { action, confirmed: needs }).catch(e => ({ ok: false, error: e.message }));
  if (!r.ok) toast({ title: 'Not started', sub: r.error });
}
document.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => act(b.dataset.act)));
$('#range').onclick = () => { range = range === 24 ? 6 : 24; $('#range').title = `Show ${range === 24 ? 6 : 24} hours`; render(); };

let toastTimer = null;
function toast(p) {
  $('#toastTitle').textContent = p.title || '';
  $('#toastSub').textContent = p.sub || '';
  $('#toast').classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.add('hidden'), 5000);
}
$('#toast').onclick = () => $('#toast').classList.add('hidden');
document.addEventListener('keydown', e => { if (e.key === 'Escape') { $('#sheetNo').click(); } });

// ------------------------------------------------------------------ settings view
function show(view) {
  $('#home').classList.toggle('hidden', view !== 'home');
  $('#settings').classList.toggle('hidden', view !== 'settings');
  if (view === 'settings') { renderSettings(); loadLog(); }
  else render();
}
$('#openSettings').onclick = () => show('settings');
$('#back').onclick = () => show('home');

let fpShown = false;
function renderSettings() {
  const st = (A && A.setup) || {};
  const ok = connected();
  if (document.activeElement !== $('#host')) $('#host').value = SET.host || '';
  if (document.activeElement !== $('#user')) $('#user').value = SET.user || '';
  $('#connLine').textContent = !A || A.conn === 'unset' ? (!SET.host || !SET.user ? 'Enter the NAS address and user' : !st.hasKey ? 'Step 1: create this PC\'s key' : !st.trusted ? 'Step 2: check and trust the NAS key' : 'Enter the NAS address')
    : A.conn === 'connecting' ? 'Connecting…'
    : ok ? `Connected · ${A.name || 'the server'} is ${(LABEL[A.status] || A.status).toLowerCase()}` : (A.error || 'Not connected');
  $('#setup').classList.toggle('hidden', ok && st.hasKey && st.trusted);
  $('#keyState').textContent = st.hasKey ? 'Key created' : 'No key yet';
  $('#key').textContent = st.hasKey ? 'Copy NAS command' : 'Create key';
  if (!fpShown) $('#fp').textContent = st.trusted ? 'NAS key trusted' : 'Not checked';
  $('#autoCard').classList.toggle('hidden', !ok);
  $('#maintCard').classList.toggle('hidden', !ok);
  if (!ok) return;
  const au = A.auto || {};
  $('#autoOn').checked = !!au.shutdown;
  document.querySelectorAll('#idle button').forEach(b => b.classList.toggle('on', +b.dataset.v === au.idleMinutes));
  if (document.activeElement !== $('#startAt')) $('#startAt').value = au.startAt || '';
  const age = au.lastTick ? (Date.now() - au.lastTick) / 60000 : null;
  $('#tick').textContent = age == null ? 'not running on the NAS yet' : age > 5 ? `paused since ${clock(au.lastTick)}` : 'active on the NAS';
  $('#build').textContent = A.updateAvailable ? `Update available · build ${A.build}` : `Game build ${A.build || '–'}`;
  $('#backupInfo').textContent = A.lastBackup ? `Last checked backup ${clock(A.lastBackup)}${A.backupMb != null ? ` · ${A.backupMb} MB` : ''}` : 'No checked backup yet';
  $('#storage').textContent = A.backupTotalMb != null ? `Backups ${A.backupTotalMb} MB of ${A.backupLimitMb || '–'} MB · ${A.freeGb != null ? A.freeGb.toFixed(0) + ' GB free on the NAS' : ''}` : '';
  $('#lastOp').textContent = A.lastOp ? `Last: ${A.lastOp} · ${A.lastResult || 'running'} · ${A.lastMessage}` : '';
  $('#join').textContent = A.connect || '–';
  const busy = !!(A.operation || A.pending);
  $('#checkUpd').disabled = busy; $('#verify').disabled = busy;
  $('#update').disabled = busy || A.status !== 'online';
}
async function loadLog() {
  if (!connected()) { $('#log').textContent = '–'; return; }
  const t = await api.invoke('log').catch(() => '');
  $('#log').textContent = t || '–';
  $('#log').scrollTop = $('#log').scrollHeight;
}
$('#refreshLog').onclick = loadLog;
const commitHost = async () => {
  const host = $('#host').value.trim(), user = $('#user').value.trim();
  if (host === SET.host && user === SET.user) return;
  const r = await api.invoke('set-host', { host, user });
  if (r.ok) { SET.host = host; SET.user = user; } else toast({ title: 'Not saved', sub: r.error });
};
for (const id of ['#host', '#user']) {
  $(id).addEventListener('change', commitHost);
  $(id).addEventListener('keydown', e => { if (e.key === 'Enter') { commitHost(); e.target.blur(); } });
}
$('#key').onclick = async () => {
  $('#key').disabled = true;
  const r = await api.invoke('key').catch(e => ({ ok: false, error: e.message }));
  $('#key').disabled = false;
  $('#keyState').textContent = r.ok ? 'NAS command copied: paste it in your SSH window on the NAS' : r.error;
};
$('#scan').onclick = async () => {
  $('#scan').disabled = true; fpShown = true; $('#fp').textContent = 'Asking the NAS…';
  const r = await api.invoke('scan').catch(e => ({ ok: false, error: e.message }));
  $('#scan').disabled = false;
  $('#fp').textContent = r.ok ? r.fingerprint : r.error;
  $('#trust').hidden = !r.ok;
};
$('#trust').onclick = async () => { await api.invoke('trust'); $('#trust').hidden = true; fpShown = false; renderSettings(); };
$('#forget').onclick = async () => {
  $('#sheetTitle').textContent = 'Disconnect?'; $('#sheetText').textContent = 'This removes this PC\'s key and the trusted NAS key. You will have to set up the connection again.'; $('#sheetYes').textContent = 'Disconnect';
  $('#sheet').classList.remove('hidden');
  $('#sheetNo').onclick = () => $('#sheet').classList.add('hidden');
  $('#sheetYes').onclick = async () => { $('#sheet').classList.add('hidden'); await api.invoke('forget'); };
};
const cfg = async word => { const r = await api.invoke('config', word).catch(e => ({ ok: false, error: e.message })); if (!r.ok) toast({ title: 'Setting not saved', sub: r.error }); };
$('#autoOn').onchange = e => cfg(e.target.checked ? 'autoshutdown-on' : 'autoshutdown-off');
document.querySelectorAll('#idle button').forEach(b => b.onclick = () => cfg('idle-' + b.dataset.v));
const commitStart = () => {
  const v = $('#startAt').value.trim();
  if (v === ((A && A.auto && A.auto.startAt) || '')) return;
  if (!v) return cfg('start-off');
  const m = v.match(/^([01]?\d|2[0-3])[:.]?([0-5]\d)$/);
  if (!m) { toast({ title: 'Time not saved', sub: 'Write it as 19:30, or leave it empty for off.' }); return; }
  cfg(`start-${m[1].padStart(2, '0')}${m[2]}`);
};
$('#startAt').addEventListener('change', commitStart);
$('#startAt').addEventListener('keydown', e => { if (e.key === 'Enter') { commitStart(); e.target.blur(); } });
$('#checkUpd').onclick = () => api.invoke('run', { action: 'checkupdate' }).then(r => { if (!r.ok) toast({ title: 'Not started', sub: r.error }); });
$('#verify').onclick = () => api.invoke('run', { action: 'verify' }).then(r => { if (!r.ok) toast({ title: 'Not started', sub: r.error }); });
$('#update').onclick = () => act('update');
$('#copyJoin').onclick = async () => { if (await api.invoke('copy', 'join')) toast({ title: 'Copied', sub: 'Paste it in the ARK console (Tab)' }); };

// ------------------------------------------------------------------ app updates
let UP = null;
function renderUpdate(u) {
  if (!u) return;
  UP = u;
  const t = $('#version'), b = $('#updBtn');
  b.disabled = false; b.className = 'pill';
  if (!u.packaged) { t.textContent = `Server Manager ${u.current} · updates only in the installed app`; b.disabled = true; return; }
  if (u.state === 'checking') { t.textContent = `Server Manager ${u.current} · checking…`; b.disabled = true; }
  else if (u.state === 'downloading') { t.textContent = `Downloading ${u.version} · ${u.percent || 0}%`; b.disabled = true; }
  else if (u.state === 'ready') { t.textContent = `Version ${u.version} is ready`; b.textContent = 'Restart to update'; b.className = 'pill dark'; return; }
  else t.textContent = `Server Manager ${u.current}` + (u.error ? ' · last check failed' : ' · up to date');
  b.textContent = 'Check for updates';
}
api.on('update', u => { renderUpdate(u); if (u.state === 'ready') toast({ title: `Update ${u.version} is ready`, sub: 'It installs when you close Server Manager, or now via Settings' }); });
$('#updBtn').onclick = () => api.invoke(UP && UP.state === 'ready' ? 'update-install' : 'update-check');

// ------------------------------------------------------------------ this PC: tray and start with Windows
const renderPrefs = p => { if (!p) return; $('#prefTray').checked = !!p.tray; $('#prefLogin').checked = !!p.launchAtLogin; };
api.on('prefs', renderPrefs);
$('#prefTray').onchange = async e => renderPrefs(await api.invoke('set-prefs', { tray: e.target.checked }));
$('#prefLogin').onchange = async e => renderPrefs(await api.invoke('set-prefs', { launchAtLogin: e.target.checked }));

// ------------------------------------------------------------------ boot
api.on('state', s => { A = s; render(); });
api.on('toast', toast);
(async () => {
  const init = await api.invoke('init');
  SET = init.settings; A = init.state;
  $('#version').textContent = `Server Manager ${init.version}`;
  renderUpdate(await api.invoke('update-state').catch(() => null));
  renderPrefs(await api.invoke('prefs').catch(() => null));
  render();
})();
setInterval(render, 30000);   // countdowns and "today, 22:30" stay current
