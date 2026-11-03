/* core.js — protocol and formatting helpers shared by the app, the demo
   device and the tests. No browser APIs in here.

   Board -> app lines
     S;T:41.3;G:42.0;D:41;R:1;M:P;I:0;L:60;F:0;B:3.87;X:1   status (every 5 s)
     C;MX:50.0;SP:42.0;MD:F;N:2;HX:50.0                       saved configuration
     P;I:0;T:40.0;M:30                                        one saved profile step
     OK:SP          command accepted
     ER:SP:RANGE    command refused, with a reason

   App -> board commands (one at a time; each gets OK or ER)
     GET  SP:<t10>  MD:F|P  PB:<n>  PS:<i>:<t10>:<min>  PE  RUN:0|1
     AU:<pwd>  MX:<t10>:<pwd>  PW:<old>:<new>
   Temperatures in commands are tenths of a degree: 425 = 42.5 °C.
*/
(function (root) {
  'use strict';

  const LIMITS = {
    minC: 30.0,          // lowest set point the firmware accepts
    stepC: 0.5,          // set point resolution in the app
    maxSteps: 10,
    maxStepMin: 1440,
  };

  function splitLines(buffer) {
    const normalized = buffer.replace(/\\n/g, '\n').replace(/\r/g, '');
    const parts = normalized.split('\n');
    const rest = parts.pop();
    return { lines: parts.map(s => s.trim()).filter(Boolean), rest };
  }

  function num(v) { const n = parseFloat(v); return isNaN(n) ? undefined : n; }

  function parseLine(line) {
    if (line.startsWith('OK:')) return { type: 'OK', cmd: line.slice(3) };
    if (line.startsWith('ER:')) {
      const [, cmd, reason] = line.split(':');
      return { type: 'ER', cmd, reason: reason || '' };
    }
    const parts = line.split(';');
    const type = parts.shift();
    const kv = {};
    for (const p of parts) {
      const i = p.indexOf(':');
      if (i > 0) kv[p.slice(0, i)] = p.slice(i + 1);
    }
    if (type === 'S') {
      return {
        type: 'S',
        temp: num(kv.T), target: num(kv.G), duty: num(kv.D),
        running: kv.R === '1', mode: kv.M, step: num(kv.I),
        left: num(kv.L), fault: num(kv.F) || 0, battery: num(kv.B),
        simulated: kv.X === '1',
      };
    }
    if (type === 'C') {
      return {
        type: 'C', max: num(kv.MX), sp: num(kv.SP), mode: kv.MD,
        steps: num(kv.N) || 0, hardMax: num(kv.HX),
      };
    }
    if (type === 'P') {
      return { type: 'P', index: num(kv.I), temp: num(kv.T), minutes: num(kv.M) };
    }
    return { type: 'UNKNOWN', raw: line };
  }

  const toTenths = c => Math.round(c * 10);
  const roundHalf = c => Math.round(c * 2) / 2;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // Problems with a profile draft, as Hebrew messages. Empty array = OK.
  function validateProfile(steps, maxC) {
    const errs = [];
    if (!steps.length) errs.push('צריך לפחות שלב אחד.');
    if (steps.length > LIMITS.maxSteps) errs.push(`אפשר עד ${LIMITS.maxSteps} שלבים.`);
    steps.forEach((s, i) => {
      if (!(s.temp >= LIMITS.minC && s.temp <= maxC)) errs.push(`שלב ${i + 1}: הטמפרטורה חייבת להיות בין \u2066${LIMITS.minC.toFixed(1)}°\u2069 ל-\u2066${maxC.toFixed(1)}°\u2069.`);
      if (!(Number.isInteger(s.minutes) && s.minutes >= 1 && s.minutes <= LIMITS.maxStepMin)) errs.push(`שלב ${i + 1}: משך השלב חייב להיות בין דקה ל-24 שעות.`);
    });
    return errs;
  }

  // Commands that upload a profile, in order.
  function profileCommands(steps) {
    const cmds = [`PB:${steps.length}`];
    steps.forEach((s, i) => cmds.push(`PS:${i}:${toTenths(s.temp)}:${s.minutes}`));
    cmds.push('PE');
    return cmds;
  }

  function validPassword(p) { return /^[0-9]{4,8}$/.test(p); }

  function formatDuration(minutes) {
    const h = Math.floor(minutes / 60), m = minutes % 60;
    if (h && m) return `${h} שע' ${m} דק'`;
    if (h) return h === 1 ? 'שעה' : `${h} שעות`;
    return `${m} דק'`;
  }

  function formatClock(seconds) {
    const s = Math.max(0, Math.round(seconds));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    const p = n => String(n).padStart(2, '0');
    return h ? `${h}:${p(m)}:${p(r)}` : `${p(m)}:${p(r)}`;
  }

  const FAULTS = {
    1: 'החימום נעצר: הטמפרטורה עלתה מעל המקסימום המותר.',
    2: 'החימום נעצר: חיישן הטמפרטורה לא מגיב. בדקו את החיבור שלו.',
  };

  const REASONS = {
    RANGE: 'הערך מחוץ לטווח המותר',
    PWD: 'סיסמה שגויה',
    LOCKED: 'יותר מדי ניסיונות. נסו שוב בעוד דקה',
    FORMAT: 'הסיסמה חייבת להיות 4–8 ספרות',
    NOPROFILE: 'אין פרופיל שמור בבקר',
    MISSING: 'חלק מהשלבים לא הגיעו לבקר',
    NOBEGIN: 'העלאת הפרופיל לא התחילה כראוי',
    FAULT: 'התקלה עדיין קיימת. חכו שהמכשיר יתקרר',
    TIMEOUT: 'הבקר לא ענה',
  };

  const api = {
    LIMITS, splitLines, parseLine, toTenths, roundHalf, clamp,
    validateProfile, profileCommands, validPassword,
    formatDuration, formatClock, FAULTS, REASONS,
  };
  if (typeof module !== 'undefined') module.exports = api;
  else root.Core = api;
})(typeof self !== 'undefined' ? self : this);
