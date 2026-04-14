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
  return changed;
}

export async function POST(req: NextRequest) {
  const { song, sectionIndex, originalSection } = await req.json() as {
    song: Song;
    sectionIndex: number;
    originalSection?: SongSection;
  };

  const section = song.sections[sectionIndex];
  if (!section) return NextResponse.json({ error: 'Invalid section index' }, { status: 400 });

  const changedFields = originalSection ? diffSections(originalSection, section) : [];
  // Vocals-only when the only changes are to lyrics and/or vocalists
  const vocalsOnly = changedFields.length > 0 &&
    changedFields.every(f => f === 'lyrics' || f === 'vocalists');

  const sectionContext: SectionRegenerationContext | undefined = originalSection
    ? { originalSection, changedFields, vocalsOnly }
    : undefined;

  const singleSectionSong: Song = { ...song, sections: [section] };
  const provider = getAudioProvider();
  const { audioUrl, wordTimestamps } = await provider.generate(singleSectionSong, sectionContext);
  return NextResponse.json({ audioUrl, wordTimestamps: wordTimestamps ?? [], vocalsOnly });
}
