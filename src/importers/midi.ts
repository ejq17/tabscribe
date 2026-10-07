import { Midi } from '@tonejs/midi';
import { DEFAULT_PPQ } from '../core';
import type { Score, Track, KeySignature } from '../core';
import { addWarning, keyNameToFifths, makeNote, sortScoreMeta } from './util';

/** Choose the best guitar candidate among tracks (indices into `tracks`, with drum flags). */
export function pickGuitarTarget(tracks: Track[], drums: boolean[]): void {
  let best = -1;
  for (let i = 0; i < tracks.length; i++) {
    if (drums[i] || tracks[i].notes.length === 0) continue;
    const p = tracks[i].program;
    if (p >= 24 && p <= 31) {
      if (best < 0 || !(tracks[best].program >= 24 && tracks[best].program <= 31) || tracks[i].notes.length > tracks[best].notes.length) best = i;
    }
  }
  if (best < 0) {
    for (let i = 0; i < tracks.length; i++) {
      if (drums[i]) continue;
      if (best < 0 || tracks[i].notes.length > tracks[best].notes.length) best = i;
    }
  }
  if (best >= 0) tracks[best].isGuitarTarget = true;
}

export function importMidi(data: ArrayBuffer): Score {
  const midi = new Midi(data);
  const srcPpq = midi.header.ppq || DEFAULT_PPQ;
  const k = DEFAULT_PPQ / srcPpq;
  const sc = (t: number) => Math.round(t * k);

  const score: Score = {
    ppq: DEFAULT_PPQ,
    tracks: [],
    timeSignatures: [],
    keySignatures: [],
    tempos: [],
    meta: { source: 'midi' },
  };
  if (midi.header.name) score.meta.title = midi.header.name;

  for (const t of midi.header.tempos) score.tempos.push({ tick: sc(t.ticks), bpm: Math.round(t.bpm * 100) / 100 });
  if (!score.tempos.length || score.tempos[0].tick > 0) score.tempos.unshift({ tick: 0, bpm: 120 });

  for (const ts of midi.header.timeSignatures) {
    score.timeSignatures.push({ tick: sc(ts.ticks), numerator: ts.timeSignature[0], denominator: ts.timeSignature[1] });
  }
  if (!score.timeSignatures.length || score.timeSignatures[0].tick > 0) {
    score.timeSignatures.unshift({ tick: 0, numerator: 4, denominator: 4 });
  }

  for (const ks of midi.header.keySignatures) {
    if (!ks.key) continue;
    const mode = ks.scale === 'minor' ? 'minor' : 'major';
    // Tone's `key` is the major-key name matching the signature (index into the circle of fifths), also for minor.
    const key: KeySignature = { tick: sc(ks.ticks), fifths: keyNameToFifths(ks.key, 'major'), mode };
    score.keySignatures.push(key);
  }
  if (!score.keySignatures.length || score.keySignatures[0].tick > 0) {
    score.keySignatures.unshift({ tick: 0, fifths: 0, mode: 'major' });
  }

  const drums: boolean[] = [];
  midi.tracks.forEach((mt, idx) => {
    if (mt.notes.length === 0) return;
    const isDrum = mt.channel === 9 || mt.instrument.percussion;
    const notes = mt.notes.map((n) =>
      makeNote(n.midi, sc(n.ticks), Math.max(1, sc(n.durationTicks)), Math.max(1, Math.min(127, Math.round(n.velocity * 127)))),
    );
    // Overlapping notes of the same pitch cannot share a voice cleanly; keep voice 0 otherwise.
    notes.sort((a, b) => a.start - b.start || b.pitch - a.pitch);
    const track: Track = {
      id: `t${idx}`,
      name: mt.name || mt.instrument.name || `Track ${idx + 1}`,
      program: isDrum ? 0 : mt.instrument.number,
      notes,
    };
    score.tracks.push(track);
    drums.push(isDrum);
  });
  if (score.tracks.length === 0) addWarning(score, 'MIDI file contains no notes.');
  else if (drums.some(Boolean)) addWarning(score, 'Percussion track(s) present; they are not suitable for tab.');
  pickGuitarTarget(score.tracks, drums);
  sortScoreMeta(score);
  return score;
}
