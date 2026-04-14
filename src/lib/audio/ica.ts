/**
 * FastICA — Blind Source Separation for stereo audio.
 *
 * Estimates a 2×2 unmixing matrix from signal statistics on a subsample
 * (for speed), then applies it to the full signal. Uses the fixed-point
 * algorithm (Hyvärinen 1999) with tanh as the non-linearity.
 *
 * Assignment: the component that correlates more strongly with (L+R)/2
 * is labelled "vocals" (matches the professional convention where lead
 * vocals are panned to centre); the other becomes "instrumental".
 *
 * Both outputs are mono signals scaled to match the original mid/side RMS.
 */

const MAX_SUB  = 30_000; // samples used for ICA parameter estimation
const MAX_ITER = 100;
const TOL      = 1e-6;

export interface ICAResult {
  vocalsData:       Float32Array; // the more centre-correlated IC
  instrumentalData: Float32Array; // the more side-correlated IC
}

export function applyICA(L: Float32Array, R: Float32Array): ICAResult {
  const N = L.length;

  // ── 1. Centre ──────────────────────────────────────────────────────────────
  const mL = arrayMean(L);
  const mR = arrayMean(R);
  const cL  = centred(L, mL);
  const cR  = centred(R, mR);

  // ── 2. Subsample for covariance / whitening estimation ─────────────────────
  const step = Math.max(1, Math.floor(N / MAX_SUB));
  const sN   = Math.floor(N / step);
  let covLL = 0, covLR = 0, covRR = 0;
  for (let i = 0; i < sN; i++) {
    const l = cL[i * step], r = cR[i * step];
    covLL += l * l;
    covLR += l * r;
    covRR += r * r;
  }
  covLL /= sN; covLR /= sN; covRR /= sN;

  // ── 3. Eigendecomposition of 2×2 covariance ────────────────────────────────
  const tr   = covLL + covRR;
  const disc = Math.sqrt(Math.max(0, tr * tr / 4 - (covLL * covRR - covLR * covLR)));
  const lam1 = tr / 2 + disc;
  const lam2 = Math.max(tr / 2 - disc, 1e-12);

  // Eigenvectors v = [b, λ−a] (mutually orthogonal for symmetric 2×2)
  let e1x: number, e1y: number, e2x: number, e2y: number;
  if (Math.abs(covLR) > 1e-10) {
    const n1 = Math.hypot(covLR, lam1 - covLL);
    const n2 = Math.hypot(covLR, lam2 - covLL);
    e1x = covLR / n1;  e1y = (lam1 - covLL) / n1;
    e2x = covLR / n2;  e2y = (lam2 - covLL) / n2;
  } else {
    if (covLL >= covRR) { e1x = 1; e1y = 0; e2x = 0; e2y = 1; }
    else               { e1x = 0; e1y = 1; e2x = 1; e2y = 0; }
  }

  // ── 4. Whitening matrix W = D^{−½} · Eᵀ ──────────────────────────────────
  const s1 = 1 / Math.sqrt(lam1), s2 = 1 / Math.sqrt(lam2);
  const W00 = s1 * e1x, W01 = s1 * e1y;
  const W10 = s2 * e2x, W11 = s2 * e2y;

  // Whiten subsampled data
  const zL = new Float32Array(sN);
  const zR = new Float32Array(sN);
  for (let i = 0; i < sN; i++) {
    const l = cL[i * step], r = cR[i * step];
    zL[i] = W00 * l + W01 * r;
    zR[i] = W10 * l + W11 * r;
  }

  // ── 5. FastICA fixed-point iteration (tanh non-linearity) ─────────────────
  // Find w1 — the unit vector whose projection on z has maximum non-Gaussianity.
  let w1x = 1 / Math.SQRT2, w1y = 1 / Math.SQRT2;
  for (let iter = 0; iter < MAX_ITER; iter++) {
    let nx = 0, ny = 0, gp = 0;
    for (let i = 0; i < sN; i++) {
      const u  = w1x * zL[i] + w1y * zR[i];
      const g  = Math.tanh(u);
      nx += zL[i] * g;
      ny += zR[i] * g;
      gp += 1 - g * g; // tanh'(u)
    }
    const gMean = gp / sN;
    const nwx = nx / sN - gMean * w1x;
    const nwy = ny / sN - gMean * w1y;
    const norm = Math.hypot(nwx, nwy);
    if (norm < 1e-12) break;
    const dot    = (nwx / norm) * w1x + (nwy / norm) * w1y;
    const change = Math.abs(Math.abs(dot) - 1);
    w1x = nwx / norm;
    w1y = nwy / norm;
    if (change < TOL) break;
  }
  // w2 is the orthogonal complement
  const w2x = -w1y, w2y = w1x;

  // ── 6. Combined unmixing: apply [w1; w2] · W to the full centred signal ───
  const A00 = w1x * W00 + w1y * W10,  A01 = w1x * W01 + w1y * W11;
  const A10 = w2x * W00 + w2y * W10,  A11 = w2x * W01 + w2y * W11;

  const ic1 = new Float32Array(N);
  const ic2 = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    ic1[i] = A00 * cL[i] + A01 * cR[i];
    ic2[i] = A10 * cL[i] + A11 * cR[i];
  }

  // ── 7. Assign labels: mid-correlated IC → vocals ───────────────────────────
  let dot1 = 0, dot2 = 0;
  for (let i = 0; i < N; i++) {
    const mid = cL[i] + cR[i]; // proportional to (L+R)/2
    dot1 += ic1[i] * mid;
    dot2 += ic2[i] * mid;
  }
  const [vocIC, instIC] = Math.abs(dot1) >= Math.abs(dot2) ? [ic1, ic2] : [ic2, ic1];

  // ── 8. Scale to match original mid/side RMS ────────────────────────────────
  rescale(vocIC,  channelRms(cL, cR, 'mid'));
  rescale(instIC, channelRms(cL, cR, 'side'));

  return { vocalsData: vocIC, instrumentalData: instIC };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function arrayMean(a: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return s / a.length;
}

function centred(a: Float32Array, m: number): Float32Array {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] - m;
  return out;
}

function channelRms(L: Float32Array, R: Float32Array, mode: 'mid' | 'side'): number {
  let s = 0;
  for (let i = 0; i < L.length; i++) {
    const v = mode === 'mid' ? (L[i] + R[i]) * 0.5 : (L[i] - R[i]) * 0.5;
    s += v * v;
  }
  return Math.sqrt(s / L.length);
}

function rescale(arr: Float32Array, targetRms: number): void {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i] * arr[i];
  const currentRms = Math.sqrt(s / arr.length);
  if (currentRms < 1e-10) return;
  const scale = targetRms / currentRms;
  for (let i = 0; i < arr.length; i++) arr[i] *= scale;
}
