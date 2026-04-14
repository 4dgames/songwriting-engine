'use client';

import { useEffect, useRef, useState } from 'react';
import type { Song } from '@/lib/types';
import PromptInput from '@/components/PromptInput';
import SongEditor from '@/components/SongEditor';
import MelodyRecorder from '@/components/MelodyRecorder';
import SongWizard from '@/components/SongWizard';

const MILESTONES: [string, number, string][] = [
  ['"title"',       8,  'Naming your song…'],
  ['"genre"',       16, 'Choosing the genre…'],
  ['"tempo"',       24, 'Setting the tempo…'],
  ['"sections"',    32, 'Writing the sections…'],
  ['"audioPrompt"', 88, 'Polishing the audio prompt…'],
];

function deriveProgress(text: string): { pct: number; label: string } {
  let pct = 5; let label = 'Starting…';
  for (const [marker, p, l] of MILESTONES) {
    if (text.includes(marker)) { pct = p; label = l; }
    else break;
  }
  if (pct === 32 && !text.includes('"audioPrompt"')) {
    const lyricsCount = (text.match(/"lyrics"/g) ?? []).length;
    const sectionPct = Math.min(lyricsCount * 8, 55);
    if (lyricsCount > 0) {
      pct = 32 + sectionPct;
      const labelMatches = [...text.matchAll(/"label"\s*:\s*"([^"]+)"/g)];
      const sectionName = labelMatches[lyricsCount - 1]?.[1];
      label = sectionName ? `Writing ${sectionName}…` : `Writing section ${lyricsCount}…`;
    }
  }
  return { pct, label };
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-[#929292] font-semibold mb-0.5">{label}</p>
      <p className="text-sm font-medium text-[#3b3b3b] truncate">{value}</p>
    </div>
  );
}

type InputMode = 'wizard' | 'prompt';

export default function Home() {
  const [song,            setSong]            = useState<Song | null>(null);
  const [audioPrompt,     setAudioPrompt]     = useState('');
  const [melodyUrl,       setMelodyUrl]       = useState<string | null>(null);
  const [submittedPrompt, setSubmittedPrompt] = useState('');
  const [editingPrompt,   setEditingPrompt]   = useState(false);
  const [autoGenerate,    setAutoGenerate]    = useState(false);
  const [inputMode,       setInputMode]       = useState<InputMode>('wizard');
  const [loading,         setLoading]         = useState(false);
  const [error,           setError]           = useState('');
  const [progress,        setProgress]        = useState(0);
  const [progressLabel,   setProgressLabel]   = useState('');
  const [viewLayout,      setViewLayout]      = useState<'waveform' | 'sheet'>('waveform');
  const [playRequestCount, setPlayRequestCount] = useState(0);
  const [audioReadyCount,  setAudioReadyCount]  = useState(0);
  const crawlRef      = useRef<ReturnType<typeof setInterval> | null>(null);
  const songEditorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (loading) {
      crawlRef.current = setInterval(() => {
        setProgress(prev => prev >= 97 ? prev : prev + (97 - prev) * 0.04);
      }, 350);
    } else {
      if (crawlRef.current) clearInterval(crawlRef.current);
    }
    return () => { if (crawlRef.current) clearInterval(crawlRef.current); };
  }, [loading]);

  const handleCompose = async (prompt: string) => {
    setLoading(true);
    setError('');
    setSong(null);
    setAutoGenerate(false);
    setProgress(5);
    setProgressLabel('Starting…');

    try {
      const res = await fetch('/api/compose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      if (!res.ok) throw new Error(await res.text());

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let accumulated = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        accumulated += decoder.decode(value, { stream: true });
        const { pct, label } = deriveProgress(accumulated);
        setProgress(prev => Math.max(prev, pct));
        setProgressLabel(label);
      }

      setProgress(98); setProgressLabel('Parsing…');
      const data = JSON.parse(accumulated) as Song;
      setProgress(100);
      setSong(data);
      setAudioPrompt(data.audioPrompt);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmitPrompt = (prompt: string) => {
    setSubmittedPrompt(prompt);
    setEditingPrompt(false);
    handleCompose(prompt);
  };

  // Called by SongWizard when it has finished building the song
  const handleWizardSongReady = (wizardSong: Song, shouldAutoGenerate: boolean) => {
    setSong(wizardSong);
    setAudioPrompt(wizardSong.audioPrompt);
    setSubmittedPrompt('');       // wizard flow — no single prompt string
    setAutoGenerate(shouldAutoGenerate);
  };

  const showPromptDisplay = !!submittedPrompt && !editingPrompt;

  return (
    <div className="min-h-screen flex flex-col">

      {/* ── Top nav ── */}
      <header className="w-full bg-white relative" style={{ boxShadow: '0 1px 0 #e9e9e9' }}>
        <div className="flex items-center gap-0 px-8 h-[80px]">
          <div className="w-12 h-12 rounded flex items-center justify-center flex-shrink-0 mr-3" style={{ backgroundColor: '#f37321' }}>
            <span className="text-white font-bold text-[26px] leading-none select-none" style={{ fontFamily: 'Georgia, "Times New Roman", serif' }}>A</span>
          </div>
          <span className="text-[#676767] text-[20px] font-normal tracking-normal mr-6">classroom</span>
          <div className="w-px self-stretch my-4 bg-[#d4d4d4] mr-6 flex-shrink-0" />
          <span className="text-[#929292] text-sm font-normal ml-auto">Prototype by Gabe Turow</span>
        </div>
        <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-[#d4d4d4]" />
      </header>

      {/* ── Main content ── */}
      <main className="flex-1 flex flex-col items-center py-12 px-4">
        <div className="w-full flex flex-col gap-8 max-w-none">

          <h1 className="tracking-tight text-center" style={{ fontFamily: 'var(--font-merriweather), Georgia, serif', color: '#1e2235', fontWeight: 700, fontSize: '38px' }}>
            Song Maker
          </h1>

          {/* ── Mode toggle ── */}
          <div className="flex justify-center">
            <div className="flex items-center gap-0 rounded-lg border border-[#e9e9e9] bg-[#f6f6f6] p-0.5">
              {(['wizard', 'prompt'] as InputMode[]).map(mode => (
                <button
                  key={mode}
                  onClick={() => setInputMode(mode)}
                  className={`px-4 py-1.5 rounded-md text-sm font-semibold transition-colors ${
                    inputMode === mode
                      ? 'bg-white text-[#f37321] shadow-sm'
                      : 'text-[#929292] hover:text-[#3b3b3b]'
                  }`}
                >
                  {mode === 'wizard' ? 'Chat with AI' : 'Quick prompt'}
                </button>
              ))}
            </div>
          </div>

          {/* ── Centred ½-width input column ── */}
          <div className="flex flex-col gap-3 w-1/2 min-w-72 mx-auto">

            {inputMode === 'wizard' ? (
              <SongWizard
                onSongReady={handleWizardSongReady}
                onPlayRequest={() => setPlayRequestCount(c => c + 1)}
                audioReadyCount={audioReadyCount}
              />
            ) : (
              <>
                {/* Describe your song — display or input */}
                {showPromptDisplay ? (
                  <div className="rounded-lg border border-[#e9e9e9] bg-white p-4 shadow-[0_2px_8px_rgba(0,0,0,0.06)]">
                    <p className="text-xs font-medium text-[#676767] mb-2">Describe your song</p>
                    <p className="text-sm text-[#3b3b3b] leading-relaxed mb-3">{submittedPrompt}</p>
                    <div className="flex items-center gap-2 justify-end">
                      <button
                        onClick={() => setEditingPrompt(true)}
                        className="px-3 py-1.5 rounded-lg border border-[#bdbdbd] text-[#676767] hover:border-[#f37321] hover:text-[#f37321] text-xs font-semibold transition-colors"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => handleCompose(submittedPrompt)}
                        disabled={loading}
                        className="px-4 py-1.5 rounded-lg bg-[#f37321] hover:bg-[#da6520] disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-semibold transition-colors shadow-[0_2px_4px_rgba(243,115,33,0.3)]"
                      >
                        {loading ? 'Composing…' : 'Re-generate song'}
                      </button>
                    </div>
                  </div>
                ) : !song ? (
                  <PromptInput
                    onCompose={handleSubmitPrompt}
                    loading={loading}
                    defaultValue={submittedPrompt}
                  />
                ) : null}

                {/* Progress / error */}
                {loading && (
                  <div className="rounded-lg border border-[#e9e9e9] bg-white p-5 shadow-[0_2px_8px_rgba(0,0,0,0.06)]">
                    <div className="flex items-center justify-between mb-3">
                      <span className="font-semibold text-[#3b3b3b]">Creating Your Song</span>
                      <span className="text-sm tabular-nums text-[#929292]">{Math.round(progress)}%</span>
                    </div>
                    <div className="w-full h-2 rounded-full bg-[#e9e9e9] overflow-hidden mb-3">
                      <div className="h-full rounded-full bg-[#f37321] transition-all duration-700 ease-out" style={{ width: `${progress}%` }} />
                    </div>
                    {progressLabel && <p className="text-xs text-[#929292]">{progressLabel}</p>}
                  </div>
                )}

                {error && (
                  <p className="text-sm text-red-600 rounded-lg border border-red-200 bg-red-50 px-4 py-3">{error}</p>
                )}

                {/* Song description + audio prompt + melody (shown once song exists) */}
                {song && (
                  <>
                    <div className="rounded-lg border border-[#e9e9e9] bg-white p-5 shadow-[0_2px_8px_rgba(0,0,0,0.06)]">
                      <h2 className="text-xl font-bold text-[#3b3b3b] mb-4">{song.title}</h2>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
                        <Stat label="Genre" value={song.genre} />
                        <Stat label="Mood"  value={song.mood} />
                        <Stat label="Key"   value={song.key} />
                        <Stat label="Tempo" value={`${song.tempo} BPM`} />
                      </div>
                    </div>

                    <div className="rounded-lg border border-[#e9e9e9] bg-white p-4 shadow-[0_2px_8px_rgba(0,0,0,0.06)]">
                      <label className="block text-xs font-medium text-[#676767] mb-2">Audio generation prompt</label>
                      <textarea
                        value={audioPrompt}
                        onChange={e => setAudioPrompt(e.target.value.slice(0, 200))}
                        rows={4}
                        maxLength={200}
                        className="w-full rounded bg-[#f6f6f6] border border-[#e9e9e9] text-[#3b3b3b] px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-[#f37321] focus:border-[#f37321]"
                      />
                    </div>

                    <div className="rounded-lg border border-[#e9e9e9] bg-white p-4 shadow-[0_2px_8px_rgba(0,0,0,0.06)] flex flex-col gap-2">
                      <label className="block text-xs font-medium text-[#676767]">
                        Melody reference
                        <span className="text-[#929292] font-normal ml-1">— hum or upload to guide the vocal melody</span>
                      </label>
                      <MelodyRecorder onMelodyChange={setMelodyUrl} />
                    </div>
                  </>
                )}
              </>
            )}
          </div>

          {/* ── Full-width song editor ── */}
          {song && (
            <div ref={songEditorRef}>
              <SongEditor
                key={song.title}
                song={song}
                audioPrompt={audioPrompt}
                onAudioPromptChange={setAudioPrompt}
                melodyUrl={melodyUrl}
                autoGenerate={autoGenerate}
                onViewLayoutChange={setViewLayout}
                playRequestCount={playRequestCount}
                onGenerationStart={() => {
                  setTimeout(() => document.getElementById('audio-generation-progress')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 150);
                }}
                onAudioReady={() => {
                  setAudioReadyCount(c => c + 1);
                  setTimeout(() => document.getElementById('song-audio-player')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 300);
                }}
              />
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
