/**
 * Beat phase detection and phrase-boundary snapping.
 *
 * Given an AudioBuffer and a known tempo (BPM), finds where beat 1 falls
 * in the audio (the "phase offset"), then snaps section start times to the
 * nearest 4-beat phrase boundary. Because 8 and 16 beat phrases are
 * multiples of 4, a 4-beat grid satisfies all three phrase lengths.
 */

/**
 * Trims a newly-generated section clip so it starts at beat 1.
 *
 * The model often outputs a short pickup (silence or a pickup note) before
 * the downbeat. We detect beat phase in the new clip independently, then
 * remove exactly that many samples so the clip's first sample aligns with
 * beat 1. The trimmed ms is returned so callers can shift word timestamps.
 *
 * Limits:
 *  - Won't trim less than 20 ms (already aligned)
 *  - Won't trim more than one beat period (something's wrong if we'd need more)
 */
export async function trimToDownbeat(
  audioUrl: string,
  tempo: number,
): Promise<{ url: string; trimmedMs: number }> {
  const arrayBuf = await fetch(audioUrl).then(r => r.arrayBuffer());
  const ctx = new AudioContext();
  const audioBuf = await ctx.decodeAudioData(arrayBuf);
  await ctx.close();

  const beatPeriodMs = 60000 / tempo;
  const beatPhaseMs  = detectBeatPhaseMs(audioBuf, tempo);

  // Skip trimming if the offset is negligible or suspiciously large
  if (beatPhaseMs < 20 || beatPhaseMs > beatPeriodMs * 0.9) {
    return { url: audioUrl, trimmedMs: 0 };
  }

  const { sampleRate, numberOfChannels, length } = audioBuf;
  const trimSamples = Math.round((beatPhaseMs / 1000) * sampleRate);
  const newLength   = length - trimSamples;
  if (newLength <= 0) return { url: audioUrl, trimmedMs: 0 };

  const offline = new OfflineAudioContext(numberOfChannels, newLength, sampleRate);
  const source  = offline.createBufferSource();
  source.buffer = audioBuf;
  source.connect(offline.destination);
  source.start(0, beatPhaseMs / 1000);

  const rendered = await offline.startRendering();
  return { url: URL.createObjectURL(encodeWavBlob(rendered)), trimmedMs: beatPhaseMs };
}

function encodeWavBlob(buffer: AudioBuffer): Blob {
  const { numberOfChannels, sampleRate, length } = buffer;
  const bytesPerSample = 2;
  const blockAlign     = numberOfChannels * bytesPerSample;
  const dataSize       = length * blockAlign;
  const wav  = new ArrayBuffer(44 + dataSize);
  const view = new DataView(wav);
  const str  = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true);
  str(8, 'WAVE'); str(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, numberOfChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true); view.setUint16(34, bytesPerSample * 8, true);
  str(36, 'data'); view.setUint32(40, dataSize, true);
  let off = 44;
  for (let i = 0; i < length; i++) {
    for (let ch = 0; ch < numberOfChannels; ch++) {
      const s = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return new Blob([wav], { type: 'audio/wav' });
}

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
