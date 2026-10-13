/*
 * connect.js: a generic Connect-K game, a pure Monte Carlo tree searcher,
 * and a hand-written Connect Four expert.
 *
 * The searcher knows nothing about any particular game. It sees only the
 * interface: legal moves, play a move, has someone won. The expert is the
 * opposite: a page of human Connect Four strategy and almost no search.
 *
 * Runs in the browser (window or worker) and in Node. Everything hangs off
 * the global BL namespace.
 */
(function (root) {
  'use strict';
  const BL = root.BL || (root.BL = {});

  // ---------------------------------------------------------------- RNG
  // xorshift32: tiny, fast, seedable. Returns uint32.
  function makeRng(seed) {
    let s = (seed >>> 0) || 0x9e3779b9;
    return function () {
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5; s >>>= 0;
      return s;
    };
  }

  // ---------------------------------------------------------------- Rules
  // A family of games: W x H board, K in a row.
  //   gravity: stones fall to the lowest empty cell of a column (Connect Four)
  //   misere:  completing K in a row LOSES instead of wins
  //   wrap:    the board is a cylinder; lines may cross the left/right edge
  const STANDARD = Object.freeze({ w: 7, h: 6, k: 4, gravity: true, misere: false, wrap: false });

  function normalizeRules(r) {
    const rules = Object.assign({}, STANDARD, r || {});
    rules.w = Math.max(3, Math.min(12, rules.w | 0));
    rules.h = Math.max(3, Math.min(12, rules.h | 0));
    rules.k = Math.max(3, Math.min(Math.max(rules.w, rules.h), rules.k | 0));
    if (rules.wrap && rules.w < rules.k) rules.wrap = false;
    rules.gravity = !!rules.gravity; rules.misere = !!rules.misere; rules.wrap = !!rules.wrap;
    return rules;
  }

  function isStandard(r) {
    return r.w === 7 && r.h === 6 && r.k === 4 && r.gravity && !r.misere && !r.wrap;
  }

  // ---------------------------------------------------------------- Game
  // Cells are stored column-major: cell = c * h + r, with r = 0 at the bottom.
  class Game {
    constructor(rules) {
      const R = normalizeRules(rules);
      this.rules = R;
      this.w = R.w; this.h = R.h; this.k = R.k;
      this.gravity = R.gravity; this.misere = R.misere; this.wrap = R.wrap;
      this.n = R.w * R.h;
      this.cells = new Uint8Array(this.n);
      this.heights = new Uint8Array(this.w);
      this.moves = new Int16Array(this.gravity ? this.w : this.n);
      this.pos = new Int16Array(this.gravity ? this.w : this.n);
      this.reset();
    }

    reset() {
      this.cells.fill(0);
      this.heights.fill(0);
      const m = this.moves.length;
      for (let i = 0; i < m; i++) { this.moves[i] = i; this.pos[i] = i; }
      this.nMoves = m;
      this.toMove = 1;
      this.ply = 0;
      this.result = -1; // -1 ongoing, 0 draw, 1 or 2 winner
      this.lastCell = -1;
      this.lineCells = null;
    }

    copyFrom(g) {
      const n = this.n, cells = this.cells, gc = g.cells;
      for (let i = 0; i < n; i++) cells[i] = gc[i];
      const w = this.w, hs = this.heights, gh = g.heights;
      for (let i = 0; i < w; i++) hs[i] = gh[i];
      const nm = g.nMoves, mv = this.moves, gm = g.moves, ps = this.pos, gp = g.pos, len = mv.length;
      for (let i = 0; i < nm; i++) mv[i] = gm[i];
      for (let i = 0; i < len; i++) ps[i] = gp[i];
      this.nMoves = nm;
      this.toMove = g.toMove;
      this.ply = g.ply;
      this.result = g.result;
      this.lastCell = g.lastCell;
      this.lineCells = null;
    }

    clone() { const g = new Game(this.rules); g.copyFrom(this); return g; }

    isLegal(m) {
      if (this.result >= 0) return false;
      if (this.gravity) return m >= 0 && m < this.w && this.heights[m] < this.h;
      return m >= 0 && m < this.n && this.cells[m] === 0;
    }

    // Cell a move would occupy (or -1 if illegal).
    cellOf(m) {
      if (this.gravity) return this.heights[m] < this.h ? m * this.h + this.heights[m] : -1;
      return this.cells[m] === 0 ? m : -1;
    }

    _removeMove(m) {
      const i = this.pos[m], last = this.moves[--this.nMoves];
      this.moves[i] = last; this.pos[last] = i;
    }

    play(m) {
      let cell;
      if (this.gravity) {
        cell = m * this.h + this.heights[m];
        if (++this.heights[m] === this.h) this._removeMove(m);
      } else {
        cell = m;
        this._removeMove(m);
      }
      const p = this.toMove;
      this.cells[cell] = p;
      this.ply++;
      this.lastCell = cell;
      if (this.lineThrough(cell, p)) this.result = this.misere ? 3 - p : p;
      else if (this.nMoves === 0) this.result = 0;
      this.toMove = 3 - p;
      return this.result;
    }

    // Length of the run of player p starting next to (c, r) in direction (dc, dr).
    _run(c, r, dc, dr, p, max) {
      const w = this.w, h = this.h, cells = this.cells, wrap = this.wrap;
      let n = 0;
      for (let i = 0; i < max; i++) {
        c += dc; r += dr;
        if (r < 0 || r >= h) break;
        if (c < 0 || c >= w) { if (!wrap) break; c = (c + w) % w; }
        if (cells[c * h + r] !== p) break;
        n++;
      }
      return n;
    }

    // Does the stone of player p at `cell` sit on a line of K? (cell need not
    // actually hold p: callers use this to ask "what if p played here".)
    lineThrough(cell, p) {
      const h = this.h, c = (cell / h) | 0, r = cell - c * h, k1 = this.k - 1;
      if (1 + this._run(c, r, 0, -1, p, k1) >= this.k) return true; // vertical: only down matters
      if (1 + this._run(c, r, 1, 0, p, k1) + this._run(c, r, -1, 0, p, k1) >= this.k) return true;
      if (1 + this._run(c, r, 1, 1, p, k1) + this._run(c, r, -1, -1, p, k1) >= this.k) return true;
      if (1 + this._run(c, r, 1, -1, p, k1) + this._run(c, r, -1, 1, p, k1) >= this.k) return true;
      return false;
    }

    // The winning line's cells, for drawing. Only meaningful after a line was made.
    findLine() {
      const cell = this.lastCell; if (cell < 0) return null;
      const h = this.h, w = this.w, c0 = (cell / h) | 0, r0 = cell - c0 * h, p = this.cells[cell];
      const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
      for (const [dc, dr] of dirs) {
        const back = this._run(c0, r0, -dc, -dr, p, this.k - 1);
        const fwd = this._run(c0, r0, dc, dr, p, this.k - 1);
        if (1 + back + fwd >= this.k) {
          const out = [];
          let c = c0 - dc * back, r = r0 - dr * back;
          for (let i = 0; i < 1 + back + fwd; i++) {
            const cc = ((c % w) + w) % w;
            out.push(cc * h + r);
            c += dc; r += dr;
          }
          return out;
        }
      }
      return null;
    }

    legalMoves() { return Array.from(this.moves.subarray(0, this.nMoves)).sort((a, b) => a - b); }
  }

  // ---------------------------------------------------------------- MCTS
  // Plain UCT. Random playouts. No knowledge of any game beyond its rules.
  class MCTS {
    constructor(rules, opts) {
      opts = opts || {};
      const maxNodes = opts.maxNodes || (1 << 19);
      this.maxNodes = maxNodes;
      this.visits = new Float64Array(maxNodes);
      this.value = new Float64Array(maxNodes);
      this.childStart = new Int32Array(maxNodes);
      this.childCount = new Int16Array(maxNodes);
      this.move = new Int16Array(maxNodes);
      // Game-theoretic proofs found inside the tree (MCTS-Solver): 0 unknown,
      // 1 a forced win for the player who moved into the node, -1 a forced
      // loss for them, 2 a forced draw. Pure search: it needs only the rules.
      this.proof = new Int8Array(maxNodes);
      this.solver = opts.solver !== false;
      this.root = new Game(rules);
      this.sim = new Game(rules);
      this.c = opts.c != null ? opts.c : 0.5;
      this.rng = makeRng(opts.seed || 12345);
      this.path = new Int32Array(this.root.n + 2);
      this.nodeCount = 0;
      this.sims = 0;
      this.movesSimulated = 0; // stones placed across all playouts: our unit of "work"
    }

    setRoot(game) {
      this.root.copyFrom(game);
      this.nodeCount = 1;
      this.visits[0] = 0; this.value[0] = 0; this.childCount[0] = -1; this.move[0] = -1; this.proof[0] = 0;
      this.sims = 0;
      this.movesSimulated = 0;
    }

    _expand(node, g) {
      const nm = g.nMoves;
      if (this.nodeCount + nm > this.maxNodes) return false;
      const start = this.nodeCount, rng = this.rng;
      this.childStart[node] = start;
      this.childCount[node] = nm;
      for (let i = 0; i < nm; i++) {
        const id = start + i;
        this.move[id] = g.moves[i];
        this.visits[id] = 0; this.value[id] = 0; this.childCount[id] = -1; this.proof[id] = 0;
      }
      // shuffle so that unvisited children are tried in random order
      for (let i = nm - 1; i > 0; i--) {
        const j = rng() % (i + 1), a = this.move[start + i];
        this.move[start + i] = this.move[start + j]; this.move[start + j] = a;
      }
      this.nodeCount += nm;
      return true;
    }

    _select(node) {
      const start = this.childStart[node], end = start + this.childCount[node];
      const visits = this.visits, value = this.value, proof = this.proof;
      const logN = Math.log(visits[node] + 1), c = this.c;
      let best = -1, bestScore = -Infinity;
      for (let i = start; i < end; i++) {
        const pf = proof[i];
        if (pf === 1) return i;      // a proven win: nothing else to consider
        if (pf === -1) continue;     // a proven loss: never choose it
        const n = visits[i];
        if (n === 0) return i;
        const s = value[i] / n + c * Math.sqrt(logN / n);
        if (s > bestScore) { bestScore = s; best = i; }
      }
      if (best < 0) { // every move loses: resist as long as possible
        for (let i = start; i < end; i++) if (best < 0 || visits[i] > visits[best]) best = i;
      }
      return best;
    }

    // After `child` was proven, try to prove its parent.
    _prove(parent, child) {
      const proof = this.proof;
      if (proof[child] === 1) { proof[parent] = -1; return true; }
      const start = this.childStart[parent], end = start + this.childCount[parent];
      let draws = 0;
      for (let i = start; i < end; i++) {
        const pf = proof[i];
        if (pf === 0 || pf === 1) return false;
        if (pf === 2) draws++;
      }
      proof[parent] = draws > 0 ? 2 : 1;
      return true;
    }

    // Run n more simulations from the root.
    run(n) {
      const root = this.root, sim = this.sim, path = this.path, rng = this.rng;
      const visits = this.visits, value = this.value, childCount = this.childCount, move = this.move;
      const proof = this.proof, solver = this.solver;
      if (root.result >= 0) return;
      const rootMover = root.toMove; // player choosing at the root
      for (let it = 0; it < n; it++) {
        sim.copyFrom(root);
        let node = 0, depth = 0;
        path[depth++] = 0;
        // 1. selection
        while (childCount[node] > 0 && sim.result < 0 && (node === 0 || proof[node] === 0)) {
          node = this._select(node);
          sim.play(move[node]);
          path[depth++] = node;
        }
        // 2. expansion
        if (sim.result < 0 && childCount[node] < 0 && (node === 0 || visits[node] > 0)) {
          if (this._expand(node, sim)) {
            node = this.childStart[node]; // children were shuffled: take the first
            sim.play(move[node]);
            path[depth++] = node;
          }
        }
        // 3. random playout, unless the outcome is already known
        const leafMover = ((depth - 1) & 1) ? rootMover : 3 - rootMover;
        let res, placed = 0;
        if (sim.result >= 0) {
          res = sim.result;
          if (solver && depth > 1) proof[node] = res === 0 ? 2 : (res === leafMover ? 1 : -1);
        } else if (solver && depth > 1 && proof[node] !== 0) {
          const pf = proof[node];
          res = pf === 2 ? 0 : (pf === 1 ? leafMover : 3 - leafMover);
        } else {
          while (sim.result < 0) { sim.play(sim.moves[rng() % sim.nMoves]); placed++; }
          res = sim.result;
        }
        this.movesSimulated += placed + depth;
        // 4. backpropagation. Node at depth d was entered by the player who
        // moved at depth d-1: rootMover for odd d, the opponent for even d.
        let proving = solver && depth > 1 && proof[path[depth - 1]] !== 0;
        for (let d = depth - 1; d >= 0; d--) {
          const id = path[d];
          visits[id] += 1;
          if (d === 0) break;
          const mover = (d & 1) ? rootMover : 3 - rootMover;
          value[id] += res === 0 ? 0.5 : (res === mover ? 1 : 0);
          if (proving) proving = d - 1 > 0 && this._prove(path[d - 1], id);
        }
        this.sims++;
      }
    }

    // Is the game at the root already decided under perfect play, as far as
    // the search has proven? 1: the player to move wins, -1: loses, 2: draw.
    rootProof() {
      const cc = this.childCount[0];
      if (cc <= 0) return 0;
      const s = this.childStart[0];
      let all = true, draws = 0;
      for (let i = s; i < s + cc; i++) {
        const pf = this.proof[i];
        if (pf === 1) return 1;
        if (pf === 0) all = false; else if (pf === 2) draws++;
      }
      return all ? (draws ? 2 : -1) : 0;
    }

    // Per root move: visits, estimated win rate for the player to move, and
    // any proof (1 forced win, -1 forced loss, 2 forced draw).
    rootStats() {
      const out = [];
      const cc = this.childCount[0];
      if (cc <= 0) return out;
      const s = this.childStart[0];
      for (let i = s; i < s + cc; i++) {
        const n = this.visits[i], pf = this.proof[i];
        let v = n > 0 ? this.value[i] / n : 0.5;
        if (pf === 1) v = 1; else if (pf === -1) v = 0; else if (pf === 2) v = 0.5;
        out.push({ move: this.move[i], visits: n, value: v, proof: pf });
      }
      out.sort((a, b) => a.move - b.move);
      return out;
    }

    bestMove() {
      const cc = this.childCount[0];
      if (cc <= 0) {
        const g = this.root;
        return g.nMoves > 0 ? g.moves[this.rng() % g.nMoves] : -1;
      }
      const s = this.childStart[0], proof = this.proof;
      for (let i = s; i < s + cc; i++) if (proof[i] === 1) return this.move[i];
      let best = -1, bv = -1, bq = -1;
      for (let pass = 0; pass < 2 && best < 0; pass++) {
        for (let i = s; i < s + cc; i++) {
          if (pass === 0 && proof[i] === -1) continue; // avoid proven losses if we can
          const n = this.visits[i], q = n > 0 ? this.value[i] / n : 0;
          if (n > bv || (n === bv && q > bq)) { bv = n; bq = q; best = this.move[i]; }
        }
      }
      return best;
    }
  }

  // ---------------------------------------------------------------- The Expert
  // Human Connect Four knowledge, written down. Tactics, threat theory and the
  // odd/even rule (Allis, 1988), positional weights. Two moves of lookahead.
  // Written for the standard game: stones fall, four in a row wins.

  // Every K-window on the board, as lists of cells. Cached per rules.
  const windowCache = new Map();
  function windowsFor(g) {
    const key = g.w + 'x' + g.h + 'k' + g.k + (g.wrap ? 'w' : '');
    let ws = windowCache.get(key);
    if (ws) return ws;
    ws = [];
    const w = g.w, h = g.h, k = g.k;
    const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
    for (let c = 0; c < w; c++) for (let r = 0; r < h; r++) {
      for (const [dc, dr] of dirs) {
        const cellsOf = [];
        let ok = true;
        for (let i = 0; i < k; i++) {
          let cc = c + dc * i; const rr = r + dr * i;
          if (rr < 0 || rr >= h) { ok = false; break; }
          if (cc < 0 || cc >= w) { if (!g.wrap) { ok = false; break; } cc = ((cc % w) + w) % w; }
          cellsOf.push(cc * h + rr);
        }
        if (ok) ws.push(Int16Array.from(cellsOf));
      }
    }
    // windows through each cell
    const through = Array.from({ length: w * h }, () => []);
    ws.forEach((win, i) => { for (const cell of win) through[cell].push(i); });
    ws = { list: ws, through };
    windowCache.set(key, ws);
    return ws;
  }

  // Would player p complete a line by occupying `cell`?
  function completes(g, cell, p) {
    const old = g.cells[cell];
    g.cells[cell] = p;
    const r = g.lineThrough(cell, p);
    g.cells[cell] = old;
    return r;
  }

  // Cells where p could complete a line right now (playable threats).
  function immediateWins(g, p) {
    let n = 0, h = g.h;
    for (let i = 0; i < g.nMoves; i++) {
      const c = g.moves[i];
      if (g.heights[c] < h && completes(g, c * h + g.heights[c], p)) n++;
    }
    return n;
  }

  // Static evaluation from `me`'s point of view. This is where most of the
  // human knowledge lives.
  function evaluate(g, me, W) {
    const opp = 3 - me, h = g.h, cells = g.cells, wins = windowsFor(g).list;
    let s = 0;
    // Odd/even threat rule: the first player wants threats on odd rows
    // (1st, 3rd, 5th from the bottom), the second player on even rows.
    const myParity = me === 1 ? 0 : 1;
    const oppParity = 1 - myParity;
    for (let i = 0; i < wins.length; i++) {
      const win = wins[i];
      let a = 0, b = 0, empty = -1;
      for (let j = 0; j < win.length; j++) {
        const v = cells[win[j]];
        if (v === me) a++; else if (v === opp) b++; else empty = win[j];
      }
      if (a > 0 && b > 0) continue; // dead window
      const k = win.length;
      if (a === k - 1) {
        const r = empty % h;
        s += W.three;
        if ((r & 1) === myParity) s += W.goodParity;
        // a threat with an empty cell beneath it cannot be blocked yet
        if (r > 0 && cells[empty - 1] === 0) s += W.hanging;
      } else if (a === k - 2) s += W.two;
      else if (b === k - 1) {
        const r = empty % h;
        s -= W.three * W.fear;
        if ((r & 1) === oppParity) s -= W.goodParity * W.fear;
        if (r > 0 && cells[empty - 1] === 0) s -= W.hanging * W.fear;
      } else if (b === k - 2) s -= W.two * W.fear;
    }
    // Positional weights: how many lines run through each cell. The centre
    // column is worth most.
    const through = windowsFor(g).through;
    for (let cell = 0; cell < cells.length; cell++) {
      const v = cells[cell];
      if (v === me) s += W.position * through[cell].length;
      else if (v === opp) s -= W.position * through[cell].length;
    }
    // Two of my threats stacked directly on top of each other win the column.
    for (let c = 0; c < g.w; c++) {
      for (let r = g.heights[c]; r + 1 < h; r++) {
        const cell = c * h + r;
        if (cells[cell] === 0 && cells[cell + 1] === 0 && completes(g, cell, me) && completes(g, cell + 1, me)) {
          s += W.stacked; break;
        }
      }
    }
    return s;
  }

  const EXPERT_WEIGHTS = Object.freeze({
    three: 9, two: 2, goodParity: 7, hanging: 3, fear: 1.15,
    position: 0.9, stacked: 40,
    fork: 900, giveAway: 5000, spoil: 25, allowFork: 700,
  });

  // Choose a move for the player to move. Returns a column.
  function expertMove(g, rng, weights) {
    const W = weights || EXPERT_WEIGHTS;
    const me = g.toMove, opp = 3 - me, h = g.h;
    const cols = g.legalMoves();
    if (cols.length === 0) return -1;
    // 1. Win if you can.
    for (const c of cols) if (completes(g, c * h + g.heights[c], me)) return c;
    // 2. Block if you must.
    for (const c of cols) if (completes(g, c * h + g.heights[c], opp)) return c;
    // 3. Otherwise weigh every move.
    let best = -Infinity, choice = cols[0];
    for (const c of cols) {
      const r = g.heights[c], cell = c * h + r;
      let s = 0;
      g.cells[cell] = me; g.heights[c]++;
      const above = r + 1 < h ? cell + 1 : -1;
      // Never play directly beneath your opponent's winning square.
      if (above >= 0 && completes(g, above, opp)) s -= W.giveAway;
      // Don't fill the square beneath your own threat: they'd just block it.
      if (above >= 0 && completes(g, above, me)) s -= W.spoil;
      // Two threats at once can't both be blocked.
      if (immediateWins(g, me) >= 2) s += W.fork;
      // Look one reply ahead: can the opponent answer with a double threat?
      if (s > -W.giveAway) {
        for (let i = 0; i < g.nMoves; i++) {
          const oc = g.moves[i], or = g.heights[oc];
          if (or >= h) continue;
          const ocell = oc * h + or;
          if (completes(g, ocell, me)) continue; // they'd have to block us instead
          g.cells[ocell] = opp; g.heights[oc]++;
          const theirs = immediateWins(g, opp);
          g.heights[oc]--; g.cells[ocell] = 0;
          if (theirs >= 2) { s -= W.allowFork; break; }
        }
      }
      s += evaluate(g, me, W);
      g.heights[c]--; g.cells[cell] = 0;
      s += (rng() % 1000) / 1000; // break ties at random
      if (s > best) { best = s; choice = c; }
    }
    return choice;
  }

  // ---------------------------------------------------------------- exports
  BL.makeRng = makeRng;
  BL.STANDARD_RULES = STANDARD;
  BL.normalizeRules = normalizeRules;
  BL.isStandardRules = isStandard;
  BL.Game = Game;
  BL.MCTS = MCTS;
  BL.expertMove = expertMove;
  BL.EXPERT_WEIGHTS = EXPERT_WEIGHTS;
  BL.connectInternals = { completes, immediateWins, evaluate, windowsFor };
})(typeof globalThis !== 'undefined' ? globalThis : self);
