// Parallel calibration: node tests/tourney-par.js '{"sims":[4096,16384],"games":80,"c":0.9}'
// Optional keys: rules (variant), expertWeights, c, maxNodes, opponent ("expert" | "random" | "mcts:<sims>")
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const os = require('os');

if (isMainThread) {
  const cfg = Object.assign({ sims: [1024], games: 40, c: 0.9 }, JSON.parse(process.argv[2] || '{}'));
  const nW = Math.min(os.cpus().length, 4);
  (async () => {
    for (const sims of cfg.sims) {
      const t = Date.now();
      const jobs = [];
      for (let w = 0; w < nW; w++) {
        const idx = [];
        for (let i = w; i < cfg.games; i += nW) idx.push(i);
        jobs.push(new Promise((res, rej) => {
          const wk = new Worker(__filename, { workerData: { cfg, sims, idx } });
          wk.on('message', res); wk.on('error', rej);
        }));
      }
      const parts = await Promise.all(jobs);
      let score = 0, n = 0, firstScore = 0, firstN = 0, plies = 0;
      for (const p of parts) { score += p.score; n += p.n; firstScore += p.firstScore; firstN += p.firstN; plies += p.plies; }
      const pct = (x, m) => (100 * x / m).toFixed(1).padStart(5) + '%';
      console.log(`sims=${String(sims).padStart(6)} c=${cfg.c}${cfg.decisive ? ' D' : ''} score=${pct(score, n)} (as 1st ${pct(firstScore, firstN)}, as 2nd ${pct(score - firstScore, n - firstN)}) avg plies ${(plies / n).toFixed(1)}  ${((Date.now() - t) / 1000).toFixed(1)}s`);
    }
  })();
} else {
  require('../assets/js/connect.js');
  const BL = globalThis.BL;
  const { cfg, sims, idx } = workerData;
  const rules = BL.normalizeRules(cfg.rules || BL.STANDARD_RULES);
  let score = 0, firstScore = 0, firstN = 0, plies = 0;
  for (const i of idx) {
    const seed = 1000 + i * 31 + sims * 7;
    const rng = BL.makeRng(seed);
    const g = new BL.Game(rules);
    const mcts = new BL.MCTS(rules, { seed: seed * 7 + 1, maxNodes: cfg.maxNodes || (1 << 21), c: cfg.c, decisive: !!cfg.decisive, solver: cfg.solver !== false });
    let opp = null;
    if (cfg.opponent && cfg.opponent.startsWith('mcts:')) opp = new BL.MCTS(rules, { seed: seed * 13 + 5, maxNodes: 1 << 21, c: cfg.c });
    const mctsFirst = i % 2 === 0;
    const me = mctsFirst ? 1 : 2;
    // optional random opening, shared by each pair of games (colours swapped)
    if (cfg.openingPlies) {
      const orng = BL.makeRng(777 + (i >> 1) * 101);
      for (let k = 0; k < cfg.openingPlies && g.result < 0; k++) g.play(g.moves[orng() % g.nMoves]);
    }
    while (g.result < 0) {
      let m;
      if (g.toMove === me) { mcts.setRoot(g); mcts.run(sims); m = mcts.bestMove(); }
      else if (opp) { opp.setRoot(g); opp.run(+cfg.opponent.slice(5)); m = opp.bestMove(); }
      else if (cfg.opponent === 'random') m = g.moves[rng() % g.nMoves];
      else m = BL.expertMove(g, rng, cfg.expertWeights ? Object.assign({}, BL.EXPERT_WEIGHTS, cfg.expertWeights) : undefined);
      g.play(m);
    }
    const s = g.result === 0 ? 0.5 : (g.result === me ? 1 : 0);
    score += s; plies += g.ply;
    if (mctsFirst) { firstScore += s; firstN++; }
  }
  parentPort.postMessage({ score, n: idx.length, firstScore, firstN, plies });
}
