export type SectionType = 'intro' | 'verse' | 'pre-chorus' | 'chorus' | 'bridge' | 'outro';

export interface SongSection {
  type: SectionType;
  label: string;
  lyrics: string;
  chords: string[];
  mood?: string;
  instruments?: string[];
  style?: string;       // per-section genre/style override (e.g. "country", "punk rock", "jazz")
  vocalists?: string[]; // vocalist IDs from vocalists.ts
  durationMs?: number;  // override duration in ms
  positiveStylesAdd?: string[];    // user-added positive style tags
  positiveStylesRemove?: string[]; // computed positive style tags the user removed
}

export interface WordTimestamp {
  word: string;
  start_ms: number;
  end_ms: number;
}

export interface SectionTake {
  id: string;
  label: string;
  section: SongSection;
  audioUrl: string;           // backward compat (= instrumentalUrl)
  instrumentalUrl?: string;
  vocalsUrl?: string;
  wordTimestamps: WordTimestamp[];
}

export interface Song {
  title: string;
  genre: string;
  mood: string;
  tempo: number;
  key: string;
  sections: SongSection[];
  audioPrompt: string;
  audioUrl?: string;
  wordTimestamps?: WordTimestamp[];
  positiveGlobalAdd?: string[];    // user-added positive global style tags
  positiveGlobalRemove?: string[]; // computed positive global tags the user removed
  negativeGlobalAdd?: string[];    // user-added negative global style tags
  negativeGlobalRemove?: string[]; // computed negative global tags the user removed
}
