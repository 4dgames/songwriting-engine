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
  const { song, sectionIndex, originalSection, regenMode } = await req.json() as {
    song: Song;
    sectionIndex: number;
    originalSection?: SongSection;
    regenMode?: 'vocals' | 'instruments' | 'both';
  };

  const prevSection = song.sections[sectionIndex - 1] as SongSection | undefined;
  const nextSection = song.sections[sectionIndex + 1] as SongSection | undefined;

  const section = song.sections[sectionIndex];
  if (!section) return NextResponse.json({ error: 'Invalid section index' }, { status: 400 });

  const changedFields = originalSection ? diffSections(originalSection, section) : [];

  // Explicit mode takes priority; fall back to auto-detection from changed fields
  let vocalsOnly: boolean;
  let instrumentalOnly: boolean;
  if (regenMode === 'vocals') {
    vocalsOnly = true;
    instrumentalOnly = false;
  } else if (regenMode === 'instruments') {
    vocalsOnly = false;
    instrumentalOnly = true;
  } else {
    // 'both' or no explicit mode — auto-detect from changed fields
    vocalsOnly = changedFields.length > 0 &&
      changedFields.every(f => f === 'lyrics' || f === 'vocalists');
    instrumentalOnly = false;
  }

  const sectionContext: SectionRegenerationContext | undefined = originalSection
    ? { originalSection, changedFields, vocalsOnly, prevSection, nextSection }
    : undefined;

  const singleSectionSong: Song = { ...song, sections: [section] };
  const provider = getAudioProvider();
  const { audioUrl, wordTimestamps } = await provider.generate(
    singleSectionSong,
    sectionContext,
    instrumentalOnly,
  );
  return NextResponse.json({ audioUrl, wordTimestamps: wordTimestamps ?? [], vocalsOnly, instrumentalOnly });
}
