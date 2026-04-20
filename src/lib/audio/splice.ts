import type { WordTimestamp } from '../types';

export interface SpliceResult {
  audioUrl: string;
  wordTimestamps: WordTimestamp[];
  /** How many ms the start crossfade reaches back before the bar boundary.
   *  Section N's audio actually starts at (sectionStartMs − crossfadeMs),
   *  so callers should shift the section marker back by this amount. */
  crossfadeMs?: number;
}

const MAX_CROSSFADE_SECONDS = 0.1;  // 100 ms — tight section transitions, no audible bleed
const MIN_CROSSFADE_SECONDS = 0.02; // 20 ms — enough to kill boundary clicks

/** RMS energy of a Float32Array slice, safe against out-of-bounds. */
function rms(data: Float32Array, from: number, count: number): number {
  const start = Math.max(0, from);
  const end   = Math.min(data.length, from + count);
  if (end <= start) return 0;
  let sum = 0;
  for (let i = start; i < end; i++) sum += data[i] * data[i];
  return Math.sqrt(sum / (end - start));
}

/**
 * Computes an energy-adaptive crossfade length in samples.
 *
 * Analyses the RMS at both splice boundaries (end-of-before, start-of-new,
 * end-of-new, start-of-after) across all channels. Quiet / sparse audio
 * gets a short crossfade; loud / dense music gets the full 1-second window.
 *
 * Scale: linear from MIN_CROSSFADE_SECONDS (RMS ≈ 0) to MAX_CROSSFADE_SECONDS
 * (RMS ≥ 0.25 — typical for mastered music at −12 dBFS).
 */
function adaptiveCrossfadeSamples(
  fullBuf: AudioBuffer,
  newBuf:  AudioBuffer,
  startSample: number,
  endSample:   number,
): number {
  const { sampleRate } = fullBuf;
  const windowSamples = Math.floor(MAX_CROSSFADE_SECONDS * sampleRate);
  let totalRms = 0;
  let measurements = 0;

  for (let ch = 0; ch < fullBuf.numberOfChannels; ch++) {
    const full  = fullBuf.getChannelData(ch);
    const newCh = newBuf.getChannelData(Math.min(ch, newBuf.numberOfChannels - 1));

    // Boundary A: end of "before" segment + start of new segment
    totalRms += rms(full,  startSample - windowSamples, windowSamples);
    totalRms += rms(newCh, 0,                           windowSamples);

    // Boundary B: end of new segment + start of "after" segment
    totalRms += rms(newCh, newBuf.length - windowSamples, windowSamples);
    totalRms += rms(full,  endSample,                     windowSamples);

    measurements += 4;
  }

  const avgRms = totalRms / Math.max(1, measurements);

  // Map RMS → crossfade seconds (clamp at 0.25 = loud mastered music)
  const t = Math.min(1, avgRms / 0.25);
  const seconds = MIN_CROSSFADE_SECONDS + t * (MAX_CROSSFADE_SECONDS - MIN_CROSSFADE_SECONDS);

  return Math.floor(seconds * sampleRate);
}

/**
 * Replaces a section of the full audio (defined by start/end ratios 0–1) with new
 * section audio, crossfading at both boundaries. Returns a blob URL to a WAV file.
 *
 * Equal-power crossfade: sin/cos curves preserve perceived loudness at the blend point.
 */
/**
 * Core splice logic operating directly on decoded AudioBuffers. Used by both
 * spliceSection (ratio-based) and spliceSectionMs (ms-based).
 */
function spliceSectionBuffers(
  fullBuf: AudioBuffer,
  fullWordTimestamps: WordTimestamp[],
  sectionStartRatio: number,
  sectionEndRatio: number,
  newBuf: AudioBuffer,
  newSectionWordTimestamps: WordTimestamp[],
): SpliceResult {
  const { sampleRate, numberOfChannels } = fullBuf;
  const startSample = Math.max(0, Math.min(Math.floor(sectionStartRatio * fullBuf.length), fullBuf.length));
  const endSample   = Math.max(startSample, Math.min(Math.floor(sectionEndRatio * fullBuf.length), fullBuf.length));

  const crossfadeSamples = Math.max(0, Math.min(
    adaptiveCrossfadeSamples(fullBuf, newBuf, startSample, endSample),
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

  const outBuf = new AudioBuffer({ numberOfChannels, length: outputLen, sampleRate });

  for (let ch = 0; ch < numberOfChannels; ch++) {
    const out   = outBuf.getChannelData(ch);
    const full  = fullBuf.getChannelData(ch);
    const newCh = ch < newBuf.numberOfChannels ? newBuf.getChannelData(ch) : newBuf.getChannelData(0);
    let outPos  = 0;

    const cleanBeforeLen = startSample - crossfadeSamples;
    out.set(full.subarray(0, cleanBeforeLen), outPos);
    outPos += cleanBeforeLen;

    for (let i = 0; i < crossfadeSamples; i++) {
      const t = i / crossfadeSamples;
      out[outPos + i] = full[startSample - crossfadeSamples + i] * Math.cos(t * Math.PI / 2)
                      + newCh[i]                                  * Math.sin(t * Math.PI / 2);
    }
    outPos += crossfadeSamples;

    const newMiddleLen = Math.max(0, newBuf.length - 2 * crossfadeSamples);
    out.set(newCh.subarray(crossfadeSamples, crossfadeSamples + newMiddleLen), outPos);
    outPos += newMiddleLen;

    for (let i = 0; i < crossfadeSamples; i++) {
      const t = i / crossfadeSamples;
      out[outPos + i] = newCh[newBuf.length - crossfadeSamples + i] * Math.cos(t * Math.PI / 2)
                      + full[endSample + i]                          * Math.sin(t * Math.PI / 2);
    }
    outPos += crossfadeSamples;

    out.set(full.subarray(endSample + crossfadeSamples), outPos);
  }

  const crossfadeMs     = (crossfadeSamples / sampleRate) * 1000;
  const fullDurationMs  = fullBuf.duration * 1000;
  const sectionStartMs  = sectionStartRatio * fullDurationMs;
  const oldSectionDurMs = (sectionEndRatio - sectionStartRatio) * fullDurationMs;
  const newSectionDurMs = newBuf.duration * 1000;

  const beforeTs = fullWordTimestamps.filter(w => w.end_ms <= sectionStartMs);
  const newTs    = newSectionWordTimestamps.map(w => ({
    word:     w.word,
    start_ms: w.start_ms + sectionStartMs - crossfadeMs,
    end_ms:   w.end_ms   + sectionStartMs - crossfadeMs,
  }));
  const drift   = newSectionDurMs - oldSectionDurMs - crossfadeMs;
  const afterTs = fullWordTimestamps
    .filter(w => w.start_ms >= sectionStartMs + oldSectionDurMs)
    .map(w => ({ word: w.word, start_ms: w.start_ms + drift, end_ms: w.end_ms + drift }));

  return { audioUrl: encodeWav(outBuf), wordTimestamps: [...beforeTs, ...newTs, ...afterTs], crossfadeMs };
}

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
  return spliceSectionBuffers(fullBuf, fullWordTimestamps, sectionStartRatio, sectionEndRatio, newBuf, newSectionWordTimestamps);
}

/**
 * Like spliceSection but takes absolute ms boundaries instead of ratios, and
 * accepts an optional trimNewToMs: if provided, the new audio is truncated to
 * that many ms before splicing. Used for section regeneration: the API generates
 * extra tail beats, and trimNewToMs = sectionDurMs + 1 beat keeps only the
 * content we want + 1 beat of crossfade material, discarding the rest.
 */
export async function spliceSectionMs(
  fullAudioUrl: string,
  fullWordTimestamps: WordTimestamp[],
  startMs: number,
  endMs: number,
  newSectionAudioUrl: string,
  newSectionWordTimestamps: WordTimestamp[],
  trimNewToMs?: number,
): Promise<SpliceResult> {
  const [fullArray, newArray] = await Promise.all([
    fetch(fullAudioUrl).then(r => r.arrayBuffer()),
    fetch(newSectionAudioUrl).then(r => r.arrayBuffer()),
  ]);
  const ctx = new AudioContext();
  const [fullBuf, rawNewBuf] = await Promise.all([
    ctx.decodeAudioData(fullArray),
    ctx.decodeAudioData(newArray),
  ]);
  await ctx.close();

  // Trim the new section to discard extra generated tail beyond the crossfade zone
  const { sampleRate } = fullBuf;
  let newBuf = rawNewBuf;
  if (trimNewToMs !== undefined) {
    const trimSamples = Math.min(Math.floor(trimNewToMs * sampleRate / 1000), rawNewBuf.length);
    if (trimSamples < rawNewBuf.length) {
      const trimmed = new AudioBuffer({
        numberOfChannels: rawNewBuf.numberOfChannels,
        length: Math.max(1, trimSamples),
        sampleRate,
      });
      for (let ch = 0; ch < rawNewBuf.numberOfChannels; ch++) {
        trimmed.getChannelData(ch).set(rawNewBuf.getChannelData(ch).subarray(0, trimSamples));
      }
      newBuf = trimmed;
    }
  }

  const fullDurationMs  = fullBuf.duration * 1000;
  const startRatio = startMs / fullDurationMs;
  const endRatio   = endMs   / fullDurationMs;
  return spliceSectionBuffers(fullBuf, fullWordTimestamps, startRatio, endRatio, newBuf, newSectionWordTimestamps);
}

/**
 * Replaces a fixed-duration region [startMs, endMs] with new audio sized to
 * exactly match that region. Total file length is always preserved.
 *
 * - New audio longer than (endMs − startMs): truncated to fit
 * - New audio shorter: padded with silence at the end
 *
 * A 15 ms linear ramp is applied at both cut boundaries to prevent clicks.
 * Word timestamps before startMs and after endMs are left completely unchanged
 * (no drift, no shifting). Only the section's own timestamps are replaced.
 */
export async function replaceSection(
  fullAudioUrl: string,
  fullWordTimestamps: WordTimestamp[],
  startMs: number,
  endMs: number,
  newAudioUrl: string,
  newWordTimestamps: WordTimestamp[],
): Promise<SpliceResult> {
  const [fullArray, newArray] = await Promise.all([
    fetch(fullAudioUrl).then(r => r.arrayBuffer()),
    fetch(newAudioUrl) .then(r => r.arrayBuffer()),
  ]);

  const ctx = new AudioContext();
  const [fullBuf, newBuf] = await Promise.all([
    ctx.decodeAudioData(fullArray),
    ctx.decodeAudioData(newArray),
  ]);
  await ctx.close();

  const { sampleRate, numberOfChannels } = fullBuf;
  const startSample = Math.min(Math.round(startMs * sampleRate / 1000), fullBuf.length);
  const endSample   = Math.min(Math.round(endMs   * sampleRate / 1000), fullBuf.length);
  const regionLen   = endSample - startSample;
  if (regionLen <= 0) {
    return { audioUrl: encodeWav(fullBuf), wordTimestamps: fullWordTimestamps };
  }

  // 15 ms ramp — just enough to kill boundary clicks, inaudible as a fade
  const RAMP_MS      = 15;
  const rampSamples  = Math.min(Math.floor(RAMP_MS * sampleRate / 1000), Math.floor(regionLen / 4));

  // Output is the exact same length as the input
  const outBuf = new AudioBuffer({ numberOfChannels, length: fullBuf.length, sampleRate });

  for (let ch = 0; ch < numberOfChannels; ch++) {
    const out   = outBuf.getChannelData(ch);
    const full  = fullBuf.getChannelData(ch);
    const newCh = ch < newBuf.numberOfChannels ? newBuf.getChannelData(ch) : newBuf.getChannelData(0);

    // Before and after: straight copy
    out.set(full.subarray(0, startSample), 0);
    out.set(full.subarray(endSample),      endSample);

    // Section region: new audio fitted to regionLen with boundary ramps
    for (let i = 0; i < regionLen; i++) {
      const sample = i < newCh.length ? newCh[i] : 0; // silence-pad if shorter
      let gain = 1;
      if (i < rampSamples)                  gain = i / rampSamples;
      else if (i >= regionLen - rampSamples) gain = (regionLen - i) / rampSamples;
      out[startSample + i] = sample * gain;
    }
  }

  // Timestamps: before / after completely unchanged; section replaced with new timestamps
  const beforeTs  = fullWordTimestamps.filter(w => w.end_ms   <= startMs);
  const afterTs   = fullWordTimestamps.filter(w => w.start_ms >= endMs);
  const sectionTs = newWordTimestamps
    .map(w => ({
      word:     w.word,
      start_ms: w.start_ms + startMs,
      end_ms:   Math.min(w.end_ms + startMs, endMs),
    }))
    .filter(w => w.start_ms < endMs);

  return {
    audioUrl: encodeWav(outBuf),
    wordTimestamps: [...beforeTs, ...sectionTs, ...afterTs],
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
  const startSample = Math.max(0, Math.min(Math.floor(sectionStartRatio * fullBuf.length), fullBuf.length));
  const endSample   = Math.max(startSample, Math.min(Math.floor(sectionEndRatio * fullBuf.length), fullBuf.length));

  const crossfadeSamples = Math.max(0, Math.min(
    adaptiveCrossfadeSamples(fullBuf, newBuf, startSample, endSample),
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

/**
 * Inserts new audio at a specific time position (clean cut, no crossfade).
 * Produces: before ++ new ++ after.
 * Word timestamps before `insertAtMs` are unchanged; those at/after shift by the new audio duration.
 */
export async function insertAudioAtMs(
  fullAudioUrl: string,
  fullWordTimestamps: WordTimestamp[],
  insertAtMs: number,
  newAudioUrl: string,
  newWordTimestamps: WordTimestamp[],
): Promise<SpliceResult> {
  const [fullArray, newArray] = await Promise.all([
    fetch(fullAudioUrl).then(r => r.arrayBuffer()),
    fetch(newAudioUrl).then(r => r.arrayBuffer()),
  ]);

  const ctx = new AudioContext();
  const [fullBuf, newBuf] = await Promise.all([
    ctx.decodeAudioData(fullArray),
    ctx.decodeAudioData(newArray),
  ]);
  await ctx.close();

  const { sampleRate } = fullBuf;
  const numCh = Math.max(fullBuf.numberOfChannels, newBuf.numberOfChannels);
  const insertSample = Math.min(Math.floor((insertAtMs / 1000) * sampleRate), fullBuf.length);
  const outBuf = new AudioBuffer({ numberOfChannels: numCh, length: fullBuf.length + newBuf.length, sampleRate });

  for (let ch = 0; ch < numCh; ch++) {
    const out  = outBuf.getChannelData(ch);
    const full = fullBuf.getChannelData(Math.min(ch, fullBuf.numberOfChannels - 1));
    const neu  = newBuf.getChannelData(Math.min(ch, newBuf.numberOfChannels - 1));
    out.set(full.subarray(0, insertSample), 0);
    out.set(neu, insertSample);
    out.set(full.subarray(insertSample), insertSample + newBuf.length);
  }

  const newDurationMs = (newBuf.length / sampleRate) * 1000;
  const beforeTs = fullWordTimestamps.filter(w => w.end_ms <= insertAtMs);
  const insertedTs = newWordTimestamps.map(w => ({
    word:     w.word,
    start_ms: w.start_ms + insertAtMs,
    end_ms:   w.end_ms   + insertAtMs,
  }));
  const afterTs = fullWordTimestamps
    .filter(w => w.start_ms >= insertAtMs)
    .map(w => ({ word: w.word, start_ms: w.start_ms + newDurationMs, end_ms: w.end_ms + newDurationMs }));

  return { audioUrl: encodeWav(outBuf), wordTimestamps: [...beforeTs, ...insertedTs, ...afterTs] };
}

/**
 * Extracts the audio region [startMs, endMs] as a new standalone clip.
 * Word timestamps are re-zeroed so they are relative to the start of the clip.
 * Used for copy/paste: call sliceAudioRegion to copy, insertAudioAtMs to paste.
 */
export async function sliceAudioRegion(
  audioUrl: string,
  wordTimestamps: WordTimestamp[],
  startMs: number,
  endMs: number,
): Promise<SpliceResult> {
  const arrayBuf = await fetch(audioUrl).then(r => r.arrayBuffer());
  const ctx = new AudioContext();
  const audioBuf = await ctx.decodeAudioData(arrayBuf);
  await ctx.close();

  const { sampleRate, numberOfChannels } = audioBuf;
  const startSample = Math.floor((startMs / 1000) * sampleRate);
  const endSample   = Math.min(Math.ceil((endMs / 1000) * sampleRate), audioBuf.length);
  const len = Math.max(1, endSample - startSample);

  const outBuf = new AudioBuffer({ numberOfChannels, length: len, sampleRate });
  for (let ch = 0; ch < numberOfChannels; ch++) {
    outBuf.getChannelData(ch).set(audioBuf.getChannelData(ch).subarray(startSample, endSample));
  }

  const slicedTs = wordTimestamps
    .filter(w => w.end_ms > startMs && w.start_ms < endMs)
    .map(w => ({
      word:     w.word,
      start_ms: Math.max(0, w.start_ms - startMs),
      end_ms:   Math.min(endMs - startMs, w.end_ms - startMs),
    }));

  return { audioUrl: encodeWav(outBuf), wordTimestamps: slicedTs };
}

/**
 * Trim (if longer) or zero-pad (if shorter) audio to exactly targetMs.
 * Used to lock a regenerated clip to its bar-based duration before splicing.
 */
export async function fitAudioToMs(
  audioUrl: string,
  wordTimestamps: WordTimestamp[],
  targetMs: number,
): Promise<SpliceResult> {
  const arrayBuf = await fetch(audioUrl).then(r => r.arrayBuffer());
  const ctx = new AudioContext();
  const audioBuf = await ctx.decodeAudioData(arrayBuf);
  await ctx.close();

  const { sampleRate, numberOfChannels } = audioBuf;
  const targetSamples = Math.max(1, Math.round((targetMs / 1000) * sampleRate));

  // Within 1 sample — no-op
  if (Math.abs(targetSamples - audioBuf.length) <= 1) {
    return { audioUrl, wordTimestamps };
  }

  const outBuf = new AudioBuffer({ numberOfChannels, length: targetSamples, sampleRate });
  for (let ch = 0; ch < numberOfChannels; ch++) {
    const src = audioBuf.getChannelData(ch);
    const dst = outBuf.getChannelData(ch);
    // Copy what we have; remainder stays 0 (silence pad)
    dst.set(src.subarray(0, Math.min(src.length, targetSamples)));
  }

  const clampedTs = wordTimestamps
    .filter(w => w.start_ms < targetMs)
    .map(w => ({ ...w, end_ms: Math.min(w.end_ms, targetMs) }));

  return { audioUrl: encodeWav(outBuf), wordTimestamps: clampedTs };
}

/**
 * Applies a linear fade-out over [fadeStartMs, fadeEndMs] in the full audio.
 * Samples before fadeStartMs are untouched; samples after fadeEndMs are silenced.
 * Total file length is preserved. Word timestamps in the fade region are kept.
 */
export async function applyFadeOut(
  audioUrl: string,
  wordTimestamps: WordTimestamp[],
  fadeStartMs: number,
  fadeEndMs: number,
): Promise<SpliceResult> {
  const arrayBuf = await fetch(audioUrl).then(r => r.arrayBuffer());
  const ctx = new AudioContext();
  const audioBuf = await ctx.decodeAudioData(arrayBuf);
  await ctx.close();

  const { sampleRate, numberOfChannels, length } = audioBuf;
  const startSample = Math.max(0, Math.floor(fadeStartMs * sampleRate / 1000));
  const endSample   = Math.min(length, Math.ceil(fadeEndMs * sampleRate / 1000));
  const fadeSamples = Math.max(1, endSample - startSample);

  const outBuf = new AudioBuffer({ numberOfChannels, length, sampleRate });
  for (let ch = 0; ch < numberOfChannels; ch++) {
    const src = audioBuf.getChannelData(ch);
    const dst = outBuf.getChannelData(ch);
    dst.set(src);
    for (let i = startSample; i < endSample; i++) {
      const gain = 1 - (i - startSample) / fadeSamples;
      dst[i] = src[i] * gain;
    }
  }

  return { audioUrl: encodeWav(outBuf), wordTimestamps };
}

/**
 * Zeroes out (silences) the audio region [startMs, endMs] in place.
 * Total file length is preserved. Word timestamps within the region are removed.
 */
export async function silenceAudioRegion(
  audioUrl: string,
  wordTimestamps: WordTimestamp[],
  startMs: number,
  endMs: number,
): Promise<SpliceResult> {
  const arrayBuf = await fetch(audioUrl).then(r => r.arrayBuffer());
  const ctx = new AudioContext();
  const audioBuf = await ctx.decodeAudioData(arrayBuf);
  await ctx.close();

  const { sampleRate, numberOfChannels, length } = audioBuf;
  const startSample = Math.floor((startMs / 1000) * sampleRate);
  const endSample   = Math.min(Math.floor((endMs / 1000) * sampleRate), length);

  const outBuf = new AudioBuffer({ numberOfChannels, length, sampleRate });
  for (let ch = 0; ch < numberOfChannels; ch++) {
    const dst = outBuf.getChannelData(ch);
    dst.set(audioBuf.getChannelData(ch));
    for (let i = startSample; i < endSample; i++) dst[i] = 0;
  }

  const newTs = wordTimestamps.filter(w => w.end_ms <= startMs || w.start_ms >= endMs);
  return { audioUrl: encodeWav(outBuf), wordTimestamps: newTs };
}

/**
 * Removes the audio region [startMs, endMs] from the audio file.
 * Word timestamps within the removed region are discarded; those after endMs shift back by the removed duration.
 */
export async function cutAudioRegion(
  audioUrl: string,
  wordTimestamps: WordTimestamp[],
  startMs: number,
  endMs: number,
): Promise<SpliceResult> {
  const arrayBuf = await fetch(audioUrl).then(r => r.arrayBuffer());
  const ctx = new AudioContext();
  const audioBuf = await ctx.decodeAudioData(arrayBuf);
  await ctx.close();

  const { sampleRate, numberOfChannels } = audioBuf;
  const startSample = Math.floor((startMs / 1000) * sampleRate);
  const endSample   = Math.min(Math.floor((endMs / 1000) * sampleRate), audioBuf.length);
  const outputLen   = Math.max(1, audioBuf.length - (endSample - startSample));
  const outBuf = new AudioBuffer({ numberOfChannels, length: outputLen, sampleRate });

  for (let ch = 0; ch < numberOfChannels; ch++) {
    const out = outBuf.getChannelData(ch);
    const src = audioBuf.getChannelData(ch);
    out.set(src.subarray(0, startSample), 0);
    out.set(src.subarray(endSample), startSample);
  }

  const removedMs = endMs - startMs;
  const beforeTs  = wordTimestamps.filter(w => w.end_ms <= startMs);
  const afterTs   = wordTimestamps
    .filter(w => w.start_ms >= endMs)
    .map(w => ({ word: w.word, start_ms: w.start_ms - removedMs, end_ms: w.end_ms - removedMs }));

  return { audioUrl: encodeWav(outBuf), wordTimestamps: [...beforeTs, ...afterTs] };
}

/**
 * Cuts out [startMs, endMs] from the full audio and inserts new audio at that position.
 * Total file length changes to match the new section's duration.
 * Word timestamps before startMs are unchanged; those after endMs shift by (newDuration − oldDuration).
 */
export async function swapSection(
  fullAudioUrl: string,
  fullWordTimestamps: WordTimestamp[],
  startMs: number,
  endMs: number,
  newAudioUrl: string,
  newWordTimestamps: WordTimestamp[],
): Promise<SpliceResult> {
  const [fullArray, newArray] = await Promise.all([
    fetch(fullAudioUrl).then(r => r.arrayBuffer()),
    fetch(newAudioUrl).then(r => r.arrayBuffer()),
  ]);
  const ctx = new AudioContext();
  const [fullBuf, newBuf] = await Promise.all([
    ctx.decodeAudioData(fullArray),
    ctx.decodeAudioData(newArray),
  ]);
  await ctx.close();

  const { sampleRate, numberOfChannels } = fullBuf;
  const startSample = Math.min(Math.round(startMs * sampleRate / 1000), fullBuf.length);
  const endSample   = Math.min(Math.round(endMs   * sampleRate / 1000), fullBuf.length);

  const outLen = startSample + newBuf.length + (fullBuf.length - endSample);
  const outBuf = new AudioBuffer({ numberOfChannels, length: Math.max(1, outLen), sampleRate });

  // 15 ms linear ramps at both boundaries of the new audio prevent cut clicks
  // without touching the adjacent sections at all.
  const RAMP_MS     = 15;
  const rampSamples = Math.min(Math.floor(RAMP_MS * sampleRate / 1000), Math.floor(newBuf.length / 4));

  for (let ch = 0; ch < numberOfChannels; ch++) {
    const out   = outBuf.getChannelData(ch);
    const full  = fullBuf.getChannelData(ch);
    const newCh = ch < newBuf.numberOfChannels ? newBuf.getChannelData(ch) : newBuf.getChannelData(0);

    // Before and after regions: straight copy, boundaries untouched
    out.set(full.subarray(0, startSample), 0);
    out.set(full.subarray(endSample), startSample + newBuf.length);

    // New section with ramp-in and ramp-out
    for (let i = 0; i < newBuf.length; i++) {
      let gain = 1;
      if      (i < rampSamples)                  gain = i / rampSamples;
      else if (i >= newBuf.length - rampSamples) gain = (newBuf.length - i) / rampSamples;
      out[startSample + i] = newCh[i] * gain;
    }
  }

  const oldDurationMs = endMs - startMs;
  const newDurationMs = (newBuf.length / sampleRate) * 1000;
  const drift = newDurationMs - oldDurationMs;

  const beforeTs  = fullWordTimestamps.filter(w => w.end_ms <= startMs);
  const sectionTs = newWordTimestamps.map(w => ({ word: w.word, start_ms: w.start_ms + startMs, end_ms: w.end_ms + startMs }));
  const afterTs   = fullWordTimestamps
    .filter(w => w.start_ms >= endMs)
    .map(w => ({ word: w.word, start_ms: w.start_ms + drift, end_ms: w.end_ms + drift }));

  return { audioUrl: encodeWav(outBuf), wordTimestamps: [...beforeTs, ...sectionTs, ...afterTs] };
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
