'use client';

import { useEffect, useRef, useState } from 'react';
import { detectBeatPhaseMs } from '@/lib/audio/beatDetect';

interface SectionMarker {
  ratio: number; // 0–1 position in the audio
  label: string;
}

interface Props {
  audioUrl: string;
  progress: number; // 0–100
  onSeek: (ratio: number) => void;
  sectionMarkers?: SectionMarker[];
  activeSectionIndex?: number | null;
  onSectionClick?: (index: number) => void;
  onDurationReady?: (ms: number) => void;
  onBeatPhaseReady?: (phaseMs: number) => void;
  tempo?: number;
  showLabels?: boolean; // default true; pass false when labels are rendered externally
}

const PEAK_COUNT = 800;

export default function Waveform({ audioUrl, progress, onSeek, sectionMarkers = [], activeSectionIndex, onSectionClick, onDurationReady, onBeatPhaseReady, tempo, showLabels = true }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loading, setLoading] = useState(true);
  const peaksRef = useRef<number[]>([]);

  // Decode audio and compute PEAK_COUNT peak amplitudes
  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    async function decode() {
      try {
        const ctx = new AudioContext();
        const res = await fetch(audioUrl);
        const arrayBuf = await res.arrayBuffer();
        const audioBuf = await ctx.decodeAudioData(arrayBuf);
        await ctx.close();

        if (cancelled) return;

        const data = audioBuf.getChannelData(0);
        const blockSize = Math.floor(data.length / PEAK_COUNT);
        const peaks: number[] = [];

        for (let i = 0; i < PEAK_COUNT; i++) {
          let max = 0;
          for (let j = 0; j < blockSize; j++) {
            const v = Math.abs(data[i * blockSize + j]);
            if (v > max) max = v;
          }
          peaks.push(max);
        }

        peaksRef.current = peaks;
        onDurationReady?.(audioBuf.duration * 1000);
        if (tempo && onBeatPhaseReady) {
          onBeatPhaseReady(detectBeatPhaseMs(audioBuf, tempo));
        }
        setLoading(false);
      } catch {
        setLoading(false);
      }
    }

    decode();
    return () => { cancelled = true; };
  }, [audioUrl, onDurationReady]);

  // Redraw at device-pixel-ratio resolution whenever state changes
  useEffect(() => {
    const canvas = canvasRef.current;
    const peaks = peaksRef.current;
    if (!canvas || peaks.length === 0) return;

    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;

    // Resize physical pixels to match DPR — only when dimensions actually change
    const physW = Math.round(cssW * dpr);
    const physH = Math.round(cssH * dpr);
    if (canvas.width !== physW || canvas.height !== physH) {
      canvas.width  = physW;
      canvas.height = physH;
    }

    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // scale to CSS pixel space
    const w = cssW;
    const h = cssH;
    const mid = h / 2;

    ctx.clearRect(0, 0, w, h);

    const playedX = (progress / 100) * w;

    // Active section background highlight
    if (activeSectionIndex != null && sectionMarkers.length > 0) {
      const startRatio = sectionMarkers[activeSectionIndex]?.ratio ?? 0;
      const endRatio   = sectionMarkers[activeSectionIndex + 1]?.ratio ?? 1;
      ctx.fillStyle = 'rgba(243, 115, 33, 0.12)';
      ctx.fillRect(startRatio * w, 0, (endRatio - startRatio) * w, h);
    }

    // Waveform bars — sub-pixel bar width for smooth scaling at any zoom
    const barW = Math.max(1, w / peaks.length);
    for (let i = 0; i < peaks.length; i++) {
      const x    = (i / peaks.length) * w;
      const barH = Math.max(1, peaks[i] * h * 0.9);
      ctx.fillStyle = x < playedX ? '#f37321' : '#d4d4d4';
      ctx.fillRect(x, mid - barH / 2, barW - 0.5, barH);
    }

    // Section divider lines
    sectionMarkers.forEach((marker, i) => {
      if (i === 0) return;
      const x = marker.ratio * w;
      ctx.strokeStyle = '#f37321';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.setLineDash([]);
    });

    // Playhead
    ctx.fillStyle = '#f37321';
    ctx.fillRect(Math.min(playedX, w - 1), 0, 1.5, h);
  }, [progress, loading, sectionMarkers, activeSectionIndex]);

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    onSeek((e.clientX - rect.left) / rect.width);
  };

  return (
    <div className="relative w-full flex flex-col gap-1">
      {/* Section labels — clickable, highlight active */}
      {showLabels && !loading && sectionMarkers.length > 0 && (
        <div className="relative w-full h-4">
          {sectionMarkers.map((marker, i) => (
            <button
              key={i}
              onClick={() => { onSeek(marker.ratio); onSectionClick?.(i); }}
              style={{ left: `${marker.ratio * 100}%` }}
              className={`absolute text-[10px] font-bold uppercase tracking-wide transition-colors whitespace-nowrap ${
                i === 0 ? 'translate-x-0' : '-translate-x-1/2'
              } ${
                activeSectionIndex === i ? 'text-[#da6520]' : 'text-[#f37321] hover:text-[#da6520]'
              }`}
            >
              {marker.label}
            </button>
          ))}
        </div>
      )}

      {/* Waveform canvas */}
      <div className="relative w-full h-16">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-[#929292]">
            Loading waveform…
          </div>
        )}
        <canvas
          ref={canvasRef}
          onClick={handleClick}
          className="w-full h-full cursor-pointer"
          style={{ opacity: loading ? 0 : 1, transition: 'opacity 0.3s' }}
        />
      </div>
    </div>
  );
}
