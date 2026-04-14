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

function estimateDurationMs(lines: string[]): number {
  return Math.max(15000, lines.length * 3500 + 4000);
}

const STYLE_VOCABULARY = [
  'folk', 'rock', 'pop', 'jazz', 'blues', 'country', 'electronic', 'ambient', 'indie',
  'classical', 'hip-hop', 'r&b', 'soul', 'reggae', 'punk', 'metal', 'acoustic', 'cinematic',
  'reverb', 'echo', 'warm', 'bright', 'dark', 'raw', 'polished', 'lo-fi', 'intimate',
  'sparse', 'lush', 'layered', 'minimal', 'driving', 'groovy', 'fingerpicking', 'strumming',
  'arpeggiated', 'distorted', 'clean', 'melancholic', 'energetic', 'mellow', 'dramatic',
  'uplifting', 'nostalgic', 'upbeat', 'atmospheric', 'confessional', 'anthemic',
  'falsetto', 'harmonies', 'breathy', 'powerful', 'delicate', 'raspy', 'smooth',
  'male vocalist', 'female vocalist', 'male vocal', 'female vocal',
];

function extractStyleTerms(text: string): string[] {
  const lower = text.toLowerCase();
  return STYLE_VOCABULARY.filter(term => lower.includes(term));
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
    const globalInstruments = extractInstruments(song.audioPrompt);
    const styleTerms = extractStyleTerms(song.audioPrompt);

    const positiveGlobal = [
      ...song.genre.toLowerCase().split(/[\s,/]+/).filter(s => s.length > 2),
      ...song.mood.toLowerCase().split(/[\s,/]+/).filter(s => s.length > 2),
      ...styleTerms,
      `${song.tempo} bpm`,
      song.key,
      ...globalInstruments,
    ];

    const negativeGlobal = [
      'noise', 'distortion',
      ...(forceInstrumental ? ['vocals', 'singing', 'voice', 'lyrics', 'acapella'] : ['acapella', 'vocals only']),
    ];

    const sections = song.sections.map(section => {
      // For instrumental-only, treat every section as having no lyrics
      const lines = forceInstrumental
        ? []
        : section.lyrics.split('\n').map(l => l.trim()).filter(Boolean);
      const styles = SECTION_STYLES[section.type] ?? SECTION_STYLES.verse;
      const sectionMoodTags = section.mood
        ? section.mood.toLowerCase().split(/[\s,/]+/).filter(s => s.length > 2)
        : [];
      const chordTags = section.chords.length > 0
        ? [`${section.chords.join(' ')} chord progression`, ...section.chords]
        : [];
      const sectionInstruments = section.instruments?.length ? section.instruments : globalInstruments;
      const vocalTags = section.vocalists?.length ? getVocalStyleTags(section.vocalists) : [];
      const isInstrumental = lines.length === 0;

      let positiveLocal = [
        ...styles.positive,
        ...sectionMoodTags,
        ...chordTags,
        ...sectionInstruments,
        ...(!isInstrumental ? vocalTags : []),
      ];
      let negativeLocal = [
        ...styles.negative,
        ...(isInstrumental ? ['vocals', 'singing', 'lyrics'] : []),
      ];

      if (sectionContext) {
        const { changedFields } = sectionContext;
        const onlyInstrumentsChanged =
          changedFields.length > 0 && changedFields.every(f => f === 'instruments');
        if (onlyInstrumentsChanged) {
          positiveLocal = [
            ...positiveLocal,
            'same vocal melody', 'same vocal performance', 'same phrasing',
            `${song.tempo} bpm`, song.key,
          ];
          negativeLocal = [...negativeLocal, 'different melody', 'different tempo', 'different key'];
        } else if (!changedFields.includes('lyrics')) {
          positiveLocal = [...positiveLocal, 'same vocal style', `${song.tempo} bpm`, song.key];
          negativeLocal = [...negativeLocal, 'different tempo', 'different key'];
        }
      }

      const durationMs = section.durationMs
        ? Math.min(120000, Math.max(3000, section.durationMs))
        : estimateDurationMs(lines);

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
      ? section.mood.toLowerCase().split(/[\s,/]+/).filter(s => s.length > 2)
      : [];
    const vocalTags = section.vocalists?.length
      ? getVocalStyleTags(section.vocalists)
      : ['vocals'];

    const positiveGlobal = [
      ...song.genre.toLowerCase().split(/[\s,/]+/).filter(s => s.length > 2),
      ...song.mood.toLowerCase().split(/[\s,/]+/).filter(s => s.length > 2),
      `${song.tempo} bpm`,
      song.key,
      'vocals', 'a cappella', 'voice',
      ...vocalTags,
    ];

    const sections = [{
      section_name: section.label,
      positive_local_styles: [...styles.positive, ...sectionMoodTags, ...vocalTags, 'lead vocal', 'vocal performance'],
      negative_local_styles: [
        ...styles.negative,
        'drums', 'percussion', 'guitar', 'bass', 'piano', 'keyboard',
        'synth', 'strings', 'brass', 'horns', 'instrumental', 'instruments',
      ],
      duration_ms: estimateDurationMs(lines),
      lines,
    }];

    const result = await this.callAPI({
      composition_plan: {
        positive_global_styles: positiveGlobal,
        negative_global_styles: [
          'noise', 'distortion',
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
