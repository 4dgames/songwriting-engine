import { NextRequest, NextResponse } from 'next/server';
import type { Song } from '@/lib/types';

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const { song, sectionIndex, directive } = await req.json() as {
    song: Song;
    sectionIndex: number;
    directive?: string;
  };

  const section = song.sections[sectionIndex];
  if (!section) return NextResponse.json({ error: 'Invalid section index' }, { status: 400 });

  const styleDesc = [section.style, section.mood].filter(Boolean).join(', ');
  const current = section.chords.length > 0 ? section.chords.join(' ') : null;

  let prompt: string;

  if (directive && current) {
    prompt = `Transform this chord progression: ${current}
Make it ${directive}. Keep exactly ${section.chords.length} chords.
Key: ${song.key}
Genre: ${song.genre}${styleDesc ? `\nStyle: ${styleDesc}` : ''}
Section: ${section.type}

Return ONLY the chord names separated by spaces, nothing else. Example: Am F C G`;
  } else {
    prompt = `Generate a ${section.chords.length > 0 ? section.chords.length : 4}-chord progression.
Key: ${song.key}
Genre: ${song.genre}${styleDesc ? `\nStyle: ${styleDesc}` : ''}
Section: ${section.type}${section.mood ? `\nMood: ${section.mood}` : ''}

Return ONLY the chord names separated by spaces, nothing else. Example: Am F C G`;
  }

  const res = await fetch(process.env.LLM_GATEWAY_URL!, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.LLM_GATEWAY_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 60,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) throw new Error(`LLM Gateway error: ${res.status} ${await res.text()}`);

  const data = await res.json() as { choices: { message: { content: string } }[] };
  const text = data.choices[0]?.message?.content?.trim() ?? '';
  const chords = text.split(/\s+/).filter(s => /^[A-Gb#]/.test(s));

  return NextResponse.json({ chords });
}
