'use client';

/**
 * TimelineEditor — drag-to-offset tracks, rubber-band region select, cut/move segments.
 *
 * Tracks are passed in and rendered as waveforms on a zoomable canvas.
 * "Apply" bakes all offsets and region operations into new blob URLs via Web Audio API.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { encodeWav } from '@/lib/audio/mix';

// ── Layout ──────────────────────────────────────────────────────────────────
const LABEL_W  = 140;
const HEADER_H = 30;
const TRACK_H  = 76;
const PEAKS    = 2000;
const MIN_ZOOM = 8;
const MAX_ZOOM = 1000;

// ── Types ────────────────────────────────────────────────────────────────────
export interface TimelineTrack {
  id:    string;
  label: string;
  url:   string;
  color: string; // hex
}

interface DecodedTrack {
  id:          string;
  peaks:       Float32Array;
  durationSec: number;
  buffer:      AudioBuffer;
}

interface Region {
  trackId:  string;
  startSec: number;
  endSec:   number;
  /** Non-null when the region has been dragged or a button was pressed */
  destSec:  number | null;
  /** silence = cut-in-place (no paste); move = cut + paste; copy = keep original + paste */
  opType:   'silence' | 'move' | 'copy' | null;
}

export interface Props {
  tracks:  TimelineTrack[];
  onApply: (updated: { id: string; url: string }[]) => void;
  onClose: () => void;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function niceInterval(totalSec: number, widthPx: number): number {
  const minPx = 60;
  const min   = totalSec / (widthPx / minPx);
  for (const c of [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300]) {
    if (c >= min) return c;
  }
  return 600;
}

function fmtSec(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m > 0) return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
  return `${s.toFixed(1)}s`;
}

// ── Component ────────────────────────────────────────────────────────────────
export default function TimelineEditor({ tracks, onApply, onClose }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef   = useRef<HTMLDivElement>(null);
  const rafRef    = useRef(0);

  // Live state stored in refs for use inside RAF / event handlers without stale closures
  const zoomRef    = useRef(80);   // px per second
  const scrollRef  = useRef(0);   // px scrolled left
  const offsetsRef = useRef<Map<string, number>>(new Map(tracks.map(t => [t.id, 0])));
  const regionRef  = useRef<Region | null>(null);
  const toolRef    = useRef<'move' | 'select'>('move');

  // React state (drives re-renders / UI labels)
  const [zoom,     setZoom]     = useState(80);
  const [tool,     setTool]     = useState<'move' | 'select'>('move');
  const [decoded,  setDecoded]  = useState<Map<string, DecodedTrack>>(new Map());
  const [loading,  setLoading]  = useState(true);
  const [applying,      setApplying]      = useState(false);
  const [hasRegion,     setHasRegion]     = useState(false);
  /** Mirrors region.destSec for toolbar rendering (ref changes don't trigger re-renders) */
  const [regionHasDest, setRegionHasDest] = useState(false);

  // keep refs in sync
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);
  useEffect(() => { toolRef.current = tool; }, [tool]);

  // ── Decode tracks ──────────────────────────────────────────────────────────
  useEffect(() => {
    setLoading(true);
    const result = new Map<string, DecodedTrack>();
    Promise.all(tracks.map(async (track) => {
      try {
        const audioCtx = new AudioContext();
        const ab  = await fetch(track.url).then(r => r.arrayBuffer());
        const buf = await audioCtx.decodeAudioData(ab);
        await audioCtx.close();

        const peaks = new Float32Array(PEAKS);
        const step  = buf.length / PEAKS;
        for (let b = 0; b < PEAKS; b++) {
          let maxAbs = 0;
          const s = Math.floor(b * step);
          const e = Math.floor((b + 1) * step);
          for (let ch = 0; ch < buf.numberOfChannels; ch++) {
            const d = buf.getChannelData(ch);
            for (let i = s; i < e; i++) if (Math.abs(d[i]) > maxAbs) maxAbs = Math.abs(d[i]);
          }
          peaks[b] = maxAbs;
        }
        result.set(track.id, { id: track.id, peaks, durationSec: buf.duration, buffer: buf });
      } catch (e) {
        console.warn('TimelineEditor: failed to decode', track.id, e);
      }
    })).then(() => { setDecoded(result); setLoading(false); });
  }, [tracks]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Draw ────────────────────────────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr  = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (cssW === 0 || cssH === 0) return;

    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width  = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    }

    const ctx  = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const zoom   = zoomRef.current;
    const scroll = scrollRef.current;
    const timeW  = cssW - LABEL_W;

    // background
    ctx.fillStyle = '#0c0c0c';
    ctx.fillRect(0, 0, cssW, cssH);

    // header bg
    ctx.fillStyle = '#181818';
    ctx.fillRect(LABEL_W, 0, timeW, HEADER_H);

    // time grid + labels
    const visibleSec = timeW / zoom;
    const startSec   = scroll / zoom;
    const interval   = niceInterval(visibleSec, timeW);
    const firstMark  = Math.ceil(startSec / interval) * interval;

    ctx.font        = '10px monospace';
    ctx.textAlign   = 'center';
    for (let t = firstMark; t < startSec + visibleSec + interval; t += interval) {
      const x = LABEL_W + t * zoom - scroll;
      if (x < LABEL_W || x > cssW) continue;
      ctx.fillStyle = '#1e1e1e';
      ctx.fillRect(x, HEADER_H, 1, cssH - HEADER_H);
      ctx.fillStyle = '#777';
      ctx.fillText(fmtSec(t), x, HEADER_H - 8);
    }

    // tracks
    tracks.forEach((track, i) => {
      const y   = HEADER_H + i * TRACK_H;
      const dec = decoded.get(track.id);
      const off = offsetsRef.current.get(track.id) ?? 0;
      const reg = regionRef.current;

      // row bg
      ctx.fillStyle = i % 2 === 0 ? '#111' : '#0e0e0e';
      ctx.fillRect(0, y, cssW, TRACK_H);

      // label area
      ctx.fillStyle = '#161616';
      ctx.fillRect(0, y, LABEL_W, TRACK_H);
      ctx.fillStyle = '#aaa';
      ctx.font      = '12px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(track.label, 8, y + TRACK_H / 2 + 5, LABEL_W - 16);

      if (!dec) {
        ctx.fillStyle = '#444';
        ctx.font      = '10px monospace';
        ctx.fillText('decoding…', LABEL_W + 8, y + TRACK_H / 2 + 5);
        return;
      }

      const tStartX = LABEL_W + off * zoom - scroll;
      const tWidth  = dec.durationSec * zoom;
      const clipL   = Math.max(LABEL_W, tStartX);
      const clipR   = Math.min(cssW, tStartX + tWidth);

      if (clipR > clipL) {
        // track fill
        ctx.fillStyle = track.color + '22';
        ctx.fillRect(clipL, y + 2, clipR - clipL, TRACK_H - 4);

        // waveform
        const mid   = y + TRACK_H / 2;
        const halfH = (TRACK_H - 18) / 2;
        ctx.fillStyle = track.color;
        // Pre-compute region bounds in pixel space for flattening
        const flatL = (reg && reg.trackId === track.id && reg.opType !== null && reg.opType !== 'copy')
          ? LABEL_W + reg.startSec * zoom - scroll : Infinity;
        const flatR = (reg && reg.trackId === track.id && reg.opType !== null && reg.opType !== 'copy')
          ? LABEL_W + reg.endSec   * zoom - scroll : -Infinity;
        for (let px = Math.floor(clipL); px < Math.ceil(clipR); px++) {
          const localPx  = px - tStartX;
          const pidx     = Math.min(PEAKS - 1, Math.floor((localPx / tWidth) * PEAKS));
          const rawAmp   = dec.peaks[pidx];
          // Flatten amplitude when this pixel falls in a committed (silenced / moved) region
          const amp      = (px >= flatL && px <= flatR) ? 0 : rawAmp;
          const barH     = Math.max(1, amp * halfH * 2);
          ctx.fillRect(px, mid - barH / 2, 1, barH);
        }
      }

      // region overlay
      if (reg && reg.trackId === track.id) {
        const rL = LABEL_W + reg.startSec * zoom - scroll;
        const rR = LABEL_W + reg.endSec   * zoom - scroll;
        const rcL = Math.max(LABEL_W, rL);
        const rcR = Math.min(cssW, rR);
        if (rcR > rcL) {
          ctx.fillStyle   = 'rgba(96,165,250,0.22)';
          ctx.fillRect(rcL, y + 2, rcR - rcL, TRACK_H - 4);
          ctx.strokeStyle = '#60a5fa';
          ctx.lineWidth   = 1.5;
          ctx.strokeRect(rcL, y + 2, rcR - rcL, TRACK_H - 4);
        }

        // ghost waveform at destination (for move and copy operations)
        if (reg.destSec !== null && reg.opType !== 'silence') {
          const regW   = rR - rL;
          const gL     = LABEL_W + reg.destSec * zoom - scroll;
          const gcL    = Math.max(LABEL_W, gL);
          const gcR    = Math.min(cssW, gL + regW);
          if (gcR > gcL) {
            // ghost fill
            ctx.fillStyle = 'rgba(96,165,250,0.1)';
            ctx.fillRect(gcL, y + 2, gcR - gcL, TRACK_H - 4);
            // ghost waveform (mirrors peaks from the original region position)
            ctx.fillStyle = '#60a5fa';
            const mid   = y + TRACK_H / 2;
            const halfH = (TRACK_H - 18) / 2;
            for (let px = Math.floor(gcL); px < Math.ceil(gcR); px++) {
              const fracInGhost = (px - gL) / regW;
              const origLocalPx = (reg.startSec * zoom) + fracInGhost * regW;
              const pidx = Math.min(PEAKS - 1, Math.floor((origLocalPx / tWidth) * PEAKS));
              const amp  = dec.peaks[pidx];
              const barH = Math.max(1, amp * halfH * 2);
              ctx.fillRect(px, mid - barH / 2, 1, barH);
            }
            // dashed border
            ctx.setLineDash([4, 4]);
            ctx.strokeStyle = '#60a5fa';
            ctx.lineWidth   = 1;
            ctx.strokeRect(gcL, y + 2, gcR - gcL, TRACK_H - 4);
            ctx.setLineDash([]);
          }
        }
      }
    });

    // label / timeline divider
    ctx.fillStyle = '#2a2a2a';
    ctx.fillRect(LABEL_W - 1, 0, 2, cssH);
  }, [tracks, decoded]);

  // schedule draw on state change
  useEffect(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [draw]);

  // ── Resize observer ────────────────────────────────────────────────────────
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(draw);
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [draw]);

  // ── Wheel ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const factor = e.deltaY < 0 ? 1.15 : 0.87;
        const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoomRef.current * factor));
        zoomRef.current = next;
        setZoom(next);
      } else {
        scrollRef.current = Math.max(0, scrollRef.current + e.deltaX + e.deltaY);
      }
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(draw);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [draw]);

  // ── Mouse ──────────────────────────────────────────────────────────────────
  const dragRef = useRef<{
    type:        'track-move' | 'region-draw' | 'region-drag';
    trackId:     string;
    startMouseX: number;
    startOffset?: number;     // track-move
    drawStart?:   number;     // region-draw: timeline sec at drag start
    regionDelta?: number;     // region-drag: mouseX - region.startSec in timeline coords
  } | null>(null);

  const pxToSec  = (px: number) => (px + scrollRef.current - LABEL_W) / zoomRef.current;
  const trackAt  = (y: number) => {
    const i = Math.floor((y - HEADER_H) / TRACK_H);
    return (i >= 0 && i < tracks.length) ? tracks[i] : null;
  };

  const onMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (x < LABEL_W || y < HEADER_H) return;

    const track = trackAt(y);
    if (!track) return;

    const sec = pxToSec(x);
    const reg = regionRef.current;

    if (toolRef.current === 'select') {
      // click inside existing region → drag it
      if (reg && reg.trackId === track.id && sec >= reg.startSec && sec <= reg.endSec) {
        dragRef.current = { type: 'region-drag', trackId: track.id, startMouseX: e.clientX, regionDelta: sec - reg.startSec };
      } else {
        // start rubber-band
        regionRef.current = { trackId: track.id, startSec: sec, endSec: sec, destSec: null, opType: null };
        setHasRegion(true);
        dragRef.current = { type: 'region-draw', trackId: track.id, startMouseX: e.clientX, drawStart: sec };
      }
    } else {
      // move tool: drag track offset
      dragRef.current = {
        type: 'track-move', trackId: track.id,
        startMouseX: e.clientX,
        startOffset: offsetsRef.current.get(track.id) ?? 0,
      };
    }
  }, [tracks]); // eslint-disable-line react-hooks/exhaustive-deps

  const onMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag) return;

    const rect = canvasRef.current!.getBoundingClientRect();
    const x    = e.clientX - rect.left;
    const sec  = pxToSec(x);

    if (drag.type === 'track-move') {
      const dx  = e.clientX - drag.startMouseX;
      const off = Math.max(0, (drag.startOffset ?? 0) + dx / zoomRef.current);
      offsetsRef.current.set(drag.trackId, off);
    } else if (drag.type === 'region-draw') {
      const s = drag.drawStart ?? sec;
      regionRef.current = {
        trackId:  drag.trackId,
        startSec: Math.max(0, Math.min(s, sec)),
        endSec:   Math.max(s, sec),
        destSec:  null,
        opType:   null,
      };
    } else if (drag.type === 'region-drag' && regionRef.current) {
      const newStart = Math.max(0, sec - (drag.regionDelta ?? 0));
      regionRef.current = { ...regionRef.current, destSec: newStart };
    }

    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(draw);
  }, [draw]); // eslint-disable-line react-hooks/exhaustive-deps

  const onMouseUp = useCallback(() => {
    dragRef.current = null;
    // Update toolbar state: did a region-drag just finish with a destination?
    setRegionHasDest(
      regionRef.current !== null &&
      regionRef.current.destSec !== null &&
      Math.abs(regionRef.current.destSec - regionRef.current.startSec) > 0.01
    );
  }, []);

  // cursor
  const onMouseMoveWithCursor = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    onMouseMove(e);
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x   = e.clientX - rect.left;
    const y   = e.clientY - rect.top;
    const sec = pxToSec(x);
    const reg = regionRef.current;
    const trk = trackAt(y);
    let cursor = 'default';
    if (x >= LABEL_W && y >= HEADER_H) {
      if (toolRef.current === 'select') {
        if (reg && trk?.id === reg.trackId && sec >= reg.startSec && sec <= reg.endSec) {
          cursor = dragRef.current ? 'grabbing' : 'grab';
        } else {
          cursor = 'crosshair';
        }
      } else {
        cursor = dragRef.current ? 'ew-resize' : 'col-resize';
      }
    }
    if (canvasRef.current) canvasRef.current.style.cursor = cursor;
  }, [onMouseMove, tracks]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Zoom buttons ───────────────────────────────────────────────────────────
  const zoomBy = (factor: number) => {
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoomRef.current * factor));
    zoomRef.current = next;
    setZoom(next);
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(draw);
  };

  // ── Region operations ──────────────────────────────────────────────────────
  const silenceRegion = () => {
    if (!regionRef.current) return;
    regionRef.current = { ...regionRef.current, destSec: regionRef.current.startSec, opType: 'silence' };
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(draw);
  };

  const commitMove = () => {
    if (!regionRef.current || regionRef.current.destSec === null) return;
    regionRef.current = { ...regionRef.current, opType: 'move' };
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(draw);
  };

  const commitCopy = () => {
    if (!regionRef.current || regionRef.current.destSec === null) return;
    regionRef.current = { ...regionRef.current, opType: 'copy' };
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(draw);
  };

  const clearRegion = () => {
    regionRef.current = null;
    setHasRegion(false);
    setRegionHasDest(false);
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(draw);
  };

  // ── Apply ──────────────────────────────────────────────────────────────────
  const handleApply = async () => {
    setApplying(true);
    try {
      // Find total output length
      let maxEnd = 0;
      for (const track of tracks) {
        const dec = decoded.get(track.id);
        const off = offsetsRef.current.get(track.id) ?? 0;
        if (dec) maxEnd = Math.max(maxEnd, off + dec.durationSec);
      }

      const reg     = regionRef.current;
      const results: { id: string; url: string }[] = [];

      for (const track of tracks) {
        const dec = decoded.get(track.id);
        const off = offsetsRef.current.get(track.id) ?? 0;

        // Unchanged: no offset and no region op on this track
        const hasOffsetChange = off !== 0;
        const hasRegionOp     = reg?.trackId === track.id && reg.opType !== null;

        if (!dec || (!hasOffsetChange && !hasRegionOp)) {
          results.push({ id: track.id, url: track.url });
          continue;
        }

        const sr     = dec.buffer.sampleRate;
        const numCh  = dec.buffer.numberOfChannels;
        const outLen = Math.ceil(maxEnd * sr);
        const chans  = Array.from({ length: numCh }, () => new Float32Array(outLen));

        const offSamples = Math.floor(off * sr);

        // Copy source at offset
        for (let ch = 0; ch < numCh; ch++) {
          const src = dec.buffer.getChannelData(ch);
          const dst = chans[ch];
          for (let i = 0; i < src.length; i++) {
            const j = i + offSamples;
            if (j < outLen) dst[j] = src[i];
          }
        }

        // Apply region operation
        if (hasRegionOp && reg) {
          const cutStart  = Math.floor(reg.startSec * sr);
          const cutEnd    = Math.floor(reg.endSec   * sr);
          const regLen    = cutEnd - cutStart;

          // Extract the segment BEFORE modifying channels
          const segment = Array.from({ length: numCh }, (_, ch) => {
            const s = new Float32Array(regLen);
            const src = chans[ch];
            for (let i = 0; i < regLen; i++) s[i] = src[cutStart + i] ?? 0;
            return s;
          });

          if (reg.opType === 'silence') {
            // Zero out the original region in place
            for (let ch = 0; ch < numCh; ch++) {
              const dst = chans[ch];
              for (let i = cutStart; i < cutEnd && i < outLen; i++) dst[i] = 0;
            }
          } else if ((reg.opType === 'move' || reg.opType === 'copy') && reg.destSec !== null) {
            const destStart = Math.floor(reg.destSec * sr);
            // move: silence original; copy: leave original
            if (reg.opType === 'move') {
              for (let ch = 0; ch < numCh; ch++) {
                const dst = chans[ch];
                for (let i = cutStart; i < cutEnd && i < outLen; i++) dst[i] = 0;
              }
            }
            // paste at destination
            for (let ch = 0; ch < numCh; ch++) {
              const dst = chans[ch];
              const seg = segment[ch];
              for (let i = 0; i < regLen; i++) {
                const j = destStart + i;
                if (j >= 0 && j < outLen) dst[j] = seg[i];
              }
            }
          }
        }

        // Build AudioBuffer from raw Float32Arrays
        const actx    = new AudioContext();
        const finalBuf = actx.createBuffer(numCh, outLen, sr);
        for (let ch = 0; ch < numCh; ch++) finalBuf.getChannelData(ch).set(chans[ch]);
        await actx.close();

        results.push({ id: track.id, url: encodeWav(finalBuf) });
      }

      onApply(results);
    } finally {
      setApplying(false);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  const canvasH = HEADER_H + tracks.length * TRACK_H;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div
        className="bg-[#0f0f0f] border border-[#252525] rounded-xl shadow-2xl flex flex-col"
        style={{ width: 'min(1280px, 96vw)', maxHeight: '88vh' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#1e1e1e] flex-shrink-0">
          <h2 className="text-white font-semibold text-sm tracking-wide">Timeline Editor</h2>

          <div className="flex items-center gap-2">
            {/* Tool toggle */}
            <div className="flex rounded-md overflow-hidden border border-[#2a2a2a]">
              {(['move', 'select'] as const).map(t => (
                <button
                  key={t}
                  onClick={() => setTool(t)}
                  className={`px-3 py-1.5 text-xs font-medium transition-colors capitalize ${
                    tool === t ? 'bg-[#2a2a2a] text-white' : 'bg-transparent text-neutral-500 hover:text-white'
                  }`}
                  title={t === 'move' ? 'Drag a track left/right to offset its start' : 'Click+drag to select a region; drag selected region to move it'}
                >
                  {t === 'move' ? 'Move' : 'Select'}
                </button>
              ))}
            </div>

            {/* Zoom */}
            <div className="flex rounded-md overflow-hidden border border-[#2a2a2a]">
              <button onClick={() => zoomBy(0.7)} className="px-2.5 py-1.5 text-xs text-neutral-500 hover:text-white transition-colors">−</button>
              <span className="px-2.5 py-1.5 text-xs text-neutral-600 select-none border-x border-[#2a2a2a] min-w-[58px] text-center">{Math.round(zoom)}px/s</span>
              <button onClick={() => zoomBy(1.4)} className="px-2.5 py-1.5 text-xs text-neutral-500 hover:text-white transition-colors">+</button>
            </div>

            {/* Region actions */}
            {hasRegion && (
              <>
                <button
                  onClick={silenceRegion}
                  className="px-3 py-1.5 text-xs bg-red-950/60 text-red-400 hover:bg-red-900/60 border border-red-900/50 rounded-md font-medium"
                  title="Fill selected region with silence (waveform flattens immediately)"
                >
                  Silence
                </button>
                {regionHasDest && (
                  <>
                    <button
                      onClick={commitMove}
                      className="px-3 py-1.5 text-xs bg-blue-950/60 text-blue-400 hover:bg-blue-900/60 border border-blue-900/50 rounded-md font-medium"
                      title="Move selected region to the ghost position (original becomes silence)"
                    >
                      Move here
                    </button>
                    <button
                      onClick={commitCopy}
                      className="px-3 py-1.5 text-xs bg-green-950/60 text-green-400 hover:bg-green-900/60 border border-green-900/50 rounded-md font-medium"
                      title="Copy selected region to the ghost position (original stays)"
                    >
                      Copy here
                    </button>
                  </>
                )}
                <button
                  onClick={clearRegion}
                  className="px-3 py-1.5 text-xs bg-[#1e1e1e] text-neutral-400 hover:text-white border border-[#2a2a2a] rounded-md font-medium"
                >
                  Clear
                </button>
              </>
            )}

            <button
              onClick={handleApply}
              disabled={applying}
              className="px-4 py-1.5 text-xs bg-[#f37321] hover:bg-[#e06010] disabled:opacity-50 text-white rounded-md font-semibold"
            >
              {applying ? 'Applying…' : 'Apply'}
            </button>
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs bg-[#1e1e1e] hover:bg-[#2a2a2a] text-neutral-400 hover:text-white rounded-md font-medium"
            >
              Cancel
            </button>
          </div>
        </div>

        {/* Canvas */}
        <div className="relative flex-1 overflow-hidden" ref={wrapRef}>
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center text-neutral-600 text-sm pointer-events-none">
              Decoding audio…
            </div>
          )}
          <canvas
            ref={canvasRef}
            className="block w-full"
            style={{ height: canvasH }}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMoveWithCursor}
            onMouseUp={onMouseUp}
            onMouseLeave={onMouseUp}
          />
        </div>

        {/* Footer hints */}
        <div className="px-4 py-2 border-t border-[#181818] flex items-center gap-5 text-[10px] text-neutral-700 flex-shrink-0">
          <span>Scroll: wheel</span>
          <span>Zoom: Ctrl+wheel or ± buttons</span>
          <span>Move mode: drag track left/right to shift its start</span>
          <span>Select mode: drag to select a region; drag selection to reposition it</span>
        </div>
      </div>
    </div>
  );
}
