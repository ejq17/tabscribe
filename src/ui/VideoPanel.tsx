import { useEffect, useRef, useState } from 'react';
import { ticksToSeconds } from '../core';
import { useStore } from '../store';
import { createVideoPlayer, type VideoPlayer } from '../video/player';
import { createSyncController } from '../video/sync';
import { formatTime, parseTime, parseYouTubeUrl } from '../video/youtube';
import { isGuitarMuted, setGuitarMuted } from './playback';
import { createTransportHooks } from './videoTransport';

/** Attach a YouTube video to the tab and play it in sync with the transport. */
export default function VideoPanel() {
  const score = useStore((s) => s.score);
  const setVideo = useStore((s) => s.setVideo);
  const video = score?.meta.video;
  const id = video?.youtubeId;
  const startSec = video?.startSec ?? 0;

  const [url, setUrl] = useState('');
  const [urlError, setUrlError] = useState('');
  const [playerError, setPlayerError] = useState('');
  const [startText, setStartText] = useState(formatTime(startSec));
  const [startBad, setStartBad] = useState(false);
  const [vol, setVol] = useState(100);
  const [vMuted, setVMuted] = useState(false);
  const [gMuted, setGMuted] = useState(isGuitarMuted());
  const holder = useRef<HTMLDivElement>(null);
  const playerRef = useRef<VideoPlayer | null>(null);

  // Re-sync the field when the stored start changes (derive during render, not in an effect).
  const [shownStart, setShownStart] = useState(startSec);
  if (shownStart !== startSec) {
    setShownStart(startSec);
    setStartText(formatTime(startSec));
    setStartBad(false);
  }

  // One player + sync controller per attached video; torn down when the video changes or the panel unmounts.
  useEffect(() => {
    const el = holder.current;
    if (!id || !el) return;
    let cancelled = false;
    let dispose = () => {};
    setPlayerError('');
    createVideoPlayer(el, id, useStore.getState().score?.meta.video?.startSec ?? 0).then(
      (p) => {
        if (cancelled) {
          p.destroy();
          return;
        }
        playerRef.current = p;
        const ctl = createSyncController(p, createTransportHooks(), {
          getStartSec: () => useStore.getState().score?.meta.video?.startSec ?? 0,
          getRate: () => useStore.getState().playback.tempoScale,
        });
        dispose = () => {
          ctl.dispose();
          p.destroy();
        };
      },
      (e) => {
        if (!cancelled) setPlayerError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      cancelled = true;
      dispose();
      playerRef.current = null;
    };
  }, [id]);

  useEffect(() => {
    playerRef.current?.setVolume(vMuted ? 0 : vol);
  }, [vol, vMuted, id, playerError]);

  if (!score) return null;

  const load = () => {
    const parsed = parseYouTubeUrl(url);
    if (!parsed) {
      setUrlError('That does not look like a YouTube link or video id.');
      return;
    }
    setUrlError('');
    setVideo({ youtubeId: parsed.id, startSec: parsed.t ?? (parsed.id === id ? startSec : 0) });
    setUrl('');
  };

  const commitStart = () => {
    const t = parseTime(startText);
    if (t === null) {
      setStartBad(true);
      return;
    }
    setStartBad(false);
    if (id) setVideo({ youtubeId: id, startSec: t });
  };

  const tabSeconds = () => {
    const s = useStore.getState().score;
    return s ? ticksToSeconds(s, useStore.getState().playback.tick) : 0;
  };
  const useCurrent = () => {
    const p = playerRef.current;
    if (p && id) setVideo({ youtubeId: id, startSec: p.getTime() });
  };
  const alignToPlayhead = () => {
    const p = playerRef.current;
    if (p && id) setVideo({ youtubeId: id, startSec: Math.max(0, p.getTime() - tabSeconds()) });
  };

  return (
    <section className="video-panel" aria-label="Video">
      <h2 className="pane-title">Video</h2>
      <form
        className="vp-row"
        onSubmit={(e) => {
          e.preventDefault();
          load();
        }}
      >
        <input
          type="text"
          className={urlError ? 'bad' : undefined}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Paste a YouTube link"
          aria-label="YouTube link"
          aria-invalid={!!urlError}
        />
        <button type="submit" className="btn">Load</button>
      </form>
      {urlError && <p className="vp-error" role="alert">{urlError}</p>}
      {id && (
        <>
          {playerError ? (
            <p className="vp-error" role="alert">{playerError}</p>
          ) : (
            <div className="vp-frame" ref={holder} />
          )}
          <div className="vp-row">
            <label className="vp-start">
              <span>Start in video</span>
              <input
                type="text"
                inputMode="numeric"
                className={startBad ? 'bad' : undefined}
                value={startText}
                onChange={(e) => setStartText(e.target.value)}
                onBlur={commitStart}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitStart();
                }}
                aria-label="Start in video"
                aria-invalid={startBad}
              />
            </label>
            <button className="btn" onClick={useCurrent} title="Pause the video where the music begins, then press this">Use current video time</button>
            <button className="btn" onClick={alignToPlayhead} title="Make the current video moment match the tab playhead">Align to playhead</button>
          </div>
          <div className="vp-row">
            <label className="vp-vol">
              <span>Video volume</span>
              <input type="range" min={0} max={100} value={vol} onChange={(e) => setVol(Number(e.target.value))} aria-label="Video volume" />
            </label>
            <button className={`btn${vMuted ? ' on' : ''}`} aria-pressed={vMuted} onClick={() => setVMuted(!vMuted)}>Mute video</button>
            <button
              className={`btn${gMuted ? ' on' : ''}`}
              aria-pressed={gMuted}
              onClick={() => {
                setGuitarMuted(!gMuted);
                setGMuted(!gMuted);
              }}
              title="Silence the app's own guitar so you only hear the video"
            >
              Guitar audio {gMuted ? 'off' : 'on'}
            </button>
            <button className="btn danger" onClick={() => setVideo(undefined)}>Remove video</button>
          </div>
        </>
      )}
    </section>
  );
}
