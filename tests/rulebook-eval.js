// Evaluate the hand-written rulebook digit reader.
//
//   node tests/rulebook-eval.js          development set: first 6000 training images
//   node tests/rulebook-eval.js --test   held-out test set, with confusion matrix and timing
//
// The rulebook was tuned by hand on the development set only.
require('../assets/js/rulebook.js');
const D = require('./digits-data.js');
const RB = globalThis.BL.rulebook;

const useTest = process.argv.includes('--test');
const data = useTest ? D.test() : D.train();
const count = useTest ? data.count : Math.min(6000, data.count);

const conf = Array.from({ length: 10 }, () => new Array(10).fill(0));
let correct = 0;
const t0 = process.hrtime.bigint();
for (let i = 0; i < count; i++) {
  const r = RB.classify(data.image(i));
  conf[data.labels[i]][r.digit]++;
  if (r.digit === data.labels[i]) correct++;
}
const ms = Number(process.hrtime.bigint() - t0) / 1e6;

const name = useTest ? 'test' : 'dev';
console.log(`${name} accuracy: ${(100 * correct / count).toFixed(1)}%  (${correct}/${count}), ${RB.RULE_COUNT} rules`);
console.log(`time: ${ms.toFixed(0)} ms for ${count} images (${(1000 * ms / count).toFixed(0)} us each)`);
console.log('');
console.log('confusion matrix (rows: true digit, columns: rulebook answer)');
console.log('      ' + [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => String(d).padStart(5)).join('') + '    right');
for (let t = 0; t < 10; t++) {
  const row = conf[t], n = row.reduce((a, b) => a + b, 0);
  const cells = row.map((v) => String(v).padStart(5)).join('');
  console.log(`  ${t}:  ${cells}   ${(100 * row[t] / (n || 1)).toFixed(1).padStart(5)}%`);
}
const pairs = [];
for (let t = 0; t < 10; t++) for (let p = 0; p < 10; p++) if (t !== p && conf[t][p]) pairs.push([conf[t][p], t, p]);
pairs.sort((a, b) => b[0] - a[0]);
console.log('');
console.log('most common mistakes: ' + pairs.slice(0, 6).map(([n, t, p]) => `${t} read as ${p} (${n})`).join(', '));
