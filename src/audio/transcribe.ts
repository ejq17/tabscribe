/** Monophonic audio -> Score transcription. DSP is pure (Float32Array + sampleRate). */
import { PitchDetector } from 'pitchy';
import { DEFAULT_PPQ, createEmptyScore, newNoteId } from '../core';
import type { Note, Score } from '../core';

export interface AudioTranscribeOptions {
  onProgress?: (p: { stage: string; fraction: number }) => void;
  bpm?: number;
}

const WINDOW = 2048;
const HOP = 512;
const MIN_NOTE_SEC = 0.04;
const MIN_CLARITY = 0.9;

type Progress = AudioTranscribeOptions['onProgress'];

/** Decode compressed audio to a mono Float32Array at 44.1 kHz. */
export async function decodeToMono(data: ArrayBuffer): Promise<{ samples: Float32Array; sampleRate: number }> {
  const ctx = new OfflineAudioContext(1, 1, 44100);
  const buf = await ctx.decodeAudioData(data.slice(0));
  const out = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += ch[i] / buf.numberOfChannels;
  }
  return { samples: out, sampleRate: buf.sampleRate };
}

export async function transcribeAudio(data: ArrayBuffer, opts: AudioTranscribeOptions = {}): Promise<Score> {
  opts.onProgress?.({ stage: 'Decoding audio', fraction: 0 });
  const { samples, sampleRate } = await decodeToMono(data);
  opts.onProgress?.({ stage: 'Decoding audio', fraction: 1 });
  // let the UI paint
  await new Promise((r) => setTimeout(r, 0));
  return transcribeSamples(samples, sampleRate, opts);
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[s.length >> 1];
}

interface RawNote {
  startSec: number;
  endSec: number;
  midi: number;
  clarity: number;
}

export function transcribeSamples(samples: Float32Array, sampleRate: number, opts: AudioTranscribeOptions = {}): Score {
  const progress: Progress = opts.onProgress;
  const nFrames = samples.length >= WINDOW ? Math.floor((samples.length - WINDOW) / HOP) + 1 : 0;
  const rms = new Float32Array(nFrames);
  const midiF = new Float32Array(nFrames).fill(NaN);
  const clarity = new Float32Array(nFrames);

  // Stage 1: energy
  for (let f = 0; f < nFrames; f++) {
    let sum = 0;
    const off = f * HOP;
    for (let i = 0; i < WINDOW; i++) sum += samples[off + i] * samples[off + i];
    rms[f] = Math.sqrt(sum / WINDOW);
  }
  progress?.({ stage: 'Analyzing energy', fraction: 1 });
  let maxRms = 0;
  for (let f = 0; f < nFrames; f++) maxRms = Math.max(maxRms, rms[f]);
  const threshold = Math.max(0.01, 0.05 * maxRms);

  // Stage 2: pitch
  const detector = PitchDetector.forFloat32Array(WINDOW);
  for (let f = 0; f < nFrames; f++) {
    if (rms[f] > threshold) {
      const [hz, c] = detector.findPitch(samples.subarray(f * HOP, f * HOP + WINDOW), sampleRate);
      clarity[f] = c;
      if (c > MIN_CLARITY && hz > 30 && hz < 4500) midiF[f] = 69 + 12 * Math.log2(hz / 440);
    }
    if (f % 64 === 0) progress?.({ stage: 'Detecting pitch', fraction: f / Math.max(1, nFrames) });
  }
  progress?.({ stage: 'Detecting pitch', fraction: 1 });

  // Stage 3: median filter (5 frames) + rounding
  const midi = new Int16Array(nFrames).fill(-1);
  for (let f = 0; f < nFrames; f++) {
    if (Number.isNaN(midiF[f])) continue;
    const win: number[] = [];
    for (let k = Math.max(0, f - 2); k <= Math.min(nFrames - 1, f + 2); k++) if (!Number.isNaN(midiF[k])) win.push(midiF[k]);
    midi[f] = Math.round(median(win));
  }

  // Stage 4: segmentation
  progress?.({ stage: 'Segmenting notes', fraction: 0 });
  const minFrames = Math.max(1, Math.ceil((MIN_NOTE_SEC * sampleRate) / HOP));
  const raw: RawNote[] = [];
  const onsetFactor = Math.max(0.1 * maxRms, 0.005);
  let start = -1;
  const close = (endExclusive: number) => {
    if (start < 0) return;
    const len = endExclusive - start;
    if (len >= minFrames) {
      const pitches: number[] = [];
      let cl = 0;
      for (let k = start; k < endExclusive; k++) {
        pitches.push(midi[k]);
        cl += clarity[k];
      }
      raw.push({
        startSec: (start * HOP + WINDOW / 2) / sampleRate,
        endSec: (endExclusive * HOP + WINDOW / 2) / sampleRate,
        midi: median(pitches),
        clarity: Math.min(1, cl / len),
      });
    }
    start = -1;
  };
  for (let f = 0; f < nFrames; f++) {
    if (midi[f] < 0) {
      close(f);
      continue;
    }
    if (start >= 0) {
      const energyOnset = f > 0 && rms[f] - rms[f - 1] > onsetFactor && rms[f] > 1.5 * rms[f - 1];
      let pitchChange = false;
      if (Math.abs(midiF[f] - midi[start]) > 0.6 || midi[f] !== midi[f - 1]) {
        // sustained: next 3 frames (incl. this) agree on a different pitch
        let same = 0;
        for (let k = f; k < Math.min(nFrames, f + 3); k++) if (midi[k] === midi[f] && midi[f] !== midi[start]) same++;
        pitchChange = same >= Math.min(3, nFrames - f) && midi[f] !== midi[start];
      }
      if (energyOnset || pitchChange) {
        close(f);
        start = f;
      }
    } else {
      start = f;
    }
  }
  close(nFrames);

  // Stage 5: tempo
  progress?.({ stage: 'Estimating tempo', fraction: 0 });
  const bpm = opts.bpm && opts.bpm > 0 ? opts.bpm : estimateBpm(raw.map((n) => n.startSec));
  progress?.({ stage: 'Estimating tempo', fraction: 1 });

  // Stage 6: quantize
  const ppq = DEFAULT_PPQ;
  const grid = ppq / 4; // 16th = 120 ticks
  const secToTick = (s: number) => (s * bpm * ppq) / 60;
  const notes: Note[] = [];
  for (const r of raw) {
    let startTick = Math.round(secToTick(r.startSec) / grid) * grid;
    let dur = Math.max(grid, Math.round(secToTick(r.endSec - r.startSec) / grid) * grid);
    const prev = notes[notes.length - 1];
    if (prev) {
      if (startTick < prev.start + grid) startTick = prev.start + grid;
      if (startTick < prev.start + prev.duration) prev.duration = Math.max(grid, startTick - prev.start);
    }
    dur = Math.max(grid, dur);
    notes.push({
      id: newNoteId(),
      pitch: r.midi,
      start: startTick,
      duration: dur,
      velocity: 90,
      voice: 0,
      confidence: r.clarity,
    });
  }
  const score = createEmptyScore({
    source: 'audio',
    warnings: ['Audio was transcribed as a single melodic line (monophonic). Chords and overlapping notes are not detected; review and edit the result.'],
  });
  score.ppq = ppq;
  score.tempos = [{ tick: 0, bpm }];
  score.tracks = [{ id: 'audio-1', name: 'Transcribed melody', program: 25, isGuitarTarget: true, notes }];
  if (notes.length === 0) score.meta.warnings!.push('No clear pitched notes were detected.');
  progress?.({ stage: 'Done', fraction: 1 });
  return score;
}

/** Estimate tempo (60-180 bpm) from note onset times. Exported for testing. */
export function estimateBpm(onsets: number[]): number {
  if (onsets.length < 3) return 120;
  const iois: number[] = [];
  for (let i = 1; i < onsets.length; i++) {
    const d = onsets[i] - onsets[i - 1];
    if (d > 0.05) iois.push(d);
    if (i > 1) {
      const d2 = onsets[i] - onsets[i - 2];
      if (d2 < 2) iois.push(d2);
    }
  }
  if (iois.length === 0) return 120;
  let best = 120;
  let bestScore = -Infinity;
  for (let bpm = 60; bpm <= 180; bpm++) {
    const beat = 60 / bpm;
    let s = 0;
    for (const d of iois) s += Math.cos((2 * Math.PI * d) / beat) + 0.5 * Math.cos((4 * Math.PI * d) / beat);
    s /= iois.length;
    // mild preference for common tempi
    s -= Math.abs(bpm - 110) / 5000;
    if (s > bestScore) {
      bestScore = s;
      best = bpm;
    }
  }
  return best;
}
