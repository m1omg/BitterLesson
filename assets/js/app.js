/*
 * app.js: the page itself. Charts, boards, the drawing pad, and the
 * orchestration of every experiment. Heavy work happens in Web Workers (see
 * tasks.js). Everything animated here is driven by elapsed time, never by
 * frame count, so it behaves the same on a 60 Hz and a 144 Hz display.
 */
(function () {
  'use strict';
  const BL = window.BL;
  const $ = (id) => document.getElementById(id);
  const now = () => performance.now();
  const reduceMotion = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const CORES = Math.max(1, Math.min(8, navigator.hardwareConcurrency || 4));
  const WORKERS = Math.max(1, Math.min(6, CORES - 1));
  const WORKER_URL = 'assets/js/worker.js';

  // ================================================================ format
  const SUP = '⁰¹²³⁴⁵⁶⁷⁸⁹';
  const sup = (n) => String(n).replace(/-/g, '⁻').replace(/\d/g, (d) => SUP[+d]);
  const fmtInt = (n) => Math.round(n).toLocaleString('en-US');
  function fmtSci(x, digits) {
    if (!(x > 0)) return '0';
    if (x < 1e5) return fmtInt(x);
    const e = Math.floor(Math.log10(x) + 1e-9);
    const m = x / Math.pow(10, e);
    const d = digits == null ? 1 : digits;
    const ms = m.toFixed(d);
    if (ms === '10.0' || ms === '10') return '10' + sup(e + 1);
    return (d === 0 && ms === '1' ? '' : ms + '×') + '10' + sup(e);
  }
  function fmtBig(x) { // 41,203,991 -> 41.2 million
    if (x < 1e6) return fmtInt(x);
    if (x < 1e9) return (x / 1e6).toFixed(x < 1e7 ? 2 : 1) + ' million';
    if (x < 1e12) return (x / 1e9).toFixed(x < 1e10 ? 2 : 1) + ' billion';
    return fmtSci(x);
  }
  function fmtCompact(x) { // for the top bar
    if (x < 1e4) return fmtInt(x);
    if (x < 1e6) return (x / 1e3).toFixed(x < 1e5 ? 1 : 0) + 'K';
    if (x < 1e9) return (x / 1e6).toFixed(x < 1e7 ? 2 : 1) + 'M';
    if (x < 1e12) return (x / 1e9).toFixed(x < 1e10 ? 2 : 1) + 'B';
    return fmtSci(x);
  }
  const fmtSims = (n) => (n >= 1024 && n % 1024 === 0 ? n / 1024 + 'K' : fmtInt(n));
  function fmtTime(ms) {
    if (ms < 1) return ms.toFixed(2) + ' ms';
    if (ms < 1000) return Math.round(ms) + ' ms';
    const s = ms / 1000;
    if (s < 60) return s.toFixed(s < 10 ? 1 : 0) + ' s';
    const m = Math.floor(s / 60);
    return m + ' min ' + Math.round(s - m * 60) + ' s';
  }
  const pct = (x) => Math.round(x * 100) + '%';
  const sig2 = (x) => { if (!(x > 0)) return 0; const p = Math.pow(10, Math.floor(Math.log10(x)) - 1); return Math.round(x / p) * p; };
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeOut = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);

  // ================================================================ palette
  let pal = null;
  function palette() {
    if (pal) return pal;
    const s = getComputedStyle(document.documentElement);
    const g = (n) => s.getPropertyValue(n).trim() || '#888888';
    pal = {
      bg: g('--bg'), bench: g('--bench'), panel: g('--panel'), ink: g('--ink'), ink2: g('--ink-2'), ink3: g('--ink-3'),
      rule: g('--rule'), grid: g('--grid'), knowledge: g('--knowledge'), knowledgeInk: g('--knowledge-ink'),
      hybrid: g('--hybrid'), compute: g('--compute'), computeInk: g('--compute-ink'), win: g('--win'),
      hole: g('--hole'), board: g('--board'),
    };
    return pal;
  }
  function rgba(color, a) {
    const c = color.trim();
    if (c[0] === '#') {
      let v = c.slice(1);
      if (v.length === 3) v = v.split('').map((x) => x + x).join('');
      const n = parseInt(v.slice(0, 6), 16);
      return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
    }
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (m) { const p = m[1].split(',').map((x) => parseFloat(x)); return 'rgba(' + p[0] + ',' + p[1] + ',' + p[2] + ',' + a + ')'; }
    return c;
  }
  // Grey image of a float or byte array, normalised to its own maximum.
  function paintGray(canvas, data, w, h) {
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(w, h);
    let mx = 0;
    for (let i = 0; i < w * h; i++) if (data[i] > mx) mx = data[i];
    const s = mx > 0 ? 255 / mx : 0;
    for (let i = 0; i < w * h; i++) {
      const v = Math.round(Math.max(0, data[i]) * s);
      img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }

  const FONT = {
    mono: (px, w) => (w || 400) + ' ' + px + 'px "IBM Plex Mono", ui-monospace, Menlo, monospace',
    sans: (px, w) => (w || 500) + ' ' + px + 'px "IBM Plex Sans Condensed", "IBM Plex Sans", "Arial Narrow", Arial, sans-serif',
    serif: (px, w, it) => (it ? 'italic ' : '') + (w || 400) + ' ' + px + 'px "IBM Plex Serif", Georgia, serif',
  };

  // ================================================================ drawing loop
  // Drawables expose draw(t). Anything time-animated keeps `animating` true
  // until done; all motion is computed from t, so frame rate never matters.
  const drawables = new Set();
  let rafPending = false;
  function invalidate(d) {
    if (d) d.dirty = true;
    if (!rafPending) { rafPending = true; requestAnimationFrame(frame); }
  }
  function frame(t) {
    rafPending = false;
    let again = false;
    for (const d of drawables) {
      if (!(d.dirty || d.animating)) continue;
      if (d.visible === false) { continue; }
      d.dirty = false;
      try { d.draw(t); } catch (err) { console.error(err); }
      if (d.animating) again = true;
    }
    if (again) { rafPending = true; requestAnimationFrame(frame); }
  }
  function redrawAll() { pal = null; for (const d of drawables) d.dirty = true; invalidate(); }
  if (window.matchMedia) {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    (mq.addEventListener ? mq.addEventListener.bind(mq, 'change') : mq.addListener.bind(mq))(redrawAll);
  }
  new MutationObserver(redrawAll).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(redrawAll);

  const visObserver = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
    for (const e of entries) {
      const d = e.target.__drawable;
      if (!d) continue;
      d.visible = e.isIntersecting;
      if (d.visible) invalidate(d);
    }
  }, { rootMargin: '200px 0px' }) : null;

  const sizeObserver = 'ResizeObserver' in window ? new ResizeObserver((entries) => {
    for (const e of entries) { const d = e.target.__drawable; if (d) invalidate(d); }
  }) : null;
  if (!sizeObserver) window.addEventListener('resize', redrawAll);

  // A canvas sized to its CSS box at device resolution.
  class Surface {
    constructor(canvas, drawable) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.w = 0; this.h = 0; this.dpr = 1;
      canvas.__drawable = drawable;
      drawable.visible = true;
      if (visObserver) visObserver.observe(canvas);
      if (sizeObserver) sizeObserver.observe(canvas);
      drawables.add(drawable);
    }
    fit() {
      const w = Math.max(1, Math.round(this.canvas.clientWidth)), h = Math.max(1, Math.round(this.canvas.clientHeight));
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      if (w !== this.w || h !== this.h || dpr !== this.dpr) {
        this.w = w; this.h = h; this.dpr = dpr;
        this.canvas.width = Math.round(w * dpr);
        this.canvas.height = Math.round(h * dpr);
      }
      const ctx = this.ctx;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      return ctx;
    }
  }

  // ================================================================ chart frame
  // Maps data to pixels inside padded bounds; draws grid and tick labels.
  class Axes {
    constructor(w, h, pad, x, y) {
      this.l = pad.l; this.r = w - pad.r; this.t = pad.t; this.b = h - pad.b;
      this.x = x; this.y = y;
    }
    tx(v) { return this._map(v, this.x, this.l, this.r); }
    ty(v) { return this._map(v, this.y, this.b, this.t); }
    _map(v, ax, p0, p1) {
      const f = ax.log ? (Math.log10(v) - Math.log10(ax.min)) / (Math.log10(ax.max) - Math.log10(ax.min)) : (v - ax.min) / (ax.max - ax.min);
      return p0 + (p1 - p0) * f;
    }
    grid(ctx, xt, yt, opts) {
      const P = palette();
      opts = opts || {};
      ctx.save();
      ctx.lineWidth = 1;
      ctx.strokeStyle = P.grid;
      ctx.fillStyle = P.ink3;
      ctx.font = FONT.mono(opts.fontPx || 10.5);
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'right';
      const px = opts.fontPx || 10.5;
      for (const t of yt || []) {
        const y = Math.round(this.ty(t.v)) + 0.5;
        ctx.strokeStyle = t.strong ? P.rule : P.grid;
        ctx.beginPath(); ctx.moveTo(this.l, y); ctx.lineTo(this.r, y); ctx.stroke();
        if (t.pow != null) pow10(ctx, t.pow, this.l - 7, y, 'right', px);
        else if (t.label != null) ctx.fillText(t.label, this.l - 7, y);
      }
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (const t of xt || []) {
        const x = Math.round(this.tx(t.v)) + 0.5;
        ctx.strokeStyle = t.strong ? P.rule : P.grid;
        ctx.beginPath(); ctx.moveTo(x, this.t); ctx.lineTo(x, this.b); ctx.stroke();
        if (t.pow != null) pow10(ctx, t.pow, x, this.b + 7 + px * 0.5, 'center', px);
        else if (t.label != null) ctx.fillText(t.label, x, this.b + 7);
      }
      ctx.strokeStyle = P.rule;
      ctx.beginPath(); ctx.moveTo(this.l, this.b + 0.5); ctx.lineTo(this.r, this.b + 0.5); ctx.stroke();
      ctx.restore();
    }
    titles(ctx, xTitle, yTitle, opts) {
      const P = palette();
      opts = opts || {};
      ctx.save();
      ctx.fillStyle = P.ink2;
      ctx.font = FONT.sans(opts.px || 12.5, 500);
      if (xTitle) { ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.fillText(xTitle, this.r, this.b + (opts.xOff || 38)); }
      if (yTitle) { ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillText(yTitle, this.l - (opts.yIndent || 0), this.t - 10); }
      ctx.restore();
    }
  }

  // "10" with a raised exponent, readable at small sizes. y is the middle.
  function pow10(ctx, e, x, y, align, px) {
    ctx.save();
    const base = FONT.mono(px), small = FONT.mono(Math.max(7.5, px * 0.78));
    ctx.font = base;
    const wb = ctx.measureText('10').width;
    ctx.font = small;
    const we = ctx.measureText(String(e)).width;
    const total = wb + we + 1;
    const x0 = align === 'right' ? x - total : align === 'center' ? x - total / 2 : x;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = base;
    ctx.fillText('10', x0, y);
    ctx.font = small;
    ctx.fillText(String(e), x0 + wb + 1, y - px * 0.42);
    ctx.restore();
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function label(ctx, text, x, y, opts) {
    const P = palette();
    opts = opts || {};
    ctx.save();
    ctx.font = opts.font || FONT.sans(12.5, 500);
    ctx.textAlign = opts.align || 'left';
    ctx.textBaseline = opts.baseline || 'middle';
    if (opts.halo !== false) {
      ctx.lineJoin = 'round';
      ctx.lineWidth = 4;
      ctx.strokeStyle = opts.haloColor || P.panel;
      ctx.strokeText(text, x, y);
    }
    ctx.fillStyle = opts.color || P.ink;
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  // Wilson score interval for a proportion.
  function wilson(p, n) {
    if (n <= 0) return [0, 1];
    const z = 1.96, z2 = z * z;
    const c = (p + z2 / (2 * n)) / (1 + z2 / n);
    const h = (z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / (1 + z2 / n);
    return [clamp(c - h, 0, 1), clamp(c + h, 0, 1)];
  }

  // ================================================================ meter
  const meter = {
    positions: 0, flops: 0, busy: 0, lastPaint: 0, timer: 0,
    add(positions, flops) {
      if (positions) this.positions += positions;
      if (flops) this.flops += flops;
      this.paint();
    },
    setBusy(delta) { this.busy = Math.max(0, this.busy + delta); this.paint(true); },
    paint(force) {
      const t = now();
      if (!force && t - this.lastPaint < 200) {
        if (!this.timer) this.timer = setTimeout(() => { this.timer = 0; this.paint(true); }, 220);
        return;
      }
      this.lastPaint = t;
      $('m-pos').textContent = fmtCompact(this.positions);
      $('m-flop').textContent = fmtCompact(this.flops);
      $('meter').classList.toggle('busy', this.busy > 0);
      scale.onMeter();
    },
  };

  // ================================================================ workers
  // Same message interface as a Worker, but runs tasks on this thread in
  // slices. Used only if real workers can't start.
  class LocalWorker {
    constructor() { this.onmessage = null; this.local = true; }
    postMessage(msg) {
      setTimeout(() => {
        BL.tasks.handle(msg, (m) => { setTimeout(() => { if (this.onmessage) this.onmessage({ data: m }); }, 0); });
      }, 0);
    }
    terminate() {}
  }
  let workersBroken = false;

  // Workers normally load assets/js/worker.js. When the page is a single file
  // with its scripts inlined, build the worker from those scripts instead.
  let workerBlobUrl = null;
  function makeWorker() {
    const parts = ['src-connect', 'src-digits', 'src-rulebook', 'src-tasks'].map((id) => document.getElementById(id));
    if (parts.every(Boolean)) {
      if (!workerBlobUrl) {
        const code = parts.map((e) => e.textContent).join('\n;\n') +
          '\nself.onmessage = function (e) { self.BL.tasks.handle(e.data, function (m, t) { self.postMessage(m, t || []); }); };\n';
        workerBlobUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      }
      return new Worker(workerBlobUrl);
    }
    return new Worker(WORKER_URL);
  }

  class Pool {
    constructor(size) {
      this.size = size;
      this.workers = [];
      this.idle = [];
      this.queue = [];
      this.jobs = new Map();
      this.nextId = 1;
      for (let i = 0; i < size; i++) this._spawn(i);
    }
    _spawn(slot) {
      let w = null;
      if (!workersBroken && typeof Worker !== 'undefined') {
        try { w = makeWorker(); } catch (e) { w = null; workersBroken = true; }
      }
      if (!w) w = new LocalWorker();
      w.slot = slot;
      w.ok = !!w.local;
      w.onmessage = (e) => { w.ok = true; this._onMessage(w, e.data); };
      if (!w.local) {
        w.onerror = (e) => {
          if (w.ok) { console.error('worker error', e.message || e); return; }
          // The worker script failed to load: fall back to this thread.
          workersBroken = true;
          if (e.preventDefault) e.preventDefault();
          this._replace(w);
        };
      }
      this.workers[slot] = w;
      this.idle.push(w);
    }
    _replace(w) {
      try { w.terminate(); } catch (e) { /* ignore */ }
      const lw = new LocalWorker();
      lw.slot = w.slot; lw.ok = true;
      lw.onmessage = (e) => this._onMessage(lw, e.data);
      this.workers[w.slot] = lw;
      const i = this.idle.indexOf(w);
      if (i >= 0) this.idle[i] = lw;
      for (const job of this.jobs.values()) if (job.worker === w) { job.worker = lw; lw.postMessage(job.msg); }
      for (const d of this.direct || []) if (d.worker === w) { d.worker = lw; lw.postMessage(d.msg); }
    }
    run(msg, onMsg, transfer) {
      return new Promise((resolve, reject) => {
        const id = this.nextId++;
        msg.id = id;
        this.queue.push({ id, msg, onMsg, transfer, resolve, reject });
        this._dispatch();
      });
    }
    // Send one message to every worker (e.g. data), resolving when all reply.
    each(makeMsg) {
      this.direct = [];
      const ps = this.workers.map((w) => new Promise((resolve, reject) => {
        const id = this.nextId++;
        const msg = makeMsg(w.slot);
        msg.id = id;
        const job = { id, msg, resolve, reject, worker: w, direct: true };
        this.jobs.set(id, job);
        this.direct.push(job);
        const k = this.idle.indexOf(w);
        if (k >= 0) this.idle.splice(k, 1);
        w.postMessage(msg);
      }));
      return Promise.all(ps);
    }
    _dispatch() {
      while (this.idle.length && this.queue.length) {
        const w = this.idle.shift();
        const job = this.queue.shift();
        job.worker = w;
        this.jobs.set(job.id, job);
        meter.setBusy(1);
        job.busy = true;
        try {
          w.postMessage(job.msg, w.local ? undefined : (job.transfer || []));
        } catch (e) {
          job.reject(e);
        }
        if (job.onMsg) job.onMsg({ id: job.id, type: 'start' }, w.slot);
      }
    }
    _onMessage(w, m) {
      const job = this.jobs.get(m.id);
      if (!job) return;
      if (job.onMsg) job.onMsg(m, w.slot);
      if (m.type === 'done' || m.type === 'error' || m.type === 'cancelled') {
        this.jobs.delete(m.id);
        if (job.busy) meter.setBusy(-1);
        if (this.workers[w.slot] === w) this.idle.push(w);
        if (m.type === 'error') { console.error(m.error); job.reject(new Error(m.error)); } else job.resolve(m);
        this._dispatch();
      }
    }
    cancelAll() {
      for (const job of this.queue) job.resolve({ type: 'cancelled' });
      this.queue = [];
      for (const job of this.jobs.values()) {
        if (job.worker) job.worker.postMessage({ type: 'cancel', id: job.id });
      }
    }
    terminate() {
      this.cancelAll();
      for (const w of this.workers) { try { w.terminate(); } catch (e) { /* ignore */ } }
      for (const job of this.jobs.values()) { if (job.busy) meter.setBusy(-1); job.resolve({ type: 'cancelled' }); }
      this.jobs.clear();
      this.workers = []; this.idle = [];
    }
  }

  // ================================================================ data
  async function fetchBinary(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error('Could not load ' + url + ' (' + res.status + ')');
    let buf;
    if (/\.b64\.txt$/.test(url)) { // some hosts only serve text: base64 inside
      const bin = atob((await res.text()).trim());
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      buf = bytes.buffer;
    } else buf = await res.arrayBuffer();
    const b = new Uint8Array(buf, 0, 2);
    if (b[0] === 0x1f && b[1] === 0x8b) {
      if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot unpack the digit data.');
      const ds = new DecompressionStream('gzip');
      const stream = new Blob([buf]).stream().pipeThrough(ds);
      buf = await new Response(stream).arrayBuffer();
    }
    return buf;
  }
  let digitData = null;
  function loadDigits() {
    if (!digitData) {
      digitData = Promise.all([fetchBinary('assets/data/digits-train.bin.gz'), fetchBinary('assets/data/digits-test.bin.gz')])
        .then(([tr, te]) => ({ trainBuf: tr, testBuf: te, train: BL.digits.parseDigits(tr), test: BL.digits.parseDigits(te) }));
      digitData.catch(() => { digitData = null; });
    }
    return digitData;
  }
  let epochData = null;
  function loadEpoch() {
    if (!epochData) {
      epochData = fetch('assets/data/epoch.json').then((r) => { if (!r.ok) throw new Error('epoch ' + r.status); return r.json(); });
      epochData.catch(() => { epochData = null; });
    }
    return epochData;
  }

  // Run fn once, the first time el is mostly on screen.
  function whenSeen(el, fn, threshold) {
    if (!('IntersectionObserver' in window)) { setTimeout(fn, 1500); return; }
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { io.disconnect(); fn(); break; }
    }, { threshold: threshold == null ? 0.35 : threshold });
    io.observe(el);
  }

  // ================================================================ Connect board drawing
  // Shared by the mini boards, the play board and the inventor.
  function drawBoard(ctx, x0, y0, cell, g, colors, opts) {
    const P = palette();
    opts = opts || {};
    const W = g.w, H = g.h, r = cell * 0.39;
    ctx.save();
    ctx.fillStyle = opts.boardColor || P.board;
    roundRect(ctx, x0, y0, cell * W, cell * H, Math.min(8, cell * 0.18));
    ctx.fill();
    if (opts.outline !== false) { ctx.strokeStyle = P.rule; ctx.lineWidth = 1; ctx.stroke(); }
    for (let c = 0; c < W; c++) {
      for (let row = 0; row < H; row++) {
        const cx = x0 + (c + 0.5) * cell, cy = y0 + (H - row - 0.5) * cell;
        const v = g.cells[c * H + row];
        const anim = opts.anim && opts.anim.get(c * H + row);
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = P.hole;
        ctx.fill();
        if (v && !anim) {
          ctx.beginPath();
          ctx.arc(cx, cy, r, 0, Math.PI * 2);
          ctx.fillStyle = colors[v];
          ctx.fill();
        }
      }
    }
    ctx.restore();
  }

  // ================================================================ hero + scale charts
  const DOMAIN_NAMES = { G: 'Games', L: 'Language', S: 'Speech', V: 'Vision', M: 'Multimodal', O: 'Other' };

  function fitTrend(models, y0, y1) {
    let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const m of models) {
      if (m[2] < y0 || m[2] >= y1) continue;
      n++; sx += m[2]; sy += m[4]; sxx += m[2] * m[2]; sxy += m[2] * m[4];
    }
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    const icpt = (sy - slope * sx) / n;
    return { slope, icpt, n, y0, y1, doublingMonths: 12 * Math.log10(2) / slope };
  }

  class EpochChart {
    constructor(container, opts) {
      this.opts = opts || {};
      this.canvas = container.querySelector('canvas');
      this.surface = new Surface(this.canvas, this);
      this.container = container;
      this.data = null;
      this.revealStart = 0;
      this.marks = []; // this page's own compute
      this.hover = null;
      if (this.opts.interactive) this._bindHover();
    }
    setData(d) {
      this.data = d;
      this.models = d.models;
      this.milestones = d.milestones;
      this.trends = [fitTrend(d.models, 1950, 2010), fitTrend(d.models, 2010, 2100)];
      if (this.opts.reveal && !reduceMotion) { this.revealStart = now(); this.animating = true; }
      invalidate(this);
    }
    _axes(w, h) {
      const small = w < 560;
      return new Axes(w, h, { l: small ? 40 : 52, r: small ? 12 : 20, t: 26, b: 30 }, { min: 1948, max: 2028 }, { min: 0, max: 28 });
    }
    draw(t) {
      const ctx = this.surface.fit(), w = this.surface.w, h = this.surface.h, P = palette();
      const A = this._axes(w, h);
      const small = w < 560;
      const yt = [];
      for (let e = 0; e <= 28; e++) yt.push({ v: e, pow: e % 5 === 0 ? e : null, strong: e % 5 === 0 });
      const xt = [];
      for (let yr = 1950; yr <= 2025; yr += small ? 25 : 10) xt.push({ v: yr, label: String(yr) });
      A.grid(ctx, xt, yt);
      A.titles(ctx, null, 'training computation, FLOP (log scale)', { yIndent: small ? 40 : 52 });
      if (!this.models) {
        label(ctx, 'loading Epoch AI data…', (A.l + A.r) / 2, (A.t + A.b) / 2, { align: 'center', color: P.ink3 });
        this.animating = false;
        return;
      }
      // reveal: models appear in date order over ~2.6 s
      let upto = 3000;
      if (this.revealStart) {
        const f = (t - this.revealStart) / 2600;
        upto = lerp(1948, 2028, easeOut(f));
        this.animating = f < 1;
      } else this.animating = false;
      // trends
      if (this.opts.trends) {
        ctx.save();
        ctx.setLineDash([5, 5]);
        ctx.lineWidth = 1.25;
        ctx.strokeStyle = rgba(P.ink3, 0.9);
        for (const tr of this.trends) {
          const xa = Math.max(tr.y0, 1950), xb = Math.min(tr.y1, 2026.8);
          ctx.beginPath();
          ctx.moveTo(A.tx(xa), A.ty(tr.icpt + tr.slope * xa));
          ctx.lineTo(A.tx(xb), A.ty(tr.icpt + tr.slope * xb));
          ctx.stroke();
        }
        ctx.restore();
      }
      // points
      const r = small ? 2.1 : 2.6;
      ctx.save();
      for (const m of this.models) {
        if (m[2] > upto) break;
        const x = A.tx(m[2]), y = A.ty(m[4]);
        ctx.beginPath();
        ctx.arc(x, y, this.milestones[m[0]] ? r + 1.4 : r, 0, Math.PI * 2);
        ctx.fillStyle = this.milestones[m[0]] ? P.ink : rgba(P.ink2, m[5] === 'S' ? 0.35 : 0.55);
        ctx.fill();
      }
      ctx.restore();
      // milestone labels
      if (this.opts.labels !== false) {
        const list = Object.keys(this.milestones);
        for (const name of list) {
          const m = this.models.find((q) => q[0] === name);
          if (!m || m[2] > upto) continue;
          if (small && this.opts.sparse && !['Theseus', 'AlexNet', 'GPT-4 (Mar 2023)', 'Perceptron Mark I', 'TD-Gammon'].includes(name)) continue;
          const x = A.tx(m[2]), y = A.ty(m[4]);
          const left = m[2] > 2000;
          const text = this.milestones[name] + (small ? '' : ', ' + Math.floor(m[2]));
          label(ctx, text, x + (left ? -8 : 8), y - (name === 'GPT-4 (Mar 2023)' ? 10 : 0), { align: left ? 'right' : 'left', font: FONT.sans(small ? 11 : 12.5, 500), color: P.ink });
        }
      }
      // the top of the chart
      if (upto > 2026.5 && !small) {
        let top = this.models[0];
        for (const m of this.models) if (m[4] > top[4]) top = m;
        label(ctx, Math.floor(top[2]) + ': 10' + sup(Math.round(top[4])) + ' FLOP', A.tx(top[2]) - 8, A.ty(top[4]) - 2, { align: 'right', font: FONT.mono(small ? 10.5 : 11.5, 500), color: P.ink });
      }
      // this page's own computation
      for (const mk of this.marks) {
        if (!(mk.flop > 0)) continue;
        const ly = Math.log10(mk.flop);
        const x = A.tx(mk.year), y = A.ty(ly);
        // horizontal guide to the past
        if (mk.match) {
          ctx.save();
          ctx.setLineDash([3, 4]);
          ctx.strokeStyle = rgba(P.compute, 0.7);
          ctx.lineWidth = 1.25;
          ctx.beginPath(); ctx.moveTo(A.tx(mk.match[2]), y); ctx.lineTo(x, y); ctx.stroke();
          ctx.restore();
        }
        ctx.beginPath();
        ctx.arc(x, y, 6, 0, Math.PI * 2);
        ctx.fillStyle = P.compute;
        ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = P.panel; ctx.stroke();
        label(ctx, mk.label, x - 10, y + (mk.dy || 0) + 15, { align: 'right', font: FONT.sans(small ? 11.5 : 13, 600), color: P.computeInk });
      }
      // tooltip
      if (this.hover && this.tip) {
        const m = this.hover;
        const x = A.tx(m[2]), y = A.ty(m[4]);
        ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.strokeStyle = P.ink; ctx.lineWidth = 1.5; ctx.stroke();
      }
      this._A = A;
    }
    _bindHover() {
      const tip = document.createElement('div');
      tip.className = 'tip';
      tip.hidden = true;
      this.container.appendChild(tip);
      this.tip = tip;
      const pick = (ev) => {
        if (!this._A || !this.models) return;
        const rect = this.canvas.getBoundingClientRect();
        const px = ev.clientX - rect.left, py = ev.clientY - rect.top;
        let best = null, bd = 18 * 18;
        for (const m of this.models) {
          const dx = this._A.tx(m[2]) - px, dy = this._A.ty(m[4]) - py, d = dx * dx + dy * dy;
          if (d < bd) { bd = d; best = m; }
        }
        if (best !== this.hover) { this.hover = best; invalidate(this); }
        if (best) {
          const conf = { C: 'confident', L: 'likely', S: 'speculative' }[best[5]] || '';
          tip.innerHTML = '<b></b><br><span class="mono"></span>';
          tip.firstChild.textContent = best[0];
          tip.lastChild.textContent = best[1] + ' · ' + Math.floor(best[2]) + ' · ' + fmtSci(Math.pow(10, best[4])) + ' FLOP · ' + DOMAIN_NAMES[best[3]].toLowerCase() + ' · ' + conf;
          tip.hidden = false;
          const x = this._A.tx(best[2]), y = this._A.ty(best[4]);
          const tw = tip.offsetWidth;
          tip.style.left = clamp(x - tw / 2, 4, rect.width - tw - 4) + 'px';
          tip.style.top = Math.max(4, y - tip.offsetHeight - 14) + 'px';
        } else tip.hidden = true;
      };
      this.canvas.addEventListener('pointermove', pick);
      this.canvas.addEventListener('pointerdown', pick);
      this.canvas.addEventListener('pointerleave', () => { this.hover = null; tip.hidden = true; invalidate(this); });
    }
  }

  const hero = new EpochChart($('hero-chart'), { reveal: true, labels: true, sparse: true, trends: false });

  const scale = {
    chart: null,
    init() {
      this.chart = new EpochChart($('scale-chart'), { interactive: true, labels: true, trends: true });
    },
    onMeter() {
      if (!this.chart || !this.chart.models) return;
      const flop = meter.flops;
      const marks = [];
      if (flop > 0) {
        const ms = this.chart.models.filter((m) => this.chart.milestones[m[0]]).sort((a, b) => a[4] - b[4]);
        const lf = Math.log10(flop);
        let below = null, above = null;
        for (const m of ms) { if (m[4] <= lf) below = m; else if (!above) above = m; }
        marks.push({ year: 2026.8, flop, label: 'this page', match: below });
        const top = this.chart.models.reduce((a, m) => (m[4] > a[4] ? m : a));
        const ratio = Math.pow(10, top[4]) / flop;
        const name = (m) => this.chart.milestones[m[0]] + ' (' + Math.floor(m[2]) + ', ' + fmtSci(Math.pow(10, m[4])) + ')';
        let txt = 'So far this page has spent ' + fmtSci(flop) + ' FLOP on learning';
        if (below && above) txt += ', between ' + name(below) + ' and ' + name(above) + '.';
        else if (below) txt += ', more than ' + name(below) + '.';
        else txt += '.';
        txt += ' The largest training runs in the data, from ' + Math.floor(top[2]) + ', used about ' + fmtSci(ratio, 0).replace(/^1×/, '') + ' times as much.';
        $('scale-result').textContent = txt;
      }
      this.chart.marks = marks;
      invalidate(this.chart);
    },
  };
  scale.init();

  loadEpoch().then((d) => {
    hero.setData(d);
    scale.chart.setData(d);
    const t = scale.chart.trends;
    $('scale-status').textContent = d.models.length + ' systems, ' + Math.floor(d.models[0][2]) + '–' + Math.floor(d.models[d.models.length - 1][2]);
    $('scale-trend').textContent = 'Dashed lines are least-squares trends through these points: before 2010 the computation used to train notable systems doubled about every ' +
      Math.round(t[0].doublingMonths) + ' months; since 2010, about every ' + Math.round(t[1].doublingMonths) + ' months.';
    scale.onMeter();
  }).catch((e) => { console.error(e); $('scale-status').textContent = 'data unavailable'; });

  // ================================================================ cost of computing
  // Hardware cost per GFLOPS in 2025 dollars (Wikipedia, "FLOPS").
  const COST = [
    [1961, 201.171e9, 'IBM 7030'], [1984, 58.106e6, 'Cray X-MP/48'], [1997, 60168, 'Beowulf cluster'],
    [2000, 1899, 'Bunyip cluster'], [2003, 147, 'KASY0'], [2007, 75.01, 'Microwulf'], [2011, 2.58, 'HPU4Science'],
    [2017, 0.0359, '3 × Radeon RX Vega 64'], [2020, 0.0391, '3 × GeForce RTX 3080'], [2025, 0.0123, 'Radeon RX 9070 XT'],
  ];
  function fmtDollars(v) {
    if (v >= 1e9) return '$' + Math.round(v / 1e9) + ' billion';
    if (v >= 1e6) return '$' + Math.round(v / 1e6) + ' million';
    if (v >= 1) return '$' + fmtInt(v);
    return (v * 100).toFixed(1) + '¢';
  }
  const cost = { dirty: true };
  cost.draw = function () {
    const S = this.surface, ctx = S.fit(), w = S.w, h = S.h, P = palette();
    const small = w < 520;
    const A = new Axes(w, h, { l: small ? 40 : 52, r: small ? 14 : 24, t: 26, b: 30 }, { min: 1958, max: 2028 }, { min: 1e-3, max: 1e12, log: true });
    const yt = [];
    for (let e = -3; e <= 12; e++) yt.push({ v: Math.pow(10, e), label: null, strong: e % 3 === 0 });
    const labels = { 1e12: '$1T', 1e9: '$1B', 1e6: '$1M', 1e3: '$1K', 1: '$1', 1e-3: '0.1¢' };
    for (const t of yt) if (labels[t.v] != null) t.label = labels[t.v];
    const xt = [];
    for (let y = 1960; y <= 2020; y += small ? 20 : 10) xt.push({ v: y, label: String(y) });
    A.grid(ctx, xt, yt);
    A.titles(ctx, null, 'dollars per GFLOPS (log scale)', { yIndent: small ? 40 : 52 });
    ctx.save();
    ctx.strokeStyle = P.compute; ctx.lineWidth = 2.5; ctx.lineJoin = 'round';
    ctx.beginPath();
    COST.forEach((c, i) => { const x = A.tx(c[0]), y = A.ty(c[1]); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    ctx.stroke();
    for (const c of COST) { ctx.beginPath(); ctx.arc(A.tx(c[0]), A.ty(c[1]), 3.5, 0, Math.PI * 2); ctx.fillStyle = P.compute; ctx.fill(); }
    ctx.restore();
    const first = COST[0], last = COST[COST.length - 1];
    label(ctx, first[0] + ': ' + fmtDollars(first[1]), A.tx(first[0]) + 6, A.ty(first[1]) + 17, { font: FONT.sans(small ? 11.5 : 12.5, 600), color: P.ink });
    label(ctx, last[0] + ': ' + fmtDollars(last[1]), A.tx(last[0]) - 9, A.ty(last[1]) - 14, { align: 'right', font: FONT.sans(small ? 11.5 : 12.5, 600), color: P.ink });
    if (!small) {
      const mid = COST[2];
      label(ctx, mid[0] + ': ' + fmtDollars(mid[1]), A.tx(mid[0]) + 9, A.ty(mid[1]) - 6, { font: FONT.sans(12, 500), color: P.ink2 });
    }
  };
  cost.surface = new Surface($('cost-chart').querySelector('canvas'), cost);

  // ================================================================ code listings
  function highlight(src) {
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const re = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`)|\b(const|let|var|function|return|if|else|for|while|break|continue|new|class|constructor|this|of|in|true|false|null)\b|(\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b)/g;
    let out = '', last = 0, m;
    while ((m = re.exec(src))) {
      out += esc(src.slice(last, m.index));
      if (m[1]) out += '<span class="cm">' + esc(m[1]) + '</span>';
      else if (m[2]) out += esc(m[2]);
      else if (m[3]) out += '<span class="kw">' + m[3] + '</span>';
      else if (m[4]) out += '<span class="n">' + m[4] + '</span>';
      last = re.lastIndex;
    }
    return out + esc(src.slice(last));
  }
  function dedent(src) {
    const lines = src.split('\n');
    let min = Infinity;
    for (let i = 1; i < lines.length; i++) {
      const l = lines[i];
      if (!l.trim()) continue;
      min = Math.min(min, l.match(/^ */)[0].length);
    }
    if (!isFinite(min)) return src;
    return [lines[0]].concat(lines.slice(1).map((l) => l.slice(Math.min(min, l.match(/^ */)[0].length)))).join('\n');
  }
  (function fillCode() {
    const I = BL.connectInternals;
    const W = BL.EXPERT_WEIGHTS;
    const weights = 'const EXPERT_WEIGHTS = {\n' + Object.keys(W).map((k) => '  ' + k + ': ' + W[k] + ',').join('\n') + '\n};';
    const expert = [weights, dedent(I.evaluate.toString()), dedent(BL.expertMove.toString()), dedent(I.completes.toString()), dedent(I.immediateWins.toString())].join('\n\n');
    const searcher = dedent(BL.MCTS.toString());
    $('code-k').innerHTML = highlight(expert);
    $('code-c').innerHTML = highlight(searcher);
    $('code-k-n').textContent = expert.split('\n').length + ' lines, all about Connect Four';
    $('code-c-n').textContent = searcher.split('\n').length + ' lines, none about Connect Four';
  })();

  // ================================================================ I. tournament
  const LEVELS = [1, 4, 16, 64, 256, 1024, 4096, 16384, 65536];
  const OPENINGS_PER_LEVEL = 16; // each played twice, colours swapped

  const tour = {
    pool: null, running: false, round: 0, t0: 0, elapsed: 0,
    levels: LEVELS.map((s) => ({ sims: s, score: 0, n: 0, wins: 0, draws: 0, losses: 0, planned: 0, searchMs: 0, searchMoves: 0, positions: 0 })),
    positions: 0, games: 0, planned: 0, topLevel: LEVELS.length - 1, crossover: null,
    boards: [],
    chart: null,
    init() {
      const box = $('tour-boards');
      const nb = 8;
      for (let i = 0; i < nb; i++) {
        const el = document.createElement('div');
        el.className = 'mini';
        el.innerHTML = '<canvas aria-hidden="true"></canvas><div class="cap">idle</div>';
        box.appendChild(el);
        const b = { el, cap: el.querySelector('.cap'), game: new BL.Game(BL.STANDARD_RULES), searcher: 1, line: null, dirty: true, draw: null };
        b.surface = new Surface(el.querySelector('canvas'), b);
        b.draw = () => this._drawMini(b);
        this.boards.push(b);
      }
      this.chart = { dirty: true, draw: (t) => this._drawChart(t), pops: new Map() };
      this.chart.surface = new Surface($('tour-chart').querySelector('canvas'), this.chart);
      $('tour-run').addEventListener('click', () => (this.running ? this.stop() : this.start()));
      $('tour-more').addEventListener('click', () => this.start(true));
      whenSeen($('tour'), () => { if (!this.running && this.games === 0) this.start(); }, 0.3);
      this._readouts();
    },
    _drawMini(b) {
      const ctx = b.surface.fit(), w = b.surface.w, h = b.surface.h, P = palette();
      const cell = Math.min(w / 7, h / 6);
      const colors = { 1: b.searcher === 1 ? P.compute : P.knowledge, 2: b.searcher === 2 ? P.compute : P.knowledge };
      drawBoard(ctx, (w - cell * 7) / 2, (h - cell * 6) / 2, cell, b.game, colors, { outline: false });
      if (b.line) {
        ctx.save();
        ctx.strokeStyle = P.ink; ctx.lineWidth = Math.max(1.5, cell * 0.12); ctx.lineCap = 'round';
        const pt = (cellIdx) => [(w - cell * 7) / 2 + (Math.floor(cellIdx / 6) + 0.5) * cell, (h - cell * 6) / 2 + (6 - (cellIdx % 6) - 0.5) * cell];
        const a = pt(b.line[0]), z = pt(b.line[b.line.length - 1]);
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(z[0], z[1]); ctx.stroke();
        ctx.restore();
      }
    },
    start(more) {
      if (this.running) return;
      this.running = true;
      this.round++;
      if (!more && this.games > 0) this._reset();
      $('tour-run').textContent = 'Stop';
      $('tour-more').hidden = true;
      this.t0 = now();
      this.pool = this.pool || new Pool(WORKERS);
      const seedBase = (Math.random() * 1e9) >>> 0;
      const rng = BL.makeRng(seedBase);
      const tasks = [];
      this.topLevel = LEVELS.length - 1;
      for (let li = 0; li < LEVELS.length; li++) {
        for (let o = 0; o < OPENINGS_PER_LEVEL; o++) {
          const g = new BL.Game(BL.STANDARD_RULES);
          const opening = [];
          for (let k = 0; k < 2; k++) { const m = g.moves[rng() % g.nMoves]; g.play(m); opening.push(m); }
          for (const first of [true, false]) tasks.push({ li, opening, mctsFirst: first, seed: rng() });
        }
        this.levels[li].planned += OPENINGS_PER_LEVEL * 2;
      }
      this.planned += tasks.length;
      this._readouts();
      // Feed the pool lazily so we can stop before the most expensive level
      // on slow devices.
      let next = 0;
      const pump = () => {
        while (this.running && next < tasks.length && this.pool.queue.length < 2) {
          const task = tasks[next++];
          if (task.li > this.topLevel) { this.levels[task.li].planned--; this.planned--; continue; }
          this._play(task).then(pump);
        }
        if (this.running && next >= tasks.length && this.pool.jobs.size === 0 && this.pool.queue.length === 0) this._finish();
      };
      this.pump = pump;
      pump();
    },
    _play(task) {
      const L = this.levels[task.li];
      let board = null;
      let searchStart = 0;
      return this.pool.run({ type: 'c4Game', rules: BL.STANDARD_RULES, sims: L.sims, mctsFirst: task.mctsFirst, seed: task.seed, opening: task.opening, c: 0.5 }, (m, slot) => {
        if (m.type === 'start') {
          board = this._freeBoard();
          board.live = true;
          board.used = now();
          board.game.reset(); board.line = null; board.searcher = task.mctsFirst ? 1 : 2;
          board.cap.textContent = fmtSims(L.sims) + ' · playing';
          searchStart = now();
          invalidate(board);
        } else if (m.type === 'move') {
          if (board && board.game.isLegal(m.move)) { board.game.play(m.move); invalidate(board); }
        } else if (m.type === 'work') {
          this.positions += m.positions; L.positions += m.positions; meter.add(m.positions, 0); this._readouts();
        }
      }).then((m) => {
        if (m.type !== 'done') return;
        this.positions += m.positions; L.positions += m.positions; meter.add(m.positions, 0);
        L.n++; this.games++;
        L.score += m.score;
        if (m.score === 1) L.wins++; else if (m.score === 0) L.losses++; else L.draws++;
        L.searchMs += now() - searchStart;
        L.searchMoves += Math.ceil((m.plies - 2) / 2);
        if (board) {
          board.live = false;
          board.line = m.line;
          board.cap.innerHTML = '';
          board.cap.appendChild(document.createTextNode(fmtSims(L.sims) + ' · '));
          if (m.score === 0.5) board.cap.appendChild(document.createTextNode('draw'));
          else {
            const who = document.createElement('b');
            who.textContent = m.score === 1 ? 'Searcher' : 'Expert';
            who.className = m.score === 1 ? 'c' : 'k';
            board.cap.appendChild(who);
          }
          invalidate(board);
        }
        this.chart.pops.set(task.li, now());
        this.chart.animating = true;
        this._maybeTrim();
        this._readouts();
        invalidate(this.chart);
        multiples.update();
      });
    },
    _freeBoard() {
      let best = null;
      for (const b of this.boards) if (!b.live && (!best || (b.used || 0) < (best.used || 0))) best = b;
      return best || this.boards[0];
    },
    // After the 4,096 level, estimate how long 65,536 would take here.
    _maybeTrim() {
      const li = LEVELS.indexOf(4096);
      const L = this.levels[li];
      if (L.n < 6 || this.topLevel < LEVELS.length - 1 || this.trimChecked) return;
      this.trimChecked = true;
      const perGameMs = L.searchMs / L.n; // wall time per game per worker
      const est = perGameMs * 16 * this.levels[LEVELS.length - 1].planned / this.pool.size;
      if (est > 150000) this.topLevel = LEVELS.length - 2;
    },
    stop() {
      if (!this.running) return;
      this.pool.cancelAll();
      this._finish(true);
    },
    _finish(stopped) {
      if (!this.running) return;
      this.running = false;
      this.elapsed += now() - this.t0;
      $('tour-run').textContent = this.games ? 'Run again from scratch' : 'Start the tournament';
      $('tour-more').hidden = !this.games;
      for (const b of this.boards) { b.live = false; if (!b.line) b.cap.textContent = 'idle'; }
      this._readouts(stopped);
      this._result(stopped);
      invalidate(this.chart);
      multiples.update();
    },
    _reset() {
      for (const L of this.levels) Object.assign(L, { score: 0, n: 0, wins: 0, draws: 0, losses: 0, planned: 0, searchMs: 0, searchMoves: 0, positions: 0 });
      this.games = 0; this.planned = 0; this.positions = 0; this.elapsed = 0; this.crossover = null; this.trimChecked = false;
      this.chart.pops.clear();
    },
    rate(L) { return L.n ? L.score / L.n : null; },
    computeCrossover() {
      // first rise through 50%, interpolated on the log axis
      const pts = this.levels.map((L, i) => ({ i, p: this.rate(L), n: L.n, L })).filter((q) => q.n >= Math.min(8, q.L.planned || 8));
      for (let k = 0; k + 1 < pts.length; k++) {
        const a = pts[k], b = pts[k + 1];
        if (b.i !== a.i + 1) continue;
        if (a.p < 0.5 && b.p >= 0.5) {
          const f = (0.5 - a.p) / (b.p - a.p);
          const li = a.i + f;
          const sims = Math.pow(4, li);
          const msPerSim = (a.L.searchMoves ? a.L.searchMs / a.L.searchMoves / a.L.sims : 0) || 0;
          return { li, sims, a, b, msPerMove: msPerSim * sims };
        }
      }
      return null;
    },
    _readouts(stopped) {
      const levelNow = this.levels.findIndex((L) => L.n < L.planned);
      const st = this.running
        ? 'level ' + (levelNow + 1) + ' of ' + (this.topLevel + 1) + ' · ' + fmtInt(this.levels[Math.max(0, levelNow)].sims) + ' imagined games per move'
        : this.games ? (stopped ? 'stopped' : 'finished') + ' · ' + this.games + ' games' : 'waiting';
      $('tour-status').textContent = st;
      const t = this.running ? this.elapsed + now() - this.t0 : this.elapsed;
      $('tour-readouts').innerHTML = '';
      const add = (k, v) => { const s = document.createElement('span'); s.innerHTML = k + ' <b></b>'; s.lastChild.textContent = v; $('tour-readouts').appendChild(s); };
      add('games', this.games + (this.running ? ' of ' + this.planned : ''));
      add('positions imagined', fmtBig(this.positions));
      add('time', fmtTime(t));
      add('cores', String(this.pool ? this.pool.size : WORKERS) + (workersBroken ? ' (main thread)' : ''));
    },
    _result(stopped) {
      const el = $('tour-result');
      const x = this.computeCrossover();
      this.crossover = x;
      const top = this.levels.filter((L) => L.n > 0).pop();
      if (!top) { el.textContent = ''; return; }
      const parts = [];
      if (x) {
        parts.push('The Searcher drew level with the Expert at about ' + fmtInt(sig2(x.sims)) + ' imagined games per move' + (x.msPerMove ? ', roughly ' + fmtTime(x.msPerMove) + ' of thinking per move on this device.' : '.'));
      } else if (this.rate(top) < 0.5) {
        parts.push('The Searcher has not caught the Expert yet.');
      }
      parts.push('At ' + fmtInt(top.sims) + ' it scored ' + pct(this.rate(top)) + ' (' + top.wins + ' wins, ' + top.draws + ' draws, ' + top.losses + ' losses).');
      if (this.topLevel < LEVELS.length - 1 && !stopped) parts.push('Your device skipped the 65,536 level to save time.');
      const low = this.levels[0];
      if (low.n) parts.push('With a single imagined game per move it scored ' + pct(this.rate(low)) + '.');
      el.textContent = parts.join(' ');
    },
    _drawChart(t) {
      const S = this.chart.surface, ctx = S.fit(), w = S.w, h = S.h, P = palette();
      drawTourChart(ctx, w, h, this, t, false);
      let anim = false;
      for (const [, t0] of this.chart.pops) if (t - t0 < 450) anim = true;
      this.chart.animating = anim;
    },
  };

  function drawTourChart(ctx, w, h, T, t, compact) {
    const P = palette();
    const small = w < 520 || compact;
    const A = new Axes(w, h, compact ? { l: 30, r: 8, t: 14, b: 22 } : { l: small ? 38 : 48, r: small ? 12 : 22, t: 30, b: small ? 44 : 48 }, { min: 1, max: 65536, log: true }, { min: 0, max: 1 });
    // two eras: shade left of the crossover amber, right of it blue
    const x = T.computeCrossover();
    if (x) {
      const cx = A.tx(x.sims);
      ctx.fillStyle = rgba(P.knowledge, 0.06);
      ctx.fillRect(A.l, A.t, cx - A.l, A.b - A.t);
      ctx.fillStyle = rgba(P.compute, 0.07);
      ctx.fillRect(cx, A.t, A.r - cx, A.b - A.t);
    }
    const xt = LEVELS.map((s, i) => ({ v: s, label: compact || small ? (i % 2 === 0 ? fmtSims(s) : null) : fmtInt(s) }));
    const yt = [0, 0.25, 0.5, 0.75, 1].map((v) => ({ v, label: compact && v % 0.5 ? null : Math.round(v * 100) + '%', strong: v === 0.5 }));
    A.grid(ctx, xt, yt, { fontPx: compact ? 9 : 10.5 });
    if (!compact) A.titles(ctx, 'imagined games per move for the Searcher →', 'score against the other player', { yIndent: small ? 38 : 48, xOff: small ? 40 : 42 });
    label(ctx, 'even', A.r - 2, A.ty(0.5) - 9, { align: 'right', font: FONT.sans(compact ? 9.5 : 11.5), color: P.ink3 });
    const all = T.levels.map((L, i) => ({ L, i, p: T.rate(L), done: L.planned > 0 && L.n >= L.planned })).filter((q) => q.p != null);
    // a level still being played joins the line once it has enough games to mean something
    const pts = all.filter((q) => q.done || q.L.n >= 12);
    const partial = all.filter((q) => !(q.done || q.L.n >= 12));
    const series = [
      { color: P.compute, f: (p) => p },
      { color: P.knowledge, f: (p) => 1 - p },
    ];
    for (const s of series) {
      // whiskers
      if (!compact) {
        ctx.save();
        ctx.strokeStyle = rgba(s.color, 0.45);
        ctx.lineWidth = 1.5;
        for (const q of pts) {
          const [lo, hi] = wilson(q.p, q.L.n);
          const xx = A.tx(q.L.sims);
          const a = s.f(lo), b = s.f(hi);
          ctx.beginPath(); ctx.moveTo(xx, A.ty(a)); ctx.lineTo(xx, A.ty(b)); ctx.stroke();
        }
        ctx.restore();
      }
      ctx.save();
      ctx.strokeStyle = s.color;
      ctx.lineWidth = compact ? 2 : 2.5;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      pts.forEach((q, k) => { const xx = A.tx(q.L.sims), yy = A.ty(s.f(q.p)); if (k === 0) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy); });
      ctx.stroke();
      for (const q of pts) {
        const xx = A.tx(q.L.sims), yy = A.ty(s.f(q.p));
        const t0 = T.chart && T.chart.pops.get(q.i);
        const pop = t0 && !reduceMotion ? 1 + 0.6 * (1 - easeOut((t - t0) / 450)) : 1;
        const done = q.L.n >= q.L.planned && q.L.planned > 0;
        ctx.beginPath();
        ctx.arc(xx, yy, (compact ? 2.6 : 4) * pop, 0, Math.PI * 2);
        ctx.fillStyle = done || compact ? s.color : P.panel;
        ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = s.color; ctx.stroke();
      }
      // games in progress at a new level: faint, unconnected
      ctx.save();
      for (const q of partial) {
        const xx = A.tx(q.L.sims), yy = A.ty(s.f(q.p));
        ctx.globalAlpha = 0.35 + 0.4 * (q.L.n / 12);
        ctx.beginPath(); ctx.arc(xx, yy, compact ? 2.4 : 3.6, 0, Math.PI * 2);
        ctx.lineWidth = 1.5; ctx.strokeStyle = s.color; ctx.stroke();
      }
      ctx.restore();
      ctx.restore();
    }
    if (x) {
      const cx = A.tx(x.sims);
      ctx.save();
      ctx.strokeStyle = P.ink; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(cx, A.t); ctx.lineTo(cx, A.b); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(cx, A.ty(0.5), compact ? 5 : 7, 0, Math.PI * 2); ctx.lineWidth = 1.5; ctx.stroke();
      ctx.restore();
      const txt = compact ? 'crossover' : 'crossover · ≈' + fmtInt(sig2(x.sims)) + ' per move';
      label(ctx, txt, cx + 8, A.t + 10, { font: FONT.sans(compact ? 10 : 12.5, 600), color: P.ink });
    }
    if (!compact) {
      // direct labels at the right end of each line
      const last = pts[pts.length - 1];
      if (last) {
        const xx = A.tx(last.L.sims);
        const ys = A.ty(last.p), ye = A.ty(1 - last.p);
        const sep = Math.abs(ys - ye) < 26 ? 13 : 0;
        const right = xx > A.r - 120;
        label(ctx, 'Searcher', xx + (right ? -10 : 10), ys + (ys < ye ? -sep : sep), { align: right ? 'right' : 'left', color: P.computeInk, font: FONT.sans(13, 600) });
        label(ctx, 'Expert', xx + (right ? -10 : 10), ye + (ye < ys ? -sep : sep), { align: right ? 'right' : 'left', color: P.knowledgeInk, font: FONT.sans(13, 600) });
      } else {
        label(ctx, 'The tournament starts when this panel scrolls into view.', (A.l + A.r) / 2, (A.t + A.b) / 2 - 14, { align: 'center', color: P.ink3, font: FONT.sans(13) });
      }
    }
  }

  // ================================================================ play (I and III)
  const LADDER = [16, 64, 256, 1024, 4096, 16384, 65536, 262144];

  class PlayBoard {
    constructor(opts) {
      this.canvas = opts.canvas;
      this.say = opts.say;
      this.status = opts.status;
      this.onEnd = opts.onEnd || (() => {});
      this.onMove = opts.onMove || (() => {});
      this.getSims = opts.getSims;
      this.rules = BL.normalizeRules(opts.rules || BL.STANDARD_RULES);
      this.humanFirst = opts.humanFirst !== false;
      this.worker = null;
      this.surface = new Surface(this.canvas, this);
      this.game = new BL.Game(this.rules);
      this.history = [];
      this.anim = new Map(); // cell -> {t0, dur, fromRow}
      this.stats = null;
      this.thinking = false;
      this.hoverCol = -1;
      this.line = null;
      this.positions = 0;
      this.jobId = 0;
      this.canvas.tabIndex = 0;
      this._bind();
    }
    get searcherPlayer() { return this.humanFirst ? 2 : 1; }
    get humanPlayer() { return this.humanFirst ? 1 : 2; }
    setRules(rules) {
      this.rules = BL.normalizeRules(rules);
      this.canvas.style.aspectRatio = this.rules.w + ' / ' + (this.rules.h + (this.rules.gravity ? 0.95 : 0.15));
      this.reset();
    }
    reset() {
      this._cancelThinking();
      this.game = new BL.Game(this.rules);
      this.history = [];
      this.anim.clear();
      this.stats = null;
      this.line = null;
      this.positions = 0;
      this.over = false;
      invalidate(this);
      if (!this.humanFirst) this._searcherTurn();
    }
    _cancelThinking() {
      if (this.thinking && this.worker) this.worker.postMessage({ type: 'cancel', id: this.jobId });
      this.thinking = false;
      meter.setBusy(this.busy ? -1 : 0); this.busy = false;
    }
    _geom() {
      const w = this.surface.w, h = this.surface.h, R = this.rules;
      const band = R.gravity ? 0.95 : 0.15;
      const cell = Math.min(w / R.w, h / (R.h + band));
      const x0 = (w - cell * R.w) / 2;
      const y0 = h - cell * R.h - (h - cell * (R.h + band)) / 2;
      return { cell, x0, y0, band: band * cell };
    }
    _colAt(ev) {
      const rect = this.canvas.getBoundingClientRect();
      const G = this._geom();
      const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
      const c = Math.floor((x - G.x0) / G.cell);
      if (c < 0 || c >= this.rules.w) return -1;
      if (this.rules.gravity) return c;
      const row = this.rules.h - 1 - Math.floor((y - G.y0) / G.cell);
      if (row < 0 || row >= this.rules.h) return -1;
      return c * this.rules.h + row;
    }
    _bind() {
      this.canvas.addEventListener('pointermove', (ev) => { const c = this._colAt(ev); if (c !== this.hoverCol) { this.hoverCol = c; invalidate(this); } });
      this.canvas.addEventListener('pointerleave', () => { this.hoverCol = -1; invalidate(this); });
      this.canvas.addEventListener('pointerup', (ev) => { const c = this._colAt(ev); if (c >= 0) this.human(c); });
      this.canvas.addEventListener('keydown', (ev) => {
        const k = parseInt(ev.key, 10);
        if (this.rules.gravity && k >= 1 && k <= this.rules.w) { ev.preventDefault(); this.human(k - 1); }
      });
    }
    human(m) {
      if (this.over || this.thinking || this.game.result >= 0) return;
      if (this.game.toMove !== this.humanPlayer) return;
      if (!this.game.isLegal(m)) return;
      this._place(m);
      this.onMove();
      if (this.game.result >= 0) { this._end(); return; }
      this._searcherTurn();
    }
    _place(m) {
      const g = this.game;
      const cell = g.cellOf(m);
      g.play(m);
      this.history.push(m);
      if (!reduceMotion) {
        const row = cell % g.h;
        const fall = g.gravity ? (g.h - row) : 0;
        const dur = g.gravity ? 110 + 230 * Math.sqrt(fall / g.h) : 160;
        this.anim.set(cell, { t0: now(), dur, fromRow: g.gravity ? g.h + 0.3 : row });
        this.animating = true;
      }
      invalidate(this);
    }
    _searcherTurn() {
      const sims = this.getSims();
      this.thinking = true;
      this.stats = null;
      this.thinkStart = now();
      this.thinkSims = sims;
      if (!this.worker) this.worker = new Pool(1);
      if (!this.busy) { this.busy = true; }
      this._say('<b>Thinking.</b> Imagining ' + fmtInt(sims) + ' games…');
      const job = this.worker.run({ type: 'c4Think', rules: this.rules, moves: this.history.slice(), sims, seed: (Math.random() * 4e9) >>> 0, c: 0.5 }, (m) => {
        if (m.type === 'start') this.jobId = m.id;
        if (m.type === 'stats') {
          this.stats = m;
          this.positions += m.positions; meter.add(m.positions, 0);
          this._say('<b>Thinking.</b> ' + fmtInt(m.sims) + ' of ' + fmtInt(sims) + ' imagined games…');
          invalidate(this);
        }
      });
      const gameAtStart = this.game;
      job.then((m) => {
        if (gameAtStart !== this.game || m.type !== 'done') return;
        this.thinking = false;
        this.busy = false;
        this.positions += m.positions; meter.add(m.positions, 0);
        this.stats = m;
        if (m.move < 0) return;
        this._place(m.move);
        const best = (m.stats || []).find((s) => s.move === m.move);
        const conf = best ? best.value : 0.5;
        if (this.game.result >= 0) { this._end(); return; }
        let mood;
        if (m.proof === 1) mood = 'It has found a forced win.';
        else if (conf > 0.8) mood = 'It likes its position: about ' + pct(conf) + ' of its imagined games from here are wins.';
        else if (conf < 0.3) mood = 'It thinks it is in trouble: only ' + pct(conf) + ' of its imagined games from here are wins.';
        else mood = 'About ' + pct(conf) + ' of its imagined games from here are wins.';
        this._say('<b>Your move.</b> ' + mood + '<small>' + fmtInt(m.sims) + ' imagined games in ' + fmtTime(m.elapsed) + '</small>');
      });
    }
    _end() {
      this.over = true;
      this.line = this.game.findLine();
      const r = this.game.result;
      const outcome = r === 0 ? 'draw' : r === this.humanPlayer ? 'win' : 'loss';
      this.onEnd(outcome, this);
      invalidate(this);
    }
    _say(html) { if (this.say) this.say.innerHTML = html; }
    draw(t) {
      const ctx = this.surface.fit(), P = palette();
      const G = this._geom(), R = this.rules, g = this.game;
      const colors = { [this.humanPlayer]: P.knowledge, [this.searcherPlayer]: P.compute };
      // settle pieces whose fall is over before drawing the board
      for (const [cell, a] of this.anim) if (t - a.t0 >= a.dur) this.anim.delete(cell);
      drawBoard(ctx, G.x0, G.y0, G.cell, g, colors, { anim: this.anim });
      const r = G.cell * 0.39;
      // falling pieces
      let anim = false;
      for (const [cell, a] of this.anim) {
        const f = (t - a.t0) / a.dur;
        const c = Math.floor(cell / R.h), row = cell % R.h;
        anim = true;
        const cy = R.gravity ? lerp(a.fromRow, row, clamp(f, 0, 1) * clamp(f, 0, 1)) : row;
        const scale = R.gravity ? 1 : easeOut(f);
        ctx.save();
        ctx.beginPath();
        ctx.rect(G.x0, G.y0 - G.band, G.cell * R.w, G.cell * R.h + G.band);
        ctx.clip();
        ctx.beginPath();
        ctx.arc(G.x0 + (c + 0.5) * G.cell, G.y0 + (R.h - cy - 0.5) * G.cell, r * scale, 0, Math.PI * 2);
        ctx.fillStyle = colors[g.cells[cell]];
        ctx.fill();
        ctx.restore();
      }
      this.animating = anim;
      // hover hint
      if (!this.over && !this.thinking && this.hoverCol >= 0 && g.toMove === this.humanPlayer && g.result < 0) {
        const cell = g.cellOf(R.gravity ? this.hoverCol : this.hoverCol);
        if (cell >= 0) {
          const c = Math.floor(cell / R.h), row = cell % R.h;
          ctx.beginPath();
          ctx.arc(G.x0 + (c + 0.5) * G.cell, G.y0 + (R.h - row - 0.5) * G.cell, r, 0, Math.PI * 2);
          ctx.fillStyle = rgba(P.knowledge, 0.28);
          ctx.fill();
        }
      }
      // what the Searcher is thinking: visit share per move
      if (this.stats && this.stats.stats && this.stats.stats.length) {
        const st = this.stats.stats;
        let tot = 0, maxV = 0;
        for (const s of st) { tot += s.visits; if (s.visits > maxV) maxV = s.visits; }
        if (R.gravity) {
          const bandH = G.band * 0.62;
          for (const s of st) {
            const c = s.move;
            const share = tot ? s.visits / tot : 0;
            const bh = Math.max(1.5, bandH * (maxV ? s.visits / maxV : 0));
            const bx = G.x0 + (c + 0.18) * G.cell, bw = G.cell * 0.64;
            ctx.fillStyle = rgba(P.compute, this.thinking ? 0.55 : 0.32);
            ctx.fillRect(bx, G.y0 - 6 - bh, bw, bh);
            if (G.cell > 30 && share > 0.02) {
              label(ctx, pct(s.value), bx + bw / 2, G.y0 - 12 - bh, { align: 'center', baseline: 'bottom', font: FONT.mono(Math.min(11, G.cell * 0.22), 500), color: P.computeInk, halo: false });
            }
          }
        } else {
          for (const s of st) {
            const cell = s.move, c = Math.floor(cell / R.h), row = cell % R.h;
            const a = maxV ? s.visits / maxV : 0;
            if (a < 0.04) continue;
            ctx.beginPath();
            ctx.arc(G.x0 + (c + 0.5) * G.cell, G.y0 + (R.h - row - 0.5) * G.cell, r * 0.55 * Math.sqrt(a), 0, Math.PI * 2);
            ctx.fillStyle = rgba(P.compute, 0.45);
            ctx.fill();
          }
        }
      } else if (R.gravity && !this.history.length && !this.thinking) {
        label(ctx, 'tap a column', G.x0 + G.cell * R.w / 2, G.y0 - G.band * 0.45, { align: 'center', font: FONT.sans(13), color: P.ink3, halo: false });
      }
      // winning line
      if (this.line && !anim) {
        const pt = (cell) => [G.x0 + (Math.floor(cell / R.h) + 0.5) * G.cell, G.y0 + (R.h - (cell % R.h) - 0.5) * G.cell];
        ctx.save();
        ctx.strokeStyle = P.ink; ctx.lineWidth = Math.max(3, G.cell * 0.1); ctx.lineCap = 'round';
        // a wrapped line is drawn as dots, since it leaves one edge and enters the other
        const pts = this.line.map(pt);
        const wraps = pts.some((p, i) => i && Math.abs(p[0] - pts[i - 1][0]) > G.cell * 1.5);
        if (wraps) { for (const p of pts) { ctx.beginPath(); ctx.arc(p[0], p[1], G.cell * 0.12, 0, Math.PI * 2); ctx.fillStyle = P.ink; ctx.fill(); } }
        else { ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]); ctx.stroke(); }
        ctx.restore();
      }
    }
  }

  const play = {
    level: 0,
    record: LADDER.map(() => ({ w: 0, l: 0, d: 0 })),
    init() {
      this.board = new PlayBoard({
        canvas: $('play-board'), say: $('play-say'),
        getSims: () => LADDER[this.level],
        onEnd: (o) => this._end(o),
        onMove: () => { if (this.board.history.length <= 2) this._paint(); },
      });
      this.board.setRules(BL.STANDARD_RULES);
      const ladder = $('play-ladder');
      LADDER.forEach((s, i) => {
        const d = document.createElement('div');
        d.className = 'rung';
        d.title = fmtInt(s) + ' imagined games per move';
        d.innerHTML = '<b>' + (i + 1) + '</b>' + fmtSims(s);
        ladder.appendChild(d);
      });
      $('play-new').addEventListener('click', () => this.newGame());
      $('play-up').addEventListener('click', () => { if (this.level < LADDER.length - 1) { this.level++; this.newGame(); } });
      $('play-down').addEventListener('click', () => { if (this.level > 0) { this.level--; this.newGame(); } });
      this._paint();
    },
    newGame() { this.board.reset(); this._paint(); this.board._say('Level ' + (this.level + 1) + ': it imagines ' + fmtInt(LADDER[this.level]) + ' games before each move. Your move.'); },
    _end(outcome) {
      const rec = this.record[this.level];
      const sims = LADDER[this.level];
      const pos = this.board.positions;
      if (outcome === 'win') {
        rec.w++;
        const next = Math.min(LADDER.length - 1, this.level + 1);
        const msg = this.level === LADDER.length - 1
          ? '<b>You beat the top level.</b> That is genuinely impressive: it imagined ' + fmtInt(sims) + ' games per move. Give it a minute more per move and it would get stronger still; you would not.'
          : '<b>You win.</b> Your knowledge beat ' + fmtInt(sims) + ' imagined games per move. Next level: ' + fmtInt(LADDER[next]) + '. Your knowledge stays the same; its computation goes up four times.';
        this.level = next;
        this.board._say(msg + '<small>it imagined ' + fmtBig(pos) + ' positions this game</small>');
      } else if (outcome === 'loss') {
        rec.l++;
        const beaten = this.record.map((r, i) => (r.w ? i : -1)).filter((i) => i >= 0);
        const tail = beaten.length ? ' You have beaten it at ' + fmtInt(LADDER[Math.max(...beaten)]) + ' imagined games per move; at ' + fmtInt(sims) + ', it beat you.' : '';
        this.board._say('<b>It wins.</b> It knows nothing about Connect Four. It imagined ' + fmtInt(sims) + ' games before each move, and that was enough.' + tail + '<small>it imagined ' + fmtBig(pos) + ' positions this game · press New game to try again</small>');
      } else {
        rec.d++;
        this.board._say('<b>A draw.</b> Press New game to try this level again.');
      }
      this._paint();
      multiples.update();
    },
    _paint() {
      const rungs = $('play-ladder').children;
      for (let i = 0; i < rungs.length; i++) {
        const r = this.record[i];
        rungs[i].classList.toggle('now', i === this.level);
        rungs[i].classList.toggle('won', r.w > 0);
        rungs[i].classList.toggle('lost', r.w === 0 && r.l > 0);
      }
      $('play-status').textContent = 'level ' + (this.level + 1) + ' · ' + fmtInt(LADDER[this.level]) + ' imagined games per move';
      $('play-new').textContent = this.board && this.board.history.length && !this.board.over ? 'Restart level ' + (this.level + 1) : 'Play level ' + (this.level + 1);
      $('play-down').disabled = this.level === 0;
      $('play-up').disabled = this.level === LADDER.length - 1;
    },
  };

  // ================================================================ II. learning
  const CNN_CONFIG = { f1: 8, f2: 16, lr: 0.003, batch: 32, seed: 2012 };
  const CNN_EPOCHS = 8, FE_EPOCHS = 12;
  const EVAL_SUBSET = 2500; // test digits used for the points along the way; the end uses all
  const CHECKPOINTS = [];
  for (let e = 5; e <= 12.001; e += 0.25) CHECKPOINTS.push(Math.pow(10, e));
  const fmtRate = (r) => (r >= 0.1 ? (r * 100).toFixed(0) : r >= 0.01 ? (r * 100).toFixed(1) : (r * 100).toFixed(2)) + '%';

  const race = {
    pool: null, running: false, done: false,
    rulebook: null, fe: [], cnn: [], feDone: false, cnnDone: false,
    net: null, flops: 0, seen: 0, t0: 0, elapsed: 0,
    feW: null, feB: null, feFlops: 0,
    init() {
      this.chart = { dirty: true, draw: (t) => drawRaceChart(this.chart.surface, this, t, false) };
      this.chart.surface = new Surface($('race-chart').querySelector('canvas'), this.chart);
      this.net = new BL.digits.ConvNet(CNN_CONFIG);
      $('cnn-params').textContent = fmtInt(this.net.paramCount) + ' learned weights';
      this._filters();
      $('race-run').addEventListener('click', () => (this.running ? this.stop() : this.start()));
      whenSeen($('race'), () => { if (!this.running && !this.done && !this.started) this.start(); }, 0.3);
      this._readouts();
      if (BL.rulebook && BL.rulebook.RULE_COUNT) $('rb-rules').textContent = BL.rulebook.RULE_COUNT + ' hand-written rules';
    },
    // The digit both programs are shown looking at, and their edge maps.
    _filters() {
      const mk = (parent, n, size) => {
        const out = [];
        for (let i = 0; i < n; i++) { const c = document.createElement('canvas'); c.width = size; c.height = size; parent.appendChild(c); out.push(c); }
        return out;
      };
      this.humanMaps = mk($('maps-human'), 4, 28);
      this.learnedMaps = mk($('maps-learned'), CNN_CONFIG.f1, 24);
    },
    _setMapDigit(data) {
      let i = 0;
      while (i < data.test.count && data.test.labels[i] !== 3) i++;
      this.mapDigit = data.test.images.slice(i * 784, i * 784 + 784);
      paintGray($('maps-digit'), this.mapDigit, 28, 28);
      // edge strength in four orientations, from the same gradients HOG uses
      const px = this.mapDigit, maps = [0, 1, 2, 3].map(() => new Float32Array(784));
      for (let y = 0; y < 28; y++) for (let x = 0; x < 28; x++) {
        const l = x > 0 ? px[y * 28 + x - 1] : 0, r = x < 27 ? px[y * 28 + x + 1] : 0;
        const u = y > 0 ? px[(y - 1) * 28 + x] : 0, d = y < 27 ? px[(y + 1) * 28 + x] : 0;
        const gx = (r - l) / 255, gy = (d - u) / 255, mag = Math.sqrt(gx * gx + gy * gy);
        if (!mag) continue;
        let ang = Math.atan2(gy, gx); if (ang < 0) ang += Math.PI;
        for (let k = 0; k < 4; k++) {
          let dd = Math.abs(ang - k * Math.PI / 4); dd = Math.min(dd, Math.PI - dd);
          maps[k][y * 28 + x] = mag * Math.max(0, 1 - dd / (Math.PI / 4));
        }
      }
      maps.forEach((m, k) => paintGray(this.humanMaps[k], m, 28, 28));
      this._paintFilters();
    },
    _paintFilters() {
      if (!this.mapDigit) return;
      const net = this.net, px = this.mapDigit, F1 = CNN_CONFIG.f1;
      const out = new Float32Array(576);
      for (let f = 0; f < F1; f++) {
        const wo = f * 25, bias = net.b1[f];
        for (let y = 0; y < 24; y++) for (let x = 0; x < 24; x++) {
          let s = bias;
          for (let ky = 0; ky < 5; ky++) for (let kx = 0; kx < 5; kx++) s += net.w1[wo + ky * 5 + kx] * px[(y + ky) * 28 + x + kx] / 255;
          out[y * 24 + x] = s > 0 ? s : 0;
        }
        paintGray(this.learnedMaps[f], out, 24, 24);
      }
    },
    async start() {
      if (this.running) return;
      this.started = true;
      this.running = true;
      $('race-run').textContent = 'Stop';
      $('race-status').textContent = 'loading 3.6 MB of handwritten digits…';
      let data;
      try { data = await loadDigits(); } catch (e) {
        $('race-status').textContent = e.message; this.running = false; $('race-run').textContent = 'Try again'; return;
      }
      draw.setData(data);
      if (!this.running) return;
      this._reset();
      this._setMapDigit(data);
      this.data = data;
      // Gradients on every core we can have; one more core each for the
      // Rulebook and Feature Engineer, and for grading the Learner.
      this.pool = new Pool(WORKERS);
      this.sidePool = new Pool(1);
      this.evalPool = new Pool(1);
      $('race-status').textContent = 'sending the digits to ' + (this.pool.size + 2) + ' threads…';
      await Promise.all([
        this.pool.each(() => ({ type: 'setData', train: data.trainBuf })),
        this.sidePool.each(() => ({ type: 'setData', train: data.trainBuf, test: data.testBuf })),
        this.evalPool.each(() => ({ type: 'setData', test: data.testBuf })),
      ]);
      if (!this.running) return;
      this.t0 = now();
      // The Rulebook reads all the test digits once.
      if (BL.rulebook) {
        this.sidePool.run({ type: 'rulebookEval' }).then((m) => {
          if (m.type !== 'done') return;
          const n = this.data.test.count;
          this.rulebook = { errors: m.wrong.length, rate: m.wrong.length / n, n, wrong: m.wrong, ms: m.ms };
          invalidate(this.chart); this._readouts(); multiples.update();
        });
      }
      // The Feature Engineer trains on one core.
      this.sidePool.run({ type: 'feTrain', epochs: FE_EPOCHS, checkpoints: CHECKPOINTS, lr: 0.003, batch: 32, seed: 11, evalCount: EVAL_SUBSET }, (m) => {
        if (m.type === 'point') {
          this.fe.push({ flops: Math.max(m.flops, 1e5), rate: m.rate, n: m.n, errors: m.errors, final: m.final });
          meter.add(0, m.flops - this.feFlops); this.feFlops = m.flops;
          this.feW = m.W; this.feB = m.b;
          if (m.final) this.feWrong = m.wrong;
          invalidate(this.chart); this._readouts(); draw.refresh();
        } else if (m.type === 'work') {
          meter.add(0, m.flops - this.feFlops); this.feFlops = m.flops;
        }
      }).then((m) => {
        if (m.type === 'done') { this.feDone = true; this._readouts(); this._maybeDone(); }
      });
      // The Learner trains data-parallel across all cores.
      this._trainLoop();
    },
    _reset() {
      this.fe = []; this.cnn = []; this.feDone = false; this.cnnDone = false; this.done = false;
      this.flops = 0; this.seen = 0; this.elapsed = 0; this.feFlops = 0; this.trainEnd = 0; this.pendingSnap = null; this.evalLoop = null;
      this.rulebook = null;
      this.net = new BL.digits.ConvNet(CNN_CONFIG);
      this.trainMs = 0;
      this._paintFilters();
      $('race-result').textContent = '';
    },
    // Evaluate a snapshot of the weights on the evaluation worker. Training
    // never waits for this; if snapshots pile up, only the newest is kept.
    _queueEval(full, flopsOverride) {
      this.pendingSnap = { w: this.net.getParams(), flops: flopsOverride || this.flops, seen: this.seen, full };
      if (!this.evalLoop) this.evalLoop = this._evalLoop();
      return this.evalLoop;
    },
    async _evalLoop() {
      const config = JSON.stringify(CNN_CONFIG);
      while (this.pendingSnap && this.evalPool) {
        const snap = this.pendingSnap;
        this.pendingSnap = null;
        const n = snap.full ? this.data.test.count : Math.min(EVAL_SUBSET, this.data.test.count);
        let m;
        try { m = await this.evalPool.run({ type: 'cnnEval', config, w: snap.w, from: 0, to: n }); } catch (e) { break; }
        if (!m || m.type !== 'done') break;
        this.cnn.push({ flops: snap.flops, rate: m.wrong.length / n, n, errors: m.wrong.length, seen: snap.seen, final: snap.full });
        if (snap.full) this.cnnWrong = m.wrong;
        invalidate(this.chart); this._readouts(); multiples.update();
      }
      this.evalLoop = null;
    },
    async _trainLoop() {
      const net = this.net, data = this.data, pool = this.pool;
      const N = data.train.count, B = CNN_CONFIG.batch;
      const stepsPerEpoch = Math.floor(N / B), totalSteps = stepsPerEpoch * CNN_EPOCHS;
      const rng = BL.digits.makeFloatRng(4242);
      const config = JSON.stringify(CNN_CONFIG);
      let ci = 0;
      // Early points come thick and fast; measure them on 500 digits, pausing
      // training (and its clock) while we do.
      const quickEval = async (flops) => {
        const n = Math.min(500, data.test.count), w = net.getParams();
        const r = await this.evalPool.run({ type: 'cnnEval', config, w, from: 0, to: n });
        if (!r || r.type !== 'done') return false;
        const wrong = r.wrong.length;
        this.cnn.push({ flops, rate: wrong / n, n, errors: wrong, seen: this.seen });
        invalidate(this.chart); this._readouts(); multiples.update();
        return true;
      };
      if (!(await quickEval(1e5))) return;
      let lastPaint = 0;
      for (let e = 0; e < CNN_EPOCHS && this.running; e++) {
        const order = Array.from({ length: N }, (_, i) => i);
        for (let i = N - 1; i > 0; i--) { const j = rng.int(i + 1); const t = order[i]; order[i] = order[j]; order[j] = t; }
        for (let s = 0; s < stepsPerEpoch && this.running; s++) {
          const step = e * stepsPerEpoch + s;
          const ts = now();
          const idx = order.slice(s * B, s * B + B);
          const k = pool.size, per = Math.ceil(B / k);
          const w = net.getParams();
          const parts = [];
          for (let i = 0; i < k; i++) {
            const shard = idx.slice(i * per, (i + 1) * per);
            if (shard.length) parts.push(pool.run({ type: 'cnnGrad', config, w, indices: shard }));
          }
          const res = await Promise.all(parts);
          if (!this.running || res.some((r) => r.type !== 'done')) return;
          net.zeroGrads();
          for (const r of res) net.addGrads(r.grads);
          net.setLearningRate(CNN_CONFIG.lr * 0.5 * (1 + Math.cos(Math.PI * step / totalSteps)));
          net.step(B);
          this.trainMs += now() - ts;
          this.seen += B;
          const f = B * net.flopsPerExample;
          this.flops += f;
          meter.add(0, f);
          this.epoch = e + 1;
          const t = now();
          if (t - lastPaint > 120) {
            lastPaint = t;
            this._paintFilters();
            this._readouts();
            draw.refresh();
          }
          if (ci < CHECKPOINTS.length && this.flops >= CHECKPOINTS[ci]) {
            while (ci < CHECKPOINTS.length && this.flops >= CHECKPOINTS[ci]) ci++;
            if (this.flops < 1.2e9) { if (!(await quickEval(this.flops))) return; }
            else this._queueEval(false);
          }
        }
      }
      if (!this.running) return;
      this.trainEnd = now();
      this._paintFilters();
      if (this.evalLoop) await this.evalLoop;
      await this._queueEval(true);
      this.cnnDone = true;
      invalidate(this.chart);
      this._maybeDone();
    },
    _maybeDone() {
      if (!(this.cnnDone && this.feDone)) { this._readouts(); return; }
      this.running = false; this.done = true;
      this.elapsed = this.trainEnd ? this.trainEnd - this.t0 : now() - this.t0;
      if (this.pool) { this.pool.terminate(); this.pool = null; }
      if (this.evalPool) { this.evalPool.terminate(); this.evalPool = null; }
      if (this.sidePool) { this.sidePool.terminate(); this.sidePool = null; }
      $('race-run').textContent = 'Train again from scratch';
      this._readouts();
      this._result();
      draw.refresh();
      multiples.update();
    },
    stop() {
      if (!this.running) return;
      this.running = false;
      if (this.pool) { this.pool.terminate(); this.pool = null; }
      if (this.evalPool) { this.evalPool.terminate(); this.evalPool = null; }
      if (this.sidePool) { this.sidePool.terminate(); this.sidePool = null; }
      this.pendingSnap = null;
      this.elapsed = this.t0 ? now() - this.t0 : 0;
      $('race-run').textContent = 'Start training again';
      this._readouts(true);
    },
    feBest() {
      if (!this.fe.length) return null;
      const fin = this.fe.find((p) => p.final);
      return fin ? fin.rate : Math.min(...this.fe.map((p) => p.rate));
    },
    crossings() {
      const out = {};
      const cross = (series, level) => {
        for (let i = 1; i < series.length; i++) {
          const a = series[i - 1], b = series[i];
          if (a.rate > level && b.rate <= level) {
            const la = Math.log10(Math.max(a.rate, 1e-4)), lb = Math.log10(Math.max(b.rate, 1e-4)), lv = Math.log10(level);
            const f = la === lb ? 1 : (la - lv) / (la - lb);
            return Math.pow(10, lerp(Math.log10(a.flops), Math.log10(b.flops), f));
          }
        }
        return null;
      };
      if (this.rulebook) out.rulebook = cross(this.cnn, this.rulebook.rate);
      if (this.feDone && this.fe.length) {
        out.feBest = this.feBest();
        out.fe = cross(this.cnn, out.feBest);
      }
      return out;
    },
    timeAtFlops(f) { // milliseconds of training the Learner needed to reach f FLOP
      return f / Math.max(1, this.flops) * this.trainMs;
    },
    _readouts(stopped) {
      const el = $('race-readouts');
      el.innerHTML = '';
      const add = (k, v) => { const s = document.createElement('span'); s.innerHTML = k + ' <b></b>'; s.lastChild.textContent = v; el.appendChild(s); };
      const last = (arr) => (arr.length ? arr[arr.length - 1] : null);
      if (this.rulebook) add('Rulebook', fmtRate(this.rulebook.rate) + ' misread');
      const fe = last(this.fe);
      if (fe) add('Feature Engineer', fmtRate(fe.rate) + (this.feDone ? ' (done)' : ''));
      const c = last(this.cnn);
      if (c) add('Learner', fmtRate(c.rate) + ' · epoch ' + (this.epoch || 0) + ' of ' + CNN_EPOCHS);
      add('Learner FLOP', fmtSci(this.flops));
      add('time', fmtTime(this.running ? now() - this.t0 : this.elapsed));
      if (this.running) $('race-status').textContent = 'training on ' + (this.pool ? this.pool.size : 1) + (workersBroken ? ' slice (main thread)' : ' cores') + ' · ' + fmtInt(this.seen) + ' examples';
      else if (this.done) $('race-status').textContent = 'finished';
      else if (stopped) $('race-status').textContent = 'stopped';
    },
    _result() {
      const x = this.crossings();
      const c = this.cnn[this.cnn.length - 1];
      const feFin = this.fe.find((p) => p.final);
      const parts = [];
      if (x.rulebook) parts.push('The Learner passed the Rulebook after ' + fmtSci(x.rulebook) + ' FLOP of training, about ' + fmtTime(this.timeAtFlops(x.rulebook)) + ' on this device.');
      if (x.fe) parts.push('It passed the Feature Engineer, whose hand-designed features had stopped improving, after ' + fmtSci(x.fe) + ' FLOP, about ' + fmtTime(this.timeAtFlops(x.fe)) + '.');
      else if (x.feBest != null) parts.push('This time it did not get below the Feature Engineer; on digits, the hand-designed features are very good.');
      if (c && c.final && this.rulebook && feFin) parts.push('Mistakes on all ' + fmtInt(c.n) + ' test digits: Rulebook ' + fmtInt(this.rulebook.errors) + ', Feature Engineer ' + fmtInt(feFin.errors) + ', Learner ' + fmtInt(c.errors) + '.');
      $('race-result').textContent = parts.join(' ');
    },
  };

  function drawRaceChart(S, R, t, compact) {
    const ctx = S.fit(), w = S.w, h = S.h, P = palette();
    const small = w < 560 || compact;
    const YMAX = 0.95, YMIN = 0.004;
    const pad = compact ? { l: 32, r: 8, t: 14, b: 22 } : small ? { l: 40, r: 12, t: 30, b: 44 } : { l: 50, r: 150, t: 30, b: 48 };
    const A = new Axes(w, h, pad, { min: 1e5, max: 1e12, log: true }, { min: YMAX, max: YMIN, log: true });
    const xt = [];
    for (let e = 5; e <= 12; e++) xt.push({ v: Math.pow(10, e), pow: (compact ? e % 2 === 1 : !(small && e % 2 === 0)) ? e : null });
    const ticks = [0.9, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01, 0.005];
    const yt = ticks.map((v) => ({ v, label: compact && ![0.9, 0.1, 0.01].includes(v) ? null : (v * 100) + '%' }));
    A.grid(ctx, xt, yt, { fontPx: compact ? 9 : 10.5 });
    if (!compact) A.titles(ctx, 'training computation, FLOP →', 'share of unseen test digits misread · log scale · better ↑', { yIndent: small ? 40 : 50, xOff: small ? 40 : 42 });
    const Y = (r) => A.ty(clamp(r, YMIN, YMAX));
    const X = (f) => A.tx(clamp(f, 1e5, 1e12));
    const line = (pts, color, dashed, width) => {
      if (!pts.length) return;
      ctx.save();
      ctx.strokeStyle = color; ctx.lineWidth = width || (compact ? 2 : 2.5); ctx.lineJoin = 'round';
      if (dashed) ctx.setLineDash(dashed);
      ctx.beginPath();
      pts.forEach((p, i) => { const x = X(p.flops), y = Y(p.rate); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
      ctx.stroke();
      ctx.restore();
    };
    const ends = [];
    // Rulebook: flat, it never trains
    if (R.rulebook) {
      line([{ flops: 1e5, rate: R.rulebook.rate }, { flops: 1e12, rate: R.rulebook.rate }], P.knowledge, null);
      ends.push({ y: Y(R.rulebook.rate), name: 'Rulebook', value: fmtRate(R.rulebook.rate), color: P.knowledgeInk });
    }
    // Feature Engineer, then its plateau extended
    if (R.fe.length) {
      line(R.fe, P.hybrid, null);
      const lastFe = R.fe[R.fe.length - 1];
      if (R.feDone) {
        const best = R.feBest();
        line([{ flops: lastFe.flops, rate: best }, { flops: 1e12, rate: best }], P.hybrid, [4, 4], compact ? 1.5 : 2);
        ends.push({ y: Y(best), name: 'Feature Engineer', value: fmtRate(best), color: P.hybrid });
      } else {
        ends.push({ y: Y(lastFe.rate), name: 'Feature Engineer', value: fmtRate(lastFe.rate), color: P.hybrid, live: true });
      }
    }
    // Learner
    if (R.cnn.length) {
      line(R.cnn, P.compute, null, compact ? 2.2 : 3);
      const lc = R.cnn[R.cnn.length - 1];
      const x = X(lc.flops), y = Y(lc.rate);
      ctx.beginPath(); ctx.arc(x, y, compact ? 2.8 : 4.5, 0, Math.PI * 2); ctx.fillStyle = P.compute; ctx.fill();
      ends.push({ y, name: 'Learner', value: fmtRate(lc.rate), color: P.computeInk, live: !R.cnnDone });
    }
    // labels in the right margin, nudged apart
    if (!compact && !small && ends.length) {
      ends.sort((a, b) => a.y - b.y);
      for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 30) ends[i].y = ends[i - 1].y + 30;
      for (const e of ends) {
        label(ctx, e.name, A.r + 12, e.y - 7, { color: e.color, font: FONT.sans(12.5, 600) });
        label(ctx, e.value + (e.live ? ' · so far' : ''), A.r + 12, e.y + 9, { color: e.color, font: FONT.mono(11.5, 500) });
      }
    } else if (!compact && R.rulebook) {
      label(ctx, 'Rulebook', A.l + 6, Y(R.rulebook.rate) - 11, { color: P.knowledgeInk, font: FONT.sans(12, 600) });
    }
    // crossovers
    const xs = R.crossings();
    for (const key of ['rulebook', 'fe']) {
      const f = xs[key];
      if (!f) continue;
      const lvl = key === 'rulebook' ? R.rulebook.rate : xs.feBest;
      const x = A.tx(f), y = Y(lvl);
      ctx.save();
      ctx.strokeStyle = P.ink; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x, y, compact ? 4.5 : 7, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
      if (!compact) {
        const txt = (small ? '' : 'crossover · ') + fmtSci(f, 1) + ' FLOP';
        const right = x > A.r - 150;
        label(ctx, txt, x + (right ? -10 : 10), y + (key === 'fe' ? 20 : -17), { align: right ? 'right' : 'left', font: FONT.sans(small ? 11 : 12, 600), color: P.ink });
      }
    }
    if (!compact && !R.cnn.length && !R.fe.length) {
      label(ctx, R.running ? 'loading…' : 'Training starts when this panel scrolls into view.', (A.l + A.r) / 2, (A.t + A.b) / 2, { align: 'center', color: P.ink3, font: FONT.sans(13) });
    }
  }

  // ================================================================ draw a digit
  const draw = {
    data: null,
    init() {
      const c = $('draw-pad');
      this.pad = c;
      this.ctx = c.getContext('2d', { willReadFrequently: true });
      this.size = 0;
      this.drawing = false;
      this.hasInk = false;
      this.pixels = null;
      this.sizePad();
      if ('ResizeObserver' in window) new ResizeObserver(() => this.sizePad()).observe(c);
      c.addEventListener('pointerdown', (e) => this._down(e));
      c.addEventListener('pointermove', (e) => this._move(e));
      c.addEventListener('pointerup', (e) => this._up(e));
      c.addEventListener('pointercancel', (e) => this._up(e));
      $('draw-clear').addEventListener('click', () => this.clear());
      $('draw-sample').addEventListener('click', () => this.sample());
      // A small inset showing what the Rulebook sees.
      const inset = document.createElement('canvas');
      inset.width = 28; inset.height = 28;
      inset.style.cssText = 'width:84px;height:84px;image-rendering:pixelated;border-radius:3px;background:#05070a;margin:.2rem 0';
      inset.setAttribute('aria-hidden', 'true');
      $('v-rb').after(inset);
      this.inset = inset;
      for (const id of ['v-fe-bars', 'v-cnn-bars']) for (let i = 0; i < 10; i++) $(id).appendChild(document.createElement('i'));
    },
    sizePad() {
      const c = this.pad, dpr = Math.min(window.devicePixelRatio || 1, 2);
      const size = Math.round(c.clientWidth * dpr);
      if (!size || size === this.size) return;
      const old = this.hasInk ? this.ctx.getImageData(0, 0, c.width, c.height) : null;
      this.size = size; c.width = size; c.height = size;
      this.ctx.fillStyle = '#000'; this.ctx.fillRect(0, 0, size, size);
      if (old) this.clear();
    },
    _pos(e) { const r = this.pad.getBoundingClientRect(); return [(e.clientX - r.left) / r.width * this.size, (e.clientY - r.top) / r.height * this.size]; },
    _down(e) {
      e.preventDefault();
      this.pad.setPointerCapture && this.pad.setPointerCapture(e.pointerId);
      if (this.sampleShown) this.clear();
      this.drawing = true; this.last = this._pos(e);
      this._dot(this.last);
      $('draw-hint').hidden = true;
    },
    _move(e) {
      if (!this.drawing) return;
      const p = this._pos(e), ctx = this.ctx;
      ctx.strokeStyle = '#fff'; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.lineWidth = this.size * 0.085;
      ctx.beginPath(); ctx.moveTo(this.last[0], this.last[1]); ctx.lineTo(p[0], p[1]); ctx.stroke();
      this.last = p; this.hasInk = true;
      const t = now();
      if (!this.lastRead || t - this.lastRead > 90) { this.lastRead = t; this.read(); }
    },
    _up() { if (!this.drawing) return; this.drawing = false; this.read(); },
    _dot(p) {
      const ctx = this.ctx;
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(p[0], p[1], this.size * 0.0425, 0, Math.PI * 2); ctx.fill();
      this.hasInk = true;
    },
    clear() {
      this.ctx.fillStyle = '#000'; this.ctx.fillRect(0, 0, this.size, this.size);
      this.hasInk = false; this.pixels = null; this.sampleShown = false;
      $('draw-hint').hidden = false;
      $('draw-status').textContent = '';
      this._show(null);
    },
    setData(d) { this.data = d; },
    async sample() {
      let d = this.data;
      if (!d) { $('draw-status').textContent = 'loading digits…'; try { d = await loadDigits(); this.data = d; } catch (e) { $('draw-status').textContent = e.message; return; } }
      const i = Math.floor(Math.random() * d.test.count);
      const px = d.test.images.subarray(i * 784, i * 784 + 784);
      const img = this.ctx.createImageData(28, 28);
      for (let k = 0; k < 784; k++) { img.data[k * 4] = img.data[k * 4 + 1] = img.data[k * 4 + 2] = px[k]; img.data[k * 4 + 3] = 255; }
      const tmp = document.createElement('canvas'); tmp.width = 28; tmp.height = 28; tmp.getContext('2d').putImageData(img, 0, 0);
      this.ctx.imageSmoothingEnabled = false;
      this.ctx.drawImage(tmp, 0, 0, this.size, this.size);
      this.ctx.imageSmoothingEnabled = true;
      this.hasInk = true; this.sampleShown = true;
      $('draw-hint').hidden = true;
      $('draw-status').textContent = 'test digit #' + i + ', labelled ' + d.test.labels[i];
      this.pixels = new Uint8Array(px);
      this._show(this.pixels);
    },
    // MNIST-style: fit the ink into 20x20, centre its mass in 28x28.
    read() {
      if (!this.hasInk) return;
      const S = this.size, src = this.ctx.getImageData(0, 0, S, S).data;
      let x0 = S, y0 = S, x1 = -1, y1 = -1;
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if (src[(y * S + x) * 4] > 40) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      if (x1 < 0) return;
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1, sc = 20 / Math.max(bw, bh);
      const tw = Math.max(1, Math.round(bw * sc)), th = Math.max(1, Math.round(bh * sc));
      const tmp = document.createElement('canvas'); tmp.width = tw; tmp.height = th;
      const tc = tmp.getContext('2d');
      tc.imageSmoothingEnabled = true; tc.imageSmoothingQuality = 'high';
      // downscale in halving steps for clean antialiasing
      let srcCanvas = this.pad, sx = x0, sy = y0, sw = bw, sh = bh;
      while (sw / 2 > tw * 1.5) {
        const half = document.createElement('canvas'); half.width = Math.ceil(sw / 2); half.height = Math.ceil(sh / 2);
        const hc = half.getContext('2d'); hc.imageSmoothingEnabled = true; hc.imageSmoothingQuality = 'high';
        hc.drawImage(srcCanvas, sx, sy, sw, sh, 0, 0, half.width, half.height);
        srcCanvas = half; sx = 0; sy = 0; sw = half.width; sh = half.height;
      }
      tc.drawImage(srcCanvas, sx, sy, sw, sh, 0, 0, tw, th);
      const small = tc.getImageData(0, 0, tw, th).data;
      let mx = 0, my = 0, mass = 0;
      for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) { const v = small[(y * tw + x) * 4]; mass += v; mx += x * v; my += y * v; }
      if (!mass) return;
      const ox = Math.round(14 - mx / mass), oy = Math.round(14 - my / mass);
      const px = new Uint8Array(784);
      for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
        const X = x + ox, Y = y + oy;
        if (X >= 0 && X < 28 && Y >= 0 && Y < 28) px[Y * 28 + X] = small[(y * tw + x) * 4];
      }
      this.pixels = px;
      this._show(px);
    },
    refresh() { if (this.pixels) this._show(this.pixels); },
    _bars(id, probs) {
      const bars = $(id).children;
      for (let i = 0; i < 10; i++) bars[i].style.height = (probs ? Math.max(2, probs[i] * 100) : 2) + '%';
    },
    _show(px) {
      const P = palette();
      const ictx = this.inset.getContext('2d');
      ictx.clearRect(0, 0, 28, 28);
      if (!px) {
        $('v-rb').textContent = '–'; $('v-fe').textContent = '–'; $('v-cnn').textContent = '–';
        $('s-rb').textContent = '–'; $('s-fe').textContent = '–'; $('s-cnn').textContent = '–';
        for (const id of ['v-rb', 'v-fe', 'v-cnn']) $(id).classList.add('empty');
        $('v-rb-why').textContent = 'Waiting for a digit.';
        $('v-fe-why').textContent = ''; $('v-cnn-why').textContent = '';
        this._bars('v-fe-bars', null); this._bars('v-cnn-bars', null);
        return;
      }
      for (const id of ['v-rb', 'v-fe', 'v-cnn']) $(id).classList.remove('empty');
      // what the rulebook sees: the digit, and its skeleton in amber
      const img = ictx.createImageData(28, 28);
      const sk = BL.rulebook && BL.rulebook.skeleton ? BL.rulebook.skeleton(px) : null;
      const amber = P.knowledge.replace('#', '');
      const ar = parseInt(amber.slice(0, 2), 16), ag = parseInt(amber.slice(2, 4), 16), ab = parseInt(amber.slice(4, 6), 16);
      for (let k = 0; k < 784; k++) {
        const v = Math.round(px[k] * 0.55);
        if (sk && sk[k]) { img.data[k * 4] = ar; img.data[k * 4 + 1] = ag; img.data[k * 4 + 2] = ab; }
        else { img.data[k * 4] = v; img.data[k * 4 + 1] = v; img.data[k * 4 + 2] = v; }
        img.data[k * 4 + 3] = 255;
      }
      ictx.putImageData(img, 0, 0);
      // Rulebook
      if (BL.rulebook) {
        try {
          const r = BL.rulebook.classify(px);
          $('v-rb').textContent = String(r.digit);
          $('s-rb').textContent = String(r.digit);
          const why = $('v-rb-why');
          why.innerHTML = '';
          for (const line of (r.trace || []).slice(0, 5)) { const d = document.createElement('div'); d.textContent = line; why.appendChild(d); }
        } catch (e) { $('v-rb').textContent = '?'; console.error(e); }
      } else { $('v-rb').textContent = '–'; $('v-rb-why').textContent = 'Rulebook unavailable.'; }
      // Feature Engineer
      if (race.feW) {
        const F = BL.digits.HOG.size, feat = new Float32Array(F);
        BL.digits.hogFeatures(px, feat);
        const z = new Float32Array(10);
        for (let k = 0; k < 10; k++) { let s = race.feB[k]; for (let i = 0; i < F; i++) s += race.feW[k * F + i] * feat[i]; z[k] = s; }
        BL.digits.softmaxInPlace(z, 10);
        let b = 0; for (let k = 1; k < 10; k++) if (z[k] > z[b]) b = k;
        $('v-fe').textContent = String(b);
        $('s-fe').textContent = String(b);
        this._bars('v-fe-bars', z);
        $('v-fe-why').textContent = pct(z[b]) + ' sure' + (race.feDone ? '' : ' · still training');
      } else {
        $('v-fe').textContent = '?'; $('s-fe').textContent = '?'; this._bars('v-fe-bars', null);
        $('v-fe-why').textContent = 'Untrained. Its classifier learns in Experiment 3.';
      }
      // Learner
      const z = race.net.predict(px);
      let b = 0; for (let k = 1; k < 10; k++) if (z[k] > z[b]) b = k;
      $('v-cnn').textContent = String(b);
      $('s-cnn').textContent = String(b);
      this._bars('v-cnn-bars', z);
      $('v-cnn-why').textContent = race.seen ? pct(z[b]) + ' sure · trained on ' + fmtInt(race.seen) + ' examples' : 'Untrained: random weights. It learns in Experiment 3.';
    },
  };

  // ================================================================ diary
  const diary = {
    init() {
      fetch('assets/data/rulebook-diary.json').then((r) => (r.ok ? r.json() : null)).then((d) => {
        if (!d || !d.entries || !d.entries.length) { this._hide(); return; }
        this.d = d;
        this.hover = null;
        this.chart = { dirty: true, draw: () => this._draw() };
        const box = $('diary-chart');
        this.chart.surface = new Surface(box.querySelector('canvas'), this.chart);
        const E = d.entries, first = E[0], last = E[E.length - 1];
        const mins = Math.round(last.minutes - first.minutes);
        const cap = $('diary-cap');
        cap.innerHTML = '';
        const s = document.createElement('strong'); s.textContent = 'Knowledge engineering, measured. ';
        cap.appendChild(s);
        cap.appendChild(document.createTextNode(E.length + ' revisions in ' + mins + ' minutes. Accuracy after each one on development digits, which come from the training set; ' +
          'its score on the test digits appears in the training race above.'));
        const tip = document.createElement('div');
        tip.className = 'tip'; tip.hidden = true;
        box.appendChild(tip);
        this.tip = tip;
        const canvas = box.querySelector('canvas');
        const pick = (ev) => {
          if (!this._A) return;
          const rect = canvas.getBoundingClientRect();
          const px = ev.clientX - rect.left;
          let best = null, bd = 1e9;
          for (const e of E) { const dx = Math.abs(this._A.tx((e.minutes - E[0].minutes)) - px); if (dx < bd) { bd = dx; best = e; } }
          if (bd > 24) best = null;
          if (best !== this.hover) { this.hover = best; invalidate(this.chart); }
          if (!best) { tip.hidden = true; return; }
          tip.innerHTML = '<b></b> <span class="mono"></span><br><span></span>';
          tip.children[0].textContent = best.v;
          tip.children[1].textContent = best.acc.toFixed(1) + '% · ' + best.time + ' UTC';
          tip.children[3].textContent = best.note;
          tip.hidden = false;
          const x = this._A.tx(best.minutes - E[0].minutes), y = this._A.ty(best.acc);
          const tw = tip.offsetWidth, th = tip.offsetHeight;
          tip.style.left = clamp(x - tw / 2, 4, rect.width - tw - 4) + 'px';
          tip.style.top = (y - th - 14 > 4 ? y - th - 14 : y + 14) + 'px';
        };
        canvas.addEventListener('pointermove', pick);
        canvas.addEventListener('pointerdown', pick);
        canvas.addEventListener('pointerleave', () => { this.hover = null; tip.hidden = true; invalidate(this.chart); });
        invalidate(this.chart);
      }).catch(() => this._hide());
    },
    _hide() { $('diary-fig').hidden = true; $('diary-intro').hidden = true; $('diary-after').hidden = true; },
    _draw() {
      const S = this.chart.surface, ctx = S.fit(), w = S.w, h = S.h, P = palette();
      const E = this.d.entries;
      const t0 = E[0].minutes, span = Math.max(1, E[E.length - 1].minutes - t0);
      const small = w < 520;
      const A = new Axes(w, h, { l: small ? 38 : 48, r: 16, t: 28, b: 40 }, { min: 0, max: span }, { min: 50, max: 100 });
      this._A = A;
      const xt = [];
      const step = span > 60 ? 15 : span > 25 ? 10 : 5;
      for (let v = 0; v <= span + 1e-9; v += step) xt.push({ v, label: v + ' min' });
      const yt = [];
      for (let v = 50; v <= 100; v += 10) yt.push({ v, label: v + '%' });
      A.grid(ctx, xt, yt);
      A.titles(ctx, 'minutes of knowledge engineering →', 'Rulebook accuracy on development digits', { yIndent: small ? 38 : 48, xOff: 36 });
      // the Learner, for scale
      if (race.cnn.length && race.done) {
        const acc = 100 * (1 - race.cnn[race.cnn.length - 1].rate);
        const y = A.ty(acc);
        ctx.save(); ctx.setLineDash([4, 4]); ctx.strokeStyle = P.compute; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(A.l, y); ctx.lineTo(A.r, y); ctx.stroke(); ctx.restore();
        label(ctx, 'the Learner after ' + fmtTime(race.trainMs) + ' of training: ' + acc.toFixed(1) + '% on test digits', A.r - 4, y - 10, { align: 'right', font: FONT.sans(small ? 11 : 12, 600), color: P.computeInk });
      }
      ctx.save();
      ctx.strokeStyle = P.knowledge; ctx.lineWidth = 2.5; ctx.lineJoin = 'round';
      ctx.beginPath();
      let best = -1;
      E.forEach((e, i) => {
        const x = A.tx(e.minutes - t0), y = A.ty(Math.max(best, e.acc));
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        best = Math.max(best, e.acc);
      });
      ctx.stroke();
      ctx.restore();
      // every attempt, including the ones that made things worse
      let run = -1;
      for (const e of E) {
        const worse = e.acc < run;
        run = Math.max(run, e.acc);
        const x = A.tx(e.minutes - t0), y = A.ty(e.acc);
        ctx.beginPath(); ctx.arc(x, y, this.hover === e ? 5 : 3.4, 0, Math.PI * 2);
        if (worse) { ctx.fillStyle = P.panel; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = P.knowledge; ctx.stroke(); }
        else { ctx.fillStyle = P.knowledge; ctx.fill(); }
      }
      const top = E.reduce((a, e) => (e.acc > a.acc ? e : a));
      label(ctx, top.acc.toFixed(1) + '%', A.tx(top.minutes - t0), A.ty(top.acc) - 13, { align: 'center', font: FONT.mono(11.5, 500), color: P.knowledgeInk });
      label(ctx, 'hollow points: revisions that made it worse', A.l + 8, A.b - 12, { font: FONT.sans(small ? 10.5 : 11.5), color: P.ink3 });
    },
  };

  // ================================================================ III. variants
  const VARIANTS = [
    { name: 'Connect Four', desc: 'The Expert\'s home ground. 7 × 6, four in a row.', rules: {} },
    { name: 'Misère', desc: 'Same board, same pieces. Making four in a row loses.', rules: { misere: true } },
    { name: 'Cylinder', desc: 'The left edge touches the right, so lines wrap around. There is no centre.', rules: { wrap: true } },
    { name: 'Five in a row', desc: 'A 9 × 7 board; lines must be five long.', rules: { w: 9, h: 7, k: 5 } },
    { name: 'No gravity', desc: 'Pieces stay wherever you put them, like noughts and crosses.', rules: { gravity: false } },
  ];
  const VARY_SIMS = 1024, VARY_OPENINGS = 12;

  const vary = {
    running: false, results: [],
    init() {
      const list = $('vary-list');
      VARIANTS.forEach((v) => {
        const el = document.createElement('div');
        el.className = 'panel variant';
        el.innerHTML = '<div><div class="name"></div><div class="desc"></div></div><div class="rows"></div>';
        el.querySelector('.name').textContent = v.name;
        el.querySelector('.desc').textContent = v.desc;
        v.el = el;
        v.rows = el.querySelector('.rows');
        this._resetRows(v);
        list.appendChild(el);
      });
      $('vary-run').addEventListener('click', () => (this.running ? this.stop() : this.start()));
      whenSeen($('vary'), () => { if (!this.running && !this.started) this.start(); }, 0.3);
    },
    _resetRows(v) {
      v.rows.innerHTML = '';
      v.bars = [];
      if (v.rules.gravity === false) {
        v.rows.innerHTML = '<div class="vrow"><div class="na">The Expert can\'t play this: its code assumes pieces fall. Someone would have to write a new Expert.</div><div class="scoretxt">no match</div></div>';
        return;
      }
      this._addRow(v, null);
    },
    _addRow(v, sims) {
      if (sims) {
        const lab = document.createElement('div');
        lab.className = 'boostlab';
        lab.textContent = 'Not enough? Four times the imagination: ' + fmtInt(sims) + ' per move.';
        v.rows.appendChild(lab);
      }
      const row = document.createElement('div');
      row.className = 'vrow';
      row.innerHTML = '<div class="scorebar"><div class="s" style="width:0%"></div><div class="e" style="width:0%"></div><div class="mid"></div></div><div class="scoretxt">–</div>';
      v.rows.appendChild(row);
      v.bars.push(row);
    },
    // One match: 24 games over 12 random openings. If the Searcher loses it,
    // its answer is the general method's answer: more computation.
    _match(vi, sims, rng, depth) {
      const v = VARIANTS[vi];
      const rules = BL.normalizeRules(Object.assign({}, BL.STANDARD_RULES, v.rules));
      const R = { sims, score: 0, n: 0, planned: VARY_OPENINGS * 2 };
      this.results[vi].push(R);
      const row = depth;
      for (let o = 0; o < VARY_OPENINGS; o++) {
        const g = new BL.Game(rules), opening = [];
        for (let k = 0; k < 2; k++) { const m = g.moves[rng() % g.nMoves]; g.play(m); opening.push(m); }
        for (const first of [true, false]) {
          this.outstanding++;
          this.pool.run({ type: 'c4Game', rules, sims, mctsFirst: first, seed: rng(), opening, c: 0.5 }, (m) => {
            if (m.type === 'work') meter.add(m.positions, 0);
          }).then((m) => {
            this.outstanding--;
            if (m.type === 'done') {
              meter.add(m.positions, 0);
              R.score += m.score; R.n++;
              this._paintRow(v.bars[row], R);
              if (R.n === R.planned && R.score / R.n < 0.5 && depth < 2 && this.running) {
                this._addRow(v, sims * 4);
                this._match(vi, sims * 4, rng, depth + 1);
              }
              this._status();
            }
            if (this.outstanding === 0) this._finish();
          });
        }
      }
    },
    start() {
      this.started = true;
      this.running = true;
      $('vary-run').textContent = 'Stop';
      $('vary-result').textContent = '';
      this.results = VARIANTS.map(() => []);
      VARIANTS.forEach((v) => this._resetRows(v));
      this.pool = new Pool(WORKERS);
      this.outstanding = 0;
      const rng = BL.makeRng((Math.random() * 4e9) >>> 0);
      VARIANTS.forEach((v, vi) => { if (v.rules.gravity !== false) this._match(vi, VARY_SIMS, rng, 0); });
      this._status();
    },
    stop() { this._finish(true); },
    _finish(stopped) {
      if (!this.running) return;
      this.running = false;
      if (this.pool) { this.pool.terminate(); this.pool = null; }
      $('vary-run').textContent = 'Play them again';
      $('vary-status').textContent = stopped ? 'stopped' : 'finished';
      const R = this.results;
      const f = (r) => (r && r.n ? pct(r.score / r.n) : '–');
      if (stopped || !R[0].length || !R[1].length) return;
      let txt = 'At ' + fmtInt(VARY_SIMS) + ' imagined games per move the Searcher scored ' + f(R[0][0]) + ' at home. With one rule flipped (misère) it scored ' + f(R[1][0]) + ', with the same code and the same budget. On the cylinder, ' + f(R[2][0]) + '.';
      const k5 = R[3];
      if (k5.length > 1) {
        const last = k5[k5.length - 1];
        txt += ' On the bigger board, five in a row, ' + fmtInt(VARY_SIMS) + ' was not enough (' + f(k5[0]) + '). ' +
          k5.slice(1).map((r) => 'At ' + fmtInt(r.sims) + ' it scored ' + f(r)).join('; ') + '.';
        txt += last.score / last.n >= 0.5 ? ' Nobody had to rewrite anything.' : ' It needs still more computation on this board, but nobody has to rewrite anything to give it that.';
      } else if (k5.length) txt += ' Five in a row on the bigger board: ' + f(k5[0]) + '.';
      $('vary-result').textContent = txt;
    },
    _paintRow(row, R) {
      const s = R.n ? R.score / R.n : 0;
      row.querySelector('.s').style.width = (R.n ? s * 100 : 0) + '%';
      row.querySelector('.e').style.width = (R.n ? (1 - s) * 100 : 0) + '%';
      row.querySelector('.scoretxt').textContent = R.n ? pct(s) + ' · ' + R.n + '/' + R.planned : '–';
    },
    _status() {
      let n = 0, p = 0;
      for (const list of this.results) for (const r of list) { n += r.n; p += r.planned; }
      if (this.running) $('vary-status').textContent = n + ' of ' + p + ' games';
    },
  };

  // ================================================================ III. inventor
  const inventor = {
    init() {
      const ids = ['w', 'h', 'k', 'sims'];
      this.searcherFirst = false;
      for (const id of ids) $('inv-' + id).addEventListener('input', () => this._sync());
      for (const id of ['gravity', 'misere', 'wrap']) $('inv-' + id).addEventListener('change', () => this._sync());
      $('inv-play').addEventListener('click', () => this.play());
      $('inv-first').addEventListener('click', () => {
        this.searcherFirst = !this.searcherFirst;
        $('inv-first').textContent = this.searcherFirst ? 'You move first' : 'Searcher moves first';
        this.play();
      });
      this.board = new PlayBoard({
        canvas: $('inv-board'), say: $('inv-say'), humanFirst: true,
        getSims: () => 1 << +$('inv-sims').value,
        onEnd: (o) => {
          const rules = this.rules;
          const msg = o === 'win' ? '<b>You win.</b> Raise its imagination and try again.' : o === 'loss' ? '<b>It wins.</b> A game nobody had played until a minute ago, and no strategy written for it.' : '<b>A draw.</b>';
          this.board._say(msg + '<small>' + this._describe(rules) + ' · ' + fmtInt(1 << +$('inv-sims').value) + ' imagined games per move</small>');
        },
      });
      this._sync(true);
    },
    _rules() {
      return BL.normalizeRules({
        w: +$('inv-w').value, h: +$('inv-h').value, k: +$('inv-k').value,
        gravity: $('inv-gravity').checked, misere: $('inv-misere').checked, wrap: $('inv-wrap').checked,
      });
    },
    _describe(r) {
      return r.w + ' × ' + r.h + ', ' + r.k + ' in a row' + (r.misere ? ' loses' : ' wins') + (r.gravity ? '' : ', no gravity') + (r.wrap ? ', wrapping' : '');
    },
    _sync(initial) {
      const w = +$('inv-w').value, h = +$('inv-h').value;
      $('inv-k').max = String(Math.max(w, h));
      if (+$('inv-k').value > Math.max(w, h)) $('inv-k').value = String(Math.max(w, h));
      $('inv-w-o').textContent = $('inv-w').value;
      $('inv-h-o').textContent = $('inv-h').value;
      $('inv-k-o').textContent = $('inv-k').value;
      const sims = 1 << +$('inv-sims').value;
      $('inv-sims-o').textContent = fmtSims(sims);
      const k = +$('inv-k').value;
      $('inv-wrap').disabled = w < k;
      if (w < k) $('inv-wrap').checked = false;
      this.rules = this._rules();
      $('inv-status').textContent = this._describe(this.rules);
      if (initial || !this.board.history.length || this.board.over) {
        this.board.humanFirst = !this.searcherFirst;
        this.board.setRules(this.rules);
        this.board._say('Rules set: ' + this._describe(this.rules) + '. ' + (this.searcherFirst ? 'The Searcher moves first.' : 'Your move.'));
      }
    },
    play() {
      this.rules = this._rules();
      this.board.humanFirst = !this.searcherFirst;
      this.board.setRules(this.rules);
      if (!this.searcherFirst) this.board._say('A new game: ' + this._describe(this.rules) + '. Your move.');
    },
  };

  // ================================================================ coda
  const multiples = {
    init() {
      this.tour = { dirty: true, draw: (t) => { const ctx = this.tour.surface.fit(); drawTourChart(ctx, this.tour.surface.w, this.tour.surface.h, tour, t, true); } };
      this.tour.surface = new Surface($('mult-tour').querySelector('canvas'), this.tour);
      this.race = { dirty: true, draw: (t) => drawRaceChart(this.race.surface, race, t, true) };
      this.race.surface = new Surface($('mult-race').querySelector('canvas'), this.race);
      this.you = { dirty: true, draw: () => this._drawYou() };
      this.you.surface = new Surface($('mult-you').querySelector('canvas'), this.you);
    },
    update() {
      if (!this.tour) return;
      invalidate(this.tour); invalidate(this.race); invalidate(this.you);
      if (diary.chart) invalidate(diary.chart);
      const x = tour.computeCrossover();
      if (tour.games) {
        const top = tour.levels.filter((L) => L.n > 0).pop();
        $('mult-tour-p').textContent = (x ? 'Crossover at ≈' + fmtInt(sig2(x.sims)) + ' imagined games per move. ' : '') + 'Searcher at ' + fmtInt(top.sims) + ': ' + pct(tour.rate(top)) + '.';
      }
      const rec = play.record;
      const played = rec.some((r) => r.w + r.l + r.d > 0);
      if (played) {
        const won = rec.map((r, i) => (r.w ? i : -1)).filter((i) => i >= 0);
        const lost = rec.map((r, i) => (r.l ? i : -1)).filter((i) => i >= 0);
        const parts = [];
        if (won.length) parts.push('You beat it at up to ' + fmtInt(LADDER[Math.max(...won)]) + ' imagined games per move.');
        if (lost.length) parts.push('It beat you at ' + fmtInt(LADDER[Math.min(...lost.filter((i) => !won.length || i > Math.min(...won)).concat(lost))]) + '.');
        $('mult-you-p').textContent = parts.join(' ');
      }
      const xs = race.crossings();
      if (race.cnn.length > 1) {
        const parts = [];
        if (xs.rulebook) parts.push('Passed the Rulebook at ' + fmtSci(xs.rulebook) + ' FLOP.');
        if (xs.fe) parts.push('Passed the Feature Engineer at ' + fmtSci(xs.fe) + '.');
        if (!parts.length) parts.push('Training…');
        $('mult-race-p').textContent = parts.join(' ');
      }
    },
    _drawYou() {
      const S = this.you.surface, ctx = S.fit(), w = S.w, h = S.h, P = palette();
      const A = new Axes(w, h, { l: 30, r: 8, t: 14, b: 22 }, { min: 16, max: 262144, log: true }, { min: 0, max: 1 });
      A.grid(ctx, LADDER.map((s, i) => ({ v: s, label: i % 2 === 0 ? fmtSims(s) : null })), [0, 0.5, 1].map((v) => ({ v, label: Math.round(v * 100) + '%', strong: v === 0.5 })), { fontPx: 9 });
      const rec = play.record;
      const pts = [];
      rec.forEach((r, i) => { const n = r.w + r.l + r.d; if (n) pts.push({ s: LADDER[i], you: (r.w + 0.5 * r.d) / n }); });
      if (!pts.length) { label(ctx, 'no games yet', (A.l + A.r) / 2, (A.t + A.b) / 2, { align: 'center', color: P.ink3, font: FONT.sans(12) }); return; }
      for (const [color, f] of [[P.knowledge, (q) => q.you], [P.compute, (q) => 1 - q.you]]) {
        ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
        pts.forEach((q, i) => { const x = A.tx(q.s), y = A.ty(f(q)); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
        ctx.stroke();
        for (const q of pts) { ctx.beginPath(); ctx.arc(A.tx(q.s), A.ty(f(q)), 2.8, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill(); }
        ctx.restore();
      }
      label(ctx, 'you', A.l + 6, A.t + 8, { color: P.knowledgeInk, font: FONT.sans(10.5, 600) });
    },
  };

  // ================================================================ boot
  function boot() {
    tour.init();
    play.init();
    race.init();
    draw.init();
    diary.init();
    vary.init();
    inventor.init();
    multiples.init();
    meter.paint(true);
    invalidate();
    window.__bl = { tour, race, play, vary, inventor, meter, scale, draw };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
