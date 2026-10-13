// Accuracy vs training compute for the Feature Engineer (HOG + linear) and
// the Learner (ConvNet). usage: node tests/digits-train.js [epochs] [f1] [f2] [lr] [batch]
require('../assets/js/connect.js');
require('../assets/js/digits.js');
const BL = globalThis.BL, D = BL.digits;
const dd = require('./digits-data.js');
const train = dd.train(), test = dd.test();
const epochs = +(process.argv[2] || 3);
const f1 = +(process.argv[3] || 8), f2 = +(process.argv[4] || 16), lr = +(process.argv[5] || 0.002), batch = +(process.argv[6] || 16);

function order(n, seed) { const r = D.makeFloatRng(seed), a = Array.from({ length: n }, (_, i) => i); for (let i = n - 1; i > 0; i--) { const j = r.int(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const checkpoints = []; for (let e = 6; e <= 12; e += 0.25) checkpoints.push(Math.pow(10, e));

// --- HOG + linear
{
  const t0 = Date.now();
  const F = D.HOG.size;
  const trainF = new Float32Array(train.count * F), testF = new Float32Array(test.count * F);
  for (let i = 0; i < train.count; i++) D.hogFeatures(train.image(i), trainF.subarray(i * F, (i + 1) * F));
  for (let i = 0; i < test.count; i++) D.hogFeatures(test.image(i), testF.subarray(i * F, (i + 1) * F));
  console.log('hog extraction', ((Date.now() - t0) / 1000).toFixed(2) + 's');
  const lin = new D.LinearClassifier(F, { lr: 0.003, batch: 32 });
  let flops = 0, ci = 0, seen = 0;
  const t1 = Date.now();
  const evalAcc = () => { let ok = 0; for (let i = 0; i < test.count; i++) { const p = lin.predict(testF.subarray(i * F, (i + 1) * F)); let b = 0; for (let k = 1; k < 10; k++) if (p[k] > p[b]) b = k; if (b === test.labels[i]) ok++; } return ok / test.count; };
  const out = [];
  for (let e = 0; e < 8; e++) {
    const ord = order(train.count, 11 + e);
    for (const i of ord) {
      lin.train(trainF.subarray(i * F, (i + 1) * F), train.labels[i]);
      flops += lin.flopsPerExample + (seen < train.count ? D.HOG.flops : 0);
      seen++;
      while (ci < checkpoints.length && flops >= checkpoints[ci]) { lin.flush(); out.push(`${Math.log10(checkpoints[ci]).toFixed(2)}:${(evalAcc() * 100).toFixed(1)}`); ci++; }
    }
  }
  lin.flush();
  console.log('HOG+linear', out.join(' '), ' final', (evalAcc() * 100).toFixed(2), 'flops', flops.toExponential(2), ((Date.now() - t1) / 1000).toFixed(1) + 's');
}

// --- ConvNet
{
  const net = new D.ConvNet({ f1, f2, lr, batch, seed: 2012 });
  let flops = 0, ci = 0, seen = 0;
  const t1 = Date.now();
  let evalTime = 0;
  const evalAcc = () => { const te = Date.now(); let ok = 0; for (let i = 0; i < test.count; i++) { const z = net.forward(test.image(i)); let b = 0; for (let k = 1; k < 10; k++) if (z[k] > z[b]) b = k; if (b === test.labels[i]) ok++; } evalTime += Date.now() - te; return ok / test.count; };
  const out = [];
  for (let e = 0; e < epochs; e++) {
    const ord = order(train.count, 101 + e);
    for (const i of ord) {
      net.train(train.image(i), train.labels[i]);
      flops += net.flopsPerExample; seen++;
      while (ci < checkpoints.length && flops >= checkpoints[ci]) { out.push(`${Math.log10(checkpoints[ci]).toFixed(2)}:${(evalAcc() * 100).toFixed(1)}`); ci++; }
    }
    console.log(' epoch', e + 1, 'acc', (evalAcc() * 100).toFixed(2), 'flops', flops.toExponential(2), 'train time', ((Date.now() - t1 - evalTime) / 1000).toFixed(1) + 's', 'ex/s', (seen / ((Date.now() - t1 - evalTime) / 1000)).toFixed(0));
  }
  console.log('ConvNet', out.join(' '));
}
