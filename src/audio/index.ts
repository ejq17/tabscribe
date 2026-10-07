// STUB — replaced by the audio agent. Keep these signatures.
import type { Score, GuitarConfig } from '../core';
export interface AudioTranscribeOptions { onProgress?: (p: { stage: string; fraction: number }) => void; bpm?: number }
export async function transcribeAudio(_data: ArrayBuffer, _opts?: AudioTranscribeOptions): Promise<Score> { throw new Error('not implemented'); }
export interface PlayOptions { fromTick?: number; tempoScale?: number; onTick?: (tick: number) => void; onEnd?: () => void; metronome?: boolean; loop?: { from: number; to: number } }
export class Player {
  get isPlaying(): boolean { return false; }
  async load(): Promise<void> {}
  play(_score: Score, _guitar: GuitarConfig, _opts?: PlayOptions): void {}
  pause(): void {}
  resume(): void {}
  stop(): void {}
  seek(_tick: number): void {}
  playNote(_pitch: number, _durationSec?: number): void {}
}
