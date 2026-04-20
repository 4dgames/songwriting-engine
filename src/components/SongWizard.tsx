'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Song } from '@/lib/types';

// ── Types ─────────────────────────────────────────────────────────────────────

interface WordTiming { word: string; startSec: number; endSec: number; }
interface TtsData    { audioUrl: string; words: WordTiming[]; }

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;   // raw (may include JSON block)
  display: string;   // cleaned for display
  song?: Song;
  tts?: TtsData;
}

interface Props {
  onSongReady: (song: Song, autoGenerate: boolean) => void;
  onPlayRequest?: () => void;   // called when user asks to generate/play the song
  audioReadyCount?: number;     // incremented by parent when audio generation completes
  resumeSignal?: number;        // increment to re-enable chat input after song is composed
  instrumentalUrl?: string;     // current instrumental URL (for VocalRecorder)
  songTitle?: string;           // current song title (for VocalRecorder download name)
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CHARACTERS = {
  axel: {
    name:        'Axel',
    voiceId:     'JBFqnCBsd6RMkjVDRZzb', // George — high-quality British male
    color:       '#f37321',
    colorLight:  '#fde3cc',
    description: 'British · bold · creative',
    initial:     'A',
  },
  amber: {
    name:        'Amber',
    voiceId:     '9BWtsMINqrJLrRacOk9x', // Aria — high-quality American female
    color:       '#8b5cf6',
    colorLight:  '#ede9fe',
    description: 'Warm · upbeat · encouraging',
    initial:     'Am',
  },
} as const;

type Character = keyof typeof CHARACTERS;

const greeting = (name: string) =>
  `Hey! I'm ${name} — let's write a song together. What's the feeling, story, or vibe you're going for?`;

// ── Helpers ───────────────────────────────────────────────────────────────────

// ── Song composition progress ─────────────────────────────────────────────────

const JSON_MILESTONES: [string, number, string][] = [
  ['"title"',       8,  'Naming your song…'],
  ['"genre"',       16, 'Picking the genre…'],
  ['"tempo"',       24, 'Setting the tempo…'],
  ['"sections"',    32, 'Writing the sections…'],
  ['"audioPrompt"', 88, 'Polishing the audio prompt…'],
];

function deriveJsonProgress(text: string): { pct: number; label: string } {
  let pct = 5; let label = 'Starting…';
  for (const [marker, p, l] of JSON_MILESTONES) {
    if (text.includes(marker)) { pct = p; label = l; }
    else break;
  }
  if (pct === 32 && !text.includes('"audioPrompt"')) {
    const lyricsCount = (text.match(/"lyrics"/g) ?? []).length;
    if (lyricsCount > 0) {
      pct = Math.min(32 + lyricsCount * 8, 87);
      const labelMatches = [...text.matchAll(/"label"\s*:\s*"([^"]+)"/g)];
      const sectionName = labelMatches[lyricsCount - 1]?.[1];
      label = sectionName ? `Writing ${sectionName}…` : `Writing section ${lyricsCount}…`;
    }
  }
  return { pct, label };
}

const stripMarkdown = (s: string) => s.replace(/\*\*/g, '');

function parseSong(text: string): { display: string; song: Song | null } {
  const match = text.match(/SONG_JSON_START\s*([\s\S]*?)\s*SONG_JSON_END/);
  if (!match) {
    const startIdx = text.indexOf('SONG_JSON_START');
    if (startIdx !== -1) return { display: stripMarkdown(text.slice(0, startIdx).trim()), song: null };
    return { display: stripMarkdown(text), song: null };
  }
  try {
    const song = JSON.parse(match[1]) as Song;
    const display = stripMarkdown(text.replace(/SONG_JSON_START[\s\S]*?SONG_JSON_END/, '').trim());
    return { display, song };
  } catch {
    return { display: stripMarkdown(text), song: null };
  }
}

// ── Sub-components ────────────────────────────────────────────────────────────

/** Hip vector avatar — unique illustration per character */
function CharacterAvatar({ id, color, colorLight }: { id: string; color: string; colorLight: string }) {
  if (id === 'axel') {
    // Axel: cool British guy — dark tousled hair, slight stubble, headphones around neck
    return (
      <svg viewBox="0 0 80 80" className="w-full h-full" aria-hidden>
        <defs>
          <radialGradient id="axel-bg" cx="40%" cy="30%" r="70%">
            <stop offset="0%" stopColor={colorLight} />
            <stop offset="100%" stopColor={color} />
          </radialGradient>
        </defs>
        {/* Background */}
        <circle cx="40" cy="40" r="40" fill={`url(#axel-bg)`} />
        {/* Neck */}
        <rect x="33" y="52" width="14" height="10" rx="3" fill="#f5c9a0" />
        {/* Body / shirt — dark jacket */}
        <ellipse cx="40" cy="74" rx="22" ry="14" fill="#1e2235" />
        {/* Collar */}
        <polygon points="34,62 40,68 46,62 43,58 37,58" fill="#2d3550" />
        {/* Face */}
        <ellipse cx="40" cy="38" rx="15" ry="17" fill="#f5c9a0" />
        {/* Hair — tousled dark */}
        <ellipse cx="40" cy="24" rx="15" ry="9" fill="#1a1a2e" />
        <ellipse cx="28" cy="28" rx="6" ry="8" fill="#1a1a2e" />
        <ellipse cx="52" cy="28" rx="5" ry="7" fill="#1a1a2e" />
        <ellipse cx="40" cy="20" rx="12" ry="6" fill="#1a1a2e" />
        {/* Side-swept bang */}
        <ellipse cx="30" cy="25" rx="8" ry="5" fill="#1a1a2e" transform="rotate(-10 30 25)" />
        {/* Eyes */}
        <ellipse cx="34" cy="37" rx="2.5" ry="2.8" fill="#1a1a2e" />
        <ellipse cx="46" cy="37" rx="2.5" ry="2.8" fill="#1a1a2e" />
        <circle cx="35" cy="36" r="0.8" fill="white" />
        <circle cx="47" cy="36" r="0.8" fill="white" />
        {/* Eyebrows — slightly arched */}
        <path d="M31 33 Q34 31.5 37 33" stroke="#1a1a2e" strokeWidth="1.5" fill="none" strokeLinecap="round" />
        <path d="M43 33 Q46 31.5 49 33" stroke="#1a1a2e" strokeWidth="1.5" fill="none" strokeLinecap="round" />
        {/* Stubble */}
        <ellipse cx="40" cy="47" rx="9" ry="4" fill="#d4a882" opacity="0.5" />
        {/* Mouth — slight smirk */}
        <path d="M36 45 Q40 48 45 45" stroke="#b07040" strokeWidth="1.5" fill="none" strokeLinecap="round" />
        {/* Headphones around neck */}
        <path d="M28 55 Q40 60 52 55" stroke="#333" strokeWidth="3" fill="none" strokeLinecap="round" />
        <circle cx="28" cy="54" r="3.5" fill="#222" />
        <circle cx="52" cy="54" r="3.5" fill="#222" />
      </svg>
    );
  }

  // Amber: hip, warm female — wavy hair, confident smile
  return (
    <svg viewBox="0 0 80 80" className="w-full h-full" aria-hidden>
      <defs>
        <radialGradient id="amber-bg" cx="40%" cy="30%" r="70%">
          <stop offset="0%" stopColor={colorLight} />
          <stop offset="100%" stopColor={color} />
        </radialGradient>
      </defs>
      {/* Background */}
      <circle cx="40" cy="40" r="40" fill={`url(#amber-bg)`} />
      {/* Body */}
      <ellipse cx="40" cy="76" rx="22" ry="13" fill="#c4b5fd" />
      {/* Neck */}
      <rect x="34" y="52" width="12" height="10" rx="3" fill="#f5c0a0" />
      {/* Hair back layer */}
      <ellipse cx="40" cy="42" rx="20" ry="22" fill="#7c3aed" />
      {/* Face */}
      <ellipse cx="40" cy="38" rx="14" ry="16" fill="#f5c0a0" />
      {/* Hair top + waves */}
      <ellipse cx="40" cy="22" rx="16" ry="10" fill="#7c3aed" />
      <path d="M56 28 Q62 38 58 52" stroke="#7c3aed" strokeWidth="7" fill="none" strokeLinecap="round" />
      <path d="M24 28 Q18 38 22 52" stroke="#7c3aed" strokeWidth="7" fill="none" strokeLinecap="round" />
      {/* Hair highlight */}
      <path d="M32 16 Q40 12 48 16" stroke="#a78bfa" strokeWidth="3" fill="none" strokeLinecap="round" />
      {/* Eyes */}
      <ellipse cx="34.5" cy="37" rx="2.8" ry="3" fill="#1a1a2e" />
      <ellipse cx="45.5" cy="37" rx="2.8" ry="3" fill="#1a1a2e" />
      <circle cx="35.5" cy="36" r="0.9" fill="white" />
      <circle cx="46.5" cy="36" r="0.9" fill="white" />
      {/* Lashes */}
      <path d="M32 34.5 L31 33" stroke="#1a1a2e" strokeWidth="1" strokeLinecap="round" />
      <path d="M34.5 33.5 L34 32" stroke="#1a1a2e" strokeWidth="1" strokeLinecap="round" />
      <path d="M43 34.5 L42 33" stroke="#1a1a2e" strokeWidth="1" strokeLinecap="round" />
      <path d="M45.5 33.5 L45 32" stroke="#1a1a2e" strokeWidth="1" strokeLinecap="round" />
      <path d="M48 34.5 L49 33" stroke="#1a1a2e" strokeWidth="1" strokeLinecap="round" />
      {/* Eyebrows */}
      <path d="M31.5 33 Q34.5 31 37.5 32.5" stroke="#4c1d95" strokeWidth="1.5" fill="none" strokeLinecap="round" />
      <path d="M42.5 32.5 Q45.5 31 48.5 33" stroke="#4c1d95" strokeWidth="1.5" fill="none" strokeLinecap="round" />
      {/* Smile */}
      <path d="M35 45 Q40 50 45 45" stroke="#b06040" strokeWidth="1.8" fill="none" strokeLinecap="round" />
      {/* Cheek blush */}
      <ellipse cx="29" cy="43" rx="4" ry="2.5" fill="#f9a8d4" opacity="0.45" />
      <ellipse cx="51" cy="43" rx="4" ry="2.5" fill="#f9a8d4" opacity="0.45" />
      {/* Small earring */}
      <circle cx="24.5" cy="42" r="2" fill="#f59e0b" />
      <circle cx="55.5" cy="42" r="2" fill="#f59e0b" />
    </svg>
  );
}

function TypingDots() {
  return (
    <div className="flex items-center gap-1 px-3.5 py-3">
      {[0, 150, 300].map(d => (
        <span key={d} className="w-1.5 h-1.5 rounded-full bg-[#bdbdbd] animate-bounce" style={{ animationDelay: `${d}ms` }} />
      ))}
    </div>
  );
}

function SongCard({ song }: { song: Song }) {
  return (
    <div className="rounded-xl border border-[#f37321] bg-[#fffaf6] p-3.5 mt-1">
      <p className="font-bold text-[#f37321] text-sm mb-0.5">{song.title}</p>
      <p className="text-[10px] text-[#929292] mb-2.5">
        {song.genre} · {song.mood} · {song.tempo} BPM · {song.key}
      </p>
      <div className="flex flex-wrap gap-1">
        {song.sections.map((s, i) => (
          <span key={i} className="text-[10px] bg-white border border-[#e9e9e9] text-[#676767] rounded px-1.5 py-0.5">
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * Renders assistant message text with per-word highlighting while TTS is playing.
 * Words yet to be spoken are dimmed; the active word has an orange highlight;
 * spoken words return to normal.
 */
function SpeakingText({
  text, tts, isActive, playbackTime,
}: {
  text: string;
  tts?: TtsData;
  isActive: boolean;
  playbackTime: number;
}) {
  if (!isActive || !tts || tts.words.length === 0) return <>{text}</>;

  // Split on whitespace boundaries, preserving the spaces as their own tokens
  const tokens = text.split(/(\s+)/);
  let wi = 0;

  return (
    <>
      {tokens.map((tok, i) => {
        if (/^\s+$/.test(tok)) return <span key={i}>{tok}</span>;
        // Emoji-only tokens have no word timing — skip the counter
        if (/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\u200d\ufe0f]+$/u.test(tok))
          return <span key={i}>{tok}</span>;
        // Dash characters stripped from TTS text (em dash, en dash, etc.) have no timing slot
        if (/^[\u2013\u2014\u2012\u2015]$/.test(tok) || /^-{2,}$/.test(tok))
          return <span key={i}>{tok}</span>;
        const timing = tts.words[wi++];
        if (!timing) return <span key={i}>{tok}</span>;
        const active = playbackTime >= timing.startSec && playbackTime <= timing.endSec + 0.08;
        const said   = playbackTime > timing.endSec + 0.08;
        return (
          <span
            key={i}
            className={
              active
                ? 'bg-[#f37321] text-white rounded-sm px-0.5 -mx-0.5 transition-colors'
                : !said && playbackTime > 0
                ? 'text-[#aaaaaa]'
                : ''
            }
          >
            {tok}
          </span>
        );
      })}
    </>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function SongWizard({ onSongReady, onPlayRequest, audioReadyCount, resumeSignal, instrumentalUrl, songTitle }: Props) {
  const [character,     setCharacter]     = useState<Character | null>(null);
  const [started,       setStarted]       = useState(false);
  const [messages,      setMessages]      = useState<ChatMessage[]>([]);
  const [inputText,     setInputText]     = useState('');
  const [loading,       setLoading]       = useState(false);
  const [recording,     setRecording]     = useState(false);
  const [speechSupported, setSpeechSupported] = useState(false);
  const [generatedSong, setGeneratedSong] = useState<Song | null>(null);
  const [chatDone,       setChatDone]       = useState(false);
  const [chatCollapsed,  setChatCollapsed]  = useState(false);

  const [audioRequested, setAudioRequested] = useState(false);
  const [composingJson,       setComposingJson]       = useState(false);
  const [jsonProgress,        setJsonProgress]        = useState(5);
  const [jsonProgressLabel,   setJsonProgressLabel]   = useState('Starting…');
  const [speakingIndex, setSpeakingIndex] = useState<number | null>(null);
  const [playbackTime,  setPlaybackTime]  = useState(0);
  const [voiceRate,     setVoiceRate]     = useState(1.0);
  const [availableVoices, setAvailableVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [selectedVoiceName, setSelectedVoiceName] = useState('');
  const [showSettings,  setShowSettings]  = useState(false);
  const voiceRateRef    = useRef(1.0);
  const selectedVoiceRef = useRef('');
  const characterRef    = useRef<Character>('axel');

  // ── Refs (avoid stale closures in async/speech callbacks) ──
  const scrollRef       = useRef<HTMLDivElement>(null);
  const inputRef        = useRef<HTMLTextAreaElement>(null);
  const continuousRef   = useRef(false);   // desired continuous-listen state
  const ttsPlayingRef   = useRef(false);   // true while TTS audio is playing — mic is muted
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null); // retry timer when AI is loading
  const accumulatedTranscript = useRef('');  // finals collected between speech_final events
  // Deepgram WebSocket STT refs
  const dgSocketRef   = useRef<WebSocket | null>(null);
  const dgRecorderRef = useRef<MediaRecorder | null>(null);
  const dgStreamRef   = useRef<MediaStream | null>(null);
  // Barge-in detection — AudioContext analyser that monitors mic energy during TTS
  const bargeInRef    = useRef<{ actx: AudioContext; raf: number } | null>(null);
  // Text currently being spoken by TTS — used to filter AI voice bleed from the mic
  const ttsTextRef    = useRef('');
  // Whether the current inputText value was set by voice (Deepgram) vs manual typing.
  // Used to prevent voice auto-clear from erasing text the user typed manually.
  const voiceInputRef = useRef(false);
  const inputTextRef  = useRef('');     // mirror of inputText for use in WS callbacks
  const ttsAudioRef     = useRef<HTMLAudioElement | null>(null);
  const rafRef          = useRef<number | null>(null);
  const messagesRef     = useRef(messages);
  const loadingRef      = useRef(false);
  const hasSongRef       = useRef(false);   // whether a song has ever been generated
  const generatedSongRef = useRef<Song | null>(null);
  const onSongReadyRef   = useRef(onSongReady);
  const lastTtsRef      = useRef(-1);      // index of last message sent to TTS
  const startListeningRef = useRef<() => void>(() => {});
  const stopListeningRef  = useRef<() => void>(() => {});
  const onPlayRequestRef   = useRef(onPlayRequest);
  const instrumentalUrlRef = useRef(instrumentalUrl);

  // Keep refs in sync
  useEffect(() => { messagesRef.current       = messages;       }, [messages]);
  useEffect(() => { loadingRef.current        = loading;        }, [loading]);
  useEffect(() => { onSongReadyRef.current    = onSongReady;    }, [onSongReady]);
  useEffect(() => { onPlayRequestRef.current  = onPlayRequest;  }, [onPlayRequest]);
  useEffect(() => { instrumentalUrlRef.current = instrumentalUrl; }, [instrumentalUrl]);
  useEffect(() => { inputTextRef.current      = inputText;      }, [inputText]);

  // When audio generation completes, stop mic and speak the "ready" announcement
  const prevAudioReadyCount = useRef(0);
  useEffect(() => {
    if (!audioReadyCount || audioReadyCount <= prevAudioReadyCount.current) return;
    prevAudioReadyCount.current = audioReadyCount;
    stopListeningRef.current();
    const readyMsg = 'Your song is ready! Have a listen.';
    const idx = messagesRef.current.length;
    lastTtsRef.current = idx; // prevent auto-TTS from double-speaking this message
    setMessages(prev => [...prev, { role: 'assistant', content: readyMsg, display: readyMsg }]);
    void speakMessage(idx, readyMsg);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioReadyCount]);
  // When parent signals to resume, re-enable the chat input
  const prevResumeSignal = useRef(0);
  useEffect(() => {
    if (!resumeSignal || resumeSignal <= prevResumeSignal.current) return;
    prevResumeSignal.current = resumeSignal;
    setChatDone(false);
  }, [resumeSignal]);

  useEffect(() => { voiceRateRef.current     = voiceRate;       }, [voiceRate]);
  useEffect(() => { selectedVoiceRef.current = selectedVoiceName; }, [selectedVoiceName]);
  useEffect(() => { if (character) characterRef.current = character; }, [character]);

  // Load browser voices
  useEffect(() => {
    const load = () => {
      const v = window.speechSynthesis?.getVoices().filter(v => v.lang.startsWith('en')) ?? [];
      if (v.length) setAvailableVoices(v);
    };
    load();
    window.speechSynthesis?.addEventListener('voiceschanged', load);
    return () => window.speechSynthesis?.removeEventListener('voiceschanged', load);
  }, []);


  // Auto-scroll on new messages
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, loading]);

  // ── Barge-in helpers ─────────────────────────────────────────────────────

  /** Restart the MediaRecorder on the existing (still-open) Deepgram socket.
   *  Called after TTS ends or when barge-in is detected. */
  const resumeRecording = useCallback(() => {
    // Always open a fresh Deepgram WebSocket — reusing the same socket after
    // stopping MediaRecorder causes a new WebM/Opus stream to start mid-session,
    // which Deepgram cannot handle and silently stops transcribing.
    // We keep dgStreamRef alive (mic stays open) so startListening can reuse it
    // without triggering another getUserMedia permission prompt.
    dgRecorderRef.current?.stop();
    dgRecorderRef.current = null;
    dgSocketRef.current?.close(1000, 'resume-recording');
    dgSocketRef.current = null;
    void startListeningRef.current();
  }, []);

  /** Stop barge-in energy monitoring. */
  const stopBargeIn = useCallback(() => {
    if (bargeInRef.current) {
      cancelAnimationFrame(bargeInRef.current.raf);
      void bargeInRef.current.actx.close();
      bargeInRef.current = null;
    }
  }, []);

  /** Start monitoring mic energy during TTS so the user can barge in by speaking.
   *  The mic stream stays open; we use a Web Audio AnalyserNode to detect voice. */
  const startBargeIn = useCallback(() => {
    const stream = dgStreamRef.current;
    if (!stream || bargeInRef.current) return;

    let actx: AudioContext;
    try {
      actx = new AudioContext();
    } catch { return; }

    const src      = actx.createMediaStreamSource(stream);
    const analyser = actx.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    let loudCount = 0;

    const check = () => {
      analyser.getByteTimeDomainData(data);
      // Compute RMS amplitude (values are 0–255 centred at 128)
      let sum = 0;
      for (const v of data) sum += (v - 128) ** 2;
      const rms = Math.sqrt(sum / data.length);

      if (rms > 12) {
        loudCount++;
        // ~5 frames at 60fps ≈ 80 ms of sustained speech → barge-in
        if (loudCount >= 5 && ttsPlayingRef.current) {
          stopBargeIn();
          ttsAudioRef.current?.pause();
          ttsPlayingRef.current = false;
          setSpeakingIndex(null);
          setPlaybackTime(0);
          if (rafRef.current) cancelAnimationFrame(rafRef.current);
          accumulatedTranscript.current = '';
          resumeRecording();
          return;
        }
      } else {
        loudCount = 0;
      }
      if (bargeInRef.current) {
        bargeInRef.current.raf = requestAnimationFrame(check);
      }
    };

    bargeInRef.current = { actx, raf: requestAnimationFrame(check) };
  }, [stopBargeIn, resumeRecording]);

  // ── TTS ───────────────────────────────────────────────────────────────────

  const speakMessage = useCallback(async (msgIndex: number, text: string) => {
    if (!text.trim()) return;

    // Stop anything currently playing. Pause the MediaRecorder so no audio goes
    // to Deepgram during TTS, but keep the mic stream and WebSocket alive —
    // this lets barge-in detection work without a reconnect penalty.
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    ttsPlayingRef.current = true;
    ttsTextRef.current = text.trim();
    dgRecorderRef.current?.stop();
    dgRecorderRef.current = null;
    ttsAudioRef.current?.pause();
    startBargeIn();
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    setSpeakingIndex(null);
    setPlaybackTime(0);


    try {
      // ── Try ElevenLabs first ──────────────────────────────────────────────
      const res = await fetch('/api/wizard/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text:    text.trim(),
          rate:    voiceRateRef.current,
          voiceId: CHARACTERS[characterRef.current].voiceId,
        }),
      });

      if (res.ok) {
        const json = await res.json() as { audioBase64: string; words: WordTiming[] };
        const { audioBase64, words } = json;

        if (audioBase64) {
          const binary = atob(audioBase64);
          const bytes  = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
          const ttsData: TtsData = { audioUrl: url, words };

          setMessages(prev => {
            const next = [...prev];
            if (next[msgIndex]) next[msgIndex] = { ...next[msgIndex], tts: ttsData };
            return next;
          });

          const audio = new Audio(url);
          ttsAudioRef.current = audio;
          audio.onended = () => {
            stopBargeIn();
            setSpeakingIndex(null);
            setPlaybackTime(0);
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
            URL.revokeObjectURL(url);
            ttsPlayingRef.current = false;
            if (continuousRef.current) resumeRecording();
          };
          await audio.play();
          setSpeakingIndex(msgIndex);
          const tick = () => {
            if (audio.paused || audio.ended) return;
            setPlaybackTime(audio.currentTime);
            rafRef.current = requestAnimationFrame(tick);
          };
          rafRef.current = requestAnimationFrame(tick);
          return; // success — skip browser fallback
        }
      }

      // ── Browser speechSynthesis fallback ─────────────────────────────────
      if (!window.speechSynthesis) {
        ttsPlayingRef.current = false;
        return;
      }
      window.speechSynthesis.cancel();

      const speak = () => {
        const utt = new SpeechSynthesisUtterance(text.trim());
        utt.rate  = voiceRateRef.current;
        utt.pitch = 0.7;
        const voices = window.speechSynthesis.getVoices().filter(v => v.lang.startsWith('en'));
        const selected = selectedVoiceRef.current
          ? voices.find(v => v.name === selectedVoiceRef.current)
          : undefined;
        const preferred = selected ??
          voices.find(v => /daniel|alex|fred|thomas|oliver|google uk english male/i.test(v.name)) ??
          voices.find(v => v.name.toLowerCase().includes('male')) ??
          voices[0];
        if (preferred) utt.voice = preferred;
        setSpeakingIndex(msgIndex);
        utt.onend = () => {
          stopBargeIn();
          setSpeakingIndex(null);
          setPlaybackTime(0);
          ttsPlayingRef.current = false;
          if (continuousRef.current) resumeRecording();
        };
        window.speechSynthesis.speak(utt);
      };

      // Voices may not be loaded yet — wait for them
      if (window.speechSynthesis.getVoices().length > 0) {
        speak();
      } else {
        window.speechSynthesis.onvoiceschanged = () => { speak(); };
      }

    } catch (err) {
      console.error('TTS error:', err);
    }
  }, []);

  // Auto-trigger TTS for each new completed assistant message
  useEffect(() => {
    if (!started || loading) return;
    const msgs = messagesRef.current;
    const idx  = msgs.length - 1;
    if (idx < 0 || idx <= lastTtsRef.current) return;
    const msg = msgs[idx];
    if (msg.role !== 'assistant' || !msg.display.trim()) return;
    lastTtsRef.current = idx;
    void speakMessage(idx, msg.display);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, started, speakMessage]);

  const beginSession = (char: Character) => {
    const g = greeting(CHARACTERS[char].name);
    setMessages([{ role: 'assistant', content: g, display: g }]);
    setCharacter(char);
    setStarted(true);
    if (speechSupported) startListening();
  };

  // ── Core send logic — uses refs so speech handler can call it stably ────────

  const doSendMessage = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || loadingRef.current) return;

    // ── Detect "play" / playback intent ──────────────────────────────────────
    const playIntent = /\b(play|hear|listen to|start|launch)\b.*\b(song|track|music|it)\b/i.test(trimmed)
                    || /\b(play it|play now|play the song|hit play|press play|start playback|start playing|play back)\b/i.test(trimmed)
                    || /^(play|go|start)[.!?]?$/i.test(trimmed.trim());
    if (playIntent && (hasSongRef.current || instrumentalUrlRef.current)) {
      onPlayRequestRef.current?.();
      setInputText('');
      const hasAudio = !!instrumentalUrlRef.current;
      const reply = hasAudio ? 'Playing now!' : 'On it! Generating the audio now…';
      if (!hasAudio) setAudioRequested(true);
      const userIdx = messagesRef.current.length;
      const assistIdx = userIdx + 1;
      lastTtsRef.current = assistIdx;
      setMessages(prev => [
        ...prev,
        { role: 'user', content: trimmed, display: trimmed },
        { role: 'assistant', content: reply, display: stripMarkdown(reply) },
      ]);
      void speakMessage(assistIdx, reply);
      return;
    }

    // ── Detect character switch ───────────────────────────────────────────────
    const switchTo = /\b(talk to|switch to|use|be|i want|speak to)\b.*\bamber\b/i.test(trimmed) ? 'amber'
                   : /\b(talk to|switch to|use|be|i want|speak to)\b.*\baxel\b/i.test(trimmed) ? 'axel'
                   : null;
    if (switchTo) {
      const newChar = switchTo as Character;
      const g = greeting(CHARACTERS[newChar].name);
      setCharacter(newChar);
      setMessages([{ role: 'assistant', content: g, display: g }]);
      setInputText('');
      lastTtsRef.current = -1; // allow greeting TTS to fire
      return;
    }

    // ── Detect speaking-rate change ───────────────────────────────────────────
    const rateMatch = trimmed.match(/(?:speak|talk|go|read|voice|speed|rate|slow|fast).*?([\d.]+)\s*x/i)
                   || trimmed.match(/(?:speak|talk)\s+(?:at\s+)?(\d+)\s*(?:percent|%)/i);
    const slowMatch  = /\b(slow(?:er)?|take it slow(?:er)?)\b/i.test(trimmed);
    const fastMatch  = /\b(fast(?:er)?|speed up|quicker)\b/i.test(trimmed);
    if (rateMatch) {
      const val = parseFloat(rateMatch[1]);
      const newRate = Math.min(1.2, Math.max(0.7, val > 5 ? val / 100 : val));
      setVoiceRate(newRate);
      voiceRateRef.current = newRate;
      setInputText('');
      return;
    }
    if (slowMatch) {
      const newRate = Math.max(0.7, voiceRateRef.current - 0.2);
      setVoiceRate(newRate);
      voiceRateRef.current = newRate;
      setInputText('');
      return;
    }
    if (fastMatch) {
      const newRate = Math.min(1.2, voiceRateRef.current + 0.2);
      setVoiceRate(newRate);
      voiceRateRef.current = newRate;
      setInputText('');
      return;
    }

    // Interrupt any current speech when user sends
    ttsAudioRef.current?.pause();
    setSpeakingIndex(null);
    setPlaybackTime(0);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);

    const userMsg: ChatMessage = { role: 'user', content: trimmed, display: trimmed };
    const history = [...messagesRef.current, userMsg];
    setMessages(history);
    setInputText('');
    setLoading(true);

    try {
      const apiMessages = history.map(m => ({ role: m.role, content: m.content }));
      const res = await fetch('/api/wizard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: apiMessages, character: character ?? 'axel' }),
      });
      if (!res.ok) throw new Error(await res.text());

      const reader    = res.body!.getReader();
      const decoder   = new TextDecoder();
      let accumulated = '';

      setMessages(prev => [...prev, { role: 'assistant', content: '', display: '' }]);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        accumulated += decoder.decode(value, { stream: true });
        if (accumulated.includes('SONG_JSON_START') && !accumulated.includes('SONG_JSON_END')) {
          setComposingJson(true);
          const { pct, label } = deriveJsonProgress(accumulated);
          setJsonProgress(prev => Math.max(prev, pct));
          setJsonProgressLabel(label);
        }
        const { display } = parseSong(accumulated);
        setMessages(prev => {
          const next = [...prev];
          next[next.length - 1] = { role: 'assistant', content: accumulated, display };
          return next;
        });
      }
      setComposingJson(false);
      setJsonProgress(5);
      setJsonProgressLabel('Starting…');

      const { display, song } = parseSong(accumulated);
      setMessages(prev => {
        const next = [...prev];
        next[next.length - 1] = { role: 'assistant', content: accumulated, display, song: song ?? undefined };
        return next;
      });

      if (song) {
        const isUpdate = hasSongRef.current;
        hasSongRef.current = true;
        setGeneratedSong(song);
        generatedSongRef.current = song;
        setChatDone(true);
        if (!isUpdate) {
          // First time — show sections for review; user triggers audio when ready
          onSongReadyRef.current(song, false);
        } else {
          // Resumed conversation — update the parent's song silently
          onSongReadyRef.current(song, false);
        }
      }
    } catch {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: 'Something went wrong — try again?',
        display: 'Something went wrong — try again?',
      }]);
    } finally {
      setLoading(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [stopBargeIn, resumeRecording]); // stable helpers injected via useCallback

  // ── Deepgram WebSocket speech recognition ────────────────────────────────
  // Uses Deepgram nova-2 with smart_format + endpointing so the agent responds
  // as soon as Deepgram detects end-of-speech (speech_final:true), rather than
  // waiting on a fixed silence timer.

  const startListening = useCallback(() => {
    // Guard against both OPEN and CONNECTING states — a socket in CONNECTING
    // would pass the old OPEN-only check and create a second connection, causing
    // both sockets to write to the shared accumulatedTranscript and duplicate text.
    const ws = dgSocketRef.current;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    if (!continuousRef.current) continuousRef.current = true;
    setRecording(true);

    void (async () => {
      try {
        // 1. Get a short-lived Deepgram key from our backend (real key stays server-side)
        const tokenRes = await fetch('/api/deepgram-token');
        if (!tokenRes.ok) throw new Error('deepgram-token fetch failed');
        const { key, error: tokenErr } = await tokenRes.json() as { key?: string; error?: string };
        if (tokenErr || !key) throw new Error(tokenErr ?? 'no key');

        if (!continuousRef.current || ttsPlayingRef.current) return;

        // 2. Open Deepgram WebSocket
        const params = new URLSearchParams({
          model:            'nova-2',
          language:         'en-US',
          smart_format:     'true',   // auto-punctuates transcripts
          interim_results:  'true',
          endpointing:      '380',    // ms of silence → speech_final fires
          no_delay:         'true',   // minimise latency on interim results
          encoding:         'opus',
          channels:         '1',
        });
        const ws = new WebSocket(
          `wss://api.deepgram.com/v1/listen?${params}`,
          ['token', key],
        );
        dgSocketRef.current = ws;

        ws.onopen = async () => {
          try {
            // 3. Open mic and pipe audio chunks into the WebSocket.
            // Reuse an existing live stream (e.g. kept alive for barge-in detection)
            // so we don't re-prompt for mic permissions on every TTS → listen cycle.
            let stream = dgStreamRef.current;
            if (!stream || stream.getTracks().every(t => t.readyState === 'ended')) {
              stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
              dgStreamRef.current = stream;
            }

            // Pick a supported mimeType
            const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
              ? 'audio/webm;codecs=opus'
              : MediaRecorder.isTypeSupported('audio/webm')
              ? 'audio/webm'
              : '';
            const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
            dgRecorderRef.current = recorder;
            recorder.ondataavailable = e => {
              if (ws.readyState === WebSocket.OPEN && e.data.size > 0) ws.send(e.data);
            };
            recorder.start(250); // send a chunk every 250 ms
          } catch (micErr) {
            console.error('[deepgram] mic access failed', micErr);
            ws.close();
            setRecording(false);
            continuousRef.current = false;
          }
        };

        ws.onmessage = e => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const msg = JSON.parse(e.data as string) as any;
          if (msg.type !== 'Results') return;

          const transcript = (msg.channel?.alternatives?.[0]?.transcript ?? '') as string;
          const isFinal    = msg.is_final    as boolean;
          const speechFinal = msg.speech_final as boolean;

          if (isFinal && transcript.trim()) {
            // Accumulate confirmed segments into the running transcript
            accumulatedTranscript.current =
              (accumulatedTranscript.current + ' ' + transcript).trim();
          }

          // Update live display — but only if the input is currently voice-driven
          // or empty. If the user has typed manually, don't overwrite their text.
          const interim = !isFinal ? transcript : '';
          const display = [accumulatedTranscript.current, interim].filter(Boolean).join(' ');
          if (display && (voiceInputRef.current || !inputTextRef.current)) {
            setInputText(display);
            voiceInputRef.current = true;
          }

          if (speechFinal && accumulatedTranscript.current.trim()) {
            // Deepgram has detected end-of-utterance.
            const toSend = accumulatedTranscript.current;
            accumulatedTranscript.current = '';

            // If the user typed manually while the mic was on, don't clear their
            // text or auto-send the voice transcript — they'll send it themselves.
            if (!voiceInputRef.current) return;

            // Before sending, check if this is just the AI's own voice bleeding
            // into the mic (echo). Compare word overlap against current TTS text.
            const isEcho = (() => {
              const ttsWords  = ttsTextRef.current.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(Boolean);
              const heardWords = toSend.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(Boolean);
              if (ttsWords.length === 0 || heardWords.length === 0) return false;
              const ttsSet = new Set(ttsWords);
              const overlap = heardWords.filter(w => ttsSet.has(w)).length;
              return overlap / heardWords.length > 0.5;
            })();

            setInputText('');
            voiceInputRef.current = false;

            if (isEcho) return; // Discard — audio bleed from the speaker

            if (loadingRef.current) {
              // AI still responding — buffer the text and retry when it's free
              if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
              const retry = () => {
                if (loadingRef.current) {
                  silenceTimerRef.current = setTimeout(retry, 500);
                } else {
                  silenceTimerRef.current = null;
                  void doSendMessage(toSend);
                }
              };
              silenceTimerRef.current = setTimeout(retry, 500);
            } else {
              void doSendMessage(toSend);
            }
          }
        };

        ws.onerror = () => {
          continuousRef.current = false;
          setRecording(false);
        };

        ws.onclose = () => {
          // Auto-reconnect on unexpected close (e.g. network glitch), but not
          // when we deliberately closed for TTS playback.
          if (continuousRef.current && !ttsPlayingRef.current) {
            void startListeningRef.current();
          } else if (!continuousRef.current) {
            setRecording(false);
          }
        };
      } catch (err) {
        console.error('[deepgram] startListening failed', err);
        continuousRef.current = false;
        setRecording(false);
      }
    })();
  }, [doSendMessage]);

  // Keep ref current so speakMessage (frozen closure) can always call the latest startListening
  startListeningRef.current = startListening;

  const stopListening = useCallback(() => {
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    stopBargeIn();
    continuousRef.current = false;
    setRecording(false);
    accumulatedTranscript.current = '';
    dgRecorderRef.current?.stop();
    dgRecorderRef.current = null;
    dgStreamRef.current?.getTracks().forEach(t => t.stop());
    dgStreamRef.current = null;
    dgSocketRef.current?.close(1000, 'stop-listening');
    dgSocketRef.current = null;
  }, [stopBargeIn]);

  stopListeningRef.current = stopListening;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void doSendMessage(inputText);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setSpeechSupported(!!(window.SpeechRecognition || (window as any).webkitSpeechRecognition));
  }, []);

  const inputDisabled = loading || chatDone;

  // ── Render ────────────────────────────────────────────────────────────────

  if (!started) {
    return (
      <div className="flex flex-col items-center gap-6 rounded-xl border border-[#e9e9e9] bg-white shadow-[0_2px_12px_rgba(0,0,0,0.07)] p-10">
        <div className="text-center">
          <p className="font-bold text-[#1e2235] text-lg mb-1">Who do you want to talk to?</p>
          <p className="text-sm text-[#929292]">Choose your AI songwriter — they&apos;ll guide you through building your song.</p>
        </div>

        {/* Character cards */}
        <div className="flex gap-4 w-full">
          {(Object.entries(CHARACTERS) as [Character, typeof CHARACTERS[Character]][]).map(([key, ch]) => (
            <button
              key={key}
              onClick={() => beginSession(key)}
              className={`flex-1 flex flex-col items-center gap-3 p-5 rounded-xl border-2 transition-all hover:shadow-md ${
                character === key
                  ? 'border-[var(--c)] shadow-md'
                  : 'border-[#e9e9e9] hover:border-[#d4d4d4]'
              }`}
              style={{ '--c': ch.color } as React.CSSProperties}
            >
              <CharacterAvatar id={key} color={ch.color} colorLight={ch.colorLight} />
              <div className="text-center">
                <p className="font-bold text-[#1e2235] text-base">{ch.name}</p>
                <p className="text-[11px] text-[#929292] mt-0.5">{ch.description}</p>
              </div>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col rounded-xl border border-[#e9e9e9] bg-white shadow-[0_2px_12px_rgba(0,0,0,0.07)] overflow-hidden">

      {/* ── Header with settings toggle ── */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-[#f0f0f0]">
        <button
          onClick={() => setChatCollapsed(c => !c)}
          className="flex items-center gap-1.5 text-xs font-semibold text-[#929292] uppercase tracking-wider hover:text-[#3b3b3b] transition-colors"
          title={chatCollapsed ? 'Expand chat' : 'Collapse chat'}
        >
          <svg
            className={`w-3 h-3 transition-transform ${chatCollapsed ? '-rotate-90' : ''}`}
            fill="none" stroke="currentColor" viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
          {character ? CHARACTERS[character].name : 'Axel'}
        </button>

        <button
          onClick={() => setShowSettings(s => !s)}
          title="Voice settings"
          className={`p-1.5 rounded transition-colors ${showSettings ? 'text-[#f37321]' : 'text-[#bdbdbd] hover:text-[#929292]'}`}
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>
      </div>

      {/* ── Voice settings panel ── */}
      {showSettings && !chatCollapsed && (
        <div className="px-4 py-3 border-b border-[#f0f0f0] bg-[#fafafa] flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <label className="text-xs text-[#676767] w-16 flex-shrink-0">Speed</label>
            <input
              type="range" min="0.7" max="1.2" step="0.1"
              value={voiceRate}
              onChange={e => setVoiceRate(parseFloat(e.target.value))}
              className="flex-1 accent-[#f37321]"
            />
            <span className="text-xs text-[#929292] w-8 text-right tabular-nums">{voiceRate.toFixed(1)}×</span>
          </div>
        </div>
      )}

      {/* ── Messages ── hidden when chat is done or collapsed */}
      <div
        ref={scrollRef}
        className={`flex flex-col gap-4 p-4 overflow-y-auto ${chatDone || chatCollapsed ? 'hidden' : ''}`}
        style={{ minHeight: 160, maxHeight: 260 }}
      >
        {messages.map((msg, i) => (
          <div key={i} className={`flex gap-2.5 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
            {msg.role === 'assistant' && character && (
              <div className="w-7 h-7 rounded-full overflow-hidden flex-shrink-0 mt-0.5">
                <CharacterAvatar id={character} color={CHARACTERS[character].color} colorLight={CHARACTERS[character].colorLight} />
              </div>
            )}
            <div className={`flex flex-col gap-1 max-w-[88%] ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
              <div className={`px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${
                msg.role === 'user'
                  ? 'bg-[#f37321] text-white rounded-tr-sm'
                  : 'bg-[#f6f6f6] text-[#3b3b3b] rounded-tl-sm'
              }`}>
                <SpeakingText
                  text={msg.display || '\u00A0'}
                  tts={msg.tts}
                  isActive={speakingIndex === i}
                  playbackTime={playbackTime}
                />
              </div>
              {/* SongCard intentionally hidden — song appears in the editor below */}
            </div>
          </div>
        ))}

        {loading && !composingJson && character && (
          <div className="flex gap-2.5">
            <div className="w-7 h-7 rounded-full overflow-hidden flex-shrink-0">
              <CharacterAvatar id={character} color={CHARACTERS[character].color} colorLight={CHARACTERS[character].colorLight} />
            </div>
            <div className="bg-[#f6f6f6] rounded-2xl rounded-tl-sm">
              <TypingDots />
            </div>
          </div>
        )}

      </div>

      {/* ── Input area ── hidden when chat is done or collapsed */}
      <div className={`border-t border-[#e9e9e9] p-3 flex items-center gap-2 transition-opacity ${chatDone || chatCollapsed ? 'hidden' : ''} ${inputDisabled ? 'opacity-40 pointer-events-none' : ''}`}>
        <textarea
          ref={inputRef}
          value={inputText}
          onChange={e => { setInputText(e.target.value); voiceInputRef.current = false; }}
          onKeyDown={handleKeyDown}
          placeholder={recording ? 'Listening… speak naturally, I\'ll send when you finish' : 'Type or tap the mic… (Enter to send)'}
          rows={2}
          disabled={inputDisabled}
          className="flex-1 rounded-lg bg-[#f6f6f6] border border-[#e9e9e9] text-[#3b3b3b] px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-[#f37321] focus:border-[#f37321] disabled:opacity-60"
          style={{ maxHeight: 360, lineHeight: '1.5' }}
        />

        {/* Stop TTS — shown to the left of mic while AI is speaking */}
        {speakingIndex !== null && (
          <button
            onClick={() => {
              stopBargeIn();
              ttsAudioRef.current?.pause();
              ttsPlayingRef.current = false;
              setSpeakingIndex(null);
              setPlaybackTime(0);
              if (rafRef.current) cancelAnimationFrame(rafRef.current);
              accumulatedTranscript.current = '';
              if (continuousRef.current) resumeRecording();
            }}
            title="Stop speaking (or just speak to interrupt)"
            className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 bg-[#f37321] hover:bg-[#da6520] text-white transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
              <rect x="6" y="6" width="12" height="12" rx="1" />
            </svg>
          </button>
        )}

        {/* Mic — toggles continuous listening mode */}
        {speechSupported && (
          <button
            onClick={recording ? stopListening : startListening}
            disabled={inputDisabled}
            title={recording ? 'Stop listening' : 'Start listening — auto-sends when you finish a sentence'}
            className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 transition-colors disabled:opacity-40 ${
              recording
                ? 'bg-red-500 text-white shadow-[0_0_0_3px_rgba(239,68,68,0.25)] animate-pulse'
                : 'bg-[#e9e9e9] hover:bg-[#d4d4d4] text-[#676767]'
            }`}
          >
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
              <path d="M19 10v2a7 7 0 0 1-14 0v-2H3v2a9 9 0 0 0 8 8.94V23h2v-2.06A9 9 0 0 0 21 12v-2h-2z"/>
            </svg>
          </button>
        )}

        {/* Send */}
        <button
          onClick={() => void doSendMessage(inputText)}
          disabled={!inputText.trim() || inputDisabled}
          className="w-9 h-9 rounded-full bg-[#f37321] hover:bg-[#da6520] disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center text-white flex-shrink-0 transition-colors"
        >
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
            <path d="M2 21l21-9L2 3v7l15 2-15 2z"/>
          </svg>
        </button>
      </div>

      {/* ── Action bar — below input, shown once song is ready ── */}
      {chatDone && !chatCollapsed && !loading && generatedSong && (
        <div className="border-t border-[#e9e9e9] px-4 py-2.5 flex items-center gap-2 bg-[#fffaf6]">
          <button
            onClick={() => { setChatDone(false); setChatCollapsed(false); }}
            className="px-3 py-1.5 rounded-lg border border-[#d4d4d4] text-[#676767] hover:border-[#929292] hover:text-[#3b3b3b] text-xs font-semibold transition-colors"
          >
            Resume chat
          </button>
        </div>
      )}

      {/* Composing song — floating fixed overlay */}
      {composingJson && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
          <div className="rounded-xl border border-[#e9e9e9] bg-white p-6 shadow-[0_8px_40px_rgba(0,0,0,0.18)] w-[640px] max-w-[90vw]">
            <div className="flex items-center justify-between mb-3">
              <span className="font-semibold text-[#3b3b3b]">Writing Your Song</span>
              <span className="text-sm tabular-nums text-[#929292]">{Math.round(jsonProgress)}%</span>
            </div>
            <div className="w-full h-2 rounded-full bg-[#e9e9e9] overflow-hidden mb-3">
              <div
                className="h-full rounded-full bg-[#f37321] transition-all duration-700 ease-out"
                style={{ width: `${jsonProgress}%` }}
              />
            </div>
            <p className="text-xs text-[#929292]">{jsonProgressLabel}</p>
          </div>
        </div>
      )}
    </div>
  );
}
