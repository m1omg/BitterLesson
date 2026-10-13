// Calibration harness: Expert vs MCTS(N) on standard Connect Four.
// usage: node tests/tourney.js [games-per-level] [maxExp]
require('../assets/js/connect.js');
const BL = globalThis.BL;

const games = +(process.argv[2] || 40);
const maxExp = +(process.argv[3] || 14);
const rules = BL.STANDARD_RULES;

function playGame(sims, mctsFirst, seed) {
  const rng = BL.makeRng(seed);
  const g = new BL.Game(rules);
  const mcts = new BL.MCTS(rules, { seed: seed * 7 + 1, maxNodes: 1 << 20 });
  const mctsPlayer = mctsFirst ? 1 : 2;
  while (g.result < 0) {
    let m;
    if (g.toMove === mctsPlayer) {
      mcts.setRoot(g);
      mcts.run(sims);
      m = mcts.bestMove();
    } else {
      m = BL.expertMove(g, rng);
    }
    g.play(m);
  }
  return g.result === 0 ? 0.5 : (g.result === mctsPlayer ? 1 : 0);
}

const t0 = Date.now();
for (let e = 0; e <= maxExp; e += 1) {
  const sims = 1 << e;
  let score = 0;
  const t = Date.now();
  for (let i = 0; i < games; i++) score += playGame(sims, i % 2 === 0, 1000 + i * 31 + e * 7919);
  console.log(`sims=${String(sims).padStart(6)}  mcts score=${(score / games * 100).toFixed(1).padStart(5)}%  (${((Date.now() - t) / 1000).toFixed(1)}s)`);
}
console.log('total', ((Date.now() - t0) / 1000).toFixed(1) + 's');
