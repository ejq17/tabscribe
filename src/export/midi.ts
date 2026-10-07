import { Midi } from '@tonejs/midi';
import { guitarTrack } from '../core';
import type { Score } from '../core';

const MAJOR_KEYS = ['Cb', 'Gb', 'Db', 'Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#'];
const MINOR_KEYS = ['Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#', 'G#', 'D#', 'A#'];

function isGuitarProgram(p: number): boolean { return p >= 24 && p <= 31; }

export function exportMidi(score: Score): Uint8Array {
  const midi = new Midi();
  const ppq = score.ppq || 480;
  const tempos = [...score.tempos].sort((a, b) => a.tick - b.tick).map((t) => ({ ticks: t.tick, bpm: t.bpm }));
  const sigs = [...score.timeSignatures].sort((a, b) => a.tick - b.tick).map((t) => ({ ticks: t.tick, timeSignature: [t.numerator, t.denominator] }));
  const keys = [...score.keySignatures].sort((a, b) => a.tick - b.tick).map((k) => {
    const i = Math.max(0, Math.min(14, k.fifths + 7));
    return { ticks: k.tick, key: k.mode === 'minor' ? MINOR_KEYS[i] : MAJOR_KEYS[i], scale: k.mode };
  });
  midi.header.fromJSON({
    name: score.meta.title ?? '',
    tempos: tempos.length ? tempos : [{ ticks: 0, bpm: 120 }],
    timeSignatures: sigs.length ? sigs : [{ ticks: 0, timeSignature: [4, 4] }],
    keySignatures: keys,
    meta: [],
    ppq,
  } as unknown as Parameters<typeof midi.header.fromJSON>[0]);

  const gt = guitarTrack(score);
  let channel = 0;
  for (const tr of score.tracks) {
    const t = midi.addTrack();
    t.name = tr.name;
    if (channel === 9) channel++;
    t.channel = Math.min(channel, 15);
    channel++;
    t.instrument.number = tr === gt && !isGuitarProgram(tr.program) ? 25 : tr.program;
    const emitted: { pitch: number; start: number; end: number; ref: { durationTicks: number } }[] = [];
    const sorted = [...tr.notes].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
    for (const n of sorted) {
      if (n.tiedFromPrevious) {
        let prev: (typeof emitted)[number] | undefined;
        for (let i = emitted.length - 1; i >= 0; i--) {
          if (emitted[i].pitch === n.pitch && emitted[i].end >= n.start - 1 && emitted[i].end <= n.start + 1) { prev = emitted[i]; break; }
        }
        if (prev) {
          prev.end = n.start + n.duration;
          prev.ref.durationTicks = prev.end - prev.start;
          continue;
        }
      }
      const ref = { midi: n.pitch, ticks: n.start, durationTicks: Math.max(1, n.duration), velocity: (n.velocity + 0.5) / 127 };
      t.addNote(ref);
      // addNote copies; fetch the stored note to allow merging later
      const stored = t.notes[t.notes.length - 1] as unknown as { durationTicks: number };
      emitted.push({ pitch: n.pitch, start: n.start, end: n.start + Math.max(1, n.duration), ref: stored });
    }
  }
  const bytes = midi.toArray();
  // @tonejs/midi writes the key-signature byte as (index in key list + 7) instead of the
  // sharps/flats count, so patch each FF 59 02 sf mi meta event with the true value.
  const fifths = [...score.keySignatures].sort((a, b) => a.tick - b.tick).map((k) => Math.max(-7, Math.min(7, k.fifths)));
  let k = 0;
  for (let i = 0; i + 4 < bytes.length && k < fifths.length; i++) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0x59 && bytes[i + 2] === 0x02) {
      bytes[i + 3] = fifths[k++] & 0xff;
      i += 4;
    }
  }
  return bytes;
}
