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

// ── Full-song waveform canvas ────────────────────────────────────────────────

interface WaveformCanvasProps {
  peaks: number[];
  currentRatio: number;       // 0–1 playhead position within full song
  zoom: number;
  sectionMarkers: SectionMarker[];
  onSeek: (ratio: number) => void;
}

function WaveformCanvas({ peaks, currentRatio, zoom, sectionMarkers, onSeek }: WaveformCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const resolution = Math.round(1600 * Math.max(1, zoom));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const { width: w, height: h } = canvas;
    const mid = h / 2;
    ctx.clearRect(0, 0, w, h);

    // Draw alternating section backgrounds
    sectionMarkers.forEach((m, i) => {
      const endRatio = sectionMarkers[i + 1]?.ratio ?? 1;
      const x0 = Math.floor(m.ratio * w);
      const x1 = Math.ceil(endRatio * w);
      ctx.fillStyle = i % 2 === 0 ? '#f9f9f9' : '#f0f0f0';
      ctx.fillRect(x0, 0, x1 - x0, h);
    });

    // Draw waveform bars
    if (peaks.length > 0) {
      const playedX = Math.max(0, Math.min(w, Math.round(currentRatio * w)));
      for (let i = 0; i < w; i++) {
        const idx  = Math.floor((i / w) * peaks.length);
        const barH = Math.max(2, (peaks[idx] ?? 0) * h * 0.88);
        ctx.fillStyle = i < playedX ? '#f37321' : '#c8c8c8';
        ctx.fillRect(i, mid - barH / 2, 1, barH);
      }
      // Playhead
      ctx.fillStyle = '#f37321';
      ctx.fillRect(Math.min(Math.round(currentRatio * w), w - 2), 0, 2, h);
    } else {
      ctx.fillStyle = '#e9e9e9';
      ctx.fillRect(0, mid - 1, w, 2);
    }

    // Section divider lines
    sectionMarkers.forEach(m => {
      if (m.ratio === 0) return;
      const x = Math.round(m.ratio * w);
      ctx.fillStyle = '#bdbdbd';
      ctx.fillRect(x, 0, 1, h);
    });
  }, [peaks, currentRatio, zoom, sectionMarkers]);

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    onSeek((e.clientX - rect.left) / rect.width);
  };

  return (
    <canvas
      ref={canvasRef}
      width={resolution}
      height={128}
      className="w-full cursor-crosshair"
      style={{ height: 128, display: 'block' }}
      onClick={handleClick}
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
  const [zoom, setZoom] = useState(3);

  const scrollRef = useRef<HTMLDivElement>(null);

  // Current playback ratio (0–1 of full song)
  const currentRatio = audioDurationMs > 0 ? currentTimeMs / audioDurationMs : 0;

  // Auto-scroll to keep playhead centred when zoomed
  useEffect(() => {
    if (zoom <= 1 || !scrollRef.current) return;
    const el = scrollRef.current;
    const totalW = el.scrollWidth;
    const viewW  = el.clientWidth;
    const playheadX = currentRatio * totalW;
    el.scrollLeft = Math.max(0, Math.min(playheadX - viewW / 2, totalW - viewW));
  }, [currentRatio, zoom]);

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
          onClick={() => setZoom(z => Math.max(1, parseFloat((z - 0.5).toFixed(1))))}
          disabled={zoom <= 1}
          className="w-6 h-6 flex items-center justify-center rounded border border-[#e9e9e9] bg-white text-[#676767] hover:border-[#bdbdbd] hover:text-[#3b3b3b] disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-sm font-bold leading-none"
          title="Zoom out"
        >
          −
        </button>
        <span className="text-xs text-[#3b3b3b] w-8 text-center tabular-nums">{zoom}×</span>
        <button
          onClick={() => setZoom(z => Math.min(8, parseFloat((z + 0.5).toFixed(1))))}
          disabled={zoom >= 8}
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
            currentRatio={currentRatio}
            zoom={zoom}
            sectionMarkers={sectionMarkers}
            onSeek={onSeek}
          />

          {/* Lyrics track — words appear at their time position */}
          {wordTimestamps.length > 0 && audioDurationMs > 0 && (
            <div
              className="relative select-none overflow-hidden"
              style={{ height: 22 }}
            >
              {wordTimestamps.map((w, wi) => {
                const leftPct  = (w.start_ms / audioDurationMs) * 100;
                const isSung   = currentTimeMs > w.end_ms;
                const isSinging = currentTimeMs >= w.start_ms && currentTimeMs <= w.end_ms;
                const isVisible = isSinging || isSung;
                return (
                  <span
                    key={wi}
                    style={{ left: `${Math.min(99, leftPct)}%`, fontSize: 10 }}
                    onClick={e => { e.stopPropagation(); onSeek(w.start_ms / audioDurationMs); }}
                    className={`absolute whitespace-nowrap cursor-pointer leading-none transition-all duration-75 ${
                      !isVisible
                        ? 'opacity-0'
                        : isSinging
                        ? 'text-[#f37321] font-bold opacity-100'
                        : 'text-[#bdbdbd] opacity-100'
                    }`}
                  >
                    {w.word}
                  </span>
                );
              })}
            </div>
          )}
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
