/*
 * cnn.c: the Learner's forward and backward passes, in WebAssembly SIMD.
 *
 * Same network and the same arithmetic as ConvNet in assets/js/digits.js,
 * which stays the reference implementation (and the fallback when
 * WebAssembly is unavailable). Parameters and gradients cross the boundary
 * in the JS layout; inside, activations are channel-last so that the filters
 * of a layer fill SIMD lanes.
 *
 * Build: tools/build_wasm.sh
 */
#include <wasm_simd128.h>

#define F1 8
#define F2 16
#define K 25
#define NW1 (F1 * K)
#define NW2 (F2 * F1 * K)
#define NW3 (10 * F2 * 16)
#define OB1 NW1
#define OW2 (OB1 + F1)
#define OB2 (OW2 + NW2)
#define OW3 (OB2 + F2)
#define OB3 (OW3 + NW3)
#define NP (OB3 + 10)
#define MAXB 256

typedef float f32;

/* shared with JS */
f32 P[NP];                    /* parameters, JS layout */
f32 G[NP];                    /* gradients, JS layout */
unsigned char X[MAXB * 784];  /* a batch of images */
unsigned char Y[MAXB];        /* their labels */
int PRED[MAXB];               /* predictions */

/* parameters, rearranged for SIMD */
static f32 W1T[K][F1] __attribute__((aligned(16)));          /* [tap][f] */
static f32 W2T[K][F1][F2] __attribute__((aligned(16)));      /* [tap][c][f2] */
static f32 W2B[K][F2][F1] __attribute__((aligned(16)));      /* [tap][f2][c] */
static f32 W3T[10][16][F2] __attribute__((aligned(16)));     /* [k][pos][f2] */

/* gradient accumulators, same layouts */
static f32 GW1T[K][F1] __attribute__((aligned(16)));
static f32 GB1[F1] __attribute__((aligned(16)));
static f32 GW2T[K][F1][F2] __attribute__((aligned(16)));
static f32 GB2[F2] __attribute__((aligned(16)));
static f32 GW3T[10][16][F2] __attribute__((aligned(16)));
static f32 GB3[10];

/* activations, channel-last */
static f32 XIN[28 * 28] __attribute__((aligned(16)));
static f32 A1[24][24][F1] __attribute__((aligned(16)));
static f32 Q1[12][12][F1] __attribute__((aligned(16)));
static int I1[12][12][F1];
static f32 A2[8][8][F2] __attribute__((aligned(16)));
static f32 Q2[16][F2] __attribute__((aligned(16)));
static int I2[16][F2];
static f32 Z[10];
static f32 DQ2[16][F2] __attribute__((aligned(16)));
static f32 DA2[8][8][F2] __attribute__((aligned(16)));
static f32 DQ1[12][12][F1] __attribute__((aligned(16)));
static f32 DA1[24][24][F1] __attribute__((aligned(16)));

#define LD(p) wasm_v128_load(p)
#define ST(p, v) wasm_v128_store(p, v)
#define ADD wasm_f32x4_add
#define MUL wasm_f32x4_mul
#define SPLAT wasm_f32x4_splat

static inline v128_t relu(v128_t v) { return wasm_f32x4_pmax(v, SPLAT(0.0f)); }

/* exp(x) without libc: 2^(x log2 e), split into integer and fraction. */
static inline f32 expf_(f32 x) {
  if (x < -87.0f) return 0.0f;
  if (x > 88.0f) x = 88.0f;
  f32 t = x * 1.4426950408889634f;
  f32 n = __builtin_floorf(t + 0.5f);
  f32 f = (t - n) * 0.6931471805599453f; /* in [-0.35, 0.35] */
  f32 p = 1.0f + f * (1.0f + f * (0.5f + f * (1.0f / 6 + f * (1.0f / 24 + f * (1.0f / 120 + f * (1.0f / 720 + f * (1.0f / 5040)))))));
  union { f32 f; int i; } u;
  u.i = ((int)n + 127) << 23;
  return p * u.f;
}

/* Bring the JS-layout parameters in P into the SIMD layouts. */
void prepare(void) {
  for (int f = 0; f < F1; f++)
    for (int t = 0; t < K; t++) W1T[t][f] = P[f * K + t];
  for (int f2 = 0; f2 < F2; f2++)
    for (int c = 0; c < F1; c++)
      for (int t = 0; t < K; t++) {
        f32 w = P[OW2 + (f2 * F1 + c) * K + t];
        W2T[t][c][f2] = w;
        W2B[t][f2][c] = w;
      }
  for (int k = 0; k < 10; k++)
    for (int f2 = 0; f2 < F2; f2++)
      for (int p = 0; p < 16; p++) W3T[k][p][f2] = P[OW3 + k * F2 * 16 + f2 * 16 + p];
}

void zero_grads(void) {
  f32 *ps[] = { &GW1T[0][0], GB1, &GW2T[0][0][0], GB2, &GW3T[0][0][0], GB3 };
  int ns[] = { K * F1, F1, K * F1 * F2, F2, 10 * 16 * F2, 10 };
  for (int j = 0; j < 6; j++)
    for (int i = 0; i < ns[j]; i++) ps[j][i] = 0.0f;
}

/* Gradient accumulators back into the JS layout, in G. */
void export_grads(void) {
  for (int f = 0; f < F1; f++)
    for (int t = 0; t < K; t++) G[f * K + t] = GW1T[t][f];
  for (int f = 0; f < F1; f++) G[OB1 + f] = GB1[f];
  for (int f2 = 0; f2 < F2; f2++)
    for (int c = 0; c < F1; c++)
      for (int t = 0; t < K; t++) G[OW2 + (f2 * F1 + c) * K + t] = GW2T[t][c][f2];
  for (int f2 = 0; f2 < F2; f2++) G[OB2 + f2] = GB2[f2];
  for (int k = 0; k < 10; k++)
    for (int f2 = 0; f2 < F2; f2++)
      for (int p = 0; p < 16; p++) G[OW3 + k * F2 * 16 + f2 * 16 + p] = GW3T[k][p][f2];
  for (int k = 0; k < 10; k++) G[OB3 + k] = GB3[k];
}

static void forward(const unsigned char *img) {
  for (int i = 0; i < 784; i++) XIN[i] = img[i] * (1.0f / 255.0f);
  /* conv1 + ReLU: eight filters in two vectors */
  const v128_t b10 = LD(P + OB1), b11 = LD(P + OB1 + 4);
  for (int y = 0; y < 24; y++) {
    for (int x = 0; x < 24; x++) {
      v128_t a0 = b10, a1 = b11;
      for (int ky = 0; ky < 5; ky++) {
        const f32 *row = XIN + (y + ky) * 28 + x;
        for (int kx = 0; kx < 5; kx++) {
          const f32 v = row[kx];
          if (v == 0.0f) continue; /* most of a digit is background */
          const v128_t s = SPLAT(v);
          const f32 *w = W1T[ky * 5 + kx];
          a0 = ADD(a0, MUL(s, LD(w)));
          a1 = ADD(a1, MUL(s, LD(w + 4)));
        }
      }
      ST(A1[y][x], relu(a0));
      ST(A1[y][x] + 4, relu(a1));
    }
  }
  /* pool1: 2x2 max, remembering where the max came from */
  for (int y = 0; y < 12; y++)
    for (int x = 0; x < 12; x++)
      for (int c = 0; c < F1; c++) {
        int by = 2 * y, bx = 2 * x;
        f32 best = A1[by][bx][c]; int bi = (by * 24 + bx) * F1 + c;
        f32 v;
        v = A1[by][bx + 1][c]; if (v > best) { best = v; bi = (by * 24 + bx + 1) * F1 + c; }
        v = A1[by + 1][bx][c]; if (v > best) { best = v; bi = ((by + 1) * 24 + bx) * F1 + c; }
        v = A1[by + 1][bx + 1][c]; if (v > best) { best = v; bi = ((by + 1) * 24 + bx + 1) * F1 + c; }
        Q1[y][x][c] = best; I1[y][x][c] = bi;
      }
  /* conv2 + ReLU: sixteen filters in four vectors */
  for (int y = 0; y < 8; y++) {
    for (int x = 0; x < 8; x++) {
      v128_t a0 = LD(P + OB2), a1 = LD(P + OB2 + 4), a2 = LD(P + OB2 + 8), a3 = LD(P + OB2 + 12);
      for (int ky = 0; ky < 5; ky++) {
        for (int kx = 0; kx < 5; kx++) {
          const f32 *q = Q1[y + ky][x + kx];
          const f32 *w = &W2T[ky * 5 + kx][0][0];
          for (int c = 0; c < F1; c++) {
            const f32 v = q[c];
            if (v == 0.0f) continue;
            const v128_t s = SPLAT(v);
            const f32 *wc = w + c * F2;
            a0 = ADD(a0, MUL(s, LD(wc)));
            a1 = ADD(a1, MUL(s, LD(wc + 4)));
            a2 = ADD(a2, MUL(s, LD(wc + 8)));
            a3 = ADD(a3, MUL(s, LD(wc + 12)));
          }
        }
      }
      ST(A2[y][x], relu(a0)); ST(A2[y][x] + 4, relu(a1));
      ST(A2[y][x] + 8, relu(a2)); ST(A2[y][x] + 12, relu(a3));
    }
  }
  /* pool2 */
  for (int y = 0; y < 4; y++)
    for (int x = 0; x < 4; x++)
      for (int c = 0; c < F2; c++) {
        int by = 2 * y, bx = 2 * x;
        f32 best = A2[by][bx][c]; int bi = (by * 8 + bx) * F2 + c;
        f32 v;
        v = A2[by][bx + 1][c]; if (v > best) { best = v; bi = (by * 8 + bx + 1) * F2 + c; }
        v = A2[by + 1][bx][c]; if (v > best) { best = v; bi = ((by + 1) * 8 + bx) * F2 + c; }
        v = A2[by + 1][bx + 1][c]; if (v > best) { best = v; bi = ((by + 1) * 8 + bx + 1) * F2 + c; }
        Q2[y * 4 + x][c] = best; I2[y * 4 + x][c] = bi;
      }
  /* fully connected */
  for (int k = 0; k < 10; k++) {
    v128_t acc = SPLAT(0.0f);
    for (int p = 0; p < 16; p++) {
      const f32 *w = W3T[k][p], *q = Q2[p];
      acc = ADD(acc, MUL(LD(w), LD(q)));
      acc = ADD(acc, MUL(LD(w + 4), LD(q + 4)));
      acc = ADD(acc, MUL(LD(w + 8), LD(q + 8)));
      acc = ADD(acc, MUL(LD(w + 12), LD(q + 12)));
    }
    Z[k] = P[OB3 + k] + wasm_f32x4_extract_lane(acc, 0) + wasm_f32x4_extract_lane(acc, 1) +
           wasm_f32x4_extract_lane(acc, 2) + wasm_f32x4_extract_lane(acc, 3);
  }
}

static void backward(int label) {
  /* softmax, then dL/dz */
  f32 m = Z[0];
  for (int k = 1; k < 10; k++) if (Z[k] > m) m = Z[k];
  f32 sum = 0.0f;
  for (int k = 0; k < 10; k++) { Z[k] = expf_(Z[k] - m); sum += Z[k]; }
  for (int k = 0; k < 10; k++) Z[k] = Z[k] / sum - (k == label ? 1.0f : 0.0f);
  /* fully connected */
  for (int p = 0; p < 16; p++) {
    v128_t d0 = SPLAT(0.0f), d1 = d0, d2 = d0, d3 = d0;
    const f32 *q = Q2[p];
    const v128_t q0 = LD(q), q1 = LD(q + 4), q2 = LD(q + 8), q3 = LD(q + 12);
    for (int k = 0; k < 10; k++) {
      const v128_t s = SPLAT(Z[k]);
      f32 *gw = GW3T[k][p];
      const f32 *w = W3T[k][p];
      ST(gw, ADD(LD(gw), MUL(s, q0))); ST(gw + 4, ADD(LD(gw + 4), MUL(s, q1)));
      ST(gw + 8, ADD(LD(gw + 8), MUL(s, q2))); ST(gw + 12, ADD(LD(gw + 12), MUL(s, q3)));
      d0 = ADD(d0, MUL(s, LD(w))); d1 = ADD(d1, MUL(s, LD(w + 4)));
      d2 = ADD(d2, MUL(s, LD(w + 8))); d3 = ADD(d3, MUL(s, LD(w + 12)));
    }
    ST(DQ2[p], d0); ST(DQ2[p] + 4, d1); ST(DQ2[p] + 8, d2); ST(DQ2[p] + 12, d3);
  }
  for (int k = 0; k < 10; k++) GB3[k] += Z[k];
  /* pool2 and ReLU */
  f32 *da2 = &DA2[0][0][0];
  for (int i = 0; i < 64 * F2; i++) da2[i] = 0.0f;
  const f32 *a2 = &A2[0][0][0];
  for (int p = 0; p < 16; p++)
    for (int c = 0; c < F2; c++) { int j = I2[p][c]; if (a2[j] > 0.0f) da2[j] += DQ2[p][c]; }
  /* conv2: weight and input gradients */
  f32 *dq1 = &DQ1[0][0][0];
  for (int i = 0; i < 144 * F1; i++) dq1[i] = 0.0f;
  v128_t gb0 = LD(GB2), gb1 = LD(GB2 + 4), gb2 = LD(GB2 + 8), gb3 = LD(GB2 + 12);
  for (int y = 0; y < 8; y++) {
    for (int x = 0; x < 8; x++) {
      const f32 *d = DA2[y][x];
      const v128_t d0 = LD(d), d1 = LD(d + 4), d2 = LD(d + 8), d3 = LD(d + 12);
      if (!wasm_v128_any_true(wasm_v128_or(wasm_v128_or(d0, d1), wasm_v128_or(d2, d3)))) continue;
      gb0 = ADD(gb0, d0); gb1 = ADD(gb1, d1); gb2 = ADD(gb2, d2); gb3 = ADD(gb3, d3);
      for (int ky = 0; ky < 5; ky++) {
        for (int kx = 0; kx < 5; kx++) {
          const int t = ky * 5 + kx;
          const f32 *q = Q1[y + ky][x + kx];
          /* weight gradient: vectors over output filters */
          for (int c = 0; c < F1; c++) {
            const f32 v = q[c];
            if (v == 0.0f) continue;
            const v128_t s = SPLAT(v);
            f32 *g = GW2T[t][c];
            ST(g, ADD(LD(g), MUL(s, d0))); ST(g + 4, ADD(LD(g + 4), MUL(s, d1)));
            ST(g + 8, ADD(LD(g + 8), MUL(s, d2))); ST(g + 12, ADD(LD(g + 12), MUL(s, d3)));
          }
          /* input gradient: vectors over input channels */
          f32 *dq = DQ1[y + ky][x + kx];
          v128_t e0 = LD(dq), e1 = LD(dq + 4);
          for (int f2 = 0; f2 < F2; f2++) {
            const f32 df = d[f2];
            if (df == 0.0f) continue;
            const v128_t s = SPLAT(df);
            const f32 *w = W2B[t][f2];
            e0 = ADD(e0, MUL(s, LD(w)));
            e1 = ADD(e1, MUL(s, LD(w + 4)));
          }
          ST(dq, e0); ST(dq + 4, e1);
        }
      }
    }
  }
  ST(GB2, gb0); ST(GB2 + 4, gb1); ST(GB2 + 8, gb2); ST(GB2 + 12, gb3);
  /* pool1 and ReLU */
  f32 *da1 = &DA1[0][0][0];
  for (int i = 0; i < 576 * F1; i++) da1[i] = 0.0f;
  const f32 *a1 = &A1[0][0][0];
  for (int y = 0; y < 12; y++)
    for (int x = 0; x < 12; x++)
      for (int c = 0; c < F1; c++) { int j = I1[y][x][c]; if (a1[j] > 0.0f) da1[j] += DQ1[y][x][c]; }
  /* conv1 weight gradient */
  v128_t gc0 = LD(GB1), gc1 = LD(GB1 + 4);
  for (int y = 0; y < 24; y++) {
    for (int x = 0; x < 24; x++) {
      const v128_t d0 = LD(DA1[y][x]), d1 = LD(DA1[y][x] + 4);
      if (!wasm_v128_any_true(wasm_v128_or(d0, d1))) continue;
      gc0 = ADD(gc0, d0); gc1 = ADD(gc1, d1);
      for (int ky = 0; ky < 5; ky++) {
        const f32 *row = XIN + (y + ky) * 28 + x;
        for (int kx = 0; kx < 5; kx++) {
          const f32 v = row[kx];
          if (v == 0.0f) continue;
          const v128_t s = SPLAT(v);
          f32 *g = GW1T[ky * 5 + kx];
          ST(g, ADD(LD(g), MUL(s, d0)));
          ST(g + 4, ADD(LD(g + 4), MUL(s, d1)));
        }
      }
    }
  }
  ST(GB1, gc0); ST(GB1 + 4, gc1);
}

/* Accumulate gradients over the first n images in X. */
void train(int n) {
  for (int i = 0; i < n; i++) {
    forward(X + i * 784);
    backward(Y[i]);
  }
}

/* Predicted digit for each of the first n images in X, into PRED. */
void predict(int n) {
  for (int i = 0; i < n; i++) {
    forward(X + i * 784);
    int b = 0;
    for (int k = 1; k < 10; k++) if (Z[k] > Z[b]) b = k;
    PRED[i] = b;
  }
}

int param_count(void) { return NP; }
int max_batch(void) { return MAXB; }
f32 *params(void) { return P; }
f32 *grads(void) { return G; }
unsigned char *images(void) { return X; }
unsigned char *labels(void) { return Y; }
int *preds(void) { return PRED; }
