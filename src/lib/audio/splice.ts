import type { WordTimestamp } from '../types';

export interface SpliceResult {
  audioUrl: string;
  wordTimestamps: WordTimestamp[];
}

const CROSSFADE_SECONDS = 0.3;

/**
 * Replaces a section of the full audio (defined by start/end ratios 0–1) with new
 * section audio, crossfading at both boundaries. Returns a blob URL to a WAV file.
 *
 * Equal-power crossfade: sin/cos curves preserve perceived loudness at the blend point.
 */
export async function spliceSection(
  fullAudioUrl: string,
  fullWordTimestamps: WordTimestamp[],
  sectionStartRatio: number,
  sectionEndRatio: number,
  newSectionAudioUrl: string,
  newSectionWordTimestamps: WordTimestamp[],
): Promise<SpliceResult> {
  const [fullArray, newArray] = await Promise.all([
    fetch(fullAudioUrl).then(r => r.arrayBuffer()),
    fetch(newSectionAudioUrl).then(r => r.arrayBuffer()),
  ]);

  const ctx = new AudioContext();
  const [fullBuf, newBuf] = await Promise.all([
    ctx.decodeAudioData(fullArray),
    ctx.decodeAudioData(newArray),
  ]);
  await ctx.close();

  const { sampleRate, numberOfChannels } = fullBuf;
  const startSample = Math.floor(sectionStartRatio * fullBuf.length);
  const endSample = Math.floor(sectionEndRatio * fullBuf.length);

  // Clamp crossfade so it never exceeds half the before/after segments or 25% of the new section
  const crossfadeSamples = Math.max(0, Math.min(
    Math.floor(CROSSFADE_SECONDS * sampleRate),
    Math.floor(startSample / 2),
    Math.floor((fullBuf.length - endSample) / 2),
    Math.floor(newBuf.length / 4),
  ));

  // Output = clean-before + start-crossfade + new-middle + end-crossfade + clean-after
  // The two crossfades overlap with their neighbours, so total shrinks by 2 * crossfadeSamples
  const outputLen =
    (startSample - crossfadeSamples) +
    crossfadeSamples +
    Math.max(0, newBuf.length - 2 * crossfadeSamples) +
    crossfadeSamples +
    (fullBuf.length - endSample - crossfadeSamples);

  const outBuf = new AudioBuffer({ numberOfChannels, length: outputLen, sampleRate });

  for (let ch = 0; ch < numberOfChannels; ch++) {
    const out = outBuf.getChannelData(ch);
    const full = fullBuf.getChannelData(ch);
    const newCh = ch < newBuf.numberOfChannels ? newBuf.getChannelData(ch) : newBuf.getChannelData(0);

    let outPos = 0;

    // 1. Clean before segment
    const cleanBeforeLen = startSample - crossfadeSamples;
    out.set(full.subarray(0, cleanBeforeLen), outPos);
    outPos += cleanBeforeLen;

    // 2. Start crossfade: full fades out, new section fades in
    for (let i = 0; i < crossfadeSamples; i++) {
      const t = i / crossfadeSamples;
      const fadeOut = Math.cos(t * Math.PI / 2); // equal-power
      const fadeIn  = Math.sin(t * Math.PI / 2);
      out[outPos + i] = full[startSample - crossfadeSamples + i] * fadeOut + newCh[i] * fadeIn;
    }
    outPos += crossfadeSamples;

    // 3. Middle of new section (full volume)
    const newMiddleLen = Math.max(0, newBuf.length - 2 * crossfadeSamples);
    out.set(newCh.subarray(crossfadeSamples, crossfadeSamples + newMiddleLen), outPos);
    outPos += newMiddleLen;

    // 4. End crossfade: new section fades out, after-segment fades in
    for (let i = 0; i < crossfadeSamples; i++) {
      const t = i / crossfadeSamples;
      const fadeOut = Math.cos(t * Math.PI / 2);
      const fadeIn  = Math.sin(t * Math.PI / 2);
      out[outPos + i] = newCh[newBuf.length - crossfadeSamples + i] * fadeOut + full[endSample + i] * fadeIn;
    }
    outPos += crossfadeSamples;

    // 5. Clean after segment
    out.set(full.subarray(endSample + crossfadeSamples), outPos);
  }

  // Rebuild word timestamps
  const crossfadeMs       = (crossfadeSamples / sampleRate) * 1000;
  const fullDurationMs    = fullBuf.duration * 1000;
  const sectionStartMs    = sectionStartRatio * fullDurationMs;
  const oldSectionDurMs   = (sectionEndRatio - sectionStartRatio) * fullDurationMs;
  const newSectionDurMs   = newBuf.duration * 1000;

  // Timestamps before the section are unchanged
  const beforeTs = fullWordTimestamps.filter(w => w.end_ms <= sectionStartMs);

  // New section timestamps are offset to where the crossfade begins
  const newTsOffset = sectionStartMs - crossfadeMs;
  const newTs = newSectionWordTimestamps.map(w => ({
    word:     w.word,
    start_ms: w.start_ms + newTsOffset,
    end_ms:   w.end_ms   + newTsOffset,
  }));

  // After-section timestamps shift by (new duration − old duration − crossfade overlap)
  const drift = newSectionDurMs - oldSectionDurMs - crossfadeMs;
  const afterTs = fullWordTimestamps
    .filter(w => w.start_ms >= sectionStartMs + oldSectionDurMs)
    .map(w => ({ word: w.word, start_ms: w.start_ms + drift, end_ms: w.end_ms + drift }));

  return {
    audioUrl: encodeWav(outBuf),
    wordTimestamps: [...beforeTs, ...newTs, ...afterTs],
  };
}

/**
 * Vocal-isolation splice: replaces only the center (vocal) channel of a section
 * using mid-side processing, preserving the original stereo instruments.
 *
 * Strategy:
 *   Mid   = (L + R) / 2  → center content (vocals, mono bass, kick)
 *   Side  = (L − R) / 2  → stereo content (panned guitars, synths, pads)
 *
 * We keep the original Side (stereo instruments) and replace Mid with the
 * center content of the new vocals-focused generation, then decode back:
 *   newL = newMid + originalSide
 *   newR = newMid − originalSide
 *
 * Falls back to spliceSection when original audio is mono.
 */
export async function spliceVocals(
  fullAudioUrl: string,
  fullWordTimestamps: WordTimestamp[],
  sectionStartRatio: number,
  sectionEndRatio: number,
  newVocalsAudioUrl: string,
  newSectionWordTimestamps: WordTimestamp[],
): Promise<SpliceResult> {
  const [fullArray, newArray] = await Promise.all([
    fetch(fullAudioUrl).then(r => r.arrayBuffer()),
    fetch(newVocalsAudioUrl).then(r => r.arrayBuffer()),
  ]);

  const ctx = new AudioContext();
  const [fullBuf, newBuf] = await Promise.all([
    ctx.decodeAudioData(fullArray),
    ctx.decodeAudioData(newArray),
  ]);
  await ctx.close();

  // Mono fallback — can't do mid-side, use regular splice
  if (fullBuf.numberOfChannels < 2) {
    return spliceSection(
      fullAudioUrl, fullWordTimestamps,
      sectionStartRatio, sectionEndRatio,
      newVocalsAudioUrl, newSectionWordTimestamps,
    );
  }

  const { sampleRate } = fullBuf;
  const startSample = Math.floor(sectionStartRatio * fullBuf.length);
  const endSample   = Math.floor(sectionEndRatio   * fullBuf.length);

  const crossfadeSamples = Math.max(0, Math.min(
    Math.floor(CROSSFADE_SECONDS * sampleRate),
    Math.floor(startSample / 2),
    Math.floor((fullBuf.length - endSample) / 2),
    Math.floor(newBuf.length / 4),
  ));

  const outputLen =
    (startSample - crossfadeSamples) +
    crossfadeSamples +
    Math.max(0, newBuf.length - 2 * crossfadeSamples) +
    crossfadeSamples +
    (fullBuf.length - endSample - crossfadeSamples);

  // Always output stereo
  const outBuf = new AudioBuffer({ numberOfChannels: 2, length: outputLen, sampleRate });

  const fullL = fullBuf.getChannelData(0);
  const fullR = fullBuf.getChannelData(1);
  // New vocals: use both channels if available, otherwise duplicate
  const newL = newBuf.getChannelData(0);
  const newR = newBuf.numberOfChannels > 1 ? newBuf.getChannelData(1) : newL;

  for (let ch = 0; ch < 2; ch++) {
    const out = outBuf.getChannelData(ch);
    let outPos = 0;

    // Helper: get the mixed output sample at full-audio position `fPos` and new-audio position `nPos`
    // using mid-side: keep original Side, replace Mid with new Mid
    const mixedSample = (fPos: number, nPos: number, fadeOrigMid: number, fadeNewMid: number): number => {
      const origL = fullL[fPos] ?? 0;
      const origR = fullR[fPos] ?? 0;
      const nwL   = newL[nPos] ?? 0;
      const nwR   = newR[nPos] ?? 0;

      const origSide = (origL - origR) * 0.5; // Side channel (instruments)
      const origMid  = (origL + origR) * 0.5; // Mid  channel (original vocals)
      const newMid   = (nwL + nwR)    * 0.5; // Mid  channel (new vocals)

      // Blend mid channels at crossfade boundaries; keep Side fully intact
      const blendedMid = origMid * fadeOrigMid + newMid * fadeNewMid;
      return ch === 0 ? blendedMid + origSide : blendedMid - origSide;
    };

    // 1. Clean before (original audio untouched)
    const cleanBeforeLen = startSample - crossfadeSamples;
    for (let i = 0; i < cleanBeforeLen; i++) {
      out[outPos + i] = ch === 0 ? fullL[i] : fullR[i];
    }
    outPos += cleanBeforeLen;

    // 2. Start crossfade: original Mid fades out, new vocal Mid fades in; Side stays
    for (let i = 0; i < crossfadeSamples; i++) {
      const t = i / crossfadeSamples;
      out[outPos + i] = mixedSample(
        startSample - crossfadeSamples + i, i,
        Math.cos(t * Math.PI / 2),  // original mid fade out
        Math.sin(t * Math.PI / 2),  // new mid fade in
      );
    }
    outPos += crossfadeSamples;

    // 3. New vocals section (full blend: only new Mid, original Side)
    const newMiddleLen = Math.max(0, newBuf.length - 2 * crossfadeSamples);
    for (let i = 0; i < newMiddleLen; i++) {
      out[outPos + i] = mixedSample(
        startSample + i, crossfadeSamples + i,
        0, 1, // only new mid
      );
    }
    outPos += newMiddleLen;

    // 4. End crossfade: new vocal Mid fades out, original after-section Mid fades in; Side stays
    for (let i = 0; i < crossfadeSamples; i++) {
      const t = i / crossfadeSamples;
      out[outPos + i] = mixedSample(
        endSample + i, newBuf.length - crossfadeSamples + i,
        Math.sin(t * Math.PI / 2),  // original mid fades back in
        Math.cos(t * Math.PI / 2),  // new mid fades out
      );
    }
    outPos += crossfadeSamples;

    // 5. Clean after (original audio untouched)
    const afterStart = endSample + crossfadeSamples;
    for (let i = 0; i < fullBuf.length - afterStart; i++) {
      out[outPos + i] = ch === 0 ? fullL[afterStart + i] : fullR[afterStart + i];
    }
  }

  // Rebuild timestamps (same logic as spliceSection)
  const crossfadeMs    = (crossfadeSamples / sampleRate) * 1000;
  const fullDurationMs = fullBuf.duration * 1000;
  const sectionStartMs = sectionStartRatio * fullDurationMs;
  const oldSectionDurMs = (sectionEndRatio - sectionStartRatio) * fullDurationMs;
  const newSectionDurMs = newBuf.duration * 1000;

  const beforeTs = fullWordTimestamps.filter(w => w.end_ms <= sectionStartMs);
  const newTs = newSectionWordTimestamps.map(w => ({
    word: w.word,
    start_ms: w.start_ms + sectionStartMs - crossfadeMs,
    end_ms:   w.end_ms   + sectionStartMs - crossfadeMs,
  }));
  const drift = newSectionDurMs - oldSectionDurMs - crossfadeMs;
  const afterTs = fullWordTimestamps
    .filter(w => w.start_ms >= sectionStartMs + oldSectionDurMs)
    .map(w => ({ word: w.word, start_ms: w.start_ms + drift, end_ms: w.end_ms + drift }));

  return {
    audioUrl: encodeWav(outBuf),
    wordTimestamps: [...beforeTs, ...newTs, ...afterTs],
  };
}

function encodeWav(buffer: AudioBuffer): string {
  const { numberOfChannels, sampleRate, length } = buffer;
  const pcmSize = length * numberOfChannels * 2; // 16-bit samples
  const ab   = new ArrayBuffer(44 + pcmSize);
  const view = new DataView(ab);

  const ws = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };

  ws(0, 'RIFF'); view.setUint32(4, 36 + pcmSize, true);
  ws(8, 'WAVE'); ws(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numberOfChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numberOfChannels * 2, true);
  view.setUint16(32, numberOfChannels * 2, true);
  view.setUint16(34, 16, true);
  ws(36, 'data'); view.setUint32(40, pcmSize, true);

  const channels = Array.from({ length: numberOfChannels }, (_, i) => buffer.getChannelData(i));
  let off = 44;
  for (let i = 0; i < length; i++) {
    for (let ch = 0; ch < numberOfChannels; ch++) {
      const s = Math.max(-1, Math.min(1, channels[ch][i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }

  return URL.createObjectURL(new Blob([ab], { type: 'audio/wav' }));
}
