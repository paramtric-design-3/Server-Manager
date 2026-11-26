# Server Manager

A small Windows app for an ARK: Survival Evolved server on a NAS (hermsi/ark-server in Docker, controlled by `ark-ctl`): status, players, a 24-hour player graph, ARK's CPU and memory, the last world save, and Start, Save, Shut down, Restart and Backup. Nothing about your own setup is in this repo: the NAS address and user are entered in Settings and stored on your PC, and the server name, map and join command come from the NAS. Settings hold the connection, the automations on the NAS, the game update, the backup check, the join command and the NAS log.

It talks to the NAS the same way as BJ: Windows' own OpenSSH, with a key the app creates itself. The NAS limits that key to `/usr/local/bin/ark-ctl` and to this PC's IP address. `ark-ctl` does the real work (lock, countdown, verified save, tar-checked backups); the automations run on the NAS through DSM's Task Scheduler.

Run from source: `npm install`, then `npm start`. Build: `npm run dist` (on Windows this also makes the installer; on Linux the NSIS installer needs Wine, `--win zip` does not).

## Updates

Installed copies update themselves from this repo's releases: they check at start and every hour, download a new version quietly and install it when you close the app (or straight away with **Restart to update** in Settings). Settings and the NAS key stay where they are.

To publish a new version: raise `"version"` in `package.json`, commit and push to `main`. The **Release** GitHub Action builds the installer on Windows and publishes it as release `vX.Y.Z`.

## Servers and adapters

The app keeps a list of servers (Settings is per server; the PC's key, the tray and the Windows settings are shared). Each game type is an adapter in `adapters/` with the same methods: `start`, `stop`, `snapshot`, `run`, `allowed`, `listBackups`, `restore`, `setConfig`, `fetchLog`, `createKey`, `scanHost`, `trust`, `forget`. `adapters/ark.js` talks to `ark-ctl` on the NAS. To add a game, write its adapter and register it in `ADAPTERS` in `main.js`.
