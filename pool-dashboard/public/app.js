/* pool-dashboard frontend */
(() => {
  const $ = id => document.getElementById(id);
  const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const C1 = css('--series-1'), C2 = css('--series-2');
  const INK2 = css('--ink-2'), MUTED = css('--muted'), GRID = css('--grid'), SURF = css('--surface-1');

  let cur = null;           // latest summarized state
  let rangeHours = 12;
  let chlorDirty = false;   // user touching slider — don't overwrite from state

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

  const baseOpts = () => ({
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#232322', borderColor: 'rgba(255,255,255,.12)', borderWidth: 1,
        titleColor: INK2, bodyColor: '#fff', padding: 10, displayColors: true,
        boxWidth: 8, boxHeight: 8, usePointStyle: true
      }
    },
    scales: {
      x: { grid: { display: false }, border: { color: GRID },
           ticks: { maxTicksLimit: 6, maxRotation: 0, color: MUTED } },
      y: { grid: { color: GRID, lineWidth: 1 }, border: { display: false },
           ticks: { maxTicksLimit: 5, color: MUTED } }
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

  function setEmpty(chart, emptyId, isEmpty) {
    document.getElementById(emptyId).hidden = !isEmpty;
    chart.canvas.parentElement.classList.toggle('is-empty', isEmpty);
  }

  async function loadHistory() {
    const rows = await api(`/api/history?hours=${rangeHours}`);
    const labels = rows.map(r => {
      const d = new Date(r.ts);
      return rangeHours > 48
        ? d.toLocaleDateString([], { month: 'short', day: 'numeric' })
        : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    });
    const any = k => rows.some(r => r[k] != null);

    tempChart.data.labels = labels;
    tempChart.data.datasets[0].data = rows.map(r => r.poolTemp);
    tempChart.data.datasets[1].data = rows.map(r => r.airTemp);
    tempChart.update();
    setEmpty(tempChart, 'tempEmpty', !any('poolTemp') && !any('airTemp'));

    wattsChart.data.labels = labels;
    wattsChart.data.datasets[0].data = rows.map(r => r.watts);
    wattsChart.update();
    setEmpty(wattsChart, 'wattsEmpty', !any('watts'));

    rpmChart.data.labels = labels;
    rpmChart.data.datasets[0].data = rows.map(r => r.rpm);
    rpmChart.update();
    setEmpty(rpmChart, 'rpmEmpty', !any('rpm'));
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
    $('heroLabel').textContent = (s.body ? s.body.name : 'Pool') + ' temperature';
    $('heroTemp').textContent = s.body && s.body.temp != null ? fmt1(s.body.temp) : '--';
    $('heroAir').textContent = `Air ${s.airTemp != null ? fmt1(s.airTemp) + unit : '--'}`;
    $('heroHeat').textContent = s.body && s.body.heatStatus ? `Heater: ${s.body.heatStatus}` : 'Heater: –';

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
    const slider = $('chlorSlider'), apply = $('chlorApply');
    slider.disabled = apply.disabled = !c;
    if (c && !chlorDirty) {
      slider.value = c.poolSetpoint != null ? c.poolSetpoint : 0;
      syncSlider();
    }

    renderPumpPrograms(s);
    renderLights(s);
    renderCircuits(s);
    renderSchedules(s);
  }

  /* ---------- pump programmed speeds (the panel's circuit-speed table) ---------- */
  let progsDragging = false;
  let progsKey = '';
  function renderPumpPrograms(s) {
    const progs = s.pumpPrograms || [];
    $('progsBlock').hidden = progs.length === 0;
    if (!progs.length) { progsKey = ''; return; }
    const key = JSON.stringify(progs);
    if (progsDragging || key === progsKey) return;   // don't fight the user's thumb
    progsKey = key;
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
        <input type="range" min="${min}" max="${max}" step="${step}" value="${val ?? min}">
        <span class="pval"><span class="v">${val != null ? val.toLocaleString() : '--'}</span><span class="u">${unit}</span></span>`;
      const slider = row.querySelector('input');
      const vlabel = row.querySelector('.v');
      const paint = () => {
        slider.style.setProperty('--fill', (100 * (slider.value - min) / (max - min)) + '%');
        vlabel.textContent = parseInt(slider.value, 10).toLocaleString();
      };
      paint();
      slider.addEventListener('pointerdown', () => { progsDragging = true; });
      slider.addEventListener('input', () => { progsDragging = true; paint(); });
      slider.addEventListener('pointerup', () => {   // change (if any) fires first
        setTimeout(() => { progsDragging = false; }, 400);
      });
      slider.addEventListener('change', async () => {
        const v = parseInt(slider.value, 10);
        try {
          const body = { pumpId: cur.pump.id, circuitId: p.circuitId };
          body[isFlow ? 'flow' : 'speed'] = v;
          await put('/njspc/config/pumpCircuit', body);
          toast(`${p.name}: ${v.toLocaleString()} ${unit}`);
        } catch { toast(`Failed to set ${p.name}`, false); }
        progsDragging = false; progsKey = '';   // allow next state to re-sync
      });
      host.appendChild(row);
    }
  }

  function syncSlider() {
    const slider = $('chlorSlider');
    slider.style.setProperty('--fill', slider.value + '%');
    $('chlorPctLabel').textContent = slider.value + '%';
  }
  $('chlorSlider').addEventListener('input', () => { chlorDirty = true; syncSlider(); });
  $('chlorApply').addEventListener('click', async () => {
    try {
      await put('/njspc/state/chlorinator/setChlor', { id: cur.chlorinator.id, poolSetpoint: parseInt($('chlorSlider').value, 10) });
      chlorDirty = false;
      toast(`Chlorinator set to ${$('chlorSlider').value}%`);
    } catch (e) { toast('Failed to set chlorinator', false); }
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

  /* ---------- schedules ---------- */
  const ALLDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function renderSchedules(s) {
    const host = $('schedList');
    $('schedEmpty').hidden = s.schedules.length > 0;
    host.innerHTML = '';
    for (const sc of s.schedules) {
      const days = ALLDAYS.map(d =>
        `<span class="day ${sc.days.includes(d) ? 'on' : ''}">${d[0]}</span>`).join('');
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `
        <div>
          <div class="name">${sc.circuit || 'Schedule ' + sc.id}</div>
          <div class="meta">${days}</div>
        </div>
        <div class="sched-time">${minToTime(sc.startTime)} – ${minToTime(sc.endTime)}</div>`;
      host.appendChild(row);
    }
  }

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
