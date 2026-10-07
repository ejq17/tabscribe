import type { Player } from '../audio';
import { scoreLength } from '../core';
import { useStore } from '../store';
import type { ChordEvent } from '../chords';
import { useAudioUi } from './uiStore';

let playerPromise: Promise<Player> | null = null;
let player: Player | null = null;

/** Create the Player on first use (dynamic import keeps audio out of the main bundle). */
export function getPlayer(): Promise<Player> {
  if (!playerPromise) {
    useAudioUi.setState({ loading: true, error: undefined });
    playerPromise = (async () => {
      const mod = await import('../audio');
      const p = new mod.Player();
      await p.load();
      player = p;
      useAudioUi.setState({ loading: false });
      return p;
    })().catch((e) => {
      playerPromise = null;
      useAudioUi.setState({ loading: false, error: e instanceof Error ? e.message : String(e) });
      throw e;
    });
  }
  return playerPromise;
}

export function peekPlayer(): Player | null {
  return player;
}

/** Player options plus the chord list for the accompaniment (forwarded to buildEvents). */
type PlayOpts = Parameters<Player['play']>[2] & { chords?: ChordEvent[] };

export async function startPlayback(fromTick?: number): Promise<void> {
  const st = useStore.getState();
  if (!st.score) return;
  const p = await getPlayer();
  const { score, guitar, playback, settings, chords } = useStore.getState();
  if (!score) return;
  const end = scoreLength(score);
  let from = fromTick ?? playback.tick;
  if (from >= end - 1) from = playback.loop?.from ?? 0;
  if (playback.loop && (from < playback.loop.from || from >= playback.loop.to)) from = playback.loop.from;
  p.stop();
  useStore.getState().setPlayback({ isPlaying: true, tick: from });
  const opts: PlayOpts = {
    fromTick: from,
    tempoScale: playback.tempoScale,
    metronome: playback.metronome,
    loop: playback.loop,
    onTick: (tick) => useStore.getState().setPlayback({ tick }),
    onEnd: () => {
      const pb = useStore.getState().playback;
      useStore.getState().setPlayback({ isPlaying: false, tick: pb.loop?.from ?? 0 });
    },
    chords: settings.playChords ? chords : undefined,
  };
  p.play(score, guitar, opts);
}

export function pausePlayback(): void {
  const tick = useStore.getState().playback.tick;
  player?.pause();
  useStore.getState().setPlayback({ isPlaying: false, tick });
}

export function stopPlayback(): void {
  player?.stop();
  useStore.getState().setPlayback({ isPlaying: false, tick: useStore.getState().playback.loop?.from ?? 0 });
}

export async function togglePlay(): Promise<void> {
  if (useStore.getState().playback.isPlaying) pausePlayback();
  else await startPlayback();
}

export async function seekTo(tick: number): Promise<void> {
  const pb = useStore.getState().playback;
  useStore.getState().setPlayback({ tick });
  if (pb.isPlaying) await startPlayback(tick);
}

/** Restart from the current position when a live setting (tempo, metronome, loop) changes. */
export function restartIfPlaying(): void {
  if (useStore.getState().playback.isPlaying) void startPlayback();
}

export async function auditionPitch(pitch: number): Promise<void> {
  try {
    const p = await getPlayer();
    p.playNote(pitch, 0.8);
  } catch {
    /* audio unavailable */
  }
}

export function setVolume(v: number): void {
  const p = player as unknown as { setVolume?: (v: number) => void } | null;
  p?.setVolume?.(v);
}
