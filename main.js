// Server Manager — main process: one window, the NAS connection (ark.js) and settings.
'use strict';

const { app, BrowserWindow, ipcMain, clipboard, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { Ark } = require('./ark');
let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch { /* running from source without it */ }

app.setAppUserModelId('com.fjbc.servermanager');
if (!app.requestSingleInstanceLock()) app.quit();

// ---------------------------------------------------------------- settings
const DEFAULTS = { host: '', user: '', bounds: null };   // filled in by you in Settings
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
  win.once('ready-to-show', () => win.show());
  const remember = () => { if (!win.isMinimized() && !win.isMaximized()) { settings.bounds = win.getBounds(); saveSettings(); } };
  win.on('resized', remember); win.on('moved', remember);
  // links open in the browser, never inside the app
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', e => e.preventDefault());
}

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
    send: s => send('state', s),
    peek: p => send('toast', p),
    log: m => { try { fs.appendFileSync(path.join(app.getPath('userData'), 'server-manager.log'), `${new Date().toISOString()} ${m}\n`); } catch { /* fine */ } },
  });
  createWindow();
  ark.start();
  setupUpdater();
});
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => app.quit());
