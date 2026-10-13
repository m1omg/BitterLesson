// Numerical gradient check for the ConvNet and the linear classifier.
require('../assets/js/connect.js');
require('../assets/js/digits.js');
const BL = globalThis.BL;
const data = require('./digits-data.js').train();

function lossOf(net, img, y) {
  const p = net.predict(img);
  return -Math.log(p[y]);
}

const net = new BL.digits.ConvNet({ seed: 7, batch: 16 });
// train a little first so biases move off zero (ReLU kinks spoil finite differences)
for (let i = 0; i < 320; i++) { net.train(data.image(i), data.labels[i]); }
net.batch = 1 << 30;
net.inBatch = 0;
for (const k of Object.keys(net.g)) net.g[k].fill(0);
const img = data.image(123), y = data.labels[123];
net.train(img, y);
// The network computes in float32, so the loss only moves in steps of about
// 1e-7: a central difference carries noise of about NOISE / (2 eps), which
// for the smallest gradients is as large as the gradient itself. Allow for it.
const NOISE = 3e-7;
let worst = 0, bad = 0;
const rng = BL.digits.makeFloatRng(99);
for (const name of ['w1', 'b1', 'w2', 'b2', 'w3', 'b3']) {
  const w = net[name], g = net.g[name];
  for (let t = 0; t < 12; t++) {
    const i = rng.int(w.length);
    const old = w[i], eps = 1e-3;
    w[i] = old + eps; const lp = lossOf(net, img, y);
    w[i] = old - eps; const lm = lossOf(net, img, y);
    w[i] = old;
    const num = (lp - lm) / (2 * eps), ana = g[i];
    const err = Math.max(0, Math.abs(num - ana) - NOISE / (2 * eps));
    const rel = err / Math.max(1e-4, Math.abs(num) + Math.abs(ana));
    worst = Math.max(worst, rel);
    if (rel > 0.05) { bad++; console.log('MISMATCH', name, i, num.toFixed(6), ana.toFixed(6)); }
  }
}
console.log('convnet worst relative error, single weights', worst.toFixed(4));
// A stronger signal: move a whole layer along a random direction and compare
// the change in loss with the gradient's prediction.
worst = 0;
for (const name of ['w1', 'b1', 'w2', 'b2', 'w3', 'b3']) {
  const w = net[name], g = net.g[name], saved = Float32Array.from(w);
  const d = new Float64Array(w.length);
  let norm = 0;
  for (let j = 0; j < d.length; j++) { d[j] = rng() - 0.5; norm += d[j] * d[j]; }
  norm = Math.sqrt(norm);
  let ana = 0;
  for (let j = 0; j < d.length; j++) { d[j] /= norm; ana += g[j] * d[j]; }
  const eps = 1e-3;
  for (let j = 0; j < d.length; j++) w[j] = saved[j] + eps * d[j];
  const lp = lossOf(net, img, y);
  for (let j = 0; j < d.length; j++) w[j] = saved[j] - eps * d[j];
  const lm = lossOf(net, img, y);
  w.set(saved);
  const num = (lp - lm) / (2 * eps);
  const rel = Math.max(0, Math.abs(num - ana) - NOISE / (2 * eps)) / Math.max(1e-4, Math.abs(num) + Math.abs(ana));
  worst = Math.max(worst, rel);
  if (rel > 0.05) { bad++; console.log('MISMATCH direction', name, num.toFixed(6), ana.toFixed(6)); }
}
console.log('convnet worst relative error, whole layers', worst.toFixed(4));

const feats = new Float32Array(BL.digits.HOG.size);
BL.digits.hogFeatures(img, feats);
const lin = new BL.digits.LinearClassifier(feats.length, { batch: 1 << 30 });
for (let i = 0; i < lin.W.length; i++) lin.W[i] = (rng() - 0.5) * 0.2;
lin.train(feats, y);
worst = 0;
for (let t = 0; t < 30; t++) {
  const i = rng.int(lin.W.length), old = lin.W[i], eps = 1e-3;
  lin.W[i] = old + eps; const lp = -Math.log(lin.predict(feats)[y]);
  lin.W[i] = old - eps; const lm = -Math.log(lin.predict(feats)[y]);
  lin.W[i] = old;
  const num = (lp - lm) / (2 * eps), ana = lin.gW[i];
  worst = Math.max(worst, Math.abs(num - ana) / Math.max(1e-4, Math.abs(num) + Math.abs(ana)));
}
console.log('linear worst relative error', worst.toFixed(4));
console.log('convnet flops/example', net.flopsPerExample, 'forward', net.flopsForward, 'hog flops', BL.digits.HOG.flops, 'hog size', BL.digits.HOG.size);
if (bad) { console.log(bad + ' mismatches'); process.exitCode = 1; }
