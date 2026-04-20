/**
 * Pure, client-safe helpers for computing ElevenLabs composition plan tags.
 * Imported by both elevenlabs.ts (server) and the UI (client).
 */
import type { Song, SectionType } from '../types';
import { getVocalStyleTags } from '../vocalists';

export const SECTION_STYLES: Record<SectionType, { positive: string[]; negative: string[] }> = {
  intro:        { positive: ['atmospheric', 'building', 'anticipation'], negative: ['abrupt', 'climactic'] },
  verse:        { positive: ['storytelling', 'melodic', 'building tension'], negative: ['climactic', 'chaotic'] },
  'pre-chorus': { positive: ['building', 'anticipation', 'rising energy'], negative: ['dropping', 'subdued'] },
  chorus:       { positive: ['anthemic', 'powerful', 'catchy', 'uplifting'], negative: ['subdued', 'quiet', 'sparse'] },
  bridge:       { positive: ['contrast', 'emotional depth', 'surprising'], negative: ['predictable', 'repetitive'] },
  outro:        { positive: ['resolution', 'fading', 'reflective'], negative: ['abrupt', 'building'] },
};

const GENRE_VOCABULARY = [
  'folk', 'rock', 'pop', 'jazz', 'blues', 'country', 'electronic', 'ambient', 'indie',
  'classical', 'hip-hop', 'r&b', 'soul', 'reggae', 'punk', 'metal', 'acoustic', 'cinematic',
  'funk', 'disco', 'gospel', 'latin', 'bossa nova', 'samba', 'trap', 'dancehall', 'ska',
  'house', 'techno', 'edm', 'synth-pop', 'new wave', 'grunge', 'alt-rock', 'hard rock',
  'heavy metal', 'death metal', 'progressive', 'psychedelic', 'neo-soul', 'afrobeat',
  'swing', 'bebop', 'bluegrass', 'americana', 'indie pop', 'indie rock', 'dream pop',
];

const STYLE_VOCABULARY = [
  ...GENRE_VOCABULARY,
  'reverb', 'echo', 'warm', 'bright', 'dark', 'raw', 'polished', 'lo-fi', 'intimate',
  'sparse', 'lush', 'layered', 'minimal', 'driving', 'groovy', 'fingerpicking', 'strumming',
  'arpeggiated', 'distorted', 'clean', 'melancholic', 'energetic', 'mellow', 'dramatic',
  'uplifting', 'nostalgic', 'upbeat', 'atmospheric', 'confessional', 'anthemic', 'funky',
  'syncopated', 'rhythmic', 'bass-heavy', 'horn-driven', 'organ-driven',
  'falsetto', 'harmonies', 'breathy', 'powerful', 'delicate', 'raspy', 'smooth',
  'male vocalist', 'female vocalist', 'male vocal', 'female vocal',
];

const STYLE_ALIASES: [RegExp, string][] = [
  [/\bhip hop\b/g,       'hip-hop'],
  [/\br&b\b|\brnb\b|\br 'n' b\b|\br and b\b/g, 'r&b'],
  [/\balt rock\b/g,      'alt-rock'],
  [/\bsynth pop\b/g,     'synth-pop'],
  [/\bneo soul\b/g,      'neo-soul'],
  [/\blo fi\b|\blofi\b/g,'lo-fi'],
  [/\bbass heavy\b/g,    'bass-heavy'],
  [/\bhorn driven\b/g,   'horn-driven'],
  [/\borgan driven\b/g,  'organ-driven'],
  [/\bheavy metal\b/g,   'heavy metal'],
  [/\bhard rock\b/g,     'hard rock'],
  [/\bdream pop\b/g,     'dream pop'],
  [/\bindie pop\b/g,     'indie pop'],
  [/\bindie rock\b/g,    'indie rock'],
  [/\bbossa nova\b/g,    'bossa nova'],
];

const FILLER_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'for', 'nor', 'so', 'yet',
  'to', 'in', 'of', 'is', 'it', 'at', 'by', 'as', 'up', 'its',
  'with', 'that', 'this', 'from', 'into', 'very', 'also',
]);

export function tokenize(text: string): string[] {
  return text.split(/[\s,/]+/).filter(s => s.length > 2 && !FILLER_WORDS.has(s));
}

export function normalizeStyleText(text: string): string {
  let s = text.toLowerCase();
  for (const [pattern, canonical] of STYLE_ALIASES) {
    s = s.replace(pattern, canonical);
  }
  return s;
}

export function extractStyleTerms(text: string): string[] {
  const normalized = normalizeStyleText(text);
  return STYLE_VOCABULARY.filter(term => normalized.includes(term));
}

export function excludedGenres(activeGenreText: string): string[] {
  const normalized = normalizeStyleText(activeGenreText);
  const active = new Set(GENRE_VOCABULARY.filter(g => normalized.includes(g)));
  return GENRE_VOCABULARY.filter(g => !active.has(g));
}

export const KNOWN_INSTRUMENTS = [
  'acoustic guitar', 'electric guitar', 'bass guitar', 'drum kit',
  'guitar', 'bass', 'drums', 'percussion', 'piano', 'keyboard', 'synth', 'synthesizer',
  'violin', 'viola', 'cello', 'strings', 'orchestra', 'trumpet', 'saxophone', 'sax',
  'flute', 'clarinet', 'trombone', 'horns', 'brass', 'banjo', 'mandolin', 'ukulele',
  'harp', 'organ', 'hammond', 'pad', 'pads', 'choir', 'vocals',
  '808', 'hi-hat', 'snare', 'kick',
];

export const DEFAULT_INSTRUMENTS = ['guitar', 'drums', 'bass'];

export function extractInstruments(text: string): string[] {
  const lower = text.toLowerCase();
  const found = KNOWN_INSTRUMENTS.filter(inst => lower.includes(inst));
  return found.length > 0 ? found : DEFAULT_INSTRUMENTS;
}

export function instrumentExclusions(chosenInstruments: string[], hasLyrics: boolean): string[] {
  const VOCAL_INSTRUMENTS = new Set(['vocals', 'choir']);
  const lower = chosenInstruments.map(i => i.toLowerCase());
  return KNOWN_INSTRUMENTS.filter(inst => {
    if (hasLyrics && VOCAL_INSTRUMENTS.has(inst)) return false;
    return !lower.some(chosen => chosen.includes(inst) || inst.includes(chosen));
  });
}

export interface SectionCompositionPlan {
  positiveLocal: string[];
  negativeLocal: string[];
}

export interface GlobalCompositionPlan {
  positiveGlobal: string[];
  negativeGlobal: string[];
}

/**
 * Computes the positive and negative *global* style tags that would be sent to
 * ElevenLabs for the entire song — mirrors the logic in elevenlabs.ts buildCompositionBody.
 */
export function computeGlobalCompositionPlan(song: Song): GlobalCompositionPlan {
  const normGenre  = normalizeStyleText(song.genre);
  const normMood   = normalizeStyleText(song.mood);
  const styleTerms = extractStyleTerms(song.genre + ' ' + song.mood);

  // Deduplicate while preserving order
  const seen = new Set<string>();
  const dedup = (tags: string[]) => tags.filter(t => !seen.has(t) && seen.add(t) && true);

  let positiveGlobal = dedup([
    normGenre,
    ...tokenize(normGenre),
    ...tokenize(normMood),
    ...styleTerms,
    `${song.tempo} bpm`,
    song.key,
    'starts on beat 1', 'downbeat entry', 'on the beat',
  ]);

  // Apply user overrides (same pattern as per-section positiveStylesAdd/Remove)
  if (song.positiveGlobalRemove?.length || song.positiveGlobalAdd?.length) {
    const removedSet = new Set(song.positiveGlobalRemove ?? []);
    positiveGlobal = [
      ...positiveGlobal.filter(t => !removedSet.has(t)),
      ...(song.positiveGlobalAdd ?? []),
    ];
  }

  let negativeGlobal = [
    'noise', 'distortion',
    'pickup notes', 'anacrusis', 'before the beat', 'upbeat start', 'pre-beat',
    'acapella', 'vocals only',
    ...excludedGenres(normGenre),
  ].slice(0, 50);

  if (song.negativeGlobalRemove?.length || song.negativeGlobalAdd?.length) {
    const removedSet = new Set(song.negativeGlobalRemove ?? []);
    negativeGlobal = [
      ...negativeGlobal.filter(t => !removedSet.has(t)),
      ...(song.negativeGlobalAdd ?? []),
    ];
  }

  return { positiveGlobal, negativeGlobal };
}

/**
 * Computes the positive and negative local style tags that would be sent to
 * ElevenLabs for a given section, without any API calls or server dependencies.
 */
export function computeCompositionPlan(song: Song, sectionIndex: number): SectionCompositionPlan {
  const section = song.sections[sectionIndex];
  const prevSection = song.sections[sectionIndex - 1] as typeof section | undefined;
  const nextSection = song.sections[sectionIndex + 1] as typeof section | undefined;

  const allSectionInstruments = song.sections.flatMap(s => s.instruments ?? []);
  const globalInstruments = allSectionInstruments.length > 0
    ? [...new Set(allSectionInstruments)]
    : extractInstruments(song.audioPrompt);

  const normGenre = normalizeStyleText(song.genre);
  const globalGenreTokens = tokenize(normGenre);

  const lines = section.lyrics.split('\n').map(l => l.trim()).filter(Boolean);
  const isInstrumental = lines.length === 0;
  const styles = SECTION_STYLES[section.type] ?? SECTION_STYLES.verse;

  const normSectionMood = section.mood ? normalizeStyleText(section.mood) : '';
  const sectionMoodTags = normSectionMood ? tokenize(normSectionMood) : [];

  const normSectionStyle = section.style ? normalizeStyleText(section.style) : '';
  const sectionStyleTokens = normSectionStyle ? tokenize(normSectionStyle) : [];
  const sectionStyleTags = section.style
    ? [...new Set([normSectionStyle, ...sectionStyleTokens, ...extractStyleTerms(section.style)])]
    : [];

  const styleConflictNegatives = section.style
    ? globalGenreTokens.filter(t => !sectionStyleTokens.includes(t))
    : [];

  const activeGenreForSection = normSectionStyle || normGenre;
  const sectionGenreExclusions = excludedGenres(activeGenreForSection);

  const chordTags = section.chords.length > 0
    ? [
        `exact chord progression: ${section.chords.join(' ')}`,
        `${section.chords.join(' ')} chord progression`,
        ...section.chords,
      ]
    : [];
  const chordNegatives = section.chords.length > 0
    ? ['wrong chords', 'different chords', 'different chord progression', 'improvised harmony', 'random chords']
    : [];

  const sectionInstruments = section.instruments?.length
    ? section.instruments
    : section.style
      ? extractInstruments(section.style)
      : globalInstruments;

  const vocalTags = (!isInstrumental && section.vocalists?.length)
    ? getVocalStyleTags(section.vocalists)
    : [];

  const vocalistGenderNegatives: string[] = [];
  if (vocalTags.length > 0) {
    const hasFemale = vocalTags.some(t => t.includes('female'));
    const hasMale   = vocalTags.some(t => t.includes('male') && !t.includes('female'));
    if (hasFemale && !hasMale) vocalistGenderNegatives.push('male vocal', 'male vocalist', 'male voice');
    if (hasMale && !hasFemale) vocalistGenderNegatives.push('female vocal', 'female vocalist', 'female voice');
  }

  const instExclusions = instrumentExclusions(sectionInstruments, !isInstrumental);

  let positiveLocal = [
    'starts on beat 1', 'downbeat entry',
    ...chordTags,
    ...sectionStyleTags,
    ...vocalTags,
    ...sectionMoodTags,
    ...styles.positive,
    ...sectionInstruments,
  ];

  // Prev-section context only — earlier sections are not influenced by later ones
  if (prevSection) {
    const prevStyle = prevSection.style ? normalizeStyleText(prevSection.style) : null;
    const prevLastChord = prevSection.chords[prevSection.chords.length - 1];
    const prevMoodTokens = prevSection.mood ? tokenize(normalizeStyleText(prevSection.mood)) : [];
    positiveLocal = [
      ...positiveLocal,
      `continues from ${prevSection.type}`,
      ...(prevLastChord ? [`resolves from ${prevLastChord}`] : []),
      ...(prevStyle ? [`after ${prevStyle}`] : []),
      ...(prevMoodTokens.length ? [`from ${prevMoodTokens[0]}`] : []),
    ];
  }

  const negativeLocal = [
    'pickup notes', 'anacrusis', 'before the beat',
    ...vocalistGenderNegatives,
    ...styleConflictNegatives,
    ...styles.negative,
    ...(isInstrumental ? ['vocals', 'singing', 'lyrics'] : []),
    ...chordNegatives,
    ...instExclusions,
    ...sectionGenreExclusions,
  ].slice(0, 50);

  return { positiveLocal, negativeLocal };
}
