/* Murph support-cost calculator (standalone page, ES + EN).
   Pure client-side maths. Nothing is sent anywhere until the visitor submits the form at the bottom.
   The form posts to the same Supabase "leads" table, with the same fields, as the Contact page in app.js. */
(function () {
  'use strict';

  var SUPABASE_URL = 'https://wiavnyuchdsfztzhvaua.supabase.co';
  var SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndpYXZueXVjaGRzZnp0emh2YXVhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzEwMDI2ODQsImV4cCI6MjA4NjU3ODY4NH0.dXz7vyFglA_lihma__rbtBT8afZZ1YUJEkAmqpFOL6c';

  var LIMITS = {
    q: [0, 1000], min: [0, 60], rate: [0, 200], days: [1, 31],
    n: [0, 1000], slip: [0, 100], lose: [0, 100], spend: [0, 10000]
  };
  var IDS = ['q', 'min', 'rate', 'days', 'n', 'slip', 'lose', 'spend'];

  var TX = {
    es: {
      locale: 'es-ES',
      hours: '{h} h al mes', cost: '≈ {m} al mes · {y} al año',
      cases: '{c} {cw} al mes', casesW1: 'caso', casesWN: 'casos',
      lost: '≈ {l} {lw} al año · {r} de ventas anuales en riesgo', lostW1: 'cliente', lostWN: 'clientes',
      summary: 'Tu fuga más grande ahora mismo: {name}, unos {amt} al año.',
      name1: 'responder siempre lo mismo', name2: 'los problemas reales que se pierden',
      sending: 'Enviando…',
      comment: 'Origen: calculadora de atención al cliente (web). 1) {q} preguntas/día, {min} min, {rate} €/h, {days} días/mes: ≈ {cost} al mes. 2) {n} casos/mes, {slip}% se escapan, {lose}% dejan de comprar, {spend} €/año por cliente: ≈ {risk} de ventas anuales en riesgo.'
    },
    en: {
      locale: 'en-GB',
      hours: '{h} h a month', cost: '≈ {m} a month · {y} a year',
      cases: '{c} {cw} a month', casesW1: 'case', casesWN: 'cases',
      lost: '≈ {l} {lw} a year · {r} of yearly sales at risk', lostW1: 'customer', lostWN: 'customers',
      summary: 'Your biggest leak right now: {name}, about {amt} a year.',
      name1: 'answering the same questions', name2: 'real problems getting lost',
      sending: 'Sending…',
      comment: 'Source: customer-service calculator (web). 1) {q} questions/day, {min} min, {rate} EUR/h, {days} days/month: ≈ {cost} a month. 2) {n} cases/month, {slip}% slip through, {lose}% stop buying, {spend} EUR/year per customer: ≈ {risk} of yearly sales at risk.'
    }
  };

  function lang() { return (document.documentElement.lang || 'es').slice(0, 2) === 'en' ? 'en' : 'es'; }

  function clamp(name, raw) {
    var n = parseFloat(String(raw).replace(',', '.'));
    if (!isFinite(n)) n = 0;
    return Math.min(LIMITS[name][1], Math.max(LIMITS[name][0], n));
  }

  // Pure maths, no DOM. Exposed for testing.
  function compute(v) {
    var hours = v.q * v.min / 60 * v.days;
    var costMonth = hours * v.rate;
    var casesMonth = v.n * v.slip / 100;
    var lostYear = casesMonth * 12 * v.lose / 100;
    return {
      hours: hours, costMonth: costMonth, costYear: costMonth * 12,
      casesMonth: casesMonth, lostYear: lostYear, riskYear: lostYear * v.spend
    };
  }

  function fill(tpl, map) { return tpl.replace(/\{(\w+)\}/g, function (m, k) { return map[k] != null ? map[k] : m; }); }
  function eur(n, loc) { return new Intl.NumberFormat(loc, { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(Math.round(n)); }
  function num(n, loc) { return new Intl.NumberFormat(loc, { maximumFractionDigits: 1 }).format(Math.round(n * 10) / 10); }
  function setText(sel, text) { var el = document.querySelector(sel); if (el) el.textContent = text; }

  var last = { comment: '' };

  function read() {
    var v = {};
    IDS.forEach(function (id) {
      var el = document.getElementById('mc-' + id);
      v[id] = clamp(id, el ? el.value : 0);
    });
    return v;
  }

  function render() {
    var t = TX[lang()], v = read(), r = compute(v), loc = t.locale;

    setText('[data-r="hours"]', fill(t.hours, { h: num(r.hours, loc) }));
    setText('[data-r="cost"]', fill(t.cost, { m: eur(r.costMonth, loc), y: eur(r.costYear, loc) }));

    var cRounded = Math.round(r.casesMonth * 10) / 10;
    setText('[data-r="cases"]', fill(t.cases, { c: num(r.casesMonth, loc), cw: cRounded === 1 ? t.casesW1 : t.casesWN }));
    var lRounded = Math.round(r.lostYear * 10) / 10;
    setText('[data-r="lost"]', fill(t.lost, { l: num(r.lostYear, loc), lw: lRounded === 1 ? t.lostW1 : t.lostWN, r: eur(r.riskYear, loc) }));

    // Summary names the bigger yearly figure. It does not add the two together:
    // one is the value of your time, the other is sales at risk.
    var summary = '';
    if (r.costYear > 0 || r.riskYear > 0) {
      var first = r.costYear >= r.riskYear;
      summary = fill(t.summary, { name: first ? t.name1 : t.name2, amt: eur(first ? r.costYear : r.riskYear, loc) });
    }
    setText('[data-r="summary"]', summary);

    last.comment = fill(t.comment, {
      q: v.q, min: v.min, rate: v.rate, days: v.days, n: v.n, slip: v.slip, lose: v.lose, spend: v.spend,
      cost: eur(r.costMonth, loc), risk: eur(r.riskYear, loc)
    });
  }

  // Same field names the Contact page in app.js sends to the "leads" table.
  function buildPayload(f, comment) {
    return {
      full_name: f.full_name, company: f.company, email: f.email, phone: f.phone || '',
      website: '', interest: 'Discovery', comments: comment
    };
  }

  function onSubmit(e) {
    e.preventDefault();
    var form = e.target, t = TX[lang()];
    var err = form.querySelector('.mc-error'), btn = form.querySelector('.mc-btn');
    err.classList.remove('show');
    if (!form.reportValidity()) return;
    var val = function (n) { return (form.elements[n].value || '').trim(); };

    // Anti-spam trap: bots fill the hidden field. Pretend success, send nothing.
    if (val('hp_url')) { showDone(); return; }

    var idle = btn.textContent;
    btn.disabled = true; btn.textContent = t.sending;
    fetch(SUPABASE_URL + '/rest/v1/leads', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON,
        'Authorization': 'Bearer ' + SUPABASE_ANON,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(buildPayload({
        full_name: val('full_name'), company: val('company'), email: val('email'), phone: val('phone')
      }, last.comment))
    }).then(function (res) {
      if (res.ok) showDone(); else throw new Error('http ' + res.status);
    }).catch(function () {
      err.classList.add('show');
      btn.disabled = false; btn.textContent = idle;
    });
  }

  function showDone() {
    var f = document.getElementById('mc-form'), d = document.getElementById('mc-done');
    if (f) f.style.display = 'none';
    if (d) { d.style.display = 'block'; d.setAttribute('tabindex', '-1'); d.focus(); }
  }

  function init() {
    if (!document.getElementById('mc-q')) return;
    IDS.forEach(function (id) {
      var el = document.getElementById('mc-' + id);
      if (el) el.addEventListener('input', render);
    });
    var f = document.getElementById('mc-form');
    if (f) f.addEventListener('submit', onSubmit);
    render();
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { compute: compute, clamp: clamp, buildPayload: buildPayload };
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  }
})();
