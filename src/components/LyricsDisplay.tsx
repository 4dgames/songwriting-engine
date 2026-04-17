'use client';

import { useEffect, useRef, useState } from 'react';
import type { SongSection, WordTimestamp } from '@/lib/types';

interface Props {
  sections: SongSection[];
  wordTimestamps: WordTimestamp[];
  currentTimeMs: number;
  activeSectionIndex?: number | null;
  onSectionClick?: (index: number) => void;
}

export default function LyricsDisplay({ sections, wordTimestamps, currentTimeMs, activeSectionIndex, onSectionClick }: Props) {
  const activeIndex = wordTimestamps.findIndex(
    w => currentTimeMs >= w.start_ms && currentTimeMs <= w.end_ms
  );
  const activeWord = activeIndex >= 0 ? wordTimestamps[activeIndex] : null;

  const [viewMode,    setViewMode]    = useState<'big' | 'compact'>('big');
  const [autoScroll,  setAutoScroll]  = useState(true);
  const containerRef      = useRef<HTMLDivElement>(null);
  const activeWordRef     = useRef<HTMLSpanElement>(null);
  const programmaticRef   = useRef(false);

  // Auto-scroll: keep the active word centred vertically in the panel
  useEffect(() => {
    if (!autoScroll || !activeWordRef.current || !containerRef.current) return;
    const el        = activeWordRef.current;
    const container = containerRef.current;
    const elTop     = el.offsetTop;
    const elH       = el.offsetHeight;
    const viewH     = container.clientHeight;
    programmaticRef.current = true;
    container.scrollTop = elTop - viewH / 2 + elH / 2;
    requestAnimationFrame(() => { programmaticRef.current = false; });
  }, [activeIndex, autoScroll]);

  // If the user manually scrolls, disable auto-scroll
  const onUserScroll = () => {
    if (programmaticRef.current) return;
    if (activeWord) setAutoScroll(false);
  };

  let timestampCursor = 0;

  // ── View toggle ───────────────────────────────────────────────────────────────
  const viewToggle = (
    <div className="flex items-center gap-0.5 rounded-md border border-[#e9e9e9] overflow-hidden">
      {/* Big karaoke view */}
      <button
        onClick={() => setViewMode('big')}
        title="Big karaoke view"
        className={`px-2 py-0.5 text-[10px] font-semibold transition-colors ${
          viewMode === 'big'
            ? 'bg-[#f37321] text-white'
            : 'text-[#929292] hover:text-[#3b3b3b] bg-white'
        }`}
      >
        <span className="text-base font-bold leading-none">A</span>
      </button>
      {/* Compact sheet view */}
      <button
        onClick={() => setViewMode('compact')}
        title="Compact sheet view"
        className={`px-2 py-0.5 transition-colors ${
          viewMode === 'compact'
            ? 'bg-[#f37321] text-white'
            : 'text-[#929292] hover:text-[#3b3b3b] bg-white'
        }`}
      >
        {/* Three lines icon */}
        <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 16 16">
          <rect x="0" y="2" width="16" height="2" rx="1" />
          <rect x="0" y="7" width="16" height="2" rx="1" />
          <rect x="0" y="12" width="16" height="2" rx="1" />
        </svg>
      </button>
    </div>
  );

  // ── Compact (old) view ────────────────────────────────────────────────────────
  if (viewMode === 'compact') {
    let cursor = 0;
    return (
      <div className="flex flex-col gap-0" style={{ position: 'relative' }}>
        <div className="flex items-center justify-end gap-2 mb-2">
          <label className="flex items-center gap-1.5 cursor-pointer select-none">
            <div
              onClick={() => setAutoScroll(v => !v)}
              className={`relative w-7 h-3.5 rounded-full transition-colors ${autoScroll ? 'bg-[#f37321]' : 'bg-[#bdbdbd]'}`}
            >
              <span className={`absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white shadow transition-transform ${autoScroll ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
            </div>
            <span className="text-[10px] text-[#929292]">Auto-scroll</span>
          </label>
          {viewToggle}
        </div>

        <div
          ref={containerRef}
          onScroll={onUserScroll}
          className="flex flex-col gap-4 overflow-y-auto"
          style={{ maxHeight: '240vh' }}
        >
          {sections.map((section, si) => {
            const lines   = section.lyrics.split('\n').map(l => l.trim()).filter(Boolean);
            const isActive = activeSectionIndex === si;

            return (
              <div key={si} className="flex flex-col gap-1">
                <button
                  onClick={() => onSectionClick?.(si)}
                  className={`text-base font-bold uppercase tracking-widest text-left transition-colors ${
                    isActive
                      ? 'text-[#f37321] underline underline-offset-2'
                      : 'text-[#f37321] opacity-70 hover:opacity-100'
                  }`}
                >
                  {section.label}
                </button>
                <div className={`flex flex-col gap-0.5 rounded px-2 py-1 transition-colors ${isActive ? 'bg-[#fff3eb]' : ''}`}>
                  {lines.map((line, li) => {
                    const words = line.split(/\s+/);
                    return (
                      <p key={li} className="text-[18px] leading-relaxed text-[#3b3b3b]">
                        {words.map((word, wi) => {
                          const ts           = wordTimestamps[cursor];
                          const isActiveWord = ts && activeWord === ts;
                          cursor++;
                          return (
                            <span
                              key={wi}
                              ref={isActiveWord ? activeWordRef : undefined}
                              className={`transition-colors duration-75 rounded px-0.5 ${
                                isActiveWord
                                  ? 'text-white bg-[#f37321]'
                                  : currentTimeMs > (ts?.end_ms ?? 0) && ts
                                  ? 'text-[#929292]'
                                  : 'text-[#3b3b3b]'
                              }`}
                            >
                              {word}{' '}
                            </span>
                          );
                        })}
                      </p>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // ── Big (current) view ────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-0" style={{ position: 'relative' }}>
      <div className="flex items-center justify-end gap-2 mb-2">
        {viewToggle}
      </div>

      <div
        ref={containerRef}
        onScroll={onUserScroll}
        className="flex flex-col gap-6 overflow-y-auto"
        style={{ maxHeight: 170 }}
      >
        {sections.map((section, si) => {
          const lines   = section.lyrics.split('\n').map(l => l.trim()).filter(Boolean);
          const isActive = activeSectionIndex === si;

          return (
            <div key={si} className="flex flex-col items-center gap-2">
              <button
                onClick={() => onSectionClick?.(si)}
                className={`text-xs font-bold uppercase tracking-widest transition-colors ${
                  isActive
                    ? 'text-[#f37321] underline underline-offset-2'
                    : 'text-[#f37321] opacity-70 hover:opacity-100'
                }`}
              >
                {section.label}
              </button>
              <div className={`flex flex-col gap-1 items-center text-center w-full rounded px-2 py-1 transition-colors ${isActive ? 'bg-[#fff3eb]' : ''}`}>
                {lines.map((line, li) => {
                  const words = line.split(/\s+/);
                  return (
                    <p key={li} className="text-3xl font-medium leading-snug text-[#3b3b3b]">
                      {words.map((word, wi) => {
                        const ts          = wordTimestamps[timestampCursor];
                        const isActiveWord = ts && activeWord === ts;
                        timestampCursor++;
                        return (
                          <span
                            key={wi}
                            ref={isActiveWord ? activeWordRef : undefined}
                            className={`transition-colors duration-75 rounded px-0.5 ${
                              isActiveWord
                                ? 'text-white bg-[#f37321]'
                                : currentTimeMs > (ts?.end_ms ?? 0) && ts
                                ? 'text-[#929292]'
                                : 'text-[#3b3b3b]'
                            }`}
                          >
                            {word}{' '}
                          </span>
                        );
                      })}
                    </p>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
