export type SectionType = 'intro' | 'verse' | 'pre-chorus' | 'chorus' | 'bridge' | 'outro';

export interface SongSection {
  type: SectionType;
  label: string;
  lyrics: string;
  chords: string[];
  mood?: string;
  instruments?: string[];
  vocalists?: string[]; // vocalist IDs from vocalists.ts
  durationMs?: number;  // override auto-estimated section duration (3000–120000 ms)
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
}
