'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { SongSection, WordTimestamp } from '@/lib/types';

interface SectionMarker { ratio: number; label: string; }

interface Props {
  sections: SongSection[];
  sectionMarkers: SectionMarker[];
  peaks: number[];            // 800-sample peaks for the full instrumental
  wordTimestamps: WordTimestamp[];
  audioDurationMs: number;
  currentTimeMs: number;
  activeSectionIndex: number | null;
  /** Seek without toggling the section selection state */
  onSeek: (ratio: number) => void;
  /** Click the section header — toggles active state + seeks */
  onSectionClick: (index: number) => void;
}

// ── Per-section mini waveform ─────────────────────────────────────────────────

interface SectionCanvasProps {
  slice: number[];           // peaks for just this section
  sectionProgress: number;   // 0–1 playhead position within this section
  zoom: number;
}

function SectionCanvas({ slice, sectionProgress, zoom }: SectionCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Higher resolution canvas when zoomed in for crisp rendering
  const resolution = Math.round(800 * Math.max(1, zoom));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx   = canvas.getContext('2d')!;
    const { width: w, height: h } = canvas;
    const mid   = h / 2;
    ctx.clearRect(0, 0, w, h);

    if (slice.length === 0) {
      ctx.fillStyle = '#e9e9e9';
      ctx.fillRect(0, mid - 1, w, 2);
      return;
    }

    const playedX = Math.max(0, Math.min(w, Math.round(sectionProgress * w)));

    for (let i = 0; i < w; i++) {
      const idx  = Math.floor((i / w) * slice.length);
      const barH = Math.max(2, (slice[idx] ?? 0) * h * 0.88);
      ctx.fillStyle = i < playedX ? '#f37321' : '#d4d4d4';
      ctx.fillRect(i, mid - barH / 2, 1, barH);
    }

    // Playhead line
    ctx.fillStyle = '#f37321';
    ctx.fillRect(Math.min(playedX, w - 2), 0, 2, h);
  }, [slice, sectionProgress, resolution]);

  return (
    <canvas
      ref={canvasRef}
      width={resolution}
      height={96}
      className="w-full"
      style={{ height: 96, display: 'block' }}
    />
  );
}

// ── Main SheetMusicView ────────────────────────────────────────────────────────

export default function SheetMusicView({
  sections,
  sectionMarkers,
  peaks,
  wordTimestamps,
  audioDurationMs,
  currentTimeMs,
  activeSectionIndex,
  onSeek,
  onSectionClick,
}: Props) {
  const [zoom, setZoom] = useState(1);

  // One scroll-container ref per section index
  const scrollRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  // Precompute per-section peak slices (only recomputed when peaks or markers change)
  const sectionSlices = useMemo(() => {
    const n = peaks.length || 1;
    return sectionMarkers.map((m, i) => {
      const endRatio = sectionMarkers[i + 1]?.ratio ?? 1;
      const startI   = Math.floor(m.ratio * n);
      const endI     = Math.ceil(endRatio * n);
      return peaks.slice(startI, endI);
    });
  }, [peaks, sectionMarkers]);

  // Auto-scroll the active section's waveform to keep the playhead centred
  useEffect(() => {
    if (zoom <= 1) return;
    for (let i = 0; i < sectionMarkers.length; i++) {
      const marker   = sectionMarkers[i];
      const endRatio = sectionMarkers[i + 1]?.ratio ?? 1;
      const startMs  = marker.ratio * audioDurationMs;
      const endMs    = endRatio * audioDurationMs;
      if (currentTimeMs < startMs || currentTimeMs >= endMs) continue;

      const el = scrollRefs.current.get(i);
      if (!el) break;

      const sectionProgress = (currentTimeMs - startMs) / Math.max(1, endMs - startMs);
      const totalW = el.scrollWidth;
      const viewW  = el.clientWidth;
      const playheadX = sectionProgress * totalW;
      el.scrollLeft = Math.max(0, Math.min(playheadX - viewW / 2, totalW - viewW));
      break;
    }
  }, [currentTimeMs, zoom, audioDurationMs, sectionMarkers]);

  if (sectionMarkers.length === 0) {
    return (
      <div className="flex items-center justify-center h-20 text-xs text-[#929292]">
        Play the song to load section markers.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* ── Zoom controls ── */}
      <div className="flex items-center justify-end gap-1.5">
        <span className="text-[10px] text-[#929292] uppercase tracking-wider mr-1">Zoom</span>
        <button
          onClick={() => setZoom(z => Math.max(1, parseFloat((z - 0.5).toFixed(1))))}
          disabled={zoom <= 1}
          className="w-6 h-6 flex items-center justify-center rounded border border-[#e9e9e9] bg-white text-[#676767] hover:border-[#bdbdbd] hover:text-[#3b3b3b] disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-sm font-bold leading-none"
          title="Zoom out"
        >
          −
        </button>
        <span className="text-xs text-[#3b3b3b] w-8 text-center tabular-nums">{zoom}×</span>
        <button
          onClick={() => setZoom(z => Math.min(4, parseFloat((z + 0.5).toFixed(1))))}
          disabled={zoom >= 4}
          className="w-6 h-6 flex items-center justify-center rounded border border-[#e9e9e9] bg-white text-[#676767] hover:border-[#bdbdbd] hover:text-[#3b3b3b] disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-sm font-bold leading-none"
          title="Zoom in"
        >
          +
        </button>
      </div>

      {sections.map((section, i) => {
        const marker    = sectionMarkers[i];
        if (!marker) return null;

        const endRatio   = sectionMarkers[i + 1]?.ratio ?? 1;
        const startMs    = marker.ratio * audioDurationMs;
        const endMs      = endRatio * audioDurationMs;
        const durationMs = Math.max(1, endMs - startMs);

        const isActive  = activeSectionIndex === i;
        const isPast    = currentTimeMs >= endMs;
        const isCurrent = currentTimeMs >= startMs && currentTimeMs < endMs;

        const sectionProgress = isCurrent
          ? (currentTimeMs - startMs) / durationMs
          : isPast ? 1 : 0;

        // Words that fall within this section's time window
        const sectionWords = wordTimestamps.filter(
          w => w.start_ms >= startMs - 50 && w.start_ms < endMs
        );

        // Font scale tied to zoom
        const lyricsFontSize = Math.round(11 * Math.sqrt(zoom));

        return (
          <div
            key={i}
            className={`rounded-xl border transition-all duration-200 overflow-hidden ${
              isActive
                ? 'border-[#f37321] shadow-[0_0_0_2px_rgba(243,115,33,0.10)]'
                : 'border-[#e9e9e9] hover:border-[#bdbdbd]'
            }`}
            style={{ background: isActive ? '#fffaf6' : '#ffffff' }}
          >
            {/* ── Staff header ── */}
            <div
              className="flex items-center justify-between gap-4 px-4 pt-3 pb-1 cursor-pointer select-none"
              onClick={() => { onSectionClick(i); onSeek(marker.ratio); }}
            >
              <div className="flex items-center gap-2 min-w-0">
                {/* Playing indicator */}
                <span className={`w-2 h-2 rounded-full flex-shrink-0 transition-colors ${
                  isCurrent ? 'bg-[#f37321] animate-pulse' : 'bg-transparent border border-[#d4d4d4]'
                }`} />
                <span className={`text-xs font-bold uppercase tracking-widest truncate ${
                  isActive ? 'text-[#f37321]' : isPast ? 'text-[#929292]' : 'text-[#3b3b3b]'
                }`}>
                  {marker.label}
                </span>
                {section.mood && (
                  <span className="text-[10px] text-[#929292] italic truncate hidden sm:block">
                    {section.mood}
                  </span>
                )}
              </div>

              {/* Chord symbols */}
              {section.chords.length > 0 && (
                <div className="flex items-center gap-1 flex-shrink-0 flex-wrap justify-end">
                  {section.chords.map((chord, ci) => (
                    <span
                      key={ci}
                      className={`text-[11px] font-bold font-mono px-1.5 py-0.5 rounded transition-colors ${
                        isActive
                          ? 'bg-[#fff0e6] text-[#f37321]'
                          : 'bg-[#f6f6f6] text-[#676767]'
                      }`}
                    >
                      {chord}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* ── Scrollable waveform + lyrics area ── */}
            <div
              ref={el => {
                if (el) scrollRefs.current.set(i, el);
                else scrollRefs.current.delete(i);
              }}
              className="overflow-x-auto"
              style={{ scrollbarWidth: 'none' }}
            >
              <div style={{ width: zoom > 1 ? `${zoom * 100}%` : '100%', minWidth: '100%' }}>

                {/* Waveform */}
                <div
                  className="px-4 cursor-crosshair"
                  onClick={e => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    const local = (e.clientX - rect.left) / rect.width;
                    onSeek(marker.ratio + local * (endRatio - marker.ratio));
                  }}
                >
                  <SectionCanvas
                    slice={sectionSlices[i] ?? []}
                    sectionProgress={sectionProgress}
                    zoom={zoom}
                  />
                </div>

                {/* Lyrics */}
                <div className="px-4 pb-3 pt-1.5">
                  {sectionWords.length > 0 ? (
                    // Timestamp-aligned lyrics: words revealed only when it's time to sing them.
                    <div className="relative select-none overflow-hidden" style={{ height: lyricsFontSize * 2.2 }}>
                      {sectionWords.map((w, wi) => {
                        const leftPct   = ((w.start_ms - startMs) / durationMs) * 100;
                        const isSung    = currentTimeMs > w.end_ms;
                        const isSinging = currentTimeMs >= w.start_ms && currentTimeMs <= w.end_ms;
                        const isVisible = isSinging || isSung;
                        return (
                          <span
                            key={wi}
                            style={{ left: `${Math.min(98, leftPct)}%`, fontSize: lyricsFontSize }}
                            onClick={e => {
                              e.stopPropagation();
                              onSeek(w.start_ms / audioDurationMs);
                            }}
                            className={`absolute whitespace-nowrap cursor-pointer leading-none transition-all duration-100 ${
                              !isVisible
                                ? 'opacity-0'
                                : isSinging
                                ? 'text-[#f37321] font-bold underline underline-offset-2 decoration-[#f37321] opacity-100'
                                : 'text-[#c4c4c4] opacity-100'
                            }`}
                          >
                            {w.word}
                          </span>
                        );
                      })}
                    </div>
                  ) : section.lyrics.trim() ? (
                    // Fallback: plain text when no timestamps available (e.g. MusicGen)
                    <div className="flex flex-col gap-0.5">
                      {section.lyrics.split('\n').map((line, li) => (
                        <p key={li} style={{ fontSize: lyricsFontSize }} className={`leading-relaxed ${
                          isActive ? 'text-[#3b3b3b]' : 'text-[#929292]'
                        }`}>
                          {line.trim()}
                        </p>
                      ))}
                    </div>
                  ) : null}
                </div>

              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
