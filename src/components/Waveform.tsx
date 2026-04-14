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

export default function Waveform({ audioUrl, progress, onSeek, sectionMarkers = [], activeSectionIndex, onSectionClick, onDurationReady, onBeatPhaseReady, tempo, showLabels = true }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loading, setLoading] = useState(true);
  const peaksRef = useRef<number[]>([]);

  // Decode audio and compute per-pixel peak amplitudes
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

        const canvas = canvasRef.current;
        if (!canvas) return;

        const width = canvas.width;
        const data = audioBuf.getChannelData(0);
        const blockSize = Math.floor(data.length / width);
        const peaks: number[] = [];

        for (let i = 0; i < width; i++) {
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

  // Redraw whenever peaks, progress, section markers, or active section change
  useEffect(() => {
    const canvas = canvasRef.current;
    const peaks = peaksRef.current;
    if (!canvas || peaks.length === 0) return;

    const ctx = canvas.getContext('2d')!;
    const { width, height } = canvas;
    const mid = height / 2;
    const playedX = Math.floor((progress / 100) * width);

    ctx.clearRect(0, 0, width, height);

    // Active section background highlight
    if (activeSectionIndex != null && sectionMarkers.length > 0) {
      const startRatio = sectionMarkers[activeSectionIndex]?.ratio ?? 0;
      const endRatio = sectionMarkers[activeSectionIndex + 1]?.ratio ?? 1;
      const startX = Math.floor(startRatio * width);
      const endX = Math.floor(endRatio * width);
      ctx.fillStyle = 'rgba(243, 115, 33, 0.12)'; // Amplify orange at 12%
      ctx.fillRect(startX, 0, endX - startX, height);
    }

    // Waveform bars
    for (let i = 0; i < peaks.length; i++) {
      const barH = Math.max(2, peaks[i] * height * 0.9);
      ctx.fillStyle = i < playedX ? '#f37321' : '#d4d4d4'; // Amplify orange : light gray
      ctx.fillRect(i, mid - barH / 2, 1, barH);
    }

    // Section divider lines (skip first — nothing to divide before it)
    sectionMarkers.forEach((marker, i) => {
      if (i === 0) return;
      const x = Math.floor(marker.ratio * width);
      ctx.strokeStyle = '#f37321'; // Amplify orange
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
      ctx.setLineDash([]);
    });

    // Playhead
    ctx.fillStyle = '#f37321'; // Amplify orange
    ctx.fillRect(playedX, 0, 2, height);
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
          width={800}
          height={64}
          onClick={handleClick}
          className="w-full h-full cursor-pointer"
          style={{ opacity: loading ? 0 : 1, transition: 'opacity 0.3s' }}
        />
      </div>
    </div>
  );
}
