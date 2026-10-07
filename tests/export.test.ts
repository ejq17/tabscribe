import { describe, it, expect } from 'vitest';
import { Midi } from '@tonejs/midi';
import { createEmptyScore, newNoteId, DEFAULT_GUITAR } from '../src/core';
import type { Score, Note } from '../src/core';
import { assignTab } from '../src/tab';
import { exportMidi, exportMusicXml } from '../src/export';

const PPQ = 480;
function nt(pitch: number, start: number, duration: number, extra: Partial<Note> = {}): Note {
  return { id: newNoteId(), pitch, start, duration, velocity: 90, voice: 0, ...extra };
}
function mkScore(): Score {
  const s = createEmptyScore({ title: 'A & B <test>', composer: 'Me' });
  s.tempos = [{ tick: 0, bpm: 100 }, { tick: PPQ * 4, bpm: 140 }];
  s.timeSignatures = [{ tick: 0, numerator: 3, denominator: 4 }];
  s.keySignatures = [{ tick: 0, fifths: 1, mode: 'major' }];
  s.tracks.push({ id: 'g', name: 'Guitar', program: 0, isGuitarTarget: true, notes: [
    nt(64, 0, PPQ), nt(67, PPQ, PPQ), nt(71, PPQ * 2, PPQ), nt(40, PPQ * 3, PPQ * 2), nt(52, PPQ * 3, PPQ * 2), nt(66, PPQ * 5, PPQ / 2), nt(67, PPQ * 5.5, PPQ / 2),
  ] });
  s.tracks.push({ id: 'b', name: 'Bass', program: 33, notes: [nt(36, 0, PPQ * 2, { velocity: 60 })] });
  return s;
}

describe('exportMidi', () => {
  it('round-trips notes, tempos, signatures and programs', () => {
    const s = mkScore();
    const bytes = exportMidi(s);
    expect(bytes).toBeInstanceOf(Uint8Array);
    const m = new Midi(bytes);
    expect(m.header.ppq).toBe(PPQ);
    expect(m.tracks.length).toBe(2);
    expect(m.tracks[0].notes.length).toBe(7);
    expect(m.tracks[0].notes.map((n) => n.midi)).toEqual(s.tracks[0].notes.map((n) => n.pitch));
    expect(m.tracks[0].notes[0].ticks).toBe(0);
    expect(m.tracks[0].notes[3].durationTicks).toBe(PPQ * 2);
    expect(m.tracks[1].notes[0].midi).toBe(36);
    expect(m.tracks[0].instrument.number).toBe(25);
    expect(m.tracks[1].instrument.number).toBe(33);
    expect(m.tracks[0].name).toBe('Guitar');
    expect(m.header.tempos.map((t) => Math.round(t.bpm))).toEqual([100, 140]);
    expect(m.header.timeSignatures[0].timeSignature).toEqual([3, 4]);
    expect(m.header.keySignatures[0].key).toBe('G');
    expect(m.tracks[0].notes[0].velocity).toBeCloseTo(90 / 127, 2);
  });
  it('keeps an existing guitar program and merges ties', () => {
    const s = mkScore();
    s.tracks[0].program = 27;
    s.tracks[0].notes.push(nt(64, PPQ * 1, PPQ, { tiedFromPrevious: false }));
    s.tracks[0].notes = [nt(64, 0, PPQ), nt(64, PPQ, PPQ, { tiedFromPrevious: true }), nt(65, PPQ * 2, PPQ)];
    const m = new Midi(exportMidi(s));
    expect(m.tracks[0].instrument.number).toBe(27);
    expect(m.tracks[0].notes.length).toBe(2);
    expect(m.tracks[0].notes[0].durationTicks).toBe(PPQ * 2);
  });
});

describe('exportMusicXml', () => {
  const s = assignTab(mkScore(), DEFAULT_GUITAR);
  const xml = exportMusicXml(s, DEFAULT_GUITAR);
  it('is well-formed partwise MusicXML', () => {
    expect(xml).toContain('<score-partwise');
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    expect(doc.getElementsByTagName('parsererror').length).toBe(0);
    expect(doc.getElementsByTagName('part').length).toBe(2);
    expect(doc.getElementsByTagName('divisions')[0].textContent).toBe(String(PPQ));
    expect(doc.getElementsByTagName('work-title')[0].textContent).toBe('A & B <test>');
  });
  it('contains string/fret technical data and staff details', () => {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const part = doc.getElementsByTagName('part')[0];
    const notes = Array.from(part.getElementsByTagName('note')).filter((n) => n.getElementsByTagName('pitch').length);
    const first = notes[0];
    // E4 -> string 0 (high e) fret 0 -> xml string 1
    expect(first.getElementsByTagName('string')[0].textContent).toBe('1');
    expect(first.getElementsByTagName('fret')[0].textContent).toBe('0');
    expect(first.getElementsByTagName('step')[0].textContent).toBe('E');
    const tuning = doc.getElementsByTagName('staff-tuning');
    expect(tuning.length).toBe(6);
    expect(tuning[0].getAttribute('line')).toBe('1');
    expect(tuning[0].getElementsByTagName('tuning-step')[0].textContent).toBe('E');
    expect(tuning[0].getElementsByTagName('tuning-octave')[0].textContent).toBe('2');
    expect(doc.getElementsByTagName('clef-octave-change')[0].textContent).toBe('-1');
    // F# in G major
    const alters = Array.from(doc.getElementsByTagName('alter')).map((a) => a.textContent);
    expect(alters).toContain('1');
  });
  it('has chords, time, key, tempo and fills measures', () => {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    expect(doc.getElementsByTagName('chord').length).toBe(1);
    expect(doc.getElementsByTagName('beats')[0].textContent).toBe('3');
    expect(doc.getElementsByTagName('fifths')[0].textContent).toBe('1');
    expect(doc.getElementsByTagName('sound')[0].getAttribute('tempo')).toBe('100');
    // every measure of every voice sums to 3 * PPQ
    for (const meas of Array.from(doc.getElementsByTagName('part')[0].getElementsByTagName('measure'))) {
      let sum = 0;
      for (const el of Array.from(meas.children)) {
        if (el.tagName === 'note' && !el.getElementsByTagName('chord').length) sum += Number(el.getElementsByTagName('duration')[0].textContent);
        if (el.tagName === 'backup') sum -= Number(el.getElementsByTagName('duration')[0].textContent);
      }
      expect(sum).toBe(PPQ * 3);
    }
  });
  it('splits notes across barlines with ties and writes hammer-ons', () => {
    const sc = createEmptyScore();
    sc.tracks.push({ id: 'g', name: 'G', program: 25, isGuitarTarget: true, notes: [nt(64, PPQ * 3, PPQ * 2, { articulations: ['hammer'] }), nt(66, PPQ * 5, PPQ)] });
    const out = exportMusicXml(assignTab(sc, DEFAULT_GUITAR), DEFAULT_GUITAR);
    const doc = new DOMParser().parseFromString(out, 'application/xml');
    expect(doc.getElementsByTagName('parsererror').length).toBe(0);
    expect(doc.getElementsByTagName('tie').length).toBe(2);
    expect(doc.getElementsByTagName('hammer-on').length).toBeGreaterThan(0);
  });
});
