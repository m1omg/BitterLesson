/*
 * rulebook.js: "The Rulebook", a hand-written handwritten-digit recognizer
 * in the style of 1970s-80s structural pattern recognition.
 *
 * Nothing here is learned. The image is binarized, its loops are found, its
 * strokes are thinned to a one-pixel skeleton, stroke ends, junctions and the
 * bays between strokes are measured, and then an ordered list of if/then
 * rules, written by hand from what digits look like, picks the answer.
 *
 * Runs in the browser (window or worker) and in Node. Everything hangs off
 * the global BL namespace.
 */
(function (root) {
  'use strict';
  const BL = root.BL || (root.BL = {});

  const N = 28;            // input is N x N, row-major, 0..255, ink is bright
  const W = N + 2;         // working grids carry a one-pixel empty border
  const SIZE = W * W;
  const INK = 100;         // grey level above which a pixel counts as ink
  const HEAVY = 170;       // stricter level for drawings made with a very thick pen
  const FINE = 50;         // gentler level for drawings made with a very fine pen
  const DEEP = 200;        // stricter level that looks for loops inked over

  // Neighbour offsets in the padded grid, clockwise from north.
  const NB = [-W, -W + 1, 1, W + 1, W, W - 1, -1, -W - 1];

  // ---------------------------------------------------------------- buffers
  // Reused across calls: classify() allocates almost nothing.
  const src = new Float32Array(N * N);   // the input, brightness-stretched
  const tmp = new Float32Array(N * N);
  const grey = new Uint8Array(SIZE);     // padded grids from here on
  const deep = new Uint8Array(SIZE);     // grey >= DEEP
  const ink = new Uint8Array(SIZE);      // the binary image
  const sk = new Uint8Array(SIZE);       // its skeleton
  const mark = new Int16Array(SIZE);     // flood-fill labels
  const queue = new Int16Array(SIZE);
  const del = new Int16Array(SIZE);
  const PX = new Uint8Array(SIZE), PY = new Uint8Array(SIZE);   // coordinates of each cell
  for (let p = 0; p < SIZE; p++) { PX[p] = p % W; PY[p] = (p / W) | 0; }

  // Every pass works inside a window: the ink's bounding box plus a one-pixel
  // margin of background. Inclusive, in padded coordinates.
  let wx0 = 0, wx1 = W - 1, wy0 = 0, wy1 = W - 1;

  // ---------------------------------------------------------------- image
  // Read the input into src. Faint drawings are stretched so that their
  // brightest pixel counts as full ink, and a digit drawn much smaller or
  // bigger than usual is first scaled to the standard size: its larger side
  // 20 pixels, its centre of mass in the middle. False if there is no ink.
  function load(pixels) {
    const n = Math.min(pixels.length | 0, N * N);
    let max = 0, sum = 0;
    for (let i = 0; i < n; i++) { const v = +pixels[i] || 0; if (v > max) max = v; sum += v; }
    if (!(max > 0)) return false;
    // Dark ink on light paper? Turn it into light ink on dark.
    const invert = sum > 0.5 * max * n;
    const k = max < 255 ? 255 / max : 1;
    src.fill(0);
    let bx0 = N, bx1 = -1, by0 = N, by1 = -1, m = 0, mx = 0, my = 0;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = y * N + x;
        if (i >= n) break;
        const raw = +pixels[i] || 0;
        const v = Math.min(255, (invert ? max - raw : raw) * k);
        if (!(v > 0)) continue;
        src[i] = v;
        m += v; mx += v * x; my += v * y;
        if (v >= INK) { if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; }
      }
    }
    if (bx1 < 0) return false;
    const size = Math.max(bx1 - bx0 + 1, by1 - by0 + 1);
    if (size < 16 || size > 24) resample(20 / size, mx / m, my / m);
    return true;
  }

  // Binarize the loaded image at a grey level into the padded grid. Returns
  // the number of ink pixels, and sets the working window.
  function binarize(level) {
    ink.fill(0); grey.fill(0); deep.fill(0);
    let count = 0;
    wx0 = W; wx1 = 0; wy0 = W; wy1 = 0;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const v = Math.round(src[y * N + x]);
        if (v <= 0) continue;
        const p = (y + 1) * W + x + 1;
        grey[p] = v;
        if (v >= DEEP) deep[p] = 1;
        if (v >= level) {
          ink[p] = 1; count++;
          if (x < wx0) wx0 = x; if (x > wx1) wx1 = x; if (y < wy0) wy0 = y; if (y > wy1) wy1 = y;
        }
      }
    }
    if (!count) { wx0 = 0; wx1 = W - 1; wy0 = 0; wy1 = W - 1; return 0; }
    // padded coordinates of the box, plus one pixel of margin
    wx1 += 2; wy1 += 2;
    return count;
  }

  // Scale src by s about its centre of mass (cx, cy), which lands in the
  // middle of the field. Bilinear interpolation.
  function resample(s, cx, cy) {
    tmp.set(src);
    const c = (N - 1) / 2;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const sx = cx + (x - c) / s, sy = cy + (y - c) / s;
      const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
      let v = 0;
      if (x0 >= 0 && y0 >= 0 && x0 < N && y0 < N) v += tmp[y0 * N + x0] * (1 - fx) * (1 - fy);
      if (x0 + 1 >= 0 && y0 >= 0 && x0 + 1 < N && y0 < N) v += tmp[y0 * N + x0 + 1] * fx * (1 - fy);
      if (x0 >= 0 && y0 + 1 >= 0 && x0 < N && y0 + 1 < N) v += tmp[(y0 + 1) * N + x0] * (1 - fx) * fy;
      if (x0 + 1 >= 0 && y0 + 1 >= 0 && x0 + 1 < N && y0 + 1 < N) v += tmp[(y0 + 1) * N + x0 + 1] * fx * fy;
      src[y * N + x] = v;
    }
    // interpolation dims thin strokes: stretch the brightest back to full ink
    let top = 0;
    for (let i = 0; i < N * N; i++) if (src[i] > top) top = src[i];
    if (top > 0 && top < 255) for (let i = 0; i < N * N; i++) src[i] = Math.min(255, src[i] * 255 / top);
  }

  // Label 8-connected ink components; drop specks of dirt. Returns the
  // number of components kept.
  const sizes = new Int16Array(SIZE);
  function cleanComponents() {
    mark.fill(0);
    let label = 0, biggest = 0;
    for (let y = wy0; y <= wy1; y++) for (let p = y * W + wx0, e = y * W + wx1; p <= e; p++) {
      if (!ink[p] || mark[p]) continue;
      label++;
      let head = 0, tail = 0;
      queue[tail++] = p; mark[p] = label;
      while (head < tail) {
        const q = queue[head++];
        for (let k = 0; k < 8; k++) {
          const r = q + NB[k];
          if (ink[r] && !mark[r]) { mark[r] = label; queue[tail++] = r; }
        }
      }
      sizes[label] = tail;
      if (tail > biggest) biggest = tail;
    }
    // keep a component if it is not a speck: sizes[] becomes 1 (keep) or 0
    let kept = 0;
    for (let l = 1; l <= label; l++) {
      sizes[l] = sizes[l] >= 4 && sizes[l] >= biggest * 0.08 ? 1 : 0;
      kept += sizes[l];
    }
    if (kept < label) {
      for (let y = wy0; y <= wy1; y++) {
        for (let p = y * W + wx0, e = y * W + wx1; p <= e; p++) if (ink[p] && !sizes[mark[p]]) ink[p] = 0;
      }
    }
    return kept;
  }

  // Flood the background from the window's edge, 4-connected: mark[] = -1
  // outside. wall[] says what blocks the flood (ink, or only bright grey).
  function floodOutside(wall) {
    mark.fill(0);
    let head = 0, tail = 0;
    for (let x = wx0; x <= wx1; x++) {
      queue[tail++] = wy0 * W + x; mark[wy0 * W + x] = -1;
      queue[tail++] = wy1 * W + x; mark[wy1 * W + x] = -1;
    }
    for (let y = wy0 + 1; y < wy1; y++) {
      queue[tail++] = y * W + wx0; mark[y * W + wx0] = -1;
      queue[tail++] = y * W + wx1; mark[y * W + wx1] = -1;
    }
    // Only ever step to cells strictly inside the window.
    while (head < tail) {
      const q = queue[head++], qx = PX[q], qy = PY[q];
      const inRow = qy > wy0 && qy < wy1, inCol = qx > wx0 && qx < wx1;
      let r;
      if (inRow && qx - 1 > wx0 && !mark[r = q - 1] && !wall[r]) { mark[r] = -1; queue[tail++] = r; }
      if (inRow && qx + 1 < wx1 && !mark[r = q + 1] && !wall[r]) { mark[r] = -1; queue[tail++] = r; }
      if (inCol && qy - 1 > wy0 && !mark[r = q - W] && !wall[r]) { mark[r] = -1; queue[tail++] = r; }
      if (inCol && qy + 1 < wy1 && !mark[r = q + W] && !wall[r]) { mark[r] = -1; queue[tail++] = r; }
    }
  }

  // Collect the 4-connected region of unmarked open cells around p (label
  // id). Returns its size; the cells are queue[0..size).
  function fillRegion(p, id, wall) {
    let head = 0, tail = 0;
    queue[tail++] = p; mark[p] = id;
    while (head < tail) {
      const q = queue[head++];
      let r;
      if (!mark[r = q - 1] && !wall[r]) { mark[r] = id; queue[tail++] = r; }
      if (!mark[r = q + 1] && !wall[r]) { mark[r] = id; queue[tail++] = r; }
      if (!mark[r = q - W] && !wall[r]) { mark[r] = id; queue[tail++] = r; }
      if (!mark[r = q + W] && !wall[r]) { mark[r] = id; queue[tail++] = r; }
    }
    return tail;
  }

  // A heavy pen can ink over a small loop. Look again at a stricter grey
  // level: dim pixels walled in by bright ink are a loop, so cut them out.
  function openHiddenLoops() {
    floodOutside(deep);
    let id = 0;
    for (let y = wy0; y <= wy1; y++) for (let p = y * W + wx0, e = y * W + wx1; p <= e; p++) {
      if (mark[p] || grey[p] >= DEEP) continue;
      const size = fillRegion(p, ++id, deep);
      let darkest = 255;
      for (let i = 0; i < size; i++) if (grey[queue[i]] < darkest) darkest = grey[queue[i]];
      if (size >= 2 && darkest < INK) for (let i = 0; i < size; i++) ink[queue[i]] = 0;
    }
  }

  // Background regions that cannot reach the border are holes (loops).
  // Background is 4-connected because ink is 8-connected. Holes smaller than
  // `fillBelow` pixels are filled in as ink: they are pen noise, not loops.
  function findHoles(fillBelow) {
    floodOutside(ink);
    const holes = [];
    let id = 0;
    for (let y = wy0; y <= wy1; y++) for (let p = y * W + wx0, e = y * W + wx1; p <= e; p++) {
      if (ink[p] || mark[p]) continue;
      const size = fillRegion(p, ++id, ink);
      if (size < fillBelow) {
        for (let i = 0; i < size; i++) ink[queue[i]] = 1;
        continue;
      }
      let sx = 0, sy = 0, x0 = W, x1 = 0, y0 = W, y1 = 0;
      for (let i = 0; i < size; i++) {
        const q = queue[i], y = PY[q], x = PX[q];
        sx += x; sy += y;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      holes.push({ id, area: size, cx: sx / size - 1, cy: sy / size - 1, x0: x0 - 1, x1: x1 - 1, y0: y0 - 1, y1: y1 - 1 });
    }
    return holes;
  }

  // Everything before measuring: binarize, clean, find loops, thin, mend
  // broken loops.
  function prepare(pixels) {
    if (!load(pixels)) return null;
    let count = binarize(INK);
    if (!count) return null;
    let components = cleanComponents();
    openHiddenLoops();
    let holes = findHoles(3);
    thin();
    // A very heavy pen (strokes over 5 pixels wide on average): look again
    // at a stricter grey level, which pares the strokes down. A very fine pen
    // (under 2 pixels): look again at a gentler level, which takes in the
    // soft edge of the stroke and closes hairline gaps.
    let skel = 0;
    for (let y = wy0; y <= wy1; y++) for (let p = y * W + wx0, e = y * W + wx1; p <= e; p++) skel += sk[p];
    const pen = count / Math.max(1, skel);
    const level = pen > 5 ? HEAVY : pen < 2 ? FINE : 0;
    if (level) {
      count = binarize(level) || binarize(INK);
      components = cleanComponents();
      openHiddenLoops();
      holes = findHoles(3);
      thin();
    }
    prune(2);
    const bridges = bridgeGaps(5);
    if (bridges) {
      holes = findHoles(3);
      thin();
      prune(2);
    }
    return { count, components, holes, bridges, pen };
  }

  // ---------------------------------------------------------------- gaps
  const seen = new Int32Array(SIZE);
  let stamp = 0;
  const endList = new Int16Array(64);
  const used = new Uint8Array(64);

  const endDx = new Float32Array(64), endDy = new Float32Array(64);
  let dirX = 0, dirY = 0;

  // Direction a stroke points as it arrives at end pixel p (unit vector in
  // dirX, dirY), judged from a few pixels back along the skeleton.
  function endDirection(p) {
    const q = pathBuf[walk(p, 6, pathBuf) - 1];
    const dx = PX[p] - PX[q], dy = PY[p] - PY[q];
    const l = Math.hypot(dx, dy) || 1;
    dirX = dx / l; dirY = dy / l;
  }

  // How bent is the stroke over its last ten pixels before end p? The largest
  // distance of the path from the straight chord, as a share of the chord.
  function endBend(p) {
    const len = walk(p, 11, pathBuf);
    if (len < 5) return 0;
    const q = pathBuf[len - 1];
    const ax = PX[p], ay = PY[p], cx = PX[q] - ax, cy = PY[q] - ay;
    const c = Math.hypot(cx, cy) || 1;
    let worst = 0;
    for (let i = 1; i < len - 1; i++) {
      const d = Math.abs((PX[pathBuf[i]] - ax) * cy - (PY[pathBuf[i]] - ay) * cx) / c;
      if (d > worst) worst = d;
    }
    return worst / c;
  }

  // Steps along the skeleton from a to b, or -1 if more than cap.
  function skeletonDistance(a, b, cap) {
    stamp++;
    let head = 0, tail = 0, level = 0, levelEnd = 1;
    queue[tail++] = a; seen[a] = stamp;
    while (head < tail) {
      if (head === levelEnd) { level++; levelEnd = tail; if (level > cap) return -1; }
      const q = queue[head++];
      if (q === b) return level;
      for (let k = 0; k < 8; k++) {
        const r = q + NB[k];
        if (sk[r] && seen[r] !== stamp) { seen[r] = stamp; queue[tail++] = r; }
      }
    }
    return -1;
  }

  // Draw an 8-connected line of ink (Bresenham).
  function drawLine(ax, ay, bx, by) {
    const dx = Math.abs(bx - ax), dy = -Math.abs(by - ay);
    const sx = ax < bx ? 1 : -1, sy = ay < by ? 1 : -1;
    let err = dx + dy, x = ax, y = ay;
    for (let i = 0; i < 64; i++) {
      ink[y * W + x] = 1;
      if (x === bx && y === by) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x += sx; }
      if (e2 <= dx) { err += dx; y += sy; }
    }
  }

  // Pen lifts and faint ink break loops open. Where two stroke ends lie close
  // together on the page but far apart along the stroke, join them.
  let boxX0 = 0, boxX1 = 0;
  function bridgeGaps(maxGap) {
    boxX0 = W; boxX1 = 0;
    let ne = 0;
    for (let y = wy0; y <= wy1; y++) for (let p = y * W + wx0, e = y * W + wx1; p <= e; p++) {
      if (!ink[p]) continue;
      if (PX[p] < boxX0) boxX0 = PX[p]; if (PX[p] > boxX1) boxX1 = PX[p];
      if (!sk[p] || degree(p) > 1 || ne >= 64) continue;
      endDirection(p);
      endDx[ne] = dirX; endDy[ne] = dirY;
      endList[ne++] = p;
    }
    used.fill(0);
    let bridges = 0;
    for (let i = 0; i < ne; i++) {
      if (used[i]) continue;
      const a = endList[i], ay = PY[a], ax = PX[a];
      let best = -1, bestD = maxGap + 0.01;
      for (let j = 0; j < ne; j++) {
        if (j === i || used[j]) continue;
        const b = endList[j], by = PY[b], bx = PX[b];
        const d = Math.hypot(ax - bx, ay - by);
        if (d >= bestD) continue;
        // Two ends of a broken loop meet, overlap, or one heads for the other.
        // Ends pointing the same way, neither at the other, are two arms side
        // by side, like the ends of a 3.
        const ux = (bx - ax) / (d || 1), uy = (by - ay) / (d || 1);
        const aims = Math.max(endDx[i] * ux + endDy[i] * uy, -(endDx[j] * ux + endDy[j] * uy));
        // A 3 or a 5 is open on the left by design: never close a gap there
        // just because one end heads for the other.
        const leftSide = (ax + bx) / 2 < boxX0 + 0.4 * (boxX1 - boxX0 + 1);
        if (endDx[i] * endDx[j] + endDy[i] * endDy[j] > 0.3 && (aims < 0.6 || leftSide)) continue;
        if (skeletonDistance(a, b, Math.ceil(d * 3)) >= 0) continue; // same short stroke
        best = j; bestD = d;
      }
      if (best < 0) continue;
      const b = endList[best], by = PY[b], bx = PX[b];
      drawLine(ax, ay, bx, by);
      used[i] = used[best] = 1;
      bridges++;
    }
    return bridges;
  }

  // ---------------------------------------------------------------- skeleton
  // Zhang & Suen (1984) thinning, with the Lu & Wang (1986) fix that keeps
  // two-pixel-thick diagonals alive.
  const list = new Int16Array(SIZE);
  function thin() {
    sk.set(ink);
    // the ink pixels in raster order: only they can ever change
    let n = 0;
    for (let y = wy0; y <= wy1; y++) for (let p = y * W + wx0, e = y * W + wx1; p <= e; p++) if (sk[p]) list[n++] = p;
    let changed = true;
    while (changed) {
      changed = false;
      for (let pass = 0; pass < 2; pass++) {
        let nd = 0;
        for (let i = 0; i < n; i++) {
          const p = list[i];
          if (!sk[p]) continue;
          const p2 = sk[p - W], p3 = sk[p - W + 1], p4 = sk[p + 1], p5 = sk[p + W + 1];
          const p6 = sk[p + W], p7 = sk[p + W - 1], p8 = sk[p - 1], p9 = sk[p - W - 1];
          const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (b < 3 || b > 6) continue;
          const a = (!p2 && p3) + (!p3 && p4) + (!p4 && p5) + (!p5 && p6) +
            (!p6 && p7) + (!p7 && p8) + (!p8 && p9) + (!p9 && p2);
          if (a !== 1) continue;
          if (pass === 0) { if (p2 && p4 && p6) continue; if (p4 && p6 && p8) continue; }
          else { if (p2 && p4 && p8) continue; if (p2 && p6 && p8) continue; }
          del[nd++] = p;
        }
        for (let i = 0; i < nd; i++) sk[del[i]] = 0;
        if (nd) changed = true;
      }
      let m = 0;
      for (let i = 0; i < n; i++) if (sk[list[i]]) list[m++] = list[i];
      n = m;
    }
    // Make the skeleton minimal: drop staircase pixels that sit on a corner
    // between two 4-neighbours and whose removal keeps everything connected.
    let again = true;
    while (again) {
      again = false;
      for (let i = 0; i < n; i++) {
        const p = list[i];
        if (!sk[p]) continue;
        const up = sk[p - W], right = sk[p + 1], down = sk[p + W], left = sk[p - 1];
        if (!((up && right) || (right && down) || (down && left) || (left && up))) continue;
        if (degree(p) < 2 || crossings8(p) !== 1) continue;
        sk[p] = 0; again = true;
      }
    }
  }

  // Hilditch crossing number: how many separate groups of skeleton pixels
  // touch p (1 means p can go without cutting anything apart).
  function crossings8(p) {
    const e = sk[p + 1], ne = sk[p - W + 1], n = sk[p - W], nw = sk[p - W - 1];
    const w = sk[p - 1], sw = sk[p + W - 1], s = sk[p + W], se = sk[p + W + 1];
    return (!e && (ne || n)) + (!n && (nw || w)) + (!w && (sw || s)) + (!s && (se || e));
  }

  function degree(p) {
    let c = 0;
    for (let k = 0; k < 8; k++) c += sk[p + NB[k]];
    return c;
  }

  // Walk along the skeleton from an end pixel until a junction or another
  // end. The pixels walked go in path (not the junction it stops at); returns
  // how many, and walkStop tells why it stopped: 0 an end, 1 a junction, 2 the
  // length limit.
  let walkStop = 0;
  function walk(start, maxLen, path) {
    let prev = -1, cur = start, len = 0;
    path[len++] = cur;
    while (len < maxLen) {
      let next = -1, n = 0;
      for (let k = 0; k < 8; k++) {
        const r = cur + NB[k];
        if (sk[r] && r !== prev) {
          // skip pixels already on the path (tight corners)
          let seen = false;
          for (let i = Math.max(0, len - 3); i < len; i++) if (path[i] === r) { seen = true; break; }
          if (!seen) { n++; if (next < 0 || (k & 1) === 0) next = r; }
        }
      }
      if (n === 0) { walkStop = 0; return len; }
      if (n >= 2 || degree(next) >= 3) { walkStop = 1; return len; }
      prev = cur; cur = next;
      path[len++] = cur;
    }
    walkStop = 2;
    return len;
  }

  const pathBuf = new Int16Array(SIZE);

  // Prune spurs: short branches from a junction to an end, left over from
  // bumps on the stroke outline.
  function prune(maxSpur) {
    for (let round = 0; round < 2; round++) {
      let removed = false;
      for (let y = wy0; y <= wy1; y++) for (let p = y * W + wx0, e = y * W + wx1; p <= e; p++) {
        if (!sk[p] || degree(p) !== 1) continue;
        const len = walk(p, maxSpur + 1, pathBuf);
        if (walkStop === 1 && len <= maxSpur) {
          for (let i = 0; i < len; i++) sk[pathBuf[i]] = 0;
          removed = true;
        }
      }
      if (!removed) break;
    }
  }

  // ---------------------------------------------------------------- measure
  const colTop = new Int8Array(W), colBot = new Int8Array(W);
  const rowLeft = new Int8Array(W), rowRight = new Int8Array(W);
  const BAYS = ['L', 'R', 'U', 'D', 'C'];   // open to the left, right, up, down; closed all round
  const bayCount = new Float64Array(15), baySumY = new Float64Array(5);

  // Everything the rules look at, in one plain object. Positions are
  // fractions of the ink's box: x 0 left .. 1 right, y 0 top .. 1 bottom.
  function measure(pixels) {
    const prep = prepare(pixels);
    if (!prep) return null;
    const f = { inkCount: prep.count, components: prep.components, bridges: prep.bridges, pen: prep.pen };
    const holes = prep.holes;
    // bounding box and mass
    let x0 = W, x1 = -1, y0 = W, y1 = -1, mass = 0, sx = 0, sy = 0;
    for (let y = wy0; y <= wy1; y++) for (let x = wx0; x <= wx1; x++) {
      if (!ink[y * W + x]) continue;
      mass++; sx += x; sy += y;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (mass === 0) return null;
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    f.width = bw; f.height = bh; f.aspect = bw / bh;
    const rx = (x) => (x + 1 - x0) / bw;   // relative position of an unpadded x
    const ry = (y) => (y + 1 - y0) / bh;
    f.massY = (sy / mass - y0) / bh; f.massX = (sx / mass - x0) / bw;
    // second moments of the ink: how elongated is it?
    const mx = sx / mass, my = sy / mass;
    let mxx = 0, myy = 0, mxy = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (!ink[y * W + x]) continue;
      const dx = x - mx, dy = y - my;
      mxx += dx * dx; myy += dy * dy; mxy += dx * dy;
    }
    const tr = (mxx + myy) / 2, det = (mxx * myy - mxy * mxy);
    const disc = Math.sqrt(Math.max(0, tr * tr - det));
    f.elong = Math.sqrt((tr + disc) / Math.max(1e-6, tr - disc));

    f.holes = holes.map((h) => ({ area: h.area, x: rx(h.cx + 0.5), y: ry(h.cy + 0.5),
      top: ry(h.y0), bottom: ry(h.y1 + 1), left: rx(h.x0), right: rx(h.x1 + 1) }));
    f.loops = f.holes.length;

    // ends and junctions
    const ends = [], junc = [];
    for (let yy = y0; yy <= y1; yy++) for (let p = yy * W + x0, e = yy * W + x1; p <= e; p++) {
      if (!sk[p]) continue;
      const d = degree(p);
      const y = PY[p] - 1, x = PX[p] - 1;
      if (d === 1) {
        endDirection(p);
        ends.push({ px: x, py: y, x: rx(x + 0.5), y: ry(y + 0.5), dx: dirX, dy: dirY, bend: endBend(p) });
      } else if (d === 0) {
        ends.push({ px: x, py: y, x: rx(x + 0.5), y: ry(y + 0.5), dx: 0, dy: 0, bend: 0 });
      } else if (d >= 3) {
        // merge with a nearby junction pixel
        let merged = false;
        for (const j of junc) if (Math.abs(j.px - x) <= 2 && Math.abs(j.py - y) <= 2) { merged = true; break; }
        if (!merged) junc.push({ px: x, py: y, x: rx(x + 0.5), y: ry(y + 0.5) });
      }
    }
    f.ends = ends; f.junctions = junc;

    // Bays: for each background pixel inside the box, which directions hit
    // ink? Open on exactly one side is a bay facing that side.
    colTop.fill(-1); colBot.fill(-1); rowLeft.fill(-1); rowRight.fill(-1);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (!ink[y * W + x]) continue;
      if (colTop[x] < 0) colTop[x] = y; colBot[x] = y;
      if (rowLeft[y] < 0) rowLeft[y] = x; rowRight[y] = x;
    }
    // bay[k] = share of the box in the top, middle and bottom third; bayY[k] =
    // the bay's average height (0 top, 1 bottom)
    bayCount.fill(0); baySumY.fill(0);
    for (let y = y0; y <= y1; y++) {
      const band = Math.min(2, (3 * (y - y0) / bh) | 0);
      for (let x = x0; x <= x1; x++) {
        const p = y * W + x;
        if (ink[p] || mark[p] > 0) continue; // ink or a true hole
        const u = colTop[x] >= 0 && colTop[x] < y, d = colBot[x] > y;
        const l = rowLeft[y] >= 0 && rowLeft[y] < x, r = rowRight[y] > x;
        const n = u + d + l + r;
        let k = -1;
        if (n === 4) k = 4;
        else if (n === 3) k = !l ? 0 : !r ? 1 : !u ? 2 : 3;
        if (k >= 0) { bayCount[k * 3 + band]++; baySumY[k] += y; }
      }
    }
    const area = bw * bh;
    const bay = {}, bayY = {};
    for (let k = 0; k < 5; k++) {
      const c0 = bayCount[k * 3], c1 = bayCount[k * 3 + 1], c2 = bayCount[k * 3 + 2], n = c0 + c1 + c2;
      bayY[BAYS[k]] = n ? (baySumY[k] / n - y0 + 0.5) / bh : 0.5;
      bay[BAYS[k]] = [c0 / area, c1 / area, c2 / area];
    }
    f.bay = bay; f.bayY = bayY;

    // where the ink sits, left to right, between a quarter and half way down
    let ax = 0, an = 0;
    for (let y = y0 + Math.floor(0.25 * bh); y <= y0 + Math.floor(0.5 * bh); y++) {
      for (let x = x0; x <= x1; x++) if (ink[y * W + x]) { ax += x; an++; }
    }
    f.upperX = an ? (ax / an - x0 + 0.5) / bw : 0.5;

    // how much of the bottom 40% of the box is ink (a tail is thin, an inked
    // over bowl is solid)
    let lowInk = 0;
    const ly0 = y1 - Math.floor(0.4 * bh) + 1;
    for (let y = ly0; y <= y1; y++) for (let x = x0; x <= x1; x++) lowInk += ink[y * W + x];
    f.lowerFill = lowInk / ((y1 - ly0 + 1) * bw);

    // bars: the longest horizontal stretch of ink near the top and bottom
    const q = Math.max(1, Math.round(bh * 0.25));
    f.topBar = longestRun(y0, y0 + q - 1, x0, x1) / bw;
    f.bottomBar = longestRun(y1 - q + 1, y1, x0, x1) / bw;

    // crossings: how many strokes a horizontal line meets at a few heights
    f.hcross = [0.2, 0.35, 0.5, 0.65, 0.8].map((t) => runs(y0 + Math.min(bh - 1, Math.floor(t * bh)), x0, x1, true));
    f.vcross = [0.3, 0.5, 0.7].map((t) => runs(x0 + Math.min(bw - 1, Math.floor(t * bw)), y0, y1, false));
    // the most strokes any vertical line through the middle 60% meets
    f.vmax = 0;
    for (let x = x0 + Math.floor(0.2 * bw); x <= x0 + Math.ceil(0.8 * bw) && x <= x1; x++) {
      f.vmax = Math.max(f.vmax, runs(x, y0, y1, false));
    }
    f.box = { x0: x0 - 1, y0: y0 - 1, x1: x1 - 1, y1: y1 - 1 };
    return f;
  }

  // Longest horizontal run of ink in rows ya..yb, two rows at a time so that
  // a slightly sloping bar still counts.
  function longestRun(ya, yb, xa, xb) {
    let best = 0;
    for (let y = ya; y <= yb; y++) {
      let run = 0;
      for (let x = xa; x <= xb; x++) {
        if (ink[y * W + x] || (y < yb && ink[(y + 1) * W + x])) { run++; if (run > best) best = run; } else run = 0;
      }
    }
    return best;
  }

  function runs(line, a, b, horizontal) {
    let n = 0, inside = false;
    for (let i = a; i <= b; i++) {
      const v = horizontal ? ink[line * W + i] : ink[i * W + line];
      if (v && !inside) n++;
      inside = !!v;
    }
    return n;
  }

  // ---------------------------------------------------------------- rules
  // How many stroke ends lie inside a region of the box (0..1 coordinates).
  function endsIn(f, x0, x1, y0, y1) {
    let n = 0;
    for (const e of f.ends) if (e.x >= x0 && e.x <= x1 && e.y >= y0 && e.y <= y1) n++;
    return n;
  }

  // The stroke end nearest the bottom, or null.
  function lowestEnd(f) {
    let low = null;
    for (const e of f.ends) if (!low || e.y > low.y) low = e;
    return low;
  }

  // Does the digit hang from the top on a straight tail (a 7's leg, a 9's
  // stem) rather than sit on a curl (a 5's belly)? Both signs must agree.
  function hangsOnStraightTail(f) {
    const e = lowestEnd(f);
    return !!e && e.y > 0.8 && e.bend < 0.12 && f.massY < 0.44;
  }

  // The rulebook: tried in order, the first rule whose test holds decides.
  // Positions are fractions of the ink's box: x 0 left .. 1 right, y 0 top ..
  // 1 bottom. A stroke end's (dx, dy) is the way the stroke points as it ends.
  const rule = (digit, why, when) => ({ digit, why, when });
  const RULES = [
    // Two loops.
    rule(8, 'two loops: 8', (f) => f.loops >= 2),

    // One loop: where is it, and what hangs off it?
    rule(8, 'lower loop closed, upper one open: 8', (f) =>
      f.loops === 1 && f.holes[0].y > 0.55 && endsIn(f, 0, 1, 0, 0.5) >= 2),
    rule(8, 'upper loop closed, lower one open: 8', (f) =>
      f.loops === 1 && f.holes[0].y < 0.45 && f.ends.filter((e) => e.y > 0.7 && e.dy > 0.3).length >= 2),
    rule(4, 'stem through a closed corner: 4', (f) =>
      f.loops === 1 && f.holes[0].y < 0.6 &&
      f.ends.some((e) => e.y < 0.2 && e.x > f.holes[0].x) && endsIn(f, 0, 1, 0.75, 1) > 0),
    rule(4, 'closed corner, bar sticks out right: 4', (f) =>
      f.loops === 1 && f.holes[0].y < 0.6 && f.ends.some((e) => e.x > 0.7 && e.y > 0.35 && e.y < 0.75 && e.dx > 0.7)),
    rule(0, 'one loop, filling the box: 0', (f) =>
      f.loops === 1 && f.holes[0].bottom - f.holes[0].top >= 0.5 && f.holes[0].bottom >= 0.75),
    rule(8, 'loop over a solid inked bowl: 8', (f) =>
      f.loops === 1 && f.holes[0].y < 0.5 && f.lowerFill >= 0.42),
    rule(9, 'loop on top of a tail: 9', (f) =>
      f.loops === 1 && f.holes[0].y < 0.5),
    rule(3, 'arm open left over a closed bowl: 3', (f) =>
      f.loops === 1 && f.holes[0].y > 0.5 && f.holes[0].x >= 0.45 && f.upperX > 0.55 &&
      f.bay.L[0] + f.bay.L[1] >= 0.03 && endsIn(f, 0.6, 1, 0.7, 1) === 0 && endsIn(f, 0, 0.6, 0, 0.4) > 0),
    rule(2, 'neck on the right, curl below: 2', (f) =>
      f.loops === 1 && f.holes[0].y > 0.5 && f.upperX > 0.55 && f.ends.some((e) => e.y < 0.4 && e.x < 0.6 && e.dx < 0)),
    rule(2, 'curl at the foot, base to the right: 2', (f) =>
      f.loops === 1 && endsIn(f, 0, 0.6, 0, 0.4) > 0 && endsIn(f, 0.55, 1, 0.65, 1) > 0),
    rule(0, 'a closed ring, no stroke ends: 0', (f) =>
      f.loops === 1 && f.ends.length === 0 && f.holes[0].y > 0.35 && f.holes[0].y < 0.65),
    rule(2, 'a small curl at the bottom left: 2', (f) =>
      f.loops === 1 && f.holes[0].area < 20 && f.holes[0].x < 0.35 && f.holes[0].y > 0.6 &&
      f.ends.some((e) => e.y < 0.45 && e.dx < -0.5)),
    rule(6, 'loop under a stem: 6', (f) => f.loops === 1),

    // No loops: stroke ends, bars, and the bays between strokes.
    rule(1, 'one long thin stroke: 1', (f) => f.elong >= 4 || f.aspect < 0.4),
    rule(6, 'stem down the left, open bowl: 6', (f) =>
      f.upperX < 0.6 && f.bay.R[1] + f.bay.R[2] >= 0.1 &&
      f.ends.some((e) => e.y < 0.25 && e.x > 0.5 && e.dx > -0.5) && f.ends.some((e) => e.y > 0.6 && e.dx > 0.5)),
    rule(4, 'open top, strokes meet: 4', (f) =>
      f.bay.U[0] >= 0.03 && endsIn(f, 0, 1, 0, 0.35) >= 2 && f.junctions.length > 0),
    rule(5, 'open right on top, left below: 5', (f) =>
      f.bay.R[0] + f.bay.R[1] >= 0.05 && f.bayY.R < 0.45 && f.bay.L[1] + f.bay.L[2] >= 0.03 && f.bay.L[0] < 0.02 &&
      !hangsOnStraightTail(f)),
    rule(3, 'two arms open to the left: 3', (f) =>
      f.vmax >= 3 && endsIn(f, 0, 0.6, 0, 0.35) > 0 &&
      f.ends.some((e) => e.x < 0.5 && e.y > 0.65 && e.dx < -0.5 && e.dy < 0.5) && endsIn(f, 0.6, 1, 0.7, 1) === 0),
    rule(5, 'bar ends at the top right: 5', (f) =>
      f.topBar >= 0.4 && f.ends.some((e) => e.x > 0.6 && e.y < 0.25 && e.dx > 0.5) &&
      endsIn(f, 0, 0.5, 0.6, 1) > 0 && !hangsOnStraightTail(f)),
    rule(9, 'loop open at the top right, a tail: 9', (f) =>
      f.massY < 0.52 && endsIn(f, 0, 1, 0.8, 1) > 0 && endsIn(f, 0.5, 1, 0, 0.4) >= 2 && endsIn(f, 0, 0.5, 0, 0.4) === 0),
    rule(7, 'a bar on top, one leg down: 7', (f) =>
      f.topBar >= 0.5 && f.bottomBar < 0.45 && f.vcross[1] <= 2 && f.massY < 0.5 && endsIn(f, 0, 1, 0.8, 1) > 0 &&
      !f.ends.some((e) => e.x > 0.65 && e.y < 0.25 && e.dx > 0.5)),
    rule(3, 'crossed 3 times, ends on the left: 3', (f) =>
      f.vcross[1] >= 3 && endsIn(f, 0, 0.5, 0, 1) >= 2 && endsIn(f, 0.55, 1, 0.6, 1) === 0),
    rule(2, 'starts top left, ends bottom right: 2', (f) =>
      f.ends.some((e) => e.x < 0.6 && e.y < 0.4 && e.dx < 0.3) && f.ends.some((e) => e.x > 0.55 && e.y > 0.65 && e.dx > 0.3)),

    // Last chances: shapes spoiled by a gap, a slip or heavy ink.
    rule(0, 'an almost closed ring: 0', (f) =>
      f.hcross[1] === 2 && f.hcross[2] === 2 && f.hcross[3] === 2 && f.vcross[1] === 2 &&
      f.bay.C[0] + f.bay.C[1] + f.bay.C[2] >= 0.15),
    rule(4, 'two arms up, one leg down: 4', (f) =>
      f.junctions.length > 0 && endsIn(f, 0, 1, 0.8, 1) > 0 &&
      f.ends.some((a) => a.y < 0.55 && a.dy < -0.5 && f.ends.some((b) => b.y < 0.55 && b.dy < -0.5 && b.x - a.x >= 0.3))),
    rule(9, 'open loop over a straight stem: 9', (f) =>
      f.ends.length === 2 && f.massY < 0.47 && f.ends.some((e) => e.x > 0.55 && e.y < 0.25) &&
      f.ends.some((e) => e.y > 0.8 && e.dy > 0.7)),
    rule(6, 'inked-in bowl under a stem: 6', (f) =>
      f.massY >= 0.53 && f.hcross[4] >= 2 && f.upperX < 0.6 && f.ends.some((e) => e.y < 0.15 && e.dx > -0.5)),
    rule(2, 'hook to the left on a wide base: 2', (f) =>
      f.bottomBar >= 0.5 && f.ends.some((e) => e.y < 0.45 && e.x < 0.6 && e.dx < -0.5 && e.dy > -0.5)),
    rule(3, 'hook on top, bowl open to the left: 3', (f) =>
      f.massX > 0.5 && endsIn(f, 0, 1, 0, 0.4) > 0 && f.ends.some((e) => e.x < 0.3 && e.y > 0.55 && e.dx < -0.4 && e.dy < 0.3)),
    rule(7, 'a full-width bar, ink high: 7', (f) => f.topBar >= 0.8 && f.massY < 0.47),
    rule(5, 'a flag at the top right: 5', (f) =>
      f.ends.some((e) => e.x > 0.6 && e.y < 0.3 && e.dx > 0.7) && f.massY >= 0.45),
    rule(6, 'heavy bottom under a stem: 6', (f) =>
      f.massY >= 0.53 && f.bottomBar >= 0.7 && f.ends.some((e) => e.y < 0.2 && e.dx > -0.5)),

    // When nothing else fits, guess the plainest digit.
    rule(1, 'nothing else fits: 1', () => true),
  ];

  // Plain words for a position in the box.
  function where(x, y) {
    const v = y < 0.33 ? 'top' : y > 0.67 ? 'bottom' : '';
    const h = x < 0.33 ? 'left' : x > 0.67 ? 'right' : '';
    return v && h ? v + ' ' + h : v || h || 'middle';
  }

  // What the rulebook saw, in a few short lines.
  function describe(f) {
    const lines = [];
    if (f.loops === 0) lines.push('no loops');
    else if (f.loops === 1) {
      const y = f.holes[0].y;
      lines.push('1 loop, ' + (y < 0.4 ? 'in the upper half' : y > 0.6 ? 'in the lower half' : 'in the middle'));
    } else lines.push(f.loops + ' loops');
    const n = f.ends.length;
    let ends = n === 0 ? 'no stroke ends' : n === 1 ? '1 stroke end, at the ' + where(f.ends[0].x, f.ends[0].y) :
      n + ' stroke ends: ' + f.ends.map((e) => where(e.x, e.y)).join(', ');
    if (ends.length > 45) ends = n + ' stroke ends';
    lines.push(ends);
    if (f.bridges) lines.push(f.bridges === 1 ? 'a gap in a stroke was closed' : f.bridges + ' gaps in strokes were closed');
    return lines;
  }

  function decide(f) {
    const trace = describe(f);
    for (const rule of RULES) {
      if (rule.when(f)) { trace.push(rule.why); return { digit: rule.digit, trace }; }
    }
    return { digit: 1, trace };
  }

  // A few of the measurements, as plain numbers, for display.
  function summary(f) {
    const r2 = (v) => Math.round(v * 100) / 100;
    return {
      loops: f.loops,
      loopY: f.loops ? r2(f.holes[0].y) : -1,   // height of the first loop, 0 top .. 1 bottom; -1 if none
      strokeEnds: f.ends.length,
      junctions: f.junctions.length,
      gapsClosed: f.bridges,
      width: f.width,
      height: f.height,
      aspect: r2(f.aspect),                    // width / height
      inkHeight: r2(f.massY),                  // centre of the ink, 0 top .. 1 bottom
      topBar: r2(f.topBar),                    // longest stroke across the top quarter, share of the width
      bottomBar: r2(f.bottomBar),
      crossings: f.vmax,                       // most strokes one vertical line meets
      penWidth: r2(f.pen),                     // average stroke width in pixels
    };
  }

  // ---------------------------------------------------------------- api
  // classify(pixels): pixels is 28 x 28, row-major, 0..255, a light digit on
  // a dark ground (dark on light is turned round). Never throws.
  function classify(pixels) {
    try {
      const f = measure(pixels);
      if (!f) return { digit: 1, trace: ['no ink found', 'nothing to read: guess 1'], features: { loops: 0, strokeEnds: 0 } };
      const r = decide(f);
      return { digit: r.digit, trace: r.trace, features: summary(f) };
    } catch (e) {
      return { digit: 1, trace: ['could not read this drawing', 'guess 1'], features: { loops: 0, strokeEnds: 0 } };
    }
  }

  // The thinned skeleton the rules looked at, 28 x 28 of 0/1. (A digit drawn
  // far from the standard size is rescaled first, and so is its skeleton.)
  function skeleton(pixels) {
    const out = new Uint8Array(N * N);
    try {
      if (!prepare(pixels)) return out;
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) out[y * N + x] = sk[(y + 1) * W + x + 1];
    } catch (e) { /* return what we have */ }
    return out;
  }

  BL.rulebook = {
    classify,
    skeleton,
    RULE_COUNT: RULES.length,   // decision rules in the rulebook, the default guess included
    _measure: measure,          // every measurement, for debugging
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
