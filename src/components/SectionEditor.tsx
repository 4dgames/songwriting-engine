'use client';

import { useState } from 'react';
import type { SongSection, SectionTake } from '@/lib/types';
import { VOCALISTS } from '@/lib/vocalists';

interface Props {
  section: SongSection;
  index: number;
  tempo: number;
  onChange: (index: number, updated: SongSection) => void;
  onRegenerate?: (mode: 'vocals' | 'instruments' | 'both') => void;
  regenerating?: boolean;
  isNewSection?: boolean;
  onInsertAfter?: () => void;
  onDelete?: () => void;
  sectionTakes?: SectionTake[];
  onRestoreTake?: (take: SectionTake) => void;
  isPlaying?: boolean;
  onPlay?: () => void;
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

// 4/4 time assumed throughout — 1 bar = 4 beats = 240000 ms / tempo
function msToBars(ms: number, tempo: number): number {
  return ms * tempo / 240000;
}
function barsToMs(bars: number, tempo: number): number {
  return Math.round(bars * 240000 / tempo);
}
/** Round bars to nearest multiple of 2, with 1 as the only allowed odd value. */
function roundToBars(bars: number): number {
  if (bars <= 1) return 1;
  return Math.max(2, Math.round(bars / 2) * 2);
}
function estimateDurationBars(_lyrics: string, _tempo: number): number {
  return 8;
}

export default function SectionEditor({ section, index, tempo, onChange, onRegenerate, regenerating, isNewSection, onInsertAfter, onDelete, sectionTakes, onRestoreTake, isPlaying, onPlay }: Props) {
  const [chordsOpen, setChordsOpen] = useState(false);
  const [vocalistOpen, setVocalistOpen] = useState(false);
  const [regenOpen, setRegenOpen] = useState(false);
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
          {/* Duration override in bars */}
          <div className="flex items-center gap-1 flex-shrink-0">
            <input
              type="number"
              min={1}
              max={Math.round(msToBars(120000, tempo))}
              step={1}
              value={section.durationMs != null ? roundToBars(Math.round(msToBars(section.durationMs, tempo))) : ''}
              onChange={e => {
                const raw = e.target.value;
                if (raw === '') {
                  update({ durationMs: undefined });
                } else {
                  const parsed = parseInt(raw, 10);
                  if (!isNaN(parsed)) {
                    const bars = roundToBars(Math.max(1, parsed));
                    update({ durationMs: barsToMs(bars, tempo) });
                  }
                }
              }}
              placeholder={String(estimateDurationBars(section.lyrics, tempo))}
              title="Section duration in bars (leave blank to auto-estimate from lyrics)"
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
                onClick={() => onRegenerate('both')}
                title="Generate this section"
                className="flex items-center gap-1 px-2 py-0.5 rounded border border-[#f37321] bg-[#fff3eb] hover:bg-[#ffe5d0] text-[#f37321] text-[10px] font-semibold transition-colors flex-shrink-0"
              >
                <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
                </svg>
                Generate
              </button>
            ) : (
              <div className="relative flex-shrink-0">
                <button
                  type="button"
                  onClick={() => setRegenOpen(o => !o)}
                  title="Regenerate section"
                  className="w-6 h-6 flex items-center justify-center rounded border border-[#e9e9e9] bg-[#f6f6f6] hover:bg-[#e9e9e9] text-[#464646] transition-colors"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                </button>
                {regenOpen && (
                  <>
                    {/* Backdrop to close on outside click */}
                    <div className="fixed inset-0 z-10" onClick={() => setRegenOpen(false)} />
                    <div className="absolute right-0 top-full mt-1 z-20 bg-white rounded-lg border border-[#e9e9e9] shadow-[0_4px_16px_rgba(0,0,0,0.12)] py-1 min-w-[140px]">
                      {([
                        ['vocals',      'Regenerate Vocals'],
                        ['instruments', 'Regenerate Instruments'],
                        ['both',        'Regenerate Both'],
                      ] as const).map(([mode, label]) => (
                        <button
                          key={mode}
                          type="button"
                          onClick={() => { setRegenOpen(false); onRegenerate(mode); }}
                          className="w-full text-left px-3 py-1.5 text-xs text-[#3b3b3b] hover:bg-[#fff3eb] hover:text-[#f37321] transition-colors"
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
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

      {/* Chords — collapsible */}
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
            <span className="text-[#929292] font-mono ml-1">{section.chords.join(' ')}</span>
          )}
        </button>
        {chordsOpen && (
          <input
            type="text"
            value={section.chords.join(' ')}
            onChange={e => update({ chords: e.target.value.split(/[\s,]+/).filter(Boolean) })}
            placeholder="Am F C G"
            className="mt-2 w-full rounded bg-[#f6f6f6] border border-[#e9e9e9] text-[#3b3b3b] placeholder-[#929292] px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-[#f37321]"
          />
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
        <label className="block text-xs text-[#929292] mb-2">Instruments</label>
        <div className="flex flex-wrap gap-1.5 mb-2">
          {instruments.map((inst, i) => (
            <span key={i} className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#e9e9e9] text-xs text-[#464646]">
              {inst}
              <button
                type="button"
                onClick={() => removeInstrument(i)}
                className="text-[#929292] hover:text-[#3b3b3b] transition-colors leading-none"
                aria-label={`Remove ${inst}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
        <input
          type="text"
          placeholder="Add instrument, press Enter…"
          onKeyDown={handleInstrumentKeyDown}
          onBlur={handleInstrumentBlur}
          className="w-full rounded bg-[#f6f6f6] border border-[#e9e9e9] text-[#3b3b3b] placeholder-[#929292] px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-[#f37321]"
        />
      </div>

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
