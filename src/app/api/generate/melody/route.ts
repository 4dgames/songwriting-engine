import { NextRequest, NextResponse } from 'next/server';
import Replicate from 'replicate';
import type { Song } from '@/lib/types';

// MusicGen can take a few minutes for longer durations
export const maxDuration = 300;

function buildPrompt(song: Song): string {
  return [song.genre, song.mood, `${song.tempo} BPM`, song.key, song.audioPrompt]
    .filter(Boolean)
    .join(', ');
}

function estimateDurationSec(song: Song): number {
  const totalMs = song.sections.reduce((sum, section) => {
    if (section.durationMs) return sum + section.durationMs;
    const lines = section.lyrics.split('\n').filter(l => l.trim());
    return sum + Math.max(15000, lines.length * 3500 + 4000);
  }, 0);
  // MusicGen stereo-melody is capped at 30 s
  return Math.min(30, Math.max(10, Math.round(totalMs / 1000)));
}

async function toBuffer(output: unknown): Promise<Buffer> {
  // Replicate FileOutput objects are ReadableStreams; URLs are plain strings.
  if (output && typeof (output as ReadableStream).getReader === 'function') {
    const reader = (output as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks);
  }
  // String URL — fetch it
  const url = typeof output === 'string' ? output : String(output);
  return Buffer.from(await (await fetch(url)).arrayBuffer());
}

export async function POST(req: NextRequest) {
  const token = process.env.REPLICATE_API_TOKEN ?? process.env.REPLICATE_API_KEY;
  if (!token) {
    return NextResponse.json({ error: 'REPLICATE_API_TOKEN (or REPLICATE_API_KEY) not configured' }, { status: 503 });
  }

  const { song, melodyDataUrl } = await req.json() as { song: Song; melodyDataUrl: string };

  const replicate = new Replicate({ auth: token });

  // Upload the melody audio to Replicate file storage so the model can fetch it
  const base64   = melodyDataUrl.replace(/^data:[^;]+;base64,/, '');
  const mimeType = melodyDataUrl.match(/^data:([^;]+)/)?.[1] ?? 'audio/webm';
  const melodyBuf = Buffer.from(base64, 'base64');

  const melodyFile = await replicate.files.create(
    new Blob([melodyBuf], { type: mimeType }),
  );

  const output = await replicate.run('meta/musicgen', {
    input: {
      prompt:               buildPrompt(song),
      melody:               melodyFile.urls.get,
      model_version:        'stereo-melody',
      duration:             estimateDurationSec(song),
      output_format:        'mp3',
      normalization_strategy: 'peak',
    },
  });

  const audioBuf = await toBuffer(output);
  const audioUrl = `data:audio/mpeg;base64,${audioBuf.toString('base64')}`;

  // MusicGen doesn't produce word timestamps; the AudioPlayer handles empty arrays gracefully
  return NextResponse.json({ audioUrl, wordTimestamps: [] });
}
