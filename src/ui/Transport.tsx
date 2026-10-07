import { useMemo } from 'react';
import { measuresOf, scoreLength } from '../core';
import { useStore } from '../store';
import { guitarNotes } from '../store/ops';
import { restartIfPlaying, seekTo, setVolume, stopPlayback, togglePlay } from './playback';
import { useAudioUi } from './uiStore';

export default function Transport() {
  const score = useStore((s) => s.score);
  const pb = useStore((s) => s.playback);
  const selection = useStore((s) => s.selection);
  const setPlayback = useStore((s) => s.setPlayback);
  const loading = useAudioUi((s) => s.loading);
  const audioError = useAudioUi((s) => s.error);

  const measures = useMemo(() => (score ? measuresOf(score) : []), [score]);
  const total = score ? scoreLength(score) : 0;

  if (!score) return null;

  const pos = (() => {
    const m = measures.find((mm) => pb.tick >= mm.startTick && pb.tick < mm.endTick) ?? measures[measures.length - 1];
    if (!m) return '1.1';
    const beatTicks = (score.ppq * 4) / m.timeSignature.denominator;
    return `${m.index + 1}.${Math.floor((pb.tick - m.startTick) / beatTicks) + 1}`;
  })();

  const toggleLoop = () => {
    if (pb.loop) {
      setPlayback({ loop: undefined });
    } else {
      const notes = guitarNotes(score).filter((n) => selection.includes(n.id));
      if (!notes.length) return;
      const from = Math.min(...notes.map((n) => n.start));
      const to = Math.max(...notes.map((n) => n.start + n.duration));
      setPlayback({ loop: { from, to } });
    }
    restartIfPlaying();
  };

  return (
    <footer className="transport" aria-label="Playback controls">
      <div className="tr-buttons">
        <button className="btn primary round" onClick={() => void togglePlay()} aria-label={pb.isPlaying ? 'Pause' : 'Play'} title="Play / pause (Space)">
          {pb.isPlaying ? '❚❚' : '▶'}
        </button>
        <button className="btn round" onClick={stopPlayback} aria-label="Stop" title="Stop">
          ■
        </button>
        <button
          className={`btn${pb.loop ? ' on' : ''}`}
          onClick={toggleLoop}
          aria-pressed={!!pb.loop}
          aria-label="Loop selection"
          title={pb.loop ? 'Clear loop' : 'Loop the selected notes'}
          disabled={!pb.loop && selection.length === 0}
        >
          ⟲ Loop
        </button>
        <button
          className={`btn${pb.metronome ? ' on' : ''}`}
          onClick={() => {
            setPlayback({ metronome: !pb.metronome });
            restartIfPlaying();
          }}
          aria-pressed={pb.metronome}
          aria-label="Metronome"
        >
          ♩ Click
        </button>
      </div>
      <div className="tr-pos">
        <span className="tr-time" aria-live="off">{pos}</span>
        <input
          type="range"
          min={0}
          max={Math.max(total, 1)}
          step={Math.max(1, Math.round(score.ppq / 4))}
          value={Math.min(pb.tick, total)}
          onChange={(e) => void seekTo(Number(e.target.value))}
          aria-label="Playback position"
        />
      </div>
      <div className="tr-sliders">
        <label title="Tempo">
          <span>Tempo {Math.round(pb.tempoScale * 100)}%</span>
          <input
            type="range"
            min={25}
            max={200}
            step={5}
            value={Math.round(pb.tempoScale * 100)}
            onChange={(e) => setPlayback({ tempoScale: Number(e.target.value) / 100 })}
            onPointerUp={restartIfPlaying}
            onKeyUp={restartIfPlaying}
            aria-label="Tempo percent"
          />
        </label>
        <label title="Volume">
          <span>Vol</span>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(pb.volume * 100)}
            onChange={(e) => {
              const v = Number(e.target.value) / 100;
              setPlayback({ volume: v });
              setVolume(v);
            }}
            aria-label="Volume"
          />
        </label>
      </div>
      {loading && <span className="tr-status">loading sounds…</span>}
      {audioError && <span className="tr-status err">Audio unavailable: {audioError}</span>}
    </footer>
  );
}
