'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const ON = new Set(['state', 'toast', 'update', 'prefs']);
const INVOKE = new Set(['init', 'set-host', 'run', 'config', 'key', 'scan', 'trust', 'forget', 'log', 'copy', 'update-state', 'update-check', 'update-install', 'prefs', 'set-prefs', 'backups', 'restore', 'set-active', 'add-server', 'remove-server', 'open-ssh', 'set-ssh-user']);

contextBridge.exposeInMainWorld('sm', {
  on: (ch, cb) => { if (ON.has(ch)) ipcRenderer.on(ch, (_e, d) => cb(d)); },
  invoke: (ch, d) => INVOKE.has(ch) ? ipcRenderer.invoke(ch, d) : Promise.reject(new Error('blocked')),
});
