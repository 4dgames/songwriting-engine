'use client';

/**
 * TimelineEditor — drag-to-offset tracks, rubber-band region select, cut/move segments.
 *
 * Tracks are passed in and rendered as waveforms on a zoomable canvas.
 * "Apply" bakes all offsets and region operations into new blob URLs via Web Audio API.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { encodeWav } from '@/lib/audio/mix';
import type { WordTimestamp } from '@/lib/types';

// ── Layout ──────────────────────────────────────────────────────────────────
const LABEL_W  = 140;
const HEADER_H = 30;
const TRACK_H  = 228;
const PEAKS    = 2000;
const MIN_ZOOM = 8;
const MAX_ZOOM = 1000;

// ── Types ────────────────────────────────────────────────────────────────────
export interface TimelineTrack {
  id:    string;
  label: string;
  url:   string;
  color: string; // hex
  wordTimestamps?: WordTimestamp[];
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
  /** silence = cut-in-place (no paste); move = cut + paste; copy = keep original + paste; cut = remove + close gap; trim = keep only selection */
  opType:   'silence' | 'move' | 'copy' | 'cut' | 'trim' | null;
}

export interface Props {
  tracks:  TimelineTrack[];
  onApply: (updated: { id: string; url: string; timestamps?: WordTimestamp[] }[]) => void;
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

// ── Timestamp adjustment helpers ──────────────────────────────────────────────
function adjustTimestampsForCut(ts: WordTimestamp[], cutStartMs: number, cutEndMs: number): WordTimestamp[] {
  const regLenMs = cutEndMs - cutStartMs;
  return ts.flatMap(w => {
    if (w.end_ms <= cutStartMs)  return [w]; // before cut — unchanged
    if (w.start_ms >= cutEndMs)  return [{ ...w, start_ms: w.start_ms - regLenMs, end_ms: w.end_ms - regLenMs }]; // after — shift left
    if (w.start_ms < cutStartMs) return [{ ...w, end_ms: cutStartMs }]; // overlaps start — trim end
    if (w.end_ms   > cutEndMs)   return [{ ...w, start_ms: cutStartMs, end_ms: w.end_ms - regLenMs }]; // overlaps end — trim start + shift
    return []; // fully inside cut — drop
  });
}

function adjustTimestampsForTrim(ts: WordTimestamp[], trimStartMs: number, trimEndMs: number): WordTimestamp[] {
  return ts.flatMap(w => {
    if (w.end_ms <= trimStartMs || w.start_ms >= trimEndMs) return []; // outside trim window — drop
    return [{
      ...w,
      start_ms: Math.max(0, w.start_ms - trimStartMs),
      end_ms:   Math.min(trimEndMs - trimStartMs, w.end_ms - trimStartMs),
    }];
  });
}

function adjustTimestampsForMove(
  ts: WordTimestamp[],
  cutStartMs: number, cutEndMs: number,
  adjDestMs:  number,
): WordTimestamp[] {
  const regLenMs = cutEndMs - cutStartMs;
  // Pass 1: close the source gap (same logic as cut), tracking moved words' offset
  const movedWords:   WordTimestamp[] = [];
  const afterGap:     WordTimestamp[] = [];
  for (const w of ts) {
    if (w.end_ms <= cutStartMs) {
      afterGap.push(w);
    } else if (w.start_ms >= cutEndMs) {
      afterGap.push({ ...w, start_ms: w.start_ms - regLenMs, end_ms: w.end_ms - regLenMs });
    } else if (w.start_ms >= cutStartMs && w.end_ms <= cutEndMs) {
      movedWords.push({ ...w, start_ms: w.start_ms - cutStartMs, end_ms: w.end_ms - cutStartMs }); // offset relative to region start
    } else if (w.start_ms < cutStartMs) {
      afterGap.push({ ...w, end_ms: cutStartMs });
    } else {
      afterGap.push({ ...w, start_ms: cutStartMs, end_ms: w.end_ms - regLenMs });
    }
  }
  // Pass 2: insert moved words at adjDest, shifting everything at/after adjDest right
  const result: WordTimestamp[] = afterGap.map(w =>
    w.start_ms >= adjDestMs
      ? { ...w, start_ms: w.start_ms + regLenMs, end_ms: w.end_ms + regLenMs }
      : w
  );
  for (const w of movedWords) {
    result.push({ ...w, start_ms: adjDestMs + w.start_ms, end_ms: adjDestMs + w.end_ms });
  }
  return result.sort((a, b) => a.start_ms - b.start_ms);
}

function adjustTimestampsForCopy(
  ts: WordTimestamp[],
  cutStartMs: number, cutEndMs: number,
  destMs:     number,
): WordTimestamp[] {
  const copies = ts
    .filter(w => w.start_ms >= cutStartMs && w.end_ms <= cutEndMs)
    .map(w => ({
      ...w,
      start_ms: destMs + (w.start_ms - cutStartMs),
      end_ms:   destMs + (w.end_ms   - cutStartMs),
    }));
  return [...ts, ...copies].sort((a, b) => a.start_ms - b.start_ms);
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

      // region overlay — only shown while still selecting (opType not yet committed)
      if (reg && reg.trackId === track.id && reg.opType === null) {
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

  // ── Immediate operation execution ─────────────────────────────────────────
  const applyRegionOp = async (reg: Region) => {
    const dec = decoded.get(reg.trackId);
    if (!dec || !reg.opType) return;
    setApplying(true);
    try {
      const sr   = dec.buffer.sampleRate;
      const numCh = dec.buffer.numberOfChannels;
      const off  = offsetsRef.current.get(reg.trackId) ?? 0;
      const offSamples = Math.floor(off * sr);
      const fullOutLen = Math.ceil((off + dec.durationSec) * sr);

      const cutStart = Math.floor(reg.startSec * sr);
      const cutEnd   = Math.min(Math.floor(reg.endSec * sr), fullOutLen);
      const regLen   = Math.max(0, cutEnd - cutStart);

      // Build working buffer at full length (with offset baked in)
      const chans = Array.from({ length: numCh }, () => new Float32Array(fullOutLen));
      for (let ch = 0; ch < numCh; ch++) {
        const src = dec.buffer.getChannelData(ch);
        for (let i = 0; i < src.length; i++) {
          const j = i + offSamples;
          if (j < fullOutLen) chans[ch][j] = src[i];
        }
      }

      // Extract segment before modifying
      const segment = Array.from({ length: numCh }, (_, ch) => {
        const s = new Float32Array(regLen);
        for (let i = 0; i < regLen; i++) s[i] = chans[ch][cutStart + i] ?? 0;
        return s;
      });

      // Will be set inside the move block for timestamp computation
      let adjDestSamples = 0;

      if (reg.opType === 'silence') {
        for (let ch = 0; ch < numCh; ch++)
          for (let i = cutStart; i < cutEnd && i < fullOutLen; i++) chans[ch][i] = 0;

      } else if (reg.opType === 'copy' && reg.destSec !== null) {
        const destStart = Math.floor(reg.destSec * sr);
        for (let ch = 0; ch < numCh; ch++) {
          const seg = segment[ch];
          for (let i = 0; i < regLen; i++) {
            const j = destStart + i;
            if (j >= 0 && j < fullOutLen) chans[ch][j] = seg[i];
          }
        }

      } else if (reg.opType === 'move' && reg.destSec !== null) {
        const rawDest = Math.floor(reg.destSec * sr);
        for (let ch = 0; ch < numCh; ch++) {
          const dst = chans[ch];
          const tailLen = fullOutLen - cutEnd;
          for (let i = 0; i < tailLen; i++) dst[cutStart + i] = dst[cutEnd + i];
          for (let i = cutStart + tailLen; i < fullOutLen; i++) dst[i] = 0;
        }
        const adjDest = rawDest > cutEnd ? rawDest - regLen : rawDest > cutStart ? cutStart : rawDest;
        adjDestSamples = adjDest; // captured for timestamp computation below
        const clampedDest = Math.max(0, Math.min(fullOutLen - regLen, adjDest));
        for (let ch = 0; ch < numCh; ch++) {
          const dst = chans[ch];
          for (let i = fullOutLen - regLen - 1; i >= clampedDest; i--)
            if (i + regLen < fullOutLen) dst[i + regLen] = dst[i];
          const seg = segment[ch];
          for (let i = 0; i < regLen; i++) {
            const j = clampedDest + i;
            if (j >= 0 && j < fullOutLen) dst[j] = seg[i];
          }
        }

      } else if (reg.opType === 'cut') {
        const cutLen = Math.max(1, fullOutLen - regLen);
        for (let ch = 0; ch < numCh; ch++) {
          const cut = new Float32Array(cutLen);
          cut.set(chans[ch].subarray(0, cutStart));
          cut.set(chans[ch].subarray(cutEnd, fullOutLen), cutStart);
          chans[ch] = cut;
        }

      } else if (reg.opType === 'trim') {
        for (let ch = 0; ch < numCh; ch++) {
          const trimmed = new Float32Array(Math.max(1, regLen));
          for (let i = 0; i < trimmed.length; i++) trimmed[i] = chans[ch][cutStart + i] ?? 0;
          chans[ch] = trimmed;
        }
      }

      const finalLen = chans[0].length;
      const actx = new AudioContext();
      const finalBuf = actx.createBuffer(numCh, finalLen, sr);
      for (let ch = 0; ch < numCh; ch++) finalBuf.getChannelData(ch).set(chans[ch]);
      await actx.close();

      const url = encodeWav(finalBuf);

      // Recompute peaks for the updated buffer
      const peaks = new Float32Array(PEAKS);
      const step  = Math.max(1, finalBuf.length / PEAKS);
      for (let b = 0; b < PEAKS; b++) {
        let maxAbs = 0;
        const s = Math.floor(b * step);
        const e = Math.min(finalBuf.length, Math.floor((b + 1) * step));
        for (let ch = 0; ch < numCh; ch++) {
          const d = finalBuf.getChannelData(ch);
          for (let i = s; i < e; i++) if (Math.abs(d[i]) > maxAbs) maxAbs = Math.abs(d[i]);
        }
        peaks[b] = maxAbs;
      }

      // ── Compute updated word timestamps ──────────────────────────────────────
      const srcTrack = tracks.find(t => t.id === reg.trackId);
      const origTs   = srcTrack?.wordTimestamps;
      let updatedTimestamps: WordTimestamp[] | undefined;
      if (origTs && origTs.length > 0) {
        const offMs = off * 1000;
        // Shift timestamps to chans-space (accounts for baked-in offset leading silence)
        const tsInChans: WordTimestamp[] = offMs > 0
          ? origTs.map(w => ({ ...w, start_ms: w.start_ms + offMs, end_ms: w.end_ms + offMs }))
          : origTs;
        const cutStartMs = cutStart / sr * 1000;
        const cutEndMs   = cutEnd   / sr * 1000;
        switch (reg.opType) {
          case 'cut':
            updatedTimestamps = adjustTimestampsForCut(tsInChans, cutStartMs, cutEndMs);
            break;
          case 'trim':
            updatedTimestamps = adjustTimestampsForTrim(tsInChans, cutStartMs, cutEndMs);
            break;
          case 'move': {
            const adjDestMs = adjDestSamples / sr * 1000;
            updatedTimestamps = adjustTimestampsForMove(tsInChans, cutStartMs, cutEndMs, adjDestMs);
            break;
          }
          case 'copy': {
            const destMs = reg.destSec !== null ? Math.floor(reg.destSec * sr) / sr * 1000 : 0;
            updatedTimestamps = adjustTimestampsForCopy(tsInChans, cutStartMs, cutEndMs, destMs);
            break;
          }
          default: // silence — timestamps stay in chans-space (offset corrected)
            updatedTimestamps = tsInChans;
        }
      }

      // Reset offset (now baked in), clear region, update decoded, notify parent
      offsetsRef.current.set(reg.trackId, 0);
      regionRef.current = null;
      setDecoded(prev => {
        const next = new Map(prev);
        next.set(reg.trackId, { id: reg.trackId, peaks, durationSec: finalBuf.duration, buffer: finalBuf });
        return next;
      });
      onApply([{ id: reg.trackId, url, timestamps: updatedTimestamps }]);
    } finally {
      setApplying(false);
    }
  };

  // ── Region operations — each executes immediately ─────────────────────────
  const silenceRegion = () => {
    if (!regionRef.current) return;
    const reg = { ...regionRef.current, destSec: regionRef.current.startSec, opType: 'silence' as const };
    setHasRegion(false); setRegionHasDest(false);
    void applyRegionOp(reg);
  };

  const commitMove = () => {
    if (!regionRef.current || regionRef.current.destSec === null) return;
    const reg = { ...regionRef.current, opType: 'move' as const };
    setHasRegion(false); setRegionHasDest(false);
    void applyRegionOp(reg);
  };

  const commitCopy = () => {
    if (!regionRef.current || regionRef.current.destSec === null) return;
    const reg = { ...regionRef.current, opType: 'copy' as const };
    setHasRegion(false); setRegionHasDest(false);
    void applyRegionOp(reg);
  };

  const commitCut = () => {
    if (!regionRef.current) return;
    const reg = { ...regionRef.current, opType: 'cut' as const };
    setHasRegion(false); setRegionHasDest(false);
    void applyRegionOp(reg);
  };

  const commitTrim = () => {
    if (!regionRef.current) return;
    const reg = { ...regionRef.current, opType: 'trim' as const };
    setHasRegion(false); setRegionHasDest(false);
    void applyRegionOp(reg);
  };

  const clearRegion = () => {
    regionRef.current = null;
    setHasRegion(false);
    setRegionHasDest(false);
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(draw);
  };

  // ── Close — bakes any pending track offsets before closing ────────────────
  const handleClose = async () => {
    const pending = tracks.filter(t => (offsetsRef.current.get(t.id) ?? 0) !== 0);
    if (pending.length === 0) { onClose(); return; }
    setApplying(true);
    try {
      let maxEnd = 0;
      for (const t of tracks) {
        const dec = decoded.get(t.id);
        const off = offsetsRef.current.get(t.id) ?? 0;
        if (dec) maxEnd = Math.max(maxEnd, off + dec.durationSec);
      }
      const results: { id: string; url: string; timestamps?: WordTimestamp[] }[] = [];
      for (const track of tracks) {
        const dec = decoded.get(track.id);
        const off = offsetsRef.current.get(track.id) ?? 0;
        if (!dec || off === 0) { results.push({ id: track.id, url: track.url }); continue; }
        const sr = dec.buffer.sampleRate, numCh = dec.buffer.numberOfChannels;
        const outLen = Math.ceil(maxEnd * sr);
        const actx = new AudioContext();
        const outBuf = actx.createBuffer(numCh, outLen, sr);
        const offSamples = Math.floor(off * sr);
        for (let ch = 0; ch < numCh; ch++) {
          const src = dec.buffer.getChannelData(ch);
          const dst = outBuf.getChannelData(ch);
          for (let i = 0; i < src.length; i++) { const j = i + offSamples; if (j < outLen) dst[j] = src[i]; }
        }
        await actx.close();
        const offMs = off * 1000;
        const shiftedTs = track.wordTimestamps
          ? track.wordTimestamps.map(w => ({ ...w, start_ms: w.start_ms + offMs, end_ms: w.end_ms + offMs }))
          : undefined;
        results.push({ id: track.id, url: encodeWav(outBuf), timestamps: shiftedTs });
      }
      onApply(results);
    } finally {
      setApplying(false);
      onClose();
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
              <button
                onClick={() => setTool('move')}
                className={`px-2.5 py-1.5 transition-colors ${
                  tool === 'move' ? 'bg-[#2a2a2a] text-white' : 'bg-transparent text-neutral-500 hover:text-white'
                }`}
                title="Hand: drag a track left/right to offset its start"
              >
                {/* Open hand / pan_tool icon */}
                <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M23 5.5V20c0 2.2-1.8 4-4 4h-7.3c-1.08 0-2.1-.43-2.85-1.19L1 14.83s1.26-1.23 1.3-1.25c.22-.19.49-.29.79-.29.22 0 .42.06.6.16L7 16V5.5C7 4.12 8.12 3 9.5 3S12 4.12 12 5.5V11h1V3.5C13 2.12 14.12 1 15.5 1S18 2.12 18 3.5V11h1V5.5C19 4.12 20.12 3 21.5 3S24 4.12 23 5.5z"/>
                </svg>
              </button>
              <button
                onClick={() => setTool('select')}
                className={`px-2.5 py-1.5 transition-colors border-l border-[#2a2a2a] ${
                  tool === 'select' ? 'bg-[#2a2a2a] text-white' : 'bg-transparent text-neutral-500 hover:text-white'
                }`}
                title="Cursor: click+drag to select a region; drag selected region to move it"
              >
                {/* Mouse cursor / arrow icon */}
                <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M4 2L4 18L7.5 14.5L10 20.5L12.5 19.5L10 13.5L15 13.5Z"/>
                </svg>
              </button>
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
                <button
                  onClick={commitCut}
                  className="px-3 py-1.5 text-xs bg-orange-950/60 text-orange-400 hover:bg-orange-900/60 border border-orange-900/50 rounded-md font-medium"
                  title="Cut: remove selected region and close the gap"
                >
                  Cut
                </button>
                <button
                  onClick={commitTrim}
                  className="px-3 py-1.5 text-xs bg-violet-950/60 text-violet-400 hover:bg-violet-900/60 border border-violet-900/50 rounded-md font-medium"
                  title="Trim: keep only the selected region"
                >
                  Trim
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
              onClick={handleClose}
              disabled={applying}
              className="px-3 py-1.5 text-xs bg-[#1e1e1e] hover:bg-[#2a2a2a] text-neutral-400 hover:text-white rounded-md font-medium"
            >
              {applying ? 'Applying…' : 'Close'}
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
