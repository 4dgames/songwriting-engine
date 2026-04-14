/**
 * Stereo stem separation using FastICA (Independent Component Analysis).
 *
 * Finds two maximally independent components from the stereo mix. The component
 * that correlates with the centre (mid) channel is labelled "vocals"; the other
 * is labelled "instrumental". Both outputs are encoded as mono-compatible stereo
 * WAV blob URLs so they can be loaded by <audio> elements and are frame-perfect
 * in sync (both derived from the same decoded source buffer).
 */

import { applyICA } from './ica';

export interface SplitResult {
  instrumentalUrl: string;
  vocalsUrl: string;
}

export async function splitStereoToTracks(audioUrl: string): Promise<SplitResult> {
  const ctx = new AudioContext();
  const res = await fetch(audioUrl);
  const raw = await res.arrayBuffer();
  const src = await ctx.decodeAudioData(raw);
  await ctx.close();

  const { sampleRate, numberOfChannels, length } = src;

  // Mono audio — can't split, return same source for both
  if (numberOfChannels < 2) {
    return { instrumentalUrl: audioUrl, vocalsUrl: audioUrl };
  }

  const L = src.getChannelData(0);
  const R = src.getChannelData(1);

  // ICA separation
  const { vocalsData, instrumentalData } = applyICA(L, R);

  // Encode each IC as a mono-compatible stereo WAV (same signal on L and R)
  const vocalsBuf = monoToStereoBuffer(vocalsData, sampleRate, length);
  const instBuf   = monoToStereoBuffer(instrumentalData, sampleRate, length);

  return {
    instrumentalUrl: encodeWav(instBuf),
    vocalsUrl:       encodeWav(vocalsBuf),
  };
}

function monoToStereoBuffer(data: Float32Array, sampleRate: number, length: number): AudioBuffer {
  const buf = new AudioBuffer({ numberOfChannels: 2, length, sampleRate });
  buf.getChannelData(0).set(data);
  buf.getChannelData(1).set(data);
  return buf;
}

function encodeWav(buffer: AudioBuffer): string {
  const { numberOfChannels, sampleRate, length } = buffer;
  const pcmSize = length * numberOfChannels * 2;
  const ab   = new ArrayBuffer(44 + pcmSize);
  const view = new DataView(ab);
  const ws   = (off: number, s: string) => {
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
