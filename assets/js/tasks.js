/*
 * tasks.js: the long-running jobs the page hands to Web Workers (or, if
 * workers are unavailable, runs on the main thread in short slices).
 *
 * Every task is an async function (msg, post) that reports progress with
 * post(...) and yields regularly so it can be cancelled.
 */
(function (root) {
  'use strict';
  const BL = root.BL || (root.BL = {});

  const cancelled = new Set();
  const yieldNow = () => new Promise((r) => setTimeout(r, 0));
  const now = () => (root.performance ? root.performance.now() : Date.now());

  // Shared state inside one worker (training data, model replicas).
  const state = { train: null, test: null, net: null, netConfig: null, fe: null, testFeatures: null };

  // ------------------------------------------------------------ search
  // One search tree per worker, reused from game to game: phones don't enjoy
  // allocating tens of megabytes per move.
  const trees = new Map();
  function searcherFor(rules, sims, seed, c) {
    const key = JSON.stringify(rules);
    const want = Math.min(1 << 20, Math.max(1 << 15, sims * 8));
    let t = trees.get(key);
    if (!t || t.maxNodes < want) {
      if (trees.size > 3) trees.clear();
      t = new BL.MCTS(rules, { maxNodes: want, seed, c });
      trees.set(key, t);
    }
    t.rng = BL.makeRng(seed);
    t.c = c != null ? c : 0.5;
    return t;
  }

  // Think about one position for `sims` simulations, yielding every ~25ms.
  async function think(mcts, game, sims, id, onProgress) {
    mcts.setRoot(game);
    let last = now();
    while (mcts.sims < sims) {
      if (cancelled.has(id)) return false;
      mcts.run(Math.min(sims - mcts.sims, 256));
      if (mcts.rootProof() === 1) break; // a forced win is already proven
      const t = now();
      if (t - last > 25) {
        if (onProgress) onProgress();
        await yieldNow();
        last = now();
      }
    }
    return true;
  }

  // One tournament game: the Searcher (MCTS) against the Expert.
  async function c4Game(msg, post) {
    const { id, sims, mctsFirst, seed } = msg;
    const rules = BL.normalizeRules(msg.rules);
    const g = new BL.Game(rules);
    const rng = BL.makeRng(seed);
    const mcts = searcherFor(rules, sims, (seed * 7 + 1) >>> 0, msg.c);
    const searcher = mctsFirst ? 1 : 2;
    let positions = 0, reported = 0;
    for (const m of msg.opening || []) if (g.result < 0 && g.isLegal(m)) { g.play(m); post({ id, type: 'move', move: m, by: 'opening', ply: g.ply }); }
    const canExpertPlay = rules.gravity;
    while (g.result < 0) {
      let m, by;
      if (g.toMove === searcher) {
        const ok = await think(mcts, g, sims, id, () => {
          const p = positions + mcts.movesSimulated;
          post({ id, type: 'work', positions: p - reported }); reported = p;
        });
        if (!ok) { post({ id, type: 'cancelled' }); cancelled.delete(id); return; }
        positions += mcts.movesSimulated;
        m = mcts.bestMove(); by = 'searcher';
      } else {
        if (!canExpertPlay) { post({ id, type: 'done', result: -2, plies: g.ply, positions: positions - reported }); return; }
        m = BL.expertMove(g, rng); by = 'expert';
        positions += 1;
      }
      g.play(m);
      post({ id, type: 'move', move: m, by, ply: g.ply });
      if (positions - reported > 50000) { post({ id, type: 'work', positions: positions - reported }); reported = positions; }
    }
    const res = g.result === 0 ? 0.5 : (g.result === searcher ? 1 : 0);
    post({ id, type: 'done', score: res, winner: g.result, plies: g.ply, line: g.findLine(), positions: positions - reported });
  }

  // The Searcher picks a move for a given history, streaming what it thinks.
  async function c4Think(msg, post) {
    const { id, sims } = msg;
    const rules = BL.normalizeRules(msg.rules);
    const g = new BL.Game(rules);
    for (const m of msg.moves) g.play(m);
    if (g.result >= 0) { post({ id, type: 'done', move: -1 }); return; }
    const mcts = searcherFor(rules, sims, msg.seed >>> 0, msg.c);
    let reported = 0;
    const t0 = now();
    const report = () => {
      post({ id, type: 'stats', sims: mcts.sims, stats: mcts.rootStats(), positions: mcts.movesSimulated - reported, elapsed: now() - t0 });
      reported = mcts.movesSimulated;
    };
    const ok = await think(mcts, g, sims, id, report);
    if (!ok) { post({ id, type: 'cancelled' }); cancelled.delete(id); return; }
    post({
      id, type: 'done', move: mcts.bestMove(), sims: mcts.sims, stats: mcts.rootStats(), proof: mcts.rootProof(),
      positions: mcts.movesSimulated - reported, elapsed: now() - t0,
    });
  }

  // ------------------------------------------------------------ learning
  function setData(msg, post) {
    const D = BL.digits;
    if (msg.train) state.train = D.parseDigits(msg.train);
    if (msg.test) state.test = D.parseDigits(msg.test);
    post({ id: msg.id, type: 'done' });
  }

  function image(set, i) { return set.images.subarray(i * 784, (i + 1) * 784); }

  function replica(config) {
    if (!state.net || state.netConfig !== config) {
      state.net = new BL.digits.ConvNet(JSON.parse(config));
      state.netConfig = config;
    }
    return state.net;
  }

  // One data-parallel slice of a ConvNet minibatch: load the weights we're
  // given, return the summed gradients for our examples.
  function cnnGrad(msg, post) {
    const W = msg.noWasm ? null : BL.digits.cnnWasm(JSON.parse(msg.config));
    if (W) {
      W.P.set(msg.w);
      W.exports.prepare();
      W.exports.zero_grads();
      const idx = msg.indices, train = state.train;
      for (let s = 0; s < idx.length; s += W.maxBatch) {
        const n = Math.min(W.maxBatch, idx.length - s);
        for (let j = 0; j < n; j++) { W.X.set(image(train, idx[s + j]), j * 784); W.Y[j] = train.labels[idx[s + j]]; }
        W.exports.train(n);
      }
      W.exports.export_grads();
      const grads = W.G.slice();
      post({ id: msg.id, type: 'done', grads, loss: 0, count: idx.length, wasm: true }, [grads.buffer]);
      return;
    }
    const net = replica(msg.config);
    net.setParams(msg.w);
    net.zeroGrads();
    net.batch = 1 << 30; // accumulate, never step here
    let loss = 0;
    for (const i of msg.indices) loss += net.train(image(state.train, i), state.train.labels[i]);
    const grads = net.getGrads();
    post({ id: msg.id, type: 'done', grads, loss, count: msg.indices.length }, [grads.buffer]);
  }

  // Test errors of a ConvNet over a slice of the test set.
  function cnnEval(msg, post) {
    const W = msg.noWasm ? null : BL.digits.cnnWasm(JSON.parse(msg.config));
    if (W) {
      W.P.set(msg.w);
      W.exports.prepare();
      const test = state.test, wrong = [];
      for (let s = msg.from; s < msg.to; s += W.maxBatch) {
        const n = Math.min(W.maxBatch, msg.to - s);
        W.X.set(test.images.subarray(s * 784, (s + n) * 784), 0);
        W.exports.predict(n);
        for (let j = 0; j < n; j++) if (W.PRED[j] !== test.labels[s + j]) wrong.push(s + j);
      }
      post({ id: msg.id, type: 'done', wrong, wasm: true });
      return;
    }
    const net = replica(msg.config);
    net.setParams(msg.w);
    const wrong = [];
    for (let i = msg.from; i < msg.to; i++) {
      const z = net.forward(image(state.test, i));
      let b = 0;
      for (let k = 1; k < 10; k++) if (z[k] > z[b]) b = k;
      if (b !== state.test.labels[i]) wrong.push(i);
    }
    post({ id: msg.id, type: 'done', wrong });
  }

  // The Feature Engineer trains start to finish in one task, reporting its
  // error rate at the FLOP checkpoints it is given: on the first `evalCount`
  // test digits along the way, and on all of them at the end.
  async function feTrain(msg, post) {
    const D = BL.digits, { id } = msg;
    const train = state.train, test = state.test;
    const F = D.HOG.size;
    const evalN = Math.min(msg.evalCount || 2500, test.count);
    const testF = new Float32Array(evalN * F);
    for (let i = 0; i < evalN; i++) D.hogFeatures(image(test, i), testF.subarray(i * F, (i + 1) * F));
    const lin = new D.LinearClassifier(F, { lr: msg.lr || 0.003, batch: msg.batch || 32 });
    state.fe = lin;
    const f = new Float32Array(F);
    const rng = D.makeFloatRng(msg.seed || 11);
    const argmax = (p) => { let b = 0; for (let k = 1; k < 10; k++) if (p[k] > p[b]) b = k; return b; };
    const wrongOn = (full) => {
      const wrong = [];
      const n = full ? test.count : evalN;
      for (let i = 0; i < n; i++) {
        let feat;
        if (i < evalN) feat = testF.subarray(i * F, (i + 1) * F);
        else { D.hogFeatures(image(test, i), f); feat = f; }
        if (argmax(lin.predict(feat)) !== test.labels[i]) wrong.push(i);
      }
      return wrong;
    };
    const checkpoints = msg.checkpoints;
    let ci = 0, flops = 0, seen = 0, last = now();
    const total = msg.epochs * train.count;
    const perExample = lin.flopsPerExample + D.HOG.flops;
    const report = (final) => {
      lin.flush();
      const wrong = wrongOn(final);
      const n = final ? test.count : evalN;
      post({ id, type: 'point', flops, seen, rate: wrong.length / n, n, errors: wrong.length, wrong: final ? wrong : undefined, final: !!final, W: lin.W.slice(), b: lin.b.slice() });
    };
    report(false);
    for (let e = 0; e < msg.epochs; e++) {
      const order = Array.from({ length: train.count }, (_, i) => i);
      for (let i = order.length - 1; i > 0; i--) { const j = rng.int(i + 1); const t = order[i]; order[i] = order[j]; order[j] = t; }
      for (const i of order) {
        if (cancelled.has(id)) { cancelled.delete(id); post({ id, type: 'cancelled' }); return; }
        const lr = (msg.lr || 0.003) * 0.5 * (1 + Math.cos(Math.PI * seen / total));
        lin.optW.lr = lr; lin.optB.lr = lr;
        D.hogFeatures(image(train, i), f);
        lin.train(f, train.labels[i]);
        flops += perExample; seen++;
        if (ci < checkpoints.length && flops >= checkpoints[ci]) {
          while (ci < checkpoints.length && flops >= checkpoints[ci]) ci++;
          report(false);
        }
        if (seen % 256 === 0 && now() - last > 30) {
          post({ id, type: 'work', flops, seen });
          await yieldNow(); last = now();
        }
      }
    }
    report(true);
    post({ id, type: 'done', flops, seen });
  }

  // The Rulebook reads every test digit once.
  function rulebookEval(msg, post) {
    const test = state.test, wrong = [];
    const t0 = now();
    for (let i = 0; i < test.count; i++) {
      const r = BL.rulebook.classify(image(test, i));
      if (r.digit !== test.labels[i]) wrong.push(i);
    }
    post({ id: msg.id, type: 'done', wrong, ms: now() - t0 });
  }

  // ------------------------------------------------------------ dispatch
  const ping = (msg, post) => post({ id: msg.id, type: 'done' });
  const handlers = { ping, c4Game, c4Think, setData, cnnGrad, cnnEval, feTrain, rulebookEval };

  async function handle(msg, post) {
    if (msg.type === 'cancel') { cancelled.add(msg.id); return; }
    const h = handlers[msg.type];
    if (!h) { post({ id: msg.id, type: 'error', error: 'unknown task ' + msg.type }); return; }
    try {
      await h(msg, post);
    } catch (err) {
      post({ id: msg.id, type: 'error', error: String(err && err.stack || err) });
    }
  }

  BL.tasks = { handle };
})(typeof globalThis !== 'undefined' ? globalThis : self);
