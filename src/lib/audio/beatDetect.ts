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
 * Trims a matched pair of instrumental + vocal tracks to beat 1 using only
 * the instrumental's beat-phase as the reference.
 *
 * Beat-phase detection relies on onset energy (drum hits, transients). Vocal
 * stems have no percussion, so their phase estimate is unreliable and often
 * differs from the instrumental's by tens of milliseconds. Applying a
 * different trim to each track causes the two stems to drift apart at every
 * section boundary. This function detects the phase once from the
 * instrumental (which has clear rhythmic transients) and applies the exact
 * same trim to both tracks — keeping them sample-accurate.
 *
 * If the instrumental has no detectable pre-beat content (< 20 ms offset)
 * neither track is modified.
 *
 * If the two tracks have different leading silence (e.g. from a stem
 * separator that gave them different offsets), the vocal is padded at the
 * front to bring its beat 1 into alignment with the trimmed instrumental's.
 */
export async function trimPairToDownbeat(
  instUrl: string,
  vocUrl:  string,
  tempo:   number,
): Promise<{ instUrl: string; vocUrl: string; trimmedMs: number }> {
  const ctx = new AudioContext();
  const [instBuf, vocBuf] = await Promise.all([
    fetch(instUrl).then(r => r.arrayBuffer()).then(ab => ctx.decodeAudioData(ab)),
    fetch(vocUrl) .then(r => r.arrayBuffer()).then(ab => ctx.decodeAudioData(ab)),
  ]);
  await ctx.close();

  const beatPeriodMs = 60000 / tempo;
  const instPhaseMs  = detectBeatPhaseMs(instBuf, tempo);

  if (instPhaseMs < 20 || instPhaseMs > beatPeriodMs * 0.9) {
    // Instrumental already starts at (or very close to) beat 1 — nothing to trim.
    // Still check if the vocal has extra leading silence relative to the instrumental
    // and pad the instrumental to compensate (fill in with silence as requested).
    const vocPhaseMs = detectBeatPhaseMs(vocBuf, tempo);
    const diffMs = vocPhaseMs - instPhaseMs; // positive → vocal starts beat 1 later
    if (diffMs >= 20 && diffMs <= beatPeriodMs * 0.9) {
      // Vocal has more pre-beat content than instrumental → trim vocal to match
      const trimmed = await trimBufferByMs(vocBuf, diffMs);
      return { instUrl, vocUrl: URL.createObjectURL(encodeWavBlob(trimmed)), trimmedMs: 0 };
    }
    return { instUrl, vocUrl, trimmedMs: 0 };
  }

  // Trim both tracks by the instrumental's detected beat-phase offset.
  const [newInst, newVoc] = await Promise.all([
    trimBufferByMs(instBuf, instPhaseMs),
    trimBufferByMs(vocBuf,  instPhaseMs),
  ]);

  return {
    instUrl:   URL.createObjectURL(encodeWavBlob(newInst)),
    vocUrl:    URL.createObjectURL(encodeWavBlob(newVoc)),
    trimmedMs: instPhaseMs,
  };
}

async function trimBufferByMs(buf: AudioBuffer, ms: number): Promise<AudioBuffer> {
  const trimSamples = Math.round((ms / 1000) * buf.sampleRate);
  const newLength   = buf.length - trimSamples;
  if (newLength <= 0) return buf;
  const offline = new OfflineAudioContext(buf.numberOfChannels, newLength, buf.sampleRate);
  const src     = offline.createBufferSource();
  src.buffer    = buf;
  src.connect(offline.destination);
  src.start(0, ms / 1000);
  return offline.startRendering();
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
 * Snaps each section start ratio to the nearest bar boundary (every 4 beats).
 *
 * Bar boundaries are at: beatPhaseMs + n * 4 * beatDurationMs  (n = 0, 1, 2, …)
 *
 * This keeps section markers aligned with bar-number labels in the timeline.
 *
 * Rules:
 * - Section 0 always stays at 0 (song start, before beat 1).
 * - Each subsequent section snaps to the closest bar boundary
 *   that is still strictly after the previous snapped boundary.
 */
export function snapSectionsToPhrases(
  rawRatios: number[],
  audioDurationMs: number,
  beatPhaseMs: number,
  tempo: number,
): number[] {
  if (rawRatios.length === 0 || audioDurationMs <= 0) return rawRatios;

  const beatDurationMs = 60000 / tempo;
  const barDurationMs  = 4 * beatDurationMs; // one bar = 4 beats

  const snapped: number[] = [0]; // section 0 always at start

  for (let i = 1; i < rawRatios.length; i++) {
    const rawMs         = rawRatios[i] * audioDurationMs;
    const prevSnappedMs = snapped[i - 1] * audioDurationMs;

    // Which bar boundary is closest to rawMs?
    const relativeMs = rawMs - beatPhaseMs;
    const n = Math.floor(relativeMs / barDurationMs);

    // Candidates: bar just before and bar just after rawMs
    const candidates = [
      beatPhaseMs + n       * barDurationMs,
      beatPhaseMs + (n + 1) * barDurationMs,
    ].filter(ms => ms > prevSnappedMs && ms >= 0);

    let snappedMs: number;
    if (candidates.length === 0) {
      // Fallback: next bar boundary after prevSnappedMs
      const fallbackN = Math.ceil((prevSnappedMs - beatPhaseMs) / barDurationMs) + 1;
      snappedMs = beatPhaseMs + fallbackN * barDurationMs;
    } else {
      snappedMs = candidates.reduce((best, c) =>
        Math.abs(c - rawMs) < Math.abs(best - rawMs) ? c : best,
      );
    }

    snapped.push(Math.min(1, snappedMs / audioDurationMs));
  }

  return snapped;
}
