'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSession, signIn, signOut } from 'next-auth/react';
import type { Song } from '@/lib/types';
import PromptInput from '@/components/PromptInput';
import SongEditor, { type SongEditorHandle } from '@/components/SongEditor';
import SongWizard from '@/components/SongWizard';
import {
  saveProject, loadProject, listProjects, deleteProject,
  blobUrlToArrayBuffer, arrayBufferToBlobUrl,
  type ProjectMeta,
} from '@/lib/projectStorage';

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

type InputMode = 'wizard' | 'prompt';

export default function Home() {
  const { data: session, status: authStatus } = useSession();
  const userId = (session?.user as { id?: string } | undefined)?.id;

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
  const [playRequestCount, setPlayRequestCount] = useState(0);
  const [audioReadyCount,  setAudioReadyCount]  = useState(0);
  const [sectionsOpen,        setSectionsOpen]        = useState(true);
  const [resumeChatSignal,    setResumeChatSignal]    = useState(0);
  const [liveInstrumentalUrl, setLiveInstrumentalUrl] = useState('');
  const [songKey,             setSongKey]             = useState(0);

  // ── Project save / load state ────────────────────────────────────────────────
  const [saving,        setSaving]        = useState(false);
  const [projectsOpen,  setProjectsOpen]  = useState(false);
  const [projects,      setProjects]      = useState<ProjectMeta[]>([]);
  const [loadingProject, setLoadingProject] = useState<string | null>(null); // id being loaded
  const [initialState,  setInitialState]  = useState<Parameters<typeof SongEditor>[0]['initialState']>(undefined);

  const crawlRef      = useRef<ReturnType<typeof setInterval> | null>(null);
  const songEditorRef = useRef<SongEditorHandle>(null);
  const scrollRef     = useRef<HTMLDivElement>(null);
  // Stable ID for the auto-save slot — one entry per song session, overwritten each time
  const autoSaveIdRef = useRef<string | null>(null);

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

  // Reset auto-save slot whenever a new song session starts
  useEffect(() => {
    autoSaveIdRef.current = null;
  }, [songKey]);

  // Auto-save every 30 s when a song with audio is loaded — overwrites the same slot
  useEffect(() => {
    if (!song || !songEditorRef.current) return;
    const intervalId = setInterval(async () => {
      const editor = songEditorRef.current;
      if (!editor) return;
      const state = editor.getProjectState();
      if (!state.instrumentalUrl) return; // nothing to save yet
      try {
        const instrumentalBlob = await blobUrlToArrayBuffer(state.instrumentalUrl);
        const vocalsBlob = state.vocalsUrl ? await blobUrlToArrayBuffer(state.vocalsUrl) : null;
        const savedId = await saveProject(
          {
            name:            `${state.song.title} (auto-save)`,
            songTitle:       state.song.title,
            genre:           state.song.genre,
            song:            state.song,
            audioPrompt:     state.audioPrompt,
            wordTimestamps:  state.wordTimestamps,
            sectionTimings:  state.sectionTimings,
            lockedSections:  state.lockedSections,
            instrumentalBlob,
            vocalsBlob,
            userId,
          },
          autoSaveIdRef.current ?? undefined,  // overwrite existing slot if set
        );
        autoSaveIdRef.current = savedId; // remember this slot for next tick
      } catch { /* best-effort — don't disrupt the user */ }
    }, 30_000);
    return () => clearInterval(intervalId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song]);

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
      setSongKey(k => k + 1);
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
    setSongKey(k => k + 1);
  };

  // ── Save current project ─────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    if (!song || !songEditorRef.current) return;
    const name = window.prompt('Save project as:', song.title) ?? '';
    if (!name.trim()) return;

    setSaving(true);
    try {
      const state = songEditorRef.current.getProjectState();
      const instrumentalBlob = state.instrumentalUrl
        ? await blobUrlToArrayBuffer(state.instrumentalUrl)
        : new ArrayBuffer(0);
      const vocalsBlob = state.vocalsUrl
        ? await blobUrlToArrayBuffer(state.vocalsUrl)
        : null;

      await saveProject({
        name:            name.trim(),
        songTitle:       song.title,
        genre:           song.genre,
        song:            state.song,
        audioPrompt:     state.audioPrompt,
        wordTimestamps:  state.wordTimestamps,
        sectionTimings:  state.sectionTimings,
        lockedSections:  state.lockedSections,
        instrumentalBlob,
        vocalsBlob,
        userId,
      });
    } catch (err) {
      alert(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  }, [song]);

  // ── Open project list ─────────────────────────────────────────────────────────
  const handleOpenProjects = useCallback(async () => {
    const list = await listProjects(userId);
    setProjects(list);
    setProjectsOpen(true);
  }, [userId]);

  // ── Load a saved project ──────────────────────────────────────────────────────
  const handleLoadProject = useCallback(async (id: string) => {
    setLoadingProject(id);
    try {
      const stored = await loadProject(id);
      if (!stored) { alert('Project not found.'); return; }

      const instrumentalUrl = stored.instrumentalBlob?.byteLength
        ? arrayBufferToBlobUrl(stored.instrumentalBlob)
        : '';
      const vocalsUrl = stored.vocalsBlob?.byteLength
        ? arrayBufferToBlobUrl(stored.vocalsBlob)
        : undefined;

      // Close modal and reset all page state before mounting the new editor
      setProjectsOpen(false);
      setSong(null);
      setAudioPrompt(stored.audioPrompt);
      setInitialState({
        wordTimestamps:  stored.wordTimestamps,
        sectionTimings:  stored.sectionTimings,
        lockedSections:  stored.lockedSections,
        instrumentalUrl,
        vocalsUrl,
      });
      setSong(stored.song);
      setSongKey(k => k + 1);
      setSectionsOpen(false);
    } catch (err) {
      alert(`Load failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoadingProject(null);
    }
  }, []);

  // ── Delete a saved project ────────────────────────────────────────────────────
  const handleDeleteProject = useCallback(async (id: string) => {
    if (!window.confirm('Delete this project? This cannot be undone.')) return;
    await deleteProject(id);
    setProjects(prev => prev.filter(p => p.id !== id));
  }, []);

  // ── New project — clears the current session ──────────────────────────────────
  const handleNewProject = useCallback(() => {
    if (song && !window.confirm('Start a new project? Any unsaved work will be lost.')) return;
    setSong(null);
    setAudioPrompt('');
    setSubmittedPrompt('');
    setInitialState(undefined);
    setSongKey(k => k + 1);
    setSectionsOpen(true);
    setLiveInstrumentalUrl('');
  }, [song]);

  const showPromptDisplay = !!submittedPrompt && !editingPrompt;

  return (
    <div className="min-h-screen flex flex-col">

      {/* ── Top nav ── */}
      <header className="w-full bg-white relative" style={{ boxShadow: '0 1px 0 #e9e9e9' }}>
        <div className="flex items-center gap-0 px-8 h-[80px]">
          {/* Brand */}
          <span className="text-[#f37321] text-[28px] font-normal tracking-normal" style={{ fontFamily: 'var(--font-lora), Georgia, serif' }}>Amplify</span>
          <span className="text-[#f37321] text-[28px] font-normal tracking-normal ml-2 mr-6" style={{ fontFamily: 'var(--font-lora), Georgia, serif' }}>Prototypes.</span>
          <div className="w-px self-stretch my-4 bg-[#d4d4d4] mr-6 flex-shrink-0" />

          <div className="flex items-center gap-2 ml-auto">
            {song && (
              <>
                <button
                  onClick={() => void handleSave()}
                  disabled={saving}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#bdbdbd] text-[#676767] hover:border-[#f37321] hover:text-[#f37321] disabled:opacity-40 disabled:cursor-not-allowed text-xs font-semibold transition-colors"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
                  </svg>
                  {saving ? 'Saving…' : 'Save'}
                </button>
                <button
                  onClick={handleNewProject}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#bdbdbd] text-[#676767] hover:border-[#f37321] hover:text-[#f37321] text-xs font-semibold transition-colors"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                  New
                </button>
              </>
            )}
            <button
              onClick={() => void handleOpenProjects()}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#bdbdbd] text-[#676767] hover:border-[#f37321] hover:text-[#f37321] text-xs font-semibold transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
              </svg>
              Projects
            </button>

            {/* ── Auth ── */}
            <div className="w-px self-stretch my-3 bg-[#e9e9e9] mx-1 flex-shrink-0" />
            {authStatus === 'loading' ? (
              <div className="w-7 h-7 rounded-full bg-[#e9e9e9] animate-pulse" />
            ) : session ? (
              <div className="flex items-center gap-2">
                {session.user?.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={session.user.image}
                    alt={session.user.name ?? 'User'}
                    className="w-7 h-7 rounded-full border border-[#e9e9e9]"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <div className="w-7 h-7 rounded-full bg-[#f37321] flex items-center justify-center text-white text-xs font-bold">
                    {session.user?.name?.[0]?.toUpperCase() ?? '?'}
                  </div>
                )}
                <span className="text-xs text-[#676767] max-w-[120px] truncate hidden sm:block">
                  {session.user?.name ?? session.user?.email}
                </span>
                <button
                  onClick={() => void signOut()}
                  className="px-2.5 py-1.5 rounded-lg border border-[#bdbdbd] text-[#929292] hover:border-red-400 hover:text-red-500 text-xs font-semibold transition-colors"
                >
                  Sign out
                </button>
              </div>
            ) : (
              <button
                onClick={() => void signIn('google')}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[#bdbdbd] text-[#676767] hover:border-[#f37321] hover:text-[#f37321] text-xs font-semibold transition-colors"
              >
                {/* Google logo */}
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                  <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                  <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                  <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                  <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                </svg>
                Sign in with Google
              </button>
            )}
          </div>
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

            {/* Wizard mode — always mounted to preserve chat state */}
            <div className={inputMode === 'wizard' ? '' : 'hidden'}>
              <div className="flex flex-col gap-3">
                <SongWizard
                  onSongReady={handleWizardSongReady}
                  onPlayRequest={() => setPlayRequestCount(c => c + 1)}
                  audioReadyCount={audioReadyCount}
                  resumeSignal={resumeChatSignal}
                  instrumentalUrl={liveInstrumentalUrl || undefined}
                  songTitle={song?.title}
                />

              </div>
            </div>

            {/* Prompt mode */}
            <div className={inputMode === 'prompt' ? 'flex flex-col gap-3' : 'hidden'}>
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
                    </div>
                  </div>
                ) : (!song || editingPrompt) ? (
                  <PromptInput
                    onCompose={handleSubmitPrompt}
                    loading={loading}
                    defaultValue={submittedPrompt}
                  />
                ) : null}

                {/* (progress bar is a fixed overlay — see below) */}

                {error && (
                  <p className="text-sm text-red-600 rounded-lg border border-red-200 bg-red-50 px-4 py-3">{error}</p>
                )}

              </>
            </div>
          </div>

          {/* ── Full-width song editor ── */}
          {song && (
            <div ref={scrollRef}>
              <SongEditor
                ref={songEditorRef}
                key={songKey}
                song={song}
                audioPrompt={audioPrompt}
                onAudioPromptChange={setAudioPrompt}
                melodyUrl={melodyUrl}
                onMelodyChange={setMelodyUrl}
                autoGenerate={autoGenerate}
                playRequestCount={playRequestCount}
                sectionsOpen={sectionsOpen}
                onSectionsOpenChange={setSectionsOpen}
                onInstrumentalUrlChange={setLiveInstrumentalUrl}
                initialState={initialState}
                onGenerationStart={() => { /* overlay is fixed — no scroll needed */ }}
                onAudioReady={() => {
                  setAudioReadyCount(c => c + 1);
                  setTimeout(() => document.getElementById('song-audio-player')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 300);
                }}
              />
            </div>
          )}
        </div>
      </main>

      {/* ── Projects modal ── */}
      {projectsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={() => setProjectsOpen(false)}>
          <div className="bg-white rounded-xl border border-[#e9e9e9] shadow-[0_8px_40px_rgba(0,0,0,0.18)] w-[560px] max-w-[90vw] max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#e9e9e9]">
              <span className="font-semibold text-[#1e2235]">Saved Projects</span>
              <button onClick={() => setProjectsOpen(false)} className="text-[#929292] hover:text-[#3b3b3b] transition-colors">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="overflow-y-auto flex-1 px-4 py-3 flex flex-col gap-2">
              {!session && (
                <div className="rounded-lg border border-[#e9e9e9] bg-[#fafafa] p-4 mb-1 flex flex-col items-center gap-3">
                  <p className="text-sm text-[#676767] text-center">Sign in with Google to save and access your projects across sessions.</p>
                  <button
                    onClick={() => void signIn('google')}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg border border-[#bdbdbd] text-[#676767] hover:border-[#f37321] hover:text-[#f37321] text-xs font-semibold transition-colors"
                  >
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                    </svg>
                    Sign in with Google
                  </button>
                </div>
              )}
              {projects.length === 0 ? (
                <p className="text-sm text-[#929292] text-center py-8">{session ? 'No saved projects yet. Save your current song to get started.' : 'Sign in to see your saved projects.'}</p>
              ) : projects.map(p => (
                <div key={p.id} className="flex items-center gap-3 px-4 py-3 rounded-lg border border-[#e9e9e9] hover:border-[#bdbdbd] transition-colors">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-[#1e2235] truncate">{p.name}</p>
                    <p className="text-xs text-[#929292] truncate">{p.songTitle} · {p.genre}</p>
                    <p className="text-[10px] text-[#bdbdbd]">{new Date(p.savedAt).toLocaleString()}</p>
                  </div>
                  <button
                    onClick={() => void handleLoadProject(p.id)}
                    disabled={loadingProject === p.id}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#f37321] hover:bg-[#da6520] disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-semibold transition-colors flex-shrink-0"
                  >
                    {loadingProject === p.id ? 'Loading…' : 'Open'}
                  </button>
                  <button
                    onClick={() => void handleDeleteProject(p.id)}
                    className="text-[#bdbdbd] hover:text-red-500 transition-colors flex-shrink-0"
                    title="Delete project"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Song composing progress — fixed overlay */}
      {loading && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
          <div className="rounded-xl border border-[#e9e9e9] bg-white p-6 shadow-[0_8px_40px_rgba(0,0,0,0.18)] w-[640px] max-w-[90vw]">
            <div className="flex items-center justify-between mb-3">
              <span className="font-semibold text-[#3b3b3b]">Creating Your Song</span>
              <span className="text-sm tabular-nums text-[#929292]">{Math.round(progress)}%</span>
            </div>
            <div className="w-full h-2 rounded-full bg-[#e9e9e9] overflow-hidden mb-3">
              <div className="h-full rounded-full bg-[#f37321] transition-all duration-700 ease-out" style={{ width: `${progress}%` }} />
            </div>
            {progressLabel && <p className="text-xs text-[#929292]">{progressLabel}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
