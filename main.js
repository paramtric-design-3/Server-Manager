// Server Manager — main process: one window, the NAS connection (ark.js) and settings.
'use strict';

const { app, BrowserWindow, ipcMain, clipboard, shell, nativeImage, Tray, Menu, screen, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { Ark } = require('./ark');
let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch { /* running from source without it */ }

app.setAppUserModelId('com.fjbc.servermanager');
if (!app.requestSingleInstanceLock()) app.quit();

// ---------------------------------------------------------------- settings
const DEFAULTS = { host: '', user: '', bounds: null, tray: true, launchAtLogin: false };   // host and user: filled in by you in Settings
let settings = { ...DEFAULTS };
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
  try { settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; } catch { /* first run */ }
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
let tray = null, quitting = false, lastSnap = null;
const trayImg = {};
function trayImage(kind) {
  if (!trayImg[kind]) trayImg[kind] = nativeImage.createFromPath(path.join(__dirname, 'build', `tray-${kind}.png`));
  return trayImg[kind];
}
const WORDS = { offline: 'Offline', starting: 'Starting', updating: 'Updating', online: 'Online', saving: 'Saving', backup: 'Creating backup', stopping: 'Shutting down', restarting: 'Restarting', error: 'Error', unavailable: 'Unavailable' };
function trayKind(s) {
  if (!s || s.conn !== 'ok') return s && s.conn === 'error' ? 'error' : 'off';
  if (s.pending || s.operation || ['starting', 'updating', 'saving', 'backup', 'stopping', 'restarting'].includes(s.status)) return 'busy';
  return s.status === 'online' ? 'online' : s.status === 'error' ? 'error' : 'off';
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
async function trayAction(action) {
  const confirmText = { shutdown: 'Shut down the server? Players get a warning 60 and 10 seconds before, and the world is saved and checked first.', restart: 'Restart the server? Players get a warning and the world is saved and checked first.' }[action];
  if (confirmText) {
    const r = await dialog.showMessageBox({ type: 'question', buttons: ['Cancel', action === 'shutdown' ? 'Shut down' : 'Restart'], defaultId: 0, cancelId: 0, title: 'Server Manager', message: confirmText });
    if (r.response !== 1) return;
  }
  const r = ark ? await ark.run(action, { confirmed: !!confirmText }).catch(e => ({ ok: false, error: e.message })) : { ok: false, error: 'Not ready yet' };
  if (!r.ok && tray) tray.displayBalloon({ title: 'Not started', content: r.error || '', iconType: 'warning' });
}
function updateTray(s) {
  if (!tray) return;
  lastSnap = s;
  const name = (s && s.name) || 'Server Manager';
  tray.setImage(trayImage(trayKind(s)));
  tray.setToolTip(`${name} · ${trayLine(s)}`.slice(0, 127));
  const can = k => !!(ark && ark.allowed(k));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `${name}: ${trayLine(s)}`, enabled: false },
    { type: 'separator' },
    { label: 'Open Server Manager', click: showFromTray },
    { type: 'separator' },
    { label: 'Start', enabled: can('start'), click: () => trayAction('start') },
    { label: 'Save world', enabled: can('save'), click: () => trayAction('save') },
    { label: 'Create backup', enabled: can('backup'), click: () => trayAction('backup') },
    { label: 'Restart…', enabled: can('restart'), click: () => trayAction('restart') },
    { label: 'Shut down…', enabled: can('shutdown'), click: () => trayAction('shutdown') },
    { type: 'separator' },
    { label: 'Copy join command', enabled: !!(s && s.connect), click: () => clipboard.writeText(s.connect) },
    { label: 'Start with Windows', type: 'checkbox', checked: !!settings.launchAtLogin, click: m => setLaunchAtLogin(m.checked) },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
}
function setLaunchAtLogin(on) {
  settings.launchAtLogin = !!on; saveSettings();
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!on, args: ['--hidden'] });
  send('prefs', { tray: settings.tray, launchAtLogin: settings.launchAtLogin });
  updateTray(lastSnap);
}
function createTray() {
  if (tray || !settings.tray) return;
  tray = new Tray(trayImage('off'));
  tray.on('click', showFromTray);
  updateTray(ark ? ark.snapshot() : null);
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

// ---------------------------------------------------------------- the NAS
let ark = null;
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

ipcMain.handle('init', () => ({ settings: { host: settings.host, user: settings.user }, state: ark ? ark.snapshot() : null, version: app.getVersion() }));
ipcMain.handle('set-host', (_e, d) => {
  const h = String((d && d.host) ?? settings.host).trim(), u = String((d && d.user) ?? settings.user).trim();
  if (h && !/^[a-zA-Z0-9.-]{1,253}$/.test(h)) return { ok: false, error: 'Not a valid address' };
  if (u && !/^[a-zA-Z0-9._-]{1,64}$/.test(u)) return { ok: false, error: 'Not a valid user name' };
  settings.host = h; settings.user = u; saveSettings(); if (ark) ark.restart();
  return { ok: true };
});
ipcMain.handle('run', async (_e, d) => {
  if (!ark || !d || typeof d.action !== 'string') return { ok: false, error: 'Not ready yet' };
  return ark.run(d.action, { confirmed: d.confirmed === true }).catch(e => ({ ok: false, error: e.message }));
});
ipcMain.handle('config', (_e, word) => ark ? ark.setConfig(String(word || '')) : { ok: false, error: 'Not ready yet' });
ipcMain.handle('key', async () => {
  if (!ark) return { ok: false, error: 'Not ready yet' };
  const r = await ark.createKey().catch(e => ({ ok: false, error: e.message }));
  if (r.ok && r.command) clipboard.writeText(r.command);   // ready to paste in the NAS's SSH window
  return r;
});
ipcMain.handle('scan', () => ark ? ark.scanHost().catch(e => ({ ok: false, error: e.message })) : { ok: false });
ipcMain.handle('trust', () => ark ? ark.trust() : { ok: false });
ipcMain.handle('forget', () => ark ? ark.forget() : { ok: false });
ipcMain.handle('log', () => ark ? ark.fetchLog() : '');
ipcMain.handle('refresh', () => { if (ark) { ark.histAt = 0; ark.schedule(50); } return true; });
ipcMain.handle('copy', (_e, what) => {
  const s = ark && ark.snapshot();
  const t = what === 'command' ? s && s.setup.command : s && s.connect;
  if (!t) return false;
  clipboard.writeText(String(t)); return true;
});

app.whenReady().then(() => {
  loadSettings();
  ark = new Ark({
    dir: app.getPath('userData'),
    getSettings: () => ({ host: settings.host, user: settings.user }),
    send: s => { send('state', s); updateTray(s); },
    peek: p => send('toast', p),
    log: m => { try { fs.appendFileSync(path.join(app.getPath('userData'), 'server-manager.log'), `${new Date().toISOString()} ${m}\n`); } catch { /* fine */ } },
  });
  createWindow();
  createTray();
  ark.start();
  setupUpdater();
});
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { if (!settings.tray) app.quit(); });
