/* app.js — heater controller app (Web Bluetooth). See core.js for the protocol. */
'use strict';

const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';   // app writes
const NUS_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';   // board notifies
const NAME_PREFIX = 'HeaterCtrl';
const ACK_TIMEOUT_MS = 4000;
const RETRY_SAFE = ['GET', 'SP', 'MD', 'RUN', 'PB', 'PS'];
const HISTORY_MS = 12 * 3600 * 1000;
const RECONNECT_DELAYS_MS = [1000, 2000, 4000];

const $ = id => document.getElementById(id);
const { LIMITS, roundHalf, clamp, toTenths } = Core;

/* ======================= state ======================= */

const S = {
  transport: null, connected: false, demo: false, userDisconnect: false,
  status: null, config: null, boardProfile: [],
  history: [], windowMin: 10,
  spDraft: 39, spDirty: false,
  draft: [], draftDirty: false,
  unlocked: false, pwd: null, maxDraft: 47,
  view: 'monitor', busy: false,
};

/* ======================= Bluetooth transport ======================= */

class BleTransport {
  constructor() {
    this.device = null; this.rx = null; this.tx = null;
    this.handlers = { line: [], disconnect: [] };
    this.buffer = ''; this.decoder = new TextDecoder(); this.encoder = new TextEncoder();
    this.writeChain = Promise.resolve();
    this.onDisc = () => this.handlers.disconnect.forEach(cb => cb(false));
  }
  get name() { return (this.device && this.device.name) || 'HeaterCtrl'; }
  on_(ev, cb) { this.handlers[ev].push(cb); }

  async connect() {
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: NAME_PREFIX }, { services: [NUS_SERVICE] }],
      optionalServices: [NUS_SERVICE],
    });
    this.device.addEventListener('gattserverdisconnected', this.onDisc);
    await this.openGatt();
  }

  async openGatt() {
    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService(NUS_SERVICE);
    this.rx = await service.getCharacteristic(NUS_RX);
    this.tx = await service.getCharacteristic(NUS_TX);
    if (!this.tx.__hooked) {
      this.tx.addEventListener('characteristicvaluechanged', e => this.onNotify(e));
      this.tx.__hooked = true;
    }
    await this.tx.startNotifications();
    this.buffer = '';
  }

  onNotify(e) {
    this.buffer += this.decoder.decode(e.target.value);
    const { lines, rest } = Core.splitLines(this.buffer);
    this.buffer = rest.length > 300 ? '' : rest;
    lines.forEach(l => this.handlers.line.forEach(cb => cb(l)));
  }

  write(text) {
    const job = this.writeChain.then(async () => {
      if (!this.rx) throw new Error('not connected');
      const data = this.encoder.encode(text);
      if (this.rx.properties.write && this.rx.writeValueWithResponse) await this.rx.writeValueWithResponse(data);
      else if (this.rx.writeValueWithoutResponse) await this.rx.writeValueWithoutResponse(data);
      else await this.rx.writeValue(data);
    });
    this.writeChain = job.catch(() => {});
    return job;
  }

  async disconnect() {
    if (this.device && this.device.gatt.connected) this.device.gatt.disconnect();
    else this.handlers.disconnect.forEach(cb => cb(true));
  }
}

/* ======================= commands with acknowledgement ======================= */

let waiter = null;
let cmdChain = Promise.resolve();

class CmdError extends Error {
  constructor(cmd, reason) { super(`${cmd}:${reason}`); this.cmd = cmd; this.reason = reason; }
}

function attempt(cmd, prefix, tries) {
  return new Promise((resolve, reject) => {
    if (!S.transport || !S.connected) return reject(new CmdError(prefix, 'NOTCONN'));
    const timer = setTimeout(() => {
      waiter = null;
      if (tries > 1) attempt(cmd, prefix, tries - 1).then(resolve, reject);
      else reject(new CmdError(prefix, 'TIMEOUT'));
    }, ACK_TIMEOUT_MS);
    waiter = {
      cmd: prefix,
      ok: () => { clearTimeout(timer); waiter = null; resolve(); },
      fail: r => { clearTimeout(timer); waiter = null; reject(new CmdError(prefix, r)); },
    };
    log(`→ ${prefix === 'AU' || prefix === 'MX' || prefix === 'PW' ? prefix + ':••••' : cmd}`);
    S.transport.write(cmd).catch(() => { if (waiter) waiter.fail('SEND'); });
  });
}

function command(cmd) {
  const prefix = cmd.split(':')[0];
  const job = cmdChain.then(() => attempt(cmd, prefix, RETRY_SAFE.includes(prefix) ? 2 : 1));
  cmdChain = job.catch(() => {});
  return job;
}

function reasonText(err) {
  if (!err) return 'משהו השתבש';
  if (err.reason === 'NOTCONN') return 'אין חיבור לבקר';
  return Core.REASONS[err.reason] || `הבקר סירב (${err.reason || err.message})`;
}

/* ======================= incoming lines ======================= */

function log(text) {
  // kept small on purpose: shown nowhere yet, useful in the browser console
  if (window.__heaterDebug) console.log(text);
}

function onLine(line) {
  log(`← ${line}`);
  const m = Core.parseLine(line);
  if (m.type === 'OK' || m.type === 'ER') {
    if (waiter && waiter.cmd === m.cmd) m.type === 'OK' ? waiter.ok() : waiter.fail(m.reason);
    return;
  }
  if (m.type === 'S') applyStatus(m);
  else if (m.type === 'C') applyConfig(m);
  else if (m.type === 'P') applyProfileStep(m);
}

function applyStatus(s) {
  S.status = s;
  if (typeof s.temp === 'number') {
    const now = Date.now();
    S.history.push({ t: now, temp: s.temp, target: s.target });
    while (S.history.length && S.history[0].t < now - HISTORY_MS) S.history.shift();
  }
  renderMonitor();
  drawChart();
}

function applyConfig(c) {
  S.config = c;
  // SP/MD answers carry no profile lines: keep what we have unless the size changed
  if (S.boardProfile.length !== c.steps) S.boardProfile = new Array(c.steps).fill(null);
  if (!S.spDirty) S.spDraft = c.sp;
  S.spDraft = clamp(S.spDraft, LIMITS.minC, c.max);
  if (!S.unlocked) S.maxDraft = c.max;
  if (c.steps === 0 && !S.draftDirty) S.draft = [];
  renderAll();
}

function applyProfileStep(p) {
  if (!S.config || p.index >= S.boardProfile.length) return;
  S.boardProfile[p.index] = { temp: p.temp, minutes: p.minutes };
  if (S.boardProfile.every(Boolean) && !S.draftDirty) {
    S.draft = S.boardProfile.map(s => ({ ...s }));
  }
  renderProfile();
  renderMonitor();
}

/* ======================= connect / disconnect ======================= */

function attachTransport(t) {
  S.transport = t;
  t.on_('line', onLine);
  t.on_('disconnect', byUser => onDisconnected(byUser));
}

async function afterConnect() {
  S.connected = true;
  setChip('connected', 'מחובר');
  renderAll();
  try { await command('GET'); } catch (e) { /* status lines will still arrive */ }
}

async function connectBle() {
  if (!navigator.bluetooth) { $('noBle').hidden = false; return; }
  S.userDisconnect = false;
  const t = new BleTransport();
  try {
    setChip('connecting', 'מחפש…');
    await t.connect();
    if (S.transport) await disconnectQuiet();
    S.userDisconnect = false;
    attachTransport(t);
    S.demo = false;
    await afterConnect();
  } catch (err) {
    setChip('disconnected', 'מנותק');
    if (err && err.name === 'NotFoundError') toast('לא נבחר בקר. ודאו שהוא דלוק וקרוב, ונסו שוב.');
    else if (err && err.name === 'SecurityError') toast('אין הרשאת בלוטות\'. אשרו "מכשירים בקרבת מקום" בהגדרות Chrome.');
    else toast('החיבור נכשל. כבו והדליקו את הבקר ונסו שוב.');
  }
}

async function connectDemo() {
  S.userDisconnect = false;
  if (S.transport) await disconnectQuiet();
  S.userDisconnect = false;
  const t = new DemoDevice();
  attachTransport(t);
  S.demo = true;
  await t.connect();
  await afterConnect();
}

async function disconnectQuiet() {
  S.userDisconnect = true;
  const t = S.transport;
  S.transport = null; S.connected = false;
  if (t) { try { await t.disconnect(); } catch (e) { /* ignore */ } }
}

async function onDisconnected(byUser) {
  if (!S.connected && !S.transport) return;
  S.connected = false;
  if (waiter) waiter.fail('NOTCONN');
  lockSettings();
  renderAll();
  const t = S.transport;
  if (byUser || S.userDisconnect || S.demo || !(t instanceof BleTransport)) {
    S.transport = null;
    setChip('disconnected', 'מנותק');
    renderAll();
    return;
  }
  for (const delay of RECONNECT_DELAYS_MS) {
    setChip('connecting', 'מתחבר מחדש…');
    await new Promise(r => setTimeout(r, delay));
    if (S.userDisconnect || S.transport !== t) return;
    try { await t.openGatt(); await afterConnect(); return; } catch (e) { /* try again */ }
  }
  S.transport = null;
  setChip('disconnected', 'מנותק');
  toast('הקשר עם הבקר אבד. לחצו "התחבר" כדי להתחבר שוב.');
  renderAll();
}

/* ======================= rendering ======================= */

function setChip(kind, text) { $('chip').dataset.state = kind; $('chipText').textContent = text; }

let toastTimer = null;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 6000);
}

// \u2066…\u2069 keeps "42.0°" in number order inside Hebrew text
const deg = v => (typeof v === 'number' ? `\u2066${v.toFixed(1)}°\u2069` : '—');
const maxC = () => (S.config ? S.config.max : 47);
const hardMaxC = () => (S.config && S.config.hardMax) || 50;

function setMsg(id, text, kind) {
  const el = $(id);
  el.textContent = text || '';
  el.className = 'msg' + (kind ? ' ' + kind : '');
}

function renderAll() {
  $('deviceName').textContent = S.connected
    ? `מחובר אל ${S.transport.name}`
    : 'לא מחובר';
  $('connBtn').textContent = S.connected ? 'התנתק' : 'התחבר';
  $('connectCard').hidden = S.connected;
  renderMonitor();
  renderFixed();
  renderProfile();
  renderSettings();
  drawChart();
}

function profileTotalMin(steps) { return steps.reduce((a, s) => a + (s.minutes || 0), 0); }

function savedProgramText() {
  const c = S.config;
  if (!c) return 'יוצג אחרי ההתחברות';
  const lim = ` הבקר לא יחמם מעל ${deg(c.max)}.`;
  if (c.mode === 'P' && c.steps > 0) {
    const ready = S.boardProfile.every(Boolean);
    const total = ready ? `, מחזור של ${Core.formatDuration(profileTotalMin(S.boardProfile))}` : '';
    return `עוקב אחרי פרופיל של ${c.steps} שלבים${total}, ומתחיל מהשלב הראשון.${lim}`;
  }
  return `מחמם לטמפרטורה קבועה של ${deg(c.sp)}.${lim}`;
}

function renderMonitor() {
  const s = S.status;
  const live = S.connected && s;
  $('tempNow').innerHTML = live ? `${s.temp.toFixed(1)}<small>°</small>` : '—';
  $('targetNow').textContent = live ? deg(s.target) : '—';
  let mode = '—';
  if (live) {
    if (s.mode === 'P') {
      const n = S.config ? S.config.steps : '?';
      mode = `פרופיל · שלב ${s.step + 1} מתוך ${n} · עוד ${Core.formatClock(s.left)}`;
    } else mode = 'טמפרטורה קבועה';
  }
  $('modeLine').textContent = mode;
  $('batLine').textContent = live && typeof s.battery === 'number' ? `סוללה ${s.battery.toFixed(2)}V` : '';
  $('dutyFill').style.width = live ? `${clamp(s.duty, 0, 100)}%` : '0';
  $('dutyText').textContent = live ? `עוצמת חימום ${Math.round(s.duty)}%` : 'עוצמת חימום —';
  $('runLine').textContent = !live ? '' : s.fault ? 'נעצר בגלל תקלה' : s.running ? 'החימום פועל' : 'החימום עצור';

  const runBtn = $('runBtn');
  runBtn.disabled = !live || S.busy;
  runBtn.textContent = live && !s.running ? 'הפעל חימום' : 'עצור חימום';
  runBtn.className = 'btn ' + (live && !s.running ? 'primary' : 'secondary');

  $('faultBanner').hidden = !(live && s.fault);
  if (live && s.fault) $('faultText').textContent = Core.FAULTS[s.fault] || `תקלה ${s.fault}`;
  $('simBanner').hidden = !(live && s.simulated);
  $('savedProgram').textContent = S.connected ? savedProgramText() : 'יוצג אחרי ההתחברות';
}

function renderFixed() {
  const mx = maxC();
  S.spDraft = clamp(S.spDraft, LIMITS.minC, mx);
  $('spValue').textContent = deg(S.spDraft);
  const sl = $('spSlider');
  sl.max = String(mx); sl.min = String(LIMITS.minC); sl.value = String(S.spDraft);
  $('spMinLbl').textContent = deg(LIMITS.minC);
  $('spMaxLbl').textContent = deg(mx);
  $('spMinus').disabled = S.spDraft <= LIMITS.minC;
  $('spPlus').disabled = S.spDraft >= mx;
  $('spSave').disabled = !S.connected || S.busy;
  const c = S.config;
  let saved = 'התחברו לבקר כדי לראות מה שמור בו.';
  if (S.connected && c) {
    saved = `שמור כרגע בבקר: ${deg(c.sp)}.`;
    if (c.mode === 'P') saved += ' כרגע הבקר עוקב אחרי הפרופיל. שמירה כאן תעביר אותו לטמפרטורה קבועה, והפרופיל יישאר שמור.';
  }
  $('spSaved').textContent = saved;
}

function renderSettings() {
  $('lockForm').hidden = S.unlocked;
  $('settingsPanel').hidden = !S.unlocked;
  $('unlockBtn').disabled = !S.connected || $('pwdInput').value.length < 4 || S.busy;
  const hx = hardMaxC();
  S.maxDraft = clamp(roundHalf(S.maxDraft), LIMITS.minC, hx);
  $('maxValue').textContent = deg(S.maxDraft);
  $('maxMinus').disabled = S.maxDraft <= LIMITS.minC;
  $('maxPlus').disabled = S.maxDraft >= hx;
  $('hardMaxNote').textContent = `אי אפשר לעלות מעל ${deg(hx)}: זה גבול קבוע בקוד הבקר.`;
  $('maxSave').disabled = !S.connected || S.busy;
  $('pwdSave').disabled = !S.connected || S.busy;
  $('infoName').textContent = S.connected ? S.transport.name : '—';
  $('infoMax').textContent = S.config ? deg(S.config.max) : '—';
  $('infoHard').textContent = S.config ? deg(S.config.hardMax) : '—';
  $('infoBat').textContent = S.status && typeof S.status.battery === 'number' ? `${S.status.battery.toFixed(2)}V` : '—';
}

/* ======================= profile editor ======================= */

function renderProfile() {
  const mx = maxC();
  const c = S.config;
  const st = $('profileState');
  let text = '';
  if (!S.connected) text = 'התחברו לבקר כדי לטעון ולשמור פרופיל.';
  else if (c && c.steps === 0) text = 'אין עדיין פרופיל שמור בבקר.';
  else if (c && c.mode === 'F') text = 'בבקר שמור פרופיל, אבל כרגע הוא עובד בטמפרטורה קבועה.';
  else if (c && c.mode === 'P') text = 'הבקר עוקב כרגע אחרי הפרופיל השמור.';
  if (S.draftDirty) text += (text ? ' ' : '') + 'יש כאן שינויים שעוד לא נשמרו בבקר.';
  st.textContent = text;
  st.hidden = !text;
  $('profileActivate').hidden = !(S.connected && c && c.mode === 'F' && c.steps > 0);
  $('profileActivate').disabled = S.busy;
  $('profileReset').disabled = !S.connected || S.busy;

  const list = $('steps');
  // keep the list in sync without stealing focus from a field being edited
  const active = document.activeElement;
  if (active && list.contains(active) && active.tagName === 'INPUT') { renderPreview(); return; }

  list.textContent = '';
  if (!S.draft.length) {
    const p = document.createElement('p');
    p.className = 'intro';
    p.textContent = 'אין שלבים. לחצו "הוסף שלב" כדי להתחיל.';
    list.appendChild(p);
  }
  S.draft.forEach((s, i) => list.appendChild(stepRow(s, i, mx)));
  $('addStep').disabled = S.draft.length >= LIMITS.maxSteps;
  renderPreview();
}

function stepRow(s, i, mx) {
  const row = document.createElement('div');
  row.className = 'step';
  row.innerHTML = `
    <div class="step-head">
      <b>שלב ${i + 1}</b>
      <div class="icons">
        <button data-act="up" aria-label="הזז למעלה" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button data-act="down" aria-label="הזז למטה" ${i === S.draft.length - 1 ? 'disabled' : ''}>↓</button>
        <button data-act="del" aria-label="מחק שלב">✕</button>
      </div>
    </div>
    <div class="step-body">
      <div class="stepper small">
        <button data-act="minus" aria-label="הורד חצי מעלה" ${s.temp <= LIMITS.minC ? 'disabled' : ''}>−</button>
        <div class="val">${deg(s.temp)}</div>
        <button data-act="plus" aria-label="העלה חצי מעלה" ${s.temp >= mx ? 'disabled' : ''}>+</button>
      </div>
      <div class="dur">
        <input type="number" inputmode="numeric" min="0" max="24" data-f="h" aria-label="שעות בשלב ${i + 1}" value="${Math.floor(s.minutes / 60)}"> שע'
        <input type="number" inputmode="numeric" min="0" max="59" data-f="m" aria-label="דקות בשלב ${i + 1}" value="${s.minutes % 60}"> דק'
      </div>
    </div>`;
  row.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    const d = S.draft;
    switch (b.dataset.act) {
      case 'up': [d[i - 1], d[i]] = [d[i], d[i - 1]]; break;
      case 'down': [d[i + 1], d[i]] = [d[i], d[i + 1]]; break;
      case 'del': d.splice(i, 1); break;
      case 'minus': d[i].temp = clamp(roundHalf(d[i].temp - 0.5), LIMITS.minC, mx); break;
      case 'plus': d[i].temp = clamp(roundHalf(d[i].temp + 0.5), LIMITS.minC, mx); break;
      default: return;
    }
    S.draftDirty = true;
    renderProfile();
  });
  row.addEventListener('input', e => {
    const inp = e.target;
    if (!inp.dataset.f) return;
    const hEl = row.querySelector('[data-f="h"]'), mEl = row.querySelector('[data-f="m"]');
    const h = parseInt(hEl.value, 10) || 0, m = parseInt(mEl.value, 10) || 0;
    S.draft[i].minutes = h * 60 + m;
    S.draftDirty = true;
    renderPreview();
    const st = $('profileState');
    if (!st.textContent.includes('שינויים')) renderProfileStateOnly();
  });
  row.addEventListener('focusout', () => setTimeout(() => {
    if (!row.contains(document.activeElement)) renderProfile();
  }, 0));
  return row;
}

function renderProfileStateOnly() {
  const st = $('profileState');
  st.textContent = (st.textContent ? st.textContent + ' ' : '') + 'יש כאן שינויים שעוד לא נשמרו בבקר.';
  st.hidden = false;
}

function renderPreview() {
  const steps = S.draft;
  const mx = maxC();
  const errs = Core.validateProfile(steps, mx);
  const ul = $('profileErrors');
  ul.textContent = '';
  errs.forEach(t => { const li = document.createElement('li'); li.textContent = t; ul.appendChild(li); });
  ul.hidden = !errs.length || !steps.length;
  $('profileSave').disabled = !S.connected || S.busy || errs.length > 0;

  const total = profileTotalMin(steps);
  $('cycleText').textContent = steps.length && total
    ? `מחזור של ${Core.formatDuration(total)}, ואז חוזר לשלב 1.`
    : '';
  const box = $('preview');
  if (!steps.length || !total) { box.innerHTML = '<p class="intro small">התצוגה תופיע כשיהיה לפחות שלב אחד.</p>'; return; }

  const W = 320, H = 130, L = 34, R = 8, T = 18, B = 22;
  const temps = steps.map(s => s.temp);
  let lo = Math.floor(Math.min(...temps) - 1), hi = Math.ceil(Math.max(...temps) + 1);
  if (hi - lo < 4) hi = lo + 4;
  const x = m => L + (m / total) * (W - L - R);
  const y = t => T + (1 - (t - lo) / (hi - lo)) * (H - T - B);
  let path = '', acc = 0, labels = '', ticks = '';
  steps.forEach((s, i) => {
    const x0 = x(acc), x1 = x(acc + s.minutes), yy = y(s.temp);
    path += (i === 0 ? `M${x0},${yy}` : `L${x0},${yy}`) + `L${x1},${yy}`;
    if (x1 - x0 > 26) labels += `<text x="${(x0 + x1) / 2}" y="${yy - 5}" text-anchor="middle" font-size="10" fill="currentColor">${s.temp.toFixed(1)}°</text>`;
    acc += s.minutes;
  });
  // closing jump back to step 1 (the cycle repeats)
  path += `L${x(total)},${y(steps[0].temp)}`;
  for (let t = lo; t <= hi; t += (hi - lo > 8 ? 2 : 1)) {
    ticks += `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" stroke="var(--border)" stroke-width="1"/>`
           + `<text x="${L - 5}" y="${y(t) + 3}" text-anchor="end" font-size="9" fill="var(--fg-muted)">${t}°</text>`;
  }
  const tEnd = `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="תצוגת מחזור אחד של הפרופיל" style="direction:ltr">
      ${ticks}
      <path d="${path}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round"/>
      ${labels}
      <text x="${L}" y="${H - 6}" font-size="9" fill="var(--fg-muted)">0</text>
      <text x="${W - R}" y="${H - 6}" text-anchor="end" font-size="9" fill="var(--fg-muted)">${tEnd}</text>
    </svg>`;
}

/* ======================= chart ======================= */

function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

function niceStep(span) {
  for (const s of [0.5, 1, 2, 5]) if (span / s <= 6) return s;
  return 10;
}

function drawChart() {
  const cv = $('chart');
  const rect = cv.getBoundingClientRect();
  if (!rect.width) return;
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(rect.width * dpr);
  cv.height = Math.round(rect.height * dpr);
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = rect.width, H = rect.height;
  ctx.clearRect(0, 0, W, H);

  const now = Date.now();
  const from = S.windowMin ? now - S.windowMin * 60000 : (S.history[0] ? S.history[0].t : now);
  const pts = S.history.filter(p => p.t >= from);
  $('chartEmpty').hidden = pts.length > 0;
  if (!pts.length) return;

  const tStart = Math.min(from, pts[0].t), tEnd = Math.max(now, tStart + 60000);
  const vals = pts.flatMap(p => [p.temp, p.target]).filter(v => typeof v === 'number');
  let lo = Math.min(...vals) - 0.5, hi = Math.max(...vals) + 0.5;
  if (hi - lo < 3) { const mid = (hi + lo) / 2; lo = mid - 1.5; hi = mid + 1.5; }
  const step = niceStep(hi - lo);
  lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;

  const L = 40, R = 10, T = 10, B = 24;
  const x = t => L + (t - tStart) / (tEnd - tStart) * (W - L - R);
  const y = v => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);

  const fg = cssVar('--fg-muted'), border = cssVar('--border');
  ctx.font = `11px ${cssVar('--font') || 'sans-serif'}`;
  ctx.fillStyle = fg;
  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let v = lo; v <= hi + 1e-6; v += step) {
    ctx.beginPath(); ctx.moveTo(L, y(v)); ctx.lineTo(W - R, y(v)); ctx.stroke();
    ctx.fillText(`${Number.isInteger(v) ? v : v.toFixed(1)}°`, L - 6, y(v));
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const fmt = t => new Date(t).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
  const nLabels = W < 360 ? 3 : 4;
  for (let i = 0; i < nLabels; i++) {
    const t = tStart + (tEnd - tStart) * (i / (nLabels - 1));
    const xx = clamp(x(t), L + 16, W - R - 16);
    ctx.fillText(fmt(t), xx, H - 6);
  }

  // target: dashed step line
  ctx.strokeStyle = cssVar('--target');
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  pts.forEach((p, i) => {
    if (typeof p.target !== 'number') return;
    if (i === 0) ctx.moveTo(x(p.t), y(p.target));
    else { ctx.lineTo(x(p.t), y(pts[i - 1].target)); ctx.lineTo(x(p.t), y(p.target)); }
  });
  ctx.lineTo(x(now), y(pts[pts.length - 1].target));
  ctx.stroke();
  ctx.setLineDash([]);

  // temperature: solid line + last point
  ctx.strokeStyle = cssVar('--accent');
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(x(p.t), y(p.temp)) : ctx.moveTo(x(p.t), y(p.temp))));
  ctx.stroke();
  const last = pts[pts.length - 1];
  ctx.fillStyle = cssVar('--accent');
  ctx.beginPath(); ctx.arc(x(last.t), y(last.temp), 4, 0, Math.PI * 2); ctx.fill();
}

/* ======================= actions ======================= */

async function busy(fn) {
  S.busy = true; renderAll();
  try { return await fn(); } finally { S.busy = false; renderAll(); }
}

async function saveSetPoint() {
  setMsg('spMsg', 'שומר…');
  try {
    await busy(() => command(`SP:${toTenths(S.spDraft)}`));
    S.spDirty = false;
    setMsg('spMsg', `נשמר בבקר. מעכשיו הבקר יחמם ל-${deg(S.spDraft)} בכל הפעלה.`, 'ok');
  } catch (e) { setMsg('spMsg', `לא נשמר: ${reasonText(e)}.`, 'err'); }
}

async function saveProfile() {
  const steps = S.draft.map(s => ({ temp: roundHalf(s.temp), minutes: s.minutes }));
  const cmds = Core.profileCommands(steps);
  try {
    await busy(async () => {
      for (let i = 0; i < cmds.length; i++) {
        if (cmds[i].startsWith('PS')) setMsg('profileMsg', `שולח שלב ${i} מתוך ${steps.length}…`);
        await command(cmds[i]);
      }
    });
    S.draftDirty = false;
    setMsg('profileMsg', 'הפרופיל נשמר בבקר והופעל. מעכשיו הבקר יעקוב אחריו בכל הפעלה.', 'ok');
    renderProfile();
  } catch (e) { setMsg('profileMsg', `הפרופיל לא נשמר: ${reasonText(e)}. הבקר ממשיך עם מה שהיה שמור בו קודם.`, 'err'); }
}

async function activateProfile() {
  try {
    await busy(() => command('MD:P'));
    setMsg('profileMsg', 'הבקר חזר לפרופיל השמור, מהשלב הראשון.', 'ok');
  } catch (e) { setMsg('profileMsg', `לא בוצע: ${reasonText(e)}.`, 'err'); }
}

function reloadProfileFromBoard() {
  S.draftDirty = false;
  S.draft = S.boardProfile.every(Boolean) ? S.boardProfile.map(s => ({ ...s })) : [];
  setMsg('profileMsg', '');
  renderProfile();
}

async function toggleRun() {
  const s = S.status;
  if (!s) return;
  try { await busy(() => command(s.running ? 'RUN:0' : 'RUN:1')); }
  catch (e) { toast(`לא בוצע: ${reasonText(e)}.`); }
}

async function retryAfterFault() {
  try { await busy(() => command('RUN:1')); }
  catch (e) { $('faultText').textContent = `${Core.FAULTS[S.status && S.status.fault] || ''} ${reasonText(e)}.`; }
}

async function unlock(e) {
  e.preventDefault();
  const pwd = $('pwdInput').value.trim();
  setMsg('lockMsg', 'בודק…');
  try {
    await busy(() => command(`AU:${pwd}`));
    S.unlocked = true; S.pwd = pwd;
    S.maxDraft = maxC();
    $('pwdInput').value = '';
    setMsg('lockMsg', '');
    renderAll();
  } catch (err) { setMsg('lockMsg', reasonText(err), 'err'); }
}

function lockSettings() {
  S.unlocked = false; S.pwd = null;
  ['newPwd', 'newPwd2'].forEach(id => { $(id).value = ''; });
  setMsg('maxMsg', ''); setMsg('pwdMsg', '');
}

async function saveMax() {
  const newMax = S.maxDraft;
  const above = (S.config && S.config.sp > newMax) || S.boardProfile.some(s => s && s.temp > newMax);
  try {
    await busy(() => command(`MX:${toTenths(newMax)}:${S.pwd}`));
    let text = `נשמר. הבקר לא יחמם מעל ${deg(newMax)}.`;
    if (above) text += ' טמפרטורות שמורות שהיו גבוהות יותר הורדו למקסימום החדש.';
    setMsg('maxMsg', text, 'ok');
  } catch (e) { setMsg('maxMsg', `לא נשמר: ${reasonText(e)}.`, 'err'); }
}

async function changePassword(e) {
  e.preventDefault();
  const a = $('newPwd').value.trim(), b = $('newPwd2').value.trim();
  if (!Core.validPassword(a)) return setMsg('pwdMsg', 'הסיסמה חייבת להיות 4–8 ספרות.', 'err');
  if (a !== b) return setMsg('pwdMsg', 'שתי ההקלדות לא זהות.', 'err');
  try {
    await busy(() => command(`PW:${S.pwd}:${a}`));
    S.pwd = a;
    $('newPwd').value = ''; $('newPwd2').value = '';
    setMsg('pwdMsg', 'הסיסמה הוחלפה. רשמו אותה במקום בטוח.', 'ok');
  } catch (err) { setMsg('pwdMsg', `לא הוחלפה: ${reasonText(err)}.`, 'err'); }
}

function showView(v) {
  if (S.view === 'settings' && v !== 'settings') lockSettings();
  S.view = v;
  ['monitor', 'fixed', 'profile', 'settings'].forEach(n => { $(`view-${n}`).hidden = n !== v; });
  document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.view === v)));
  window.scrollTo(0, 0);
  renderAll();
}

/* ======================= wiring ======================= */

$('connBtn').addEventListener('click', () => (S.connected ? disconnectQuiet().then(() => { setChip('disconnected', 'מנותק'); renderAll(); }) : connectBle()));
$('connectBig').addEventListener('click', connectBle);
$('demoBtn').addEventListener('click', connectDemo);
$('runBtn').addEventListener('click', toggleRun);
$('faultRetry').addEventListener('click', retryAfterFault);

$('winSeg').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  S.windowMin = parseInt(b.dataset.min, 10);
  $('winSeg').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  drawChart();
});

const nudgeSp = d => { S.spDraft = clamp(roundHalf(S.spDraft + d), LIMITS.minC, maxC()); S.spDirty = true; setMsg('spMsg', ''); renderFixed(); };
$('spMinus').addEventListener('click', () => nudgeSp(-0.5));
$('spPlus').addEventListener('click', () => nudgeSp(0.5));
$('spSlider').addEventListener('input', e => { S.spDraft = roundHalf(parseFloat(e.target.value)); S.spDirty = true; setMsg('spMsg', ''); renderFixed(); });
$('spSave').addEventListener('click', saveSetPoint);

$('addStep').addEventListener('click', () => {
  if (S.draft.length >= LIMITS.maxSteps) return;
  const last = S.draft[S.draft.length - 1];
  S.draft.push({ temp: clamp(last ? last.temp : 40, LIMITS.minC, maxC()), minutes: 30 });
  S.draftDirty = true;
  renderProfile();
});
$('profileSave').addEventListener('click', saveProfile);
$('profileReset').addEventListener('click', reloadProfileFromBoard);
$('profileActivate').addEventListener('click', activateProfile);

$('lockForm').addEventListener('submit', unlock);
$('pwdInput').addEventListener('input', renderSettings);
$('maxMinus').addEventListener('click', () => { S.maxDraft -= 0.5; setMsg('maxMsg', ''); renderSettings(); });
$('maxPlus').addEventListener('click', () => { S.maxDraft += 0.5; setMsg('maxMsg', ''); renderSettings(); });
$('maxSave').addEventListener('click', saveMax);
$('pwdForm').addEventListener('submit', changePassword);
$('lockBtn').addEventListener('click', () => { lockSettings(); renderAll(); });

document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));

window.addEventListener('resize', drawChart);
if (window.matchMedia) window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', drawChart);
setInterval(() => { if (S.history.length) drawChart(); }, 15000);

if (!navigator.bluetooth) { $('noBle').hidden = false; $('connectBig').disabled = true; }

let installPrompt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; $('installBtn').hidden = false; });
$('installBtn').addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt(); await installPrompt.userChoice;
  installPrompt = null; $('installBtn').hidden = true;
});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

renderAll();
if (/[?&]demo\b/.test(location.search)) connectDemo();
