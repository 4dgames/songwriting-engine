import type { AudioProvider, AudioResult, SectionRegenerationContext } from './types';
import type { Song, SectionType, WordTimestamp } from '../types';
import { getVocalStyleTags } from '../vocalists';

const SECTION_STYLES: Record<SectionType, { positive: string[]; negative: string[] }> = {
  intro:        { positive: ['atmospheric', 'building', 'anticipation'], negative: ['abrupt', 'climactic'] },
  verse:        { positive: ['storytelling', 'melodic', 'building tension'], negative: ['climactic', 'chaotic'] },
  'pre-chorus': { positive: ['building', 'anticipation', 'rising energy'], negative: ['dropping', 'subdued'] },
  chorus:       { positive: ['anthemic', 'powerful', 'catchy', 'uplifting'], negative: ['subdued', 'quiet', 'sparse'] },
  bridge:       { positive: ['contrast', 'emotional depth', 'surprising'], negative: ['predictable', 'repetitive'] },
  outro:        { positive: ['resolution', 'fading', 'reflective'], negative: ['abrupt', 'building'] },
};

/** Round bars to nearest multiple of 2, with 1 as the only allowed odd value. */
function roundToBars(bars: number): number {
  if (bars <= 1) return 1;
  return Math.max(2, Math.round(bars / 2) * 2);
}

function estimateDurationMs(_lines: string[], tempo: number): number {
  // Default to 8 bars; durationMs should always be explicitly set upstream
  return Math.round(8 * 240000 / tempo);
}

// Genre terms only — used for exclusion negatives
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
  // Texture / production
  'reverb', 'echo', 'warm', 'bright', 'dark', 'raw', 'polished', 'lo-fi', 'intimate',
  'sparse', 'lush', 'layered', 'minimal', 'driving', 'groovy', 'fingerpicking', 'strumming',
  'arpeggiated', 'distorted', 'clean', 'melancholic', 'energetic', 'mellow', 'dramatic',
  'uplifting', 'nostalgic', 'upbeat', 'atmospheric', 'confessional', 'anthemic', 'funky',
  'syncopated', 'rhythmic', 'bass-heavy', 'horn-driven', 'organ-driven',
  // Vocals
  'falsetto', 'harmonies', 'breathy', 'powerful', 'delicate', 'raspy', 'smooth',
  'male vocalist', 'female vocalist', 'male vocal', 'female vocal',
];

// Alternate spellings / common variants that should map to canonical vocabulary terms
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
  [/\bheavy metal\b/g,   'heavy metal'],  // already canonical but keep for safety
  [/\bhard rock\b/g,     'hard rock'],
  [/\bdream pop\b/g,     'dream pop'],
  [/\bindie pop\b/g,     'indie pop'],
  [/\bindie rock\b/g,    'indie rock'],
  [/\bbossa nova\b/g,    'bossa nova'],
];

// Common English connectives, articles, and prepositions that carry no musical meaning
const FILLER_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'for', 'nor', 'so', 'yet',
  'to', 'in', 'of', 'is', 'it', 'at', 'by', 'as', 'up', 'its',
  'with', 'that', 'this', 'from', 'into', 'very', 'also',
]);

/** Split text into style tokens, dropping filler words and anything under 3 characters. */
function tokenize(text: string): string[] {
  return text.split(/[\s,/]+/).filter(s => s.length > 2 && !FILLER_WORDS.has(s));
}

function normalizeStyleText(text: string): string {
  let s = text.toLowerCase();
  for (const [pattern, canonical] of STYLE_ALIASES) {
    s = s.replace(pattern, canonical);
  }
  return s;
}

function extractStyleTerms(text: string): string[] {
  const normalized = normalizeStyleText(text);
  return STYLE_VOCABULARY.filter(term => normalized.includes(term));
}

/**
 * Returns every genre in GENRE_VOCABULARY that is NOT matched by activeGenreText.
 * Used to fill negative styles so ElevenLabs knows to avoid all other genres.
 */
function excludedGenres(activeGenreText: string): string[] {
  const normalized = normalizeStyleText(activeGenreText);
  const active = new Set(GENRE_VOCABULARY.filter(g => normalized.includes(g)));
  return GENRE_VOCABULARY.filter(g => !active.has(g));
}

const KNOWN_INSTRUMENTS = [
  'acoustic guitar', 'electric guitar', 'bass guitar', 'drum kit',
  'guitar', 'bass', 'drums', 'percussion', 'piano', 'keyboard', 'synth', 'synthesizer',
  'violin', 'viola', 'cello', 'strings', 'orchestra', 'trumpet', 'saxophone', 'sax',
  'flute', 'clarinet', 'trombone', 'horns', 'brass', 'banjo', 'mandolin', 'ukulele',
  'harp', 'organ', 'hammond', 'pad', 'pads', 'choir', 'vocals',
  '808', 'hi-hat', 'snare', 'kick',
];

const DEFAULT_INSTRUMENTS = ['guitar', 'drums', 'bass'];

function extractInstruments(text: string): string[] {
  const lower = text.toLowerCase();
  const found = KNOWN_INSTRUMENTS.filter(inst => lower.includes(inst));
  return found.length > 0 ? found : DEFAULT_INSTRUMENTS;
}

/**
 * Returns every instrument in KNOWN_INSTRUMENTS that is NOT covered by the chosen instruments.
 * Uses substring matching in both directions so choosing 'guitar' won't negate 'acoustic guitar'.
 * Vocal-adjacent instruments ('vocals', 'choir') are omitted when the section has lyrics.
 */
function instrumentExclusions(chosenInstruments: string[], hasLyrics: boolean): string[] {
  const VOCAL_INSTRUMENTS = new Set(['vocals', 'choir']);
  const lower = chosenInstruments.map(i => i.toLowerCase());
  return KNOWN_INSTRUMENTS.filter(inst => {
    if (hasLyrics && VOCAL_INSTRUMENTS.has(inst)) return false;
    return !lower.some(chosen => chosen.includes(inst) || inst.includes(chosen));
  });
}

interface MultipartResult {
  wordTimestamps: WordTimestamp[];
  audioBuffer: Buffer;
}

function parseMultipart(buf: Buffer, boundary: string): MultipartResult {
  const jsonStart = buf.indexOf('{');
  const boundaryBuf = Buffer.from(`\r\n--${boundary}`);
  const boundaryPos = buf.indexOf(boundaryBuf, jsonStart);
  const json = JSON.parse(buf.slice(jsonStart, boundaryPos > -1 ? boundaryPos : buf.length).toString('utf8'));
  const wordTimestamps: WordTimestamp[] = json.words_timestamps ?? [];

  const id3Pos = buf.indexOf(Buffer.from('ID3'));
  if (id3Pos === -1) throw new Error('No audio found in multipart response');

  const trailingBoundary = buf.indexOf(Buffer.from(`\r\n--${boundary}--`), id3Pos);
  const audioBuffer = buf.slice(id3Pos, trailingBoundary > -1 ? trailingBoundary : undefined);

  return { wordTimestamps, audioBuffer };
}

export class ElevenLabsProvider implements AudioProvider {
  private apiKey: string;

  constructor() {
    this.apiKey = process.env.ELEVENLABS_API_KEY ?? '';
  }

  /** Makes one API call and returns the audio URL + timestamps. */
  private async callAPI(body: object): Promise<{ audioUrl: string; wordTimestamps: WordTimestamp[] }> {
    const res = await fetch('https://api.elevenlabs.io/v1/music/detailed', {
      method: 'POST',
      headers: { 'xi-api-key': this.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`ElevenLabs error: ${res.status} ${await res.text()}`);
    const ct = res.headers.get('content-type') ?? '';
    const boundaryMatch = ct.match(/boundary=([^\s;]+)/);
    if (!boundaryMatch) throw new Error('Expected multipart response');
    const buf = Buffer.from(await res.arrayBuffer());
    const { wordTimestamps, audioBuffer } = parseMultipart(buf, boundaryMatch[1]);
    return {
      audioUrl: `data:audio/mpeg;base64,${audioBuffer.toString('base64')}`,
      wordTimestamps,
    };
  }

  private buildCompositionBody(
    song: Song,
    forceInstrumental: boolean,
    sectionContext?: SectionRegenerationContext,
  ): object {
    // Aggregate instruments from sections first; fall back to audioPrompt extraction
    const allSectionInstruments = song.sections.flatMap(s => s.instruments ?? []);
    const globalInstruments = allSectionInstruments.length > 0
      ? [...new Set(allSectionInstruments)]
      : extractInstruments(song.audioPrompt);

    // Global style from song-level metadata only (not audioPrompt, which is Suno-targeted)
    const normGenre = normalizeStyleText(song.genre);
    const normMood  = normalizeStyleText(song.mood);
    const styleTerms = extractStyleTerms(song.genre + ' ' + song.mood);

    const positiveGlobal = [
      normGenre,                                                             // full phrase — highest priority
      ...tokenize(normGenre),              // individual tokens
      ...tokenize(normMood),
      ...styleTerms,
      `${song.tempo} bpm`,
      song.key,
      'starts on beat 1', 'downbeat entry', 'on the beat',
    ];

    const negativeGlobal = [
      'noise', 'distortion',
      'pickup notes', 'anacrusis', 'before the beat', 'upbeat start', 'pre-beat',
      ...(forceInstrumental ? ['vocals', 'singing', 'voice', 'lyrics', 'acapella'] : ['acapella', 'vocals only']),
      ...excludedGenres(normGenre),   // every other genre — lowest priority, trimmed to fit
    ].slice(0, 50);

    // Global genre tokens — used to suppress conflicting global style in per-section negatives
    const globalGenreTokens = tokenize(normGenre);

    const sections = song.sections.map(section => {
      // For instrumental-only, treat every section as having no lyrics
      const lines = forceInstrumental
        ? []
        : section.lyrics.split('\n').map(l => l.trim()).filter(Boolean);
      const styles = SECTION_STYLES[section.type] ?? SECTION_STYLES.verse;
      const normSectionMood = section.mood ? normalizeStyleText(section.mood) : '';
      const sectionMoodTags = normSectionMood
        ? tokenize(normSectionMood)
        : [];

      // Per-section genre/style override: extract both vocabulary terms and raw tokens
      const normSectionStyle = section.style ? normalizeStyleText(section.style) : '';
      const sectionStyleTokens = normSectionStyle
        ? tokenize(normSectionStyle)
        : [];
      const sectionStyleTags = section.style
        ? [...new Set([normSectionStyle, ...sectionStyleTokens, ...extractStyleTerms(section.style)])]
        : [];

      // When a section has its own style, push the conflicting global genre terms away
      const styleConflictNegatives = section.style
        ? globalGenreTokens.filter(t => !sectionStyleTokens.includes(t))
        : [];

      // Exclude every genre that is NOT the active genre for this section
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

      // Prefer section instruments, then infer from section style, then fall back to global
      const sectionInstruments = section.instruments?.length
        ? section.instruments
        : section.style
          ? extractInstruments(section.style)
          : globalInstruments;

      const isInstrumental = lines.length === 0;
      const vocalTags = (!isInstrumental && section.vocalists?.length)
        ? getVocalStyleTags(section.vocalists)
        : [];

      // Suppress the opposite gender when a vocalist is chosen
      const vocalistGenderNegatives: string[] = [];
      if (vocalTags.length > 0) {
        const hasFemale = vocalTags.some(t => t.includes('female'));
        const hasMale   = vocalTags.some(t => t.includes('male') && !t.includes('female'));
        if (hasFemale && !hasMale) vocalistGenderNegatives.push('male vocal', 'male vocalist', 'male voice');
        if (hasMale && !hasFemale) vocalistGenderNegatives.push('female vocal', 'female vocalist', 'female voice');
      }

      // Priority order: chords first (exact, must follow), then section style, vocals, mood, section type, instruments
      let positiveLocal = [
        'starts on beat 1', 'downbeat entry',  // beat-alignment — must precede lyrics
        ...chordTags,             // chord progression — highest priority when specified
        ...sectionStyleTags,      // section genre
        ...vocalTags,             // vocalist
        ...sectionMoodTags,
        ...styles.positive,
        ...sectionInstruments,
      ];
      const instExclusions = instrumentExclusions(sectionInstruments, !isInstrumental);

      // Most specific negatives first — they're guaranteed to fit.
      // Genre exclusions go last so they fill remaining budget without evicting specific signals.
      let negativeLocal = [
        'pickup notes', 'anacrusis', 'before the beat',  // no pre-beat content
        ...vocalistGenderNegatives,   // push opposite gender away
        ...styleConflictNegatives,    // push global genre away when section has its own style
        ...styles.negative,
        ...(isInstrumental ? ['vocals', 'singing', 'lyrics'] : []),
        ...chordNegatives,            // push away wrong/improvised chords
        ...instExclusions,            // every other known instrument
        ...sectionGenreExclusions,    // every other genre — trimmed to fit
      ].slice(0, 50);

      if (sectionContext) {
        const { changedFields, prevSection, nextSection } = sectionContext;
        const styleChanged = changedFields.includes('style');
        const onlyInstrumentsChanged =
          changedFields.length > 0 && changedFields.every(f => f === 'instruments');
        if (onlyInstrumentsChanged) {
          // Only instrumentation changed — lock vocals in place
          positiveLocal = [
            ...positiveLocal,
            'same vocal melody', 'same vocal performance', 'same phrasing',
            `${song.tempo} bpm`, song.key,
          ];
          negativeLocal = [...negativeLocal, 'different melody', 'different tempo', 'different key'].slice(0, 50);
        } else if (!changedFields.includes('lyrics') && !styleChanged) {
          // Nothing that should affect voice changed — nudge toward consistency
          positiveLocal = [...positiveLocal, 'same vocal style', `${song.tempo} bpm`, song.key];
          negativeLocal = [...negativeLocal, 'different tempo', 'different key'].slice(0, 50);
        }
        // If style changed: no consistency nudges — let the new style tags drive the output freely

        // ── Transition context: what comes before and after ──────────────────────
        // Tell the model what musical territory it's connecting, so it can generate
        // an appropriate entry and exit. Applied for all regeneration modes.
        if (prevSection) {
          const prevStyle = prevSection.style ? normalizeStyleText(prevSection.style) : null;
          const prevLastChord = prevSection.chords[prevSection.chords.length - 1];
          const prevMoodTokens = prevSection.mood
            ? tokenize(normalizeStyleText(prevSection.mood))
            : [];
          positiveLocal = [
            ...positiveLocal,
            `continues from ${prevSection.type}`,
            ...(prevLastChord ? [`resolves from ${prevLastChord}`] : []),
            ...(prevStyle ? [`after ${prevStyle}`] : []),
            ...(prevMoodTokens.length ? [`from ${prevMoodTokens[0]}`] : []),
          ];
        }

        if (nextSection) {
          const nextStyle = nextSection.style ? normalizeStyleText(nextSection.style) : null;
          const nextFirstChord = nextSection.chords[0];
          const nextMoodTokens = nextSection.mood
            ? tokenize(normalizeStyleText(nextSection.mood))
            : [];
          const buildToChorus = nextSection.type === 'chorus';
          const buildToBridge = nextSection.type === 'bridge';
          positiveLocal = [
            ...positiveLocal,
            `leads into ${nextSection.type}`,
            ...(nextFirstChord ? [`resolving to ${nextFirstChord}`] : []),
            ...(nextStyle ? [`transitioning to ${nextStyle}`] : []),
            ...(buildToChorus ? ['building to chorus', 'rising energy', 'anticipation'] : []),
            ...(buildToBridge ? ['contrast approaching', 'surprising turn'] : []),
            ...(nextMoodTokens.length ? [`into ${nextMoodTokens[0]}`] : []),
          ];
        }
      }

      const durationMs = section.durationMs
        ? Math.min(120000, Math.max(3000, section.durationMs))
        : estimateDurationMs(lines, song.tempo);

      return {
        section_name: section.label,
        positive_local_styles: positiveLocal,
        negative_local_styles: negativeLocal,
        duration_ms: durationMs,
        lines,
      };
    });

    return {
      composition_plan: {
        positive_global_styles: positiveGlobal,
        negative_global_styles: negativeGlobal,
        sections,
      },
      with_timestamps: true,
    };
  }

  async generate(song: Song, sectionContext?: SectionRegenerationContext, forceInstrumental = false): Promise<AudioResult> {
    const vocalsOnly = sectionContext?.vocalsOnly ?? false;

    if (vocalsOnly) {
      return this.generateVocals(song, sectionContext);
    }

    return this.callAPI(this.buildCompositionBody(song, forceInstrumental, sectionContext));
  }

  /** Generates a vocals-forward (acapella-style) render for vocal-only section changes. */
  private async generateVocals(song: Song, sectionContext?: SectionRegenerationContext): Promise<AudioResult> {
    const section = song.sections[0];
    const lines = section.lyrics.split('\n').map(l => l.trim()).filter(Boolean);
    const styles = SECTION_STYLES[section.type] ?? SECTION_STYLES.verse;
    const sectionMoodTags = section.mood
      ? tokenize(section.mood.toLowerCase())
      : [];
    const vocalTags = section.vocalists?.length
      ? getVocalStyleTags(section.vocalists)
      : ['vocals'];

    const positiveGlobal = [
      ...tokenize(song.genre.toLowerCase()),
      ...tokenize(song.mood.toLowerCase()),
      `${song.tempo} bpm`,
      song.key,
      'vocals', 'a cappella', 'voice',
      'starts on beat 1', 'downbeat entry', 'on the beat',
      ...vocalTags,
    ];

    const sections = [{
      section_name: section.label,
      positive_local_styles: [
        'starts on beat 1', 'downbeat entry',
        ...styles.positive, ...sectionMoodTags, ...vocalTags, 'lead vocal', 'vocal performance',
      ],
      negative_local_styles: [
        'pickup notes', 'anacrusis', 'before the beat',
        ...styles.negative,
        'drums', 'percussion', 'guitar', 'bass', 'piano', 'keyboard',
        'synth', 'strings', 'brass', 'horns', 'instrumental', 'instruments',
      ],
      duration_ms: section.durationMs
        ? Math.min(120000, Math.max(3000, section.durationMs))
        : estimateDurationMs(lines, song.tempo),
      lines,
    }];

    const result = await this.callAPI({
      composition_plan: {
        positive_global_styles: positiveGlobal,
        negative_global_styles: [
          'noise', 'distortion',
          'pickup notes', 'anacrusis', 'before the beat', 'upbeat start', 'pre-beat',
          'drums', 'percussion', 'guitar', 'bass', 'piano', 'keyboard',
          'synth', 'synthesizer', 'strings', 'orchestra', 'horns', 'brass',
          'full band', 'instrumental',
        ],
        sections,
      },
      with_timestamps: true,
    });

    return result;
  }
}
