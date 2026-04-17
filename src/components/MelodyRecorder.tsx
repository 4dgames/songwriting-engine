'use client';

import { forwardRef, useImperativeHandle, useRef, useState } from 'react';

export interface MelodyRecorderHandle {
  start: () => Promise<void>;
  stop: () => void;
}

interface Props {
  onMelodyChange: (url: string | null) => void;
  /** When true, hide the internal Hum/Stop buttons — caller renders them externally. */
  noStartButton?: boolean;
  onRecordingChange?: (recording: boolean) => void;
}

const MelodyRecorder = forwardRef<MelodyRecorderHandle, Props>(function MelodyRecorder(
  { onMelodyChange, noStartButton, onRecordingChange },
  ref,
) {
  const [recording, setRecording] = useState(false);
  const [melodyUrl, setMelodyUrl] = useState<string | null>(null);
  const [error, setError] = useState('');

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef   = useRef<Blob[]>([]);
  const streamRef   = useRef<MediaStream | null>(null);

  const startRecording = async () => {
    setError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      streamRef.current = stream;

      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
        .find(m => MediaRecorder.isTypeSupported(m)) ?? '';
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = () => {
        streamRef.current?.getTracks().forEach(t => t.stop());
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        if (melodyUrl) URL.revokeObjectURL(melodyUrl);
        const url = URL.createObjectURL(blob);
        setMelodyUrl(url);
        onMelodyChange(url);
      };

      recorder.start(100);
      setRecording(true);
      onRecordingChange?.(true);
    } catch {
      setError('Could not access microphone — check your browser permissions.');
    }
  };

  const stopRecording = () => {
    recorderRef.current?.stop();
    setRecording(false);
    onRecordingChange?.(false);
  };

  useImperativeHandle(ref, () => ({
    start: startRecording,
    stop: stopRecording,
  }));

  const clear = () => {
    if (melodyUrl) URL.revokeObjectURL(melodyUrl);
    setMelodyUrl(null);
    onMelodyChange(null);
  };

  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (melodyUrl) URL.revokeObjectURL(melodyUrl);
    const url = URL.createObjectURL(file);
    setMelodyUrl(url);
    onMelodyChange(url);
    e.target.value = '';
  };

  if (melodyUrl) {
    return (
      <div className="flex items-center gap-3 flex-wrap">
        <span className="flex items-center gap-1 text-xs text-green-700 font-semibold">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          Melody captured
        </span>
        <audio src={melodyUrl} controls className="h-8 max-w-[220px]" />
        <button onClick={clear} className="text-xs text-[#929292] hover:text-red-500 transition-colors">
          Clear
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 flex-wrap">
        {recording ? (
          <>
            <span className="flex items-center gap-1.5 text-xs text-red-600 font-semibold">
              <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse flex-shrink-0" />
              Recording… hum or sing your melody
            </span>
            {!noStartButton && (
              <button
                onClick={stopRecording}
                className="px-3 py-1 rounded border border-red-300 hover:bg-red-50 text-red-600 text-xs font-semibold transition-colors"
              >
                Stop
              </button>
            )}
          </>
        ) : (
          <>
            {!noStartButton && (
              <button
                onClick={() => void startRecording()}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-[#bdbdbd] hover:border-[#f37321] text-[#676767] hover:text-[#f37321] text-xs font-semibold transition-colors"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4M9 11V7a3 3 0 016 0v4a3 3 0 01-6 0z" />
                </svg>
                Hum a melody
              </button>
            )}
            <label className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-[#bdbdbd] hover:border-[#f37321] text-[#676767] hover:text-[#f37321] text-xs font-semibold transition-colors cursor-pointer">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
              Upload audio
              <input type="file" accept="audio/*" onChange={handleUpload} className="sr-only" />
            </label>
          </>
        )}
      </div>
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  );
});

export default MelodyRecorder;
