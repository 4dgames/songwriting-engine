'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SongSection, WordTimestamp } from '@/lib/types';
import { spliceSection, spliceVocals } from '@/lib/audio/splice';
import { snapSectionsToPhrases } from '@/lib/audio/beatDetect';
import LyricsDisplay from './LyricsDisplay';
import SheetMusicView from './SheetMusicView';
import Waveform from './Waveform';
import VolumeKnob from './VolumeKnob';

function normalizeLabel(label: string): string {
  return label.replace(/\bIntroduction\b/gi, 'Intro');
}

interface SectionRegeneration {
  sectionIndex: number;
  audioUrl: string;
  instrumentalUrl?: string;
  vocalsUrl?: string;
  wordTimestamps: WordTimestamp[];
  vocalsOnly?: boolean;
}

interface Props {
  audioUrl: string;
  vocalsUrl?: string;
  title: string;
  sections: SongSection[];
  wordTimestamps: WordTimestamp[];
  tempo: number;
  pendingRegeneration?: SectionRegeneration | null;
  onRegenerationComplete?: () => void;
  onSpliceComplete?: (instrumentalUrl: string, vocalsUrl: string | undefined, timestamps: WordTimestamp[]) => void;
  onActiveSectionChange?: (index: number | null) => void;
  onRegenerateVocals?: () => Promise<void>;
  onRegenerateInstrumental?: () => Promise<void>;
  regeneratingVocals?: boolean;
  regeneratingInstrumental?: boolean;
  onViewLayoutChange?: (layout: 'waveform' | 'sheet') => void;
  instrumentStems?: { drums: string; bass: string; other: string } | null;
  onSeparateInstruments?: () => void;
  separatingInstruments?: boolean;
  playTrigger?: number; // increment to programmatically start playback
}

export default function AudioPlayer({
  audioUrl, vocalsUrl, title, sections, wordTimestamps, tempo,
  pendingRegeneration, onRegenerationComplete, onSpliceComplete, onActiveSectionChange,
  onRegenerateVocals, onRegenerateInstrumental, regeneratingVocals, regeneratingInstrumental,
  onViewLayoutChange,
  instrumentStems, onSeparateInstruments, separatingInstruments,
  playTrigger,
}: Props) {
  const audioRef  = useRef<HTMLAudioElement>(null);
  const vocalsRef = useRef<HTMLAudioElement>(null);

  const [playing,      setPlaying]      = useState(false);
  const [instSolo,     setInstSolo]     = useState(false);
  const [vocalsSolo,   setVocalsSolo]   = useState(false);
  const [progress,     setProgress]     = useState(0);
  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const [audioDurationMs, setAudioDurationMs] = useState(0);
  const [beatPhaseMs,  setBeatPhaseMs]  = useState<number | null>(null);
  const [activeSectionIndex, setActiveSectionIndex] = useState<number | null>(null);
  const [splicing,     setSplicing]     = useState(false);
  const [instVolume,   setInstVolume]   = useState(0.75);
  const [vocalsVolume, setVocalsVolume] = useState(0.9);

  const [viewLayout,    setViewLayout]    = useState<'waveform' | 'sheet'>('waveform');
  const [peaks,         setPeaks]         = useState<number[]>([]);
  const [waveformZoom,  setWaveformZoom]  = useState(1);
  const waveformScrollRef = useRef<HTMLDivElement>(null);

  const [currentInstrumentalUrl, setCurrentInstrumentalUrl] = useState(audioUrl);
  const [currentVocalsUrl,       setCurrentVocalsUrl]       = useState(vocalsUrl ?? '');
  const [currentWordTimestamps,  setCurrentWordTimestamps]  = useState(wordTimestamps);

  const hasTwoTracks = !!vocalsUrl;

  // ── Refs ─────────────────────────────────────────────────────────────────────
  const sectionMarkersRef          = useRef<{ ratio: number; label: string }[]>([]);
  const audioDurationMsRef         = useRef(0);
  const currentInstrumentalUrlRef  = useRef(currentInstrumentalUrl);
  const currentVocalsUrlRef        = useRef(currentVocalsUrl);
  const currentWordTimestampsRef   = useRef(currentWordTimestamps);
  const lastNotifiedSectionRef     = useRef<number | null>(null);
  const instVolumeRef              = useRef(instVolume);
  const vocalsVolumeRef            = useRef(vocalsVolume);

  useEffect(() => { currentInstrumentalUrlRef.current = currentInstrumentalUrl; }, [currentInstrumentalUrl]);
  useEffect(() => { currentVocalsUrlRef.current       = currentVocalsUrl; },       [currentVocalsUrl]);
  useEffect(() => { currentWordTimestampsRef.current  = currentWordTimestamps; },  [currentWordTimestamps]);
  useEffect(() => { audioDurationMsRef.current        = audioDurationMs; },        [audioDurationMs]);
  useEffect(() => { instVolumeRef.current             = instVolume; },             [instVolume]);
  useEffect(() => { vocalsVolumeRef.current           = vocalsVolume; },           [vocalsVolume]);

  // Apply volume changes immediately to playing elements
  useEffect(() => { if (audioRef.current)  audioRef.current.volume  = instVolume;   }, [instVolume]);
  useEffect(() => { if (vocalsRef.current) vocalsRef.current.volume = vocalsVolume; }, [vocalsVolume]);

  const handleDurationReady  = useCallback((ms: number)    => setAudioDurationMs(ms), []);
  const handleBeatPhaseReady = useCallback((ms: number)    => setBeatPhaseMs(ms),     []);

  useEffect(() => { setBeatPhaseMs(null); }, [currentInstrumentalUrl]);

  // Notify parent when layout changes so it can expand/collapse the page container
  useEffect(() => { onViewLayoutChange?.(viewLayout); }, [viewLayout, onViewLayoutChange]);

  // Reset cached peaks whenever the track changes
  useEffect(() => { setPeaks([]); }, [currentInstrumentalUrl]);

  // Auto-scroll waveform to keep playhead centred when zoomed
  useEffect(() => {
    if (waveformZoom <= 1 || !waveformScrollRef.current) return;
    const el = waveformScrollRef.current;
    const totalW = el.scrollWidth;
    const viewW  = el.clientWidth;
    el.scrollLeft = Math.max(0, Math.min((progress / 100) * totalW - viewW / 2, totalW - viewW));
  }, [progress, waveformZoom]);

  // Programmatic play via playTrigger prop (e.g. from wizard "play my song")
  useEffect(() => {
    if (!playTrigger || !audioRef.current || playing) return;
    void toggle();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playTrigger]);

  // Decode high-resolution peaks when the user switches to sheet layout
  useEffect(() => {
    if (viewLayout !== 'sheet' || peaks.length > 0 || !currentInstrumentalUrl) return;
    let cancelled = false;
    (async () => {
      try {
        const ctx   = new AudioContext();
        const buf   = await fetch(currentInstrumentalUrl).then(r => r.arrayBuffer());
        const ab    = await ctx.decodeAudioData(buf);
        await ctx.close();
        if (cancelled) return;
        const data  = ab.getChannelData(0);
        const N     = 4000;
        const block = Math.floor(data.length / N);
        const p: number[] = [];
        for (let i = 0; i < N; i++) {
          let max = 0;
          for (let j = 0; j < block; j++) {
            const v = Math.abs(data[i * block + j]);
            if (v > max) max = v;
          }
          p.push(max);
        }
        setPeaks(p);
      } catch { /* ignore decode errors */ }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewLayout, currentInstrumentalUrl]);

  // ── Section markers ───────────────────────────────────────────────────────────
  const sectionMarkers = useMemo(() => {
    const wordCounts = sections.map(s => {
      const lines = s.lyrics.split('\n').map(l => l.trim()).filter(Boolean);
      return lines.reduce((sum, l) => sum + l.split(/\s+/).filter(Boolean).length, 0);
    });
    const total = wordCounts.reduce((a, b) => a + b, 0);

    let rawRatios: number[];
    let labels: string[];

    if (currentWordTimestamps.length > 0 && audioDurationMs > 0) {
      rawRatios = []; labels = [];
      let cursor = 0;
      for (let i = 0; i < sections.length; i++) {
        const firstTs = currentWordTimestamps[cursor];
        if (firstTs) { rawRatios.push(firstTs.start_ms / audioDurationMs); labels.push(normalizeLabel(sections[i].label)); }
        cursor += wordCounts[i];
      }
    } else if (total > 0) {
      rawRatios = []; labels = [];
      let cum = 0;
      for (let i = 0; i < sections.length; i++) {
        rawRatios.push(cum / total); labels.push(normalizeLabel(sections[i].label));
        cum += wordCounts[i];
      }
    } else {
      return [];
    }

    const snappedRatios = beatPhaseMs !== null && audioDurationMs > 0
      ? snapSectionsToPhrases(rawRatios, audioDurationMs, beatPhaseMs, tempo)
      : rawRatios;

    const markers = snappedRatios.map((ratio, i) => ({ ratio, label: labels[i] }));
    sectionMarkersRef.current = markers;
    return markers;
  }, [sections, currentWordTimestamps, audioDurationMs, beatPhaseMs, tempo]);

  // ── Section click / seek ──────────────────────────────────────────────────────
  const seek = useCallback((ratio: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = ratio * audio.duration;
    const voc = vocalsRef.current;
    if (voc && isFinite(voc.duration)) voc.currentTime = ratio * voc.duration;
    // Move playhead immediately — onTimeUpdate only fires during active playback
    setProgress(ratio * 100);
    setCurrentTimeMs(ratio * audio.duration * 1000);
  }, []);

  const rewind = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = 0;
    const voc = vocalsRef.current;
    if (voc) voc.currentTime = 0;
    setProgress(0);
    setCurrentTimeMs(0);
  }, []);

  const handleSectionClick = useCallback((index: number) => {
    setActiveSectionIndex(prev => prev === index ? null : index);
    const marker = sectionMarkersRef.current[index];
    if (marker) seek(marker.ratio);
  }, [seek]);

  // ── Splice on section regeneration ───────────────────────────────────────────
  useEffect(() => {
    if (!pendingRegeneration || splicing) return;

    const {
      sectionIndex,
      audioUrl: fallback,
      instrumentalUrl: newInstUrl,
      vocalsUrl: newVocUrl,
      wordTimestamps: newSectionTs,
      vocalsOnly,
    } = pendingRegeneration;

    const markers = sectionMarkersRef.current;
    if (!markers.length) return;

    const startRatio = markers[sectionIndex]?.ratio ?? 0;
    const endRatio   = markers[sectionIndex + 1]?.ratio ?? 1;

    setSplicing(true);

    const runSplices = async () => {
      let finalInstUrl = currentInstrumentalUrlRef.current;
      let finalVocUrl  = currentVocalsUrlRef.current;
      let finalTs      = currentWordTimestampsRef.current;

      // Convert section ratios (which are relative to the instrumental's duration) into
      // absolute ms, then re-derive ratios for the vocals track from its own duration.
      // Using the same ratios on both tracks causes seam misalignment when the two
      // tracks have even slightly different total lengths.
      const getAudioDurationMs = async (url: string): Promise<number> => {
        const ctx = new AudioContext();
        const buf = await fetch(url).then(r => r.arrayBuffer());
        const decoded = await ctx.decodeAudioData(buf);
        await ctx.close();
        return decoded.duration * 1000;
      };

      const instDurationMs = await getAudioDurationMs(currentInstrumentalUrlRef.current);
      const startMs = startRatio * instDurationMs;
      const endMs   = endRatio   * instDurationMs;

      // Vocal ratios derived from the vocals track's own duration (may differ from inst)
      let vocStartRatio = startRatio;
      let vocEndRatio   = endRatio;
      if (currentVocalsUrlRef.current) {
        const vocDurationMs = await getAudioDurationMs(currentVocalsUrlRef.current);
        vocStartRatio = startMs / vocDurationMs;
        vocEndRatio   = endMs   / vocDurationMs;
      }

      const tasks: Promise<void>[] = [];

      if (!vocalsOnly) {
        tasks.push(
          spliceSection(currentInstrumentalUrlRef.current, currentWordTimestampsRef.current,
            startRatio, endRatio, newInstUrl ?? fallback, newSectionTs)
            .then(r => { finalInstUrl = r.audioUrl; finalTs = r.wordTimestamps; })
        );
      }

      if (currentVocalsUrlRef.current) {
        const fn = vocalsOnly ? spliceVocals : spliceSection;
        tasks.push(
          fn(currentVocalsUrlRef.current, currentWordTimestampsRef.current,
            vocStartRatio, vocEndRatio, newVocUrl ?? fallback, newSectionTs)
            .then(r => { finalVocUrl = r.audioUrl; if (vocalsOnly) finalTs = r.wordTimestamps; })
        );
      } else if (vocalsOnly) {
        tasks.push(
          spliceVocals(currentInstrumentalUrlRef.current, currentWordTimestampsRef.current,
            startRatio, endRatio, newVocUrl ?? fallback, newSectionTs)
            .then(r => { finalInstUrl = r.audioUrl; finalTs = r.wordTimestamps; })
        );
      }

      await Promise.all(tasks);

      setCurrentInstrumentalUrl(finalInstUrl);
      setCurrentVocalsUrl(finalVocUrl);
      setCurrentWordTimestamps(finalTs);
      setProgress(0);
      setCurrentTimeMs(0);
      onSpliceComplete?.(finalInstUrl, finalVocUrl || undefined, finalTs);
      onRegenerationComplete?.();
    };

    runSplices()
      .catch(err => console.error('Splice failed:', err))
      .finally(() => setSplicing(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingRegeneration]);

  // ── Playback controls ─────────────────────────────────────────────────────────

  /** Master play/pause — both tracks start simultaneously at the same position. */
  const toggle = useCallback(async () => {
    const audio = audioRef.current;
    const voc   = vocalsRef.current;
    if (!audio) return;

    if (playing) {
      audio.pause();
      voc?.pause();
      setPlaying(false);
      setInstSolo(false);
      setVocalsSolo(false);
      lastNotifiedSectionRef.current = null;
      onActiveSectionChange?.(null);
    } else {
      // Apply current volumes before starting
      audio.volume = instVolumeRef.current;
      if (voc) {
        voc.currentTime = audio.currentTime;   // sync position
        voc.volume      = vocalsVolumeRef.current;
      }
      // Start both simultaneously
      const plays: Promise<void>[] = [audio.play()];
      if (voc) plays.push(voc.play());
      await Promise.all(plays);
      setPlaying(true);
      setInstSolo(false);
      setVocalsSolo(false);
    }
  }, [playing, onActiveSectionChange]);

  /** Solo the instrumental track (stops vocal if it was soloing). */
  const toggleInst = useCallback(async () => {
    const audio = audioRef.current;
    const voc   = vocalsRef.current;
    if (!audio) return;

    if (playing) {
      audio.pause(); voc?.pause();
      setPlaying(false); setVocalsSolo(false);
      lastNotifiedSectionRef.current = null; onActiveSectionChange?.(null);
      audio.volume = instVolumeRef.current;
      await audio.play();
      setInstSolo(true);
    } else if (instSolo) {
      audio.pause(); setInstSolo(false);
    } else {
      voc?.pause(); setVocalsSolo(false);
      audio.volume = instVolumeRef.current;
      await audio.play();
      setInstSolo(true);
    }
  }, [playing, instSolo, onActiveSectionChange]);

  /** Solo the vocals track (stops instrumental if it was soloing). */
  const toggleVocals = useCallback(async () => {
    const audio = audioRef.current;
    const voc   = vocalsRef.current;
    if (!voc) return;

    if (playing) {
      audio?.pause(); voc.pause();
      setPlaying(false); setInstSolo(false);
      lastNotifiedSectionRef.current = null; onActiveSectionChange?.(null);
      voc.volume = vocalsVolumeRef.current;
      await voc.play();
      setVocalsSolo(true);
    } else if (vocalsSolo) {
      voc.pause(); setVocalsSolo(false);
    } else {
      audio?.pause(); setInstSolo(false);
      voc.volume = vocalsVolumeRef.current;
      await voc.play();
      setVocalsSolo(true);
    }
  }, [playing, vocalsSolo, onActiveSectionChange]);

  const updateProgress = (currentTime: number, duration: number) => {
    if (!duration) return;
    const ratio = currentTime / duration;
    setProgress(ratio * 100);
    setCurrentTimeMs(currentTime * 1000);

    const markers = sectionMarkersRef.current;
    if (markers.length > 0) {
      let newIdx = markers.length - 1;
      for (let i = 0; i < markers.length - 1; i++) {
        if (ratio < markers[i + 1].ratio) { newIdx = i; break; }
      }
      if (lastNotifiedSectionRef.current !== newIdx) {
        lastNotifiedSectionRef.current = newIdx;
        setActiveSectionIndex(newIdx);
        onActiveSectionChange?.(newIdx);
      }
    }
  };

  const onTimeUpdate = () => {
    const audio = audioRef.current;
    if (audio && !audio.paused) updateProgress(audio.currentTime, audio.duration);
  };

  const onVocalsTimeUpdate = () => {
    const voc = vocalsRef.current;
    // Only drive progress from vocals when it's the sole playing source
    if (voc && !voc.paused && audioRef.current?.paused) {
      updateProgress(voc.currentTime, voc.duration);
    }
  };

  const onEnded = () => {
    setPlaying(false); setInstSolo(false);
    const voc = vocalsRef.current;
    if (voc) { voc.pause(); voc.currentTime = 0; }
    if (audioRef.current) audioRef.current.currentTime = 0;
    setVocalsSolo(false);
    lastNotifiedSectionRef.current = null;
    onActiveSectionChange?.(null);
  };

  const instIsPlaying   = playing || instSolo;
  const vocIsPlaying    = playing || vocalsSolo;

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-lg border border-[#e9e9e9] bg-white p-4 flex flex-col gap-4 shadow-[0_2px_8px_rgba(0,0,0,0.06)]">

        {/* Transport header */}
        <div className="flex items-center gap-4">
          {/* Rewind */}
          <button
            onClick={rewind}
            disabled={splicing}
            className="w-8 h-8 rounded-full bg-[#e9e9e9] hover:bg-[#d4d4d4] disabled:opacity-40 flex items-center justify-center text-[#676767] transition-colors flex-shrink-0"
            aria-label="Rewind to start"
          >
            <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M6 6h2v12H6zm3.5 6 8.5 6V6z" />
            </svg>
          </button>

          {/* Play/Pause */}
          <button
            onClick={toggle}
            disabled={splicing}
            className="w-10 h-10 rounded-full bg-[#f37321] hover:bg-[#da6520] disabled:opacity-40 flex items-center justify-center text-white transition-colors flex-shrink-0 shadow-[0_2px_6px_rgba(243,115,33,0.4)]"
            aria-label={playing ? 'Pause' : 'Play all'}
          >
            {playing ? (
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" />
              </svg>
            ) : (
              <svg className="w-4 h-4 ml-0.5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </button>

          <span className="text-sm font-semibold text-[#3b3b3b] truncate flex-1">{title}</span>

          {splicing && (
            <span className="text-xs text-[#f37321] flex items-center gap-1.5">
              <span className="inline-block w-3 h-3 rounded-full border-2 border-[#fcd9bc] border-t-[#f37321] animate-spin" />
              Splicing…
            </span>
          )}

          {/* Zoom controls (waveform mode only) */}
          {viewLayout === 'waveform' && (
            <div className="flex items-center gap-1 flex-shrink-0">
              <button
                onClick={() => setWaveformZoom(z => Math.max(0.5, parseFloat((z - 0.5).toFixed(1))))}
                disabled={waveformZoom <= 0.5}
                className="w-5 h-5 flex items-center justify-center rounded border border-[#e9e9e9] bg-[#f6f6f6] text-[#676767] hover:border-[#bdbdbd] disabled:opacity-30 disabled:cursor-not-allowed text-xs font-bold leading-none"
                title="Zoom out"
              >−</button>
              <span className="text-[10px] text-[#929292] tabular-nums w-6 text-center">{waveformZoom}×</span>
              <button
                onClick={() => setWaveformZoom(z => Math.min(5, parseFloat((z + 0.5).toFixed(1))))}
                disabled={waveformZoom >= 5}
                className="w-5 h-5 flex items-center justify-center rounded border border-[#e9e9e9] bg-[#f6f6f6] text-[#676767] hover:border-[#bdbdbd] disabled:opacity-30 disabled:cursor-not-allowed text-xs font-bold leading-none"
                title="Zoom in"
              >+</button>
            </div>
          )}

          {/* Layout toggle */}
          <button
            onClick={() => setViewLayout(v => v === 'waveform' ? 'sheet' : 'waveform')}
            title={viewLayout === 'waveform' ? 'Switch to sheet music view' : 'Switch to waveform view'}
            className={`flex items-center gap-1 px-2 py-1 rounded border text-[10px] font-semibold transition-colors flex-shrink-0 ${
              viewLayout === 'sheet'
                ? 'border-[#f37321] bg-[#fff3eb] text-[#f37321]'
                : 'border-[#e9e9e9] bg-[#f6f6f6] text-[#929292] hover:border-[#f37321] hover:text-[#f37321]'
            }`}
          >
            {viewLayout === 'waveform' ? (
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeWidth={1.5} d="M3 5h18M3 9h18M3 13h18M3 17h18" />
                <circle cx="8" cy="17" r="2" fill="currentColor" stroke="none" />
                <path strokeLinecap="round" strokeWidth={1.5} d="M10 17V9" />
              </svg>
            ) : (
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M3 12h2l2-7 2 14 2-10 2 6 2-3h2l2 0" />
              </svg>
            )}
            {viewLayout === 'waveform' ? 'Sheet' : 'Waveform'}
          </button>

          {hasTwoTracks ? (
            <>
              <a href={currentInstrumentalUrl} download={`${title}-instrumental.mp3`}
                className="text-xs text-[#929292] hover:text-[#f37321] transition-colors">
                ↓ Instrumental
              </a>
              <a href={currentVocalsUrl} download={`${title}-vocals.mp3`}
                className="text-xs text-[#929292] hover:text-[#f37321] transition-colors">
                ↓ Vocals
              </a>
            </>
          ) : (
            <a href={currentInstrumentalUrl} download={`${title}.mp3`}
              className="text-xs text-[#929292] hover:text-[#f37321] transition-colors">
              Download
            </a>
          )}
        </div>

        {/* Tracks — either sheet music view or waveform view */}
        {viewLayout === 'sheet' ? (
          <SheetMusicView
            sections={sections}
            sectionMarkers={sectionMarkers}
            peaks={peaks}
            wordTimestamps={currentWordTimestamps}
            audioDurationMs={audioDurationMs}
            currentTimeMs={currentTimeMs}
            activeSectionIndex={activeSectionIndex}
            onSeek={seek}
            onSectionClick={handleSectionClick}
          />
        ) : (
          <div ref={waveformScrollRef} style={{ overflowX: waveformZoom > 1 ? 'auto' : 'visible', scrollbarWidth: 'none' }}>
            <div style={{ width: waveformZoom !== 1 ? `${waveformZoom * 100}%` : '100%', minWidth: '100%' }}>
        {hasTwoTracks ? (
          <div className="flex flex-col gap-1">
            {/* Section labels — rendered once above both tracks, aligned with the waveform column */}
            {sectionMarkers.length > 0 && (
              <div className="flex items-end gap-3">
                {/* Spacers mirroring TrackRow left elements: volume → play → label */}
                <div className="flex-shrink-0 flex items-center gap-1.5">
                  <div className="w-6" />
                  <div style={{ width: 30 }} />
                </div>
                <div className="w-7 flex-shrink-0" />
                <div className="w-20 flex-shrink-0" />
                <div className="flex-1 min-w-0 relative h-4">
                  {sectionMarkers.map((marker, i) => (
                    <button
                      key={i}
                      onClick={() => { seek(marker.ratio); handleSectionClick(i); }}
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
              </div>
            )}

            {/* Vocals track — section markers drawn through it too, labels suppressed */}
            <TrackRow
              label="Vocals"
              playing={vocIsPlaying}
              volume={vocalsVolume}
              onToggle={toggleVocals}
              onVolumeChange={setVocalsVolume}
              onRegenerate={onRegenerateVocals}
              regenerating={regeneratingVocals}
            >
              <Waveform
                audioUrl={currentVocalsUrl}
                progress={progress}
                onSeek={seek}
                showLabels={false}
                sectionMarkers={sectionMarkers}
                activeSectionIndex={activeSectionIndex}
                onSectionClick={handleSectionClick}
              />
            </TrackRow>

            {/* Instrumental track */}
            <TrackRow
              label="Instrumental"
              playing={instIsPlaying}
              volume={instVolume}
              onToggle={toggleInst}
              onVolumeChange={setInstVolume}
              onRegenerate={onRegenerateInstrumental}
              regenerating={regeneratingInstrumental}
            >
              <Waveform
                audioUrl={currentInstrumentalUrl}
                progress={progress}
                onSeek={seek}
                showLabels={false}
                sectionMarkers={sectionMarkers}
                activeSectionIndex={activeSectionIndex}
                onSectionClick={handleSectionClick}
                onDurationReady={handleDurationReady}
                onBeatPhaseReady={handleBeatPhaseReady}
                tempo={tempo}
              />
            </TrackRow>
          </div>
        ) : (
          <Waveform
            audioUrl={currentInstrumentalUrl}
            progress={progress}
            onSeek={seek}
            sectionMarkers={sectionMarkers}
            activeSectionIndex={activeSectionIndex}
            onSectionClick={handleSectionClick}
            onDurationReady={handleDurationReady}
            onBeatPhaseReady={handleBeatPhaseReady}
            tempo={tempo}
          />
        )}
            </div>
          </div>
        )}

        {/* ── Instrument stems — only shown after separation is complete ── */}
        {viewLayout === 'waveform' && instrumentStems && (
          <div className="border-t border-[#e9e9e9] pt-3 flex flex-col gap-1">
            <StemTrackRow label="Drums" audioUrl={instrumentStems.drums} />
            <StemTrackRow label="Bass"  audioUrl={instrumentStems.bass}  />
            <StemTrackRow label="Other" audioUrl={instrumentStems.other} />
          </div>
        )}

        {/* Hidden audio elements */}
        <audio
          ref={audioRef}
          src={currentInstrumentalUrl}
          onTimeUpdate={onTimeUpdate}
          onEnded={onEnded}
          preload="auto"
          style={{ display: 'none' }}
        />
        {hasTwoTracks && (
          <audio
            ref={vocalsRef}
            src={currentVocalsUrl}
            onTimeUpdate={onVocalsTimeUpdate}
            onEnded={() => { setVocalsSolo(false); if (vocalsRef.current) vocalsRef.current.currentTime = 0; }}
            preload="auto"
            style={{ display: 'none' }}
          />
        )}
      </div>

      {/* Karaoke lyrics — hidden in sheet mode since lyrics are inline per section */}
      {viewLayout === 'waveform' && currentWordTimestamps.length > 0 && (
        <div className="rounded-lg border border-[#e9e9e9] bg-white p-5 shadow-[0_2px_8px_rgba(0,0,0,0.06)]">
          <LyricsDisplay
            sections={sections}
            wordTimestamps={currentWordTimestamps}
            currentTimeMs={currentTimeMs}
            activeSectionIndex={activeSectionIndex}
            onSectionClick={handleSectionClick}
          />
        </div>
      )}
    </div>
  );
}

// ── StemTrackRow — self-contained playback for an individual stem ─────────────

function StemTrackRow({ label, audioUrl }: { label: string; audioUrl: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying]   = useState(false);
  const [progress, setProgress] = useState(0);
  const [volume, setVolume]     = useState(0.8);

  useEffect(() => { if (audioRef.current) audioRef.current.volume = volume; }, [volume]);

  const toggle = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) { audio.pause(); setPlaying(false); }
    else { audio.volume = volume; await audio.play(); setPlaying(true); }
  };

  const seek = (ratio: number) => {
    const audio = audioRef.current;
    if (!audio || !isFinite(audio.duration)) return;
    audio.currentTime = ratio * audio.duration;
    setProgress(ratio * 100);
  };

  return (
    <>
      <TrackRow label={label} playing={playing} volume={volume} onToggle={toggle} onVolumeChange={setVolume}>
        <Waveform audioUrl={audioUrl} progress={progress} onSeek={seek} />
      </TrackRow>
      <audio
        ref={audioRef}
        src={audioUrl}
        preload="auto"
        style={{ display: 'none' }}
        onTimeUpdate={() => {
          const a = audioRef.current;
          if (a && !a.paused) setProgress((a.currentTime / a.duration) * 100);
        }}
        onEnded={() => setPlaying(false)}
      />
    </>
  );
}

// ── TrackRow ──────────────────────────────────────────────────────────────────

interface TrackRowProps {
  label: string;
  playing: boolean;
  volume: number;
  onToggle: () => void;
  onVolumeChange: (v: number) => void;
  onRegenerate?: () => void;
  regenerating?: boolean;
  children: React.ReactNode; // waveform
}

function TrackRow({ label, playing, volume, onToggle, onVolumeChange, onRegenerate, regenerating, children }: TrackRowProps) {
  return (
    <div className="flex items-center gap-3">
      {/* Volume */}
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <span className="text-xs text-[#929292] w-6 text-right tabular-nums">{Math.round(volume * 100)}</span>
        <VolumeKnob value={volume} onChange={onVolumeChange} size={30} />
      </div>

      {/* Solo play/pause */}
      <button
        onClick={onToggle}
        title={playing ? `Pause ${label}` : `Solo ${label}`}
        className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 transition-colors ${
          playing
            ? 'bg-[#f37321] text-white'
            : 'bg-[#e9e9e9] hover:bg-[#f37321] text-[#676767] hover:text-white'
        }`}
      >
        {playing ? (
          <svg className="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 24 24">
            <rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" />
          </svg>
        ) : (
          <svg className="w-2.5 h-2.5 ml-px" fill="currentColor" viewBox="0 0 24 24">
            <path d="M8 5v14l11-7z" />
          </svg>
        )}
      </button>

      {/* Label */}
      <span className="text-xs font-semibold text-[#676767] w-20 flex-shrink-0">{label}</span>

      {/* Waveform — fills remaining space */}
      <div className="flex-1 min-w-0">{children}</div>

      {/* Regenerate */}
      {onRegenerate && (
        <button
          onClick={onRegenerate}
          disabled={regenerating}
          title={`Regenerate ${label}`}
          className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-semibold border border-[#e9e9e9] bg-[#f6f6f6] hover:border-[#f37321] hover:text-[#f37321] text-[#929292] disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex-shrink-0"
        >
          {regenerating ? (
            <span className="inline-block w-3 h-3 rounded-full border-2 border-[#bdbdbd] border-t-[#f37321] animate-spin" />
          ) : (
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          )}
          Regen
        </button>
      )}
    </div>
  );
}
