'use client';

import { useEffect, useRef, useState } from 'react';
import VolumeKnob from './VolumeKnob';

export interface VocalTrack {
  id: string;
  url: string;
  label: string;
}

interface Props {
  instrumentalUrl: string;
  vocalTracks: VocalTrack[];
  onAddVocal: () => void;
  onDeleteVocal: (id: string) => void;
}

interface TrackState {
  volume: number;
  playing: boolean;
}

export default function MultiTrackPlayer({ instrumentalUrl, vocalTracks, onAddVocal, onDeleteVocal }: Props) {
  const [masterPlaying, setMasterPlaying] = useState(false);
  const [instState, setInstState] = useState<TrackState>({ volume: 0.75, playing: false });
  const [vocalStates, setVocalStates] = useState<Record<string, TrackState>>({});
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const instRef = useRef<HTMLAudioElement | null>(null);
  const vocalRefs = useRef<Record<string, HTMLAudioElement>>({});

  useEffect(() => {
    setVocalStates(prev => {
      const next: Record<string, TrackState> = {};
      for (const t of vocalTracks) {
        next[t.id] = prev[t.id] ?? { volume: 0.9, playing: false };
      }
      return next;
    });

    const ids = new Set(vocalTracks.map(t => t.id));

    // Remove stale audio elements.
    for (const id of Object.keys(vocalRefs.current)) {
      if (!ids.has(id)) {
        vocalRefs.current[id].pause();
        delete vocalRefs.current[id];
      }
    }

    // Eagerly create and preload new audio elements so they are buffered and
    // ready before masterPlay() is ever called. Lazy creation (inside masterPlay)
    // causes vocal tracks to start 0.5–1.5 s late while the browser decodes.
    for (const t of vocalTracks) {
      if (!vocalRefs.current[t.id]) {
        const el = new Audio(t.url);
        el.preload = 'auto';
        el.onended = () => {
          setVocalStates(prev => ({ ...prev, [t.id]: { ...prev[t.id], playing: false } }));
          checkAllEnded();
        };
        el.load();
        vocalRefs.current[t.id] = el;
      }
    }
  }, [vocalTracks]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (instRef.current) instRef.current.volume = instState.volume;
  }, [instState.volume]);

  useEffect(() => {
    for (const [id, state] of Object.entries(vocalStates)) {
      const el = vocalRefs.current[id];
      if (el) el.volume = state.volume;
    }
  }, [vocalStates]);

  const getVocalEl = (id: string): HTMLAudioElement => {
    // Elements are pre-created in the useEffect above; this is just a lookup.
    return vocalRefs.current[id];
  };

  const checkAllEnded = () => {
    const inst = instRef.current;
    const instEnded = !inst || inst.ended || inst.paused;
    const vocalsEnded = vocalTracks.every(t => {
      const el = vocalRefs.current[t.id];
      return !el || el.ended || el.paused;
    });
    if (instEnded && vocalsEnded) setMasterPlaying(false);
  };

  const masterPlay = async () => {
    const inst = instRef.current;

    // Reset all positions to 0 and apply current volumes before starting.
    if (inst) { inst.currentTime = 0; inst.volume = instState.volume; }
    for (const t of vocalTracks) {
      const el = getVocalEl(t.id);
      if (el) { el.currentTime = 0; el.volume = vocalStates[t.id]?.volume ?? 0.9; }
    }

    const promises: Promise<void>[] = [];
    if (inst) promises.push(inst.play());
    for (const t of vocalTracks) { const el = getVocalEl(t.id); if (el) promises.push(el.play()); }
    await Promise.allSettled(promises);
    setMasterPlaying(true);
    setInstState(s => ({ ...s, playing: true }));
    setVocalStates(prev => {
      const next = { ...prev };
      for (const t of vocalTracks) next[t.id] = { ...next[t.id], playing: true };
      return next;
    });
  };

  const masterPause = () => {
    instRef.current?.pause();
    for (const el of Object.values(vocalRefs.current)) el.pause();
    setMasterPlaying(false);
    setInstState(s => ({ ...s, playing: false }));
    setVocalStates(prev => {
      const next = { ...prev };
      for (const id of Object.keys(next)) next[id] = { ...next[id], playing: false };
      return next;
    });
  };

  const toggleTrack = async (type: 'inst' | string) => {
    if (type === 'inst') {
      const inst = instRef.current;
      if (!inst) return;
      if (instState.playing) {
        inst.pause();
        setInstState(s => ({ ...s, playing: false }));
      } else {
        await inst.play();
        setInstState(s => ({ ...s, playing: true }));
      }
    } else {
      const el = getVocalEl(type);
      const playing = vocalStates[type]?.playing ?? false;
      if (playing) {
        el.pause();
        setVocalStates(prev => ({ ...prev, [type]: { ...prev[type], playing: false } }));
      } else {
        await el.play();
        setVocalStates(prev => ({ ...prev, [type]: { ...prev[type], playing: true } }));
      }
    }
  };

  const handleDeleteConfirm = (id: string) => {
    const el = vocalRefs.current[id];
    if (el) { el.pause(); delete vocalRefs.current[id]; }
    onDeleteVocal(id);
    setConfirmDeleteId(null);
  };

  return (
    <div className="rounded-lg border border-[#e9e9e9] bg-white overflow-hidden shadow-[0_2px_8px_rgba(0,0,0,0.06)]">
      {/* Master transport */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-[#e9e9e9] bg-[#f6f6f6]">
        <button
          onClick={masterPlaying ? masterPause : masterPlay}
          className="w-8 h-8 rounded-full bg-[#f37321] hover:bg-[#da6520] flex items-center justify-center text-white transition-colors flex-shrink-0 shadow-[0_1px_4px_rgba(243,115,33,0.4)]"
          aria-label={masterPlaying ? 'Pause all' : 'Play all'}
        >
          {masterPlaying ? (
            <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
              <rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" />
            </svg>
          ) : (
            <svg className="w-3.5 h-3.5 ml-0.5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>
        <span className="text-xs font-bold text-[#929292] uppercase tracking-widest">Mixer</span>
      </div>

      {/* Vocal tracks */}
      {vocalTracks.map((track) => (
        <div key={track.id}>
          <TrackRow
            label={track.label}
            playing={vocalStates[track.id]?.playing ?? false}
            volume={vocalStates[track.id]?.volume ?? 0.9}
            onToggle={() => toggleTrack(track.id)}
            onVolumeChange={v => setVocalStates(prev => ({ ...prev, [track.id]: { ...prev[track.id], volume: v } }))}
            actions={
              <div className="flex items-center gap-1">
                <button
                  onClick={onAddVocal}
                  title="Add vocal track"
                  className="w-6 h-6 rounded border border-[#bdbdbd] hover:border-[#f37321] text-[#929292] hover:text-[#f37321] flex items-center justify-center text-xs transition-colors"
                >
                  +
                </button>
                <button
                  onClick={() => setConfirmDeleteId(track.id)}
                  title="Delete vocal track"
                  className="w-6 h-6 rounded border border-[#bdbdbd] hover:border-red-400 text-[#929292] hover:text-red-500 flex items-center justify-center text-xs transition-colors"
                >
                  −
                </button>
              </div>
            }
          />
          {confirmDeleteId === track.id && (
            <div className="flex items-center gap-3 px-4 py-2 bg-red-50 border-t border-red-100 text-xs">
              <span className="text-red-700 flex-1">Really want to delete this vocal track?</span>
              <button
                onClick={() => handleDeleteConfirm(track.id)}
                className="px-2.5 py-1 rounded bg-red-600 hover:bg-red-700 text-white font-semibold transition-colors"
              >
                Delete
              </button>
              <button
                onClick={() => setConfirmDeleteId(null)}
                className="px-2.5 py-1 rounded bg-[#e9e9e9] hover:bg-[#bdbdbd] text-[#3b3b3b] font-semibold transition-colors"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      ))}

      {/* Add vocal track button when there are no vocal tracks */}
      {vocalTracks.length === 0 && (
        <div className="px-4 py-3 border-t border-[#e9e9e9]">
          <button
            onClick={onAddVocal}
            className="flex items-center gap-2 text-xs text-[#929292] hover:text-[#f37321] transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Add Vocal Track
          </button>
        </div>
      )}

      {/* Instrumental track — always last */}
      <TrackRow
        label="Instrumental"
        playing={instState.playing}
        volume={instState.volume}
        onToggle={() => toggleTrack('inst')}
        onVolumeChange={v => setInstState(s => ({ ...s, volume: v }))}
      >
        <audio
          ref={instRef}
          src={instrumentalUrl}
          onEnded={() => { setInstState(s => ({ ...s, playing: false })); checkAllEnded(); }}
          preload="auto"
        />
      </TrackRow>
    </div>
  );
}

interface TrackRowProps {
  label: string;
  playing: boolean;
  volume: number;
  onToggle: () => void;
  onVolumeChange: (v: number) => void;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}

function TrackRow({ label, playing, volume, onToggle, onVolumeChange, actions, children }: TrackRowProps) {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5 border-t border-[#e9e9e9] first:border-0">
      <button
        onClick={onToggle}
        className="w-6 h-6 rounded-full bg-[#e9e9e9] hover:bg-[#f37321] flex items-center justify-center text-[#676767] hover:text-white transition-colors flex-shrink-0"
        aria-label={playing ? 'Pause track' : 'Play track'}
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

      <span className="text-sm text-[#3b3b3b] flex-1 truncate">{label}</span>

      {actions}

      <div className="flex items-center gap-1.5 flex-shrink-0">
        <span className="text-xs text-[#929292] w-6 text-right">{Math.round(volume * 100)}</span>
        <VolumeKnob value={volume} onChange={onVolumeChange} size={32} />
      </div>

      {children}
    </div>
  );
}
