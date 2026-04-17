/**
 * Aligns two audio tracks so they share the same total duration.
 *
 * ElevenLabs stem separation can return tracks with slightly different lengths
 * when each stem has its own leading silence trimmed internally. This function
 * measures both durations and prepends silence to the shorter one so that
 * t=0 on both tracks corresponds to the same moment in the original recording.
 */

export async function alignTracks(
  urlA: string,
  urlB: string,
): Promise<{ urlA: string; urlB: string }> {
  const ctx = new AudioContext();
  const [bufA, bufB] = await Promise.all([
    fetch(urlA).then(r => r.arrayBuffer()).then(ab => ctx.decodeAudioData(ab)),
    fetch(urlB).then(r => r.arrayBuffer()).then(ab => ctx.decodeAudioData(ab)),
  ]);
  await ctx.close();

  const diffSamples = bufA.length - bufB.length;
  if (Math.abs(diffSamples) / bufA.sampleRate < 0.05) {
    return { urlA, urlB }; // within 50 ms — already aligned
  }

  if (diffSamples > 0) {
    return { urlA, urlB: await prependSilence(bufB, diffSamples) };
  } else {
    return { urlA: await prependSilence(bufA, -diffSamples), urlB };
  }
}

async function prependSilence(buffer: AudioBuffer, silenceSamples: number): Promise<string> {
  const { sampleRate, numberOfChannels } = buffer;
  const newLength = buffer.length + silenceSamples;

  // Render into an OfflineAudioContext with the source delayed by silenceSamples
  const offline = new OfflineAudioContext(numberOfChannels, newLength, sampleRate);
  const source  = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start(silenceSamples / sampleRate);

  const rendered = await offline.startRendering();
  return URL.createObjectURL(encodeWav(rendered));
}

function encodeWav(buffer: AudioBuffer): Blob {
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
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numberOfChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true);
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
