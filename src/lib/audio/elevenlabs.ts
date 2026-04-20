import type { AudioProvider, AudioResult, SectionRegenerationContext } from './types';
import type { Song, SectionType, WordTimestamp } from '../types';
import { getVocalStyleTags } from '../vocalists';
import {
  SECTION_STYLES,
  tokenize, normalizeStyleText, extractStyleTerms, excludedGenres,
  extractInstruments, instrumentExclusions,
} from './sectionStyles';


interface MultipartResult {
  wordTimestamps: WordTimestamp[];
  audioBuffer: Buffer;
  songId?: string;
}

function parseMultipart(buf: Buffer, boundary: string): MultipartResult {
  const jsonStart = buf.indexOf('{');
  const boundaryBuf = Buffer.from(`\r\n--${boundary}`);
  const boundaryPos = buf.indexOf(boundaryBuf, jsonStart);
  const json = JSON.parse(buf.slice(jsonStart, boundaryPos > -1 ? boundaryPos : buf.length).toString('utf8'));
  const wordTimestamps: WordTimestamp[] = json.words_timestamps ?? [];
  const songId: string | undefined = json.song_id;

  const id3Pos = buf.indexOf(Buffer.from('ID3'));
  if (id3Pos === -1) throw new Error('No audio found in multipart response');

  const trailingBoundary = buf.indexOf(Buffer.from(`\r\n--${boundary}--`), id3Pos);
  const audioBuffer = buf.slice(id3Pos, trailingBoundary > -1 ? trailingBoundary : undefined);

  return { wordTimestamps, audioBuffer, songId };
}

export class ElevenLabsProvider implements AudioProvider {
  private apiKey: string;

  constructor() {
    this.apiKey = process.env.ELEVENLABS_API_KEY ?? '';
  }

  /** Makes one API call and returns the audio URL + timestamps. */
  private async callAPI(body: object): Promise<{ audioUrl: string; wordTimestamps: WordTimestamp[]; songId?: string }> {
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
    const { wordTimestamps, audioBuffer, songId } = parseMultipart(buf, boundaryMatch[1]);
    return {
      audioUrl: `data:audio/mpeg;base64,${audioBuffer.toString('base64')}`,
      wordTimestamps,
      songId,
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

    let positiveGlobal = [
      normGenre,                                                             // full phrase — highest priority
      ...tokenize(normGenre),              // individual tokens
      ...tokenize(normMood),
      ...styleTerms,
      `${song.tempo} bpm`,
      song.key,
      'starts on beat 1', 'downbeat entry', 'on the beat',
    ];

    // Apply user overrides to global positive tags
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
      ...(forceInstrumental ? ['vocals', 'singing', 'voice', 'lyrics', 'acapella'] : ['acapella', 'vocals only']),
      ...excludedGenres(normGenre),   // every other genre — lowest priority, trimmed to fit
    ].slice(0, 50);

    // Apply user overrides to global negative tags
    if (song.negativeGlobalRemove?.length || song.negativeGlobalAdd?.length) {
      const removedSet = new Set(song.negativeGlobalRemove ?? []);
      negativeGlobal = [
        ...negativeGlobal.filter(t => !removedSet.has(t)),
        ...(song.negativeGlobalAdd ?? []),
      ];
    }

    // Global genre tokens — used to suppress conflicting global style in per-section negatives
    const globalGenreTokens = tokenize(normGenre);

    const sections = song.sections.map((section, sectionIndex) => {
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

      // Priority order: genre first (strongest identity signal), then chords, beat-alignment, vocals, mood, section type, instruments
      let positiveLocal = [
        ...sectionStyleTags,      // section genre — first and highest priority
        'starts on beat 1', 'downbeat entry',  // beat-alignment — must precede lyrics
        ...chordTags,             // chord progression
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

        // ── Prev-section context only — earlier sections are not influenced by later ones ──
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
      }

      // If this section is followed by another, suppress ElevenLabs' natural outro fade.
      // For full-song generation use the array index; for regeneration use sectionContext.nextSection.
      const hasNextSection = sectionContext
        ? !!sectionContext.nextSection
        : sectionIndex < song.sections.length - 1;
      if (hasNextSection) {
        if (sectionContext) {
          // Section regen: we generate a natural 4-beat tail for crossfading — don't signal
          // an ending at all. Omit 'abrupt ending', 'outro', 'ending' entirely so ElevenLabs
          // keeps the music flowing into the tail naturally.
          positiveLocal = ['no fadeout', 'continues', ...positiveLocal];
          negativeLocal = ['fadeout', 'fade out', 'fade', 'ending', ...negativeLocal].slice(0, 50);
        } else {
          // Full-song generation: abrupt so ElevenLabs doesn't add a fade before the next section.
          positiveLocal = ['no fadeout', 'abrupt ending', 'continues', ...positiveLocal];
          negativeLocal = ['fadeout', 'fade out', 'fade', 'outro', 'ending', ...negativeLocal].slice(0, 50);
        }
      }

      positiveLocal = positiveLocal.slice(0, 50);

      // Apply user overrides: remove explicitly removed tags, append custom additions.
      if (section.positiveStylesRemove?.length || section.positiveStylesAdd?.length) {
        const removedSet = new Set(section.positiveStylesRemove ?? []);
        positiveLocal = [
          ...positiveLocal.filter(t => !removedSet.has(t)),
          ...(section.positiveStylesAdd ?? []),
        ].slice(0, 50);
      }

      // Bars are authoritative — lyrics never affect section length.
      // Fall back to 4 bars if durationMs is somehow unset.
      // For section regen with a following section, generate 4 extra beats so the client
      // can crossfade 1 beat into the next section and discard the remaining tail.
      const TAIL_EXTRA_BEATS = 4;
      const beatMs = Math.round(60000 / song.tempo);
      const baseDurationMs = section.durationMs
        ? Math.min(120000, Math.max(3000, section.durationMs))
        : Math.min(120000, Math.round(4 * 240000 / song.tempo));
      const durationMs = (sectionContext && hasNextSection)
        ? Math.min(120000, baseDurationMs + TAIL_EXTRA_BEATS * beatMs)
        : baseDurationMs;

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
    if (vocalsOnly) return this.generateVocals(song, sectionContext);
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
        : Math.min(120000, Math.round(4 * 240000 / song.tempo)),
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
