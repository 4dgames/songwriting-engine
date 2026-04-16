'use client';

import { useEffect, useRef } from 'react';

const BUCKET_COUNT = 400; // resolution of the live waveform

interface Props {
  stream: MediaStream;
  /** Current instrumental playback progress 0–100 — used to place amplitude samples on the timeline. */
  progress: number;
}

/**
 * Draws a live mic-input waveform that grows left-to-right in sync with
 * the instrumental's playback progress. Uses a Web Audio AnalyserNode to
 * sample amplitude every animation frame and maps each sample to the
 * progress bucket that corresponds to the current playback position.
 */
export default function LiveRecordingWaveform({ stream, progress }: Props) {
  const canvasRef   = useRef<HTMLCanvasElement>(null);
  const bucketsRef  = useRef<Float32Array>(new Float32Array(BUCKET_COUNT));
  const progressRef = useRef(progress);

  // Keep progressRef current without restarting the AudioContext
  useEffect(() => { progressRef.current = progress; }, [progress]);

  useEffect(() => {
    const audioCtx = new AudioContext();
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    const source = audioCtx.createMediaStreamSource(stream);
    source.connect(analyser);
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    let raf: number;

    const tick = () => {
      analyser.getByteTimeDomainData(dataArray);

      // RMS amplitude of this frame
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const v = (dataArray[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / dataArray.length);

      // Write into the bucket that corresponds to the current progress
      const p = progressRef.current;
      const bucket = Math.min(BUCKET_COUNT - 1, Math.floor((p / 100) * BUCKET_COUNT));
      bucketsRef.current[bucket] = Math.max(bucketsRef.current[bucket], rms);

      // Redraw canvas
      const canvas = canvasRef.current;
      if (canvas) {
        const dpr  = window.devicePixelRatio || 1;
        const cssW = canvas.clientWidth;
        const cssH = canvas.clientHeight;
        const physW = Math.round(cssW * dpr);
        const physH = Math.round(cssH * dpr);
        if (canvas.width !== physW || canvas.height !== physH) {
          canvas.width  = physW;
          canvas.height = physH;
        }

        const ctx = canvas.getContext('2d')!;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssW, cssH);

        const mid      = cssH / 2;
        const playedX  = (p / 100) * cssW;
        const barW     = cssW / BUCKET_COUNT;
        const barFill  = Math.max(barW * 0.72, 1);
        const buckets  = bucketsRef.current;

        for (let i = 0; i < BUCKET_COUNT; i++) {
          if (buckets[i] < 0.002) continue;
          const x    = (i / BUCKET_COUNT) * cssW;
          const barH = Math.max(2, buckets[i] * cssH * 0.9);
          ctx.fillStyle = x < playedX ? '#f37321' : '#d4d4d4';
          ctx.fillRect(x, mid - barH / 2, barFill, barH);
        }

        // Playhead
        ctx.fillStyle = '#f37321';
        ctx.fillRect(Math.min(playedX, cssW - 1), 0, 1.5, cssH);
      }

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      source.disconnect();
      void audioCtx.close();
    };
  }, [stream]); // only recreate when the stream instance changes

  return (
    <div className="relative w-full h-24">
      {/* Recording indicator overlay */}
      <div className="absolute top-1 left-2 flex items-center gap-1.5 pointer-events-none z-10">
        <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse flex-shrink-0" />
        <span className="text-[10px] font-semibold text-red-500 uppercase tracking-wide">Recording</span>
      </div>
      <canvas ref={canvasRef} className="w-full h-full" />
    </div>
  );
}
