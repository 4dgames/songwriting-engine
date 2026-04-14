import { NextRequest, NextResponse } from 'next/server';
import Replicate from 'replicate';

// Vercel hobby plan cap is 300s; Demucs typically finishes well within that
export const maxDuration = 300;

async function streamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader();
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

async function toBuffer(output: unknown): Promise<Buffer> {
  if (output && typeof (output as ReadableStream).getReader === 'function') {
    return streamToBuffer(output as ReadableStream<Uint8Array>);
  }
  const url = typeof output === 'string' ? output : String(output);
  return Buffer.from(await (await fetch(url)).arrayBuffer());
}

export async function POST(req: NextRequest) {
  const token = process.env.REPLICATE_API_TOKEN ?? process.env.REPLICATE_API_KEY;
  if (!token) {
    return NextResponse.json({ error: 'REPLICATE_API_TOKEN (or REPLICATE_API_KEY) not configured' }, { status: 503 });
  }

  const { audioUrl } = await req.json() as { audioUrl: string };

  const replicate = new Replicate({ auth: token });

  // Upload instrumental to Replicate file storage
  const base64    = audioUrl.replace(/^data:[^;]+;base64,/, '');
  const audioBuf  = Buffer.from(base64, 'base64');
  // Detect format from the data URL prefix; fall back to audio/mpeg
  const mimeType  = audioUrl.match(/^data:([^;]+)/)?.[1] ?? 'audio/mpeg';
  const audioFile = await replicate.files.create(
    new Blob([audioBuf], { type: mimeType }),
  );

  // Run Demucs 4-stem (htdemucs): drums, bass, other, vocals
  const output = await replicate.run(
    'ryan5453/demucs:5a7041cc9b82e5a558fea6b3d7b12dea89625e89da33f0447bd727c2d0ab9e77',
    { input: { audio: audioFile.urls.get, model: 'htdemucs' } },
  ) as { bass: unknown; drums: unknown; other: unknown; vocals: unknown };

  // Collect all three instrument stems in parallel (skip vocals — already separated)
  const [drumsBuf, bassBuf, otherBuf] = await Promise.all([
    toBuffer(output.drums),
    toBuffer(output.bass),
    toBuffer(output.other),
  ]);

  return NextResponse.json({
    drums: `data:audio/wav;base64,${drumsBuf.toString('base64')}`,
    bass:  `data:audio/wav;base64,${bassBuf.toString('base64')}`,
    other: `data:audio/wav;base64,${otherBuf.toString('base64')}`,
  });
}
