import type { Song, SongSection, WordTimestamp } from '../types';

export interface AudioResult {
  audioUrl: string;
  instrumentalUrl?: string;
  vocalsUrl?: string;
  wordTimestamps?: WordTimestamp[];
}

export type ChangedField = 'lyrics' | 'chords' | 'instruments' | 'mood' | 'vocalists' | 'style';

export interface SectionRegenerationContext {
  originalSection: SongSection;
  changedFields: ChangedField[];
  vocalsOnly: boolean;
  /** Section immediately before the one being regenerated, for transition context. */
  prevSection?: SongSection;
  /** Section immediately after the one being regenerated, for transition context. */
  nextSection?: SongSection;
}

export interface AudioProvider {
  generate(song: Song, sectionContext?: SectionRegenerationContext, forceInstrumental?: boolean): Promise<AudioResult>;
}
