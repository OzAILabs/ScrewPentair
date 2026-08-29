/*
 * pool-dashboard server
 * - Mirrors njsPC state (socket.io client + REST refresh)
 * - Logs one sample/minute to SQLite (temps, pump rpm/watts, chlorinator)
 * - Serves the SPA, live updates over SSE, and a same-origin proxy to njsPC
 */
const path = require('path');
const fs = require('fs');
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
const insSample = db.prepare(
  'INSERT OR REPLACE INTO samples (ts, poolTemp, airTemp, rpm, watts, chlorPct, saltPpm) VALUES (?,?,?,?,?,?,?)');
const qHistory = db.prepare('SELECT * FROM samples WHERE ts >= ? ORDER BY ts ASC');
const qSince = db.prepare('SELECT COUNT(*) AS n, SUM(watts) AS sumWatts FROM samples WHERE ts >= ? AND watts > 0');

/* ---------------- njsPC state mirror ---------------- */
let state = null;            // last full /state/all payload
let config = null;           // last full /config/all payload (pump speed programs live here)
let njspcOk = false;
let lastStateAt = 0;

async function refreshState() {
  try {
    const [rs, rc] = await Promise.all([
      fetch(cfg.njspcUrl + '/state/all', { signal: AbortSignal.timeout(8000) }),
      fetch(cfg.njspcUrl + '/config/all', { signal: AbortSignal.timeout(8000) })
    ]);
    if (!rs.ok) throw new Error('http ' + rs.status);
    state = await rs.json();
    if (rc.ok) config = await rc.json();
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
  return {
    connected: njspcOk,
    lastStateAt,
    model: (s.equipment && s.equipment.model) || 'unknown',
    status: (s.status && s.status.desc) || 'unknown',
    airTemp: s.temps ? s.temps.air : null,
    units: (s.temps && s.temps.units && s.temps.units.name) || 'F',
    body: body && { name: body.name, temp: body.temp, setPoint: body.setPoint, isOn: body.isOn,
                    heatMode: body.heatMode && body.heatMode.desc, heatStatus: body.heatStatus && body.heatStatus.desc },
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
    schedules: (s.schedules || []).map(sc => ({
      id: sc.id,
      circuit: sc.circuit && (sc.circuit.name || sc.circuit.desc),
      startTime: sc.startTime, endTime: sc.endTime,
      days: sc.scheduleDays && sc.scheduleDays.days ? sc.scheduleDays.days.map(d => d.name.slice(0, 3)) : [],
      isOn: !!sc.isOn, disabled: !!sc.disabled
    })),
    kwhRate: cfg.kwhRate
  };
}

/* ---------------- sampler ---------------- */
function takeSample() {
  if (!state) return;
  const v = summarize();
  const num = x => (typeof x === 'number' && isFinite(x) ? x : null);
  insSample.run(Date.now(),
    num(v.body && v.body.temp), num(v.airTemp),
    num(v.pump && v.pump.rpm), num(v.pump && v.pump.watts),
    num(v.chlorinator && v.chlorinator.poolSetpoint),
    num(v.chlorinator && v.chlorinator.saltLevel));
}
setInterval(takeSample, (cfg.sampleSeconds || 60) * 1000);

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

app.get('/api/history', (req, res) => {
  const hours = Math.min(parseFloat(req.query.hours) || 12, 24 * 14);
  const rows = qHistory.all(Date.now() - hours * 3600 * 1000);
  // downsample to <= ~360 points so long ranges stay light
  const maxPts = 360;
  let out = rows;
  if (rows.length > maxPts) {
    const bucket = Math.ceil(rows.length / maxPts);
    out = [];
    for (let i = 0; i < rows.length; i += bucket) {
      const slice = rows.slice(i, i + bucket);
      const avg = k => {
        const vals = slice.map(r => r[k]).filter(x => x != null);
        return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
      };
      out.push({ ts: slice[Math.floor(slice.length / 2)].ts, poolTemp: avg('poolTemp'), airTemp: avg('airTemp'),
                 rpm: avg('rpm'), watts: avg('watts'), chlorPct: avg('chlorPct'), saltPpm: avg('saltPpm') });
    }
  }
  res.json(out);
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
