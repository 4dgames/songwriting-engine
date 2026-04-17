import { NextRequest, NextResponse } from 'next/server';
import { getAudioProvider } from '@/lib/audio/suno';
import type { Song } from '@/lib/types';

export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const body = await req.json() as Song & { forceInstrumental?: boolean };
  const { forceInstrumental, ...song } = body;

  if (!song?.genre?.trim()) {
    return NextResponse.json({ error: 'genre is required' }, { status: 400 });
  }

  const provider = getAudioProvider();
  const { audioUrl, wordTimestamps } = await provider.generate(song, undefined, forceInstrumental ?? false);
  return NextResponse.json({ audioUrl, wordTimestamps: wordTimestamps ?? [] });
}
