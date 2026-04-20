'use client';

import { useState } from 'react';
import type { SongSection, SectionTake } from '@/lib/types';
import { VOCALISTS } from '@/lib/vocalists';
import type { SectionCompositionPlan } from '@/lib/audio/sectionStyles';

// ── Chord builder data ────────────────────────────────────────────────────────

const CHORD_NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const CHORD_QUALITIES = [
  { id: 'maj',  label: 'maj'  },
  { id: 'min',  label: 'min'  },
  { id: 'dim',  label: 'dim'  },
  { id: 'aug',  label: 'aug'  },
  { id: 'sus2', label: 'sus2' },
  { id: 'sus4', label: 'sus4' },
];

const CHORD_EXTENSIONS = [
  { id: '',      label: '—'    },
  { id: '7',     label: '7'    },
  { id: 'maj7',  label: 'maj7' },
  { id: '9',     label: '9'    },
  { id: 'maj9',  label: 'maj9' },
  { id: '11',    label: '11'   },
  { id: '13',    label: '13'   },
  { id: 'add9',  label: 'add9' },
  { id: '6',     label: '6'    },
  { id: 'b5',    label: 'b5'   },
  { id: '#5',    label: '#5'   },
];

function buildChordName(note: string, quality: string, extension: string): string {
  let name = note;
  if (quality === 'min')  name += 'm';
  else if (quality === 'dim')  name += 'dim';
  else if (quality === 'aug')  name += 'aug';
  else if (quality === 'sus2') name += 'sus2';
  else if (quality === 'sus4') name += 'sus4';
  name += extension;
  return name;
}

const INSTRUMENT_GROUPS: { label: string; items: string[] }[] = [
  { label: 'Rhythm',      items: ['drums', 'bass', 'bass guitar', 'percussion', '808', 'kick', 'snare', 'hi-hat'] },
  { label: 'Guitar',      items: ['acoustic guitar', 'electric guitar', 'guitar', 'banjo', 'mandolin', 'ukulele'] },
  { label: 'Keys',        items: ['piano', 'keyboard', 'organ', 'hammond', 'synth'] },
  { label: 'Strings',     items: ['violin', 'viola', 'cello', 'strings', 'harp'] },
  { label: 'Brass & Wind', items: ['trumpet', 'saxophone', 'flute', 'clarinet', 'trombone', 'horns', 'brass'] },
  { label: 'Texture',     items: ['pads', 'choir', 'orchestra', 'vocals'] },
];

// ── Instrument icons ─────────────────────────────────────────────────────────
// Keyword-matched so custom instruments ("electric bass", "acoustic piano", …) also resolve.

function resolveIconType(name: string): string {
  const n = name.toLowerCase();
  if (n === 'hi-hat' || n === 'hihat')                                             return 'hihat';
  if (n === 'snare')                                                                return 'snare';
  if (n === '808')                                                                  return '808';
  if (n.includes('drum') || n === 'kick' || n.includes('percuss') ||
      n.includes('conga') || n.includes('bongo'))                                  return 'drums';
  if (n.includes('bass'))                                                           return 'bass';
  if (n === 'electric guitar')                                                      return 'electric-guitar';
  if (n === 'banjo')                                                                return 'banjo';
  if (n.includes('guitar') || n.includes('mandolin') || n.includes('ukulele'))     return 'guitar';
  if (n === 'piano' || n.includes('keyboard') || n === 'keys')                     return 'piano';
  if (n.includes('organ') || n.includes('hammond'))                                return 'organ';
  if (n.includes('synth') || n.includes('moog'))                                   return 'synth';
  if (n.includes('violin') || n.includes('viola') || n.includes('cello') ||
      n.includes('fiddle') || n === 'strings')                                      return 'strings';
  if (n.includes('harp'))                                                           return 'harp';
  if (n.includes('trumpet') || n.includes('horn') || n.includes('brass') ||
      n.includes('trombone') || n.includes('tuba') || n.includes('flugelhorn'))    return 'trumpet';
  if (n.includes('sax'))                                                            return 'saxophone';
  if (n.includes('flute') || n.includes('clarinet') || n.includes('oboe') ||
      n.includes('bassoon') || n.includes('woodwind'))                             return 'flute';
  if (n.includes('pad'))                                                            return 'pads';
  if (n.includes('choir') || n.includes('vocal') || n.includes('voice'))          return 'vocals';
  if (n.includes('orchestra'))                                                      return 'orchestra';
  return 'note';
}

function InstrumentIcon({ name }: { name: string }) {
  const type = resolveIconType(name);
  const p = {
    width: 11, height: 11, viewBox: '0 0 12 12',
    fill: 'none', stroke: 'currentColor',
    strokeWidth: '1.2', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
    className: 'inline-block shrink-0',
    'aria-hidden': true,
  };

  switch (type) {
    case 'hihat': return (
      <svg {...p}>
        <ellipse cx="6" cy="3.5" rx="4.5" ry="1.8"/>
        <ellipse cx="6" cy="5.5" rx="4.5" ry="1.8"/>
        <line x1="6" y1="7.3" x2="6" y2="11"/>
      </svg>
    );
    case 'snare': return (
      <svg {...p}>
        <ellipse cx="6" cy="4" rx="4.5" ry="2"/>
        <line x1="1.5" y1="4" x2="1.5" y2="8.5"/>
        <line x1="10.5" y1="4" x2="10.5" y2="8.5"/>
        <ellipse cx="6" cy="8.5" rx="4.5" ry="2"/>
        <path d="M2 10.2 Q6 11 10 10.2" strokeWidth="0.9"/>
      </svg>
    );
    case '808': return (
      <svg {...p}>
        <rect x="0.5" y="2" width="11" height="8" rx="1.5"/>
        <circle cx="4" cy="5.5" r="1.5"/>
        <circle cx="8" cy="5.5" r="1.5"/>
        <line x1="2" y1="8.5" x2="10" y2="8.5" strokeWidth="0.9"/>
      </svg>
    );
    case 'drums': return (
      <svg {...p}>
        <ellipse cx="6" cy="4" rx="4.5" ry="2"/>
        <line x1="1.5" y1="4" x2="1.5" y2="9"/>
        <line x1="10.5" y1="4" x2="10.5" y2="9"/>
        <ellipse cx="6" cy="9" rx="4.5" ry="2"/>
      </svg>
    );
    case 'bass': return (
      <svg {...p}>
        <line x1="4" y1="1" x2="8" y2="1"/>
        <path d="M6 1 L6 5.5 Q4 6.5 4 8.5 Q4 11 6 11 Q8 11 8 8.5 Q8 6.5 6 5.5"/>
        <circle cx="6" cy="8.5" r="2"/>
      </svg>
    );
    case 'electric-guitar': return (
      <svg {...p}>
        <path d="M4.5 1 L7.5 1 L7.5 5.5 Q9.5 7 10.5 9.5 Q11 11 9.5 11 Q8 11 8 9.5 Q7 8 5.5 7.5 L4.5 7.5 Z"/>
        <circle cx="9.5" cy="9.5" r="1" fill="currentColor" opacity="0.35" stroke="none"/>
      </svg>
    );
    case 'banjo': return (
      <svg {...p}>
        <circle cx="6" cy="8.5" r="3.5"/>
        <line x1="6" y1="5" x2="6" y2="1"/>
        <line x1="4.5" y1="1" x2="7.5" y2="1"/>
        <circle cx="6" cy="8.5" r="1.5" strokeWidth="0.8"/>
      </svg>
    );
    case 'guitar': return (
      <svg {...p}>
        <line x1="6" y1="1" x2="6" y2="3"/>
        <circle cx="6" cy="5.2" r="2.5"/>
        <circle cx="6" cy="8.8" r="2.5"/>
        <circle cx="6" cy="7" r="0.9" fill="currentColor" opacity="0.25" stroke="none"/>
      </svg>
    );
    case 'piano': return (
      <svg {...p}>
        <rect x="0.5" y="2" width="11" height="9" rx="1"/>
        <line x1="4" y1="2" x2="4" y2="11"/>
        <line x1="7.5" y1="2" x2="7.5" y2="11"/>
        <rect x="2" y="2" width="2.5" height="5.5" rx="0.5" fill="currentColor" opacity="0.5" stroke="none"/>
        <rect x="5.5" y="2" width="2.5" height="5.5" rx="0.5" fill="currentColor" opacity="0.5" stroke="none"/>
        <rect x="9" y="2" width="2" height="5.5" rx="0.5" fill="currentColor" opacity="0.5" stroke="none"/>
      </svg>
    );
    case 'organ': return (
      <svg {...p}>
        <rect x="0.5" y="1" width="3" height="7.5" rx="1.5"/>
        <rect x="4.5" y="2" width="3" height="6.5" rx="1.5"/>
        <rect x="8.5" y="3" width="3" height="5.5" rx="1.5"/>
        <line x1="0.5" y1="10.5" x2="11.5" y2="10.5"/>
      </svg>
    );
    case 'synth': return (
      <svg {...p}>
        <path d="M1 7.5 Q2 5.5 3 7.5 Q4 9.5 5 7.5 Q6 5.5 7 7.5 Q8 9.5 9 7.5 Q10 5.5 11 7.5"/>
        <circle cx="2.5" cy="3.5" r="1.2"/>
        <circle cx="6" cy="3.5" r="1.2"/>
        <circle cx="9.5" cy="3.5" r="1.2"/>
      </svg>
    );
    case 'strings': return (
      <svg {...p}>
        <line x1="6" y1="1" x2="6" y2="3"/>
        <path d="M4 4 Q3 4 3 5.5 Q3 7 4.5 7 Q5.5 7 5.5 6.5 Q5.5 7.5 4.5 7.8 Q3 8 3 9.5 Q3 11 4.5 11 Q6 11 6 9.5 Q6 11 7.5 11 Q9 11 9 9.5 Q9 8 7.5 7.8 Q6.5 7.5 6.5 6.5 Q6.5 7 7.5 7 Q9 7 9 5.5 Q9 4 8 4 Q7 4 6 5 Q5 4 4 4 Z"/>
      </svg>
    );
    case 'harp': return (
      <svg {...p}>
        <path d="M3 11 L3 2.5 Q4 1 6 1 Q9.5 1.5 10.5 5.5"/>
        <line x1="3" y1="11" x2="10.5" y2="11"/>
        <line x1="4" y1="4" x2="4" y2="11" strokeWidth="0.8"/>
        <line x1="5.5" y1="2.5" x2="5.5" y2="11" strokeWidth="0.8"/>
        <line x1="7" y1="2" x2="7" y2="11" strokeWidth="0.8"/>
        <line x1="8.5" y1="2.5" x2="8.5" y2="11" strokeWidth="0.8"/>
        <line x1="10" y1="4.5" x2="10" y2="11" strokeWidth="0.8"/>
      </svg>
    );
    case 'trumpet': return (
      <svg {...p}>
        <line x1="1" y1="6" x2="3.5" y2="6"/>
        <circle cx="4.5" cy="5.5" r="0.8" fill="currentColor" opacity="0.3" stroke="none"/>
        <circle cx="6" cy="5.5" r="0.8" fill="currentColor" opacity="0.3" stroke="none"/>
        <circle cx="7.5" cy="5.5" r="0.8" fill="currentColor" opacity="0.3" stroke="none"/>
        <path d="M3.5 6 L7.5 6 Q9 6 10 5 Q11 4 11.5 6 Q11.8 8.5 9.5 9 Q7.5 9.5 7.5 7.5"/>
      </svg>
    );
    case 'saxophone': return (
      <svg {...p}>
        <path d="M7.5 1 Q9.5 1 9.5 4 Q9.5 7.5 7 9.5 Q5 11.5 5 9.5 Q5 8.5 6.5 8.5 Q8.5 8.5 8.5 5.5 Q8.5 2.5 7.5 1"/>
        <line x1="9.5" y1="1" x2="10.5" y2="1.5"/>
        <circle cx="7.5" cy="4" r="0.6" fill="currentColor" stroke="none"/>
        <circle cx="7" cy="6" r="0.6" fill="currentColor" stroke="none"/>
      </svg>
    );
    case 'flute': return (
      <svg {...p}>
        <line x1="0.5" y1="6" x2="11.5" y2="6" strokeWidth="2.5"/>
        <circle cx="3" cy="6" r="1.3" fill="white" stroke="currentColor" strokeWidth="1.2"/>
        <circle cx="5.5" cy="6" r="0.7" fill="currentColor" stroke="none"/>
        <circle cx="7.5" cy="6" r="0.7" fill="currentColor" stroke="none"/>
        <circle cx="9.5" cy="6" r="0.7" fill="currentColor" stroke="none"/>
      </svg>
    );
    case 'pads': return (
      <svg {...p}>
        <path d="M1 4.5 Q2.5 2.5 4 4.5 Q5.5 6.5 7 4.5 Q8.5 2.5 10 4.5 Q11 6 11 5.5" strokeWidth="1.3"/>
        <path d="M1 8.5 Q2.5 6.5 4 8.5 Q5.5 10.5 7 8.5 Q8.5 6.5 10 8.5 Q11 10 11 9.5" strokeWidth="1.3"/>
      </svg>
    );
    case 'vocals':
    case 'orchestra': return (
      <svg {...p}>
        <path d="M6 1 Q4 1 4 4 Q4 7 6 7 Q8 7 8 4 Q8 1 6 1 Z"/>
        <path d="M3 5.5 Q3 9 6 9 Q9 9 9 5.5"/>
        <line x1="6" y1="9" x2="6" y2="11"/>
        <line x1="4.5" y1="11" x2="7.5" y2="11"/>
      </svg>
    );
    default: return (
      <svg {...p}>
        <path d="M4.5 9.5 L4.5 4 L9.5 2.5 L9.5 7"/>
        <circle cx="3.5" cy="10" r="1.5"/>
        <circle cx="8.5" cy="8" r="1.5"/>
      </svg>
    );
  }
}

interface Props {
  section: SongSection;
  index: number;
  tempo: number;
  onChange: (index: number, updated: SongSection) => void;
  onRegenerate?: () => void;
  regenerating?: boolean;
  isNewSection?: boolean;
  onInsertAfter?: () => void;
  onDelete?: () => void;
  sectionTakes?: SectionTake[];
  onRestoreTake?: (take: SectionTake) => void;
  isPlaying?: boolean;
  onPlay?: () => void;
  compositionPlan?: SectionCompositionPlan;
  onGenerateChords?: (directive?: string) => Promise<void>;
}

function VocalistAvatar({ name, color, colorLight }: { name: string; color: string; colorLight: string }) {
  const id = `grad-${name}`;
  return (
    <svg viewBox="0 0 44 44" className="w-full h-full" aria-hidden>
      <defs>
        <radialGradient id={id} cx="38%" cy="32%" r="65%">
          <stop offset="0%" stopColor={colorLight} />
          <stop offset="100%" stopColor={color} />
        </radialGradient>
      </defs>
      <circle cx="22" cy="22" r="22" fill={`url(#${id})`} />
      <ellipse cx="22" cy="18" rx="8" ry="9" fill="rgba(255,255,255,0.22)" />
      <ellipse cx="22" cy="38" rx="13" ry="8" fill="rgba(255,255,255,0.15)" />
      <text x="22" y="22" textAnchor="middle" dominantBaseline="middle" fill="white"
        fontSize="11" fontWeight="700" fontFamily="ui-sans-serif,system-ui,sans-serif"
        style={{ letterSpacing: '0.02em' }}>
        {name[0]}
      </text>
    </svg>
  );
}


function barsToMs(bars: number, tempo: number): number {
  return Math.round(bars * 240000 / tempo);
}
function msToBars(ms: number, tempo: number): number {
  return Math.round(ms * tempo / 240000);
}

export default function SectionEditor({ section, index, tempo, onChange, onRegenerate, regenerating, isNewSection, onInsertAfter, onDelete, sectionTakes, onRestoreTake, isPlaying, onPlay, compositionPlan, onGenerateChords }: Props) {
  const [chordsOpen, setChordsOpen] = useState(false);
  const [vocalistOpen, setVocalistOpen] = useState(false);
  const [instrumentsOpen, setInstrumentsOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [chordsGenerating, setChordsGenerating] = useState(false);
  const [chordsError, setChordsError] = useState('');
  const [builderNote, setBuilderNote] = useState<string | null>(null);
  const [builderQuality, setBuilderQuality] = useState('maj');
  const [builderExtension, setBuilderExtension] = useState('');
  const [styleTagInput, setStyleTagInput] = useState('');

  const triggerGenerateChords = async (directive?: string) => {
    if (!onGenerateChords) return;
    setChordsGenerating(true);
    setChordsError('');
    try {
      await onGenerateChords(directive);
    } catch {
      setChordsError('Failed to generate chords');
    } finally {
      setChordsGenerating(false);
    }
  };

  const addChord = (chord: string) => {
    const trimmed = chord.trim();
    if (trimmed) update({ chords: [...section.chords, trimmed] });
  };

  const removeChord = (i: number) => {
    update({ chords: section.chords.filter((_, idx) => idx !== i) });
  };
  const update = (patch: Partial<SongSection>) => onChange(index, { ...section, ...patch });

  const instruments = section.instruments ?? [];
  const selectedVocalists = section.vocalists ?? [];

  const toggleVocalist = (id: string) => {
    const next = selectedVocalists.includes(id)
      ? selectedVocalists.filter(v => v !== id)
      : [...selectedVocalists, id];
    update({ vocalists: next });
  };

  const addInstrument = (value: string) => {
    const trimmed = value.trim();
    if (trimmed && !instruments.includes(trimmed)) {
      update({ instruments: [...instruments, trimmed] });
    }
  };

  const removeInstrument = (i: number) => {
    update({ instruments: instruments.filter((_, idx) => idx !== i) });
  };

  const handleInstrumentKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addInstrument(e.currentTarget.value);
      e.currentTarget.value = '';
    }
  };

  const handleInstrumentBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    if (e.currentTarget.value.trim()) {
      addInstrument(e.currentTarget.value);
      e.currentTarget.value = '';
    }
  };

  return (
    <div className={`rounded-lg border bg-white p-4 flex flex-col gap-3 transition-all duration-300 ${
      isPlaying
        ? 'border-[#f37321] shadow-[0_0_0_2px_rgba(243,115,33,0.18),0_2px_12px_rgba(243,115,33,0.12)]'
        : 'border-[#e9e9e9] shadow-[0_2px_8px_rgba(0,0,0,0.06)]'
    }`}>
      {/* Header */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <input
            type="text"
            value={section.label}
            onChange={e => update({ label: e.target.value })}
            className="text-sm font-bold text-[#f37321] uppercase tracking-wide bg-transparent border-none outline-none focus:underline focus:decoration-[#f37321] underline-offset-2 min-w-0 flex-1"
          />
          {isPlaying && (
            <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-[#f37321] text-white text-[9px] font-bold uppercase tracking-wider flex-shrink-0">
              <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
              Playing
            </span>
          )}
          {onDelete && (
            <button
              type="button"
              onClick={onDelete}
              title="Delete section"
              className="w-5 h-5 flex items-center justify-center rounded flex-shrink-0 text-[#bdbdbd] hover:text-red-500 hover:bg-red-50 transition-colors"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
          {onPlay && (
            <button
              type="button"
              onClick={onPlay}
              title="Play from this section"
              className={`w-6 h-6 flex items-center justify-center rounded-full flex-shrink-0 transition-colors ${
                isPlaying
                  ? 'bg-[#f37321] text-white'
                  : 'bg-[#e9e9e9] hover:bg-[#f37321] text-[#676767] hover:text-white'
              }`}
            >
              {isPlaying ? (
                <svg className="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 24 24">
                  <rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" />
                </svg>
              ) : (
                <svg className="w-2.5 h-2.5 ml-px" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              )}
            </button>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <div className="flex items-center gap-1 flex-shrink-0">
            <input
              type="number"
              min={1}
              step={1}
              value={section.durationMs != null ? msToBars(section.durationMs, tempo) : ''}
              onChange={e => {
                const raw = e.target.value;
                if (raw === '') {
                  update({ durationMs: undefined });
                } else {
                  const bars = Math.max(1, parseInt(raw, 10));
                  if (!isNaN(bars)) update({ durationMs: barsToMs(bars, tempo) });
                }
              }}
              placeholder="4"
              title="Number of bars for this section"
              className="w-12 rounded bg-[#f6f6f6] border border-[#e9e9e9] text-[#676767] placeholder-[#bdbdbd] px-2 py-0.5 text-xs text-right focus:outline-none focus:ring-1 focus:ring-[#f37321] focus:border-[#f37321]"
            />
            <span className="text-[10px] text-[#929292] flex-shrink-0">bars</span>
          </div>
          <div className="flex-1" />
          {onRegenerate && (
            regenerating ? (
              <span className="flex items-center gap-1 text-[10px] text-[#929292]">
                <span className="inline-block w-3 h-3 rounded-full border-2 border-[#bdbdbd] border-t-[#f37321] animate-spin" />
                {isNewSection ? 'Generating…' : 'Regenerating…'}
              </span>
            ) : isNewSection ? (
              <button
                type="button"
                onClick={() => onRegenerate()}
                title="Generate this section"
                className="flex items-center gap-1 px-2 py-0.5 rounded border border-[#f37321] bg-[#fff3eb] hover:bg-[#ffe5d0] text-[#f37321] text-[10px] font-semibold transition-colors flex-shrink-0"
              >
                <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
                </svg>
                Generate
              </button>
            ) : (
              <button
                type="button"
                onClick={() => onRegenerate()}
                title="Regenerate section"
                className="w-6 h-6 flex items-center justify-center rounded border border-[#e9e9e9] bg-[#f6f6f6] hover:bg-[#e9e9e9] text-[#464646] transition-colors"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              </button>
            )
          )}
          {sectionTakes && sectionTakes.length > 0 && onRestoreTake && (
            <select
              value=""
              onChange={e => {
                const take = sectionTakes.find(t => t.id === e.target.value);
                if (take) onRestoreTake(take);
                e.currentTarget.value = '';
              }}
              className="w-16 py-1 rounded text-xs bg-[#f6f6f6] border border-[#bdbdbd] text-[#464646] cursor-pointer focus:outline-none focus:ring-1 focus:ring-[#f37321]"
              title="Restore a previous take"
            >
              <option value="" disabled>Takes</option>
              {sectionTakes.map(t => (
                <option key={t.id} value={t.id}>{t.label}</option>
              ))}
            </select>
          )}
        </div>
      </div>

      {/* Mood + Style row */}
      <div className="flex gap-2">
        <div className="flex-1">
          <label className="block text-xs text-[#929292] mb-1">Mood</label>
          <input
            type="text"
            value={section.mood ?? ''}
            onChange={e => update({ mood: e.target.value })}
            placeholder="e.g. tender and introspective"
            className="w-full rounded bg-[#f6f6f6] border border-[#e9e9e9] text-[#3b3b3b] placeholder-[#929292] px-3 py-1.5 text-sm italic focus:outline-none focus:ring-1 focus:ring-[#f37321]"
          />
        </div>
        <div className="w-28 flex-shrink-0">
          <label className="block text-xs text-[#929292] mb-1">Genre</label>
          <input
            type="text"
            value={section.style ?? ''}
            onChange={e => update({ style: e.target.value.toLowerCase() || undefined })}
            placeholder="e.g. punk rock"
            className="w-full rounded bg-[#f6f6f6] border border-[#e9e9e9] text-[#3b3b3b] placeholder-[#929292] px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-[#f37321]"
          />
        </div>
      </div>

      {/* Chords */}
      <div>
        <button
          type="button"
          onClick={() => setChordsOpen(o => !o)}
          className="flex items-center gap-1.5 text-xs text-[#676767] hover:text-[#3b3b3b] transition-colors"
        >
          <span className={`inline-flex items-center justify-center w-4 h-4 rounded border border-[#bdbdbd] text-[#676767] transition-transform ${chordsOpen ? 'rotate-45' : ''}`}>
            +
          </span>
          Chords
          {!chordsOpen && section.chords.length > 0 && (
            <span className="text-[#929292] font-mono ml-1">{section.chords.join(' – ')}</span>
          )}
        </button>
        {chordsOpen && (
          <div className="mt-2 flex flex-col gap-3">
            {/* Current progression */}
            {section.chords.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                {section.chords.map((chord, i) => (
                  <span key={i} className="group flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#f37321] text-white text-xs font-mono font-semibold shadow-sm">
                    {chord}
                    <button
                      type="button"
                      onClick={() => removeChord(i)}
                      className="opacity-50 hover:opacity-100 transition-opacity leading-none text-[10px]"
                      aria-label={`Remove ${chord}`}
                    >×</button>
                  </span>
                ))}
              </div>
            )}

            {/* Chord builder */}
            <div className="flex flex-col gap-2 p-2.5 rounded-lg bg-[#f9f9f9] border border-[#e9e9e9]">
              {/* Root note */}
              <div>
                <p className="text-[9px] font-semibold text-[#929292] uppercase tracking-wider mb-1">Root</p>
                <div className="flex flex-wrap gap-1">
                  {CHORD_NOTES.map(note => (
                    <button
                      key={note}
                      type="button"
                      onClick={() => setBuilderNote(n => n === note ? null : note)}
                      className={`px-2 py-0.5 rounded text-[11px] font-mono font-semibold transition-colors ${
                        builderNote === note
                          ? 'bg-[#f37321] border border-[#f37321] text-white'
                          : 'bg-white border border-[#e9e9e9] text-[#464646] hover:border-[#f37321] hover:text-[#f37321]'
                      }`}
                    >
                      {note}
                    </button>
                  ))}
                </div>
              </div>

              {/* Quality */}
              <div>
                <p className="text-[9px] font-semibold text-[#929292] uppercase tracking-wider mb-1">Quality</p>
                <div className="flex flex-wrap gap-1">
                  {CHORD_QUALITIES.map(q => (
                    <button
                      key={q.id}
                      type="button"
                      onClick={() => setBuilderQuality(q.id)}
                      className={`px-2 py-0.5 rounded text-[11px] font-mono transition-colors ${
                        builderQuality === q.id
                          ? 'bg-[#f37321] border border-[#f37321] text-white'
                          : 'bg-white border border-[#e9e9e9] text-[#464646] hover:border-[#f37321] hover:text-[#f37321]'
                      }`}
                    >
                      {q.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Extension */}
              <div>
                <p className="text-[9px] font-semibold text-[#929292] uppercase tracking-wider mb-1">Extension</p>
                <div className="flex flex-wrap gap-1">
                  {CHORD_EXTENSIONS.map(ext => (
                    <button
                      key={ext.id || '__none'}
                      type="button"
                      onClick={() => setBuilderExtension(ext.id)}
                      className={`px-2 py-0.5 rounded text-[11px] font-mono transition-colors ${
                        builderExtension === ext.id
                          ? 'bg-[#f37321] border border-[#f37321] text-white'
                          : 'bg-white border border-[#e9e9e9] text-[#464646] hover:border-[#f37321] hover:text-[#f37321]'
                      }`}
                    >
                      {ext.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Preview + Add */}
              <div className="flex items-center gap-2 pt-0.5">
                <span className={`text-sm font-mono font-bold min-w-[48px] ${builderNote ? 'text-[#f37321]' : 'text-[#bdbdbd]'}`}>
                  {builderNote ? buildChordName(builderNote, builderQuality, builderExtension) : '—'}
                </span>
                <button
                  type="button"
                  disabled={!builderNote}
                  onClick={() => {
                    if (!builderNote) return;
                    addChord(buildChordName(builderNote, builderQuality, builderExtension));
                    setBuilderNote(null);
                    setBuilderExtension('');
                  }}
                  className="px-3 py-1 rounded bg-[#f37321] hover:bg-[#da6520] disabled:opacity-30 disabled:cursor-not-allowed text-white text-xs font-semibold transition-colors"
                >
                  Add chord
                </button>
              </div>
            </div>

            {/* Generate */}
            <div className="flex flex-col gap-1.5">
              <button
                type="button"
                disabled={chordsGenerating || !onGenerateChords}
                onClick={() => void triggerGenerateChords()}
                className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded border border-[#f37321] bg-[#fff3eb] hover:bg-[#ffe5d0] text-[#f37321] text-xs font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {chordsGenerating ? (
                  <><span className="inline-block w-3 h-3 rounded-full border-2 border-[#f37321]/40 border-t-[#f37321] animate-spin" />Generating…</>
                ) : (
                  <><svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>Generate progression</>
                )}
              </button>

              {/* Transform row */}
              {section.chords.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {(['darker', 'lighter', 'funkier', 'chiller', 'more intense'] as const).map(d => (
                    <button
                      key={d}
                      type="button"
                      disabled={chordsGenerating || !onGenerateChords}
                      onClick={() => void triggerGenerateChords(d)}
                      className="px-2 py-0.5 rounded border border-[#e9e9e9] bg-[#f6f6f6] hover:bg-[#e9e9e9] hover:border-[#bdbdbd] text-[#464646] text-[11px] transition-colors disabled:opacity-40 disabled:cursor-not-allowed capitalize"
                    >
                      {d}
                    </button>
                  ))}
                </div>
              )}
              {chordsError && <p className="text-[10px] text-red-500">{chordsError}</p>}
            </div>
          </div>
        )}
      </div>

      {/* Vocalist — collapsible */}
      <div>
        <button
          type="button"
          onClick={() => setVocalistOpen(o => !o)}
          className="flex items-center gap-1.5 text-xs text-[#676767] hover:text-[#3b3b3b] transition-colors"
        >
          <span className={`inline-flex items-center justify-center w-4 h-4 rounded border border-[#bdbdbd] text-[#676767] transition-transform ${vocalistOpen ? 'rotate-45' : ''}`}>
            +
          </span>
          Vocalist
          {!vocalistOpen && selectedVocalists.length > 0 && (
            <span className="text-[#929292] ml-1">
              {selectedVocalists.map(id => VOCALISTS.find(v => v.id === id)?.name).filter(Boolean).join(', ')}
            </span>
          )}
        </button>
        {vocalistOpen && (
          <div className="mt-3 grid grid-cols-4 gap-2">
            {VOCALISTS.map(v => {
              const selected = selectedVocalists.includes(v.id);
              return (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => toggleVocalist(v.id)}
                  className={`flex flex-col items-center gap-1.5 p-2 rounded-lg border transition-all ${
                    selected
                      ? 'border-[#f37321] bg-[#fff3eb] ring-1 ring-[#f37321]'
                      : 'border-[#e9e9e9] bg-[#f6f6f6] hover:border-[#bdbdbd]'
                  }`}
                >
                  <div className="w-9 h-9 rounded-full overflow-hidden flex-shrink-0">
                    <VocalistAvatar name={v.name} color={v.color} colorLight={v.colorLight} />
                  </div>
                  <span className={`text-[10px] font-semibold leading-tight ${selected ? 'text-[#f37321]' : 'text-[#3b3b3b]'}`}>
                    {v.name}
                  </span>
                  <span className="text-[9px] text-[#929292] leading-tight text-center">
                    {v.description}
                  </span>
                  {selected && (
                    <span className="text-[8px] text-[#f37321] font-semibold">✓ Selected</span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Instruments */}
      <div>
        <button
          type="button"
          onClick={() => setInstrumentsOpen(o => !o)}
          className="flex items-center gap-1.5 text-xs text-[#676767] hover:text-[#3b3b3b] transition-colors"
        >
          <span className={`inline-flex items-center justify-center w-4 h-4 rounded border border-[#bdbdbd] text-[#676767] transition-transform ${instrumentsOpen ? 'rotate-45' : ''}`}>
            +
          </span>
          Instruments
          {!instrumentsOpen && instruments.length > 0 && (
            <span className="text-[#929292] ml-1 font-normal">{instruments.join(', ')}</span>
          )}
        </button>
        {instrumentsOpen && (
          <div className="mt-2 flex flex-col gap-3">
            {INSTRUMENT_GROUPS.map(group => (
              <div key={group.label}>
                <p className="text-[10px] font-semibold text-[#929292] uppercase tracking-wider mb-1">{group.label}</p>
                <div className="flex flex-wrap gap-1">
                  {group.items.map(inst => {
                    const active = instruments.includes(inst);
                    return (
                      <button
                        key={inst}
                        type="button"
                        onClick={() => active ? removeInstrument(instruments.indexOf(inst)) : addInstrument(inst)}
                        className={`flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs transition-colors ${
                          active
                            ? 'bg-[#f37321] border-[#f37321] text-white'
                            : 'bg-[#f6f6f6] border-[#e9e9e9] text-[#464646] hover:border-[#f37321] hover:text-[#f37321]'
                        }`}
                      >
                        <InstrumentIcon name={inst} />
                        {inst}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
            <div>
              <p className="text-[10px] font-semibold text-[#929292] uppercase tracking-wider mb-1">Custom</p>
              <input
                type="text"
                placeholder="Add instrument, press Enter…"
                onKeyDown={handleInstrumentKeyDown}
                onBlur={handleInstrumentBlur}
                className="w-full rounded bg-[#f6f6f6] border border-[#e9e9e9] text-[#3b3b3b] placeholder-[#929292] px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-[#f37321]"
              />
            </div>
            {instruments.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {instruments.map((inst, i) => (
                  <span key={i} className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#f37321] text-xs text-white">
                    <InstrumentIcon name={inst} />
                    {inst}
                    <button
                      type="button"
                      onClick={() => removeInstrument(i)}
                      className="opacity-70 hover:opacity-100 transition-opacity leading-none"
                      aria-label={`Remove ${inst}`}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Composition Plan */}
      {compositionPlan && (
        <div>
          <button
            type="button"
            onClick={() => setPlanOpen(o => !o)}
            className="flex items-center gap-1.5 text-xs text-[#676767] hover:text-[#3b3b3b] transition-colors"
          >
            <span className={`inline-flex items-center justify-center w-4 h-4 rounded border border-[#bdbdbd] text-[#676767] transition-transform ${planOpen ? 'rotate-45' : ''}`}>
              +
            </span>
            Composition Plan
            {!planOpen && ((section.positiveStylesRemove?.length ?? 0) + (section.positiveStylesAdd?.length ?? 0)) > 0 && (
              <span className="text-[9px] text-[#f37321] font-semibold ml-0.5">edited</span>
            )}
          </button>
          {planOpen && (() => {
            const removedSet = new Set(section.positiveStylesRemove ?? []);
            const addedStyles = section.positiveStylesAdd ?? [];
            const displayedPositive = [
              ...compositionPlan.positiveLocal.filter(t => !removedSet.has(t)),
              ...addedStyles,
            ];
            const hasOverrides = removedSet.size > 0 || addedStyles.length > 0;

            const removePositiveTag = (tag: string) => {
              if (addedStyles.includes(tag)) {
                update({ positiveStylesAdd: addedStyles.filter(t => t !== tag) });
              } else {
                update({ positiveStylesRemove: [...(section.positiveStylesRemove ?? []), tag] });
              }
            };

            const addPositiveTag = (tag: string) => {
              const trimmed = tag.trim();
              if (!trimmed || displayedPositive.includes(trimmed)) return;
              update({ positiveStylesAdd: [...addedStyles, trimmed] });
            };

            return (
              <div className="mt-2 flex flex-col gap-2">
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-[10px] font-semibold text-[#929292] uppercase tracking-wider">Positive</p>
                    {hasOverrides && (
                      <button
                        type="button"
                        onClick={() => update({ positiveStylesRemove: [], positiveStylesAdd: [] })}
                        className="text-[9px] text-[#929292] hover:text-[#464646] transition-colors"
                      >
                        Reset
                      </button>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1 items-center">
                    {displayedPositive.map((tag, i) => {
                      const isAdded = addedStyles.includes(tag);
                      return (
                        <span
                          key={i}
                          className={`group flex items-center gap-0.5 px-1.5 py-0.5 rounded border text-[10px] font-mono ${
                            isAdded
                              ? 'bg-[#fff3eb] border-[#f37321] text-[#c45a10]'
                              : 'bg-[#fff3eb] border-[#f37321]/30 text-[#c45a10]'
                          }`}
                        >
                          {tag}
                          <button
                            type="button"
                            onClick={() => removePositiveTag(tag)}
                            className="opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity leading-none text-[10px] ml-0.5"
                            aria-label={`Remove ${tag}`}
                          >×</button>
                        </span>
                      );
                    })}
                    {/* Inline add input */}
                    <form
                      onSubmit={e => { e.preventDefault(); addPositiveTag(styleTagInput); setStyleTagInput(''); }}
                      className="flex items-center"
                    >
                      <input
                        type="text"
                        value={styleTagInput}
                        onChange={e => setStyleTagInput(e.target.value)}
                        placeholder="+ add"
                        className="w-14 rounded bg-[#f6f6f6] border border-[#e9e9e9] text-[#3b3b3b] placeholder-[#bdbdbd] px-2 py-0.5 text-[10px] font-mono focus:outline-none focus:ring-1 focus:ring-[#f37321] focus:border-[#f37321]"
                        onBlur={() => { if (styleTagInput.trim()) { addPositiveTag(styleTagInput); setStyleTagInput(''); } }}
                      />
                    </form>
                  </div>
                </div>
                <div>
                  <p className="text-[10px] font-semibold text-[#929292] uppercase tracking-wider mb-1">Negative</p>
                  <div className="flex flex-wrap gap-1">
                    {compositionPlan.negativeLocal.map((tag, i) => (
                      <span key={i} className="px-1.5 py-0.5 rounded bg-[#f6f6f6] border border-[#e9e9e9] text-[10px] text-[#929292] font-mono">
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {/* Lyrics */}
      <div>
        <label className="block text-xs text-[#929292] mb-1">Lyrics</label>
        <textarea
          value={section.lyrics}
          onChange={e => update({ lyrics: e.target.value })}
          rows={Math.max(2, section.lyrics.split('\n').length + 1)}
          className="w-full rounded bg-[#f6f6f6] border border-[#e9e9e9] text-[#3b3b3b] placeholder-[#929292] px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-[#f37321]"
        />
      </div>
    </div>
  );
}
