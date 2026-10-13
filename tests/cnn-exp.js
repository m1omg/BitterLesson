// CNN configuration experiments. usage: node tests/cnn-exp.js '{"epochs":6,"f1":8,"f2":16,"lr":0.002,"batch":16,"aug":1,"decay":true}'
require('../assets/js/connect.js');
require('../assets/js/digits.js');
const BL = globalThis.BL, D = BL.digits;
const dd = require('./digits-data.js');
const train = dd.train(), test = dd.test();
const cfg = Object.assign({ epochs: 6, f1: 8, f2: 16, lr: 0.002, batch: 16, aug: 0, decay: false, seed: 2012 }, JSON.parse(process.argv[2] || '{}'));
function order(n, seed) { const r = D.makeFloatRng(seed), a = Array.from({ length: n }, (_, i) => i); for (let i = n - 1; i > 0; i--) { const j = r.int(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const net = new D.ConvNet(cfg);
const rng = D.makeFloatRng(5);
const buf = new Uint8Array(784);
const evalAcc = () => { let ok = 0; for (let i = 0; i < test.count; i++) { const z = net.forward(test.image(i)); let b = 0; for (let k = 1; k < 10; k++) if (z[k] > z[b]) b = k; if (b === test.labels[i]) ok++; } return ok / test.count; };
let flops = 0; const t0 = Date.now(); const out = [];
const total = cfg.epochs * train.count; let seen = 0;
for (let e = 0; e < cfg.epochs; e++) {
  const ord = order(train.count, 101 + e);
  for (const i of ord) {
    if (cfg.decay) net.setLearningRate(cfg.lr * 0.5 * (1 + Math.cos(Math.PI * seen / total)));
    let img = train.image(i);
    if (cfg.aug) img = D.shiftInto(img, buf, rng.int(2 * cfg.aug + 1) - cfg.aug, rng.int(2 * cfg.aug + 1) - cfg.aug);
    net.train(img, train.labels[i]);
    flops += net.flopsPerExample; seen++;
  }
  out.push(`e${e + 1}:${(evalAcc() * 100).toFixed(2)}`);
}
console.log(JSON.stringify(cfg), out.join(' '), 'flops', flops.toExponential(2), ((Date.now() - t0) / 1000).toFixed(0) + 's');
