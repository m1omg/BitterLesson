// HOG + linear with options. usage: node tests/hog-exp.js '{"epochs":8,"lr":0.003,"batch":32,"aug":0}'
require('../assets/js/connect.js');
require('../assets/js/digits.js');
const BL = globalThis.BL, D = BL.digits;
const dd = require('./digits-data.js');
const train = dd.train(), test = dd.test();
const cfg = Object.assign({ epochs: 8, lr: 0.003, batch: 32, aug: 0, decay: false }, JSON.parse(process.argv[2] || '{}'));
function order(n, seed) { const r = D.makeFloatRng(seed), a = Array.from({ length: n }, (_, i) => i); for (let i = n - 1; i > 0; i--) { const j = r.int(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const F = D.HOG.size, f = new Float32Array(F), buf = new Uint8Array(784), rng = D.makeFloatRng(5);
const testF = new Float32Array(test.count * F);
for (let i = 0; i < test.count; i++) D.hogFeatures(test.image(i), testF.subarray(i * F, (i + 1) * F));
const lin = new D.LinearClassifier(F, cfg);
const evalAcc = () => { let ok = 0; for (let i = 0; i < test.count; i++) { const p = lin.predict(testF.subarray(i * F, (i + 1) * F)); let b = 0; for (let k = 1; k < 10; k++) if (p[k] > p[b]) b = k; if (b === test.labels[i]) ok++; } return ok / test.count; };
const out = []; const total = cfg.epochs * train.count; let seen = 0;
for (let e = 0; e < cfg.epochs; e++) {
  for (const i of order(train.count, 11 + e)) {
    if (cfg.decay) { const lr = cfg.lr * 0.5 * (1 + Math.cos(Math.PI * seen / total)); lin.optW.lr = lr; lin.optB.lr = lr; }
    let img = train.image(i);
    if (cfg.aug) img = D.shiftInto(img, buf, rng.int(2 * cfg.aug + 1) - cfg.aug, rng.int(2 * cfg.aug + 1) - cfg.aug);
    D.hogFeatures(img, f);
    lin.train(f, train.labels[i]); seen++;
  }
  lin.flush();
  out.push(`e${e + 1}:${(evalAcc() * 100).toFixed(2)}`);
}
console.log(JSON.stringify(cfg), out.join(' '));
