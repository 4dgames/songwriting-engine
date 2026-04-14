export interface TrimResult {
  url: string;
  trimmedSec: number; // how many seconds were removed from the front (0 if nothing trimmed)
}

/**
 * Trims leading silence from an audio URL using the Web Audio API.
 * Returns the new blob URL and the number of seconds removed so callers
 * can shift word timestamps accordingly.
 */
export async function trimLeadingSilence(
  url: string,
  thresholdDb    = -50,   // amplitude below this is "silence"
  minSilenceSec  = 0.1,   // only trim if silence is at least this long
): Promise<TrimResult> {
  const threshold = Math.pow(10, thresholdDb / 20);

  const arrayBuf  = await fetch(url).then(r => r.arrayBuffer());
  const ctx       = new AudioContext();
  const audioBuf  = await ctx.decodeAudioData(arrayBuf);
  await ctx.close();

  const numChannels = audioBuf.numberOfChannels;
  const sampleRate  = audioBuf.sampleRate;
  const numSamples  = audioBuf.length;

  // Find first sample above threshold across all channels
  let startSample = numSamples;
  outer:
  for (let i = 0; i < numSamples; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      if (Math.abs(audioBuf.getChannelData(ch)[i]) > threshold) {
        startSample = i;
        break outer;
      }
    }
  }

  const trimmedSec = startSample / sampleRate;
  if (trimmedSec < minSilenceSec) return { url, trimmedSec: 0 }; // not enough silence

  // Render trimmed audio via OfflineAudioContext
  const trimmedLength = numSamples - startSample;
  const offline       = new OfflineAudioContext(numChannels, trimmedLength, sampleRate);
  const source        = offline.createBufferSource();
  source.buffer       = audioBuf;
  source.connect(offline.destination);
  source.start(0, trimmedSec);

  const rendered = await offline.startRendering();
  return { url: URL.createObjectURL(encodeWav(rendered)), trimmedSec };
}

function encodeWav(buffer: AudioBuffer): Blob {
  const numChannels  = buffer.numberOfChannels;
  const sampleRate   = buffer.sampleRate;
  const numSamples   = buffer.length;
  const bytesPerSample = 2; // 16-bit PCM
  const blockAlign   = numChannels * bytesPerSample;
  const dataSize     = numSamples * blockAlign;

  const wav  = new ArrayBuffer(44 + dataSize);
  const view = new DataView(wav);

  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };

  str(0,  'RIFF');
  view.setUint32(4,  36 + dataSize, true);
  str(8,  'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1,  true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate,  true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign,  true);
  view.setUint16(34, bytesPerSample * 8, true);
  str(36, 'data');
  view.setUint32(40, dataSize, true);

  let off = 44;
  for (let i = 0; i < numSamples; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const s = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }

  return new Blob([wav], { type: 'audio/wav' });
}
