// Server Manager — main process: one window, a list of game servers on the NAS, the tray and settings.
'use strict';

const { app, BrowserWindow, ipcMain, clipboard, shell, nativeImage, Tray, Menu, screen, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
// One adapter per game type. Each server in the list gets its own instance.
const ADAPTERS = {
  ark: { label: 'ARK: Survival Evolved', make: o => new (require('./adapters/ark').Ark)(o) },
};
let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch { /* running from source without it */ }

app.setAppUserModelId('com.fjbc.servermanager');
if (!app.requestSingleInstanceLock()) app.quit();

// ---------------------------------------------------------------- settings
// servers: [{ id, type, host, user }] (filled in by you in Settings); active: the one on screen
const DEFAULTS = { servers: [], active: '', bounds: null, tray: true, launchAtLogin: false };
let settings = { ...DEFAULTS };
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { /* first run */ }
  settings = { ...DEFAULTS, ...saved };
  // 1.4 and older had one server as host/user: it becomes the first server in the list
  if (!Array.isArray(saved.servers)) {
    settings.servers = [{ id: 'ark-1', type: 'ark', host: saved.host || '', user: saved.user || '' }];
    delete settings.host; delete settings.user;
    saveSettings();
  }
  settings.servers = settings.servers.filter(x => x && ADAPTERS[x.type] && /^[a-z0-9-]{1,40}$/.test(x.id));
  if (!settings.servers.length) settings.servers = [{ id: 'ark-1', type: 'ark', host: '', user: '' }];
  if (!settings.servers.some(x => x.id === settings.active)) settings.active = settings.servers[0].id;
}
function saveSettings() {
  try { fs.mkdirSync(path.dirname(settingsFile()), { recursive: true }); fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch { /* fine */ }
}

// ---------------------------------------------------------------- window
let win = null;
function send(ch, d) { if (win && !win.isDestroyed()) win.webContents.send(ch, d); }
function createWindow() {
  const b = settings.bounds || {};
  win = new BrowserWindow({
    width: b.width || 440, height: b.height || 860, x: b.x, y: b.y,
    minWidth: 380, minHeight: 680,
    title: 'Server Manager',
    backgroundColor: '#E9E9E9',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#E9E9E9', symbolColor: '#151515', height: 34 },
    icon: nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png')),
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });
  win.setMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // started with Windows (launch at login): stay in the tray until you click the icon
  const hidden = process.argv.includes('--hidden') && settings.tray;
  win.once('ready-to-show', () => { if (!hidden) win.show(); });
  // closing the window keeps Server Manager in the tray (Quit is in the tray menu)
  win.on('close', e => { if (settings.tray && !quitting) { e.preventDefault(); win.hide(); } });
  const remember = () => { if (!win.isMinimized() && !win.isMaximized()) { settings.bounds = win.getBounds(); saveSettings(); } };
  win.on('resized', remember); win.on('moved', remember);
  // links open in the browser, never inside the app
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', e => e.preventDefault());
}

// ---------------------------------------------------------------- tray icon (bottom right)
let tray = null, quitting = false;
const trayImg = {};
function trayImage(kind) {
  if (!trayImg[kind]) trayImg[kind] = nativeImage.createFromPath(path.join(__dirname, 'build', `tray-${kind}.png`));
  return trayImg[kind];
}
const WORDS = { restoring: 'Restoring a save', offline: 'Offline', starting: 'Starting', updating: 'Updating', online: 'Online', saving: 'Saving', backup: 'Creating backup', stopping: 'Shutting down', restarting: 'Restarting', error: 'Error', unavailable: 'Unavailable' };
function trayKind(s) {
  // grey: not set up · red: offline or error · orange: busy · green: online
  if (!s || s.conn === 'unset' || s.conn === 'connecting') return 'unset';
  if (s.conn !== 'ok') return 'off';
  if (s.pending || s.operation || ['starting', 'updating', 'saving', 'backup', 'stopping', 'restarting', 'restoring'].includes(s.status)) return 'busy';
  return s.status === 'online' ? 'online' : 'off';
}
function trayLine(s) {
  if (!s || s.conn === 'unset') return 'Not connected';
  if (s.conn !== 'ok') return 'Offline (the NAS does not answer)';
  return `${WORDS[s.status] || s.status}${s.players != null ? ` · ${s.players}/${s.maxPlayers} players` : ''}`;
}
// Opened from the tray: just above the clock, like Windows' own flyouts.
function showFromTray() {
  if (!win || win.isDestroyed()) return;
  if (win.isVisible() && win.isFocused()) { win.hide(); return; }
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const b = win.getBounds();
  win.setBounds({ x: wa.x + wa.width - b.width - 12, y: wa.y + wa.height - b.height - 12, width: b.width, height: Math.min(b.height, wa.height - 24) });
  win.show(); win.focus();
}
async function trayAction(id, action) {
  const srv = servers.get(id);
  const confirmText = { shutdown: 'Shut down the server? Players get a warning 60 and 10 seconds before, and the world is saved and checked first.', restart: 'Restart the server? Players get a warning and the world is saved and checked first.' }[action];
  if (confirmText) {
    const r = await dialog.showMessageBox({ type: 'question', buttons: ['Cancel', action === 'shutdown' ? 'Shut down' : 'Restart'], defaultId: 0, cancelId: 0, title: 'Server Manager', message: confirmText });
    if (r.response !== 1) return;
  }
  const r = srv ? await srv.run(action, { confirmed: !!confirmText }).catch(e => ({ ok: false, error: e.message })) : { ok: false, error: 'Not ready yet' };
  if (!r.ok && tray) tray.displayBalloon({ title: 'Not started', content: r.error || '', iconType: 'warning' });
}
// The icon shows the most important state of all servers: busy, then online, then offline.
const RANK = { busy: 4, online: 3, off: 2, unset: 1 };
function serverMenu(srv) {
  const s = srv.snapshot(), can = k => !!srv.allowed(k), id = srv.id;
  return [
    { label: 'Start', enabled: can('start'), click: () => trayAction(id, 'start') },
    { label: 'Save world', enabled: can('save'), click: () => trayAction(id, 'save') },
    { label: 'Create backup', enabled: can('backup'), click: () => trayAction(id, 'backup') },
    { label: 'Restart…', enabled: can('restart'), click: () => trayAction(id, 'restart') },
    { label: 'Shut down…', enabled: can('shutdown'), click: () => trayAction(id, 'shutdown') },
    { type: 'separator' },
    { label: 'Copy join command', enabled: !!s.connect, click: () => clipboard.writeText(s.connect) },
  ];
}
const nameOf = (srv, s) => (s && s.name) || `${ADAPTERS[srv.type].label.split(':')[0]} server`;
function updateTray() {
  if (!tray) return;
  const list = [...servers.values()];
  const snaps = list.map(x => x.snapshot());
  const kinds = snaps.map(trayKind);
  const top = kinds.reduce((a, k) => (RANK[k] > RANK[a] ? k : a), 'unset');
  tray.setImage(trayImage(top));
  tray.setToolTip(list.map((x, i) => `${nameOf(x, snaps[i])} · ${trayLine(snaps[i])}`).join('\n').slice(0, 127) || 'Server Manager');
  const per = list.length === 1
    ? [{ label: `${nameOf(list[0], snaps[0])}: ${trayLine(snaps[0])}`, enabled: false }, { type: 'separator' }, ...serverMenu(list[0])]
    : list.map((x, i) => ({ label: `${nameOf(x, snaps[i])}: ${trayLine(snaps[i])}`, submenu: serverMenu(x) }));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Server Manager', click: showFromTray },
    { type: 'separator' },
    ...per,
    { type: 'separator' },
    { label: 'Start with Windows', type: 'checkbox', checked: !!settings.launchAtLogin, click: m => setLaunchAtLogin(m.checked) },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
}
function setLaunchAtLogin(on) {
  settings.launchAtLogin = !!on; saveSettings();
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!on, args: ['--hidden'] });
  send('prefs', { tray: settings.tray, launchAtLogin: settings.launchAtLogin });
  updateTray();
}
function createTray() {
  if (tray || !settings.tray) return;
  tray = new Tray(trayImage('unset'));
  tray.on('click', showFromTray);
  updateTray();
}
ipcMain.handle('prefs', () => ({ tray: settings.tray, launchAtLogin: settings.launchAtLogin }));
ipcMain.handle('set-prefs', (_e, p) => {
  if (p && typeof p.tray === 'boolean') {
    settings.tray = p.tray; saveSettings();
    if (p.tray) createTray(); else if (tray) { tray.destroy(); tray = null; }
  }
  if (p && typeof p.launchAtLogin === 'boolean') setLaunchAtLogin(p.launchAtLogin);
  return { tray: settings.tray, launchAtLogin: settings.launchAtLogin };
});

// ---------------------------------------------------------------- the servers
const servers = new Map();   // id -> adapter instance

// ---------------------------------------------------------------- updates (GitHub releases)
// A new version downloads quietly and installs when you close the app, or straight away
// with "Restart to update" in Settings. Settings and the NAS key stay where they are.
let update = { state: 'idle' };
function setUpdate(p) { update = { ...update, ...p }; send('update', { ...update, current: app.getVersion(), packaged: app.isPackaged }); }
function setupUpdater() {
  if (!autoUpdater || !app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => setUpdate({ state: 'checking' }));
  autoUpdater.on('update-available', i => setUpdate({ state: 'downloading', version: i.version, percent: 0 }));
  autoUpdater.on('download-progress', p => setUpdate({ state: 'downloading', percent: Math.round(p.percent || 0) }));
  autoUpdater.on('update-downloaded', i => setUpdate({ state: 'ready', version: i.version }));
  autoUpdater.on('update-not-available', () => setUpdate({ state: 'idle', error: null }));
  autoUpdater.on('error', e => setUpdate({ state: 'idle', error: String(e && e.message || e).split('\n')[0] }));
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 5000);
  setInterval(check, 60 * 60 * 1000);
}
ipcMain.handle('update-state', () => ({ ...update, current: app.getVersion(), packaged: app.isPackaged }));
ipcMain.handle('update-check', () => { if (autoUpdater && app.isPackaged) autoUpdater.checkForUpdates().catch(() => {}); return true; });
ipcMain.handle('update-install', () => { if (autoUpdater && update.state === 'ready') autoUpdater.quitAndInstall(true, true); return true; });

function makeServer(cfg) {
  const srv = ADAPTERS[cfg.type].make({
    id: cfg.id,
    dir: app.getPath('userData'),
    getSettings: () => { const c = settings.servers.find(x => x.id === cfg.id) || {}; return { host: c.host, user: c.user }; },
    send: snap => { send('state', { id: cfg.id, state: snap }); updateTray(); },
    peek: p => send('toast', p),
    log: m => { try { fs.appendFileSync(path.join(app.getPath('userData'), 'server-manager.log'), `${new Date().toISOString()} [${cfg.id}] ${m}\n`); } catch { /* fine */ } },
  });
  servers.set(cfg.id, srv);
  return srv;
}
const listForUi = () => settings.servers.map(x => ({ id: x.id, type: x.type, typeLabel: ADAPTERS[x.type].label, host: x.host, user: x.user }));
const S = id => servers.get(id || settings.active);
const fail = { ok: false, error: 'Not ready yet' };

ipcMain.handle('init', () => ({
  servers: listForUi(), active: settings.active, version: app.getVersion(),
  states: Object.fromEntries([...servers].map(([id, x]) => [id, x.snapshot()])),
  types: Object.entries(ADAPTERS).map(([type, a]) => ({ type, label: a.label })),
}));
ipcMain.handle('set-active', (_e, id) => { if (servers.has(id)) { settings.active = id; saveSettings(); } return settings.active; });
ipcMain.handle('add-server', (_e, type) => {
  if (!ADAPTERS[type]) return { ok: false, error: 'Unknown game' };
  let n = 1; while (settings.servers.some(x => x.id === `${type}-${n}`)) n++;
  const first = settings.servers[0] || {};
  const cfg = { id: `${type}-${n}`, type, host: first.host || '', user: '' };   // same NAS by default; the user is per server
  settings.servers.push(cfg); settings.active = cfg.id; saveSettings();
  makeServer(cfg).start();
  return { ok: true, id: cfg.id, servers: listForUi() };
});
ipcMain.handle('remove-server', (_e, id) => {
  if (settings.servers.length < 2 || !servers.has(id)) return { ok: false, error: 'The last server stays' };
  servers.get(id).stop();
  servers.delete(id);
  settings.servers = settings.servers.filter(x => x.id !== id);
  if (settings.active === id) settings.active = settings.servers[0].id;
  saveSettings(); updateTray();
  return { ok: true, servers: listForUi(), active: settings.active };
});
ipcMain.handle('set-host', (_e, d) => {
  const cfg = settings.servers.find(x => x.id === (d && d.id) || x.id === settings.active && !(d && d.id));
  if (!cfg) return { ok: false, error: 'No such server' };
  const h = String((d && d.host) ?? cfg.host).trim(), u = String((d && d.user) ?? cfg.user).trim();
  if (h && !/^[a-zA-Z0-9.-]{1,253}$/.test(h)) return { ok: false, error: 'Not a valid address' };
  if (u && !/^[a-zA-Z0-9._-]{1,64}$/.test(u)) return { ok: false, error: 'Not a valid user name' };
  cfg.host = h; cfg.user = u; saveSettings(); S(cfg.id).restart();
  return { ok: true, servers: listForUi() };
});
ipcMain.handle('run', async (_e, d) => {
  const srv = S(d && d.id);
  if (!srv || typeof d.action !== 'string') return fail;
  return srv.run(d.action, { confirmed: d.confirmed === true }).catch(e => ({ ok: false, error: e.message }));
});
ipcMain.handle('backups', (_e, id) => S(id) ? S(id).listBackups() : { ok: false, backups: [] });
ipcMain.handle('restore', (_e, d) => S(d && d.id) && d ? S(d.id).restore(String(d.file || ''), { confirmed: d.confirmed === true }).catch(e => ({ ok: false, error: e.message })) : fail);
ipcMain.handle('config', (_e, d) => S(d && d.id) ? S(d.id).setConfig(String((d && d.word) || '')) : fail);
ipcMain.handle('key', async (_e, id) => {
  if (!S(id)) return fail;
  const r = await S(id).createKey().catch(e => ({ ok: false, error: e.message }));
  if (r.ok && r.command) clipboard.writeText(r.command);   // ready to paste in the NAS's SSH window
  return r;
});
ipcMain.handle('scan', (_e, id) => S(id) ? S(id).scanHost().catch(e => ({ ok: false, error: e.message })) : fail);
ipcMain.handle('trust', (_e, id) => S(id) ? S(id).trust() : fail);
ipcMain.handle('forget', (_e, id) => S(id) ? S(id).forget() : fail);
ipcMain.handle('log', (_e, id) => S(id) ? S(id).fetchLog() : '');
ipcMain.handle('copy', (_e, d) => {
  const s = S(d && d.id) && S(d.id).snapshot();
  const t = d && d.what === 'command' ? s && s.setup.command : s && s.connect;
  if (!t) return false;
  clipboard.writeText(String(t)); return true;
});

app.whenReady().then(() => {
  loadSettings();
  for (const cfg of settings.servers) makeServer(cfg);
  createWindow();
  createTray();
  for (const srv of servers.values()) srv.start();
  setupUpdater();
});
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { if (!settings.tray) app.quit(); });
