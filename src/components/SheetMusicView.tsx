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
  isPlaying: boolean;
  activeSectionIndex: number | null;
  /** Seek without toggling the section selection state */
  onSeek: (ratio: number) => void;
  /** Click the section header — toggles active state + seeks */
  onSectionClick: (index: number) => void;
}

// ── Full-song waveform canvas ────────────────────────────────────────────────

interface WaveformCanvasProps {
  peaks: number[];
  audioDurationMs: number;
  lastKnownTimeMsRef: React.MutableRefObject<number>;
  lastUpdateWallMsRef: React.MutableRefObject<number>;
  isPlayingRef: React.MutableRefObject<boolean>;
  zoom: number;
  sectionMarkers: SectionMarker[];
  onSeek: (ratio: number) => void;
}

function WaveformCanvas({ peaks, audioDurationMs, lastKnownTimeMsRef, lastUpdateWallMsRef, isPlayingRef, zoom, sectionMarkers, onSeek }: WaveformCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef    = useRef<number | null>(null);

  useEffect(() => {
    const draw = () => {
      const canvas = canvasRef.current;
      if (!canvas) { rafRef.current = requestAnimationFrame(draw); return; }

      const dpr  = window.devicePixelRatio || 1;
      const cssW = canvas.clientWidth;
      const cssH = canvas.clientHeight;
      if (!cssW || !cssH) { rafRef.current = requestAnimationFrame(draw); return; }

      const physW = Math.round(cssW * dpr);
      const physH = Math.round(cssH * dpr);
      if (canvas.width !== physW || canvas.height !== physH) {
        canvas.width  = physW;
        canvas.height = physH;
      }

      // Dead-reckon current position only while playing
      const elapsed = isPlayingRef.current ? performance.now() - lastUpdateWallMsRef.current : 0;
      const estimatedMs = lastKnownTimeMsRef.current + elapsed;
      const currentRatio = audioDurationMs > 0 ? Math.min(1, estimatedMs / audioDurationMs) : 0;

      const ctx = canvas.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const w   = cssW;
      const h   = cssH;
      const mid = h / 2;

      ctx.clearRect(0, 0, w, h);

      // Alternating section backgrounds
      sectionMarkers.forEach((m, i) => {
        const endRatio = sectionMarkers[i + 1]?.ratio ?? 1;
        ctx.fillStyle = i % 2 === 0 ? '#f9f9f9' : '#f0f0f0';
        ctx.fillRect(m.ratio * w, 0, (endRatio - m.ratio) * w, h);
      });

      // Waveform bars
      if (peaks.length > 0) {
        const playedX = currentRatio * w;
        const barW    = w / peaks.length;
        const barFill = barW < 1.5 ? barW : barW * 0.72;
        for (let i = 0; i < peaks.length; i++) {
          const x    = (i / peaks.length) * w;
          const barH = Math.max(1, (peaks[i] ?? 0) * h * 0.88);
          ctx.fillStyle = x < playedX ? '#f37321' : '#c8c8c8';
          ctx.fillRect(x, mid - barH / 2, barFill, barH);
        }
        // Playhead
        ctx.fillStyle = '#f37321';
        ctx.fillRect(Math.min(currentRatio * w, w - 1.5), 0, 1.5, h);
      } else {
        ctx.fillStyle = '#e9e9e9';
        ctx.fillRect(0, mid - 1, w, 2);
      }

      // Section divider lines
      sectionMarkers.forEach(m => {
        if (m.ratio === 0) return;
        ctx.fillStyle = '#bdbdbd';
        ctx.fillRect(m.ratio * w - 0.5, 0, 1, h);
      });

      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [peaks, audioDurationMs, zoom, sectionMarkers, lastKnownTimeMsRef, lastUpdateWallMsRef]);

  const getSeekRatio = (clientX: number): number => {
    const canvas = canvasRef.current;
    if (!canvas) return 0;
    const rect = canvas.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    onSeek(getSeekRatio(e.clientX));

    const onMove = (ev: MouseEvent) => { onSeek(getSeekRatio(ev.clientX)); };
    const onUp   = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',   onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
  };

  return (
    <canvas
      ref={canvasRef}
      className="w-full cursor-crosshair"
      style={{ height: 220, display: 'block' }}
      onMouseDown={handleMouseDown}
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
  isPlaying,
  activeSectionIndex,
  onSeek,
  onSectionClick,
}: Props) {
  const [displayZoom, setDisplayZoom] = useState(0.5);
  const zoom = 4 + (displayZoom - 0.5) * (8 / 4.5);

  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollRafRef = useRef<number | null>(null);
  const lastKnownTimeMsRef = useRef(0);
  const lastUpdateWallMsRef = useRef(0);
  const isPlayingRef = useRef(false);

  // Current playback ratio (0–1 of full song)
  const currentRatio = audioDurationMs > 0 ? currentTimeMs / audioDurationMs : 0;

  // Keep isPlayingRef in sync
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);

  // Record each audio time update with its wall-clock timestamp
  useEffect(() => {
    lastKnownTimeMsRef.current = currentTimeMs;
    lastUpdateWallMsRef.current = performance.now();
  }, [currentTimeMs]);

  // RAF loop: scroll to extrapolated position only while playing
  useEffect(() => {
    const tick = () => {
      if (scrollRef.current && audioDurationMs > 0) {
        const el = scrollRef.current;
        const elapsed = isPlayingRef.current ? performance.now() - lastUpdateWallMsRef.current : 0;
        const estimatedMs = lastKnownTimeMsRef.current + elapsed;
        const ratio = Math.min(1, estimatedMs / audioDurationMs);
        const totalW = el.scrollWidth;
        const viewW  = el.clientWidth;
        el.scrollLeft = Math.max(0, Math.min(ratio * totalW - viewW / 2, totalW - viewW));
      }
      scrollRafRef.current = requestAnimationFrame(tick);
    };
    scrollRafRef.current = requestAnimationFrame(tick);
    return () => { if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current); };
  }, [audioDurationMs]);

  if (sectionMarkers.length === 0) {
    return (
      <div className="flex items-center justify-center h-20 text-xs text-[#929292]">
        Play the song to load section markers.
      </div>
    );
  }

  // Section label positions (ratio → percentage)
  const labelPositions = sectionMarkers.map((m, i) => {
    const endRatio = sectionMarkers[i + 1]?.ratio ?? 1;
    const midRatio = (m.ratio + endRatio) / 2;
    return { label: m.label, ratio: m.ratio, midRatio, index: i };
  });

  // Active section based on current time
  const activeSectionByTime = useMemo(() => {
    if (audioDurationMs === 0) return null;
    for (let i = sectionMarkers.length - 1; i >= 0; i--) {
      if (currentTimeMs >= sectionMarkers[i].ratio * audioDurationMs) return i;
    }
    return null;
  }, [currentTimeMs, audioDurationMs, sectionMarkers]);

  return (
    <div className="flex flex-col gap-3">
      {/* ── Zoom controls ── */}
      <div className="flex items-center justify-end gap-1.5">
        <span className="text-[10px] text-[#929292] uppercase tracking-wider mr-1">Zoom</span>
        <button
          onClick={() => setDisplayZoom(z => Math.max(0.5, parseFloat((z - 0.5).toFixed(1))))}
          disabled={displayZoom <= 0.5}
          className="w-6 h-6 flex items-center justify-center rounded border border-[#e9e9e9] bg-white text-[#676767] hover:border-[#bdbdbd] hover:text-[#3b3b3b] disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-sm font-bold leading-none"
          title="Zoom out"
        >
          −
        </button>
        <span className="text-xs text-[#3b3b3b] w-8 text-center tabular-nums">{displayZoom}×</span>
        <button
          onClick={() => setDisplayZoom(z => Math.min(5, parseFloat((z + 0.5).toFixed(1))))}
          disabled={displayZoom >= 5}
          className="w-6 h-6 flex items-center justify-center rounded border border-[#e9e9e9] bg-white text-[#676767] hover:border-[#bdbdbd] hover:text-[#3b3b3b] disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-sm font-bold leading-none"
          title="Zoom in"
        >
          +
        </button>
      </div>

      {/* ── Continuous waveform with section overlays ── */}
      <div
        ref={scrollRef}
        className="rounded-xl border border-[#e9e9e9] overflow-x-auto relative bg-white"
        style={{ scrollbarWidth: 'none' }}
      >
        <div style={{ width: zoom > 1 ? `${zoom * 100}%` : '100%', minWidth: '100%', position: 'relative' }}>

          {/* Section name labels above waveform */}
          <div className="relative h-6 select-none">
            {labelPositions.map(({ label, ratio, index }) => {
              const isCurrent = activeSectionByTime === index || activeSectionIndex === index;
              return (
                <button
                  key={index}
                  onClick={() => { onSectionClick(index); onSeek(ratio); }}
                  style={{ left: `${ratio * 100}%` }}
                  className={`absolute top-0 bottom-0 px-1.5 text-[9px] font-bold uppercase tracking-widest whitespace-nowrap transition-colors ${
                    isCurrent ? 'text-[#f37321]' : 'text-[#929292] hover:text-[#3b3b3b]'
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>

          {/* Waveform */}
          <WaveformCanvas
            peaks={peaks}
            audioDurationMs={audioDurationMs}
            lastKnownTimeMsRef={lastKnownTimeMsRef}
            lastUpdateWallMsRef={lastUpdateWallMsRef}
            isPlayingRef={isPlayingRef}
            zoom={zoom}
            sectionMarkers={sectionMarkers}
            onSeek={onSeek}
          />

          {/* Lyrics track — words stack into rows rather than shrink */}
          {wordTimestamps.length > 0 && audioDurationMs > 0 && (() => {
            // Font grows with sqrt(zoom) so words get bigger as you zoom in,
            // but grow slower than the container → fewer rows needed at higher zoom.
            const baseFontPx  = Math.round(8 * Math.sqrt(zoom));
            const charWidthEm = 0.275;

            // Word width as a % of the zoomed container
            const wordEndPct = (w: { word: string; start_ms: number }) => {
              const startPct = (w.start_ms / audioDurationMs) * 100;
              const widthPct = (w.word.length * baseFontPx * charWidthEm) / 800 * 100 / zoom;
              return startPct + widthPct;
            };

            // Greedy first-fit row assignment
            const rowEndPcts: number[] = [];
            const rows = wordTimestamps.map(w => {
              const startPct = (w.start_ms / audioDurationMs) * 100;
              const endPct   = wordEndPct(w);
              const rowIdx   = rowEndPcts.findIndex(rowEnd => startPct >= rowEnd);
              if (rowIdx !== -1) {
                rowEndPcts[rowIdx] = endPct;
                return rowIdx;
              }
              rowEndPcts.push(endPct);
              return rowEndPcts.length - 1;
            });

            const numRows = Math.max(1, rowEndPcts.length);
            const rowH    = baseFontPx + 4;
            const trackH  = numRows * rowH + 8;

            return (
              <div className="relative select-none overflow-hidden" style={{ height: trackH }}>
                {wordTimestamps.map((w, wi) => {
                  const leftPct   = (w.start_ms / audioDurationMs) * 100;
                  const isSung    = currentTimeMs > w.end_ms;
                  const isSinging = currentTimeMs >= w.start_ms && currentTimeMs <= w.end_ms;
                  return (
                    <span
                      key={wi}
                      style={{ left: `${Math.min(99.5, leftPct)}%`, top: 4 + rows[wi] * rowH, fontSize: baseFontPx }}
                      onClick={e => { e.stopPropagation(); onSeek(w.start_ms / audioDurationMs); }}
                      className={`absolute whitespace-nowrap cursor-pointer leading-none transition-colors duration-75 ${
                        isSinging
                          ? 'text-[#f37321] font-bold'
                          : isSung
                          ? 'text-[#929292]'
                          : 'text-[#bdbdbd]'
                      }`}
                    >
                      {w.word}
                    </span>
                  );
                })}
              </div>
            );
          })()}
        </div>
      </div>

      {/* ── Section chips (click to jump) ── */}
      <div className="flex flex-wrap gap-1.5">
        {sectionMarkers.map((m, i) => {
          const isCurrent = activeSectionByTime === i || activeSectionIndex === i;
          return (
            <button
              key={i}
              onClick={() => { onSectionClick(i); onSeek(m.ratio); }}
              className={`px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wider transition-colors ${
                isCurrent
                  ? 'bg-[#f37321] text-white'
                  : 'bg-[#f6f6f6] text-[#929292] hover:bg-[#e9e9e9] hover:text-[#3b3b3b]'
              }`}
            >
              {m.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
