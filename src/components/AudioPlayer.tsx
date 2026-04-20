'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SongSection, WordTimestamp } from '@/lib/types';
import { snapSectionsToPhrases, detectBeatPhaseMs } from '@/lib/audio/beatDetect';
import { mixTracksWithVolumes, encodeWav } from '@/lib/audio/mix';
import LyricsDisplay from './LyricsDisplay';
import Waveform from './Waveform';
import LiveRecordingWaveform from './LiveRecordingWaveform';
import VolumeKnob from './VolumeKnob';
function normalizeLabel(label: string): string {
  return label.replace(/\bIntroduction\b/gi, 'Intro');
}

interface Props {
  audioUrl: string;
  vocalsUrl?: string;
  title: string;
  sections: SongSection[];
  wordTimestamps: WordTimestamp[];
  tempo: number;
  onActiveSectionChange?: (index: number | null) => void;
  onRegenerateVocals?: () => Promise<void>;
  onRegenerateInstrumental?: () => Promise<void>;
  regeneratingVocals?: boolean;
  regeneratingInstrumental?: boolean;
  instrumentStems?: { drums: string; bass: string; other: string } | null;
  stemLabels?: { drums: string; bass: string; other: string };
  onSeparateInstruments?: () => void;
  separatingInstruments?: boolean;
  onSplitTracks?: () => void;
  onRejoinTracks?: () => void;
  splitting?: boolean;
  otherStemSplit?: { vocals: string; instrumental: string } | null;
  onSeparateOtherStem?: () => void;
  separatingOtherStem?: boolean;
  onPlayStateChange?: (playing: boolean) => void;
  playTrigger?: number;  // increment to programmatically start playback
  pauseTrigger?: number; // increment to programmatically pause playback
  playSectionRequest?: { index: number; seq: number }; // seek + play a specific section
  vocalsRecordingStream?: MediaStream | null; // live mic stream while recording vocals
  extraVocalTracks?: { id: string; url: string; label: string }[];
  onDeleteVocalsTrack?: (id: string) => void; // delete a recorded vocal take
  onDeletePrimaryVocals?: () => void;          // delete the primary AI/split vocals track
  activeExtraVocalId?: string | null;
  onSelectExtraVocal?: (id: string) => void;
  onReorderSections?: (from: number, to: number) => void;
  onTimelineApply?: (updated: { id: string; url: string; timestamps?: WordTimestamp[] }[]) => void;
  onRegenerateSection?: (index: number, mode: 'both' | 'vocals' | 'instrumental') => void;
  regeneratingSectionIndex?: number | null;
  onSliceSection?: (index: number, localRatio: number) => void;
  onFadeOutSection?: (index: number) => void;
  sectionTimings?: { startMs: number; endMs: number }[];
}

export default function AudioPlayer({
  audioUrl, vocalsUrl, title, sections, wordTimestamps, tempo,
  onActiveSectionChange,
  onRegenerateVocals, onRegenerateInstrumental, regeneratingVocals, regeneratingInstrumental,
  instrumentStems, stemLabels, onSeparateInstruments, separatingInstruments,
  onSplitTracks, onRejoinTracks, splitting,
  otherStemSplit, onSeparateOtherStem, separatingOtherStem,
  onPlayStateChange,
  playTrigger,
  pauseTrigger,
  playSectionRequest,
  vocalsRecordingStream,
  extraVocalTracks,
  onDeleteVocalsTrack,
  onDeletePrimaryVocals,
  activeExtraVocalId,
  onSelectExtraVocal,
  onReorderSections,
  onTimelineApply,
  onRegenerateSection,
  regeneratingSectionIndex,
  onSliceSection,
  onFadeOutSection,
  sectionTimings,
}: Props) {
  const audioRef  = useRef<HTMLAudioElement>(null);
  const vocalsRef = useRef<HTMLAudioElement>(null);
  // Extra recorded vocal tracks — keyed by track id
  const extraVocalAudioRefsMap = useRef<Map<string, HTMLAudioElement>>(new Map());
  // Mutable refs populated by StemTrackRow via onAudioRef callback
  const drumAudioRef   = useRef<HTMLAudioElement | null>(null);
  const bassAudioRef   = useRef<HTMLAudioElement | null>(null);
  const otherAudioRef  = useRef<HTMLAudioElement | null>(null);
  // Sub-stems from re-separating the "Other" track
  const other2VocalsRef = useRef<HTMLAudioElement | null>(null);
  const other2InstRef   = useRef<HTMLAudioElement | null>(null);

  const [playing,      setPlaying]      = useState(false);
  const [instSolo,     setInstSolo]     = useState(false);
  const [vocalsSolo,   setVocalsSolo]   = useState(false);
  const [progress,     setProgress]     = useState(0);
  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const [audioDurationMs, setAudioDurationMs] = useState(0);
  const [beatPhaseMs,  setBeatPhaseMs]  = useState<number | null>(null);
  const [activeSectionIndex, setActiveSectionIndex] = useState<number | null>(null);
  const [instVolume,   setInstVolume]   = useState(0.75);
  const [vocalsVolume, setVocalsVolume] = useState(0.9);
  const [drumVolume,    setDrumVolume]    = useState(0.8);
  const [bassVolume,    setBassVolume]    = useState(0.8);
  const [otherVolume,   setOtherVolume]   = useState(0.8);
  const [other2VocalsVol, setOther2VocalsVol] = useState(0.8);
  const [other2InstVol,   setOther2InstVol]   = useState(0.8);
  const [mixing,         setMixing]         = useState(false);
  const [mixUrl,         setMixUrl]         = useState<string | null>(null);
  const [regionSel,      setRegionSel]      = useState<{ trackId: string; startRatio: number; endRatio: number } | null>(null);
  const [applyingRegion, setApplyingRegion] = useState(false);
  const [mutedRegions,   setMutedRegions]   = useState<{ id: string; trackId: string; startRatio: number; endRatio: number }[]>([]);

  type EditSnapshot = { instrumentalUrl: string; instrumentalTs: WordTimestamp[]; vocalsUrl: string };
  const [editHistory, setEditHistory] = useState<EditSnapshot[]>([]);
  const [editFuture,  setEditFuture]  = useState<EditSnapshot[]>([]);
  const [clipboard,   setClipboard]   = useState<{ url: string; ts: WordTimestamp[]; trackId: string } | null>(null);

  const [waveformZoom,  setWaveformZoom]  = useState(1);
  const waveformScrollRef = useRef<HTMLDivElement>(null);

  const [currentInstrumentalUrl, setCurrentInstrumentalUrl] = useState(audioUrl);
  const [currentVocalsUrl,       setCurrentVocalsUrl]       = useState(vocalsUrl ?? '');
  const [currentWordTimestamps,  setCurrentWordTimestamps]  = useState(wordTimestamps);

  // Playback URLs — identical to current URLs unless muted regions are active.
  // The original audio data is always preserved; silencing is applied only here.
  const [playbackInstUrl,   setPlaybackInstUrl]   = useState(audioUrl);
  const [playbackVocalsUrl, setPlaybackVocalsUrl] = useState(vocalsUrl ?? '');

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
  const activeExtraVocalIdRef      = useRef(activeExtraVocalId);
  const rafRef                     = useRef<number | null>(null);

  const onPlayStateChangeRef = useRef(onPlayStateChange);
  useEffect(() => { onPlayStateChangeRef.current = onPlayStateChange; }, [onPlayStateChange]);
  useEffect(() => { onPlayStateChangeRef.current?.(playing); }, [playing]);

  useEffect(() => { currentInstrumentalUrlRef.current = currentInstrumentalUrl; }, [currentInstrumentalUrl]);
  useEffect(() => { currentVocalsUrlRef.current       = currentVocalsUrl; },       [currentVocalsUrl]);
  useEffect(() => { currentWordTimestampsRef.current  = currentWordTimestamps; },  [currentWordTimestamps]);
  useEffect(() => { audioDurationMsRef.current        = audioDurationMs; },        [audioDurationMs]);
  useEffect(() => { instVolumeRef.current             = instVolume; },             [instVolume]);
  useEffect(() => { vocalsVolumeRef.current           = vocalsVolume; },           [vocalsVolume]);
  useEffect(() => { activeExtraVocalIdRef.current     = activeExtraVocalId; },     [activeExtraVocalId]);

  // Apply volume changes immediately to playing elements
  useEffect(() => { if (audioRef.current)  audioRef.current.volume  = instVolume;   }, [instVolume]);
  useEffect(() => { if (vocalsRef.current) vocalsRef.current.volume = vocalsVolume; }, [vocalsVolume]);

  // When the playback instrumental URL changes (splice OR muted-region resynthesis),
  // force the <audio> element to reload. Changing `src` in React alone isn't enough.
  const prevPlaybackInstRef = useRef(playbackInstUrl);
  useEffect(() => {
    if (playbackInstUrl === prevPlaybackInstRef.current) return;
    prevPlaybackInstRef.current = playbackInstUrl;
    const audio = audioRef.current;
    if (!audio) return;
    // Only reset position when the underlying source audio changed (not just mutes)
    const srcChanged = playbackInstUrl !== currentInstrumentalUrl || true;
    audio.pause();
    audio.load();
    if (srcChanged) { setPlaying(false); setProgress(0); setCurrentTimeMs(0); }
  }, [playbackInstUrl, currentInstrumentalUrl]);

  const prevPlaybackVocRef = useRef(playbackVocalsUrl);
  useEffect(() => {
    if (playbackVocalsUrl === prevPlaybackVocRef.current) return;
    prevPlaybackVocRef.current = playbackVocalsUrl;
    vocalsRef.current?.load();
  }, [playbackVocalsUrl]);

  // 60fps progress loop — runs while playing or in solo mode, cancelled on full stop
  useEffect(() => {
    const tick = () => {
      const audio = audioRef.current;
      if (audio && !audio.paused && isFinite(audio.duration) && audio.duration > 0) {
        updateProgress(audio.currentTime, audio.duration);
      } else {
        const voc = vocalsRef.current;
        if (voc && !voc.paused && isFinite(voc.duration) && voc.duration > 0) {
          updateProgress(voc.currentTime, voc.duration);
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    if (playing || instSolo || vocalsSolo) {
      rafRef.current = requestAnimationFrame(tick);
    } else {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    }

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, instSolo, vocalsSolo]);

  const handleDurationReady  = useCallback((ms: number)    => setAudioDurationMs(ms), []);
  const handleBeatPhaseReady = useCallback((ms: number)    => setBeatPhaseMs(ms),     []);

  useEffect(() => { setBeatPhaseMs(null); }, [currentInstrumentalUrl]);

  // ── Muted-region playback synthesis ──────────────────────────────────────────
  // Regenerates a silenced copy of the audio for playback whenever muted regions
  // or the source audio changes. Original audio data (currentInstrumentalUrl /
  // currentVocalsUrl) is NEVER modified — only the playback URLs change.
  useEffect(() => {
    let cancelled = false;

    /** Apply all mute markers for `trackId` onto `sourceUrl`, returning a new URL. */
    const applyMutes = async (sourceUrl: string, trackId: string) => {
      const regions = mutedRegions.filter(m => m.trackId === trackId);
      if (regions.length === 0) return sourceUrl;

      const { silenceAudioRegion } = await import('@/lib/audio/splice');
      // Get the audio duration once (needed for ratio → ms conversion)
      const ab    = await fetch(sourceUrl).then(r => r.arrayBuffer());
      const actx  = new AudioContext();
      const buf   = await actx.decodeAudioData(ab);
      await actx.close();
      const durMs = buf.duration * 1000;

      // Apply each mute region sequentially (silenceAudioRegion preserves file length)
      let url = sourceUrl;
      for (const m of regions) {
        const result = await silenceAudioRegion(url, [], m.startRatio * durMs, m.endRatio * durMs);
        url = result.audioUrl;
      }
      return url;
    };

    (async () => {
      const [newInst, newVoc] = await Promise.all([
        applyMutes(currentInstrumentalUrl, 'instrumental'),
        currentVocalsUrl ? applyMutes(currentVocalsUrl, 'vocals-primary') : Promise.resolve(currentVocalsUrl),
      ]);
      if (cancelled) return;
      setPlaybackInstUrl(newInst);
      setPlaybackVocalsUrl(newVoc);
    })();

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mutedRegions, currentInstrumentalUrl, currentVocalsUrl]);

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

  // Seek to a specific section and start playback
  useEffect(() => {
    if (!playSectionRequest) return;
    const marker = sectionMarkersRef.current[playSectionRequest.index];
    if (!marker) return;
    seek(marker.ratio);
    if (!playing) void toggle();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playSectionRequest]);

  // Pause playback on demand
  useEffect(() => {
    if (!pauseTrigger) return;
    if (playing) void toggle();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pauseTrigger]);

  // Decode high-resolution peaks when the user switches to sheet layout.
  // Use the vocals track when available (so sheet view shows vocal waveform),
  // otherwise fall back to the instrumental.

  // ── Section markers ───────────────────────────────────────────────────────────
  const sectionMarkers = useMemo(() => {
    const labels = sections.map(s => normalizeLabel(s.label));

    // Bar-based: positions are authoritative — derived from cumulative bar counts.
    if (sectionTimings && sectionTimings.length === sections.length && audioDurationMs > 0) {
      const markers = sectionTimings.map((t, i) => ({
        ratio: t.startMs / audioDurationMs,
        label: labels[i],
      }));
      sectionMarkersRef.current = markers;
      return markers;
    }

    // Fallback (no sectionTimings yet): proportional by word count
    const wordCounts = sections.map(s => {
      const lines = s.lyrics.split('\n').map(l => l.trim()).filter(Boolean);
      return lines.reduce((sum, l) => sum + l.split(/\s+/).filter(Boolean).length, 0);
    });
    const total = wordCounts.reduce((a, b) => a + b, 0);
    if (total === 0) return [];

    const rawRatios: number[] = [];
    let cum = 0;
    for (let i = 0; i < sections.length; i++) {
      rawRatios.push(cum / total);
      cum += wordCounts[i];
    }

    const markers = rawRatios.map((ratio, i) => ({ ratio, label: labels[i] }));
    sectionMarkersRef.current = markers;
    return markers;
  }, [sections, sectionTimings, audioDurationMs]);

  // ── Section click / seek ──────────────────────────────────────────────────────
  const seek = useCallback((ratio: number) => {
    const audio = audioRef.current;
    if (!audio || !isFinite(ratio) || !isFinite(audio.duration)) return;
    audio.currentTime = ratio * audio.duration;
    const voc = vocalsRef.current;
    if (voc && isFinite(voc.duration)) voc.currentTime = ratio * voc.duration;
    [drumAudioRef.current, bassAudioRef.current, otherAudioRef.current,
     other2VocalsRef.current, other2InstRef.current].forEach(el => {
      if (el && isFinite(el.duration)) el.currentTime = ratio * el.duration;
    });
    extraVocalEls().forEach(el => { if (isFinite(el.duration)) el.currentTime = ratio * el.duration; });
    setProgress(ratio * 100);
    setCurrentTimeMs(ratio * audio.duration * 1000);
  }, []);

  const rewind = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = 0;
    const voc = vocalsRef.current;
    if (voc) voc.currentTime = 0;
    [drumAudioRef.current, bassAudioRef.current, otherAudioRef.current,
     other2VocalsRef.current, other2InstRef.current].forEach(el => {
      if (el) el.currentTime = 0;
    });
    extraVocalEls().forEach(el => { el.currentTime = 0; });
    setProgress(0);
    setCurrentTimeMs(0);
  }, []);

  const handleSectionClick = useCallback((index: number) => {
    setActiveSectionIndex(prev => prev === index ? null : index);
    const marker = sectionMarkersRef.current[index];
    if (marker) seek(marker.ratio);
  }, [seek]);

  // ── Playback controls ─────────────────────────────────────────────────────────

  /** Only the active recorded vocal take's audio element.
   *  Reads from a ref so stale useCallback closures always get the current take. */
  const extraVocalEls = () => {
    const id = activeExtraVocalIdRef.current;
    if (!id) return [];
    const el = extraVocalAudioRefsMap.current.get(id);
    return el ? [el] : [];
  };

  /** Master play/pause — all tracks (instrumental, vocals, stems, extra vocals) start simultaneously. */
  const toggle = useCallback(async () => {
    const audio = audioRef.current;
    const voc   = vocalsRef.current;
    if (!audio) return;

    const stemEls  = [drumAudioRef.current, bassAudioRef.current, otherAudioRef.current,
                      other2VocalsRef.current, other2InstRef.current]
      .filter((el): el is HTMLAudioElement => el !== null);
    const extraEls = extraVocalEls();

    if (playing) {
      audio.pause();
      voc?.pause();
      stemEls.forEach(el => el.pause());
      extraEls.forEach(el => el.pause());
      setPlaying(false);
      setInstSolo(false);
      setVocalsSolo(false);
      lastNotifiedSectionRef.current = null;
      onActiveSectionChange?.(null);
    } else {
      const pos = audio.currentTime;
      audio.volume = instVolumeRef.current;
      if (voc) {
        voc.currentTime = pos;
        voc.volume      = vocalsVolumeRef.current;
      }
      stemEls.forEach(el => { el.currentTime = isFinite(el.duration) ? pos * (el.duration / (audio.duration || 1)) : 0; });
      extraEls.forEach(el => { if (isFinite(el.duration)) el.currentTime = pos * (el.duration / (audio.duration || 1)); });
      const plays: Promise<void>[] = [audio.play()];
      if (voc) plays.push(voc.play());
      stemEls.forEach(el => plays.push(el.play()));
      extraEls.forEach(el => plays.push(el.play()));
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
    [drumAudioRef.current, bassAudioRef.current, otherAudioRef.current,
     other2VocalsRef.current, other2InstRef.current].forEach(el => {
      if (el) { el.pause(); el.currentTime = 0; }
    });
    setVocalsSolo(false);
    lastNotifiedSectionRef.current = null;
    onActiveSectionChange?.(null);
  };

  const instIsPlaying   = playing || instSolo;
  const vocIsPlaying    = playing || vocalsSolo;

  // ── Region edit (cut) with undo/redo ─────────────────────────────────────────
  const handleRegionApply = async (op: 'cut') => {
    if (!regionSel) return;
    setApplyingRegion(true);
    try {
      const isInst = regionSel.trackId === 'instrumental';
      const url    = isInst ? currentInstrumentalUrl : currentVocalsUrl;
      const ts     = isInst ? currentWordTimestamps   : [];

      const actx = new AudioContext();
      const buf  = await actx.decodeAudioData(await (await fetch(url)).arrayBuffer());
      await actx.close();
      const durationMs = buf.duration * 1000;
      const startMs    = regionSel.startRatio * durationMs;
      const endMs      = regionSel.endRatio   * durationMs;

      const { cutAudioRegion } = await import('@/lib/audio/splice');
      const result = await cutAudioRegion(url, ts, startMs, endMs);

      // Push current state to undo stack, clear redo stack
      setEditHistory(h => [...h, {
        instrumentalUrl: currentInstrumentalUrl,
        instrumentalTs:  currentWordTimestamps,
        vocalsUrl:       currentVocalsUrl,
      }]);
      setEditFuture([]);

      if (isInst) {
        setCurrentInstrumentalUrl(result.audioUrl);
        setCurrentWordTimestamps(result.wordTimestamps);
      } else {
        setCurrentVocalsUrl(result.audioUrl);
      }
      onTimelineApply?.([{ id: regionSel.trackId, url: result.audioUrl, timestamps: result.wordTimestamps }]);
    } finally {
      setApplyingRegion(false);
      setRegionSel(null);
    }
  };

  // Non-destructive mute: stores a metadata marker, never touches audio data.
  const handleMute = () => {
    if (!regionSel) return;
    const id = Math.random().toString(36).slice(2);
    setMutedRegions(prev => [...prev, {
      id, trackId: regionSel.trackId, startRatio: regionSel.startRatio, endRatio: regionSel.endRatio,
    }]);
    setRegionSel(null);
  };

  // Unmute: removes ALL muted regions that overlap (even partially) with the current selection.
  const handleUnmute = () => {
    if (!regionSel) return;
    setMutedRegions(prev => prev.filter(m =>
      m.trackId !== regionSel.trackId ||
      m.endRatio <= regionSel.startRatio ||
      m.startRatio >= regionSel.endRatio,
    ));
    setRegionSel(null);
  };

  const handleUndo = () => {
    setEditHistory(h => {
      if (h.length === 0) return h;
      const snap = h[h.length - 1];
      setEditFuture(f => [{
        instrumentalUrl: currentInstrumentalUrl,
        instrumentalTs:  currentWordTimestamps,
        vocalsUrl:       currentVocalsUrl,
      }, ...f]);
      setCurrentInstrumentalUrl(snap.instrumentalUrl);
      setCurrentWordTimestamps(snap.instrumentalTs);
      setCurrentVocalsUrl(snap.vocalsUrl);
      setRegionSel(null);
      return h.slice(0, -1);
    });
  };

  const handleRedo = () => {
    setEditFuture(f => {
      if (f.length === 0) return f;
      const snap = f[0];
      setEditHistory(h => [...h, {
        instrumentalUrl: currentInstrumentalUrl,
        instrumentalTs:  currentWordTimestamps,
        vocalsUrl:       currentVocalsUrl,
      }]);
      setCurrentInstrumentalUrl(snap.instrumentalUrl);
      setCurrentWordTimestamps(snap.instrumentalTs);
      setCurrentVocalsUrl(snap.vocalsUrl);
      setRegionSel(null);
      return f.slice(1);
    });
  };

  const handleCopy = async () => {
    if (!regionSel) return;
    setApplyingRegion(true);
    try {
      const isInst = regionSel.trackId === 'instrumental';
      const url    = isInst ? currentInstrumentalUrl : currentVocalsUrl;
      const ts     = isInst ? currentWordTimestamps   : [];

      const actx = new AudioContext();
      const buf  = await actx.decodeAudioData(await (await fetch(url)).arrayBuffer());
      await actx.close();
      const durationMs = buf.duration * 1000;
      const startMs    = regionSel.startRatio * durationMs;
      const endMs      = regionSel.endRatio   * durationMs;

      const { sliceAudioRegion } = await import('@/lib/audio/splice');
      const result = await sliceAudioRegion(url, ts, startMs, endMs);
      setClipboard({ url: result.audioUrl, ts: result.wordTimestamps, trackId: regionSel.trackId });
      setRegionSel(null);
    } finally {
      setApplyingRegion(false);
    }
  };

  const handlePaste = async () => {
    if (!clipboard) return;
    setApplyingRegion(true);
    try {
      const isInst = clipboard.trackId === 'instrumental';
      const url    = isInst ? currentInstrumentalUrl : currentVocalsUrl;
      const ts     = isInst ? currentWordTimestamps   : [];

      setEditHistory(h => [...h, {
        instrumentalUrl: currentInstrumentalUrl,
        instrumentalTs:  currentWordTimestamps,
        vocalsUrl:       currentVocalsUrl,
      }]);
      setEditFuture([]);

      const { insertAudioAtMs } = await import('@/lib/audio/splice');
      const result = await insertAudioAtMs(url, ts, currentTimeMs, clipboard.url, clipboard.ts);

      if (isInst) {
        setCurrentInstrumentalUrl(result.audioUrl);
        setCurrentWordTimestamps(result.wordTimestamps);
      } else {
        setCurrentVocalsUrl(result.audioUrl);
      }
      onTimelineApply?.([{ id: clipboard.trackId, url: result.audioUrl, timestamps: result.wordTimestamps }]);
    } finally {
      setApplyingRegion(false);
    }
  };

  // Keyboard shortcuts: ⌘Z undo, ⌘⇧Z redo, ⌘C copy region, ⌘V paste
  const editActionsRef = useRef({ undo: handleUndo, redo: handleRedo, copy: handleCopy, paste: handlePaste });
  useEffect(() => { editActionsRef.current = { undo: handleUndo, redo: handleRedo, copy: handleCopy, paste: handlePaste }; });
  const undoRedoRef = editActionsRef; // alias kept for single effect below

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) undoRedoRef.current.redo();
        else            undoRedoRef.current.undo();
      } else if (e.key.toLowerCase() === 'c' && !e.shiftKey) {
        // Only intercept ⌘C when there's an active region selection
        const actions = undoRedoRef.current as typeof editActionsRef.current;
        // We don't have direct state access here, so we call copy — it no-ops if no region
        if (document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
          e.preventDefault();
          void actions.copy();
        }
      } else if (e.key.toLowerCase() === 'v' && !e.shiftKey) {
        if (document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
          e.preventDefault();
          void undoRedoRef.current.paste();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ── Mix and save ──────────────────────────────────────────────────────────────
  const mixAndSave = async () => {
    setMixing(true);
    setMixUrl(null);
    try {
      const tracks: { url: string; volume: number }[] = [];
      if (instrumentStems) {
        tracks.push({ url: instrumentStems.drums, volume: drumVolume });
        tracks.push({ url: instrumentStems.bass,  volume: bassVolume  });
        tracks.push({ url: instrumentStems.other, volume: otherVolume });
      } else {
        tracks.push({ url: currentInstrumentalUrl, volume: instVolume });
      }
      if (hasTwoTracks) {
        tracks.push({ url: currentVocalsUrl, volume: vocalsVolume });
      }
      const url = await mixTracksWithVolumes(tracks);
      setMixUrl(url);
    } finally {
      setMixing(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-lg border border-[#e9e9e9] bg-white p-4 flex flex-col gap-4 shadow-[0_2px_8px_rgba(0,0,0,0.06)]">

        {/* Transport header */}
        <div className="flex items-center gap-4">
          {/* Rewind */}
          <button
            onClick={rewind}
            className="w-8 h-8 rounded-full bg-[#e9e9e9] hover:bg-[#d4d4d4] flex items-center justify-center text-[#676767] transition-colors flex-shrink-0"
            aria-label="Rewind to start"
          >
            <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M6 6h2v12H6zm3.5 6 8.5 6V6z" />
            </svg>
          </button>

          {/* Play/Pause */}
          <button
            onClick={toggle}
            className="w-10 h-10 rounded-full bg-[#f37321] hover:bg-[#da6520] flex items-center justify-center text-white transition-colors flex-shrink-0 shadow-[0_2px_6px_rgba(243,115,33,0.4)]"
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

          {/* Zoom controls */}
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

        </div>

        {/* ── All tracks in a single scrollable column ── */}
        <>
            <div ref={waveformScrollRef} style={{ overflowX: waveformZoom > 1 ? 'auto' : 'visible', scrollbarWidth: 'none' }}>
              <div style={{ width: waveformZoom !== 1 ? `${waveformZoom * 100}%` : '100%', minWidth: '100%' }}>
                {(() => {
                  const hasRecordedTakes = (extraVocalTracks?.length ?? 0) > 0;
                  const useMultiTrack    = hasTwoTracks || hasRecordedTakes;

                  if (useMultiTrack) return (
                    <div className="flex flex-col gap-1">
                      {/* Recorded vocal takes — at the top */}
                      {hasRecordedTakes && (
                        <div className="flex flex-col gap-0.5">
                          {/* Takes selector (shown when more than one take) */}
                          {extraVocalTracks!.length > 1 && (
                            <div className="flex items-center gap-1.5 pl-[104px]">
                              <span className="text-[10px] text-[#929292] font-semibold flex-shrink-0">Takes:</span>
                              {extraVocalTracks!.map(t => (
                                <button
                                  key={t.id}
                                  onClick={() => onSelectExtraVocal?.(t.id)}
                                  className={`px-2 py-0.5 rounded text-[10px] font-semibold transition-colors ${
                                    t.id === activeExtraVocalId
                                      ? 'bg-[#f37321] text-white'
                                      : 'bg-white border border-[#bdbdbd] text-[#676767] hover:border-[#f37321] hover:text-[#f37321]'
                                  }`}
                                >
                                  {t.label}
                                </button>
                              ))}
                            </div>
                          )}
                          {/* Active take waveform */}
                          {extraVocalTracks!.filter(t => t.id === activeExtraVocalId).map(track => (
                            <StemTrackRow
                              key={track.id}
                              label={extraVocalTracks!.length > 1 ? 'Vocals' : track.label}
                              audioUrl={track.url}
                              masterPlaying={playing}
                              masterProgress={progress}
                              onAudioRef={el => {
                                if (el) extraVocalAudioRefsMap.current.set(track.id, el);
                                else extraVocalAudioRefsMap.current.delete(track.id);
                              }}
                              onDelete={() => onDeleteVocalsTrack?.(track.id)}
                            />
                          ))}
                        </div>
                      )}

                      {/* Primary AI vocals */}
                      {hasTwoTracks && (
                        <TrackRow
                          label="Vocals"
                          playing={vocIsPlaying}
                          volume={vocalsVolume}
                          onToggle={toggleVocals}
                          onVolumeChange={setVocalsVolume}
                          onRegenerate={onRegenerateVocals}
                          regenerating={regeneratingVocals}
                          onDelete={onDeletePrimaryVocals}
                          downloadUrl={currentVocalsUrl}
                          downloadFilename={`${title}-vocals.wav`}
                        >
                          {vocalsRecordingStream ? (
                            <LiveRecordingWaveform stream={vocalsRecordingStream} progress={progress} />
                          ) : (
                            <SectionedWaveform
                              audioUrl={currentVocalsUrl}
                              sectionMarkers={sectionMarkers}
                              progress={vocIsPlaying ? progress : 0}
                              onSeek={seek}
                              activeSectionIndex={activeSectionIndex}
                              onSectionClick={handleSectionClick}
                              onRegionSelect={(s, e) => setRegionSel({ trackId: 'vocals-primary', startRatio: s, endRatio: e })}
                              selectionRegion={regionSel?.trackId === 'vocals-primary' ? regionSel : null}
                              mutedRegions={mutedRegions.filter(m => m.trackId === 'vocals-primary')}
                              onRegenerateSection={onRegenerateSection}
                              regenMode="vocals"
                              regeneratingSectionIndex={regeneratingSectionIndex}
                              onSliceSection={onSliceSection}
                            />
                          )}
                        </TrackRow>
                      )}

                      {/* Instrumental — hidden once stems have been separated */}
                      {!instrumentStems && (
                        <TrackRow
                          label="Instrumental"
                          playing={instIsPlaying}
                          volume={instVolume}
                          onToggle={toggleInst}
                          onVolumeChange={setInstVolume}
                          onRegenerate={onRegenerateInstrumental}
                          regenerating={regeneratingInstrumental}
                          downloadUrl={currentInstrumentalUrl}
                          downloadFilename={`${title}-instrumental.wav`}
                        >
                          <SectionedWaveform
                            audioUrl={currentInstrumentalUrl}
                            sectionMarkers={sectionMarkers}
                            progress={instIsPlaying ? progress : 0}
                            onSeek={seek}
                            activeSectionIndex={activeSectionIndex}
                            onSectionClick={handleSectionClick}
                            onDurationReady={handleDurationReady}
                            onBeatPhaseReady={handleBeatPhaseReady}
                            tempo={tempo}
                            onRegionSelect={(s, e) => setRegionSel({ trackId: 'instrumental', startRatio: s, endRatio: e })}
                            selectionRegion={regionSel?.trackId === 'instrumental' ? regionSel : null}
                            mutedRegions={mutedRegions.filter(m => m.trackId === 'instrumental')}
                            onRegenerateSection={onRegenerateSection}
                            regenMode="instrumental"
                            regeneratingSectionIndex={regeneratingSectionIndex}
                            onSliceSection={onSliceSection}
                            onFadeOutSection={onFadeOutSection}
                          />
                        </TrackRow>
                      )}

                      {/* Stem rows */}
                      {instrumentStems && (
                        <>
                          <StemTrackRow label={stemLabels?.drums ?? 'Drums'} audioUrl={instrumentStems.drums} volume={drumVolume}  onVolumeChange={setDrumVolume}  onAudioRef={el => { drumAudioRef.current  = el; }} masterPlaying={playing} masterProgress={progress} />
                          <StemTrackRow label={stemLabels?.bass  ?? 'Bass'}  audioUrl={instrumentStems.bass}  volume={bassVolume}  onVolumeChange={setBassVolume}  onAudioRef={el => { bassAudioRef.current  = el; }} masterPlaying={playing} masterProgress={progress} />
                          <StemTrackRow label={stemLabels?.other ?? 'Other'} audioUrl={instrumentStems.other} volume={otherVolume} onVolumeChange={setOtherVolume} onAudioRef={el => { otherAudioRef.current = el; }} masterPlaying={playing} masterProgress={progress} />
                          {otherStemSplit ? (
                            <div className="ml-5 border-l-2 border-[#e9e9e9] pl-3 flex flex-col gap-0">
                              <StemTrackRow label="Vocals"      audioUrl={otherStemSplit.vocals}       volume={other2VocalsVol} onVolumeChange={setOther2VocalsVol} onAudioRef={el => { other2VocalsRef.current = el; }} masterPlaying={playing} masterProgress={progress} />
                              <StemTrackRow label="Instruments" audioUrl={otherStemSplit.instrumental} volume={other2InstVol}   onVolumeChange={setOther2InstVol}   onAudioRef={el => { other2InstRef.current   = el; }} masterPlaying={playing} masterProgress={progress} />
                            </div>
                          ) : onSeparateOtherStem && (
                            <div className="flex justify-end pr-1">
                              <button
                                onClick={onSeparateOtherStem}
                                disabled={separatingOtherStem}
                                className="text-[10px] font-semibold text-[#929292] hover:text-[#f37321] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                              >
                                {separatingOtherStem ? 'Separating…' : 'Extract vocals from Other ↻'}
                              </button>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  );

                  // Single-track (no vocals, no recorded takes)
                  return (
                    <div className="flex items-center gap-2">
                      <div className="flex-1 min-w-0">
                        <SectionedWaveform
                          audioUrl={currentInstrumentalUrl}
                          sectionMarkers={sectionMarkers}
                          progress={progress}
                          onSeek={seek}
                          activeSectionIndex={activeSectionIndex}
                          onSectionClick={handleSectionClick}
                          onDurationReady={handleDurationReady}
                          onBeatPhaseReady={handleBeatPhaseReady}
                          tempo={tempo}
                          onRegionSelect={(s, e) => setRegionSel({ trackId: 'instrumental', startRatio: s, endRatio: e })}
                          selectionRegion={regionSel?.trackId === 'instrumental' ? regionSel : null}
                          mutedRegions={mutedRegions.filter(m => m.trackId === 'instrumental')}
                          onRegenerateSection={onRegenerateSection}
                          regeneratingSectionIndex={regeneratingSectionIndex}
                          onSliceSection={onSliceSection}
                          onFadeOutSection={onFadeOutSection}
                        />
                      </div>
                      <a
                        href={currentInstrumentalUrl}
                        download={`${title}.wav`}
                        title="Download"
                        className="w-6 h-6 flex items-center justify-center rounded text-[#bdbdbd] hover:text-[#f37321] transition-colors flex-shrink-0"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                        </svg>
                      </a>
                    </div>
                  );
                })()}
              </div>
            </div>

            {/* ── Divider then buttons ── */}
            <div className="border-t border-[#e9e9e9] pt-3 flex flex-col gap-3">
              <div className="flex items-center gap-2 justify-end flex-wrap">
                {vocalsUrl ? (
                  onRejoinTracks && (
                    <button
                      onClick={onRejoinTracks}
                      className="px-4 py-1.5 rounded-lg border border-[#bdbdbd] text-[#676767] hover:border-[#f37321] hover:text-[#f37321] text-sm font-semibold transition-colors"
                    >
                      Rejoin Tracks
                    </button>
                  )
                ) : (
                  onSplitTracks && (
                    <button
                      onClick={onSplitTracks}
                      disabled={splitting}
                      className="px-4 py-1.5 rounded-lg border border-[#bdbdbd] text-[#676767] hover:border-[#f37321] hover:text-[#f37321] disabled:opacity-40 disabled:cursor-not-allowed text-sm font-semibold transition-colors"
                    >
                      {splitting ? 'Splitting…' : 'Split into tracks'}
                    </button>
                  )
                )}
                {vocalsUrl && onSeparateInstruments && (
                  <button
                    onClick={onSeparateInstruments}
                    disabled={separatingInstruments}
                    className="px-4 py-1.5 rounded-lg border border-[#bdbdbd] text-[#676767] hover:border-[#f37321] hover:text-[#f37321] disabled:opacity-40 disabled:cursor-not-allowed text-sm font-semibold transition-colors"
                  >
                    {separatingInstruments ? 'Separating…' : instrumentStems ? 'Re-separate instruments' : 'Separate instruments'}
                  </button>
                )}
                {mixUrl && (
                  <a
                    href={mixUrl}
                    download={`${title}-mix.wav`}
                    className="text-xs text-[#f37321] hover:text-[#da6520] font-semibold transition-colors"
                  >
                    ↓ Download Mix
                  </a>
                )}
                {instrumentStems && (drumVolume !== 0.8 || bassVolume !== 0.8 || otherVolume !== 0.8 || (hasTwoTracks && vocalsVolume !== 0.9)) && (
                  <button
                    onClick={mixAndSave}
                    disabled={mixing}
                    className="px-4 py-1.5 rounded-lg border border-[#bdbdbd] text-[#676767] hover:border-[#f37321] hover:text-[#f37321] disabled:opacity-40 disabled:cursor-not-allowed text-sm font-semibold transition-colors"
                  >
                    {mixing ? 'Mixing…' : 'Mix and Save Track'}
                  </button>
                )}
              </div>
            </div>
        </>

        {/* Edit action bar — visible whenever there is history, a clipboard, or an active selection */}
        {(editHistory.length > 0 || editFuture.length > 0 || clipboard || regionSel) && (
          <div className="flex items-center gap-1.5 bg-[#fff8f3] border border-[#ffd5b8] rounded-lg px-3 py-2 -mt-2 flex-wrap">
            {/* Undo / Redo */}
            <button
              disabled={editHistory.length === 0}
              onClick={handleUndo}
              title="Undo (⌘Z)"
              className="px-2.5 py-1 text-xs bg-white border border-[#e9e9e9] text-[#676767] hover:border-[#f37321] hover:text-[#f37321] rounded font-medium disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >↩ Undo</button>
            <button
              disabled={editFuture.length === 0}
              onClick={handleRedo}
              title="Redo (⌘⇧Z)"
              className="px-2.5 py-1 text-xs bg-white border border-[#e9e9e9] text-[#676767] hover:border-[#f37321] hover:text-[#f37321] rounded font-medium disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >↪ Redo</button>
            {/* Paste — shown when clipboard has content */}
            {clipboard && (<>
              <div className="w-px h-4 bg-[#ffd5b8] mx-0.5" />
              <button
                disabled={applyingRegion}
                onClick={() => void handlePaste()}
                title="Paste at playhead (⌘V)"
                className="px-2.5 py-1 text-xs bg-white border border-[#e9e9e9] text-[#676767] hover:border-[#f37321] hover:text-[#f37321] rounded font-medium disabled:opacity-40 transition-colors"
              >{applyingRegion ? 'Pasting…' : '⎘ Paste at playhead'}</button>
              <button
                onClick={() => setClipboard(null)}
                title="Clear clipboard"
                className="px-1.5 py-1 text-[10px] text-[#bdbdbd] hover:text-[#929292] font-medium"
              >clear</button>
            </>)}
            {/* Region actions — only when a selection is active */}
            {regionSel && (() => {
              const selOverlapsMuted = mutedRegions.some(m =>
                m.trackId === regionSel.trackId &&
                m.startRatio < regionSel.endRatio &&
                m.endRatio   > regionSel.startRatio,
              );
              return (<>
                <div className="w-px h-4 bg-[#ffd5b8] mx-0.5" />
                <span className="text-[11px] text-[#929292]">Selection:</span>
                <button
                  disabled={applyingRegion}
                  onClick={() => void handleCopy()}
                  title="Copy selection (⌘C)"
                  className="px-2.5 py-1 text-xs bg-white border border-[#e9e9e9] text-[#676767] hover:border-[#f37321] hover:text-[#f37321] rounded font-medium disabled:opacity-40 transition-colors"
                >Copy</button>
                <button
                  disabled={applyingRegion}
                  onClick={() => void handleRegionApply('cut')}
                  className="px-2.5 py-1 text-xs bg-white border border-[#e9e9e9] text-[#676767] hover:border-[#f37321] hover:text-[#f37321] rounded font-medium disabled:opacity-40 transition-colors"
                >Cut</button>
                <button
                  onClick={handleMute}
                  className="px-2.5 py-1 text-xs bg-white border border-[#e9e9e9] text-[#676767] hover:border-[#f37321] hover:text-[#f37321] rounded font-medium transition-colors"
                >Mute</button>
                {selOverlapsMuted && (
                  <button
                    onClick={handleUnmute}
                    className="px-2.5 py-1 text-xs bg-white border border-[#e9e9e9] text-[#676767] hover:border-[#f37321] hover:text-[#f37321] rounded font-medium transition-colors"
                  >Unmute</button>
                )}
                <button
                  onClick={() => setRegionSel(null)}
                  className="px-1.5 py-1 text-xs text-[#929292] hover:text-[#3b3b3b] font-medium ml-auto"
                >✕</button>
              </>);
            })()}
          </div>
        )}

        {/* Hidden audio elements — use playback URLs so muted regions are silenced */}
        <audio
          ref={audioRef}
          src={playbackInstUrl}
          onEnded={onEnded}
          preload="auto"
          style={{ display: 'none' }}
        />
        {hasTwoTracks && (
          <audio
            ref={vocalsRef}
            src={playbackVocalsUrl}
            onEnded={() => { setVocalsSolo(false); if (vocalsRef.current) vocalsRef.current.currentTime = 0; }}
            preload="auto"
            style={{ display: 'none' }}
          />
        )}
      </div>

      {currentWordTimestamps.length > 0 && (
        <div className="rounded-lg border border-[#e9e9e9] bg-white px-5 pt-3 pb-2 shadow-[0_2px_8px_rgba(0,0,0,0.06)]">
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

// ── SectionedWaveform — audio split into per-section draggable chunk boxes ────

const SECTIONED_PEAKS = 3000;

function SectionedWaveform({
  audioUrl, sectionMarkers, progress, onSeek, activeSectionIndex,
  onSectionClick, onDurationReady, onBeatPhaseReady, tempo,
  onRegionSelect, selectionRegion, mutedRegions,
  onRegenerateSection, regenMode, regeneratingSectionIndex, onSliceSection, onFadeOutSection,
}: {
  audioUrl: string;
  sectionMarkers: { ratio: number; label: string }[];
  progress: number;
  onSeek: (ratio: number) => void;
  activeSectionIndex?: number | null;
  onSectionClick?: (index: number) => void;
  onDurationReady?: (ms: number) => void;
  onBeatPhaseReady?: (ms: number) => void;
  tempo?: number;
  /** Called when user drag-selects a region. startRatio/endRatio are 0–1. */
  onRegionSelect?: (startRatio: number, endRatio: number) => void;
  /** Committed selection to highlight (0–1 ratios). */
  selectionRegion?: { startRatio: number; endRatio: number } | null;
  /** Non-destructive muted regions to render as grey overlays. */
  mutedRegions?: { startRatio: number; endRatio: number }[];
  onRegenerateSection?: (index: number, mode: 'both' | 'vocals' | 'instrumental') => void;
  /** When set, skip the popover and fire onRegenerateSection with this mode directly. */
  regenMode?: 'both' | 'vocals' | 'instrumental';
  regeneratingSectionIndex?: number | null;
  onSliceSection?: (index: number, localRatio: number) => void;
  onFadeOutSection?: (index: number) => void;
}) {
  const [peaks,            setPeaks]            = useState<number[]>([]);
  const [loading,          setLoading]          = useState(true);
  const [localDurationMs,  setLocalDurationMs]  = useState(0);
  const [localBeatPhaseMs, setLocalBeatPhaseMs] = useState(0);
  /** Live drag-in-progress highlight, cleared on mouseup. */
  const [liveSel, setLiveSel] = useState<{ startRatio: number; endRatio: number } | null>(null);
  /** Index of the section whose regen popover is open, or null. */
  const [regenPopoverIndex, setRegenPopoverIndex] = useState<number | null>(null);
  /** Index of section currently in slice mode, or null. */
  const [slicingIndex, setSlicingIndex] = useState<number | null>(null);
  /** Cursor position (0–1 local ratio) while hovering in slice mode. */
  const [sliceHover, setSliceHover] = useState<number | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const selDragRef   = useRef<{ startX: number; startRatio: number } | null>(null);

  const getContainerRatio = (clientX: number) => {
    if (!containerRef.current) return 0;
    const rect = containerRef.current.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  };

  // Beat positions across the full track, starting from the detected beat phase.
  // Beat 0 is at localBeatPhaseMs (the first downbeat); subsequent beats increment by beatMs.
  const beatRatios = useMemo(() => {
    if (!tempo || localDurationMs <= 0) return [] as { ratio: number; beatIndex: number }[];
    const beatMs = 60000 / tempo;
    const beats: { ratio: number; beatIndex: number }[] = [];
    let i = 0;
    while (true) {
      const ms    = localBeatPhaseMs + i * beatMs;
      const ratio = ms / localDurationMs;
      if (ratio > 1.001) break;
      if (ratio >= 0) beats.push({ ratio: Math.min(ratio, 1), beatIndex: i });
      i++;
    }
    return beats;
  }, [tempo, localDurationMs, localBeatPhaseMs]);

  // Snap a 0–1 ratio to the nearest beat; Alt key bypasses snapping.
  const snapToGrid = (ratio: number, bypass: boolean) => {
    if (bypass || beatRatios.length === 0) return ratio;
    let closestRatio = beatRatios[0].ratio;
    let minDist      = Math.abs(ratio - closestRatio);
    for (const b of beatRatios) {
      const d = Math.abs(ratio - b.ratio);
      if (d < minDist) { minDist = d; closestRatio = b.ratio; }
    }
    return closestRatio;
  };

  // Close slice mode and regen popover on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setSlicingIndex(null); setSliceHover(null); setRegenPopoverIndex(null); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const actx = new AudioContext();
        const audio = await actx.decodeAudioData(await (await fetch(audioUrl)).arrayBuffer());
        await actx.close();
        if (cancelled) return;
        const data  = audio.getChannelData(0);
        const block = Math.floor(data.length / SECTIONED_PEAKS);
        const ps: number[] = [];
        for (let i = 0; i < SECTIONED_PEAKS; i++) {
          let max = 0;
          for (let j = 0; j < block; j++) { const v = Math.abs(data[i * block + j]); if (v > max) max = v; }
          ps.push(max);
        }
        setPeaks(ps);
        const durMs = audio.duration * 1000;
        onDurationReady?.(durMs);
        setLocalDurationMs(durMs);
        if (tempo) {
          const phaseMs = detectBeatPhaseMs(audio, tempo);
          setLocalBeatPhaseMs(phaseMs);
          onBeatPhaseReady?.(phaseMs);
        }
        setLoading(false);
      } catch { setLoading(false); }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioUrl]);

  if (loading) {
    return <div className="h-[68px] flex items-center justify-center text-xs text-[#929292]">Loading waveform…</div>;
  }

  if (sectionMarkers.length === 0) {
    return (
      <div className="rounded-lg border-2 border-[#e9e9e9] overflow-hidden">
        <ChunkCanvas peaks={peaks} progress={progress} isActive={false} />
      </div>
    );
  }

  const globalRatio = progress / 100;
  // Show the live drag highlight while dragging, otherwise the committed selection
  const displaySel  = liveSel ?? selectionRegion ?? null;

  return (
    <div className="flex flex-col w-full min-w-0">
    {/* Transparent backdrop — closes regen popover on outside click */}
    {regenPopoverIndex !== null && (
      <div className="fixed inset-0 z-40" onClick={() => setRegenPopoverIndex(null)} />
    )}
    <div
      ref={containerRef}
      className="flex gap-1 items-stretch w-full min-w-0 relative select-none"
      onMouseDown={onRegionSelect ? e => {
        if (slicingIndex !== null) return; // don't start region-select while in slice mode
        const snapped = snapToGrid(getContainerRatio(e.clientX), e.altKey);
        selDragRef.current = { startX: e.clientX, startRatio: snapped };
        setLiveSel(null);
      } : undefined}
      onMouseMove={onRegionSelect ? e => {
        if (!selDragRef.current) return;
        if (Math.abs(e.clientX - selDragRef.current.startX) < 4) return;
        const r = snapToGrid(getContainerRatio(e.clientX), e.altKey);
        setLiveSel({
          startRatio: Math.min(selDragRef.current.startRatio, r),
          endRatio:   Math.max(selDragRef.current.startRatio, r),
        });
      } : undefined}
      onMouseUp={onRegionSelect ? e => {
        if (!selDragRef.current) return;
        const dx       = Math.abs(e.clientX - selDragRef.current.startX);
        const endRatio = snapToGrid(getContainerRatio(e.clientX), e.altKey);
        const { startRatio } = selDragRef.current;
        selDragRef.current = null;
        setLiveSel(null);
        if (dx >= 8 && Math.abs(endRatio - startRatio) >= 0.005) {
          onRegionSelect(Math.min(startRatio, endRatio), Math.max(startRatio, endRatio));
        }
      } : undefined}
      onMouseLeave={() => {
        if (selDragRef.current) { selDragRef.current = null; setLiveSel(null); }
      }}
    >
      {/* Muted region overlays — grey hatching, pointer-events:none */}
      {mutedRegions?.map((m, mi) => (
        <div
          key={mi}
          className="absolute top-0 bottom-0 pointer-events-none z-10"
          style={{
            left:       `${m.startRatio * 100}%`,
            width:      `${(m.endRatio - m.startRatio) * 100}%`,
            background: 'repeating-linear-gradient(45deg, rgba(0,0,0,0.08) 0px, rgba(0,0,0,0.08) 4px, transparent 4px, transparent 8px)',
            borderLeft:  '1.5px solid rgba(0,0,0,0.15)',
            borderRight: '1.5px solid rgba(0,0,0,0.15)',
          }}
        />
      ))}
      {/* Selection highlight — pointer-events:none so it never blocks clicks/seeks */}
      {displaySel && (
        <div
          className="absolute top-0 bottom-0 bg-blue-400/20 border-x-2 border-blue-400/50 pointer-events-none z-20 rounded"
          style={{
            left:  `${displaySel.startRatio * 100}%`,
            width: `${(displaySel.endRatio - displaySel.startRatio) * 100}%`,
          }}
        />
      )}
      {sectionMarkers.map((marker, i) => {
        const startR    = marker.ratio;
        const endR      = sectionMarkers[i + 1]?.ratio ?? 1;
        const chunkSpan = endR - startR;
        const slice     = peaks.slice(Math.floor(startR * peaks.length), Math.ceil(endR * peaks.length));

        let chunkProg = -1;
        if (globalRatio >= startR && globalRatio <= endR) {
          chunkProg = chunkSpan > 0 ? ((globalRatio - startR) / chunkSpan) * 100 : 0;
        }

        // Beat grid lines that fall within this chunk, mapped to local (0–1) ratio
        const chunkBeats = beatRatios
          .filter(b => b.ratio >= startR && b.ratio <= endR)
          .map(b => ({
            localRatio: chunkSpan > 0 ? (b.ratio - startR) / chunkSpan : 0,
            isBar:      b.beatIndex % 4 === 0,
          }));

        const isActive = activeSectionIndex === i;
        const widthPct = chunkSpan * 100;

        return (
          <div
            key={i}
            className="relative group"
            style={{ flexBasis: `${widthPct}%`, flexGrow: widthPct, flexShrink: 0, minWidth: 0 }}
          >
            {/* Main chunk box */}
            <div
              className={`rounded-lg border-2 overflow-hidden transition-all duration-150 ${
                slicingIndex === i
                  ? 'border-[#f37321] bg-[#fff8f3]'
                  : isActive
                    ? 'border-[#f37321] bg-[#fff8f3]'
                    : 'border-[#e9e9e9] bg-white hover:border-[#bdbdbd]'
              }`}
              onClick={e => {
                if (slicingIndex === i) return;
                onSectionClick?.(i);
                onSeek(startR);
              }}
              onDoubleClick={onRegionSelect && slicingIndex === null ? e => {
                e.stopPropagation();
                onRegionSelect(startR, endR);
              } : undefined}
            >
              {/* Header: label + action buttons */}
              <div className="px-1.5 pt-0.5 pb-0 flex items-center justify-between">
                <span className={`text-[9px] font-bold uppercase tracking-wide leading-none truncate ${
                  isActive ? 'text-[#f37321]' : 'text-[#929292]'
                }`}>{marker.label}</span>
                {(onRegenerateSection || onFadeOutSection) && (
                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0 ml-0.5">
                    {/* Fade-out icon — last section only */}
                    {onFadeOutSection && i === sectionMarkers.length - 1 && (
                      <button
                        type="button"
                        title="Fade out last 2 beats"
                        onClick={e => { e.stopPropagation(); onFadeOutSection(i); }}
                        className="p-0.5 rounded hover:bg-black/10 transition-colors text-[#929292]"
                      >
                        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                          <line x1="2" y1="4" x2="14" y2="4"/>
                          <line x1="2" y1="8" x2="11" y2="8"/>
                          <line x1="2" y1="12" x2="7" y2="12"/>
                        </svg>
                      </button>
                    )}
                    {/* Scissors / slice icon */}
                    {onSliceSection && (
                      <button
                        type="button"
                        title={slicingIndex === i ? 'Cancel slice (Esc)' : 'Slice section'}
                        onClick={e => {
                          e.stopPropagation();
                          setSlicingIndex(slicingIndex === i ? null : i);
                          setSliceHover(null);
                        }}
                        className={`p-0.5 rounded hover:bg-black/10 transition-colors ${
                          slicingIndex === i ? 'text-[#f37321]' : 'text-[#929292]'
                        }`}
                      >
                        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="4" cy="4" r="2.5"/>
                          <circle cx="4" cy="12" r="2.5"/>
                          <line x1="6.5" y1="5.5" x2="14" y2="13.5"/>
                          <line x1="6.5" y1="10.5" x2="14" y2="2.5"/>
                        </svg>
                      </button>
                    )}
                    {/* Regenerate icon */}
                    <button
                      type="button"
                      title={regenMode ? `Regenerate ${regenMode}` : 'Regenerate section'}
                      onClick={e => {
                        e.stopPropagation();
                        if (regenMode) {
                          onRegenerateSection?.(i, regenMode);
                        } else {
                          setRegenPopoverIndex(regenPopoverIndex === i ? null : i);
                        }
                      }}
                      className={`p-0.5 rounded hover:bg-black/10 transition-colors ${
                        regeneratingSectionIndex === i ? 'text-[#f37321]' : 'text-[#929292]'
                      }`}
                    >
                      <svg
                        width="10" height="10" viewBox="0 0 16 16" fill="none"
                        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
                        className={regeneratingSectionIndex === i ? 'animate-spin' : ''}
                      >
                        <path d="M13.5 2.5A7 7 0 1 1 6.5 1"/>
                        <polyline points="6.5 1 6.5 4.5 10 4.5"/>
                      </svg>
                    </button>
                  </div>
                )}
              </div>
              {/* Per-section waveform — slice mode intercepts mouse events */}
              <div
                className={slicingIndex === i ? 'relative cursor-crosshair' : 'relative'}
                onMouseMove={slicingIndex === i ? e => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  setSliceHover(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)));
                } : undefined}
                onMouseLeave={slicingIndex === i ? () => setSliceHover(null) : undefined}
                onClick={slicingIndex === i ? e => {
                  e.stopPropagation();
                  const rect = e.currentTarget.getBoundingClientRect();
                  const localR = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                  onSliceSection?.(i, localR);
                  setSlicingIndex(null);
                  setSliceHover(null);
                } : undefined}
              >
                {/* Slice hover line */}
                {slicingIndex === i && sliceHover !== null && (
                  <div
                    className="absolute top-0 bottom-0 w-0.5 bg-[#f37321] pointer-events-none z-10"
                    style={{ left: `${sliceHover * 100}%` }}
                  />
                )}
                <ChunkCanvas
                  peaks={slice}
                  progress={chunkProg}
                  isActive={isActive}
                  beats={chunkBeats}
                  onSeek={slicingIndex !== i ? r => { onSectionClick?.(i); onSeek(startR + r * (endR - startR)); } : undefined}
                />
              </div>
            </div>
            {/* Regen mode popover — outside overflow-hidden so it can float above siblings */}
            {regenPopoverIndex === i && (
              <div className="absolute top-0 right-0 z-50 mt-1 mr-1 bg-white rounded-lg shadow-lg border border-[#e9e9e9] py-1 text-xs min-w-[140px]">
                {(['both', 'vocals', 'instrumental'] as const).map(mode => (
                  <button
                    key={mode}
                    type="button"
                    onClick={e => {
                      e.stopPropagation();
                      onRegenerateSection?.(i, mode);
                      setRegenPopoverIndex(null);
                    }}
                    className="w-full text-left px-3 py-1.5 hover:bg-[#fff8f3] hover:text-[#f37321] transition-colors"
                  >
                    {mode === 'both' ? 'Both (default)' : mode === 'vocals' ? 'Vocals only' : 'Instrumental only'}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
    {/* Bar numbers strip — positioned globally across the full track width */}
    {beatRatios.some(b => b.beatIndex % 4 === 0) && (
      <div className="relative h-3 pointer-events-none select-none">
        {beatRatios.filter(b => b.beatIndex % 4 === 0).map((b, bi) => (
          <span
            key={bi}
            className="absolute top-0.5 text-[8px] font-semibold leading-none -translate-x-1/2 text-[#bdbdbd]"
            style={{ left: `${b.ratio * 100}%` }}
          >
            {Math.floor(b.beatIndex / 4) + 1}
          </span>
        ))}
      </div>
    )}
    </div>
  );
}

function ChunkCanvas({ peaks, progress, isActive, onSeek, beats }: {
  peaks: number[];
  progress: number; // 0–100 within this chunk, or -1 if playhead is outside
  isActive: boolean;
  onSeek?: (ratio: number) => void;
  beats?: { localRatio: number; isBar: boolean }[];
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || peaks.length === 0) return;
    const dpr  = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    const pw = Math.round(cssW * dpr);
    const ph = Math.round(cssH * dpr);
    if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    // Beat grid — drawn first so waveform bars render on top
    if (beats && beats.length > 0) {
      for (const { localRatio, isBar } of beats) {
        const x = localRatio * cssW;
        ctx.fillStyle = isBar ? 'rgba(0,0,0,0.13)' : 'rgba(0,0,0,0.05)';
        ctx.fillRect(Math.floor(x), 0, 1, cssH);
      }
    }

    const mid = cssH / 2;
    const bw  = cssW / peaks.length;
    const bf  = bw < 1.5 ? bw : bw * 0.72;
    const px  = progress >= 0 ? (progress / 100) * cssW : -1;
    for (let i = 0; i < peaks.length; i++) {
      const x  = (i / peaks.length) * cssW;
      const bh = Math.max(1, peaks[i] * cssH * 0.85);
      ctx.fillStyle = (px >= 0 && x < px) ? '#f37321' : (isActive ? '#f5c299' : '#d4d4d4');
      ctx.fillRect(x, mid - bh / 2, bf, bh);
    }
    if (px >= 0) {
      ctx.fillStyle = '#f37321';
      ctx.fillRect(Math.min(px, cssW - 1.5), 0, 1.5, cssH);
    }
  }, [peaks, progress, isActive, beats]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: '100%', height: 52, display: 'block' }}
      className={onSeek ? 'cursor-pointer' : undefined}
      onClick={e => {
        if (!onSeek) return;
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        onSeek((e.clientX - r.left) / r.width);
      }}
    />
  );
}

// ── StemTrackRow — playback for an individual stem ────────────────────────────
// Registers its audio element with the parent via onAudioRef so the master
// transport can control all stems simultaneously.

function StemTrackRow({ label, audioUrl, volume: volumeProp, onVolumeChange, onAudioRef, masterPlaying, masterProgress, onDelete, editOverlay }: {
  label: string;
  audioUrl: string;
  volume?: number;
  onVolumeChange?: (v: number) => void;
  onAudioRef?: (el: HTMLAudioElement | null) => void;
  masterPlaying?: boolean;
  masterProgress?: number;
  onDelete?: () => void;
  editOverlay?: React.ReactNode;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [soloPlaying, setSoloPlaying] = useState(false);
  const [progress,    setProgress]    = useState(0);
  const [localVolume, setLocalVolume] = useState(0.8);

  const volume    = volumeProp ?? localVolume;
  const setVolume = (v: number) => { setLocalVolume(v); onVolumeChange?.(v); };

  useEffect(() => { if (audioRef.current) audioRef.current.volume = volume; }, [volume]);

  // When master plays, clear solo state (master is now in control)
  useEffect(() => { if (masterPlaying) setSoloPlaying(false); }, [masterPlaying]);

  const toggle = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (soloPlaying) { audio.pause(); setSoloPlaying(false); }
    else { audio.volume = volume; await audio.play(); setSoloPlaying(true); }
  };

  const seek = (ratio: number) => {
    const audio = audioRef.current;
    if (!audio || !isFinite(audio.duration)) return;
    audio.currentTime = ratio * audio.duration;
    setProgress(ratio * 100);
  };

  const isPlaying = masterPlaying || soloPlaying;

  // When master is playing, use the master's progress to keep playheads aligned.
  // Local RAF progress is only used when soloing this stem independently.
  const displayProgress = (masterPlaying && masterProgress !== undefined) ? masterProgress : progress;

  // 60fps progress loop for this stem track (only needed for solo mode)
  useEffect(() => {
    let rafId: number | null = null;
    const tick = () => {
      const a = audioRef.current;
      if (a && !a.paused && isFinite(a.duration) && a.duration > 0) {
        setProgress((a.currentTime / a.duration) * 100);
      }
      rafId = requestAnimationFrame(tick);
    };
    if (isPlaying) { rafId = requestAnimationFrame(tick); }
    return () => { if (rafId !== null) cancelAnimationFrame(rafId); };
  }, [isPlaying]);

  return (
    <>
      <TrackRow label={label} playing={isPlaying} volume={volume} onToggle={toggle} onVolumeChange={setVolume} onDelete={onDelete}>
        <div className="relative w-full">
          <Waveform audioUrl={audioUrl} progress={displayProgress} onSeek={seek} />
          {editOverlay}
        </div>
      </TrackRow>
      <audio
        ref={el => { (audioRef as React.MutableRefObject<HTMLAudioElement | null>).current = el; onAudioRef?.(el); }}
        src={audioUrl}
        preload="auto"
        style={{ display: 'none' }}
        onEnded={() => setSoloPlaying(false)}
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
  onDelete?: () => void;
  downloadUrl?: string;
  downloadFilename?: string;
  children: React.ReactNode; // waveform
}

function TrackRow({ label, playing, volume, onToggle, onVolumeChange, onRegenerate, regenerating, onDelete, downloadUrl, downloadFilename, children }: TrackRowProps) {
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

      {/* Regenerate — icon only */}
      {onRegenerate && (
        <button
          onClick={onRegenerate}
          disabled={regenerating}
          title={`Regenerate ${label}`}
          className="w-6 h-6 flex items-center justify-center rounded text-[#bdbdbd] hover:text-[#f37321] hover:bg-[#fff3eb] disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex-shrink-0"
        >
          {regenerating ? (
            <span className="inline-block w-3 h-3 rounded-full border-2 border-[#bdbdbd] border-t-[#f37321] animate-spin" />
          ) : (
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          )}
        </button>
      )}

      {/* Download */}
      {downloadUrl && (
        <a
          href={downloadUrl}
          download={downloadFilename}
          title={`Download ${label}`}
          className="w-6 h-6 flex items-center justify-center rounded text-[#bdbdbd] hover:text-[#f37321] transition-colors flex-shrink-0"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
        </a>
      )}

      {/* Delete — always reserve space so all rows have identical waveform widths */}
      <button
        onClick={onDelete}
        title={`Delete ${label}`}
        disabled={!onDelete}
        className={`w-6 h-6 flex items-center justify-center rounded text-[#bdbdbd] hover:text-red-500 hover:bg-red-50 transition-colors flex-shrink-0 ${!onDelete ? 'invisible' : ''}`}
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
        </svg>
      </button>
    </div>
  );
}

