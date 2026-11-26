// Server Manager — adapter for an ARK: Survival Evolved server on a NAS, straight over SSH.
// One instance per server. It talks to ark-ctl on the NAS; other games get their own adapter
// with the same methods (snapshot, run, restore, listBackups, setConfig, fetchLog, ...).
// Server Manager runs one program on the NAS: ark-ctl, through its own SSH key that the NAS restricts to
// that script (and to this PC's IP address). ark-ctl does the real work: the lock, the safe
// shutdown, the save and backup checks. The automations (shutdown when empty, morning backup
// check, update check, scheduled start) run on the NAS itself, so they also work with this PC off.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ACTIONS = new Set(['start', 'save', 'backup', 'shutdown', 'restart', 'update', 'checkupdate', 'verify']);
const NEEDS_CONFIRM = new Set(['shutdown', 'restart', 'update']);
const STATUSES = new Set(['offline', 'starting', 'updating', 'online', 'saving', 'backup', 'stopping', 'restarting', 'restoring', 'error']);
const CONFIG_RE = /^(autoshutdown-on|autoshutdown-off|idle-(15|30|45|60|75|90|105|120|135|150|165|180|195|210|225|240)|start-off|start-([01][0-9]|2[0-3])[0-5][0-9])$/;
const HISTORY_MS = 24 * 3600 * 1000;

// Windows ships OpenSSH in System32; elsewhere (tests) use the one on PATH.
function bin(name) {
  if (process.platform !== 'win32') return name;
  const p = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', name + '.exe');
  return fs.existsSync(p) ? p : name;
}
const time = s => { if (!s) return null; const t = Date.parse(s); return Number.isFinite(t) ? t : null; };
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

class Ark {
  constructor({ id = 'ark-1', dir, send, peek, log, getSettings, runImpl }) {
    this.id = id;
    this.type = 'ark';
    this.dir = path.join(dir, 'ark-ssh');
    this.key = path.join(this.dir, 'id_ed25519');
    this.known = path.join(this.dir, 'known_hosts');
    // the first server keeps the history file it had before servers became a list
    this.histFile = path.join(dir, id === 'ark-1' ? 'ark-history.json' : `history-${id}.json`);
    this.histAt = 0;                       // when the NAS history was last fetched
    this.logText = '';
    this.send = send;
    this.peek = peek || (() => {});
    this.log = log || (() => {});
    this.settings = getSettings;           // () => settings.ark: { host, user }
    this.runImpl = runImpl || null;        // tests: (args) => Promise<{ code, out, err }>
    this.j = null;                         // last status JSON from the NAS
    this.conn = 'unset';
    this.error = null;
    this.pending = null;                   // { action, until }
    this.scan = null;                      // host key line waiting to be trusted
    this.history = this.loadHistory();
    this.timer = null;
    this.busy = false;
  }

  // ------------------------------------------------------------ settings and files
  cfg() {
    const s = this.settings() || {};
    return { host: String(s.host || '').trim(), user: String(s.user || '').trim() };
  }
  hasKey() { return fs.existsSync(this.key) && fs.existsSync(this.key + '.pub'); }
  // known_hosts is shared by all servers: one line (or more) per NAS address
  knownLines() { try { return fs.readFileSync(this.known, 'utf8').split('\n').filter(Boolean); } catch { return []; } }
  hostOf(line) { return line.split(' ')[0].replace(/^\[|\](:\d+)?$/g, ''); }
  trusted() { const { host } = this.cfg(); return !!host && this.knownLines().some(l => this.hostOf(l) === host); }
  ready() { const { host, user } = this.cfg(); return !!host && !!user && this.hasKey() && this.trusted(); }
  validHost(h) { return /^[a-zA-Z0-9.-]{1,253}$/.test(h); }

  // The address of this PC as the NAS sees it: the local IPv4 in the same /24 as the NAS.
  pcAddress() {
    const { host } = this.cfg();
    const pre = /^\d+\.\d+\.\d+\./.test(host) ? host.split('.').slice(0, 3).join('.') + '.' : null;
    const all = Object.values(os.networkInterfaces()).flat().filter(a => a && a.family === 'IPv4' && !a.internal);
    const hit = (pre && all.find(a => a.address.startsWith(pre))) || all[0];
    return hit ? hit.address : 'PC_IP';
  }
  nasCommand() {
    if (!this.hasKey()) return '';
    const pub = fs.readFileSync(this.key + '.pub', 'utf8').trim();
    const opts = `from="${this.pcAddress()}",command="sudo -n /usr/local/bin/ark-ctl \\"\${SSH_ORIGINAL_COMMAND:-status}\\"",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty`;
    return `echo '${opts} ${pub}' | sudo tee -a /var/services/homes/${this.cfg().user}/.ssh/authorized_keys`;
  }

  // ------------------------------------------------------------ running programs
  exec(file, args, timeoutMs = 30000) {
    return new Promise(resolve => {
      let out = '', err = '', done = false;
      let p;
      try { p = spawn(file, args, { windowsHide: true }); } catch (e) { resolve({ code: -1, out: '', err: e.message }); return; }
      const t = setTimeout(() => { if (!done) { try { p.kill(); } catch { /* gone */ } } }, timeoutMs);
      p.stdout.on('data', d => { out += d; if (out.length > 200000) out = out.slice(-200000); });
      p.stderr.on('data', d => { err += d; });
      p.on('error', e => { if (done) return; done = true; clearTimeout(t); resolve({ code: -1, out, err: e.message }); });
      p.on('close', code => { if (done) return; done = true; clearTimeout(t); resolve({ code: code == null ? -1 : code, out, err }); });
    });
  }
  ssh(action, timeoutMs = 30000) {
    if (this.runImpl) return this.runImpl([action]);
    const { host, user } = this.cfg();
    return this.exec(bin('ssh'), [
      '-i', this.key, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6',
      '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile="${this.known}"`, '-o', 'GlobalKnownHostsFile=none',
      '-o', 'LogLevel=ERROR', `${user}@${host}`, action,
    ], timeoutMs);
  }

  // ------------------------------------------------------------ setup (Settings)
  async createKey() {
    if (!this.cfg().user || !this.validHost(this.cfg().host)) return { ok: false, error: 'Enter the NAS address and user first' };
    fs.mkdirSync(this.dir, { recursive: true });
    if (!this.hasKey()) {
      const r = await this.exec(bin('ssh-keygen'), ['-q', '-t', 'ed25519', '-N', '', '-C', `server-manager@${os.hostname()}`, '-f', this.key]);
      if (r.code !== 0 || !this.hasKey()) return { ok: false, error: (r.err || r.out || 'ssh-keygen failed').trim().split('\n')[0] };
    }
    this.restart();
    return { ok: true, command: this.nasCommand() };
  }
  async scanHost() {
    const { host } = this.cfg();
    if (!this.validHost(host)) return { ok: false, error: 'Enter the NAS address first' };
    const r = await this.exec(bin('ssh-keyscan'), ['-t', 'ed25519', '-T', '5', host], 15000);
    const line = (r.out || '').split('\n').find(l => / ssh-ed25519 /.test(l));
    if (!line) return { ok: false, error: 'The NAS did not answer on SSH (port 22)' };
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = path.join(this.dir, 'scan.tmp');
    fs.writeFileSync(tmp, line.trim() + '\n');
    const f = await this.exec(bin('ssh-keygen'), ['-lf', tmp]);
    fs.rmSync(tmp, { force: true });
    const fp = ((f.out || '').match(/SHA256:\S+/) || [])[0];
    if (!fp) return { ok: false, error: 'Could not read the fingerprint' };
    this.scan = line.trim();
    return { ok: true, fingerprint: fp };
  }
  trust() {
    if (!this.scan) return { ok: false, error: 'Check the NAS key first' };
    fs.mkdirSync(this.dir, { recursive: true });
    const host = this.hostOf(this.scan);
    const keep = this.knownLines().filter(l => this.hostOf(l) !== host);
    fs.writeFileSync(this.known, [...keep, this.scan].join('\n') + '\n');
    this.scan = null;
    this.restart();
    return { ok: true };
  }
  // Forget this NAS's key (other servers and this PC's own key stay)
  forget() {
    const { host } = this.cfg();
    try { fs.writeFileSync(this.known, this.knownLines().filter(l => this.hostOf(l) !== host).join('\n') + '\n'); } catch { /* fine */ }
    this.j = null;
    this.restart();
    return { ok: true };
  }

  // ------------------------------------------------------------ polling
  start() { this.schedule(500); }
  restart() { clearTimeout(this.timer); this.conn = 'unset'; this.error = null; this.emit(); this.schedule(300); }
  schedule(ms) { clearTimeout(this.timer); if (!this.stopped) this.timer = setTimeout(() => this.poll(), ms); }
  stop() { this.stopped = true; clearTimeout(this.timer); clearTimeout(this.emitTimer); }
  async poll() {
    if (this.busy) return;
    if (!this.ready()) { this.conn = 'unset'; this.emit(); this.schedule(5000); return; }
    this.busy = true;
    if (this.conn === 'unset') { this.conn = 'connecting'; this.emit(); }
    // first contact (or after a failure): 10 seconds, then it counts as offline; once connected
    // a status may take longer while the NAS is busy (docker stats, RCON)
    const r = await this.ssh('status', this.conn === 'ok' ? 40000 : 10000);
    this.busy = false;
    let j = null;
    try { j = JSON.parse((r.out || '').trim().split('\n').pop()); } catch { /* not JSON */ }
    if (r.code === 0 && j && typeof j.status === 'string') {
      this.conn = 'ok'; this.error = null;
      this.update(j);
      if (Date.now() - this.histAt > 5 * 60 * 1000) this.fetchHistory();
    } else {
      const e = (r.err || '').trim();
      if (/host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(e)) { this.conn = 'auth'; this.error = 'The NAS key changed. Check it again in Settings before you trust it.'; }
      else if (/permission denied/i.test(e)) { this.conn = 'auth'; this.error = 'The NAS refused this PC\'s key. Paste the NAS command from Settings on the NAS.'; }
      else if (/sudo|password is required/i.test(r.out + e)) { this.conn = 'error'; this.error = 'The NAS key works, but sudo refused ark-ctl (check /etc/sudoers.d/ark-ctl)'; }
      else { this.conn = 'error'; this.error = r.code === null || r.code === -1 || /timed out/i.test(e) || !e ? 'The NAS did not answer within 10 seconds' : 'The NAS does not answer over SSH'; }
      if (r.code !== 0) this.log(`ark ssh ${r.code}: ${e.split('\n')[0]}`);
      this.emit();
    }
    const fast = this.pending || (this.j && this.j.op) || (this.j && ['starting', 'updating', 'saving', 'backup', 'stopping', 'restarting'].includes(this.j.status));
    this.schedule(this.conn === 'ok' ? (fast ? 4000 : 12000) : 30000);
  }

  update(j) {
    const prev = this.j;
    this.j = j;
    if (this.pending && (j.op || Date.now() > this.pending.until)) this.pending = null;
    // players history for the graph (null = unknown)
    const v = num(j.players);
    const last = this.history[this.history.length - 1];
    if (!last || last.v !== v || Date.now() - last.t > 10 * 60 * 1000) {
      this.history.push({ t: Date.now(), v });
      const cut = Date.now() - HISTORY_MS;
      while (this.history.length > 2 && this.history[1].t < cut) this.history.shift();
      this.saveHistory();
    }
    // a finished operation reports its own result
    if (prev && num(j.seq) != null && (num(prev.seq) == null || j.seq > prev.seq)) {
      const r = j.last_result;
      this.peek({ title: `${j.session_name || 'Server'} ${j.last_op}: ${r === 'ok' ? 'done' : r}`, sub: j.last_message || '' });
    } else if (prev && prev.status === 'online' && (j.status === 'offline' || j.status === 'error') && !j.op && !prev.op) {
      this.peek({ title: `${j.session_name || 'The server'} stopped`, sub: j.message || 'It was not stopped from Server Manager' });
    }
    this.emit();
  }

  // The NAS records the players every 5 minutes (ark-ctl tick), also while this PC is off.
  async fetchHistory() {
    this.histAt = Date.now();
    const r = await this.ssh('history', 20000);
    try {
      const pts = JSON.parse((r.out || '').trim().split('\n').pop()).points;
      if (Array.isArray(pts) && pts.length >= 2) {
        this.history = pts.filter(p => Array.isArray(p) && Number.isFinite(p[0])).map(p => ({ t: p[0] * 1000, v: num(p[1]) })).sort((a, b) => a.t - b.t);
        if (this.j) this.history.push({ t: Date.now(), v: num(this.j.players) });
        this.saveHistory(); this.emit();
      }
    } catch { /* keep the local history */ }
  }
  async fetchLog() {
    if (this.conn !== 'ok') return '';
    const r = await this.ssh('log', 20000);
    this.logText = r.code === 0 ? (r.out || '').trim() : '';
    return this.logText;
  }

  loadHistory() {
    try {
      const h = JSON.parse(fs.readFileSync(this.histFile, 'utf8'));
      const cut = Date.now() - HISTORY_MS;
      return Array.isArray(h) ? h.filter(x => x && Number.isFinite(x.t) && x.t > cut) : [];
    } catch { return []; }
  }
  saveHistory() {
    clearTimeout(this.histTimer);
    this.histTimer = setTimeout(() => { try { fs.writeFileSync(this.histFile, JSON.stringify(this.history)); } catch { /* fine */ } }, 2000);
  }

  // ------------------------------------------------------------ what the tile and settings show
  snapshot() {
    const j = this.j || {};
    if (this.pending && Date.now() > this.pending.until) this.pending = null;
    const st = String(j.status || '');
    return {
      id: this.id, type: this.type,
      conn: this.conn,
      error: this.error,
      setup: { host: this.cfg().host, user: this.cfg().user, hasKey: this.hasKey(), trusted: this.trusted(), command: this.hasKey() ? this.nasCommand() : '' },
      status: this.conn === 'ok' && STATUSES.has(st) ? st : 'unavailable',
      message: j.message || '',
      operation: j.op || '',
      step: j.step || '', stepStarted: num(j.step_started) != null ? j.step_started * 1000 : null,
      stepUntil: num(j.step_until) != null ? j.step_until * 1000 : null,
      opStarted: num(j.op_started) != null ? j.op_started * 1000 : null, detail: j.detail || '',
      players: num(j.players),
      maxPlayers: num(j.max_players) || 5,
      cpu: num(j.cpu),
      memGb: num(j.memory_mb) != null ? j.memory_mb / 1024 : null,
      cpus: num(j.cpus) || 4,
      nasMemTotalGb: num(j.nas_mem_total_mb) != null ? j.nas_mem_total_mb / 1024 : null,
      nasMemUsedGb: num(j.nas_mem_used_mb) != null ? j.nas_mem_used_mb / 1024 : null,
      nasLoad: num(j.nas_load),
      started: time(j.started),
      backupMb: num(j.last_backup_mb), backupTotalMb: num(j.backup_total_mb), backupLimitMb: num(j.backup_limit_mb), freeGb: num(j.free_gb),
      lastSave: time(j.last_save),
      lastBackup: time(j.last_backup),
      lastResult: j.last_result || '', lastMessage: j.last_message || '', lastOp: j.last_op || '',
      updateAvailable: j.update_available === true,
      build: j.build || '',
      connect: j.connect || '',
      name: j.session_name || '', map: j.map || '',
      auto: { shutdown: j.auto_shutdown === true, idleMinutes: num(j.idle_minutes) || 60, idleSince: time(j.idle_since), startAt: j.start_at || '', lastTick: time(j.last_tick) },
      history: this.history.slice(-400),
      pending: this.pending ? this.pending.action : null,
    };
  }
  emit() {
    clearTimeout(this.emitTimer);
    this.emitTimer = setTimeout(() => this.send(this.snapshot()), 40);
  }

  // ------------------------------------------------------------ actions
  allowed(action) {
    if (this.conn !== 'ok' || !this.j || this.pending || this.j.op) return false;
    const st = this.j.status;
    if (action === 'start') return st === 'offline' || st === 'error';
    if (action === 'verify' || action === 'checkupdate') return true;
    return st === 'online';
  }
  // Previous saves: the backups on the NAS, newest first
  async listBackups() {
    if (this.conn !== 'ok') return { ok: false, backups: [] };
    const r = await this.ssh('backups', 20000);
    try { return { ok: true, backups: JSON.parse((r.out || '').trim().split('\n').pop()).backups || [] }; } catch { return { ok: false, backups: [] }; }
  }
  // Put a backup back: only with the server off and after confirmation; the NAS keeps the current world
  async restore(file, { confirmed = false } = {}) {
    if (!confirmed) return { ok: false, error: 'Needs confirmation' };
    if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(String(file)) || String(file).includes('..')) return { ok: false, error: 'Not a backup file' };
    if (this.conn !== 'ok' || !this.j || this.pending || this.j.op) return { ok: false, error: this.j && this.j.op ? `${this.j.op} is still running` : 'Not connected to the NAS' };
    if (!(this.j.status === 'offline' || this.j.status === 'error')) return { ok: false, error: 'Shut the server down first' };
    this.pending = { action: 'restore', until: Date.now() + 30000 };
    this.emit();
    const r = await this.ssh(`restore ${file}`, 30000);
    const out = (r.out || '').trim();
    if (r.code === 0 && /^OK\b/.test(out)) { this.schedule(1500); return { ok: true }; }
    this.pending = null; this.emit(); this.schedule(500);
    return { ok: false, error: out.replace(/^(REFUSED|BUSY)\s*/, '') || (r.err || '').trim().split('\n')[0] || 'The NAS did not answer' };
  }
  async run(action, { confirmed = false } = {}) {
    if (!ACTIONS.has(action)) return { ok: false, error: 'Unknown action' };
    if (NEEDS_CONFIRM.has(action) && !confirmed) return { ok: false, error: 'Needs confirmation' };
    if (!this.allowed(action)) return { ok: false, error: this.pending ? `${this.pending.action} was just asked for` : this.j && this.j.op ? `${this.j.op} is still running` : this.conn !== 'ok' ? (this.error || 'Not connected to the NAS') : `Not possible while the server is ${this.j ? this.j.status : 'unknown'}` };
    this.pending = { action, until: Date.now() + 30000 };
    this.emit();
    const r = await this.ssh(action, 30000);
    const out = (r.out || '').trim();
    if (r.code === 0 && /^OK\b/.test(out)) { this.schedule(1500); return { ok: true }; }
    this.pending = null; this.emit(); this.schedule(500);
    if (r.code === 75) return { ok: false, error: out.replace(/^BUSY\s*/, '') + ': wait until it is done' };
    return { ok: false, error: out || (r.err || '').trim().split('\n')[0] || 'The NAS did not answer' };
  }
  async setConfig(word) {
    if (!CONFIG_RE.test(String(word))) return { ok: false, error: 'Not a valid setting' };
    if (this.conn !== 'ok') return { ok: false, error: this.error || 'Not connected to the NAS' };
    const r = await this.ssh(word, 20000);
    this.schedule(300);
    return r.code === 0 && /^OK\b/.test((r.out || '').trim()) ? { ok: true } : { ok: false, error: (r.out || r.err || 'Refused').trim().split('\n')[0] };
  }
}

module.exports = { Ark, CONFIG_RE };
