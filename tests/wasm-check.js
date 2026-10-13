// The WebAssembly network must agree with the JavaScript reference.
require('../assets/js/connect.js');
require('../assets/js/digits.js');
require('../assets/js/cnn-wasm.js');
const BL = globalThis.BL, D = BL.digits;
const data = require('./digits-data.js').train();
const W = D.cnnWasm({ f1: 8, f2: 16 });
if (!W) { console.log('wasm unavailable'); process.exit(1); }
const net = new D.ConvNet({ seed: 3, batch: 16 });
for (let i = 0; i < 640; i++) net.train(data.image(i), data.labels[i]); // move off the initialisation
net.zeroGrads(); net.batch = 1 << 30;
const idx = Array.from({ length: 64 }, (_, i) => 1000 + i);
for (const i of idx) net.train(data.image(i), data.labels[i]);
const ref = net.getGrads();
W.P.set(net.getParams()); W.exports.prepare(); W.exports.zero_grads();
idx.forEach((i, j) => { W.X.set(data.image(i), j * 784); W.Y[j] = data.labels[i]; });
W.exports.train(idx.length); W.exports.export_grads();
let worst = 0, scale = 0;
for (let i = 0; i < ref.length; i++) { worst = Math.max(worst, Math.abs(ref[i] - W.G[i])); scale = Math.max(scale, Math.abs(ref[i])); }
console.log('gradients: max abs diff', worst.toExponential(2), 'of max', scale.toExponential(2), worst / scale < 1e-4 ? 'OK' : 'MISMATCH');
W.exports.predict(idx.length);
let agree = 0;
idx.forEach((i, j) => { const z = net.forward(data.image(i)); let b = 0; for (let k = 1; k < 10; k++) if (z[k] > z[b]) b = k; if (b === W.PRED[j]) agree++; });
console.log('predictions agree', agree + '/' + idx.length);
// speed
const N = 3000;
let t = Date.now();
for (let s = 0; s < N; s += 32) { idx.forEach((i, j) => { if (j < 32) { W.X.set(data.image((s + j) % 12000), j * 784); W.Y[j] = data.labels[(s + j) % 12000]; } }); W.exports.train(32); }
const tw = (Date.now() - t) / 1000;
t = Date.now();
for (let s = 0; s < N; s++) net.train(data.image(s % 12000), data.labels[s % 12000]);
const tj = (Date.now() - t) / 1000;
console.log('examples/s  wasm', Math.round(N / tw), ' js', Math.round(N / tj), ' speedup', (tj / tw).toFixed(1) + 'x');
