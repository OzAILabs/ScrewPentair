/*
 * pool-dashboard server
 * - Mirrors njsPC state (socket.io client + REST refresh)
 * - Logs one sample/minute to SQLite (temps, pump rpm/watts, chlorinator)
 * - Serves the SPA, live updates over SSE, and a same-origin proxy to njsPC
 */
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { exec } = require('child_process');
const express = require('express');
const { io } = require('socket.io-client');
const { DatabaseSync } = require('node:sqlite');

const APP_DIR = __dirname;
const CFG_PATH = path.join(APP_DIR, 'dashconfig.json');
const DEFAULT_CFG = { njspcUrl: 'http://127.0.0.1:4200', port: 8080, kwhRate: 0.15, sampleSeconds: 60 };

function loadCfg() {
  try { return { ...DEFAULT_CFG, ...JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')) }; }
  catch { return { ...DEFAULT_CFG }; }
}
function saveCfg(cfg) { fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2)); }
let cfg = loadCfg();

/* ---------------- SQLite ---------------- */
const db = new DatabaseSync(path.join(APP_DIR, 'data.sqlite'));
db.exec(`CREATE TABLE IF NOT EXISTS samples (
  ts INTEGER PRIMARY KEY,
  poolTemp REAL, airTemp REAL,
  rpm REAL, watts REAL,
  chlorPct REAL, saltPpm REAL
)`);
// cpuTemp added after v1; ignore the error when the column already exists
try { db.exec('ALTER TABLE samples ADD COLUMN cpuTemp REAL'); } catch { /* already there */ }
const insSample = db.prepare(
  'INSERT OR REPLACE INTO samples (ts, poolTemp, airTemp, rpm, watts, chlorPct, saltPpm, cpuTemp) VALUES (?,?,?,?,?,?,?,?)');
const qSince = db.prepare('SELECT COUNT(*) AS n, SUM(watts) AS sumWatts FROM samples WHERE ts >= ? AND watts > 0');

/* Retention: keep a year of minute samples (~525k rows, a few tens of MB).
   ts is INTEGER PRIMARY KEY, so range scans and the purge are both cheap. */
const RETAIN_DAYS = 365;
const qPurge = db.prepare('DELETE FROM samples WHERE ts < ?');
function purgeOld() {
  const cutoff = Date.now() - RETAIN_DAYS * 24 * 3600 * 1000;
  const info = qPurge.run(cutoff);
  if (info.changes) console.log(`retention: purged ${info.changes} samples older than ${RETAIN_DAYS}d`);
}
purgeOld();
setInterval(purgeOld, 24 * 3600 * 1000);

/* ---------------- njsPC state mirror ---------------- */
let state = null;            // last full /state/all payload
let config = null;           // last full /config/all payload (pump speed programs live here)
let rs485 = null;            // last /state/rs485Port/0 stats
let njspcOk = false;
let lastStateAt = 0;

async function refreshState() {
  try {
    const [rs, rc, rp] = await Promise.all([
      fetch(cfg.njspcUrl + '/state/all', { signal: AbortSignal.timeout(8000) }),
      fetch(cfg.njspcUrl + '/config/all', { signal: AbortSignal.timeout(8000) }),
      fetch(cfg.njspcUrl + '/state/rs485Port/0', { signal: AbortSignal.timeout(8000) }).catch(() => null)
    ]);
    if (!rs.ok) throw new Error('http ' + rs.status);
    state = await rs.json();
    if (rc.ok) config = await rc.json();
    if (rp && rp.ok) rs485 = await rp.json();
    njspcOk = true;
    lastStateAt = Date.now();
    broadcast();
  } catch (e) {
    njspcOk = false;
    broadcast();
  }
}

let refreshTimer = null;
function scheduleRefresh() {          // debounce bursts of socket events
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => { refreshTimer = null; refreshState(); }, 750);
}

const sock = io(cfg.njspcUrl, { reconnection: true, reconnectionDelay: 2000 });
['controller', 'temps', 'body', 'circuit', 'feature', 'pump', 'chlorinator',
 'schedule', 'equipment', 'config', 'lightGroup'].forEach(ev => sock.on(ev, scheduleRefresh));
sock.on('connect', scheduleRefresh);
sock.on('disconnect', () => { njspcOk = false; broadcast(); });
setInterval(refreshState, 30000);
refreshState();

/* ---------------- summarized view the UI consumes ---------------- */
function circuitName(circuitId) {
  const pools = [];
  if (state) { pools.push(state.circuits || [], state.features || [], state.virtualCircuits || []); }
  if (config) { pools.push(config.circuits || [], config.features || []); }
  for (const list of pools) {
    const hit = list.find(c => c.id === circuitId);
    if (hit && hit.name) return hit.name;
  }
  return 'Circuit ' + circuitId;
}

function pumpPrograms(pump) {
  // The pump's circuit-speed table (what the panel actually drives the pump with).
  // Edited via PUT /config/pumpCircuit {pumpId, circuitId, speed|flow}.
  if (!pump || !config || !Array.isArray(config.pumps)) return [];
  const cp = config.pumps.find(p => p.id === pump.id);
  if (!cp || !Array.isArray(cp.circuits)) return [];
  return cp.circuits.map(pc => ({
    circuitId: pc.circuit,
    name: circuitName(pc.circuit),
    units: (pc.units && (pc.units.name || pc.units.desc)) || 'rpm',
    speed: pc.speed != null ? pc.speed : null,
    flow: pc.flow != null ? pc.flow : null
  }));
}

function summarize() {
  const s = state || {};
  const body = (s.temps && s.temps.bodies && s.temps.bodies[0]) || null;
  const pump = (s.pumps && s.pumps[0]) || null;
  const chlor = (s.chlorinators && s.chlorinators[0]) || null;
  // The main Pool circuit (body.circuit, e.g. id 6 on EasyTouch) is flagged
  // showInFeatures:false by the panel — surface it explicitly for the hero button.
  const poolCirc = body && (s.circuits || []).find(c => c.id === body.circuit) || null;
  return {
    connected: njspcOk,
    lastStateAt,
    model: (s.equipment && s.equipment.model) || 'unknown',
    status: (s.status && s.status.desc) || 'unknown',
    airTemp: s.temps ? s.temps.air : null,
    units: (s.temps && s.temps.units && s.temps.units.name) || 'F',
    body: body && { name: body.name,
                    // body.temp only reports while the pump circulates; fall back to the raw water sensor
                    temp: body.temp != null ? body.temp : (s.temps ? s.temps.waterSensor1 : null),
                    tempIsLive: body.temp != null,
                    setPoint: body.setPoint, isOn: body.isOn,
                    heatMode: body.heatMode && body.heatMode.desc, heatStatus: body.heatStatus && body.heatStatus.desc },
    poolCircuit: poolCirc && { id: poolCirc.id, name: poolCirc.name, isOn: !!poolCirc.isOn },
    pump: pump && { id: pump.id, name: pump.name, rpm: pump.rpm || 0, watts: pump.watts || 0,
                    flow: pump.flow || null, status: pump.status && pump.status.desc },
    pumpPrograms: pumpPrograms(pump),
    chlorinator: chlor && { id: chlor.id, name: chlor.name, poolSetpoint: chlor.poolSetpoint,
                            currentOutput: chlor.currentOutput, saltLevel: chlor.saltLevel,
                            superChlor: chlor.superChlor, status: chlor.status && chlor.status.desc },
    circuits: (s.circuits || []).filter(c => c.showInFeatures !== false).map(c => ({
      id: c.id, name: c.name, isOn: !!c.isOn,
      isLight: !!(c.type && (c.type.isLight || /light|intellibrite|colorlogic|magicstream/i.test(c.type.desc || c.type.name || ''))),
      typeDesc: c.type && (c.type.desc || c.type.name),
      lightingTheme: c.lightingTheme && { val: c.lightingTheme.val, desc: c.lightingTheme.desc }
    })),
    features: (s.features || []).map(f => ({ id: f.id, name: f.name, isOn: !!f.isOn })),
    // Config is the editable truth (plain minute/bitmask fields); state adds isOn.
    schedules: ((config && config.schedules) || []).filter(sc => sc.isActive !== false).map(sc => {
      const st = (s.schedules || []).find(x => x.id === sc.id) || {};
      return { id: sc.id, circuitId: sc.circuit, circuit: circuitName(sc.circuit),
               startTime: sc.startTime, endTime: sc.endTime,
               daysVal: sc.scheduleDays, heatSource: sc.heatSource,
               isOn: !!st.isOn };
    }),
    kwhRate: cfg.kwhRate,
    rs485: rs485 && rs485.received ? {
      isOpen: !!rs485.isOpen,
      packets: rs485.received.success,
      failed: rs485.received.failed,
      collisions: rs485.received.collisions,
      failureRate: rs485.received.failureRate,
      sentRetries: rs485.sent ? rs485.sent.retries : 0
    } : null
  };
}

/* ---------------- sampler ---------------- */
async function takeSample() {
  // Pi temperature is logged even when the panel is unreachable — the whole
  // point is spotting a thermal trend inside the enclosure.
  const zones = await readThermal();
  const cpuZone = zones.find(z => z.name === 'cpu') || zones[0];
  const cpuTemp = cpuZone ? cpuZone.c : null;
  const n = x => (typeof x === 'number' && isFinite(x) ? x : null);
  if (!state) {
    if (cpuTemp != null) insSample.run(Date.now(), null, null, null, null, null, null, cpuTemp);
    return;
  }
  const v = summarize();
  insSample.run(Date.now(),
    n(v.body && v.body.temp), n(v.airTemp),
    n(v.pump && v.pump.rpm), n(v.pump && v.pump.watts),
    n(v.chlorinator && v.chlorinator.poolSetpoint),
    n(v.chlorinator && v.chlorinator.saltLevel),
    n(cpuTemp));
}
setInterval(takeSample, (cfg.sampleSeconds || 60) * 1000);

/* ---------------- Orange Pi health ----------------
   Everything comes from /proc and /sys (no root, no polling cost).
   CPU% needs two samples, so it runs on a timer and the endpoint reads
   the last computed value. */
async function readText(p) {
  try { return (await fsp.readFile(p, 'utf8')).trim(); } catch { return null; }
}
const num = v => (v == null || v === '' || isNaN(Number(v)) ? null : Number(v));

let prevCpu = null, cpuPct = null, cpuCores = [];
async function sampleCpu() {
  const txt = await readText('/proc/stat');
  if (!txt) return;
  const rows = txt.split('\n').filter(l => /^cpu\d*\s/.test(l)).map(l => {
    const p = l.trim().split(/\s+/);
    const v = p.slice(1).map(Number);
    return { name: p[0], idle: (v[3] || 0) + (v[4] || 0), total: v.reduce((a, b) => a + b, 0) };
  });
  if (prevCpu) {
    const pct = {};
    for (const cur of rows) {
      const prev = prevCpu.find(x => x.name === cur.name);
      if (!prev) continue;
      const dTot = cur.total - prev.total, dIdle = cur.idle - prev.idle;
      pct[cur.name] = dTot > 0 ? Math.max(0, Math.min(100, (100 * (dTot - dIdle)) / dTot)) : 0;
    }
    if (pct.cpu != null) cpuPct = pct.cpu;
    cpuCores = Object.keys(pct).filter(k => k !== 'cpu').sort()
      .map(k => Math.round(pct[k] * 10) / 10);
  }
  prevCpu = rows;
}
setInterval(sampleCpu, 5000);
sampleCpu();

// WiFi details need `iw`; sample slowly and cache (spawning is costly on an H618)
let wifiExtra = { ssid: null, bitrate: null, freq: null };
function sampleWifi() {
  exec('iw dev wlan0 link', { timeout: 4000 }, (err, out) => {
    if (err || !out) return;
    const ssid = out.match(/SSID:\s*(.+)/);
    const rate = out.match(/tx bitrate:\s*([\d.]+)\s*MBit/);
    const freq = out.match(/freq:\s*([\d.]+)/);
    wifiExtra = {
      ssid: ssid ? ssid[1].trim() : null,
      bitrate: rate ? Number(rate[1]) : null,
      freq: freq ? Number(freq[1]) : null
    };
  });
}
setInterval(sampleWifi, 30000);
sampleWifi();

// Thermal trip points are fixed per SoC — read once
let tripPassive = 85, tripCritical = 100;
(async () => {
  for (let i = 0; i < 6; i++) {
    const t = await readText(`/sys/class/thermal/thermal_zone0/trip_point_${i}_type`);
    const v = num(await readText(`/sys/class/thermal/thermal_zone0/trip_point_${i}_temp`));
    if (!t || v == null) continue;
    if (t === 'passive') tripPassive = v / 1000;
    if (t === 'critical') tripCritical = v / 1000;
  }
})();

async function readThermal() {
  const zones = [];
  try {
    const dirs = await fsp.readdir('/sys/class/thermal');
    for (const d of dirs.filter(x => /^thermal_zone\d+$/.test(x)).sort()) {
      const type = await readText(`/sys/class/thermal/${d}/type`);
      const raw = num(await readText(`/sys/class/thermal/${d}/temp`));
      if (type && raw != null) zones.push({ name: type.replace(/-thermal$/, ''), c: raw / 1000 });
    }
  } catch { /* no thermal zones */ }
  return zones;
}

const qTempPeak = db.prepare(
  'SELECT MAX(cpuTemp) AS peak, MIN(cpuTemp) AS low FROM samples WHERE ts >= ? AND cpuTemp IS NOT NULL');

async function sysInfo() {
  const [meminfo, loadavg, uptimeTxt, wireless, curFreq, maxFreq, gov] = await Promise.all([
    readText('/proc/meminfo'), readText('/proc/loadavg'), readText('/proc/uptime'),
    readText('/proc/net/wireless'),
    readText('/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq'),
    readText('/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq'),
    readText('/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor')
  ]);
  const zones = await readThermal();
  const cpuZone = zones.find(z => z.name === 'cpu') || zones[0] || null;

  const memGet = k => {
    if (!meminfo) return null;
    const m = meminfo.match(new RegExp('^' + k + ':\\s+(\\d+)', 'm'));
    return m ? Number(m[1]) * 1024 : null;
  };
  const memTotal = memGet('MemTotal'), memAvail = memGet('MemAvailable');

  let disk = null;
  try {
    const st = await fsp.statfs('/');
    const total = st.blocks * st.bsize, avail = st.bavail * st.bsize;
    disk = { total, avail, used: total - avail, pct: total ? (100 * (total - avail)) / total : null };
  } catch { /* statfs unavailable */ }

  // /proc/net/wireless: "wlan0: 0000   55.  -55.  -256 ..."  (link, level dBm)
  let wifi = null;
  if (wireless) {
    const line = wireless.split('\n').find(l => /^\s*wlan/.test(l));
    if (line) {
      const p = line.trim().split(/\s+/);
      wifi = { iface: p[0].replace(':', ''), quality: num(p[2]), signal: num(p[3]), ...wifiExtra };
    }
  }
  if (!wifi && wifiExtra.ssid) wifi = { iface: 'wlan0', quality: null, signal: null, ...wifiExtra };

  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const peak = qTempPeak.get(dayStart.getTime()) || {};

  return {
    temp: cpuZone ? cpuZone.c : null,
    zones,
    tripPassive, tripCritical,
    throttling: cpuZone ? cpuZone.c >= tripPassive : false,
    tempTodayPeak: peak.peak != null ? peak.peak : null,
    tempTodayLow: peak.low != null ? peak.low : null,
    cpuPct, cpuCores,
    freqMHz: num(curFreq) ? num(curFreq) / 1000 : null,
    freqMaxMHz: num(maxFreq) ? num(maxFreq) / 1000 : null,
    governor: gov,
    mem: memTotal ? { total: memTotal, avail: memAvail, used: memTotal - (memAvail || 0),
                      pct: (100 * (memTotal - (memAvail || 0))) / memTotal } : null,
    disk,
    load: loadavg ? loadavg.split(/\s+/).slice(0, 3).map(Number) : null,
    uptimeSec: uptimeTxt ? Math.round(Number(uptimeTxt.split(/\s+/)[0])) : null,
    wifi,
    appUptimeSec: Math.round(process.uptime()),
    sampledAt: Date.now()
  };
}

/* ---------------- SSE ---------------- */
const clients = new Set();
function broadcast() {
  const payload = `data: ${JSON.stringify(summarize())}\n\n`;
  for (const res of clients) res.write(payload);
}

/* ---------------- HTTP ---------------- */
const app = express();
app.use(express.json());
app.use(express.static(path.join(APP_DIR, 'public')));
app.use('/vendor', express.static(path.join(APP_DIR, 'node_modules', 'chart.js', 'dist')));

app.get('/api/state', (req, res) => res.json(summarize()));

app.get('/api/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(`data: ${JSON.stringify(summarize())}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

/* Bucketed history. Averaging happens in SQL so a 1-year query touches
   ~500k rows in C and returns ~400 — never materialized in JS. */
const MINUTE = 60000;
app.get('/api/history', (req, res) => {
  const hours = Math.min(Math.max(parseFloat(req.query.hours) || 24, 0.25), 24 * 400);
  const spanMs = hours * 3600 * 1000;
  const targetPts = 400;
  // bucket = whole minutes, so buckets align to sample cadence
  const bucketMs = Math.max(MINUTE, Math.round(spanMs / targetPts / MINUTE) * MINUTE);
  const rows = db.prepare(
    `SELECT (ts / ${bucketMs}) * ${bucketMs} AS ts,
            AVG(poolTemp) AS poolTemp, AVG(airTemp) AS airTemp,
            AVG(rpm) AS rpm, AVG(watts) AS watts,
            AVG(chlorPct) AS chlorPct, AVG(saltPpm) AS saltPpm,
            AVG(cpuTemp) AS cpuTemp
     FROM samples WHERE ts >= ? GROUP BY 1 ORDER BY 1`
  ).all(Date.now() - spanMs);
  res.json({ bucketMs, hours, rows });
});

app.get('/api/sysinfo', async (req, res) => {
  try { res.json(await sysInfo()); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/summary', (req, res) => {
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const weekStart = Date.now() - 7 * 24 * 3600 * 1000;
  const sec = cfg.sampleSeconds || 60;
  const today = qSince.get(dayStart.getTime());
  const week = qSince.get(weekStart);
  const kwh = row => ((row.sumWatts || 0) * sec) / 3600 / 1000;
  res.json({
    kwhRate: cfg.kwhRate,
    today: { kwh: kwh(today), cost: kwh(today) * cfg.kwhRate, onHours: (today.n * sec) / 3600 },
    week: { kwh: kwh(week), cost: kwh(week) * cfg.kwhRate, onHours: (week.n * sec) / 3600 }
  });
});

app.post('/api/config', (req, res) => {
  const rate = parseFloat(req.body && req.body.kwhRate);
  if (isFinite(rate) && rate >= 0 && rate < 5) { cfg.kwhRate = rate; saveCfg(cfg); }
  res.json({ kwhRate: cfg.kwhRate });
});

/* same-origin proxy to njsPC (GET/PUT/POST/DELETE) */
app.all(/^\/njspc\/(.*)/, async (req, res) => {
  try {
    const url = cfg.njspcUrl + '/' + req.params[0];
    const init = { method: req.method, headers: { 'Content-Type': 'application/json' },
                   signal: AbortSignal.timeout(10000) };
    if (!['GET', 'HEAD'].includes(req.method)) init.body = JSON.stringify(req.body || {});
    const r = await fetch(url, init);
    const text = await r.text();
    res.status(r.status).type(r.headers.get('content-type') || 'application/json').send(text);
    scheduleRefresh();
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

app.listen(cfg.port, '0.0.0.0', () => console.log(`pool-dashboard on :${cfg.port} -> ${cfg.njspcUrl}`));
