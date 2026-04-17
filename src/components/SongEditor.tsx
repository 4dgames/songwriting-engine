'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { Song, SongSection, WordTimestamp, SectionTake } from '@/lib/types';
import SectionEditor from './SectionEditor';
import AudioPlayer from './AudioPlayer';
import { splitStereoToTracks } from '@/lib/audio/split';
import { toBlobUrl, mixTracks } from '@/lib/audio/mix';
import TimelineEditor, { type TimelineTrack } from './TimelineEditor';
import { alignTracks } from '@/lib/audio/align';
import { trimLeadingSilence } from '@/lib/audio/trimSilence';
import { trimToDownbeat } from '@/lib/audio/beatDetect';
import { insertAudioAtMs, cutAudioRegion } from '@/lib/audio/splice';

/**
 * Encode an AudioBuffer as a 16-bit PCM WAV blob URL.
 * Used to pad recorded vocals so they match the instrumental's duration.
 */
function audioBufferToWavUrl(buffer: AudioBuffer): string {
  const numCh      = buffer.numberOfChannels;
  const numSamples = buffer.length;
  const sr         = buffer.sampleRate;
  const bps        = 2; // 16-bit
  const dataSize   = numSamples * numCh * bps;
  const ab         = new ArrayBuffer(44 + dataSize);
  const view       = new DataView(ab);

  const ws = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); view.setUint32(4,  36 + dataSize, true);
  ws(8, 'WAVE'); ws(12, 'fmt ');
  view.setUint32(16, 16, true);           // PCM chunk size
  view.setUint16(20, 1, true);            // PCM format
  view.setUint16(22, numCh, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * numCh * bps, true);
  view.setUint16(32, numCh * bps, true);
  view.setUint16(34, 16, true);           // bits per sample
  ws(36, 'data'); view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      const s = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i] ?? 0));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      offset += 2;
    }
  }
  return URL.createObjectURL(new Blob([ab], { type: 'audio/wav' }));
}

/**
 * Pad `recordingUrl` with silence so its total duration matches `referenceUrl`.
 * Returns a new blob URL (WAV). If recording is already >= reference length, returns original.
 */
async function padToMatch(recordingUrl: string, referenceUrl: string): Promise<string> {
  const ctx = new AudioContext();
  try {
    const [recBuf, refBuf] = await Promise.all([
      fetch(recordingUrl).then(r => r.arrayBuffer()).then(b => ctx.decodeAudioData(b)),
      fetch(referenceUrl).then(r => r.arrayBuffer()).then(b => ctx.decodeAudioData(b)),
    ]);
    if (recBuf.duration >= refBuf.duration - 0.1) return recordingUrl; // already close enough

    const numCh  = recBuf.numberOfChannels;
    const sr     = recBuf.sampleRate;
    const padded = ctx.createBuffer(numCh, Math.ceil(refBuf.duration * sr), sr);
    for (let ch = 0; ch < numCh; ch++) {
      padded.getChannelData(ch).set(recBuf.getChannelData(ch));
      // remaining samples stay 0 (silence)
    }
    return audioBufferToWavUrl(padded);
  } finally {
    await ctx.close();
  }
}

/** Converts a blob:// URL to a base64 data URL so it can be sent to a server API. */
async function blobUrlToDataUrl(blobUrl: string): Promise<string> {
  const res  = await fetch(blobUrl);
  const blob = await res.blob();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// ── Audio generation progress milestones ─────────────────────────────────────

const AUDIO_MILESTONES: [number, string][] = [
  [5,  'Preparing your song…'],
  [10, 'Formatting lyrics and structure…'],
  [15, 'Building the audio prompt…'],
  [20, 'Connecting to AI musician…'],
  [25, 'Analyzing tempo and key signature…'],
  [30, 'Sketching the arrangement…'],
  [38, 'Composing the instrumental…'],
  [46, 'Recording the lead melody…'],
  [54, 'Layering harmonies and counter-melodies…'],
  [62, 'Performing the vocals…'],
  [70, 'Blending vocals with instruments…'],
  [78, 'Applying EQ and compression…'],
  [84, 'Mastering the final mix…'],
  [88, 'Encoding the audio file…'],
  [92, 'Transcribing word timestamps…'],
  [96, 'Packaging your track…'],
];

function deriveAudioLabel(pct: number): string {
  let label = 'Starting…';
  for (const [threshold, l] of AUDIO_MILESTONES) {
    if (pct >= threshold) label = l;
    else break;
  }
  return label;
}

// ── Song-level take ──────────────────────────────────────────────────────────

interface SongTake {
  id: string;
  label: string;
  audioUrl: string;           // backward compat (= instrumentalUrl)
  instrumentalUrl: string;
  vocalsUrl?: string;
  wordTimestamps: WordTimestamp[];
  sections: SongSection[];
}

interface SectionRegeneration {
  sectionIndex: number;
  audioUrl: string;
  instrumentalUrl?: string;
  vocalsUrl?: string;
  wordTimestamps: WordTimestamp[];
  vocalsOnly: boolean;
  instrumentalOnly: boolean;
  sectionStartMs?: number;
  sectionEndMs?: number;
}

export interface SongEditorHandle {
  /** Returns the current live project state for serialisation / saving. */
  getProjectState(): {
    song: Song;
    audioPrompt: string;
    wordTimestamps: WordTimestamp[];
    sectionTimings: { startMs: number; endMs: number }[];
    lockedSections: SongSection[];
    instrumentalUrl: string;
    vocalsUrl: string | undefined;
  };
}

interface InitialState {
  wordTimestamps:  WordTimestamp[];
  sectionTimings:  { startMs: number; endMs: number }[];
  lockedSections:  SongSection[];
  instrumentalUrl: string;
  vocalsUrl?:      string;
}

interface Props {
  song: Song;
  audioPrompt: string;
  onAudioPromptChange: (v: string) => void;
  autoGenerate?: boolean;
  playRequestCount?: number;       // increment to request playback (generates if needed)
  onAudioReady?: () => void;       // called when first audio URL becomes available
  onGenerationStart?: () => void;  // called when audio generation begins
  sectionsOpen: boolean;
  onSectionsOpenChange: (v: boolean) => void;
  onInstrumentalUrlChange?: (url: string) => void;
  /** Pre-loaded project state (skips generation, goes straight to the player). */
  initialState?: InitialState;
}

const makeTakeId = () => `take-${crypto.randomUUID()}`;

const DRUM_KEYWORDS = ['drum', 'percussion', 'beat', 'snare', 'kick', 'hi-hat', 'cymbal', 'tambourine', 'bongo', 'conga'];
const BASS_KEYWORDS = ['bass'];

function deriveStemLabels(sections: SongSection[]): { drums: string; bass: string; other: string } {
  const all = [...new Set(sections.flatMap(s => s.instruments ?? []).map(i => i.toLowerCase().trim()))];
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const join = (arr: string[], fallback: string) => arr.length ? arr.map(cap).join(' & ') : fallback;

  const drumsGroup = all.filter(i => DRUM_KEYWORDS.some(k => i.includes(k)));
  const bassGroup  = all.filter(i => BASS_KEYWORDS.some(k => i.includes(k)) && !DRUM_KEYWORDS.some(k => i.includes(k)));
  const otherGroup = all.filter(i => !DRUM_KEYWORDS.some(k => i.includes(k)) && !BASS_KEYWORDS.some(k => i.includes(k)));

  return { drums: join(drumsGroup, 'Drums'), bass: join(bassGroup, 'Bass'), other: join(otherGroup, 'Other') };
}

/** 8 bars at the given tempo, in milliseconds. */
function defaultDurationMs(tempo: number): number {
  return Math.round(8 * 240000 / tempo);
}

/** Compute cumulative [startMs, endMs] for each section based on its durationMs. */
function computeSectionTimings(sections: SongSection[], tempo: number): { startMs: number; endMs: number }[] {
  let cursor = 0;
  return sections.map(s => {
    const dur = s.durationMs ?? defaultDurationMs(tempo);
    const start = cursor;
    cursor += dur;
    return { startMs: start, endMs: cursor };
  });
}

/** Determine which part of a section has changed vs its locked (last-generated) version. */
function getSectionDirtyMode(current: SongSection, locked: SongSection): 'vocals' | 'instruments' | 'both' | null {
  const lyricsChanged = current.lyrics !== locked.lyrics;
  const nonLyricsChanged =
    JSON.stringify(current.chords) !== JSON.stringify(locked.chords) ||
    current.style !== locked.style ||
    JSON.stringify(current.instruments ?? []) !== JSON.stringify(locked.instruments ?? []);
  if (!lyricsChanged && !nonLyricsChanged) return null;
  if (lyricsChanged && !nonLyricsChanged) return 'vocals';
  if (!lyricsChanged && nonLyricsChanged) return 'instruments';
  return 'both';
}

function newSection(afterIndex: number, sections: SongSection[], tempo: number): SongSection {
  return {
    type: 'verse',
    label: `Section ${sections.length + 1}`,
    lyrics: '',
    chords: [],
    durationMs: defaultDurationMs(tempo),
  };
}

const SongEditor = forwardRef<SongEditorHandle, Props>(function SongEditor({ song: initial, audioPrompt, onAudioPromptChange, autoGenerate, playRequestCount, onAudioReady, onGenerationStart, sectionsOpen, onSectionsOpenChange, onInstrumentalUrlChange, initialState }, ref) {
  const [song, setSong] = useState<Song>(() => ({
    ...initial,
    sections: initial.sections.map(s => ({
      ...s,
      style: s.style ?? initial.genre.toLowerCase(),
      durationMs: s.durationMs ?? defaultDurationMs(initial.tempo),
    })),
  }));
  const didAutoGenerate = useRef(false);

  // Song-level takes (one per full generation).
  // If loading from a saved project, seed with a synthetic "Loaded" take so the
  // player and take-management code see a valid activeSongTakeId from the start.
  const [{ songTakes: _initTakes, activeSongTakeId: _initTakeId }] = useState(() => {
    if (initialState?.instrumentalUrl) {
      const id: string = makeTakeId();
      return {
        songTakes: [{
          id,
          label: 'Loaded Save',
          audioUrl:         initialState.instrumentalUrl,
          instrumentalUrl:  initialState.instrumentalUrl,
          vocalsUrl:        initialState.vocalsUrl,
          wordTimestamps:   initialState.wordTimestamps,
          sections:         initial.sections.map(s => ({ ...s })),
        }] as SongTake[],
        activeSongTakeId: id,
      };
    }
    return { songTakes: [] as SongTake[], activeSongTakeId: null as string | null };
  });
  const [songTakes, setSongTakes] = useState<SongTake[]>(_initTakes);
  const [activeSongTakeId, setActiveSongTakeId] = useState<string | null>(_initTakeId);
  const [liveInstrumentalUrl, setLiveInstrumentalUrl] = useState(initialState?.instrumentalUrl ?? '');
  const [liveVocalsUrl, setLiveVocalsUrl] = useState<string | undefined>(initialState?.vocalsUrl);
  // True when the current instrumental URL was generated with embedded vocals (needs splitting before layering recorded vocals).
  // False when it was generated instrumental-only — already a clean track, no split needed.
  const [liveAudioHasVocals, setLiveAudioHasVocals] = useState(false);
  const [liveWordTimestamps, setLiveWordTimestamps] = useState<WordTimestamp[]>(initialState?.wordTimestamps ?? []);
  const [audioResetKey, setAudioResetKey] = useState(0);
  const [editingTakeId, setEditingTakeId] = useState<string | null>(null);

  // Section-level takes: parallel array, one entry per section index
  const [sectionTakes, setSectionTakes] = useState<SectionTake[][]>(
    () => initial.sections.map(() => [])
  );

  const [playingSection, setPlayingSection] = useState<number | null>(null);
  const [playSectionRequest, setPlaySectionRequest] = useState<{ index: number; seq: number } | null>(null);

  const [instrumentStems, setInstrumentStems] = useState<{ drums: string; bass: string; other: string } | null>(null);
  const [separatingInstruments, setSeparatingInstruments] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const [generating, setGenerating] = useState(false);
  const [separating, setSeparating] = useState(false);
  const [separationMethod, setSeparationMethod] = useState<'elevenlabs' | 'ica' | null>(null);
  const [generateMode, setGenerateMode] = useState<'both' | 'instrumental' | 'vocals'>('both');
  const forceInstrumental = generateMode === 'instrumental'; // derived — keeps downstream code unchanged
  const [modeDropdownOpen, setModeDropdownOpen] = useState(false);
  const modeDropdownRef = useRef<HTMLDivElement>(null);
  const [regeneratingVocals, setRegeneratingVocals] = useState(false);
  const [regeneratingInstrumental, setRegeneratingInstrumental] = useState(false);
  const [audioProgress, setAudioProgress] = useState(0);
  const audioCrawlRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [separationProgress, setSeparationProgress] = useState(0);
  const [separationStep,     setSeparationStep]     = useState('');
  const separationCrawlRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [instSepProgress, setInstSepProgress] = useState(0);
  const [instSepStep,     setInstSepStep]     = useState('');
  const [otherStemSplit,      setOtherStemSplit]      = useState<{ vocals: string; instrumental: string } | null>(null);
  const [separatingOtherStem, setSeparatingOtherStem] = useState(false);
  const instSepCrawlRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [error, setError] = useState('');
  const [playAudioTrigger,  setPlayAudioTrigger]  = useState(0);
  const [pauseAudioTrigger, setPauseAudioTrigger] = useState(0);

  // Recorded vocal takes — newest first; only the active one plays
  const [extraVocalTracks,    setExtraVocalTracks]    = useState<{ id: string; url: string; label: string }[]>([]);
  const [activeExtraVocalId,  setActiveExtraVocalId]  = useState<string | null>(null);
  const [vocalsGo,            setVocalsGo]            = useState(false);

  // Timeline editor + mix-down
  const [showTimeline,  setShowTimeline]  = useState(false);
  const [mixingDown,    setMixingDown]    = useState(false);

  // ── Vocals recording ──────────────────────────────────────────────────────────
  const [vocalsRecording,        setVocalsRecording]        = useState(false); // mic is live
  const [vocalsRecordingPrep,    setVocalsRecordingPrep]    = useState(false); // splitting / requesting mic
  const [vocalsCountdown,        setVocalsCountdown]        = useState<number | null>(null); // 3,2,1
  const [vocalsStream,           setVocalsStream]           = useState<MediaStream | null>(null);
  const vocalsRecorderRef  = useRef<MediaRecorder | null>(null);
  const vocalsChunksRef    = useRef<Blob[]>([]);
  const vocalsStreamRef    = useRef<MediaStream | null>(null);
  const onAudioReadyRef = useRef(onAudioReady);
  useEffect(() => { onAudioReadyRef.current = onAudioReady; }, [onAudioReady]);

  const onInstrumentalUrlChangeRef = useRef(onInstrumentalUrlChange);
  useEffect(() => { onInstrumentalUrlChangeRef.current = onInstrumentalUrlChange; }, [onInstrumentalUrlChange]);
  useEffect(() => { if (liveInstrumentalUrl) onInstrumentalUrlChangeRef.current?.(liveInstrumentalUrl); }, [liveInstrumentalUrl]);

  // Close mode dropdown on outside click
  useEffect(() => {
    if (!modeDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (modeDropdownRef.current && !modeDropdownRef.current.contains(e.target as Node)) {
        setModeDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [modeDropdownOpen]);

  // Auto-generate audio on first mount when requested (e.g. from wizard "Hear my song")
  useEffect(() => {
    if (autoGenerate && !didAutoGenerate.current) {
      didAutoGenerate.current = true;
      void generateAudio();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When wizard requests playback: generate audio if none exists, otherwise trigger play
  useEffect(() => {
    if (!playRequestCount) return;
    if (!liveInstrumentalUrl) {
      void generateAudio();
    } else {
      setPlayAudioTrigger(prev => prev + 1);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playRequestCount]);

  // Notify wizard and close sections when audio first becomes available
  const audioReadyNotifiedRef = useRef(false);
  useEffect(() => {
    if (liveInstrumentalUrl && !audioReadyNotifiedRef.current) {
      audioReadyNotifiedRef.current = true;
      onAudioReadyRef.current?.();
      onSectionsOpenChange(false);
    }
  }, [liveInstrumentalUrl]);

  // Asymptotic crawl while generating audio
  useEffect(() => {
    if (generating) {
      audioCrawlRef.current = setInterval(() => {
        setAudioProgress(prev => {
          if (prev >= 96) return prev;
          return prev + (96 - prev) * 0.035;
        });
      }, 350);
    } else {
      if (audioCrawlRef.current) clearInterval(audioCrawlRef.current);
    }
    return () => { if (audioCrawlRef.current) clearInterval(audioCrawlRef.current); };
  }, [generating]);
  const [regeneratingSectionIndex, setRegeneratingSectionIndex] = useState<number | null>(null);
  const [sectionRegeneration, setSectionRegeneration] = useState<SectionRegeneration | null>(null);
  const [confirmDeleteIndex, setConfirmDeleteIndex] = useState<number | null>(null);
  const [sectionTimings, setSectionTimings] = useState<{ startMs: number; endMs: number }[]>(
    () => initialState?.sectionTimings ?? []
  );
  const [deletingSection, setDeletingSection] = useState(false);
  const [autoRegenRunning, setAutoRegenRunning] = useState(false);
  const [lockedSections, setLockedSections] = useState<SongSection[]>(
    () => initialState?.lockedSections ?? initial.sections.map(s => ({
      ...s,
      style: s.style ?? initial.genre.toLowerCase(),
      durationMs: s.durationMs ?? defaultDurationMs(initial.tempo),
    }))
  );

  const hasAudio = !!liveInstrumentalUrl;

  // Expose project state via ref for parent-level save/load
  useImperativeHandle(ref, () => ({
    getProjectState: () => ({
      song,
      audioPrompt,
      wordTimestamps:  liveWordTimestamps,
      sectionTimings,
      lockedSections,
      instrumentalUrl: liveInstrumentalUrl,
      vocalsUrl:       liveVocalsUrl,
    }),
  }), [song, audioPrompt, liveWordTimestamps, sectionTimings, lockedSections, liveInstrumentalUrl, liveVocalsUrl]);

  // ── Section helpers ──────────────────────────────────────────────────────────

  const updateSection = (index: number, updated: SongSection) => {
    setSong(s => ({
      ...s,
      sections: s.sections.map((sec, i) => (i === index ? updated : sec)),
    }));
  };

  const insertSection = (afterIndex: number) => {
    const tempo = song.tempo;
    setSong(s => {
      const next = [...s.sections];
      next.splice(afterIndex + 1, 0, newSection(afterIndex, s.sections, tempo));
      return { ...s, sections: next };
    });
    setLockedSections(prev => {
      const next = [...prev];
      next.splice(afterIndex + 1, 0, newSection(afterIndex, prev, tempo));
      return next;
    });
    setSectionTakes(prev => {
      const next = [...prev];
      next.splice(afterIndex + 1, 0, []);
      return next;
    });
    // Insert a zero-duration timing placeholder so regeneration knows where to insert audio
    setSectionTimings(prev => {
      if (!prev.length) return prev;
      const insertAt = prev[afterIndex]?.endMs ?? (prev[prev.length - 1]?.endMs ?? 0);
      const next = [...prev];
      next.splice(afterIndex + 1, 0, { startMs: insertAt, endMs: insertAt });
      return next;
    });
  };

  const deleteSection = async (index: number) => {
    const timing = sectionTimings[index];
    if (hasAudio && timing && timing.startMs < timing.endMs) {
      // Cut the section's audio region from both live tracks
      setDeletingSection(true);
      try {
        const { startMs, endMs } = timing;
        const removedMs = endMs - startMs;
        const [instResult, vocResult] = await Promise.all([
          cutAudioRegion(liveInstrumentalUrl, liveWordTimestamps, startMs, endMs),
          liveVocalsUrl ? cutAudioRegion(liveVocalsUrl, [], startMs, endMs) : Promise.resolve(null),
        ]);
        setLiveInstrumentalUrl(instResult.audioUrl);
        setLiveWordTimestamps(instResult.wordTimestamps);
        if (vocResult) setLiveVocalsUrl(vocResult.audioUrl);
        setAudioResetKey(k => k + 1);
        setSongTakes(prev => prev.map(t =>
          t.id === activeSongTakeId
            ? { ...t, audioUrl: instResult.audioUrl, instrumentalUrl: instResult.audioUrl, vocalsUrl: vocResult?.audioUrl ?? t.vocalsUrl, wordTimestamps: instResult.wordTimestamps }
            : t
        ));
        setSectionTimings(prev => {
          const filtered = prev.filter((_, i) => i !== index);
          return filtered.map((t, i) => i >= index
            ? { startMs: t.startMs - removedMs, endMs: t.endMs - removedMs }
            : t
          );
        });
      } finally {
        setDeletingSection(false);
      }
    } else if (timing) {
      // Zero-duration section (no audio yet) — just remove the timing entry
      setSectionTimings(prev => prev.filter((_, i) => i !== index));
    }
    setSong(s => ({ ...s, sections: s.sections.filter((_, i) => i !== index) }));
    setLockedSections(prev => prev.filter((_, i) => i !== index));
    setSectionTakes(prev => prev.filter((_, i) => i !== index));
    setConfirmDeleteIndex(null);
    if (sectionRegeneration?.sectionIndex === index) setSectionRegeneration(null);
  };

  // ── Section drag-to-reorder ──────────────────────────────────────────────────

  const handleDrop = (toIndex: number) => {
    if (dragIndex === null || dragIndex === toIndex) {
      setDragIndex(null); setDragOverIndex(null); return;
    }
    const reorder = <T,>(arr: T[]): T[] => {
      const next = [...arr];
      const [moved] = next.splice(dragIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    };
    setSong(s => ({ ...s, sections: reorder(s.sections) }));
    setSectionTakes(reorder);
    setLockedSections(reorder);
    setDragIndex(null); setDragOverIndex(null);
  };

  // ── Audio generation ─────────────────────────────────────────────────────────

  const generateAudio = async () => {
    const useInstOnly = forceInstrumental;
    onGenerationStart?.();
    setGenerating(true);
    setAudioProgress(5);
    setError('');
    setInstrumentStems(null);
    let audioUrl = '';
    let wordTimestamps: WordTimestamp[] = [];

    try {
      // ── Step 1: Generate the full mix via ElevenLabs ──────────────────────
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...song, audioPrompt, forceInstrumental: useInstOnly }),
      });
      if (!res.ok) throw new Error(await res.text());
      ({ audioUrl, wordTimestamps } = await res.json() as {
        audioUrl: string; wordTimestamps: WordTimestamp[];
      });
      setAudioProgress(100);

      // Trim any leading silence and shift timestamps to match
      try {
        const { url: trimmedUrl, trimmedSec } = await trimLeadingSilence(audioUrl);
        audioUrl = trimmedUrl;
        if (trimmedSec > 0) {
          const offsetMs = trimmedSec * 1000;
          wordTimestamps = wordTimestamps.map(t => ({
            ...t,
            start_ms: Math.max(0, t.start_ms - offsetMs),
            end_ms:   Math.max(0, t.end_ms   - offsetMs),
          }));
        }
      } catch { /* best-effort */ }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Audio generation failed');
      setGenerating(false);
      return;
    } finally {
      setGenerating(false);
    }

    // Store the take immediately with the combined audio — no auto-split
    const id = makeTakeId();
    const newTake: SongTake = {
      id,
      label: `Song Take ${songTakes.length + 1}`,
      audioUrl,
      instrumentalUrl: audioUrl,
      vocalsUrl: undefined,
      wordTimestamps,
      sections: song.sections.map(s => ({ ...s })),
    };
    setSongTakes(prev => [...prev, newTake]);
    setActiveSongTakeId(id);
    setLiveInstrumentalUrl(audioUrl);
    setLiveVocalsUrl(undefined);
    setLiveAudioHasVocals(!useInstOnly); // if we generated with vocals, flag it so recording knows to split first
    setLiveWordTimestamps(wordTimestamps);
    setLockedSections(song.sections.map(s => ({ ...s })));
    setSectionTakes(song.sections.map(section => [{
      id: makeTakeId(),
      label: `${section.label}: Take 1`,
      section: { ...section },
      audioUrl,
      instrumentalUrl: audioUrl,
      wordTimestamps,
    }]));
    setSectionTimings(computeSectionTimings(song.sections, song.tempo));
    setSeparationMethod(null);
  };

  // ── Manual stem separation ────────────────────────────────────────────────────

  /** Core split logic — returns URLs without touching live/take state. */
  const doSplit = async (audioUrl: string): Promise<{ instrumentalUrl: string; vocalsUrl: string }> => {
    setSeparating(true);
    setError('');
    setSeparationProgress(0);
    setSeparationStep('Uploading audio…');
    const t1 = setTimeout(() => setSeparationStep('Separating vocals and instruments…'), 3000);
    separationCrawlRef.current = setInterval(() => {
      setSeparationProgress(prev => prev >= 90 ? prev : prev + (90 - prev) * 0.04);
    }, 350);

    let instrumentalUrl: string;
    let vocalsUrl: string;

    try {
      const audioDataUrl = audioUrl.startsWith('blob:')
        ? await blobUrlToDataUrl(audioUrl)
        : audioUrl;
      const splitRes = await fetch('/api/split', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audioUrl: audioDataUrl }),
      });
      if (!splitRes.ok) throw new Error(await splitRes.text());
      const { vocals, instrumental } = await splitRes.json() as { vocals: string; instrumental: string };
      [instrumentalUrl, vocalsUrl] = await Promise.all([toBlobUrl(instrumental), toBlobUrl(vocals)]);
      const aligned = await alignTracks(instrumentalUrl, vocalsUrl);
      instrumentalUrl = aligned.urlA;
      vocalsUrl       = aligned.urlB;
      setSeparationMethod('elevenlabs');
    } catch (err) {
      console.warn('ElevenLabs stem separation failed, using ICA fallback:', err instanceof Error ? err.message : err);
      const split = await splitStereoToTracks(audioUrl);
      instrumentalUrl = split.instrumentalUrl;
      vocalsUrl       = split.vocalsUrl;
      setSeparationMethod('ica');
    } finally {
      clearTimeout(t1);
      if (separationCrawlRef.current) clearInterval(separationCrawlRef.current);
      setSeparationProgress(100);
      setSeparationStep('Done');
      setSeparating(false);
    }

    return { instrumentalUrl: instrumentalUrl!, vocalsUrl: vocalsUrl! };
  };

  const preSplitUrlRef = useRef<string | null>(null);

  const splitTracks = async () => {
    if (!liveInstrumentalUrl) return;
    preSplitUrlRef.current = liveInstrumentalUrl; // remember original mix for rejoin
    const { instrumentalUrl, vocalsUrl } = await doSplit(liveInstrumentalUrl);
    setLiveInstrumentalUrl(instrumentalUrl);
    setLiveVocalsUrl(vocalsUrl);
    setAudioResetKey(k => k + 1);
    setSongTakes(prev => prev.map(t =>
      t.id === activeSongTakeId
        ? { ...t, audioUrl: instrumentalUrl, instrumentalUrl, vocalsUrl }
        : t
    ));
  };

  const rejoinTracks = () => {
    const original = preSplitUrlRef.current;
    if (!original) return;
    preSplitUrlRef.current = null;
    setLiveInstrumentalUrl(original);
    setLiveVocalsUrl(undefined);
    setAudioResetKey(k => k + 1);
    setSongTakes(prev => prev.map(t =>
      t.id === activeSongTakeId
        ? { ...t, audioUrl: original, instrumentalUrl: original, vocalsUrl: undefined }
        : t
    ));
    setSeparationMethod(null);
  };

  // ── Section regeneration ──────────────────────────────────────────────────────

  const handleRegenerateSection = async (sectionIndex: number, regenMode: 'vocals' | 'instruments' | 'both' = 'both') => {
    const sectionLabel = song.sections[sectionIndex].label;
    const takeNum = (sectionTakes[sectionIndex]?.length ?? 0) + 1;
    const snap: SectionTake = {
      id: makeTakeId(),
      label: `${sectionLabel}: Take ${takeNum}`,
      section: { ...song.sections[sectionIndex] },
      audioUrl: liveInstrumentalUrl,
      instrumentalUrl: liveInstrumentalUrl,
      vocalsUrl: liveVocalsUrl,
      wordTimestamps: [...liveWordTimestamps],
    };
    setSectionTakes(prev => {
      const next = [...prev];
      next[sectionIndex] = [...(next[sectionIndex] ?? []), snap];
      return next;
    });

    setRegeneratingSectionIndex(sectionIndex);
    setError('');
    try {
      const res = await fetch('/api/generate/section', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ song, sectionIndex, originalSection: lockedSections[sectionIndex], regenMode }),
      });
      if (!res.ok) throw new Error(await res.text());
      const { audioUrl, wordTimestamps, vocalsOnly, instrumentalOnly } = await res.json() as {
        audioUrl: string; wordTimestamps: WordTimestamp[]; vocalsOnly: boolean; instrumentalOnly: boolean;
      };

      let instUrl: string;
      let vocUrl: string | undefined;
      // Track effective base URLs — may update if we split the full audio during vocalsOnly handling
      let baseInstUrl = liveInstrumentalUrl;
      let baseVocUrl: string | undefined = liveVocalsUrl;

      if (vocalsOnly) {
        if (!liveVocalsUrl) {
          // No separated tracks yet — auto-split now so we have a clean vocal track to splice into
          const split = await doSplit(liveInstrumentalUrl);
          instUrl = split.instrumentalUrl;
          vocUrl  = audioUrl; // the newly generated vocals
          baseInstUrl = split.instrumentalUrl;
          baseVocUrl  = split.vocalsUrl;
          // Update live state so AudioPlayer remounts with separated tracks
          setLiveInstrumentalUrl(split.instrumentalUrl);
          setLiveVocalsUrl(split.vocalsUrl);
          setAudioResetKey(k => k + 1);
          setSongTakes(prev => prev.map(t =>
            t.id === activeSongTakeId
              ? { ...t, instrumentalUrl: split.instrumentalUrl, vocalsUrl: split.vocalsUrl }
              : t
          ));
        } else {
          instUrl = liveInstrumentalUrl;
          vocUrl  = audioUrl;
        }
      } else if (instrumentalOnly) {
        instUrl = audioUrl;
        vocUrl  = liveVocalsUrl;
      } else {
        // Full mix — split into clean stems.
        // When vocal tracks are already separated, use ElevenLabs (neural separation) to prevent
        // instrumental bleed into the clean vocal track. Client-side ICA only when no vocal track exists.
        if (liveVocalsUrl) {
          const audioDataUrl = audioUrl.startsWith('blob:') ? await blobUrlToDataUrl(audioUrl) : audioUrl;
          const splitRes = await fetch('/api/split', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ audioUrl: audioDataUrl }),
          });
          if (!splitRes.ok) throw new Error(`Stem separation failed: ${await splitRes.text()}`);
          const { vocals: vocalsDataUrl, instrumental: instDataUrl } = await splitRes.json() as { vocals: string; instrumental: string };
          instUrl = await toBlobUrl(instDataUrl);
          vocUrl  = await toBlobUrl(vocalsDataUrl);
        } else {
          const split = await splitStereoToTracks(audioUrl);
          instUrl = split.instrumentalUrl;
          vocUrl  = split.vocalsUrl;
        }
      }

      // If this is a freshly-added (zero-duration) section, insert audio rather than splice
      const timing = sectionTimings[sectionIndex];
      if (timing !== undefined && timing.startMs === timing.endMs) {
        const insertAtMs = timing.startMs;

        // Trim inserted audio to beat 1 so subsequent sections' timestamps shift only by
        // the rhythmically-meaningful duration (no pre-beat leading content included).
        const { url: trimmedInstUrl, trimmedMs: instTrimMs } = await trimToDownbeat(instUrl, song.tempo);
        const trimmedWordTimestamps = instTrimMs > 0
          ? wordTimestamps.map(w => ({
              ...w,
              start_ms: Math.max(0, w.start_ms - instTrimMs),
              end_ms:   Math.max(0, w.end_ms   - instTrimMs),
            }))
          : wordTimestamps;
        const instInsert = await insertAudioAtMs(baseInstUrl, liveWordTimestamps, insertAtMs, trimmedInstUrl, trimmedWordTimestamps);

        let finalVocUrl: string | undefined = baseVocUrl;
        if (baseVocUrl && vocUrl) {
          const { url: trimmedVocUrl } = await trimToDownbeat(vocUrl, song.tempo);
          const vocInsert = await insertAudioAtMs(baseVocUrl, [], insertAtMs, trimmedVocUrl, []);
          finalVocUrl = vocInsert.audioUrl;
        }

        // Measure actual inserted duration from the trimmed audio so sectionTimings
        // shift exactly matches what insertAudioAtMs applied to word timestamps.
        const measuredCtx = new AudioContext();
        const trimmedArr  = await fetch(trimmedInstUrl).then(r => r.arrayBuffer());
        const trimmedDecoded = await measuredCtx.decodeAudioData(trimmedArr);
        await measuredCtx.close();
        const actualInsertedDurationMs = trimmedDecoded.duration * 1000;

        setLiveInstrumentalUrl(instInsert.audioUrl);
        setLiveWordTimestamps(instInsert.wordTimestamps);
        if (finalVocUrl !== baseVocUrl) setLiveVocalsUrl(finalVocUrl);
        setAudioResetKey(k => k + 1);
        setSongTakes(prev => prev.map(t =>
          t.id === activeSongTakeId
            ? { ...t, audioUrl: instInsert.audioUrl, instrumentalUrl: instInsert.audioUrl, vocalsUrl: finalVocUrl ?? t.vocalsUrl, wordTimestamps: instInsert.wordTimestamps }
            : t
        ));
        setSectionTimings(prev => {
          const next = [...prev];
          next[sectionIndex] = { startMs: insertAtMs, endMs: insertAtMs + actualInsertedDurationMs };
          return next.map((t, i) => i > sectionIndex
            ? { startMs: t.startMs + actualInsertedDurationMs, endMs: t.endMs + actualInsertedDurationMs }
            : t
          );
        });
        setLockedSections(prev => prev.map((s, i) => i === sectionIndex ? { ...song.sections[sectionIndex] } : s));
        return; // insertion applied directly — skip sectionRegeneration splice path
      }

      const sectionTiming = sectionTimings[sectionIndex];
      setSectionRegeneration({
        sectionIndex,
        audioUrl: instUrl,
        instrumentalUrl: instUrl,
        vocalsUrl: vocUrl,
        wordTimestamps,
        vocalsOnly: vocalsOnly ?? false,
        instrumentalOnly: instrumentalOnly ?? false,
        sectionStartMs: sectionTiming?.startMs,
        sectionEndMs:   sectionTiming?.endMs,
      });
      setLockedSections(prev => prev.map((s, i) => i === sectionIndex ? { ...song.sections[sectionIndex] } : s));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Section regeneration failed');
      setSectionTakes(prev => {
        const next = [...prev];
        next[sectionIndex] = (next[sectionIndex] ?? []).filter(t => t.id !== snap.id);
        return next;
      });
    } finally {
      setRegeneratingSectionIndex(null);
    }
  };

  const handleSpliceComplete = (
    newInstUrl: string,
    newVocUrl: string | undefined,
    newTs: WordTimestamp[],
    sectionIdx: number,
    newSectionStartMs: number,
    newSectionEndMs: number,
  ) => {
    setLiveInstrumentalUrl(newInstUrl);
    if (newVocUrl !== undefined) setLiveVocalsUrl(newVocUrl);
    setLiveWordTimestamps(newTs);
    setSongTakes(prev => prev.map(t =>
      t.id === activeSongTakeId
        ? { ...t, audioUrl: newInstUrl, instrumentalUrl: newInstUrl, vocalsUrl: newVocUrl ?? t.vocalsUrl, wordTimestamps: newTs }
        : t
    ));
    // Update section timings so subsequent regenerations target the correct window
    setSectionTimings(prev => {
      const oldEndMs = prev[sectionIdx]?.endMs ?? newSectionEndMs;
      const drift    = newSectionEndMs - oldEndMs;
      return prev.map((t, i) => {
        if (i === sectionIdx) return { startMs: newSectionStartMs, endMs: newSectionEndMs };
        if (i > sectionIdx)   return { startMs: t.startMs + drift, endMs: t.endMs + drift };
        return t;
      });
    });
  };

  // ── Auto-regenerate dirty sections then play ─────────────────────────────────

  const handleHearMySong = async () => {
    if (!liveInstrumentalUrl) {
      void generateAudio();
      return;
    }

    const dirty: { index: number; mode: 'vocals' | 'instruments' | 'both' }[] = [];
    for (let i = 0; i < Math.min(song.sections.length, lockedSections.length); i++) {
      const mode = getSectionDirtyMode(song.sections[i], lockedSections[i]);
      if (mode) dirty.push({ index: i, mode });
    }

    if (dirty.length > 0) {
      setAutoRegenRunning(true);
      try {
        for (const { index, mode } of dirty) {
          await handleRegenerateSection(index, mode);
        }
      } finally {
        setAutoRegenRunning(false);
      }
    }

    setPlayAudioTrigger(prev => prev + 1);
  };

  // ── Stem-level regeneration ───────────────────────────────────────────────────

  /** Generate a fresh vocal take aligned to the existing instrumental. */
  const regenerateVocals = async () => {
    setRegeneratingVocals(true);
    setError('');
    try {
      // Step 1: Ensure we have a clean separated instrumental stem.
      // If not already split, do it now and keep the clean instrumental.
      let cleanInstUrl = liveInstrumentalUrl;
      if (!liveVocalsUrl) {
        const { instrumentalUrl, vocalsUrl } = await doSplit(liveInstrumentalUrl);
        cleanInstUrl = instrumentalUrl;
        setLiveInstrumentalUrl(instrumentalUrl);
        setLiveVocalsUrl(vocalsUrl); // placeholder — will be replaced below
        setAudioResetKey(k => k + 1);
        setSongTakes(prev => prev.map(t =>
          t.id === activeSongTakeId ? { ...t, instrumentalUrl, vocalsUrl } : t
        ));
      }

      // Step 2: Generate a fresh full mix.
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...song, audioPrompt }),
      });
      if (!res.ok) throw new Error(await res.text());
      const { audioUrl: newMixUrl, wordTimestamps } = await res.json() as { audioUrl: string; wordTimestamps: WordTimestamp[] };

      // Step 3: Split the new mix → take only the vocals stem.
      const audioDataUrl = newMixUrl.startsWith('blob:') ? await blobUrlToDataUrl(newMixUrl) : newMixUrl;
      const splitRes = await fetch('/api/split', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audioUrl: audioDataUrl }),
      });
      if (!splitRes.ok) throw new Error(await splitRes.text());
      const { vocals: vocalsDataUrl } = await splitRes.json() as { vocals: string; instrumental: string };
      const rawVocalsUrl = await toBlobUrl(vocalsDataUrl);

      // Step 4: Trim new vocals to beat 1 so they start in phase with the instrumental.
      const { url: trimmedVocalsUrl, trimmedMs } = await trimToDownbeat(rawVocalsUrl, song.tempo);
      const adjustedTimestamps = trimmedMs > 0
        ? wordTimestamps.map(w => ({
            ...w,
            start_ms: Math.max(0, w.start_ms - trimmedMs),
            end_ms:   Math.max(0, w.end_ms   - trimmedMs),
          }))
        : wordTimestamps;

      // Step 5: Align durations so instrumental and vocals stay in sync throughout.
      const { urlA: alignedInst, urlB: alignedVocals } = await alignTracks(cleanInstUrl, trimmedVocalsUrl);

      setLiveInstrumentalUrl(alignedInst);
      setLiveVocalsUrl(alignedVocals);
      setLiveWordTimestamps(adjustedTimestamps);
      setAudioResetKey(k => k + 1);
      setSongTakes(prev => prev.map(t =>
        t.id === activeSongTakeId
          ? { ...t, audioUrl: alignedInst, instrumentalUrl: alignedInst, vocalsUrl: alignedVocals, wordTimestamps: adjustedTimestamps }
          : t
      ));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Vocal regeneration failed');
    } finally {
      setRegeneratingVocals(false);
    }
  };

  /** Generate a fresh instrumental aligned to the existing vocal track. */
  const regenerateInstrumental = async () => {
    setRegeneratingInstrumental(true);
    setError('');
    try {
      // Step 1: Ensure we have a clean separated vocal stem.
      // If not already split, do it now and keep the clean vocals.
      let cleanVocalsUrl = liveVocalsUrl ?? null;
      if (!cleanVocalsUrl) {
        const { instrumentalUrl, vocalsUrl } = await doSplit(liveInstrumentalUrl);
        cleanVocalsUrl = vocalsUrl;
        setLiveInstrumentalUrl(instrumentalUrl); // placeholder — will be replaced below
        setLiveVocalsUrl(vocalsUrl);
        setAudioResetKey(k => k + 1);
        setSongTakes(prev => prev.map(t =>
          t.id === activeSongTakeId ? { ...t, instrumentalUrl, vocalsUrl } : t
        ));
      }

      // Step 2: Generate a fresh instrumental-only mix.
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...song, audioPrompt, forceInstrumental: true }),
      });
      if (!res.ok) throw new Error(await res.text());
      const { audioUrl: rawInstUrl } = await res.json() as { audioUrl: string; wordTimestamps: WordTimestamp[] };

      // Step 3: Trim new instrumental to beat 1 so it starts in phase with the vocals.
      const { url: trimmedInstUrl } = await trimToDownbeat(rawInstUrl, song.tempo);

      // Step 4: Align durations so vocals and instrumental stay in sync throughout.
      const { urlA: alignedInst, urlB: alignedVocals } = await alignTracks(trimmedInstUrl, cleanVocalsUrl);

      setLiveInstrumentalUrl(alignedInst);
      setLiveVocalsUrl(alignedVocals);
      setAudioResetKey(k => k + 1);
      setSongTakes(prev => prev.map(t =>
        t.id === activeSongTakeId
          ? { ...t, audioUrl: alignedInst, instrumentalUrl: alignedInst, vocalsUrl: alignedVocals }
          : t
      ));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Instrumental regeneration failed');
    } finally {
      setRegeneratingInstrumental(false);
    }
  };

  // ── Vocals recording ─────────────────────────────────────────────────────────

  /** Play a short beep tone using the Web Audio API. */
  const playBeep = (freqHz: number, durationMs: number, volume = 0.25) => {
    try {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = freqHz;
      gain.gain.setValueAtTime(volume, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + durationMs / 1000);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + durationMs / 1000);
      osc.onended = () => void ctx.close();
    } catch { /* ignore — non-critical */ }
  };

  const startVocalsRecording = async () => {
    setVocalsRecordingPrep(true);
    setError('');
    try {
      // Only split if the audio was generated with embedded vocals (i.e. not instrumental-only).
      // If it was already generated without vocals, it's already a clean track — no split needed.
      let instUrl = liveInstrumentalUrl;
      if (!liveVocalsUrl && liveAudioHasVocals) {
        const { instrumentalUrl, vocalsUrl } = await doSplit(liveInstrumentalUrl);
        instUrl = instrumentalUrl;
        setLiveInstrumentalUrl(instrumentalUrl);
        setLiveVocalsUrl(vocalsUrl);
        setAudioResetKey(k => k + 1);
        setSongTakes(prev => prev.map(t =>
          t.id === activeSongTakeId ? { ...t, instrumentalUrl, vocalsUrl } : t
        ));
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      vocalsStreamRef.current = stream;

      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
        .find(m => MediaRecorder.isTypeSupported(m)) ?? '';
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      vocalsRecorderRef.current = recorder;
      vocalsChunksRef.current = [];

      recorder.ondataavailable = e => { if (e.data.size > 0) vocalsChunksRef.current.push(e.data); };
      // Take number is based on how many recorded takes already exist
      const takeIndex = extraVocalTracks.length;

      recorder.onstop = async () => {
        vocalsStreamRef.current?.getTracks().forEach(t => t.stop());
        const blob = new Blob(vocalsChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        const rawUrl = URL.createObjectURL(blob);
        const label = `Take ${takeIndex + 1}`;

        // Pad the recording with silence so it matches the instrumental duration.
        const instUrl = liveInstrumentalUrl;
        const url = instUrl ? await padToMatch(rawUrl, instUrl) : rawUrl;

        // Always prepend as a new take — never overwrite existing vocals
        const id = crypto.randomUUID();
        setExtraVocalTracks(prev => [{ id, url, label }, ...prev]);
        setActiveExtraVocalId(id);
        setVocalsStream(null);
        setVocalsRecording(false);
      };

      // 3-2-1 countdown with beeps
      for (const n of [3, 2, 1]) {
        setVocalsCountdown(n);
        playBeep(n === 1 ? 880 : 440, 120);
        await new Promise(r => setTimeout(r, 900));
      }
      setVocalsCountdown(null);

      // "Go!" flash — then immediately start recording + playback
      setVocalsGo(true);
      playBeep(1200, 100, 0.5);
      await new Promise(r => setTimeout(r, 350));
      setVocalsGo(false);

      recorder.start(100);
      setVocalsRecording(true);
      setVocalsStream(stream);
      setPlayAudioTrigger(prev => prev + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not access microphone — check browser permissions.');
    } finally {
      setVocalsRecordingPrep(false);
    }
  };

  const stopVocalsRecording = () => {
    vocalsRecorderRef.current?.stop();
    setPauseAudioTrigger(prev => prev + 1);
  };

  // ── Timeline editor + Mix-down ───────────────────────────────────────────────

  /** Builds the track list passed to TimelineEditor */
  const buildTimelineTracks = (): TimelineTrack[] => {
    const result: TimelineTrack[] = [];
    if (liveInstrumentalUrl) result.push({
      id: 'instrumental', label: 'Instrumental', url: liveInstrumentalUrl, color: '#f37321',
      wordTimestamps: liveWordTimestamps.length > 0 ? liveWordTimestamps : undefined,
    });
    if (liveVocalsUrl)       result.push({ id: 'vocals-primary', label: 'Vocals 1',    url: liveVocalsUrl,       color: '#60a5fa' });
    extraVocalTracks.forEach(t => result.push({ id: t.id, label: t.label, url: t.url, color: '#34d399' }));
    return result;
  };

  /** Applies changes from the timeline editor back to the track state */
  const handleTimelineApply = (updated: { id: string; url: string; timestamps?: WordTimestamp[] }[]) => {
    for (const { id, url, timestamps } of updated) {
      if (id === 'instrumental') {
        setLiveInstrumentalUrl(url);
        if (timestamps) setLiveWordTimestamps(timestamps);
      } else if (id === 'vocals-primary') {
        setLiveVocalsUrl(url);
        setSongTakes(prev => prev.map(t => t.id === activeSongTakeId ? { ...t, vocalsUrl: url } : t));
      } else {
        setExtraVocalTracks(prev => prev.map(t => t.id === id ? { ...t, url } : t));
      }
    }
    setAudioResetKey(k => k + 1);
  };

  /** Mixes all tracks down to a single WAV and triggers a browser download */
  const handleMixDown = async () => {
    const allUrls = [
      liveInstrumentalUrl,
      liveVocalsUrl,
      ...extraVocalTracks.map(t => t.url),
    ].filter(Boolean) as string[];
    if (allUrls.length === 0) return;
    setMixingDown(true);
    try {
      const mixUrl = await mixTracks(allUrls);
      const a = document.createElement('a');
      a.href = mixUrl;
      a.download = `${song.title.replace(/[^a-z0-9 ]/gi, '').trim() || 'mix'} - Mix.wav`;
      a.click();
      URL.revokeObjectURL(mixUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Mix-down failed');
    } finally {
      setMixingDown(false);
    }
  };

  // ── Instrument stem separation ───────────────────────────────────────────────

  /** Run Demucs on the current instrumental to split into drums / bass / other. */
  const separateInstruments = async () => {
    if (!liveInstrumentalUrl) return;
    setSeparatingInstruments(true);
    setError('');
    setInstSepProgress(0);
    setInstSepStep('Uploading audio…');

    const i1 = setTimeout(() => setInstSepStep('Running AI stem separation…'), 8000);
    const i2 = setTimeout(() => setInstSepStep('Almost done…'), 60000);

    // Slow asymptotic crawl — Demucs can take over a minute
    instSepCrawlRef.current = setInterval(() => {
      setInstSepProgress(prev => prev >= 90 ? prev : prev + (90 - prev) * 0.01);
    }, 350);

    try {
      // liveInstrumentalUrl is a blob:// URL (browser-only). Convert it to a
      // base64 data URL so the server-side route can decode and upload it.
      const audioDataUrl = liveInstrumentalUrl.startsWith('blob:')
        ? await blobUrlToDataUrl(liveInstrumentalUrl)
        : liveInstrumentalUrl;
      const res = await fetch('/api/split/instruments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audioUrl: audioDataUrl }),
      });
      if (!res.ok) throw new Error(await res.text());
      setInstrumentStems(await res.json() as { drums: string; bass: string; other: string });
      setOtherStemSplit(null); // reset any prior sub-separation
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Instrument separation failed');
    } finally {
      clearTimeout(i1); clearTimeout(i2);
      if (instSepCrawlRef.current) clearInterval(instSepCrawlRef.current);
      setInstSepProgress(100);
      setInstSepStep('Done');
      setSeparatingInstruments(false);
    }
  };

  /** Run Demucs again on the "Other" stem to further separate what remains. */
  const separateOtherStem = async () => {
    if (!instrumentStems?.other) return;
    setSeparatingOtherStem(true);
    setError('');
    // Reuse the instrument-separation progress UI
    setInstSepProgress(0);
    setInstSepStep('Uploading Other stem…');
    const i1 = setTimeout(() => setInstSepStep('Separating vocals and instruments…'), 3000);
    separationCrawlRef.current = setInterval(() => {
      setInstSepProgress(prev => prev >= 90 ? prev : prev + (90 - prev) * 0.04);
    }, 350);
    try {
      const audioUrl = instrumentStems.other.startsWith('blob:')
        ? await blobUrlToDataUrl(instrumentStems.other)
        : instrumentStems.other;
      const res = await fetch('/api/split', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audioUrl }),
      });
      if (!res.ok) throw new Error(await res.text());
      const { vocals, instrumental } = await res.json() as { vocals: string; instrumental: string };
      setOtherStemSplit({ vocals, instrumental });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Other stem separation failed');
    } finally {
      clearTimeout(i1);
      if (separationCrawlRef.current) clearInterval(separationCrawlRef.current);
      setInstSepProgress(100);
      setInstSepStep('Done');
      setSeparatingOtherStem(false);
    }
  };


  // ── Song take management ──────────────────────────────────────────────────────

  const selectSongTake = (id: string) => {
    if (id === activeSongTakeId) return;
    const take = songTakes.find(t => t.id === id);
    if (!take) return;
    setActiveSongTakeId(id);
    setLiveInstrumentalUrl(take.instrumentalUrl);
    setLiveVocalsUrl(take.vocalsUrl);
    setLiveWordTimestamps(take.wordTimestamps);
    setSong(s => ({ ...s, sections: take.sections.map(sec => ({ ...sec })) }));
    setLockedSections(take.sections.map(s => ({ ...s })));
  };

  const renameSongTake = (id: string, label: string) => {
    if (!label.trim()) return;
    setSongTakes(prev => prev.map(t => t.id === id ? { ...t, label: label.trim() } : t));
  };

  // ── Section take restoration ──────────────────────────────────────────────────

  const handleRestoreSectionTake = (sectionIndex: number, take: SectionTake) => {
    updateSection(sectionIndex, take.section);
    const instUrl = take.instrumentalUrl ?? take.audioUrl;
    setLiveInstrumentalUrl(instUrl);
    setLiveVocalsUrl(take.vocalsUrl);
    setLiveWordTimestamps(take.wordTimestamps);
    setAudioResetKey(k => k + 1);
    if (activeSongTakeId) {
      setSongTakes(prev => prev.map(t =>
        t.id === activeSongTakeId
          ? { ...t, audioUrl: instUrl, instrumentalUrl: instUrl, vocalsUrl: take.vocalsUrl, wordTimestamps: take.wordTimestamps }
          : t
      ));
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-6">

      {/* ── Song metadata — editable ── */}
      <div className="rounded-xl border border-[#e9e9e9] bg-white p-5 shadow-[0_2px_8px_rgba(0,0,0,0.06)]">
        <input
          type="text"
          value={song.title}
          onChange={e => setSong(s => ({ ...s, title: e.target.value }))}
          className="block w-full text-xl font-bold text-[#3b3b3b] bg-transparent border-none outline-none mb-4 hover:underline hover:decoration-[#bdbdbd] focus:underline focus:decoration-[#f37321] underline-offset-2 placeholder-[#bdbdbd]"
          placeholder="Song title"
        />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {([
            ['Genre', 'genre', 'text'],
            ['Mood',  'mood',  'text'],
            ['Key',   'key',   'text'],
          ] as const).map(([label, field]) => (
            <div key={field}>
              <p className="text-[10px] uppercase tracking-wider text-[#929292] font-semibold mb-0.5">{label}</p>
              <input
                type="text"
                value={song[field]}
                onChange={e => setSong(s => ({ ...s, [field]: field === 'genre' ? e.target.value.toLowerCase() : e.target.value }))}
                className="text-sm font-medium text-[#3b3b3b] bg-transparent border-none outline-none w-full hover:underline hover:decoration-[#bdbdbd] focus:underline focus:decoration-[#f37321] underline-offset-2"
              />
            </div>
          ))}
          <div>
            <p className="text-[10px] uppercase tracking-wider text-[#929292] font-semibold mb-0.5">Tempo</p>
            <div className="flex items-center gap-1">
              <input
                type="number"
                min={40}
                max={240}
                value={song.tempo}
                onChange={e => {
                  const t = parseInt(e.target.value, 10);
                  if (!isNaN(t) && t >= 40 && t <= 240) setSong(s => ({ ...s, tempo: t }));
                }}
                className="text-sm font-medium text-[#3b3b3b] bg-transparent border-none outline-none w-12 text-right hover:underline hover:decoration-[#bdbdbd] focus:underline focus:decoration-[#f37321] underline-offset-2"
              />
              <span className="text-xs text-[#929292]">BPM</span>
            </div>
          </div>
        </div>
        <div className="mt-4 pt-4 border-t border-[#e9e9e9]">
          <div className="flex items-center justify-between gap-4">
            {/* Left: Edit Sections (when collapsed) + Regenerate Plan */}
            <div className="flex items-center gap-3 flex-1 min-w-0">
              {hasAudio && !sectionsOpen && (
                <button
                  onClick={() => onSectionsOpenChange(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#bdbdbd] text-[#676767] hover:border-[#f37321] hover:text-[#f37321] text-xs font-semibold transition-colors flex-shrink-0"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h8" />
                  </svg>
                  Edit Sections
                </button>
              )}
              {/* Regenerate Plan — left side so Generate Audio stays uncluttered */}
              <button
                onClick={() => void generateAudio()}
                disabled={generating || autoRegenRunning}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#bdbdbd] text-[#676767] hover:border-[#f37321] hover:text-[#f37321] disabled:opacity-40 disabled:cursor-not-allowed text-xs font-semibold transition-colors flex-shrink-0"
              >
                {generating ? 'Generating…' : (
                  <>
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    Regenerate Plan
                  </>
                )}
              </button>
            </div>

            {/* Right: Add Vocals + Generate Audio split-button with mode dropdown */}
            <div className="flex items-center gap-2 flex-shrink-0">
              {/* Record Vocals — visible once audio has been generated */}
              {hasAudio && (
                <>
                  {/* Record Vocals — mic recording over the instrumental */}
                  {/* Countdown and recording state are shown as fixed overlays; just show the idle button here */}
                  {!vocalsRecording && vocalsCountdown === null && (
                    <button
                      type="button"
                      onClick={() => void startVocalsRecording()}
                      disabled={vocalsRecordingPrep || regeneratingVocals || generating}
                      className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-[#bdbdbd] text-[#676767] hover:border-[#f37321] hover:text-[#f37321] disabled:opacity-40 disabled:cursor-not-allowed text-xs font-semibold transition-colors"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                      </svg>
                      {vocalsRecordingPrep ? 'Preparing…' : 'Record Vocals'}
                    </button>
                  )}
                </>
              )}

              {/* Generate Audio — split button with mode dropdown */}
              <div className="relative flex" ref={modeDropdownRef}>
                <button
                  onClick={() => void generateAudio()}
                  disabled={autoRegenRunning || generating || regeneratingVocals || vocalsRecording}
                  className="flex items-center gap-1.5 px-5 py-2.5 rounded-l-lg bg-[#f37321] hover:bg-[#da6520] disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold transition-colors shadow-[0_2px_4px_rgba(243,115,33,0.3)]"
                >
                  {autoRegenRunning ? (
                    'Generating…'
                  ) : (
                    <>
                      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
                      {hasAudio ? 'Generate Another Version' : 'Generate Music'}
                    </>
                  )}
                </button>
                {/* Dropdown chevron */}
                <button
                  type="button"
                  onClick={() => setModeDropdownOpen(v => !v)}
                  className="px-2 py-2.5 rounded-r-lg bg-[#f37321] hover:bg-[#da6520] border-l border-[#e05f10] text-white transition-colors shadow-[0_2px_4px_rgba(243,115,33,0.3)]"
                  aria-label="Choose generation mode"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {/* Mode dropdown */}
                {modeDropdownOpen && (
                  <div className="absolute right-0 top-full mt-1 w-52 bg-white rounded-lg border border-[#e9e9e9] shadow-[0_4px_16px_rgba(0,0,0,0.12)] z-30 py-1 overflow-hidden">
                    {([
                      { value: 'both',         label: 'Vocals + Instrumental', desc: 'Full song with vocals' },
                      { value: 'instrumental', label: 'Instrumental only',     desc: 'No vocals' },
                    ] as const).map(({ value, label, desc }) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => { setGenerateMode(value); setModeDropdownOpen(false); }}
                        className={`w-full text-left px-4 py-2.5 transition-colors ${
                          generateMode === value ? 'bg-[#fff3eb]' : 'hover:bg-[#f6f6f6]'
                        }`}
                      >
                        <p className={`text-sm font-semibold ${generateMode === value ? 'text-[#f37321]' : 'text-[#1e2235]'}`}>{label}</p>
                        <p className="text-[11px] text-[#929292]">{desc}</p>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Sections — collapsible, above waveform */}
      {sectionsOpen && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-[#929292] uppercase tracking-wider">Sections</span>
            {hasAudio && (
              <button
                onClick={() => onSectionsOpenChange(false)}
                className="w-6 h-6 flex items-center justify-center rounded hover:bg-[#e9e9e9] text-[#929292] hover:text-[#3b3b3b] transition-colors"
                aria-label="Close sections"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>

          <div className="grid grid-cols-3 lg:grid-cols-4 gap-4">
            {song.sections.map((section, i) => {
              const isDragging = dragIndex === i;
              const isOver     = dragOverIndex === i && dragIndex !== i;
              return (
                <div
                  key={i}
                  onDragOver={e => { e.preventDefault(); setDragOverIndex(i); }}
                  onDragLeave={() => setDragOverIndex(null)}
                  onDrop={() => handleDrop(i)}
                  onDragEnd={() => { setDragIndex(null); setDragOverIndex(null); }}
                  className={`flex flex-col gap-2 transition-opacity ${isDragging ? 'opacity-40' : ''}`}
                  style={isOver ? { outline: '2px solid #f37321', borderRadius: 10 } : undefined}
                >
                  {/* Drag handle — only this element is draggable, so inputs stay selectable */}
                  <div
                    draggable
                    onDragStart={() => setDragIndex(i)}
                    className="flex items-center justify-center h-4 cursor-grab active:cursor-grabbing select-none text-[#d0d0d0] hover:text-[#929292] transition-colors"
                    title="Drag to reorder"
                  >
                    <svg width="20" height="8" viewBox="0 0 20 8" fill="currentColor">
                      <circle cx="4"  cy="2" r="1.3"/><circle cx="10" cy="2" r="1.3"/><circle cx="16" cy="2" r="1.3"/>
                      <circle cx="4"  cy="6" r="1.3"/><circle cx="10" cy="6" r="1.3"/><circle cx="16" cy="6" r="1.3"/>
                    </svg>
                  </div>
                  {confirmDeleteIndex === i && (
                    <div className="flex items-center gap-3 px-4 py-3 rounded-lg border border-red-200 bg-red-50 text-sm">
                      <span className="text-red-700 flex-1">
                        Delete <span className="font-semibold">{section.label}</span>?
                      </span>
                      <button onClick={() => void deleteSection(i)} disabled={deletingSection} className="px-3 py-1 rounded bg-red-600 hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-medium transition-colors">{deletingSection ? 'Deleting…' : 'Delete'}</button>
                      <button onClick={() => setConfirmDeleteIndex(null)} className="px-3 py-1 rounded bg-[#e9e9e9] hover:bg-[#bdbdbd] text-[#3b3b3b] text-xs font-medium transition-colors">Cancel</button>
                    </div>
                  )}
                  <SectionEditor
                    section={section}
                    index={i}
                    tempo={song.tempo}
                    onChange={updateSection}
                    onRegenerate={hasAudio ? (mode) => handleRegenerateSection(i, mode) : undefined}
                    regenerating={regeneratingSectionIndex === i}
                    isNewSection={hasAudio && sectionTimings[i] !== undefined && sectionTimings[i].startMs === sectionTimings[i].endMs}
                    onInsertAfter={() => insertSection(i)}
                    onDelete={song.sections.length > 1 ? () => setConfirmDeleteIndex(i) : undefined}
                    sectionTakes={sectionTakes[i]}
                    onRestoreTake={take => handleRestoreSectionTake(i, take)}
                    isPlaying={playingSection === i}
                    onPlay={hasAudio ? () => {
                      if (playingSection === i) {
                        setPauseAudioTrigger(prev => prev + 1);
                      } else {
                        setPlaySectionRequest(prev => ({ index: i, seq: (prev?.seq ?? 0) + 1 }));
                      }
                    } : undefined}
                  />

                </div>
              );
            })}

            <button
              onClick={() => insertSection(song.sections.length - 1)}
              className="rounded-lg border-2 border-dashed border-[#bdbdbd] hover:border-[#f37321] text-[#929292] hover:text-[#f37321] flex items-center justify-center text-2xl transition-colors min-h-[80px]"
              title="Add section"
            >
              +
            </button>
          </div>
        </div>
      )}

      {/* Song takes selector + AudioPlayer */}
      {hasAudio && (
        <div id="song-audio-player" className="flex flex-col gap-3">
          {error && <p className="text-sm text-red-600">{error}</p>}
          {/* Takes bar */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-semibold text-[#929292] uppercase tracking-widest">Takes</span>
            {songTakes.map(take => (
              <div key={take.id}>
                {editingTakeId === take.id ? (
                  <input
                    autoFocus
                    defaultValue={take.label}
                    onBlur={e => {
                      renameSongTake(take.id, e.target.value);
                      setEditingTakeId(null);
                    }}
                    onKeyDown={e => {
                      if (e.key === 'Enter') e.currentTarget.blur();
                      if (e.key === 'Escape') setEditingTakeId(null);
                    }}
                    className="px-2 py-0.5 rounded text-xs bg-white border border-[#f37321] text-[#3b3b3b] outline-none w-24"
                  />
                ) : (
                  <button
                    onClick={() => selectSongTake(take.id)}
                    onDoubleClick={() => setEditingTakeId(take.id)}
                    title="Click to select · Double-click to rename"
                    className={`px-3 py-1 rounded text-xs font-semibold transition-colors ${
                      take.id === activeSongTakeId
                        ? 'bg-[#f37321] text-white shadow-[0_1px_4px_rgba(243,115,33,0.4)]'
                        : 'bg-white border border-[#bdbdbd] text-[#676767] hover:border-[#f37321] hover:text-[#f37321]'
                    }`}
                  >
                    {take.label}
                  </button>
                )}
              </div>
            ))}
            {/* Spacer + Edit Tracks + Mix Down — far right */}
            <div className="flex-1" />
            {separationMethod && (
              <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                separationMethod === 'elevenlabs'
                  ? 'bg-[#e8f5e9] text-[#2e7d32]'
                  : 'bg-[#fff3e0] text-[#e65100]'
              }`}>
                {separationMethod === 'elevenlabs' ? 'ElevenLabs stems' : 'ICA fallback'}
              </span>
            )}
            {liveInstrumentalUrl && (
              <>
                <button
                  onClick={() => setShowTimeline(true)}
                  className="flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-medium border border-[#e0e0e0] text-[#929292] hover:text-[#f37321] hover:border-[#f37321] transition-colors"
                  title="Open track editor"
                >
                  <svg className="w-3 h-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <rect x="1" y="4" width="6" height="3" rx="0.5"/><rect x="9" y="4" width="6" height="3" rx="0.5"/><rect x="3" y="9" width="7" height="3" rx="0.5"/>
                  </svg>
                  Edit Tracks
                </button>
                <button
                  onClick={handleMixDown}
                  disabled={mixingDown}
                  className="flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-medium border border-[#e0e0e0] text-[#929292] hover:text-[#f37321] hover:border-[#f37321] transition-colors disabled:opacity-40"
                  title="Mix all tracks down to a WAV file"
                >
                  <svg className="w-3 h-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M8 2v8M5 7l3 3 3-3M2 13h12"/>
                  </svg>
                  {mixingDown ? 'Mixing…' : 'Mix Down'}
                </button>
              </>
            )}
          </div>

          {/* Active AudioPlayer */}
          {activeSongTakeId && (
            <AudioPlayer
              key={`${activeSongTakeId}-${audioResetKey}`}
              audioUrl={liveInstrumentalUrl}
              vocalsUrl={liveVocalsUrl}
              title={song.title}
              sections={song.sections}
              wordTimestamps={liveWordTimestamps}
              tempo={song.tempo}
              pendingRegeneration={sectionRegeneration}
              onRegenerationComplete={() => setSectionRegeneration(null)}
              onSpliceComplete={handleSpliceComplete}
              onActiveSectionChange={setPlayingSection}
              onRegenerateVocals={liveVocalsUrl ? regenerateVocals : undefined}
              onRegenerateInstrumental={regenerateInstrumental}
              regeneratingVocals={regeneratingVocals}
              regeneratingInstrumental={regeneratingInstrumental}
              instrumentStems={instrumentStems}
              stemLabels={deriveStemLabels(song.sections)}
              onSeparateInstruments={separateInstruments}
              separatingInstruments={separatingInstruments}
              otherStemSplit={otherStemSplit}
              onSeparateOtherStem={instrumentStems ? separateOtherStem : undefined}
              separatingOtherStem={separatingOtherStem}
              onSplitTracks={liveInstrumentalUrl && !forceInstrumental ? splitTracks : undefined}
              onRejoinTracks={liveVocalsUrl && preSplitUrlRef.current ? rejoinTracks : undefined}
              splitting={separating}
              playTrigger={playAudioTrigger}
              pauseTrigger={pauseAudioTrigger}
              playSectionRequest={playSectionRequest ?? undefined}
              vocalsRecordingStream={vocalsStream}
              extraVocalTracks={extraVocalTracks}
              onDeleteVocalsTrack={id => {
                setExtraVocalTracks(prev => {
                  const next = prev.filter(t => t.id !== id);
                  if (id === activeExtraVocalId) setActiveExtraVocalId(next[0]?.id ?? null);
                  return next;
                });
              }}
              activeExtraVocalId={activeExtraVocalId}
              onSelectExtraVocal={setActiveExtraVocalId}
              onDeletePrimaryVocals={() => {
                setLiveVocalsUrl(undefined);
                setAudioResetKey(k => k + 1);
              }}
            />
          )}


        </div>
      )}

      {/* Timeline Editor modal */}
      {showTimeline && (
        <TimelineEditor
          tracks={buildTimelineTracks()}
          onApply={handleTimelineApply}
          onClose={() => setShowTimeline(false)}
        />
      )}

      {/* 3-2-1 Countdown modal */}
      {vocalsCountdown !== null && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm pointer-events-none">
          <div className="flex flex-col items-center gap-3">
            <span
              key={vocalsCountdown}
              className="text-[120px] font-black text-white leading-none tabular-nums"
              style={{ textShadow: '0 0 40px rgba(243,115,33,0.8)', animation: 'countdownPop 0.25s ease-out' }}
            >
              {vocalsCountdown}
            </span>
            <span className="text-white/60 text-sm font-medium uppercase tracking-widest">Get ready…</span>
          </div>
        </div>
      )}

      {/* "Go!" flash */}
      {vocalsGo && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center pointer-events-none">
          <span
            className="text-[160px] font-black text-[#f37321] leading-none"
            style={{ textShadow: '0 0 60px rgba(243,115,33,0.9)', animation: 'countdownPop 0.2s ease-out' }}
          >
            Go!
          </span>
        </div>
      )}

      {/* Stop Recording button — large, top center */}
      {vocalsRecording && (
        <div className="fixed top-6 left-1/2 -translate-x-1/2 z-[60]">
          <button
            type="button"
            onClick={stopVocalsRecording}
            className="flex items-center gap-3 px-12 py-5 rounded-full border-3 border-red-500 bg-white text-red-600 hover:bg-red-50 text-2xl font-black shadow-[0_8px_40px_rgba(239,68,68,0.5)] transition-all"
            style={{ border: '3px solid rgb(239 68 68)' }}
          >
            <span className="w-5 h-5 rounded-full bg-red-500 animate-pulse flex-shrink-0" />
            Stop Recording
          </button>
        </div>
      )}

      {/* Audio generation progress — floating fixed overlay */}
      {(generating || separating || separatingInstruments || separatingOtherStem) && (
        <div id="audio-generation-progress" className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
          <div className="rounded-xl border border-[#e9e9e9] bg-white p-6 shadow-[0_8px_40px_rgba(0,0,0,0.18)] w-[640px] max-w-[90vw]">
            {generating ? (
              <>
                <div className="flex items-center justify-between mb-3">
                  <span className="font-semibold text-[#3b3b3b]">Generating Audio</span>
                  <span className="text-sm tabular-nums text-[#929292]">{Math.round(audioProgress)}%</span>
                </div>
                <div className="w-full h-2 rounded-full bg-[#e9e9e9] overflow-hidden mb-3">
                  <div className="h-full rounded-full bg-[#f37321] transition-all duration-700 ease-out" style={{ width: `${audioProgress}%` }} />
                </div>
                <p className="text-xs text-[#929292]">{deriveAudioLabel(audioProgress)}</p>
              </>
            ) : separating ? (
              <>
                <div className="flex items-center justify-between mb-3">
                  <span className="font-semibold text-[#3b3b3b]">Splitting Tracks</span>
                  <span className="text-sm tabular-nums text-[#929292]">{Math.round(separationProgress)}%</span>
                </div>
                <div className="w-full h-2 rounded-full bg-[#e9e9e9] overflow-hidden mb-3">
                  <div className="h-full rounded-full bg-[#f37321] transition-all duration-700 ease-out" style={{ width: `${separationProgress}%` }} />
                </div>
                <p className="text-xs text-[#929292]">{separationStep}</p>
              </>
            ) : (
              <>
                <div className="flex items-center justify-between mb-3">
                  <span className="font-semibold text-[#3b3b3b]">Separating Instruments</span>
                  <span className="text-sm tabular-nums text-[#929292]">{Math.round(instSepProgress)}%</span>
                </div>
                <div className="w-full h-2 rounded-full bg-[#e9e9e9] overflow-hidden mb-3">
                  <div className="h-full rounded-full bg-[#f37321] transition-all duration-700 ease-out" style={{ width: `${instSepProgress}%` }} />
                </div>
                <p className="text-xs text-[#929292]">{instSepStep}</p>
              </>
            )}
          </div>
        </div>
      )}

    </div>
  );
});

export default SongEditor;
