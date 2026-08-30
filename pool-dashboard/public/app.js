/* pool-dashboard frontend */
(() => {
  const $ = id => document.getElementById(id);
  const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const C1 = css('--series-1'), C2 = css('--series-2');
  const INK2 = css('--ink-2'), MUTED = css('--muted'), GRID = css('--grid'), SURF = css('--surface-1');

  let cur = null;           // latest summarized state
  let rangeHours = 24;
  let histTs = [];          // raw timestamps behind the current chart points

  /* ---------- drum wheel picker (smooth phone-friendly value control) ---------- */
  function makeWheel(host, opts) {
    const ITEM_H = 32;
    const { min, max, step, format = v => v, onCommit } = opts;
    const count = Math.floor((max - min) / step) + 1;
    const track = document.createElement('div');
    track.className = 'wheel-track';
    for (let i = 0; i < count; i++) {
      const d = document.createElement('div');
      d.className = 'wheel-item';
      d.textContent = format(min + i * step);
      track.appendChild(d);
    }
    host.appendChild(track);
    const centerOff = () => host.clientHeight / 2 - ITEM_H / 2;
    let value = opts.value != null ? opts.value : min;
    let pos = (value - min) / step;      // fractional index
    let vel = 0, raf = null, commitTimer = null;
    const api = { active: false, el: host };

    const paint = () => { track.style.transform = `translateY(${centerOff() - pos * ITEM_H}px)`; };
    const clampPos = p => Math.max(-0.4, Math.min(count - 1 + 0.4, p));
    function finish() {
      const v = min + Math.round(Math.max(0, Math.min(count - 1, pos))) * step;
      api.active = false;
      if (v !== value) {
        value = v;
        clearTimeout(commitTimer);
        commitTimer = setTimeout(() => onCommit && onCommit(value), 450);
      }
    }
    function settle() {
      const target = Math.max(0, Math.min(count - 1, Math.round(pos)));
      cancelAnimationFrame(raf);
      const anim = () => {
        pos += (target - pos) * 0.28;
        if (Math.abs(target - pos) < 0.01) { pos = target; paint(); finish(); return; }
        paint(); raf = requestAnimationFrame(anim);
      };
      raf = requestAnimationFrame(anim);
    }
    let lastY = 0, lastT = 0;
    host.addEventListener('pointerdown', e => {
      e.preventDefault(); host.setPointerCapture(e.pointerId);
      api.active = true; cancelAnimationFrame(raf); vel = 0;
      lastY = e.clientY; lastT = performance.now();
    });
    host.addEventListener('pointermove', e => {
      if (!api.active) return;
      const dy = e.clientY - lastY, t = performance.now();
      vel = dy / Math.max(1, t - lastT) * 16;
      lastY = e.clientY; lastT = t;
      pos = clampPos(pos - dy / ITEM_H);
      paint();
    });
    const release = () => {
      if (!api.active) return;
      const momentum = () => {
        vel *= 0.94;
        pos = clampPos(pos - vel / ITEM_H);
        paint();
        if (Math.abs(vel) > 0.5) raf = requestAnimationFrame(momentum);
        else settle();
      };
      raf = requestAnimationFrame(momentum);
    };
    host.addEventListener('pointerup', release);
    host.addEventListener('pointercancel', release);
    host.addEventListener('wheel', e => {
      e.preventDefault(); api.active = true;
      pos = clampPos(Math.round(pos) + Math.sign(e.deltaY));
      paint(); settle();
    }, { passive: false });

    api.set = v => { if (api.active || v == null) return; value = v; pos = (v - min) / step; paint(); };
    api.get = () => value;
    paint();
    requestAnimationFrame(paint);
    return api;
  }

  /* ---------- water temp -> color (user spec: >=86 red, ~73 blueish, <=65 blue) ---------- */
  function tempColor(t) {
    const stops = [[65, 215], [73, 195], [79, 55], [83, 28], [86, 2]];
    let h;
    if (t <= stops[0][0]) h = stops[0][1];
    else if (t >= stops[stops.length - 1][0]) h = stops[stops.length - 1][1];
    else {
      for (let i = 1; i < stops.length; i++) {
        if (t <= stops[i][0]) {
          const [t0, h0] = stops[i - 1], [t1, h1] = stops[i];
          h = h0 + (h1 - h0) * (t - t0) / (t1 - t0);
          break;
        }
      }
    }
    return `hsl(${Math.round(h)} 82% 58%)`;
  }

  /* ---------- helpers ---------- */
  const fmt1 = n => (n == null ? '--' : Math.round(n * 10) / 10);
  const fmt0 = n => (n == null ? '--' : Math.round(n).toLocaleString());
  const money = n => (n == null ? '--' : '$' + n.toFixed(2));
  const minToTime = m => {
    if (m == null) return '--:--';
    const h = Math.floor(m / 60), min = m % 60, ap = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${String(min).padStart(2, '0')} ${ap}`;
  };
  function toast(msg, ok = true) {
    const t = $('toast');
    t.textContent = msg; t.hidden = false;
    t.style.borderColor = ok ? 'rgba(12,163,12,.5)' : 'rgba(208,59,59,.6)';
    clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2600);
  }
  async function api(path, opts) {
    const r = await fetch(path, opts);
    if (!r.ok) throw new Error(await r.text());
    const ct = r.headers.get('content-type') || '';
    return ct.includes('json') ? r.json() : r.text();
  }
  const put = (path, body) => api(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  /* ---------- charts ---------- */
  Chart.defaults.font.family = 'system-ui, -apple-system, "Segoe UI", sans-serif';
  Chart.defaults.color = MUTED;

  /* Axis ticks land on clean wall-clock boundaries (hours, days, months)
     instead of wherever the data points happen to fall. Unlabeled points
     render an empty string, so Chart.js spaces them without crowding. */
  const hourLabel = d => d.toLocaleTimeString([], { hour: 'numeric' });
  const fullStamp = d => d.toLocaleString([], {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
  });

  function makeLabels(rows, hours) {
    const out = new Array(rows.length).fill('');
    let prevKey = null;
    for (let i = 0; i < rows.length; i++) {
      const d = new Date(rows[i].ts);
      let key = null, text = '';
      if (hours <= 8) {                                   // every hour
        key = `${d.getDate()}h${d.getHours()}`; text = hourLabel(d);
      } else if (hours <= 36) {                           // every 4 hours
        if (d.getHours() % 4 === 0) { key = `${d.getDate()}h${d.getHours()}`; text = hourLabel(d); }
      } else if (hours <= 24 * 10) {                      // every day
        key = `${d.getMonth()}d${d.getDate()}`;
        text = d.toLocaleDateString([], { weekday: 'short' });
      } else if (hours <= 24 * 45) {                      // every 5th day
        if (d.getDate() % 5 === 1) { key = `${d.getMonth()}d${d.getDate()}`;
          text = d.toLocaleDateString([], { month: 'short', day: 'numeric' }); }
      } else if (hours <= 24 * 200) {                     // 1st and 16th
        if (d.getDate() === 1 || d.getDate() === 16) { key = `${d.getMonth()}d${d.getDate()}`;
          text = d.toLocaleDateString([], { month: 'short', day: 'numeric' }); }
      } else {                                            // every month
        key = `${d.getFullYear()}m${d.getMonth()}`;
        text = d.toLocaleDateString([], { month: 'short' });
      }
      if (key && key !== prevKey) { out[i] = text; prevKey = key; }
    }
    return out;
  }

  const baseOpts = (extra = {}) => ({
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#232322', borderColor: 'rgba(255,255,255,.12)', borderWidth: 1,
        titleColor: INK2, bodyColor: '#fff', padding: 10, displayColors: true,
        boxWidth: 8, boxHeight: 8, usePointStyle: true,
        callbacks: {
          title: items => {
            const src = extra.tsSource ? extra.tsSource() : histTs;
            return items.length && src[items[0].dataIndex]
              ? fullStamp(new Date(src[items[0].dataIndex])) : '';
          }
        }
      }
    },
    scales: {
      x: {
        // vertical guide only where a tick is actually labeled
        grid: { display: true, drawTicks: false,
                color: ctx => (ctx.tick && ctx.tick.label ? GRID : 'transparent') },
        border: { color: GRID },
        ticks: { autoSkip: false, maxRotation: 0, color: MUTED, font: { size: 11 } }
      },
      y: { grid: { color: GRID, lineWidth: 1 }, border: { display: false },
           ticks: { maxTicksLimit: 5, color: MUTED }, ...(extra.y || {}) }
    }
  });

  const lineSeries = (label, color) => ({
    label, data: [], borderColor: color, backgroundColor: color + '1A', /* ~10% wash */
    borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, pointHoverBackgroundColor: color,
    pointHoverBorderColor: SURF, pointHoverBorderWidth: 2, fill: true, tension: 0.3, spanGaps: true
  });

  const tempChart = new Chart($('tempChart'), {
    type: 'line',
    data: { labels: [], datasets: [lineSeries('Pool', C1), { ...lineSeries('Air', C2), fill: false }] },
    options: baseOpts()
  });
  const wattsChart = new Chart($('wattsChart'), {
    type: 'line', data: { labels: [], datasets: [lineSeries('Watts', C1)] }, options: baseOpts()
  });
  const rpmChart = new Chart($('rpmChart'), {
    type: 'line', data: { labels: [], datasets: [lineSeries('RPM', C1)] }, options: baseOpts()
  });

  // Pentair's ideal IntelliChlor salt window, drawn behind the line
  const SALT_LO = 2800, SALT_HI = 3400;
  const saltBand = {
    id: 'saltBand',
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      if (!scales.y || !chartArea) return;
      const a = scales.y.getPixelForValue(SALT_HI), b = scales.y.getPixelForValue(SALT_LO);
      const top = Math.max(chartArea.top, Math.min(a, b));
      const bot = Math.min(chartArea.bottom, Math.max(a, b));
      if (bot <= top) return;
      ctx.save();
      ctx.fillStyle = 'rgba(12,163,12,0.10)';
      ctx.fillRect(chartArea.left, top, chartArea.right - chartArea.left, bot - top);
      ctx.restore();
    }
  };
  const saltChart = new Chart($('saltChart'), {
    type: 'line',
    data: { labels: [], datasets: [{ ...lineSeries('Salt', C1), fill: false }] },
    options: baseOpts({ y: { suggestedMin: 2600, suggestedMax: 3500,
                             ticks: { maxTicksLimit: 5, color: MUTED,
                                      callback: v => v.toLocaleString() } } }),
    plugins: [saltBand]
  });

  function setEmpty(chart, emptyId, isEmpty) {
    document.getElementById(emptyId).hidden = !isEmpty;
    chart.canvas.parentElement.classList.toggle('is-empty', isEmpty);
  }

  async function loadHistory() {
    const res = await api(`/api/history?hours=${rangeHours}`);
    const rows = res.rows || [];
    histTs = rows.map(r => r.ts);
    const labels = makeLabels(rows, res.hours || rangeHours);
    const any = k => rows.some(r => r[k] != null);
    const col = k => rows.map(r => (r[k] != null ? Math.round(r[k] * 10) / 10 : null));

    tempChart.data.labels = labels;
    tempChart.data.datasets[0].data = col('poolTemp');
    tempChart.data.datasets[1].data = col('airTemp');
    tempChart.update();
    setEmpty(tempChart, 'tempEmpty', !any('poolTemp') && !any('airTemp'));

    wattsChart.data.labels = labels;
    wattsChart.data.datasets[0].data = col('watts');
    wattsChart.update();
    setEmpty(wattsChart, 'wattsEmpty', !any('watts'));

    rpmChart.data.labels = labels;
    rpmChart.data.datasets[0].data = col('rpm');
    rpmChart.update();
    setEmpty(rpmChart, 'rpmEmpty', !any('rpm'));

    saltChart.data.labels = labels;
    saltChart.data.datasets[0].data = col('saltPpm');
    saltChart.update();
    setEmpty(saltChart, 'saltEmpty', !any('saltPpm'));
  }

  $('rangeRow').addEventListener('click', e => {
    const b = e.target.closest('.chip'); if (!b) return;
    document.querySelectorAll('#rangeRow .chip').forEach(c => c.classList.toggle('active', c === b));
    rangeHours = parseFloat(b.dataset.hours);
    loadHistory();
  });

  /* ---------- state rendering ---------- */
  function render(s) {
    cur = s;
    $('connDot').classList.toggle('ok', !!s.connected);
    $('modelLine').textContent = s.connected ? `${s.model} · ${s.status}` : 'njsPC unreachable';

    const unit = '°' + (s.units || 'F');
    $('heroUnit').textContent = unit;
    $('heroLabel').textContent = (s.body ? s.body.name : 'Pool') + ' temperature' +
      (s.body && s.body.temp != null && !s.body.tempIsLive ? ' (last reading)' : '');
    const wtemp = s.body && s.body.temp != null ? s.body.temp : null;
    $('heroTemp').textContent = wtemp != null ? fmt1(wtemp) : '--';
    $('heroTemp').style.color = wtemp != null ? tempColor(wtemp) : '';
    $('heroAir').textContent = `Air ${s.airTemp != null ? fmt1(s.airTemp) + unit : '--'}`;
    $('heroHeat').textContent = s.body && s.body.heatStatus ? `Heater: ${s.body.heatStatus}` : 'Heater: –';

    // hero pool on/off button (overrides schedules, same as panel button)
    const pc = s.poolCircuit;
    $('poolBtn').hidden = !pc;
    if (pc) {
      $('poolBtn').classList.toggle('on', pc.isOn);
      $('poolBtnState').textContent = pc.isOn ? 'ON' : 'OFF';
      $('poolBtnLabel').textContent = pc.isOn ? 'Pool is running — tap to turn off' : 'Turn pool on';
    }

    // pump
    const p = s.pump;
    $('pumpStatus').textContent = p ? (p.status || (p.rpm > 0 ? 'Running' : 'Off')) : 'none yet';
    $('pumpStatus').classList.toggle('on', !!(p && p.rpm > 0));
    $('pumpRpm').textContent = p ? fmt0(p.rpm) : '--';
    $('pumpWatts').textContent = p ? fmt0(p.watts) : '--';
    $('wattsNowLbl').textContent = p ? `${fmt0(p.watts)} W now` : '';
    $('rpmNowLbl').textContent = p ? `${fmt0(p.rpm)} RPM now` : '';

    // chlorinator
    const c = s.chlorinator;
    $('chlorEmpty').hidden = !!c;
    $('chlorStatus').textContent = c ? (c.status || '–') : 'none yet';
    $('saltPpm').textContent = c && c.saltLevel != null ? fmt0(c.saltLevel) : '--';
    $('saltNowLbl').textContent = c && c.saltLevel != null ? `${fmt0(c.saltLevel)} ppm now` : '';
    $('chlorWheel').classList.toggle('disabled', !c);
    if (c) {
      if (!chlorWheel) {
        chlorWheel = makeWheel($('chlorWheel'), {
          min: 0, max: 100, step: 1, value: c.poolSetpoint || 0,
          onCommit: async v => {
            try {
              await put('/njspc/state/chlorinator/setChlor', { id: cur.chlorinator.id, poolSetpoint: v });
              toast(`Chlorinator set to ${v}%`);
            } catch { toast('Failed to set chlorinator', false); }
          }
        });
      } else chlorWheel.set(c.poolSetpoint);
    }

    // bus health footer
    const r = s.rs485;
    $('busFooter').hidden = !r;
    if (r) {
      const rate = r.failureRate || 0;
      $('busDot').className = 'bus-dot ' + (!r.isOpen || rate >= 5 ? 'bad' : rate >= 1 ? 'warn' : 'good');
      $('busText').textContent =
        `RS-485 · ${rate.toFixed(2)}% errors · ${fmt0(r.packets)} packets · ${r.collisions} collisions` +
        (r.isOpen ? '' : ' · PORT CLOSED');
    }

    renderPumpPrograms(s);
    renderLights(s);
    renderCircuits(s);
    renderSchedules(s);
  }

  /* ---------- pump programmed speeds (the panel's circuit-speed table) ---------- */
  let chlorWheel = null;
  let progWheels = [];
  let progsKey = '';
  function renderPumpPrograms(s) {
    const progs = s.pumpPrograms || [];
    $('progsBlock').hidden = progs.length === 0;
    if (!progs.length) { progsKey = ''; progWheels = []; return; }
    const key = JSON.stringify(progs.map(p => [p.circuitId, p.units]));
    if (progWheels.some(w => w.active)) return;       // don't fight the user's thumb
    if (key === progsKey) {                            // same rows — just sync values
      progs.forEach((p, i) => {
        const v = (p.units || '').toLowerCase().includes('gpm') ? p.flow : p.speed;
        if (progWheels[i]) progWheels[i].set(v);
      });
      return;
    }
    progsKey = key;
    progWheels = [];
    const host = $('pumpProgs');
    host.innerHTML = '';
    for (const p of progs) {
      const isFlow = (p.units || '').toLowerCase().includes('gpm') || (p.speed == null && p.flow != null);
      const val = isFlow ? p.flow : p.speed;
      const [min, max, step, unit] = isFlow ? [15, 130, 1, 'GPM'] : [450, 3450, 10, 'RPM'];
      const row = document.createElement('div');
      row.className = 'prog-row';
      row.innerHTML = `
        <span class="pname" title="${p.name}">${p.name}</span>
        <div class="wheel-row"><div class="wheel"></div><span class="wheel-suffix">${unit}</span></div>`;
      const wheel = makeWheel(row.querySelector('.wheel'), {
        min, max, step, value: val != null ? val : min,
        format: v => v.toLocaleString(),
        onCommit: async v => {
          try {
            const body = { pumpId: cur.pump.id, circuitId: p.circuitId };
            body[isFlow ? 'flow' : 'speed'] = v;
            await put('/njspc/config/pumpCircuit', body);
            toast(`${p.name}: ${v.toLocaleString()} ${unit}`);
          } catch { toast(`Failed to set ${p.name}`, false); }
        }
      });
      progWheels.push(wheel);
      host.appendChild(row);
    }
  }

  $('poolBtn').addEventListener('click', async () => {
    const pc = cur && cur.poolCircuit;
    if (!pc) return;
    try {
      await put('/njspc/state/circuit/setState', { id: pc.id, state: !pc.isOn });
      toast(pc.isOn ? 'Pool turning off' : 'Pool turning on');
    } catch { toast('Pool toggle failed', false); }
  });

  /* ---------- lights ---------- */
  const themeCache = {};   // circuitId -> [{val,name,desc}]
  const THEME_COLORS = {
    white: '#f4f4ef', green: '#22b24a', blue: '#2a78d6', magenta: '#d55181', red: '#e34948',
    'american': 'linear-gradient(90deg,#e34948,#f4f4ef,#2a78d6)',
    'sunset': 'linear-gradient(90deg,#e87b34,#e34948)', 'royal': 'linear-gradient(90deg,#4a3aa7,#2a78d6)',
    'caribbean': 'linear-gradient(90deg,#1baf7a,#2a78d6)', 'party': 'linear-gradient(90deg,#e34948,#eda100,#1baf7a,#2a78d6)',
    'romance': 'linear-gradient(90deg,#d55181,#9085e9)', 'sam': 'linear-gradient(90deg,#22b24a,#2a78d6,#d55181)'
  };
  const themeSwatch = name => {
    const key = Object.keys(THEME_COLORS).find(k => name.toLowerCase().includes(k));
    return THEME_COLORS[key] || '#52514e';
  };

  async function renderLights(s) {
    const lights = s.circuits.filter(c => c.isLight);
    $('lightsEmpty').hidden = lights.length > 0;
    const host = $('lightsList');
    host.innerHTML = '';
    for (const l of lights) {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `
        <div>
          <div class="name">${l.name}</div>
          <div class="themes" data-cid="${l.id}"></div>
        </div>
        <label class="switch"><input type="checkbox" ${l.isOn ? 'checked' : ''}><span class="track"></span></label>`;
      row.querySelector('input').addEventListener('change', async e => {
        try { await put('/njspc/state/circuit/setState', { id: l.id, state: e.target.checked }); }
        catch { toast('Circuit change failed', false); e.target.checked = !e.target.checked; }
      });
      host.appendChild(row);
      loadThemes(l, row.querySelector('.themes'));
    }
  }

  async function loadThemes(light, host) {
    try {
      if (!themeCache[light.id]) themeCache[light.id] = await api(`/njspc/config/circuit/${light.id}/lightThemes`);
      const themes = themeCache[light.id];
      if (!Array.isArray(themes) || !themes.length) return;
      host.innerHTML = '';
      for (const t of themes.slice(0, 14)) {
        const b = document.createElement('button');
        b.className = 'swatch' + (light.lightingTheme && light.lightingTheme.val === t.val ? ' active' : '');
        b.title = t.desc || t.name;
        b.style.background = themeSwatch(t.desc || t.name || '');
        b.addEventListener('click', async () => {
          try { await put('/njspc/state/circuit/setTheme', { id: light.id, theme: t.val }); toast(`${light.name}: ${t.desc || t.name}`); }
          catch { toast('Theme change failed', false); }
        });
        host.appendChild(b);
      }
    } catch { /* theme list unavailable until panel connected */ }
  }

  /* ---------- circuits ---------- */
  function renderCircuits(s) {
    const host = $('circuitsList');
    host.innerHTML = '';
    const items = s.circuits.filter(c => !c.isLight);
    for (const c of items) {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `
        <div><div class="name">${c.name}</div><div class="meta">${c.typeDesc || ''}</div></div>
        <label class="switch"><input type="checkbox" ${c.isOn ? 'checked' : ''}><span class="track"></span></label>`;
      row.querySelector('input').addEventListener('change', async e => {
        try { await put('/njspc/state/circuit/setState', { id: c.id, state: e.target.checked }); }
        catch { toast('Circuit change failed', false); e.target.checked = !e.target.checked; }
      });
      host.appendChild(row);
    }
  }

  /* ---------- schedules (editable — writes the panel via njsPC) ---------- */
  // Bit values from njsPC /config/options/schedules: Sun=1 ... Sat=64
  const DAYBITS = [['S', 1], ['M', 2], ['T', 4], ['W', 8], ['T', 16], ['F', 32], ['S', 64]];
  let schedKey = '';
  const minsToHHMM = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const hhmmToMins = v => { const [h, m] = v.split(':').map(Number); return h * 60 + m; };

  async function saveSchedule(payload, row) {
    try {
      await put('/njspc/config/schedule', payload);
      toast('Schedule saved — panel updated');
      if (row) row.classList.remove('dirty');
      schedKey = '';
    } catch { toast('Schedule save failed', false); }
  }

  function renderSchedules(s) {
    const host = $('schedList');
    $('schedEmpty').hidden = s.schedules.length > 0;
    const key = JSON.stringify(s.schedules);
    if (key === schedKey) return;
    if (host.querySelector('.sched-row.dirty') || host.contains(document.activeElement)) return; // mid-edit
    schedKey = key;
    host.innerHTML = '';
    for (const sc of s.schedules) {
      const row = document.createElement('div');
      row.className = 'sched-row';
      let daysVal = sc.daysVal || 0;
      row.innerHTML = `
        <span class="name">${sc.circuit || 'Schedule ' + sc.id}</span>
        <span class="sched-onchip ${sc.isOn ? 'on' : ''}">${sc.isOn ? 'active now' : 'idle'}</span>
        <input type="time" class="t-start" value="${minsToHHMM(sc.startTime)}">
        <span class="via">–</span>
        <input type="time" class="t-end" value="${minsToHHMM(sc.endTime)}">
        <span class="sched-days"></span>
        <span class="sched-actions">
          <button class="btn sched-save">Save</button>
          <button class="icon-btn sched-del" title="Delete schedule">✕</button>
        </span>`;
      const daysHost = row.querySelector('.sched-days');
      for (const [label, bit] of DAYBITS) {
        const b = document.createElement('button');
        b.className = 'dayt' + ((daysVal & bit) ? ' on' : '');
        b.textContent = label;
        b.addEventListener('click', () => {
          daysVal ^= bit;
          b.classList.toggle('on', !!(daysVal & bit));
          row.classList.add('dirty');
        });
        daysHost.appendChild(b);
      }
      row.querySelectorAll('input[type=time]').forEach(i =>
        i.addEventListener('change', () => row.classList.add('dirty')));
      row.querySelector('.sched-save').addEventListener('click', () => saveSchedule({
        id: sc.id, circuit: sc.circuitId,
        startTime: hhmmToMins(row.querySelector('.t-start').value),
        endTime: hhmmToMins(row.querySelector('.t-end').value),
        scheduleDays: daysVal, scheduleType: 0,
        startTimeType: 0, endTimeType: 0,
        heatSource: sc.heatSource != null ? sc.heatSource : 32
      }, row));
      row.querySelector('.sched-del').addEventListener('click', async () => {
        if (!confirm(`Delete the ${sc.circuit} schedule ${minsToHHMM(sc.startTime)}–${minsToHHMM(sc.endTime)}?`)) return;
        try {
          await api('/njspc/config/schedule', { method: 'DELETE',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: sc.id }) });
          toast('Schedule deleted'); schedKey = '';
        } catch { toast('Delete failed', false); }
      });
      host.appendChild(row);
    }
  }

  $('schedAdd').addEventListener('click', () => {
    const circ = (cur && cur.poolCircuit) ? cur.poolCircuit.id : 6;
    saveSchedule({ circuit: circ, startTime: 480, endTime: 600,
                   scheduleDays: 127, scheduleType: 0,
                   startTimeType: 0, endTimeType: 0, heatSource: 32 });
  });

  /* ---------- summary / cost ---------- */
  async function loadSummary() {
    try {
      const s = await api('/api/summary');
      $('costToday').textContent = money(s.today.cost);
      $('costSub').textContent = `${s.today.kwh.toFixed(2)} kWh · ${s.today.onHours.toFixed(1)} h on`;
      if (document.activeElement !== $('rateInput')) $('rateInput').value = s.kwhRate;
    } catch { }
  }
  $('rateSave').addEventListener('click', async () => {
    try {
      await api('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kwhRate: parseFloat($('rateInput').value) }) });
      toast('Rate saved'); loadSummary();
    } catch { toast('Save failed', false); }
  });

  /* ---------- Orange Pi diagnostics ---------- */
  const GOOD = css('--good'), WARNC = css('--warning'), CRIT = css('--critical');
  let diagOpen = false, diagTimer = null, diagRange = 24, diagChart = null, lastSys = null;
  let diagTs = [];          // the diag chart's own timestamps (separate range)

  const fmtBytes = b => b == null ? '--'
    : b >= 1073741824 ? (b / 1073741824).toFixed(1) + ' GB' : Math.round(b / 1048576) + ' MB';
  const fmtDur = s => {
    if (s == null) return '--';
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
  };
  // Thermal severity against the SoC's own trip points, not invented numbers
  function tempSeverity(t, trip) {
    if (t == null) return 'unknown';
    if (t >= trip) return 'bad';
    if (t >= trip - 15) return 'warn';        // within 15°C of throttling
    return 'good';
  }
  const sevColor = s => s === 'bad' ? CRIT : s === 'warn' ? WARNC : GOOD;

  function meter(barId, valId, subId, pct, text, sub, invert) {
    const p = pct == null ? 0 : Math.max(0, Math.min(100, pct));
    const bar = $(barId);
    bar.style.width = p + '%';
    // invert=true means HIGH is good (wifi); otherwise high is bad
    const level = invert ? (p >= 55 ? 'good' : p >= 30 ? 'warn' : 'bad')
                         : (p >= 90 ? 'bad' : p >= 75 ? 'warn' : 'good');
    bar.style.background = sevColor(level);
    $(valId).textContent = text;
    $(subId).textContent = sub;
  }

  function renderSys(s) {
    lastSys = s;
    const trip = s.tripPassive || 85;
    const sev = tempSeverity(s.temp, trip);
    $('diagTemp').textContent = s.temp != null ? s.temp.toFixed(1) : '--';
    $('diagTemp').style.color = sevColor(sev);
    $('diagTempSub').textContent = s.temp == null ? '–'
      : s.throttling ? `THROTTLING — at or above the ${trip}°C limit`
      : `${(trip - s.temp).toFixed(1)}°C of headroom before throttling`;
    $('diagSub').textContent = `sampled ${new Date(s.sampledAt).toLocaleTimeString()}`;

    // gauge spans 30–100°C
    const span = 100 - 30;
    $('tempGauge').style.width = s.temp == null ? '0%'
      : Math.max(0, Math.min(100, ((s.temp - 30) / span) * 100)) + '%';
    $('tempGauge').style.background = sevColor(sev);
    $('tripMark').style.left = (((trip - 30) / span) * 100) + '%';
    $('tripLabel').textContent = `${trip}° throttle`;

    meter('cpuBar', 'cpuVal', 'cpuSub', s.cpuPct,
      s.cpuPct != null ? s.cpuPct.toFixed(0) + '%' : '--',
      s.cpuCores && s.cpuCores.length ? 'cores ' + s.cpuCores.map(c => c.toFixed(0) + '%').join(' · ') : '–');

    const m = s.mem;
    meter('memBar', 'memVal', 'memSub', m ? m.pct : null,
      m ? m.pct.toFixed(0) + '%' : '--',
      m ? `${fmtBytes(m.avail)} free of ${fmtBytes(m.total)}` : '–');

    const d = s.disk;
    meter('diskBar', 'diskVal', 'diskSub', d ? d.pct : null,
      d ? d.pct.toFixed(0) + '%' : '--',
      d ? `${fmtBytes(d.avail)} free of ${fmtBytes(d.total)}` : '–');

    // signal: -30 dBm excellent .. -90 unusable
    const w = s.wifi;
    const sigPct = w && w.signal != null ? Math.max(0, Math.min(100, ((w.signal + 90) / 60) * 100)) : null;
    meter('wifiBar', 'wifiVal', 'wifiSub', sigPct,
      w && w.signal != null ? w.signal + ' dBm' : '--',
      w ? [w.ssid, w.bitrate ? w.bitrate + ' Mbit/s' : null].filter(Boolean).join(' · ') || '–' : '–', true);

    $('dZones').textContent = s.zones && s.zones.length
      ? s.zones.map(z => `${z.name} ${z.c.toFixed(1)}°`).join('   ') : '–';
    $('dRange').textContent = s.tempTodayPeak != null
      ? `${s.tempTodayLow.toFixed(1)}° low · ${s.tempTodayPeak.toFixed(1)}° peak`
      : 'collecting…';
    $('dFreq').textContent = s.freqMHz != null
      ? `${fmt0(s.freqMHz)} of ${fmt0(s.freqMaxMHz)} MHz · ${s.governor || ''}` : '–';
    $('dLoad').textContent = s.load ? s.load.map(x => x.toFixed(2)).join('  ') + '   (4 cores)' : '–';
    $('dNet').textContent = w
      ? `${w.iface}${w.freq ? ' · ' + (w.freq / 1000).toFixed(1) + ' GHz' : ''}${w.quality != null ? ' · link ' + w.quality : ''}`
      : '–';
    $('dUptime').textContent = `${fmtDur(s.uptimeSec)} since boot · dashboard up ${fmtDur(s.appUptimeSec)}`;

    // footer dot mirrors thermal state even when the modal is closed
    $('diagDot').className = 'diag-dot ' + (sev === 'unknown' ? '' : sev);
  }

  async function loadSys() {
    try { renderSys(await api('/api/sysinfo')); } catch { $('diagSub').textContent = 'sensors unavailable'; }
  }

  async function loadDiagChart() {
    if (!diagChart) {
      diagChart = new Chart($('diagTempChart'), {
        type: 'line', data: { labels: [], datasets: [lineSeries('CPU °C', C1)] },
        options: baseOpts({ tsSource: () => diagTs,
                            y: { ticks: { maxTicksLimit: 4, color: MUTED,
                                          callback: v => v + '°' } } }),
        plugins: [{
          id: 'tripLine',
          beforeDatasetsDraw(chart) {
            const trip = (lastSys && lastSys.tripPassive) || 85;
            const { ctx, chartArea, scales } = chart;
            if (!scales.y || !chartArea) return;
            const y = scales.y.getPixelForValue(trip);
            if (y < chartArea.top || y > chartArea.bottom) return;
            ctx.save();
            ctx.strokeStyle = CRIT; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
            ctx.beginPath(); ctx.moveTo(chartArea.left, y); ctx.lineTo(chartArea.right, y); ctx.stroke();
            ctx.restore();
          }
        }]
      });
    }
    const res = await api(`/api/history?hours=${diagRange}`);
    const rows = res.rows || [];
    diagTs = rows.map(r => r.ts);
    diagChart.data.labels = makeLabels(rows, res.hours || diagRange);
    diagChart.data.datasets[0].data = rows.map(r => r.cpuTemp != null ? Math.round(r.cpuTemp * 10) / 10 : null);
    diagChart.update();
    setEmpty(diagChart, 'diagTempEmpty', !rows.some(r => r.cpuTemp != null));
  }

  function openDiag() {
    diagOpen = true;
    $('diagModal').hidden = false;
    loadSys(); loadDiagChart();
    diagTimer = setInterval(loadSys, 5000);
  }
  function closeDiag() {
    diagOpen = false;
    $('diagModal').hidden = true;
    clearInterval(diagTimer); diagTimer = null;
  }
  $('diagBtn').addEventListener('click', openDiag);
  $('diagClose').addEventListener('click', closeDiag);
  $('diagModal').addEventListener('click', e => { if (e.target === $('diagModal')) closeDiag(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && diagOpen) closeDiag(); });
  $('diagRangeRow').addEventListener('click', e => {
    const b = e.target.closest('.chip'); if (!b) return;
    document.querySelectorAll('#diagRangeRow .chip').forEach(c => c.classList.toggle('active', c === b));
    diagRange = parseFloat(b.dataset.hours);
    loadDiagChart();
  });
  // keep the footer dot live without opening the modal
  loadSys();
  setInterval(() => { if (!diagOpen) loadSys(); }, 60000);

  /* ---------- live wiring ---------- */
  function connectSSE() {
    const es = new EventSource('/api/events');
    es.onmessage = ev => render(JSON.parse(ev.data));
    es.onerror = () => { es.close(); $('connDot').classList.remove('ok'); setTimeout(connectSSE, 4000); };
  }
  setInterval(() => { $('clock').textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }, 1000);

  api('/api/state').then(render).catch(() => { });
  connectSSE();
  loadHistory();
  loadSummary();
  setInterval(loadHistory, 60000);
  setInterval(loadSummary, 60000);
})();
