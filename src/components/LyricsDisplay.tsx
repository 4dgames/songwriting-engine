'use client';

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

  let timestampCursor = 0;

  return (
    <div className="flex flex-col gap-6">
      {sections.map((section, si) => {
        const lines = section.lyrics.split('\n').map(l => l.trim()).filter(Boolean);
        const isActive = activeSectionIndex === si;

        return (
          <div key={si} className="flex flex-col gap-2">
            <button
              onClick={() => onSectionClick?.(si)}
              className={`self-start text-xs font-bold uppercase tracking-widest transition-colors ${
                isActive
                  ? 'text-[#f37321] underline underline-offset-2'
                  : 'text-[#f37321] opacity-70 hover:opacity-100'
              }`}
            >
              {section.label}
            </button>
            <div className={`flex flex-col gap-1 rounded px-2 py-1 transition-colors ${isActive ? 'bg-[#fff3eb]' : ''}`}>
              {lines.map((line, li) => {
                const words = line.split(/\s+/);
                return (
                  <p key={li} className="text-base leading-relaxed text-[#3b3b3b]">
                    {words.map((word, wi) => {
                      const ts = wordTimestamps[timestampCursor];
                      const isActiveWord = ts && activeWord === ts;
                      timestampCursor++;
                      return (
                        <span
                          key={wi}
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
  );
}
