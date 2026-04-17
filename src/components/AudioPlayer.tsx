'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SongSection, WordTimestamp } from '@/lib/types';
import { spliceSection, spliceVocals } from '@/lib/audio/splice';
import { snapSectionsToPhrases, trimToDownbeat } from '@/lib/audio/beatDetect';
import { mixTracksWithVolumes, encodeWav } from '@/lib/audio/mix';
import LyricsDisplay from './LyricsDisplay';
import Waveform from './Waveform';
import LiveRecordingWaveform from './LiveRecordingWaveform';
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
  instrumentalOnly?: boolean;
  sectionStartMs?: number;
  sectionEndMs?: number;
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
  onSpliceComplete?: (instrumentalUrl: string, vocalsUrl: string | undefined, timestamps: WordTimestamp[], sectionIndex: number, newSectionStartMs: number, newSectionEndMs: number) => void;
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
  playTrigger?: number;  // increment to programmatically start playback
  pauseTrigger?: number; // increment to programmatically pause playback
  playSectionRequest?: { index: number; seq: number }; // seek + play a specific section
  vocalsRecordingStream?: MediaStream | null; // live mic stream while recording vocals
  extraVocalTracks?: { id: string; url: string; label: string }[];
  onDeleteVocalsTrack?: (id: string) => void; // delete a recorded vocal take
  onDeletePrimaryVocals?: () => void;          // delete the primary AI/split vocals track
  activeExtraVocalId?: string | null;
  onSelectExtraVocal?: (id: string) => void;
}

export default function AudioPlayer({
  audioUrl, vocalsUrl, title, sections, wordTimestamps, tempo,
  pendingRegeneration, onRegenerationComplete, onSpliceComplete, onActiveSectionChange,
  onRegenerateVocals, onRegenerateInstrumental, regeneratingVocals, regeneratingInstrumental,
  instrumentStems, stemLabels, onSeparateInstruments, separatingInstruments,
  onSplitTracks, onRejoinTracks, splitting,
  otherStemSplit, onSeparateOtherStem, separatingOtherStem,
  playTrigger,
  pauseTrigger,
  playSectionRequest,
  vocalsRecordingStream,
  extraVocalTracks,
  onDeleteVocalsTrack,
  onDeletePrimaryVocals,
  activeExtraVocalId,
  onSelectExtraVocal,
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
  const [splicing,     setSplicing]     = useState(false);
  const [instVolume,   setInstVolume]   = useState(0.75);
  const [vocalsVolume, setVocalsVolume] = useState(0.9);
  const [drumVolume,    setDrumVolume]    = useState(0.8);
  const [bassVolume,    setBassVolume]    = useState(0.8);
  const [otherVolume,   setOtherVolume]   = useState(0.8);
  const [other2VocalsVol, setOther2VocalsVol] = useState(0.8);
  const [other2InstVol,   setOther2InstVol]   = useState(0.8);
  const [mixing,       setMixing]       = useState(false);
  const [mixUrl,       setMixUrl]       = useState<string | null>(null);

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
  const rafRef                     = useRef<number | null>(null);

  useEffect(() => { currentInstrumentalUrlRef.current = currentInstrumentalUrl; }, [currentInstrumentalUrl]);
  useEffect(() => { currentVocalsUrlRef.current       = currentVocalsUrl; },       [currentVocalsUrl]);
  useEffect(() => { currentWordTimestampsRef.current  = currentWordTimestamps; },  [currentWordTimestamps]);
  useEffect(() => { audioDurationMsRef.current        = audioDurationMs; },        [audioDurationMs]);
  useEffect(() => { instVolumeRef.current             = instVolume; },             [instVolume]);
  useEffect(() => { vocalsVolumeRef.current           = vocalsVolume; },           [vocalsVolume]);

  // Apply volume changes immediately to playing elements
  useEffect(() => { if (audioRef.current)  audioRef.current.volume  = instVolume;   }, [instVolume]);
  useEffect(() => { if (vocalsRef.current) vocalsRef.current.volume = vocalsVolume; }, [vocalsVolume]);

  // When the instrumental URL changes after a splice, force the <audio> element to reload.
  // Changing `src` in React alone doesn't trigger a browser reload — .load() is required.
  const prevInstrumentalUrlRef = useRef(currentInstrumentalUrl);
  useEffect(() => {
    if (currentInstrumentalUrl === prevInstrumentalUrlRef.current) return;
    prevInstrumentalUrlRef.current = currentInstrumentalUrl;
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    audio.load();
    setPlaying(false);
    setProgress(0);
    setCurrentTimeMs(0);
  }, [currentInstrumentalUrl]);

  const prevVocalsUrlRef = useRef(currentVocalsUrl);
  useEffect(() => {
    if (currentVocalsUrl === prevVocalsUrlRef.current) return;
    prevVocalsUrlRef.current = currentVocalsUrl;
    vocalsRef.current?.load();
  }, [currentVocalsUrl]);

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

  // ── Splice on section regeneration ───────────────────────────────────────────
  useEffect(() => {
    if (!pendingRegeneration || splicing) return;

    const {
      sectionIndex,
      audioUrl: fallback,
      instrumentalUrl: newInstUrl,
      vocalsUrl: newVocUrl,
      wordTimestamps: newSectionTs,
      sectionStartMs: explicitStartMs,
      sectionEndMs:   explicitEndMs,
      vocalsOnly,
    } = pendingRegeneration;

    setSplicing(true);

    const runSplices = async () => {
      let finalInstUrl = currentInstrumentalUrlRef.current;
      let finalVocUrl  = currentVocalsUrlRef.current;
      let finalTs      = currentWordTimestampsRef.current;

      const getAudioDurationMs = async (url: string): Promise<number> => {
        const ctx = new AudioContext();
        const buf = await fetch(url).then(r => r.arrayBuffer());
        const decoded = await ctx.decodeAudioData(buf);
        await ctx.close();
        return decoded.duration * 1000;
      };

      const instDurationMs = await getAudioDurationMs(currentInstrumentalUrlRef.current);

      // Prefer explicit bar-count timings (from sectionTimings) over word-timestamp markers.
      // Markers can be wrong for sections with no lyrics or when timestamps drift.
      let startMs: number;
      let endMs: number;
      if (explicitStartMs !== undefined && explicitEndMs !== undefined) {
        startMs = explicitStartMs;
        endMs   = explicitEndMs;
      } else {
        const markers = sectionMarkersRef.current;
        const startRatio = markers[sectionIndex]?.ratio ?? 0;
        const endRatio   = markers[sectionIndex + 1]?.ratio ?? 1;
        startMs = startRatio * instDurationMs;
        endMs   = endRatio   * instDurationMs;
      }
      const startRatio = startMs / instDurationMs;
      const endRatio   = endMs   / instDurationMs;

      // Vocal ratios derived from the vocals track's own duration
      let vocStartRatio = startRatio;
      let vocEndRatio   = endRatio;
      if (currentVocalsUrlRef.current) {
        const vocDurationMs = await getAudioDurationMs(currentVocalsUrlRef.current);
        vocStartRatio = startMs / vocDurationMs;
        vocEndRatio   = endMs   / vocDurationMs;
      }

      // ── Align new section to beat 1 ────────────────────────────────────────
      let alignedVocUrl = newVocUrl ?? null;
      let alignedTs     = newSectionTs;

      // For vocals-only regen the instrumental is unchanged — only align/splice the vocal track.
      // (newInstUrl is the same URL as the current instrumental; splicing it into itself would
      //  duplicate everything from the section boundary onward.)
      let newSectionDurationMs: number;

      if (vocalsOnly) {
        // Trim vocals to downbeat
        if (alignedVocUrl) {
          const { url } = await trimToDownbeat(alignedVocUrl, tempo);
          alignedVocUrl = url;
        }
        // Section duration comes from the vocal clip, not the unchanged instrumental
        newSectionDurationMs = alignedVocUrl ? await getAudioDurationMs(alignedVocUrl) : (endMs - startMs);

        // Splice only the vocal track; instrumental stays as-is
        if (alignedVocUrl && currentVocalsUrlRef.current) {
          const r = await spliceSection(
            currentVocalsUrlRef.current, currentWordTimestampsRef.current,
            vocStartRatio, vocEndRatio, alignedVocUrl, alignedTs,
          );
          finalVocUrl = r.audioUrl;
          finalTs     = r.wordTimestamps; // timestamps rebuilt from the vocal splice
        }
      } else {
        let alignedInstUrl = newInstUrl ?? fallback;

        // Trim instrumental to downbeat and shift timestamps accordingly
        {
          const { url, trimmedMs } = await trimToDownbeat(alignedInstUrl, tempo);
          alignedInstUrl = url;
          if (trimmedMs > 0) {
            alignedTs = alignedTs.map(w => ({
              ...w,
              start_ms: Math.max(0, w.start_ms - trimmedMs),
              end_ms:   Math.max(0, w.end_ms   - trimmedMs),
            }));
          }
        }

        // Trim vocals to downbeat if provided
        if (alignedVocUrl) {
          const { url } = await trimToDownbeat(alignedVocUrl, tempo);
          alignedVocUrl = url;
        }

        // Measure the actual new-section duration AFTER beat-trim so timing update is accurate
        newSectionDurationMs = await getAudioDurationMs(alignedInstUrl);

        const tasks: Promise<void>[] = [];

        // Splice the instrumental (and rebuild timestamps from it)
        tasks.push(
          spliceSection(currentInstrumentalUrlRef.current, currentWordTimestampsRef.current,
            startRatio, endRatio, alignedInstUrl, alignedTs)
            .then(r => { finalInstUrl = r.audioUrl; finalTs = r.wordTimestamps; })
        );

        // Splice vocals if a clean vocal track exists
        if (alignedVocUrl && currentVocalsUrlRef.current) {
          tasks.push(
            spliceSection(currentVocalsUrlRef.current, currentWordTimestampsRef.current,
              vocStartRatio, vocEndRatio, alignedVocUrl, alignedTs)
              .then(r => { finalVocUrl = r.audioUrl; })
          );
        }

        await Promise.all(tasks);
      }

      setCurrentInstrumentalUrl(finalInstUrl);
      setCurrentVocalsUrl(finalVocUrl);
      setCurrentWordTimestamps(finalTs);
      setProgress(0);
      setCurrentTimeMs(0);
      onSpliceComplete?.(finalInstUrl, finalVocUrl || undefined, finalTs,
        sectionIndex, startMs, startMs + newSectionDurationMs);
      onRegenerationComplete?.();
    };

    runSplices()
      .catch(err => console.error('Splice failed:', err))
      .finally(() => setSplicing(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingRegeneration]);

  // ── Playback controls ─────────────────────────────────────────────────────────

  /** Only the active recorded vocal take's audio element. */
  const extraVocalEls = () => {
    if (!activeExtraVocalId) return [];
    const el = extraVocalAudioRefsMap.current.get(activeExtraVocalId);
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
        {true && (<>
            <div ref={waveformScrollRef} style={{ overflowX: waveformZoom > 1 ? 'auto' : 'visible', scrollbarWidth: 'none' }}>
              <div style={{ width: waveformZoom !== 1 ? `${waveformZoom * 100}%` : '100%', minWidth: '100%' }}>
                {(() => {
                  const hasRecordedTakes = (extraVocalTracks?.length ?? 0) > 0;
                  const useMultiTrack    = hasTwoTracks || hasRecordedTakes;

                  if (useMultiTrack) return (
                    <div className="flex flex-col gap-1">
                      {/* Section labels */}
                      {sectionMarkers.length > 0 && (
                        <div className="flex items-end gap-3">
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
                            <Waveform
                              audioUrl={currentVocalsUrl}
                              progress={vocIsPlaying ? progress : 0}
                              onSeek={seek}
                              showLabels={false}
                              sectionMarkers={sectionMarkers}
                              activeSectionIndex={activeSectionIndex}
                              onSectionClick={handleSectionClick}
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
                          <Waveform
                            audioUrl={currentInstrumentalUrl}
                            progress={instIsPlaying ? progress : 0}
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
                      )}

                      {/* Stem rows */}
                      {instrumentStems && (
                        <>
                          <StemTrackRow label={stemLabels?.drums ?? 'Drums'} audioUrl={instrumentStems.drums} volume={drumVolume}  onVolumeChange={setDrumVolume}  onAudioRef={el => { drumAudioRef.current  = el; }} masterPlaying={playing} />
                          <StemTrackRow label={stemLabels?.bass  ?? 'Bass'}  audioUrl={instrumentStems.bass}  volume={bassVolume}  onVolumeChange={setBassVolume}  onAudioRef={el => { bassAudioRef.current  = el; }} masterPlaying={playing} />
                          <StemTrackRow label={stemLabels?.other ?? 'Other'} audioUrl={instrumentStems.other} volume={otherVolume} onVolumeChange={setOtherVolume} onAudioRef={el => { otherAudioRef.current = el; }} masterPlaying={playing} />
                          {otherStemSplit ? (
                            <div className="ml-5 border-l-2 border-[#e9e9e9] pl-3 flex flex-col gap-0">
                              <StemTrackRow label="Vocals"      audioUrl={otherStemSplit.vocals}       volume={other2VocalsVol} onVolumeChange={setOther2VocalsVol} onAudioRef={el => { other2VocalsRef.current = el; }} masterPlaying={playing} />
                              <StemTrackRow label="Instruments" audioUrl={otherStemSplit.instrumental} volume={other2InstVol}   onVolumeChange={setOther2InstVol}   onAudioRef={el => { other2InstRef.current   = el; }} masterPlaying={playing} />
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
        </>)}

        {/* Hidden audio elements */}
        <audio
          ref={audioRef}
          src={currentInstrumentalUrl}
          onEnded={onEnded}
          preload="auto"
          style={{ display: 'none' }}
        />
        {hasTwoTracks && (
          <audio
            ref={vocalsRef}
            src={currentVocalsUrl}
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

// ── StemTrackRow — playback for an individual stem ────────────────────────────
// Registers its audio element with the parent via onAudioRef so the master
// transport can control all stems simultaneously.

function StemTrackRow({ label, audioUrl, volume: volumeProp, onVolumeChange, onAudioRef, masterPlaying, onDelete, editOverlay }: {
  label: string;
  audioUrl: string;
  volume?: number;
  onVolumeChange?: (v: number) => void;
  onAudioRef?: (el: HTMLAudioElement | null) => void;
  masterPlaying?: boolean;
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

  // 60fps progress loop for this stem track
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
          <Waveform audioUrl={audioUrl} progress={progress} onSeek={seek} />
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

      {/* Delete — rightmost */}
      {onDelete && (
        <button
          onClick={onDelete}
          title={`Delete ${label}`}
          className="w-6 h-6 flex items-center justify-center rounded text-[#bdbdbd] hover:text-red-500 hover:bg-red-50 transition-colors flex-shrink-0"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </button>
      )}
    </div>
  );
}

