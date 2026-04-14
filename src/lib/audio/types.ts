import type { Song, SongSection, WordTimestamp } from '../types';

export interface AudioResult {
  audioUrl: string;
  instrumentalUrl?: string;
  vocalsUrl?: string;
  wordTimestamps?: WordTimestamp[];
}

export type ChangedField = 'lyrics' | 'chords' | 'instruments' | 'mood' | 'vocalists';

export interface SectionRegenerationContext {
  originalSection: SongSection;
  changedFields: ChangedField[];
  vocalsOnly: boolean;
}

export interface AudioProvider {
  generate(song: Song, sectionContext?: SectionRegenerationContext, forceInstrumental?: boolean): Promise<AudioResult>;
}
