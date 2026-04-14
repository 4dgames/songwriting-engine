/**
 * Client-side audio track mixer.
 *
 * Decodes multiple audio URLs via the Web Audio API, sums their PCM samples,
 * peak-normalises the result to prevent clipping, then encodes as a WAV blob URL.
 * Used to combine Demucs stems (drums + bass + other) into a single instrumental track.
 */

export async function mixTracks(urls: string[]): Promise<string> {
  const ctx     = new AudioContext();
  const buffers = await Promise.all(
    urls.map(url =>
      fetch(url)
        .then(r => r.arrayBuffer())
        .then(ab => ctx.decodeAudioData(ab)),
    ),
  );
  await ctx.close();

  const maxLen         = Math.max(...buffers.map(b => b.length));
  const { sampleRate, numberOfChannels } = buffers[0];
  const out = new AudioBuffer({ numberOfChannels, length: maxLen, sampleRate });

  // Sum each channel across all buffers
  for (let ch = 0; ch < numberOfChannels; ch++) {
    const data = out.getChannelData(ch);
    for (const buf of buffers) {
      const src = buf.getChannelData(Math.min(ch, buf.numberOfChannels - 1));
      for (let i = 0; i < src.length; i++) data[i] += src[i];
    }
  }

  // Peak-normalise so the sum can't clip
  let peak = 0;
  for (let ch = 0; ch < numberOfChannels; ch++) {
    const data = out.getChannelData(ch);
    for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
  }
  if (peak > 1) {
    for (let ch = 0; ch < numberOfChannels; ch++) {
      const data = out.getChannelData(ch);
      for (let i = 0; i < data.length; i++) data[i] /= peak;
    }
  }

  return encodeWav(out);
}

/** Converts a remote URL to a local blob URL (avoids cross-origin AudioContext issues). */
export async function toBlobUrl(url: string): Promise<string> {
  const res  = await fetch(url);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

function encodeWav(buffer: AudioBuffer): string {
  const { numberOfChannels, sampleRate, length } = buffer;
  const pcmSize = length * numberOfChannels * 2;
  const ab      = new ArrayBuffer(44 + pcmSize);
  const view    = new DataView(ab);
  const ws      = (off: number, s: string) => {
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
