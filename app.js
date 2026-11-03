/* Heater BLE test app — talks to the Feather 32u4 Bluefruit LE over the
   Bluetooth "UART" service (Nordic UART Service, NUS).

   Messages (plain text):
     phone -> board :  "LED:1"  "LED:0"  "STATUS"
     board -> phone :  "LED:1;BAT:3.92;UP:125"  (one line, ends with a line break)
                       "ERR:..."                 (error message)
*/
'use strict';

const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_RX      = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // phone writes here
const NUS_TX      = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // board notifies here
const NAME_PREFIX = 'HeaterTest';
const CONFIRM_TIMEOUT_MS = 3000;   // how long to wait for the board to confirm a command
const STALE_AFTER_MS = 6000;       // readings look faded if nothing arrived for this long
const RECONNECT_DELAYS_MS = [1000, 2000, 4000];

/* ---------- pure helpers (also tested outside the browser) ---------- */

// Split incoming text into complete lines. Returns { lines, rest }.
// Accepts real line breaks and a literal backslash-n, in case the module
// forwards the escape as text.
function splitLines(buffer) {
  const normalized = buffer.replace(/\\n/g, '\n').replace(/\r/g, '');
  const parts = normalized.split('\n');
  const rest = parts.pop();
  return { lines: parts.map(s => s.trim()).filter(Boolean), rest };
}

// "LED:1;BAT:3.92;UP:125" -> { led: true, bat: 3.92, up: 125 }
// "ERR:something"         -> { error: "something" }
function parseLine(line) {
  if (line.startsWith('ERR:')) return { error: line.slice(4) };
  const out = {};
  for (const part of line.split(';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const key = part.slice(0, i).trim().toUpperCase();
    const val = part.slice(i + 1).trim();
    if (key === 'LED') out.led = val === '1';
    else if (key === 'BAT') { const n = parseFloat(val); if (!isNaN(n)) out.bat = n; }
    else if (key === 'UP')  { const n = parseInt(val, 10); if (!isNaN(n)) out.up = n; }
  }
  return out;
}

// Rough LiPo charge estimate from voltage (resting voltage, 3.3V–4.2V).
function batteryPercent(volts) {
  const table = [[4.20,100],[4.10,90],[4.00,78],[3.90,65],[3.80,50],[3.75,40],[3.70,30],[3.65,20],[3.55,10],[3.40,3],[3.30,0]];
  if (volts >= table[0][0]) return 100;
  for (let i = 1; i < table.length; i++) {
    const [v1, p1] = table[i - 1], [v2, p2] = table[i];
    if (volts >= v2) return Math.round(p2 + (p1 - p2) * (volts - v2) / (v1 - v2));
  }
  return 0;
}

function formatUptime(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const pad = n => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

if (typeof module !== 'undefined') {
  module.exports = { splitLines, parseLine, batteryPercent, formatUptime };
}

/* ---------- browser app ---------- */

if (typeof window !== 'undefined') {
  const $ = id => document.getElementById(id);
  const ui = {
    chip: $('chip'), chipText: $('chipText'), deviceName: $('deviceName'),
    unsupported: $('unsupported'), ledBtn: $('ledBtn'), ledBtnText: $('ledBtnText'),
    ledBtnState: $('ledBtnState'), hint: $('hint'), readings: $('readings'),
    bat: $('bat'), batNote: $('batNote'), up: $('up'), lastSeen: $('lastSeen'),
    connectBtn: $('connectBtn'), installBtn: $('installBtn'), log: $('log'),
  };

  const state = {
    device: null, rx: null, tx: null,
    connected: false, userDisconnect: false,
    led: null, pending: null, pendingTimer: null,
    lastDataAt: 0, rxBuffer: '',
    writeChain: Promise.resolve(),
  };
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function log(text) {
    const t = new Date().toLocaleTimeString('he-IL', { hour12: false });
    ui.log.textContent = `${t}  ${text}\n` + ui.log.textContent.slice(0, 8000);
  }

  function setChip(kind, text) {
    ui.chip.dataset.state = kind;
    ui.chipText.textContent = text;
  }

  function setHint(text, isError) {
    ui.hint.textContent = text;
    ui.hint.classList.toggle('err', !!isError);
  }

  function renderLed() {
    const on = state.led === true;
    ui.ledBtn.dataset.on = on ? '1' : '0';
    ui.ledBtn.dataset.pending = state.pending !== null ? '1' : '0';
    ui.ledBtn.disabled = !state.connected || state.pending !== null;
    if (state.pending !== null) {
      ui.ledBtnText.textContent = state.pending ? 'מדליק…' : 'מכבה…';
      ui.ledBtnState.textContent = 'ממתין לאישור מהבקר';
    } else if (state.led === null) {
      ui.ledBtnText.textContent = 'הדלק';
      ui.ledBtnState.textContent = 'מצב לא ידוע';
    } else {
      ui.ledBtnText.textContent = on ? 'כבה' : 'הדלק';
      ui.ledBtnState.textContent = on ? 'הנורית דולקת' : 'הנורית כבויה';
    }
  }

  function renderConnection() {
    if (state.connected) {
      ui.connectBtn.textContent = 'התנתק';
      ui.connectBtn.className = 'btn secondary';
      ui.deviceName.textContent = `מחובר אל ${state.device && state.device.name || 'הבקר'}`;
    } else {
      ui.connectBtn.textContent = 'התחבר לבקר';
      ui.connectBtn.className = 'btn primary';
      ui.deviceName.textContent = 'לא מחובר לבקר';
    }
    renderLed();
  }

  function applyStatus(s) {
    state.lastDataAt = Date.now();
    ui.readings.classList.remove('stale');
    if (s.led !== undefined) {
      state.led = s.led;
      if (state.pending !== null && state.pending === s.led) {
        clearTimeout(state.pendingTimer);
        state.pending = null;
        setHint(s.led ? 'הבקר אישר: הנורית דולקת' : 'הבקר אישר: הנורית כבויה');
      }
    }
    if (s.bat !== undefined) {
      ui.bat.innerHTML = `${s.bat.toFixed(2)} <small>V</small>`;
      ui.batNote.textContent = s.bat < 3.0 || s.bat > 4.4
        ? 'אין סוללה מחוברת (מוזן מ-USB)'
        : `בערך ${batteryPercent(s.bat)}% טעינה`;
    }
    if (s.up !== undefined) ui.up.textContent = formatUptime(s.up);
    renderLed();
  }

  function handleLine(line) {
    log(`← ${line}`);
    const s = parseLine(line);
    if (s.error) { setHint(`הבקר דיווח על שגיאה: ${s.error}`, true); return; }
    applyStatus(s);
  }

  function onNotify(event) {
    state.rxBuffer += decoder.decode(event.target.value);
    const { lines, rest } = splitLines(state.rxBuffer);
    state.rxBuffer = rest.length > 200 ? '' : rest;
    lines.forEach(handleLine);
  }

  // Writes go one at a time; Bluetooth rejects overlapping operations.
  function send(text) {
    const job = state.writeChain.then(async () => {
      if (!state.rx) throw new Error('not connected');
      const data = encoder.encode(text);
      if (state.rx.properties.write && state.rx.writeValueWithResponse) {
        await state.rx.writeValueWithResponse(data);
      } else if (state.rx.writeValueWithoutResponse) {
        await state.rx.writeValueWithoutResponse(data);
      } else {
        await state.rx.writeValue(data);
      }
      log(`→ ${text}`);
    });
    state.writeChain = job.catch(() => {});
    return job;
  }

  async function setupGatt() {
    const server = await state.device.gatt.connect();
    const service = await server.getPrimaryService(NUS_SERVICE);
    state.rx = await service.getCharacteristic(NUS_RX);
    state.tx = await service.getCharacteristic(NUS_TX);
    if (!state.tx.__hooked) {          // Chrome may hand back the same object after a reconnect
      state.tx.addEventListener('characteristicvaluechanged', onNotify);
      state.tx.__hooked = true;
    }
    await state.tx.startNotifications();
    state.connected = true;
    state.rxBuffer = '';
    setChip('connected', 'מחובר');
    setHint('לחצו על העיגול כדי להדליק או לכבות');
    renderConnection();
    log('מחובר');
    await send('STATUS');
  }

  async function connect() {
    if (!navigator.bluetooth) { ui.unsupported.hidden = false; return; }
    state.userDisconnect = false;
    try {
      setChip('connecting', 'מחפש…');
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: NAME_PREFIX }, { services: [NUS_SERVICE] }],
        optionalServices: [NUS_SERVICE],
      });
      if (state.device && state.device !== device) {
        state.device.removeEventListener('gattserverdisconnected', onDisconnected);
      }
      state.device = device;
      device.addEventListener('gattserverdisconnected', onDisconnected);
      setChip('connecting', 'מתחבר…');
      log(`נבחר: ${device.name || device.id}`);
      await setupGatt();
    } catch (err) {
      state.connected = false;
      setChip('disconnected', 'מנותק');
      renderConnection();
      if (err && err.name === 'NotFoundError') {
        setHint('לא נבחר בקר. ודאו שהבקר דלוק וקרוב, ונסו שוב.');
      } else if (err && err.name === 'SecurityError') {
        setHint('אין הרשאת בלוטות\'. אשרו "מכשירים בקרבת מקום" בהגדרות Chrome.', true);
      } else {
        setHint('החיבור נכשל. כבו והדליקו את הבקר ונסו שוב.', true);
      }
      log(`שגיאה: ${err && err.message}`);
    }
  }

  function disconnect() {
    state.userDisconnect = true;
    if (state.device && state.device.gatt.connected) state.device.gatt.disconnect();
    else onDisconnected();
  }

  async function onDisconnected() {
    const wasConnected = state.connected;
    state.connected = false;
    state.rx = null; state.tx = null;
    state.pending = null; clearTimeout(state.pendingTimer);
    renderConnection();
    if (wasConnected) log('החיבור נותק');

    if (state.userDisconnect || !state.device) {
      setChip('disconnected', 'מנותק');
      setHint('התחברו לבקר כדי לשלוט בנורית');
      return;
    }
    // Lost the link unexpectedly: try to reconnect to the same board.
    for (const delay of RECONNECT_DELAYS_MS) {
      setChip('connecting', 'מתחבר מחדש…');
      setHint('הקשר עם הבקר נותק. מנסה להתחבר מחדש…');
      await new Promise(r => setTimeout(r, delay));
      if (state.userDisconnect) return;
      try { await setupGatt(); return; } catch (e) { log(`ניסיון חוזר נכשל: ${e.message}`); }
    }
    setChip('disconnected', 'מנותק');
    setHint('לא הצלחתי להתחבר מחדש. לחצו "התחבר לבקר".', true);
  }

  async function toggleLed() {
    if (!state.connected || state.pending !== null) return;
    const want = !(state.led === true);
    state.pending = want;
    renderLed();
    setHint('');
    clearTimeout(state.pendingTimer);
    state.pendingTimer = setTimeout(() => {
      if (state.pending === null) return;
      state.pending = null;
      renderLed();
      setHint('הבקר לא אישר את הפקודה. נסו שוב.', true);
    }, CONFIRM_TIMEOUT_MS);
    try {
      await send(want ? 'LED:1' : 'LED:0');
    } catch (err) {
      clearTimeout(state.pendingTimer);
      state.pending = null;
      renderLed();
      setHint('השליחה נכשלה. בדקו את החיבור.', true);
      log(`שגיאת שליחה: ${err.message}`);
    }
  }

  // Fade readings and show their age when data stops arriving.
  setInterval(() => {
    if (!state.lastDataAt) return;
    const age = Math.round((Date.now() - state.lastDataAt) / 1000);
    ui.lastSeen.textContent = age <= 1 ? 'עודכן עכשיו' : `עודכן לפני ${age} שניות`;
    ui.readings.classList.toggle('stale', Date.now() - state.lastDataAt > STALE_AFTER_MS);
  }, 1000);

  ui.connectBtn.addEventListener('click', () => state.connected ? disconnect() : connect());
  ui.ledBtn.addEventListener('click', toggleLed);

  if (!navigator.bluetooth) {
    ui.unsupported.hidden = false;
    ui.connectBtn.disabled = true;
  }

  // "Install as app" button (Chrome on Android offers this once the page is eligible).
  let installPrompt = null;
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    installPrompt = e;
    ui.installBtn.hidden = false;
  });
  ui.installBtn.addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    ui.installBtn.hidden = true;
  });
  window.addEventListener('appinstalled', () => { ui.installBtn.hidden = true; });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  renderConnection();
}
