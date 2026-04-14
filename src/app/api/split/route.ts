import { NextRequest, NextResponse } from 'next/server';
import AdmZip from 'adm-zip';

// ElevenLabs stem separation can take up to a minute for longer tracks.
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'ELEVENLABS_API_KEY not configured' }, { status: 503 });
  }

  const { audioUrl } = await req.json() as { audioUrl: string };

  // Decode base64 data URL to a Buffer.
  const base64  = audioUrl.replace(/^data:[^;]+;base64,/, '');
  const audioBuf = Buffer.from(base64, 'base64');

  // Upload to ElevenLabs /v1/music/separate-stems as multipart form data.
  // two_stems_v1 → returns a ZIP with vocals.mp3 + background.mp3
  const form = new FormData();
  form.append('file', new Blob([audioBuf], { type: 'audio/mpeg' }), 'audio.mp3');
  form.append('stem_variation_id', 'two_stems_v1');

  const res = await fetch('https://api.elevenlabs.io/v1/music/stem-separation', {
    method: 'POST',
    headers: { 'xi-api-key': apiKey },
    body: form,
  });

  if (!res.ok) {
    const text = await res.text();
    console.error('ElevenLabs separate-stems error:', res.status, text);
    return NextResponse.json({ error: `ElevenLabs error ${res.status}: ${text}` }, { status: res.status });
  }

  // Response is a ZIP file containing the separated stems.
  const zipBuf  = Buffer.from(await res.arrayBuffer());
  const zip     = new AdmZip(zipBuf);
  const entries = zip.getEntries();

  let vocalsBuf: Buffer | null      = null;
  let backgroundBuf: Buffer | null  = null;

  for (const entry of entries) {
    const name = entry.entryName.toLowerCase();
    if (name.includes('vocal')) {
      vocalsBuf      = entry.getData();
    } else if (name.includes('background') || name.includes('instrument') || name.includes('accomp') || name.includes('other')) {
      backgroundBuf  = entry.getData();
    }
  }

  // If we couldn't identify by name, fall back to index order (vocals first is conventional).
  if (!vocalsBuf || !backgroundBuf) {
    const sorted = entries
      .filter(e => !e.isDirectory)
      .sort((a, b) => a.entryName.localeCompare(b.entryName));
    if (sorted.length >= 2) {
      vocalsBuf      = sorted[0].getData();
      backgroundBuf  = sorted[1].getData();
    }
  }

  if (!vocalsBuf || !backgroundBuf) {
    const names = entries.map(e => e.entryName).join(', ');
    console.error('Could not find stems in ZIP. Entries:', names);
    return NextResponse.json({ error: `Could not parse stems from ZIP. Entries: ${names}` }, { status: 500 });
  }

  return NextResponse.json({
    vocals:       `data:audio/mp3;base64,${vocalsBuf.toString('base64')}`,
    instrumental: `data:audio/mp3;base64,${backgroundBuf.toString('base64')}`,
  });
}
