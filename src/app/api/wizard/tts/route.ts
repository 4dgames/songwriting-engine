import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 30;

export interface WordTiming {
  word: string;
  startSec: number;
  endSec: number;
}

function buildWordTimings(
  chars: string[],
  starts: number[],
  ends: number[],
): WordTiming[] {
  const words: WordTiming[] = [];
  let wordChars = '';
  let wordStart = 0;
  let wordEnd   = 0;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (/\s/.test(c)) {
      if (wordChars) {
        words.push({ word: wordChars, startSec: wordStart, endSec: wordEnd });
        wordChars = '';
      }
    } else {
      if (!wordChars) wordStart = starts[i] ?? 0;
      wordChars += c;
      wordEnd    = ends[i]   ?? 0;
    }
  }
  if (wordChars) words.push({ word: wordChars, startSec: wordStart, endSec: wordEnd });
  return words;
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'ELEVENLABS_API_KEY not configured' }, { status: 503 });
  }

  const { text, rate, voiceId: bodyVoiceId } = await req.json() as { text: string; rate?: number; voiceId?: string };
  if (!text?.trim()) return NextResponse.json({ error: 'text required' }, { status: 400 });
  const speed = Math.min(1.2, Math.max(0.7, rate ?? 1.0));

  const voiceId = process.env.ELEVENLABS_WIZARD_VOICE_ID ?? bodyVoiceId ?? 'JBFqnCBsd6RMkjVDRZzb';

  // Use the synchronous /with-timestamps endpoint — simpler, returns one JSON object
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps`,
    {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: text.trim(),
        model_id: 'eleven_turbo_v2_5',
        voice_settings: { stability: 0.40, similarity_boost: 0.75, style: 0.10, speed },
      }),
    },
  );

  if (!res.ok) {
    const body = await res.text();
    console.error('ElevenLabs TTS error:', res.status, body);
    return NextResponse.json({ error: `TTS error ${res.status}: ${body}` }, { status: res.status });
  }

  const data = await res.json() as {
    audio_base64: string;
    alignment?: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] };
    normalized_alignment?: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] };
  };

  const align = data.normalized_alignment ?? data.alignment;
  const words = align
    ? buildWordTimings(
        align.characters,
        align.character_start_times_seconds,
        align.character_end_times_seconds,
      )
    : [];

  return NextResponse.json({ audioBase64: data.audio_base64, words });
}
