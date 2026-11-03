/* demo.js — a pretend heater controller that runs inside the app, so the app
   can be tried without the board. It speaks the same text protocol as the
   firmware and uses the same simple heater-on-skin model.
   Settings persist in this browser only (localStorage). */
(function (root) {
  'use strict';
  const HARD_MAX = 500, MIN = 300, KEY = 'heaterDemoConfig';

  function DemoDevice() {
    this.name = 'HeaterCtrl (הדגמה)';
    this.listeners = { line: [], disconnect: [] };
    this.timers = [];
    this.cfg = this.load();
    this.temp = 35; this.duty = 0; this.integ = 0; this.on = false;
    this.running = true; this.fault = 0;
    this.stepIdx = 0; this.stepStart = Date.now(); this.windowStart = Date.now();
    this.last = Date.now(); this.upload = null; this.bad = 0;
  }

  DemoDevice.prototype.load = function () {
    try {
      const c = JSON.parse(localStorage.getItem(KEY));
      if (c && c.max10) {
        if (c.v !== 2) { c.v = 2; c.max10 = Math.min(c.max10, 470); c.sp10 = Math.min(c.sp10, c.max10); c.steps.forEach(s => { s.t10 = Math.min(s.t10, c.max10); }); }
        return c;
      }
    } catch (e) { /* storage blocked: use defaults */ }
    return { v: 2, max10: 470, sp10: 390, mode: 'F', pwd: '1234', steps: [] };
  };
  DemoDevice.prototype.save = function () {
    try { localStorage.setItem(KEY, JSON.stringify(this.cfg)); } catch (e) { /* ignore */ }
  };

  DemoDevice.prototype.on_ = function (ev, cb) { this.listeners[ev].push(cb); };
  DemoDevice.prototype.emit = function (line) {
    setTimeout(() => this.listeners.line.forEach(cb => cb(line)), 30);
  };

  DemoDevice.prototype.connect = async function () {
    this.timers.push(setInterval(() => this.tick(), 250));
    this.timers.push(setInterval(() => this.status(), 5000));
  };
  DemoDevice.prototype.disconnect = async function () {
    this.timers.forEach(clearInterval); this.timers = [];
    this.listeners.disconnect.forEach(cb => cb(true));
  };

  DemoDevice.prototype.target10 = function () {
    const c = this.cfg;
    const t = c.mode === 'P' && c.steps.length ? c.steps[this.stepIdx].t10 : c.sp10;
    return Math.min(t, c.max10);
  };

  DemoDevice.prototype.tick = function () {
    const now = Date.now(), dt = (now - this.last) / 1000; this.last = now;
    this.temp += ((this.on ? 3 : 0) - 0.2 * (this.temp - 35)) / 30 * dt;
    const c = this.cfg;
    if (c.mode === 'P' && c.steps.length) {
      const ms = c.steps[this.stepIdx].minutes * 60000;
      if (now - this.stepStart >= ms) {
        this.stepStart += ms; this.stepIdx = (this.stepIdx + 1) % c.steps.length; this.integ = 0;
      }
    }
    const maxC = c.max10 / 10;
    if (this.temp > maxC + 2) this.fault = 1;
    if (!this.running || this.fault) { this.duty = 0; this.integ = 0; this.on = false; return; }
    if (now - this.windowStart >= 2000) {
      this.windowStart = now;
      const err = this.target10() / 10 - this.temp;
      if (Math.abs(err) < 1.5) this.integ = Math.min(1, Math.max(0, this.integ + err * 2 * 0.01));
      this.duty = Math.min(1, Math.max(0, 0.5 * err + this.integ));
    }
    this.on = (now - this.windowStart) < this.duty * 2000 && this.temp < maxC;
  };

  const f10 = t => (t / 10).toFixed(1);

  DemoDevice.prototype.status = function () {
    const c = this.cfg;
    let left = 0;
    if (c.mode === 'P' && c.steps.length) {
      left = Math.max(0, Math.round((c.steps[this.stepIdx].minutes * 60000 - (Date.now() - this.stepStart)) / 1000));
    }
    this.emit(`S;T:${this.temp.toFixed(1)};G:${f10(this.target10())};D:${Math.round(this.duty * 100)};R:${this.running ? 1 : 0};M:${c.mode};I:${this.stepIdx};L:${left};F:${this.fault};B:3.95;X:1`);
  };
  DemoDevice.prototype.config = function () {
    const c = this.cfg;
    this.emit(`C;MX:${f10(c.max10)};SP:${f10(c.sp10)};MD:${c.mode};N:${c.steps.length};HX:${f10(HARD_MAX)}`);
  };
  DemoDevice.prototype.profile = function () {
    this.cfg.steps.forEach((s, i) => this.emit(`P;I:${i};T:${f10(s.t10)};M:${s.minutes}`));
  };

  DemoDevice.prototype.write = async function (text) {
    const f = text.split(':'), c = this.cfg, cmd = f[0];
    const ok = () => this.emit('OK:' + cmd), er = r => this.emit(`ER:${cmd}:${r}`);
    const valid = t => t >= MIN && t <= Math.min(c.max10, HARD_MAX);
    const pwdOk = p => { if (p === c.pwd) { this.bad = 0; return true; } this.bad++; return false; };
    if (this.bad >= 5 && ['AU', 'MX', 'PW'].includes(cmd)) return er('LOCKED');
    switch (cmd) {
      case 'GET': this.config(); this.profile(); this.status(); return ok();
      case 'SP': { const t = +f[1]; if (!valid(t)) return er('RANGE'); c.sp10 = t; c.mode = 'F'; this.integ = 0; this.save(); ok(); this.config(); return this.status(); }
      case 'MD':
        if (f[1] === 'P') { if (!c.steps.length) return er('NOPROFILE'); c.mode = 'P'; this.stepIdx = 0; this.stepStart = Date.now(); } else c.mode = 'F';
        this.save(); ok(); this.config(); return this.status();
      case 'PB': { const n = +f[1]; if (!(n >= 1 && n <= 10)) return er('RANGE'); this.upload = { n, steps: [] }; return ok(); }
      case 'PS': {
        if (!this.upload) return er('NOBEGIN');
        const i = +f[1], t = +f[2], m = +f[3];
        if (!(i >= 0 && i < this.upload.n)) return er('INDEX');
        if (!valid(t)) return er('RANGE');
        if (!(m >= 1 && m <= 1440)) return er('TIME');
        this.upload.steps[i] = { t10: t, minutes: m }; return ok();
      }
      case 'PE': {
        const u = this.upload; this.upload = null;
        if (!u) return er('NOBEGIN');
        for (let i = 0; i < u.n; i++) if (!u.steps[i]) return er('MISSING');
        c.steps = u.steps; c.mode = 'P'; this.stepIdx = 0; this.stepStart = Date.now(); this.integ = 0;
        this.save(); ok(); this.config(); this.profile(); return this.status();
      }
      case 'RUN':
        if (f[1] === '1' && this.fault) { if (this.temp > c.max10 / 10 - 1) { er('FAULT'); return this.status(); } this.fault = 0; }
        this.running = f[1] === '1'; ok(); return this.status();
      case 'AU': return pwdOk(f[1]) ? ok() : er('PWD');
      case 'MX': {
        if (!pwdOk(f[2])) return er('PWD');
        const t = +f[1]; if (!(t >= MIN && t <= HARD_MAX)) return er('RANGE');
        c.max10 = t; c.sp10 = Math.min(c.sp10, t); c.steps.forEach(s => { s.t10 = Math.min(s.t10, t); });
        this.save(); ok(); this.config(); this.profile(); return this.status();
      }
      case 'PW':
        if (!pwdOk(f[1])) return er('PWD');
        if (!/^[0-9]{4,8}$/.test(f[2] || '')) return er('FORMAT');
        c.pwd = f[2]; this.save(); return ok();
      default: this.emit('ER:CMD:UNKNOWN');
    }
  };

  root.DemoDevice = DemoDevice;
})(typeof self !== 'undefined' ? self : this);
