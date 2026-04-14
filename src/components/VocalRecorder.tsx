'use client';

import { useRef, useState } from 'react';
import MultiTrackPlayer, { VocalTrack } from './MultiTrackPlayer';

type RecordingStage =
  | 'idle'
  | 'prompt'
  | 'listening'
  | 'headphones'
  | 'countdown'
  | 'recording'
  | 'mixing';

interface Props {
  latestAudioUrl: string | null;
  title: string;
}

function encodeWav(buffer: AudioBuffer): string {
  const { numberOfChannels, sampleRate, length } = buffer;
  const pcmSize = length * numberOfChannels * 2;
  const ab = new ArrayBuffer(44 + pcmSize);
  const view = new DataView(ab);
  const ws = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  ws(0, 'RIFF'); view.setUint32(4, 36 + pcmSize, true);
  ws(8, 'WAVE'); ws(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, numberOfChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numberOfChannels * 2, true);
  view.setUint16(32, numberOfChannels * 2, true); view.setUint16(34, 16, true);
  ws(36, 'data'); view.setUint32(40, pcmSize, true);
  const channels = Array.from({ length: numberOfChannels }, (_, i) => buffer.getChannelData(i));
  let off = 44;
  for (let i = 0; i < length; i++) {
    for (let ch = 0; ch < numberOfChannels; ch++) {
      const s = Math.max(-1, Math.min(1, channels[ch][i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return URL.createObjectURL(new Blob([ab], { type: 'audio/wav' }));
}

let nextTrackId = 1;

export default function VocalRecorder({ latestAudioUrl, title }: Props) {
  const [stage, setStage] = useState<RecordingStage>('idle');
  const [countdown, setCountdown] = useState(3);
  const [vocalTracks, setVocalTracks] = useState<VocalTrack[]>([]);
  const [error, setError] = useState('');

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const backingRef = useRef<HTMLAudioElement | null>(null);

  const startNewRecording = () => {
    if (!latestAudioUrl) {
      setError("Generate your song first, then let's add some vocals.");
      return;
    }
    setError('');
    setStage('prompt');
  };

  const goHeadphones = () => setStage('headphones');

  const beginCountdown = async () => {
    // Pre-load and pre-decode the audio BEFORE the countdown so there is zero
    // buffering delay between recorder.start() and audio actually playing.
    // MP3 blob URLs can take 500–1500 ms to decode on first play; pre-loading
    // here ensures the audio starts instantly when the countdown ends.
    if (latestAudioUrl) {
      const audio = new Audio(latestAudioUrl);
      audio.preload = 'auto';
      backingRef.current = audio;
      await new Promise<void>(resolve => {
        audio.addEventListener('canplaythrough', () => resolve(), { once: true });
        audio.addEventListener('error', () => resolve(), { once: true }); // don't block on error
        audio.load();
        setTimeout(resolve, 4000); // safety cap — proceed even if event never fires
      });
    }

    setStage('countdown');
    for (let n = 3; n >= 1; n--) {
      setCountdown(n);
      await new Promise(r => setTimeout(r, 1000));
    }
    await doRecord();
  };

  const doRecord = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      streamRef.current = stream;

      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
        .find(m => MediaRecorder.isTypeSupported(m)) ?? '';
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = () => mix(recorder.mimeType, latestAudioUrl!);

      // Start the recorder BEFORE audio.play() so the recording has a brief
      // pre-roll of silence that naturally aligns with the backing track start.
      // This prevents the recorder from missing the first samples of the song.
      recorder.start(100);

      const audio = backingRef.current ?? new Audio(latestAudioUrl!);
      backingRef.current = audio;
      audio.onended = stopRecording;
      // Record the exact moment audio begins — any gap between recorder.start()
      // and audio actually playing becomes correct pre-roll silence in the recording.
      await audio.play();

      setStage('recording');
    } catch {
      setError('Could not access microphone — check your browser permissions.');
      setStage('headphones');
    }
  };

  const stopRecording = () => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive') return;
    backingRef.current?.pause();
    streamRef.current?.getTracks().forEach(t => t.stop());
    setStage('mixing');
    recorder.stop();
  };

  const mix = async (mimeType: string, backingUrl: string) => {
    try {
      const vocBlob = new Blob(chunksRef.current, { type: mimeType || 'audio/webm' });
      const [backArray, vocArray] = await Promise.all([
        fetch(backingUrl).then(r => r.arrayBuffer()),
        vocBlob.arrayBuffer(),
      ]);

      const ctx = new AudioContext();
      const [backBuf, vocBuf] = await Promise.all([
        ctx.decodeAudioData(backArray),
        ctx.decodeAudioData(vocArray),
      ]);
      await ctx.close();

      // Store vocals-only so MultiTrackPlayer controls volume independently
      const nCh = Math.max(1, vocBuf.numberOfChannels);
      const outBuf = new AudioBuffer({ numberOfChannels: nCh, length: vocBuf.length, sampleRate: backBuf.sampleRate });
      for (let ch = 0; ch < nCh; ch++) {
        const out = outBuf.getChannelData(ch);
        const voc = vocBuf.getChannelData(Math.min(ch, vocBuf.numberOfChannels - 1));
        for (let i = 0; i < vocBuf.length; i++) out[i] = voc[i];
      }

      const url = encodeWav(outBuf);
      const id = String(nextTrackId++);
      setVocalTracks(prev => [...prev, { id, url, label: `Vocal Take ${prev.length + 1}` }]);
      setStage('idle');
      recorderRef.current = null;
      chunksRef.current = [];
      backingRef.current = null;
    } catch {
      setError('Failed to process audio. Please try again.');
      setStage('idle');
    }
  };

  const handleDeleteVocal = (id: string) => {
    setVocalTracks(prev => prev.filter(t => t.id !== id));
  };

  const isRecordingFlow = stage !== 'idle';

  return (
    <div className="flex flex-col gap-3">
      {/* MultiTrackPlayer — shown once there are vocal tracks */}
      {vocalTracks.length > 0 && latestAudioUrl && (
        <MultiTrackPlayer
          instrumentalUrl={latestAudioUrl}
          vocalTracks={vocalTracks}
          onAddVocal={startNewRecording}
          onDeleteVocal={handleDeleteVocal}
        />
      )}

      {/* Trigger button — shown when not in a recording flow */}
      {!isRecordingFlow && (
        <div className="flex flex-col gap-2">
          <button
            onClick={startNewRecording}
            className="px-6 py-2.5 rounded-lg bg-[#f6f6f6] hover:bg-[#e9e9e9] border border-[#bdbdbd] text-[#3b3b3b] text-sm font-semibold transition-colors flex items-center gap-2"
          >
            <svg className="w-4 h-4 text-[#f37321]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4M9 11V7a3 3 0 016 0v4a3 3 0 01-6 0z" />
            </svg>
            {vocalTracks.length === 0 ? 'Record Vocals' : 'Add Vocal Track'}
          </button>
          {error && (
            <p className="text-sm text-amber-700 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
              {error}
            </p>
          )}
        </div>
      )}

      {/* ── PROMPT ────────────────────────────────────────────────── */}
      {stage === 'prompt' && (
        <div className="rounded-lg border border-[#e9e9e9] bg-white p-5 flex flex-col gap-4 shadow-[0_2px_8px_rgba(0,0,0,0.06)]">
          <p className="text-[#3b3b3b] font-medium">Would you like to listen back to the track or start singing now?</p>
          <div className="flex gap-3">
            <button
              onClick={() => setStage('listening')}
              className="flex-1 py-2 rounded-lg border border-[#bdbdbd] hover:border-[#f37321] text-[#676767] hover:text-[#f37321] text-sm font-medium transition-colors"
            >
              Listen Back First
            </button>
            <button
              onClick={goHeadphones}
              className="flex-1 py-2 rounded-lg bg-[#f37321] hover:bg-[#da6520] text-white text-sm font-semibold transition-colors"
            >
              Start Singing Now
            </button>
          </div>
          <button onClick={() => setStage('idle')} className="self-start text-xs text-[#929292] hover:text-[#676767] transition-colors">
            Cancel
          </button>
        </div>
      )}

      {/* ── LISTEN BACK ───────────────────────────────────────────── */}
      {stage === 'listening' && latestAudioUrl && (
        <div className="rounded-lg border border-[#e9e9e9] bg-white p-5 flex flex-col gap-4 shadow-[0_2px_8px_rgba(0,0,0,0.06)]">
          <p className="text-xs text-[#929292] font-semibold uppercase tracking-wide">Listen Back</p>
          <audio controls src={latestAudioUrl} className="w-full h-10" />
          <div className="flex gap-3">
            <button
              onClick={goHeadphones}
              className="self-start flex items-center gap-2 px-5 py-2 rounded-lg bg-[#f37321] hover:bg-[#da6520] text-white text-sm font-semibold transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4M9 11V7a3 3 0 016 0v4a3 3 0 01-6 0z" />
              </svg>
              Record Vocals
            </button>
            <button onClick={() => setStage('idle')} className="self-start text-xs text-[#929292] hover:text-[#676767] transition-colors py-2">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── HEADPHONES REMINDER ───────────────────────────────────── */}
      {stage === 'headphones' && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-5 flex flex-col gap-4">
          <div className="flex items-start gap-3">
            <span className="text-2xl">🎧</span>
            <div className="flex flex-col gap-1">
              <p className="text-amber-800 font-semibold text-sm">Put on your headphones</p>
              <p className="text-amber-700/80 text-xs leading-relaxed">
                Before recording, please wear headphones so the backing track playing from your speakers
                doesn't bleed into your microphone. Once you're ready, hit the button below.
              </p>
            </div>
          </div>
          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="flex gap-3">
            <button
              onClick={beginCountdown}
              className="self-start px-5 py-2 rounded-lg bg-[#f37321] hover:bg-[#da6520] text-white text-sm font-semibold transition-colors"
            >
              I'm Ready — Let's Go
            </button>
            <button onClick={() => setStage('idle')} className="self-start text-xs text-[#929292] hover:text-[#676767] transition-colors py-2">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── COUNTDOWN ─────────────────────────────────────────────── */}
      {stage === 'countdown' && (
        <div className="rounded-lg border border-[#e9e9e9] bg-white p-8 flex flex-col items-center gap-2 shadow-[0_2px_8px_rgba(0,0,0,0.06)]">
          <p className="text-xs text-[#929292] uppercase tracking-widest">Get ready…</p>
          <span className="text-7xl font-bold text-[#f37321] tabular-nums" style={{ lineHeight: 1.1 }}>
            {countdown}
          </span>
        </div>
      )}

      {/* ── RECORDING ─────────────────────────────────────────────── */}
      {stage === 'recording' && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-5 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="w-3 h-3 rounded-full bg-red-500 animate-pulse flex-shrink-0" />
            <span className="text-red-700 text-sm font-medium">Recording — backing track is playing in your headphones</span>
          </div>
          <button
            onClick={stopRecording}
            className="flex-shrink-0 px-4 py-1.5 rounded-lg border border-red-300 hover:bg-red-100 text-red-600 text-xs font-medium transition-colors"
          >
            Stop
          </button>
        </div>
      )}

      {/* ── MIXING ────────────────────────────────────────────────── */}
      {stage === 'mixing' && (
        <div className="rounded-lg border border-[#e9e9e9] bg-white p-5 flex items-center gap-3 shadow-[0_2px_8px_rgba(0,0,0,0.06)]">
          <span className="w-4 h-4 rounded-full border-2 border-[#e9e9e9] border-t-[#f37321] animate-spin flex-shrink-0" />
          <span className="text-[#676767] text-sm">Processing your vocal take…</span>
        </div>
      )}
    </div>
  );
}
