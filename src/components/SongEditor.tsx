'use client';

import { useEffect, useRef, useState } from 'react';
import type { Song, SongSection, WordTimestamp, SectionTake } from '@/lib/types';
import SectionEditor from './SectionEditor';
import AudioPlayer from './AudioPlayer';
import VocalRecorder from './VocalRecorder';
import { splitStereoToTracks } from '@/lib/audio/split';
import { toBlobUrl } from '@/lib/audio/mix';
import { trimLeadingSilence } from '@/lib/audio/trimSilence';

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
}

interface Props {
  song: Song;
  audioPrompt: string;
  onAudioPromptChange: (v: string) => void;
  melodyUrl: string | null;
  autoGenerate?: boolean;
  onViewLayoutChange?: (layout: 'waveform' | 'sheet') => void;
  playRequestCount?: number;       // increment to request playback (generates if needed)
  onAudioReady?: () => void;       // called when first audio URL becomes available
  onGenerationStart?: () => void;  // called when audio generation begins
  sectionsOpen: boolean;
  onSectionsOpenChange: (v: boolean) => void;
}

let _takeSeq = 0;
const makeTakeId = () => `take-${++_takeSeq}`;

function newSection(afterIndex: number, sections: SongSection[]): SongSection {
  return {
    type: 'verse',
    label: `Section ${sections.length + 1}`,
    lyrics: '',
    chords: [],
  };
}

export default function SongEditor({ song: initial, audioPrompt, onAudioPromptChange, melodyUrl, autoGenerate, onViewLayoutChange, playRequestCount, onAudioReady, onGenerationStart, sectionsOpen, onSectionsOpenChange }: Props) {
  const [song, setSong] = useState<Song>(initial);
  const didAutoGenerate = useRef(false);

  // Song-level takes (one per full generation)
  const [songTakes, setSongTakes] = useState<SongTake[]>([]);
  const [activeSongTakeId, setActiveSongTakeId] = useState<string | null>(null);
  const [liveInstrumentalUrl, setLiveInstrumentalUrl] = useState('');
  const [liveVocalsUrl, setLiveVocalsUrl] = useState<string | undefined>(undefined);
  const [liveWordTimestamps, setLiveWordTimestamps] = useState<WordTimestamp[]>([]);
  const [audioResetKey, setAudioResetKey] = useState(0);
  const [editingTakeId, setEditingTakeId] = useState<string | null>(null);

  // Section-level takes: parallel array, one entry per section index
  const [sectionTakes, setSectionTakes] = useState<SectionTake[][]>(
    () => initial.sections.map(() => [])
  );

  const [playingSection, setPlayingSection] = useState<number | null>(null);

  const [instrumentStems, setInstrumentStems] = useState<{ drums: string; bass: string; other: string } | null>(null);
  const [separatingInstruments, setSeparatingInstruments] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const [generating, setGenerating] = useState(false);
  const [separating, setSeparating] = useState(false);
  const [separationMethod, setSeparationMethod] = useState<'elevenlabs' | 'ica' | null>(null);
  const [forceInstrumental, setForceInstrumental] = useState(false);
  const [regeneratingVocals, setRegeneratingVocals] = useState(false);
  const [regeneratingInstrumental, setRegeneratingInstrumental] = useState(false);
  const [audioProgress, setAudioProgress] = useState(0);
  const audioCrawlRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [separationProgress, setSeparationProgress] = useState(0);
  const [separationStep,     setSeparationStep]     = useState('');
  const separationCrawlRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [instSepProgress, setInstSepProgress] = useState(0);
  const [instSepStep,     setInstSepStep]     = useState('');
  const instSepCrawlRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [error, setError] = useState('');
  const [playAudioTrigger, setPlayAudioTrigger] = useState(0);
  const [activeViewLayout, setActiveViewLayout] = useState<'waveform' | 'sheet'>('waveform');
  const onAudioReadyRef = useRef(onAudioReady);
  useEffect(() => { onAudioReadyRef.current = onAudioReady; }, [onAudioReady]);

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
  const [lockedSections, setLockedSections] = useState<SongSection[]>(initial.sections);

  const hasAudio = songTakes.length > 0;

  // ── Section helpers ──────────────────────────────────────────────────────────

  const updateSection = (index: number, updated: SongSection) => {
    setSong(s => ({
      ...s,
      sections: s.sections.map((sec, i) => (i === index ? updated : sec)),
    }));
  };

  const insertSection = (afterIndex: number) => {
    setSong(s => {
      const next = [...s.sections];
      next.splice(afterIndex + 1, 0, newSection(afterIndex, s.sections));
      return { ...s, sections: next };
    });
    setLockedSections(prev => {
      const next = [...prev];
      next.splice(afterIndex + 1, 0, newSection(afterIndex, prev));
      return next;
    });
    setSectionTakes(prev => {
      const next = [...prev];
      next.splice(afterIndex + 1, 0, []);
      return next;
    });
  };

  const deleteSection = (index: number) => {
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
    onGenerationStart?.();
    setGenerating(true);
    setAudioProgress(5);
    setError('');
    setInstrumentStems(null);
    let audioUrl = '';
    let wordTimestamps: WordTimestamp[] = [];

    try {
      // ── Step 1: Generate the full mix ─────────────────────────────────────
      // If a melody reference is set, use Replicate MusicGen (melody-conditioned).
      // Otherwise use ElevenLabs as before.
      if (melodyUrl) {
        const melodyDataUrl = await blobUrlToDataUrl(melodyUrl);
        const res = await fetch('/api/generate/melody', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ song, melodyDataUrl }),
        });
        if (!res.ok) throw new Error(await res.text());
        ({ audioUrl, wordTimestamps } = await res.json() as {
          audioUrl: string; wordTimestamps: WordTimestamp[];
        });
      } else {
        const res = await fetch('/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...song, audioPrompt, forceInstrumental }),
        });
        if (!res.ok) throw new Error(await res.text());
        ({ audioUrl, wordTimestamps } = await res.json() as {
          audioUrl: string; wordTimestamps: WordTimestamp[];
        });
      }
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
      label: `Take ${songTakes.length + 1}`,
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
    setSeparationMethod(null);
  };

  // ── Manual stem separation ────────────────────────────────────────────────────

  const splitTracks = async () => {
    if (!liveInstrumentalUrl) return;
    setSeparating(true);
    setError('');
    setSeparationProgress(0);
    setSeparationStep('Uploading audio…');

    // Timed step labels
    const t1 = setTimeout(() => setSeparationStep('Separating vocals and instruments…'), 3000);

    // Asymptotic crawl toward 90% while waiting
    separationCrawlRef.current = setInterval(() => {
      setSeparationProgress(prev => prev >= 90 ? prev : prev + (90 - prev) * 0.04);
    }, 350);

    const audioUrl = liveInstrumentalUrl;
    let instrumentalUrl: string;
    let vocalsUrl: string | undefined;

    try {
      const splitRes = await fetch('/api/split', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audioUrl }),
      });
      if (!splitRes.ok) throw new Error(await splitRes.text());
      const { vocals, instrumental } = await splitRes.json() as {
        vocals: string; instrumental: string;
      };
      [instrumentalUrl, vocalsUrl] = await Promise.all([
        toBlobUrl(instrumental),
        toBlobUrl(vocals),
      ]);
      setSeparationMethod('elevenlabs');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('ElevenLabs stem separation failed, using ICA fallback:', msg);
      const split = await splitStereoToTracks(audioUrl);
      instrumentalUrl = split.instrumentalUrl;
      vocalsUrl       = split.vocalsUrl;
      setSeparationMethod('ica');
    }

    clearTimeout(t1);
    if (separationCrawlRef.current) clearInterval(separationCrawlRef.current);
    setSeparationProgress(100);
    setSeparationStep('Done');

    setLiveInstrumentalUrl(instrumentalUrl);
    setLiveVocalsUrl(vocalsUrl);
    setAudioResetKey(k => k + 1);
    setSongTakes(prev => prev.map(t =>
      t.id === activeSongTakeId
        ? { ...t, audioUrl: instrumentalUrl, instrumentalUrl, vocalsUrl }
        : t
    ));
    setSeparating(false);
  };

  // ── Section regeneration ──────────────────────────────────────────────────────

  const handleRegenerateSection = async (sectionIndex: number) => {
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
        body: JSON.stringify({ song, sectionIndex, originalSection: lockedSections[sectionIndex] }),
      });
      if (!res.ok) throw new Error(await res.text());
      const { audioUrl, wordTimestamps, vocalsOnly } = await res.json() as {
        audioUrl: string; wordTimestamps: WordTimestamp[]; vocalsOnly: boolean;
      };

      // For a full-mix regeneration, split into stems client-side.
      // For vocals-only, the API already returned a vocals-only render.
      let instUrl: string;
      let vocUrl: string | undefined;
      if (vocalsOnly) {
        instUrl = liveInstrumentalUrl; // keep existing instrumental unchanged
        vocUrl  = audioUrl;            // new vocals render replaces just the vocal track
      } else {
        const split = await splitStereoToTracks(audioUrl);
        instUrl = split.instrumentalUrl;
        vocUrl  = split.vocalsUrl;
      }

      setSectionRegeneration({
        sectionIndex,
        audioUrl: instUrl,
        instrumentalUrl: instUrl,
        vocalsUrl: vocUrl,
        wordTimestamps,
        vocalsOnly: vocalsOnly ?? false,
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

  const handleSpliceComplete = (newInstUrl: string, newVocUrl: string | undefined, newTs: WordTimestamp[]) => {
    setLiveInstrumentalUrl(newInstUrl);
    if (newVocUrl !== undefined) setLiveVocalsUrl(newVocUrl);
    setLiveWordTimestamps(newTs);
    setSongTakes(prev => prev.map(t =>
      t.id === activeSongTakeId
        ? { ...t, audioUrl: newInstUrl, instrumentalUrl: newInstUrl, vocalsUrl: newVocUrl ?? t.vocalsUrl, wordTimestamps: newTs }
        : t
    ));
  };

  // ── Stem-level regeneration ───────────────────────────────────────────────────

  /** Generate a fresh vocal take from the current song; instrumental stays intact. */
  const regenerateVocals = async () => {
    setRegeneratingVocals(true);
    setError('');
    try {
      // Generate a new full mix (same song, no forceInstrumental)
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...song, audioPrompt }),
      });
      if (!res.ok) throw new Error(await res.text());
      const { audioUrl, wordTimestamps } = await res.json() as { audioUrl: string; wordTimestamps: WordTimestamp[] };

      // Split and extract only the vocals stem
      const splitRes = await fetch('/api/split', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audioUrl }),
      });
      if (!splitRes.ok) throw new Error(await splitRes.text());
      const { vocals } = await splitRes.json() as { vocals: string; instrumental: string };
      const newVocalsUrl = await toBlobUrl(vocals);

      setLiveVocalsUrl(newVocalsUrl);
      setLiveWordTimestamps(wordTimestamps);
      setAudioResetKey(k => k + 1); // remount AudioPlayer so its internal state syncs with new URLs
      setSongTakes(prev => prev.map(t =>
        t.id === activeSongTakeId ? { ...t, vocalsUrl: newVocalsUrl, wordTimestamps } : t
      ));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Vocal regeneration failed');
    } finally {
      setRegeneratingVocals(false);
    }
  };

  /** Generate a fresh instrumental under the current vocals; vocal track stays intact. */
  const regenerateInstrumental = async () => {
    setRegeneratingInstrumental(true);
    setError('');
    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...song, audioPrompt, forceInstrumental: true }),
      });
      if (!res.ok) throw new Error(await res.text());
      const { audioUrl } = await res.json() as { audioUrl: string; wordTimestamps: WordTimestamp[] };
      const newInstUrl = await toBlobUrl(audioUrl);

      setLiveInstrumentalUrl(newInstUrl);
      setAudioResetKey(k => k + 1);
      setSongTakes(prev => prev.map(t =>
        t.id === activeSongTakeId ? { ...t, audioUrl: newInstUrl, instrumentalUrl: newInstUrl } : t
      ));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Instrumental regeneration failed');
    } finally {
      setRegeneratingInstrumental(false);
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

      {/* Song takes selector + AudioPlayer — always rendered first so waveform is at top */}
      {hasAudio && (
        <div id="song-audio-player" className="flex flex-col gap-3">
          {/* Takes bar */}
          <div className="flex items-center gap-2 justify-end flex-wrap">
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
              onViewLayoutChange={layout => { setActiveViewLayout(layout); onViewLayoutChange?.(layout); }}
              instrumentStems={instrumentStems}
              onSeparateInstruments={separateInstruments}
              separatingInstruments={separatingInstruments}
              playTrigger={playAudioTrigger}
            />
          )}

          {/* Controls below waveform — hidden in sheet mode */}
          {activeViewLayout !== 'sheet' && liveInstrumentalUrl && !forceInstrumental && (
            <div className="flex items-center gap-2 justify-end flex-wrap">
              <button
                onClick={splitTracks}
                disabled={generating || separating}
                className="px-4 py-1.5 rounded-lg border border-[#bdbdbd] text-[#676767] hover:border-[#f37321] hover:text-[#f37321] disabled:opacity-40 disabled:cursor-not-allowed text-sm font-semibold transition-colors"
              >
                {separating ? 'Splitting…' : liveVocalsUrl ? 'Re-split tracks' : 'Split into tracks'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Sections — collapsible, hidden in sheet mode */}
      {sectionsOpen && activeViewLayout !== 'sheet' && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-[#929292] uppercase tracking-wider">Sections</span>
            <button
              onClick={() => onSectionsOpenChange(false)}
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-[#e9e9e9] bg-[#f6f6f6] text-[#929292] hover:border-[#bdbdbd] hover:text-[#3b3b3b] text-xs font-semibold transition-colors"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
              </svg>
              Collapse
            </button>
          </div>

          {/* Section cards */}
          <div className="grid grid-cols-3 lg:grid-cols-4 gap-4">
            {song.sections.map((section, i) => {
              const isDragging = dragIndex === i;
              const isOver     = dragOverIndex === i && dragIndex !== i;
              return (
                <div
                  key={i}
                  draggable
                  onDragStart={() => setDragIndex(i)}
                  onDragOver={e => { e.preventDefault(); setDragOverIndex(i); }}
                  onDragLeave={() => setDragOverIndex(null)}
                  onDrop={() => handleDrop(i)}
                  onDragEnd={() => { setDragIndex(null); setDragOverIndex(null); }}
                  className={`flex flex-col gap-2 transition-opacity ${isDragging ? 'opacity-40' : ''}`}
                  style={isOver ? { outline: '2px solid #f37321', borderRadius: 10 } : undefined}
                >
                  <SectionEditor
                    section={section}
                    index={i}
                    tempo={song.tempo}
                    onChange={updateSection}
                    onRegenerate={hasAudio ? () => handleRegenerateSection(i) : undefined}
                    regenerating={regeneratingSectionIndex === i}
                    onInsertAfter={() => insertSection(i)}
                    onDelete={song.sections.length > 1 ? () => setConfirmDeleteIndex(i) : undefined}
                    sectionTakes={sectionTakes[i]}
                    onRestoreTake={take => handleRestoreSectionTake(i, take)}
                    isPlaying={playingSection === i}
                  />
                  {confirmDeleteIndex === i && (
                    <div className="flex items-center gap-3 px-4 py-3 rounded-lg border border-red-200 bg-red-50 text-sm">
                      <span className="text-red-700 flex-1">
                        Delete <span className="font-semibold">{section.label}</span>?
                      </span>
                      <button onClick={() => deleteSection(i)} className="px-3 py-1 rounded bg-red-600 hover:bg-red-700 text-white text-xs font-medium transition-colors">Delete</button>
                      <button onClick={() => setConfirmDeleteIndex(null)} className="px-3 py-1 rounded bg-[#e9e9e9] hover:bg-[#bdbdbd] text-[#3b3b3b] text-xs font-medium transition-colors">Cancel</button>
                    </div>
                  )}
                </div>
              );
            })}

            {/* Add section button */}
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

      {/* Instrumental-only toggle */}
      <div className="flex items-center justify-end gap-2">
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <div
            onClick={() => setForceInstrumental(v => !v)}
            className={`relative w-8 h-4 rounded-full transition-colors ${forceInstrumental ? 'bg-[#f37321]' : 'bg-[#bdbdbd]'}`}
          >
            <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform ${forceInstrumental ? 'translate-x-4' : 'translate-x-0.5'}`} />
          </div>
          <span className="text-xs text-[#676767]">Instrumental only</span>
        </label>
      </div>

      {/* Audio generation progress — floating fixed overlay */}
      {(generating || separating || separatingInstruments) && (
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

      {/* Generate / regenerate + Record Vocals */}
      <div className="flex flex-col gap-3">
        {error && <p className="text-sm text-red-600 self-end">{error}</p>}
        <div className="flex gap-3 justify-end flex-wrap">
          <VocalRecorder
            latestAudioUrl={liveInstrumentalUrl || null}
            title={song.title}
          />
          <button
            onClick={generateAudio}
            disabled={generating || separating}
            className="px-6 py-2.5 rounded-lg bg-[#f37321] hover:bg-[#da6520] disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold transition-colors shadow-[0_2px_4px_rgba(243,115,33,0.3)]"
          >
            {generating
              ? 'Generating…'
              : songTakes.length === 0
              ? 'Generate Audio'
              : 'Generate Another Version'}
          </button>
        </div>
      </div>
    </div>
  );
}
