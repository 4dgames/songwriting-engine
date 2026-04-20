import { NextRequest, NextResponse } from 'next/server';
import { getAudioProvider } from '@/lib/audio/suno';
import type { ChangedField, SectionRegenerationContext } from '@/lib/audio/types';
import type { Song, SongSection } from '@/lib/types';

export const maxDuration = 120;

function diffSections(original: SongSection, current: SongSection): ChangedField[] {
  const changed: ChangedField[] = [];
  if (original.lyrics !== current.lyrics) changed.push('lyrics');
  if (JSON.stringify(original.chords) !== JSON.stringify(current.chords)) changed.push('chords');
  if (JSON.stringify(original.instruments ?? []) !== JSON.stringify(current.instruments ?? [])) changed.push('instruments');
  if ((original.mood ?? '') !== (current.mood ?? '')) changed.push('mood');
  if (JSON.stringify(original.vocalists ?? []) !== JSON.stringify(current.vocalists ?? [])) changed.push('vocalists');
  if ((original.style ?? '') !== (current.style ?? '')) changed.push('style');
  return changed;
}

export async function POST(req: NextRequest) {
  const { song, sectionIndex, originalSection, mode } = await req.json() as {
    song: Song;
    sectionIndex: number;
    originalSection?: SongSection;
    mode?: 'both' | 'vocals' | 'instrumental';
  };

  const section = song.sections[sectionIndex];
  if (!section) return NextResponse.json({ error: 'Invalid section index' }, { status: 400 });

  const prevSection = song.sections[sectionIndex - 1] as SongSection | undefined;
  const nextSection = song.sections[sectionIndex + 1] as SongSection | undefined;
  const changedFields = originalSection ? diffSections(originalSection, section) : [];

  const sectionContext: SectionRegenerationContext = {
    originalSection: originalSection ?? section,
    changedFields,
    vocalsOnly: mode === 'vocals',
    prevSection,
    nextSection,
  };

  const singleSection: Song = { ...song, sections: [section] };

  const provider = getAudioProvider();
  const result = await provider.generate(singleSection, sectionContext, mode === 'instrumental');

  return NextResponse.json({
    audioUrl:       result.audioUrl,
    wordTimestamps: result.wordTimestamps ?? [],
  });
}
