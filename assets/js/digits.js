/*
 * digits.js: two ways to learn to read handwritten digits.
 *
 *   The Feature Engineer: edge-orientation histograms (HOG, Dalal & Triggs
 *   2005), a human design for what matters in an image, followed by a learned
 *   linear classifier.
 *
 *   The Learner: a small convolutional network that learns everything from
 *   raw pixels.
 *
 * Every floating-point operation spent on training is counted, so the two can
 * be compared at equal compute. Runs in a worker, the window, or Node.
 */
(function (root) {
  'use strict';
  const BL = root.BL || (root.BL = {});

  // ---------------------------------------------------------------- data
  // Packed format: 'BLD1', uint32 count, rows, cols, labels[count], pixels.
  function parseDigits(buffer) {
    const bytes = new Uint8Array(buffer);
    const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    if (magic !== 'BLD1') throw new Error('Unrecognised digit data');
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = dv.getUint32(4, true), rows = dv.getUint32(8, true), cols = dv.getUint32(12, true);
    const labels = bytes.slice(16, 16 + count);
    const images = bytes.slice(16 + count, 16 + count + count * rows * cols);
    return { count, rows, cols, labels, images };
  }

  // Seeded float RNG in [0, 1) and a normal sampler for initialisation.
  function makeFloatRng(seed) {
    const next = BL.makeRng ? BL.makeRng(seed) : (function () {
      let s = seed >>> 0 || 1;
      return function () { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s; };
    })();
    const f = () => next() / 4294967296;
    f.normal = () => {
      let u = 0, v = 0;
      while (u === 0) u = f();
      v = f();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    f.int = (n) => next() % n;
    return f;
  }

  // ---------------------------------------------------------------- HOG
  // 28x28 image -> gradients -> 9 unsigned orientation bins per 4x4 cell (7x7
  // cells) -> 2x2-cell blocks, L2-Hys normalised -> 6*6*36 = 1296 features.
  const HOG = { cell: 4, bins: 9, cells: 7, blocks: 6 };
  HOG.size = HOG.blocks * HOG.blocks * 4 * HOG.bins;
  // Approximate cost per image: gradient, magnitude, angle and vote per pixel,
  // plus block normalisation. Counted generously.
  HOG.flops = 784 * 30 + HOG.size * 6;

  const hogScratch = new Float32Array(HOG.cells * HOG.cells * HOG.bins);
  function hogFeatures(img, out) {
    const hist = hogScratch;
    hist.fill(0);
    const C = HOG.cell, B = HOG.bins, NC = HOG.cells;
    for (let y = 0; y < 28; y++) {
      for (let x = 0; x < 28; x++) {
        const l = x > 0 ? img[y * 28 + x - 1] : 0, r = x < 27 ? img[y * 28 + x + 1] : 0;
        const u = y > 0 ? img[(y - 1) * 28 + x] : 0, d = y < 27 ? img[(y + 1) * 28 + x] : 0;
        const gx = (r - l) / 255, gy = (d - u) / 255;
        const mag = Math.sqrt(gx * gx + gy * gy);
        if (mag === 0) continue;
        let ang = Math.atan2(gy, gx);
        if (ang < 0) ang += Math.PI;               // unsigned orientation
        let bf = ang / Math.PI * B - 0.5;           // bin centres at (i + 0.5) * 20 degrees
        let b0 = Math.floor(bf); const t = bf - b0;
        let b1 = b0 + 1;
        if (b0 < 0) b0 += B;
        if (b1 >= B) b1 -= B;
        const cell = ((y / C) | 0) * NC + ((x / C) | 0);
        hist[cell * B + b0] += mag * (1 - t);
        hist[cell * B + b1] += mag * t;
      }
    }
    let o = 0;
    for (let by = 0; by < HOG.blocks; by++) {
      for (let bx = 0; bx < HOG.blocks; bx++) {
        const start = o;
        let ss = 1e-6;
        for (let cy = 0; cy < 2; cy++) for (let cx = 0; cx < 2; cx++) {
          const base = ((by + cy) * NC + bx + cx) * B;
          for (let b = 0; b < B; b++) { const v = hist[base + b]; out[o++] = v; ss += v * v; }
        }
        // L2-Hys: normalise, clip at 0.2, renormalise
        let inv = 1 / Math.sqrt(ss), ss2 = 1e-6;
        for (let i = start; i < o; i++) { let v = out[i] * inv; if (v > 0.2) v = 0.2; out[i] = v; ss2 += v * v; }
        inv = 1 / Math.sqrt(ss2);
        for (let i = start; i < o; i++) out[i] *= inv;
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- softmax
  function softmaxInPlace(z, n) {
    let m = -Infinity;
    for (let i = 0; i < n; i++) if (z[i] > m) m = z[i];
    let s = 0;
    for (let i = 0; i < n; i++) { z[i] = Math.exp(z[i] - m); s += z[i]; }
    for (let i = 0; i < n; i++) z[i] /= s;
  }

  // Adam for one flat parameter array.
  class Adam {
    constructor(n, lr) {
      this.m = new Float32Array(n); this.v = new Float32Array(n);
      this.lr = lr; this.t = 0; this.b1 = 0.9; this.b2 = 0.999; this.eps = 1e-8;
    }
    step(w, g, scale) {
      this.t++;
      const { m, v, b1, b2, eps } = this;
      const lr = this.lr * Math.sqrt(1 - Math.pow(b2, this.t)) / (1 - Math.pow(b1, this.t));
      for (let i = 0; i < w.length; i++) {
        const gi = g[i] * scale;
        m[i] = b1 * m[i] + (1 - b1) * gi;
        v[i] = b2 * v[i] + (1 - b2) * gi * gi;
        w[i] -= lr * m[i] / (Math.sqrt(v[i]) + eps);
        g[i] = 0;
      }
    }
  }

  // ---------------------------------------------------------------- linear
  // Multinomial logistic regression on a feature vector.
  class LinearClassifier {
    constructor(nIn, opts) {
      opts = opts || {};
      this.nIn = nIn; this.nOut = 10;
      this.W = new Float32Array(nIn * 10);
      this.b = new Float32Array(10);
      this.gW = new Float32Array(nIn * 10);
      this.gb = new Float32Array(10);
      this.optW = new Adam(this.W.length, opts.lr || 0.003);
      this.optB = new Adam(10, opts.lr || 0.003);
      this.z = new Float32Array(10);
      this.batch = opts.batch || 32;
      this.inBatch = 0;
      // forward 2*n*10, backward (weight gradient) 2*n*10, plus the update
      this.flopsPerExample = 4 * nIn * 10 + 40;
    }
    logits(x) {
      const { W, b, z, nIn } = this;
      for (let k = 0; k < 10; k++) {
        let s = b[k];
        const o = k * nIn;
        for (let i = 0; i < nIn; i++) s += W[o + i] * x[i];
        z[k] = s;
      }
      return z;
    }
    predict(x) {
      const z = this.logits(x);
      softmaxInPlace(z, 10);
      return z;
    }
    // One example; parameters update once per minibatch. Returns the loss.
    train(x, y) {
      const p = this.predict(x), { gW, gb, nIn } = this;
      const loss = -Math.log(Math.max(p[y], 1e-12));
      for (let k = 0; k < 10; k++) {
        const d = p[k] - (k === y ? 1 : 0);
        if (d === 0) continue;
        gb[k] += d;
        const o = k * nIn;
        for (let i = 0; i < nIn; i++) gW[o + i] += d * x[i];
      }
      if (++this.inBatch === this.batch) this.flush();
      return loss;
    }
    flush() {
      if (!this.inBatch) return;
      const s = 1 / this.inBatch;
      this.optW.step(this.W, this.gW, s);
      this.optB.step(this.b, this.gb, s);
      this.inBatch = 0;
    }
  }

  // ---------------------------------------------------------------- convnet
  const PARAM_KEYS = ['w1', 'b1', 'w2', 'b2', 'w3', 'b3'];

  // 28x28 -> conv5x5 (F1) -> ReLU -> maxpool2 -> conv5x5 (F2) -> ReLU ->
  // maxpool2 -> fully connected -> 10.
  class ConvNet {
    constructor(opts) {
      opts = opts || {};
      const F1 = this.F1 = opts.f1 || 8;
      const F2 = this.F2 = opts.f2 || 16;
      const rng = makeFloatRng(opts.seed || 2012);
      this.K = 5;
      // shapes
      this.c1 = 24; this.p1 = 12; this.c2 = 8; this.p2 = 4;
      this.nFlat = F2 * this.p2 * this.p2;
      // parameters (He initialisation)
      this.w1 = new Float32Array(F1 * 25); this.b1 = new Float32Array(F1);
      this.w2 = new Float32Array(F2 * F1 * 25); this.b2 = new Float32Array(F2);
      this.w3 = new Float32Array(10 * this.nFlat); this.b3 = new Float32Array(10);
      const init = (w, fanIn) => { const s = Math.sqrt(2 / fanIn); for (let i = 0; i < w.length; i++) w[i] = rng.normal() * s; };
      init(this.w1, 25); init(this.w2, F1 * 25); init(this.w3, this.nFlat);
      for (let i = 0; i < this.w3.length; i++) this.w3[i] *= 0.5;
      // gradients
      this.g = {
        w1: new Float32Array(this.w1.length), b1: new Float32Array(F1),
        w2: new Float32Array(this.w2.length), b2: new Float32Array(F2),
        w3: new Float32Array(this.w3.length), b3: new Float32Array(10),
      };
      const lr = opts.lr || 0.002;
      this.opt = {
        w1: new Adam(this.w1.length, lr), b1: new Adam(F1, lr),
        w2: new Adam(this.w2.length, lr), b2: new Adam(F2, lr),
        w3: new Adam(this.w3.length, lr), b3: new Adam(10, lr),
      };
      // activations
      this.x = new Float32Array(784);
      this.a1 = new Float32Array(F1 * 576);      // conv1 + relu, 24x24
      this.q1 = new Float32Array(F1 * 144);      // pool1, 12x12
      this.i1 = new Int32Array(F1 * 144);        // argmax indices of pool1
      this.a2 = new Float32Array(F2 * 64);       // conv2 + relu, 8x8
      this.q2 = new Float32Array(F2 * 16);       // pool2, 4x4
      this.i2 = new Int32Array(F2 * 16);
      this.z = new Float32Array(10);
      // backward scratch
      this.dq2 = new Float32Array(F2 * 16);
      this.da2 = new Float32Array(F2 * 64);
      this.dq1 = new Float32Array(F1 * 144);
      this.da1 = new Float32Array(F1 * 576);
      this.batch = opts.batch || 16;
      this.inBatch = 0;
      // FLOPs, counting a multiply-add as two
      const fwd = 2 * 576 * F1 * 25 + 2 * 64 * F2 * F1 * 25 + 2 * this.nFlat * 10;
      const bwd = 2 * 576 * F1 * 25                       // conv1 weight gradient
        + 2 * (2 * 64 * F2 * F1 * 25)                       // conv2 weight + input gradients
        + 2 * (2 * this.nFlat * 10);                        // fc weight + input gradients
      this.flopsForward = fwd;
      this.flopsPerExample = fwd + bwd;
    }

    forward(img) {
      const { F1, F2, x, w1, b1, a1, q1, i1, w2, b2, a2, q2, i2, w3, b3, z, nFlat } = this;
      for (let i = 0; i < 784; i++) x[i] = img[i] / 255;
      // conv1 (valid) + relu
      for (let f = 0; f < F1; f++) {
        const wo = f * 25, ao = f * 576, bias = b1[f];
        for (let y = 0; y < 24; y++) {
          for (let xx = 0; xx < 24; xx++) {
            let s = bias;
            for (let ky = 0; ky < 5; ky++) {
              const xo = (y + ky) * 28 + xx, wk = wo + ky * 5;
              s += x[xo] * w1[wk] + x[xo + 1] * w1[wk + 1] + x[xo + 2] * w1[wk + 2] + x[xo + 3] * w1[wk + 3] + x[xo + 4] * w1[wk + 4];
            }
            a1[ao + y * 24 + xx] = s > 0 ? s : 0;
          }
        }
      }
      // pool1 2x2
      for (let f = 0; f < F1; f++) {
        for (let y = 0; y < 12; y++) for (let xx = 0; xx < 12; xx++) {
          const base = f * 576 + (2 * y) * 24 + 2 * xx;
          let bi = base, bv = a1[base];
          if (a1[base + 1] > bv) { bv = a1[base + 1]; bi = base + 1; }
          if (a1[base + 24] > bv) { bv = a1[base + 24]; bi = base + 24; }
          if (a1[base + 25] > bv) { bv = a1[base + 25]; bi = base + 25; }
          const o = f * 144 + y * 12 + xx;
          q1[o] = bv; i1[o] = bi;
        }
      }
      // conv2 + relu
      for (let f = 0; f < F2; f++) {
        const ao = f * 64;
        for (let p = 0; p < 64; p++) a2[ao + p] = b2[f];
        for (let c = 0; c < F1; c++) {
          const wo = (f * F1 + c) * 25, qo = c * 144;
          for (let y = 0; y < 8; y++) {
            for (let xx = 0; xx < 8; xx++) {
              let s = 0;
              for (let ky = 0; ky < 5; ky++) {
                const qi = qo + (y + ky) * 12 + xx, wk = wo + ky * 5;
                s += q1[qi] * w2[wk] + q1[qi + 1] * w2[wk + 1] + q1[qi + 2] * w2[wk + 2] + q1[qi + 3] * w2[wk + 3] + q1[qi + 4] * w2[wk + 4];
              }
              a2[ao + y * 8 + xx] += s;
            }
          }
        }
        for (let p = 0; p < 64; p++) if (a2[ao + p] < 0) a2[ao + p] = 0;
      }
      // pool2 2x2
      for (let f = 0; f < F2; f++) {
        for (let y = 0; y < 4; y++) for (let xx = 0; xx < 4; xx++) {
          const base = f * 64 + (2 * y) * 8 + 2 * xx;
          let bi = base, bv = a2[base];
          if (a2[base + 1] > bv) { bv = a2[base + 1]; bi = base + 1; }
          if (a2[base + 8] > bv) { bv = a2[base + 8]; bi = base + 8; }
          if (a2[base + 9] > bv) { bv = a2[base + 9]; bi = base + 9; }
          const o = f * 16 + y * 4 + xx;
          q2[o] = bv; i2[o] = bi;
        }
      }
      // fully connected
      for (let k = 0; k < 10; k++) {
        let s = b3[k];
        const o = k * nFlat;
        for (let i = 0; i < nFlat; i++) s += w3[o + i] * q2[i];
        z[k] = s;
      }
      return z;
    }

    predict(img) {
      const z = this.forward(img);
      softmaxInPlace(z, 10);
      return z;
    }

    // Forward + backward for one example; update once per minibatch.
    train(img, y) {
      const { F1, F2, x, a1, q1, i1, w2, a2, q2, i2, w3, z, nFlat, g, dq2, da2, dq1, da1 } = this;
      this.forward(img);
      softmaxInPlace(z, 10);
      const loss = -Math.log(Math.max(z[y], 1e-12));
      z[y] -= 1; // dL/dlogits
      // fc
      dq2.fill(0);
      for (let k = 0; k < 10; k++) {
        const d = z[k], o = k * nFlat;
        g.b3[k] += d;
        for (let i = 0; i < nFlat; i++) { g.w3[o + i] += d * q2[i]; dq2[i] += d * w3[o + i]; }
      }
      // pool2 -> relu2
      da2.fill(0);
      for (let i = 0; i < F2 * 16; i++) { const j = i2[i]; if (a2[j] > 0) da2[j] += dq2[i]; }
      // conv2: weight gradient and input gradient
      dq1.fill(0);
      for (let f = 0; f < F2; f++) {
        const ao = f * 64;
        let gb = 0;
        for (let p = 0; p < 64; p++) gb += da2[ao + p];
        g.b2[f] += gb;
        for (let c = 0; c < F1; c++) {
          const wo = (f * F1 + c) * 25, qo = c * 144;
          for (let y = 0; y < 8; y++) {
            for (let xx = 0; xx < 8; xx++) {
              const d = da2[ao + y * 8 + xx];
              if (d === 0) continue;
              for (let ky = 0; ky < 5; ky++) {
                const qi = qo + (y + ky) * 12 + xx, wk = wo + ky * 5;
                g.w2[wk] += d * q1[qi]; dq1[qi] += d * w2[wk];
                g.w2[wk + 1] += d * q1[qi + 1]; dq1[qi + 1] += d * w2[wk + 1];
                g.w2[wk + 2] += d * q1[qi + 2]; dq1[qi + 2] += d * w2[wk + 2];
                g.w2[wk + 3] += d * q1[qi + 3]; dq1[qi + 3] += d * w2[wk + 3];
                g.w2[wk + 4] += d * q1[qi + 4]; dq1[qi + 4] += d * w2[wk + 4];
              }
            }
          }
        }
      }
      // pool1 -> relu1
      da1.fill(0);
      for (let i = 0; i < F1 * 144; i++) { const j = i1[i]; if (a1[j] > 0) da1[j] += dq1[i]; }
      // conv1 weight gradient
      for (let f = 0; f < F1; f++) {
        const ao = f * 576, wo = f * 25;
        let gb = 0;
        for (let y = 0; y < 24; y++) {
          for (let xx = 0; xx < 24; xx++) {
            const d = da1[ao + y * 24 + xx];
            if (d === 0) continue;
            gb += d;
            for (let ky = 0; ky < 5; ky++) {
              const xo = (y + ky) * 28 + xx, wk = wo + ky * 5;
              g.w1[wk] += d * x[xo]; g.w1[wk + 1] += d * x[xo + 1]; g.w1[wk + 2] += d * x[xo + 2];
              g.w1[wk + 3] += d * x[xo + 3]; g.w1[wk + 4] += d * x[xo + 4];
            }
          }
        }
        g.b1[f] += gb;
      }
      if (++this.inBatch === this.batch) this.flush();
      return loss;
    }

    flush() {
      if (!this.inBatch) return;
      const s = 1 / this.inBatch, o = this.opt, g = this.g;
      o.w1.step(this.w1, g.w1, s); o.b1.step(this.b1, g.b1, s);
      o.w2.step(this.w2, g.w2, s); o.b2.step(this.b2, g.b2, s);
      o.w3.step(this.w3, g.w3, s); o.b3.step(this.b3, g.b3, s);
      this.inBatch = 0;
    }

    setLearningRate(lr) { for (const k in this.opt) this.opt[k].lr = lr; }

    // All parameters (or gradients) as one flat array, in a fixed order, for
    // shipping between threads.
    get paramCount() { let n = 0; for (const k of PARAM_KEYS) n += this[k].length; return n; }
    getParams(out) {
      out = out || new Float32Array(this.paramCount);
      let o = 0;
      for (const k of PARAM_KEYS) { out.set(this[k], o); o += this[k].length; }
      return out;
    }
    setParams(flat) {
      let o = 0;
      for (const k of PARAM_KEYS) { const a = this[k]; a.set(flat.subarray(o, o + a.length)); o += a.length; }
    }
    getGrads(out) {
      out = out || new Float32Array(this.paramCount);
      let o = 0;
      for (const k of PARAM_KEYS) { out.set(this.g[k], o); o += this.g[k].length; }
      return out;
    }
    addGrads(flat) {
      let o = 0;
      for (const k of PARAM_KEYS) {
        const g = this.g[k];
        for (let i = 0; i < g.length; i++) g[i] += flat[o + i];
        o += g.length;
      }
    }
    zeroGrads() { for (const k of PARAM_KEYS) this.g[k].fill(0); this.inBatch = 0; }
    // Apply the accumulated gradient of `count` examples as one step.
    step(count) { this.inBatch = count; this.flush(); }

    // First-layer filters, for drawing.
    filters() { return { count: this.F1, size: 5, data: this.w1.slice() }; }
  }

  // Copy a 28x28 image shifted by (dx, dy) pixels, filling with background.
  function shiftInto(src, dst, dx, dy) {
    for (let y = 0; y < 28; y++) {
      const sy = y - dy;
      for (let x = 0; x < 28; x++) {
        const sx = x - dx;
        dst[y * 28 + x] = (sx >= 0 && sx < 28 && sy >= 0 && sy < 28) ? src[sy * 28 + sx] : 0;
      }
    }
    return dst;
  }

  BL.digits = { parseDigits, makeFloatRng, HOG, hogFeatures, LinearClassifier, ConvNet, softmaxInPlace, shiftInto };
})(typeof globalThis !== 'undefined' ? globalThis : self);
