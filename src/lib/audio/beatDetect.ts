/**
 * Beat phase detection and phrase-boundary snapping.
 *
 * Given an AudioBuffer and a known tempo (BPM), finds where beat 1 falls
 * in the audio (the "phase offset"), then snaps section start times to the
 * nearest 4-beat phrase boundary. Because 8 and 16 beat phrases are
 * multiples of 4, a 4-beat grid satisfies all three phrase lengths.
 */

/**
 * Returns the time in milliseconds of the first beat-1 in the audio.
 * Uses onset-strength template matching: slides a pulse train at the
 * known tempo across the onset-strength signal and finds the phase that
 * maximises the sum of onset energy at each beat position.
 */
export function detectBeatPhaseMs(audioBuffer: AudioBuffer, tempo: number): number {
  const { sampleRate } = audioBuffer;
  const data = audioBuffer.getChannelData(0);

  // ~10ms hop — enough resolution without excessive computation
  const hopSamples = Math.max(1, Math.round(sampleRate * 0.01));
  const numHops = Math.floor(data.length / hopSamples);

  // Short-time RMS energy per hop
  const energy = new Float32Array(numHops);
  for (let h = 0; h < numHops; h++) {
    let sum = 0;
    const base = h * hopSamples;
    for (let i = 0; i < hopSamples; i++) {
      const s = data[base + i] ?? 0;
      sum += s * s;
    }
    energy[h] = Math.sqrt(sum / hopSamples);
  }

  // Half-wave rectified first difference → onset strength
  const onset = new Float32Array(numHops);
  for (let h = 1; h < numHops; h++) {
    onset[h] = Math.max(0, energy[h] - energy[h - 1]);
  }

  // Beat period expressed in hops
  const beatPeriodHops = (60 / tempo) * (sampleRate / hopSamples);
  const numPhases = Math.ceil(beatPeriodHops);

  // Find phase (0..beatPeriod) that maximises onset energy at beat positions
  let bestPhase = 0;
  let bestScore = -1;

  for (let phase = 0; phase < numPhases; phase++) {
    let score = 0;
    let h = phase;
    while (h < numHops) {
      score += onset[Math.round(h)];
      h += beatPeriodHops;
    }
    if (score > bestScore) {
      bestScore = score;
      bestPhase = phase;
    }
  }

  return (bestPhase * hopSamples / sampleRate) * 1000;
}

/**
 * Snaps each section start ratio to the nearest 4-beat phrase boundary.
 *
 * Rules:
 * - Section 0 always stays at 0 (song start is already beat 1).
 * - Each subsequent section snaps to the closest 4-beat boundary
 *   that is still strictly after the previous snapped boundary.
 * - We never snap backward past the previous section.
 */
export function snapSectionsToPhrases(
  rawRatios: number[],
  audioDurationMs: number,
  beatPhaseMs: number,
  tempo: number,
): number[] {
  if (rawRatios.length === 0 || audioDurationMs <= 0) return rawRatios;

  const beatDurationMs = 60000 / tempo;
  const phraseDurationMs = 4 * beatDurationMs; // 4-beat grid (LCM of 4/8/16)

  const snapped: number[] = [0]; // section 0 always at start

  for (let i = 1; i < rawRatios.length; i++) {
    const rawMs = rawRatios[i] * audioDurationMs;
    const prevSnappedMs = snapped[i - 1] * audioDurationMs;

    // How many full phrases fit between beatPhaseMs and rawMs?
    const relativeMs = rawMs - beatPhaseMs;
    const n = Math.floor(relativeMs / phraseDurationMs);

    // Candidate boundaries: the phrase just before and just after rawMs
    const candidates = [
      beatPhaseMs + n * phraseDurationMs,
      beatPhaseMs + (n + 1) * phraseDurationMs,
    ].filter(ms => ms > prevSnappedMs && ms >= 0);

    let snappedMs: number;
    if (candidates.length === 0) {
      // Fallback: just use the next phrase boundary after prevSnappedMs
      const fallbackN = Math.ceil((prevSnappedMs - beatPhaseMs) / phraseDurationMs) + 1;
      snappedMs = beatPhaseMs + fallbackN * phraseDurationMs;
    } else {
      // Pick closest candidate to rawMs
      snappedMs = candidates.reduce((best, c) =>
        Math.abs(c - rawMs) < Math.abs(best - rawMs) ? c : best
      );
    }

    snapped.push(Math.min(1, snappedMs / audioDurationMs));
  }

  return snapped;
}
