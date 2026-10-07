import { describe, expect, it } from 'vitest';
import { Midi } from '@tonejs/midi';
import { zipSync, strToU8 } from 'fflate';
import {
  importAbc,
  importFile,
  importGuitarPro,
  importMidi,
  importMusicXml,
  decompressBcfz,
  readBcfs,
  parseGpif,
} from '../src/importers';

// ---------------------------------------------------------------- MIDI
describe('importMidi', () => {
  it('round-trips tracks, tempo, meter, key and notes', () => {
    const midi = new Midi();
    midi.header.name = 'My Song';
    midi.header.setTempo(100);
    midi.header.timeSignatures.push({ ticks: 0, timeSignature: [3, 4] });
    const gtr = midi.addTrack();
    gtr.name = 'Gtr';
    gtr.instrument.number = 25;
    gtr.addNote({ midi: 64, ticks: 0, durationTicks: 480, velocity: 0.5 });
    gtr.addNote({ midi: 67, ticks: 480, durationTicks: 240 });
    const piano = midi.addTrack();
    piano.addNote({ midi: 60, ticks: 0, durationTicks: 480 });
    piano.addNote({ midi: 62, ticks: 480, durationTicks: 480 });
    piano.addNote({ midi: 64, ticks: 960, durationTicks: 480 });
    midi.addTrack(); // empty, must be skipped
    const drums = midi.addTrack();
    drums.channel = 9;
    for (let i = 0; i < 6; i++) drums.addNote({ midi: 36, ticks: i * 240, durationTicks: 120 });

    const bytes = midi.toArray();
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const score = importMidi(ab);
    expect(score.meta.source).toBe('midi');
    expect(score.ppq).toBe(480);
    expect(score.tracks.length).toBe(3);
    expect(score.tempos[0].bpm).toBeCloseTo(100, 0);
    expect(score.timeSignatures[0]).toMatchObject({ numerator: 3, denominator: 4 });
    expect(score.keySignatures[0]).toMatchObject({ fifths: 0, mode: 'major' });
    const g = score.tracks.find((t) => t.name === 'Gtr')!;
    expect(g.program).toBe(25);
    expect(g.notes.map((n) => [n.pitch, n.start, n.duration])).toEqual([[64, 0, 480], [67, 480, 240]]);
    expect(g.notes[0].velocity).toBeGreaterThan(55);
    expect(g.notes[0].velocity).toBeLessThan(72);
    expect(g.isGuitarTarget).toBe(true);
    expect(score.tracks.filter((t) => t.isGuitarTarget).length).toBe(1);
  });

  it('rescales ppq to 480, reads key signatures and picks the busiest non-drum track', () => {
    const be16 = (v: number) => [(v >> 8) & 0xff, v & 0xff];
    const be32 = (v: number) => [(v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
    const track = (events: number[]) => [0x4d, 0x54, 0x72, 0x6b, ...be32(events.length + 4), ...events, 0x00, 0xff, 0x2f, 0x00];
    // track 1: key sig A minor-ish (3 flats, minor) + one note; track 2: two notes
    const t1 = track([0x00, 0xff, 0x59, 0x02, 0xfd, 0x01, 0x00, 0x90, 60, 80, 96, 0x80, 60, 0]);
    const t2 = track([0x00, 0x90, 62, 80, 96, 0x80, 62, 0, 0x00, 0x90, 64, 80, 48, 0x80, 64, 0]);
    const file = new Uint8Array([0x4d, 0x54, 0x68, 0x64, ...be32(6), ...be16(1), ...be16(2), ...be16(96), ...t1, ...t2]);
    const score = importMidi(file.buffer);
    expect(score.keySignatures[0]).toMatchObject({ fifths: -3, mode: 'minor' });
    expect(score.tracks.length).toBe(2);
    expect(score.tracks[0].notes.map((n) => [n.start, n.duration])).toEqual([[0, 480]]);
    expect(score.tracks[1].notes.map((n) => [n.start, n.duration])).toEqual([[0, 480], [480, 240]]);
    expect(score.tracks[1].isGuitarTarget).toBe(true);
    expect(score.tracks[0].isGuitarTarget).toBeFalsy();
  });
});

// ---------------------------------------------------------------- MusicXML
const XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <work><work-title>Test Piece</work-title></work>
  <identification><creator type="composer">J. Doe</creator></identification>
  <part-list><score-part id="P1"><part-name>Guitar</part-name>
    <midi-instrument id="I1"><midi-program>26</midi-program></midi-instrument></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>2</divisions><key><fifths>1</fifths><mode>major</mode></key>
        <time><beats>3</beats><beat-type>4</beat-type></time></attributes>
      <direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>90</per-minute></metronome></direction-type></direction>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice></note>
      <note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice></note>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>2</duration><tie type="start"/><voice>1</voice>
        <notations><tied type="start"/><technical><string>2</string><fret>8</fret></technical></notations></note>
      <note><rest/><duration>2</duration><voice>1</voice></note>
      <backup><duration>6</duration></backup>
      <note><pitch><step>A</step><octave>3</octave></pitch><duration>6</duration><voice>2</voice></note>
    </measure>
    <measure number="2">
      <note><pitch><step>F</step><alter>1</alter><octave>4</octave></pitch><duration>2</duration><voice>1</voice></note>
      <note><grace/><pitch><step>A</step><octave>4</octave></pitch><voice>1</voice></note>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><tie type="stop"/><voice>1</voice>
        <notations><tied type="stop"/></notations></note>
    </measure>
  </part>
</score-partwise>`;

describe('importMusicXml', () => {
  it('parses a partwise score', () => {
    const s = importMusicXml(XML);
    expect(s.meta.title).toBe('Test Piece');
    expect(s.meta.composer).toBe('J. Doe');
    expect(s.meta.source).toBe('musicxml');
    expect(s.keySignatures[0]).toMatchObject({ fifths: 1, mode: 'major' });
    expect(s.timeSignatures[0]).toMatchObject({ numerator: 3, denominator: 4 });
    expect(s.tempos[0].bpm).toBe(90);
    expect(s.tracks.length).toBe(1);
    const t = s.tracks[0];
    expect(t.name).toBe('Guitar');
    expect(t.program).toBe(25);
    expect(t.isGuitarTarget).toBe(true);
    const at0 = t.notes.filter((n) => n.start === 0 && n.voice === 0).map((n) => n.pitch).sort();
    expect(at0).toEqual([60, 64]);
    const g = t.notes.find((n) => n.pitch === 67 && n.start === 480)!;
    expect(g.duration).toBe(480);
    expect(g.tab).toEqual({ string: 1, fret: 8 });
    expect(g.tabLocked).toBe(true);
    const a3 = t.notes.find((n) => n.pitch === 57)!;
    expect(a3.voice).toBe(1);
    expect(a3.start).toBe(0);
    expect(a3.duration).toBe(1440);
    // measure 2 starts at 1440 (3/4 of 480 ppq)
    const fs = t.notes.find((n) => n.pitch === 66)!;
    expect(fs.start).toBe(1440);
    const tied = t.notes.find((n) => n.pitch === 67 && n.start === 1440 + 480)!;
    expect(tied.tiedFromPrevious).toBe(true);
    expect(tied.duration).toBe(960);
    expect(t.notes.find((n) => n.pitch === 69)).toBeUndefined(); // grace skipped
    expect(s.meta.warnings?.some((w) => /Grace/.test(w))).toBe(true);
  });

  it('reads compressed .mxl', () => {
    const container = `<?xml version="1.0"?><container><rootfiles><rootfile full-path="score/main.xml"/></rootfiles></container>`;
    const zip = zipSync({ 'META-INF/container.xml': strToU8(container), 'score/main.xml': strToU8(XML) });
    const s = importMusicXml(zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer);
    expect(s.tracks[0].notes.length).toBeGreaterThan(3);
  });

  it('converts score-timewise', () => {
    const tw = `<score-timewise><part-list><score-part id="P1"><part-name>X</part-name></score-part></part-list>
      <measure number="1"><part id="P1"><attributes><divisions>1</divisions></attributes>
        <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration></note></part></measure>
      <measure number="2"><part id="P1"><note><pitch><step>D</step><octave>4</octave></pitch><duration>4</duration></note></part></measure>
    </score-timewise>`;
    const s = importMusicXml(tw);
    expect(s.tracks[0].notes.map((n) => [n.pitch, n.start])).toEqual([[60, 0], [62, 1920]]);
  });

  it('rejects non-MusicXML', () => {
    expect(() => importMusicXml('<foo/>')).toThrow();
  });
});

// ---------------------------------------------------------------- ABC
describe('importAbc', () => {
  it('parses the basic example', () => {
    const s = importAbc('X:1\nT:Test\nM:4/4\nL:1/8\nK:G\nGABc d2 |[CEG]2 z2 |\n');
    expect(s.meta.title).toBe('Test');
    expect(s.meta.source).toBe('abc');
    expect(s.keySignatures[0]).toMatchObject({ fifths: 1, mode: 'major' });
    expect(s.timeSignatures[0]).toMatchObject({ numerator: 4, denominator: 4 });
    const n = s.tracks[0].notes;
    expect(n.slice(0, 5).map((x) => [x.pitch, x.start, x.duration])).toEqual([
      [67, 0, 240], [69, 240, 240], [71, 480, 240], [72, 720, 240], [74, 960, 480],
    ]);
    const chord = n.filter((x) => x.start === 1440).map((x) => x.pitch).sort();
    expect(chord).toEqual([60, 64, 67]);
    expect(n.every((x) => x.start !== 1920 )).toBe(true); // rest produces no note
  });

  it('applies key signature and bar-scoped accidentals', () => {
    const s = importAbc('X:1\nM:4/4\nL:1/4\nK:G\nF ^F =F F | F\n');
    expect(s.tracks[0].notes.map((n) => n.pitch)).toEqual([66, 66, 65, 65, 66]);
  });

  it('handles flats, minor keys, octaves, ties, broken rhythm and tuplets', () => {
    const s = importAbc('X:1\nL:1/8\nM:4/4\nQ:1/4=100\nK:Dm\nB,c\'-c\' C>D (3EFG|\n');
    expect(s.keySignatures[0]).toMatchObject({ fifths: -1, mode: 'minor' });
    expect(s.tempos[0].bpm).toBe(100);
    const n = s.tracks[0].notes;
    expect(n[0].pitch).toBe(58); // B, flat in key of Dm
    expect(n[1].pitch).toBe(84); // c'
    expect(n[2].pitch).toBe(84);
    expect(n[2].tiedFromPrevious).toBe(true);
    expect(n[3].duration).toBe(360); // C>
    expect(n[4].duration).toBe(120); // D
    expect(n[5].duration).toBe(160); // triplet eighth
    expect(n[7].start + n[7].duration).toBe(n[5].start + 480);
  });

  it('supports multiple voices as tracks', () => {
    const s = importAbc('X:1\nM:4/4\nL:1/4\nK:C\nV:1\nCDEF|\nV:2\nC,D,E,F,|\n');
    expect(s.tracks.length).toBe(2);
    expect(s.tracks[1].notes[0].pitch).toBe(48);
  });
});

// ---------------------------------------------------------------- GP5 (synthetic)
class W {
  out: number[] = [];
  u8(v: number) { this.out.push(v & 0xff); return this; }
  i16(v: number) { return this.u8(v).u8(v >> 8); }
  i32(v: number) { return this.u8(v).u8(v >> 8).u8(v >> 16).u8(v >> 24); }
  zeros(n: number) { for (let i = 0; i < n; i++) this.u8(0); return this; }
  byteSize(s: string, size: number) {
    this.u8(s.length);
    for (let i = 0; i < size; i++) this.u8(i < s.length ? s.charCodeAt(i) : 0);
    return this;
  }
  intByte(s: string) { this.i32(s.length + 1).u8(s.length); for (const c of s) this.u8(c.charCodeAt(0)); return this; }
}

function buildGp5(): ArrayBuffer {
  const w = new W();
  w.byteSize('FICHIER GUITAR PRO v5.10', 30);
  for (const s of ['My Tune', '', 'Artist', '', 'Lyricist', 'Composer', '', '', '']) w.intByte(s);
  w.i32(0); // notices
  w.i32(0); for (let i = 0; i < 5; i++) w.i32(0).i32(0); // lyrics
  w.zeros(19); // rse master
  w.zeros(30); for (let i = 0; i < 10; i++) w.intByte(''); // page setup
  w.intByte(''); // tempo name
  w.i32(132); w.u8(0); // tempo, hide
  w.u8(0).zeros(4); // key + octave
  for (let i = 0; i < 64; i++) { w.i32(i === 0 ? 25 : 0).zeros(8); }
  w.zeros(38).i32(0); // directions, reverb
  w.i32(1).i32(1); // measures, tracks
  // measure header (flags: numerator + denominator)
  w.u8(0x03).u8(4).u8(4).zeros(4).u8(0).u8(0);
  // track
  w.u8(0); // blank
  w.u8(0); // flags
  w.byteSize('Lead', 40);
  w.i32(6);
  for (const p of [64, 59, 55, 50, 45, 40, 0]) w.i32(p);
  w.i32(1).i32(1).i32(2).i32(24).i32(0); // port, channel, effect channel, frets, capo
  w.zeros(4); // color
  w.i16(0).u8(0).u8(0); // flags2, auto accent, bank
  w.u8(0).zeros(24).zeros(12).i32(0).zeros(4).intByte('').intByte(''); // rse
  w.u8(0); // after tracks
  // measure: voice 0 with two beats, voice 1 empty
  w.i32(2);
  const beat = (stringIdx: number, fret: number) => {
    w.u8(0).u8(0); // beat flags, duration = quarter
    w.u8(1 << (6 - stringIdx));
    w.u8(0x20).u8(1).u8(fret).u8(0); // note flags, type normal, fret, flags2
    w.i16(0); // beat flags2
  };
  beat(0, 1);
  beat(5, 3);
  w.i32(0); // voice 1
  w.u8(0); // line break
  return new Uint8Array(w.out).buffer;
}

describe('Guitar Pro 5', () => {
  it('reads a synthetic GP5 file', () => {
    const s = importGuitarPro(buildGp5(), 'x.gp5');
    expect(s.meta.source).toBe('guitarpro');
    expect(s.meta.title).toBe('My Tune');
    expect(s.tempos[0].bpm).toBe(132);
    expect(s.timeSignatures[0]).toMatchObject({ numerator: 4, denominator: 4 });
    expect(s.tracks.length).toBe(1);
    const t = s.tracks[0];
    expect(t.isGuitarTarget).toBe(true);
    expect(t.program).toBe(25);
    expect(t.notes.map((n) => [n.pitch, n.start, n.duration, n.tab!.string, n.tab!.fret, n.tabLocked])).toEqual([
      [65, 0, 480, 0, 1, true],
      [43, 480, 480, 5, 3, true],
    ]);
  });

  it('rejects garbage', () => {
    expect(() => importGuitarPro(new Uint8Array([1, 2, 3, 4, 5, 6]).buffer, 'a.gp5')).toThrow();
  });
});

// ---------------------------------------------------------------- GPX / GP7
class Bits {
  bytes: number[] = [];
  private cur = 0;
  private n = 0;
  bit(b: number) {
    this.cur = (this.cur << 1) | (b & 1);
    if (++this.n === 8) { this.bytes.push(this.cur); this.cur = 0; this.n = 0; }
  }
  msb(v: number, count: number) { for (let i = count - 1; i >= 0; i--) this.bit((v >> i) & 1); }
  lsb(v: number, count: number) { for (let i = 0; i < count; i++) this.bit((v >> i) & 1); }
  done(): number[] { while (this.n !== 0) this.bit(0); return this.bytes; }
}

function bcfz(payload: Uint8Array, backref?: { at: number; offset: number; size: number }): Uint8Array {
  // literal-only encoding (3 bytes per chunk); optionally a back-reference replaces nothing: caller builds payload accordingly
  const b = new Bits();
  let i = 0;
  while (i < payload.length) {
    if (backref && i === backref.at) {
      b.msb(1, 1);
      b.msb(8, 4);
      b.lsb(backref.offset, 8);
      b.lsb(backref.size, 8);
      i += backref.size;
      continue;
    }
    const limit = backref && backref.at > i ? backref.at - i : payload.length - i;
    const len = Math.min(3, limit);
    b.msb(0, 1);
    b.lsb(len, 2);
    for (let k = 0; k < len; k++) b.msb(payload[i + k], 8);
    i += len;
  }
  const body = b.done();
  const out = new Uint8Array(8 + body.length);
  out.set([0x42, 0x43, 0x46, 0x5a]);
  new DataView(out.buffer).setInt32(4, payload.length, true);
  out.set(body, 8);
  return out;
}

const GPIF = `<?xml version="1.0"?><GPIF>
<Score><Title>GPX Song</Title><Music>Someone</Music></Score>
<MasterTrack><Tracks>0</Tracks><Automations><Automation><Type>Tempo</Type><Bar>0</Bar><Position>0</Position><Value>96 2</Value></Automation></Automations></MasterTrack>
<Tracks><Track id="0"><Name>Guitar</Name><GeneralMidi><Program>25</Program></GeneralMidi>
  <Properties><Property name="Tuning"><Pitches>40 45 50 55 59 64</Pitches></Property></Properties></Track></Tracks>
<MasterBars><MasterBar><Key><AccidentalCount>1</AccidentalCount><Mode>Major</Mode></Key><Time>3/4</Time><Bars>0</Bars></MasterBar>
<MasterBar><Time>3/4</Time><Bars>1</Bars></MasterBar></MasterBars>
<Bars><Bar id="0"><Voices>0 -1 -1 -1</Voices></Bar><Bar id="1"><Voices>1 -1 -1 -1</Voices></Bar></Bars>
<Voices><Voice id="0"><Beats>0 1 2</Beats></Voice><Voice id="1"><Beats>3</Beats></Voice></Voices>
<Beats>
 <Beat id="0"><Rhythm ref="0"/><Notes>0 1</Notes></Beat>
 <Beat id="1"><Rhythm ref="1"/></Beat>
 <Beat id="2"><Rhythm ref="2"/><Notes>2</Notes></Beat>
 <Beat id="3"><Rhythm ref="3"/><Notes>3</Notes></Beat>
</Beats>
<Notes>
 <Note id="0"><Properties><Property name="String"><String>5</String></Property><Property name="Fret"><Fret>3</Fret></Property></Properties></Note>
 <Note id="1"><Properties><Property name="String"><String>0</String></Property><Property name="Fret"><Fret>2</Fret></Property></Properties></Note>
 <Note id="2"><Tie origin="true" destination="false"/><Properties><Property name="String"><String>3</String></Property><Property name="Fret"><Fret>0</Fret></Property></Properties></Note>
 <Note id="3"><Tie origin="false" destination="true"/><Properties><Property name="String"><String>3</String></Property><Property name="Fret"><Fret>0</Fret></Property></Properties></Note>
</Notes>
<Rhythms>
 <Rhythm id="0"><NoteValue>Quarter</NoteValue></Rhythm>
 <Rhythm id="1"><NoteValue>Eighth</NoteValue></Rhythm>
 <Rhythm id="2"><NoteValue>Eighth</NoteValue><AugmentationDot count="1"/></Rhythm>
 <Rhythm id="3"><NoteValue>Half</NoteValue><PrimaryTuplet num="3" den="2"/></Rhythm>
</Rhythms></GPIF>`;

function checkGpif(s: ReturnType<typeof parseGpif>) {
  expect(s.meta.title).toBe('GPX Song');
  expect(s.tempos[0].bpm).toBe(96);
  expect(s.timeSignatures[0]).toMatchObject({ numerator: 3, denominator: 4 });
  expect(s.keySignatures[0]).toMatchObject({ fifths: 1 });
  const t = s.tracks[0];
  expect(t.isGuitarTarget).toBe(true);
  const [a, b, c, d] = t.notes;
  // beat 0: two notes at tick 0, sorted by pitch descending: high e fret 3 = 67, low E fret 2 = 42
  expect([a.pitch, a.tab]).toEqual([67, { string: 0, fret: 3 }]);
  expect([b.pitch, b.tab]).toEqual([42, { string: 5, fret: 2 }]);
  expect(a.duration).toBe(480);
  // beat 2 (after an eighth rest): start 480 + 240 = 720, dotted eighth = 360, G string (gp string 3 -> ours 2)
  expect(c.start).toBe(720);
  expect(c.duration).toBe(360);
  expect(c.pitch).toBe(55);
  expect(c.tab).toEqual({ string: 2, fret: 0 });
  // second bar starts at 1440, tuplet half (960 * 2/3 = 640), tied
  expect(d.start).toBe(1440);
  expect(d.duration).toBe(640);
  expect(d.tiedFromPrevious).toBe(true);
  expect(t.notes.every((n) => n.tabLocked)).toBe(true);
}

describe('Guitar Pro GPX / GP7', () => {
  it('decompresses BCFZ literal and back-reference streams', () => {
    const payload = strToU8('abcabcabcXYZ');
    // "abc" literal, then back-reference (offset 3, size 3) x2 via a single copy of size 3 at pos 3, then rest literal
    const lit = bcfz(payload);
    expect(new TextDecoder().decode(decompressBcfz(lit))).toBe('abcabcabcXYZ');
    const withRef = bcfz(payload, { at: 3, offset: 3, size: 3 });
    expect(new TextDecoder().decode(decompressBcfz(withRef))).toBe('abcabcabcXYZ');
    // mixed: ref covering bytes 6..8 offset 6 size 3
    const withRef2 = bcfz(payload, { at: 6, offset: 6, size: 3 });
    expect(new TextDecoder().decode(decompressBcfz(withRef2))).toBe('abcabcabcXYZ');
  });

  it('reads files from a BCFS file system', () => {
    const fs = new Uint8Array(0x1000 * 3);
    fs.set([0x42, 0x43, 0x46, 0x53]);
    const dv = new DataView(fs.buffer);
    const data = strToU8('hello gpif');
    dv.setInt32(0x1000, 2, true);
    fs.set(strToU8('score.gpif'), 0x1000 + 4);
    dv.setInt32(0x1000 + 0x8c, data.length, true);
    dv.setInt32(0x1000 + 0x94, 2, true);
    fs.set(data, 0x2000);
    const files = readBcfs(fs);
    expect(new TextDecoder().decode(files.get('score.gpif')!)).toBe('hello gpif');
  });

  it('parses gpif XML', () => {
    checkGpif(parseGpif(GPIF));
  });

  it('imports a full GPX (BCFZ + BCFS + gpif)', () => {
    const xml = strToU8(GPIF);
    const fs = new Uint8Array(0x1000 * 2 + Math.ceil(xml.length / 0x1000) * 0x1000);
    fs.set([0x42, 0x43, 0x46, 0x53]);
    const dv = new DataView(fs.buffer);
    dv.setInt32(0x1000, 2, true);
    fs.set(strToU8('score.gpif'), 0x1000 + 4);
    dv.setInt32(0x1000 + 0x8c, xml.length, true);
    const blocks = Math.ceil(xml.length / 0x1000);
    for (let i = 0; i < blocks; i++) dv.setInt32(0x1000 + 0x94 + 4 * i, 2 + i, true);
    fs.set(xml, 0x2000);
    const gpx = bcfz(fs);
    checkGpif(importGuitarPro(gpx.buffer.slice(gpx.byteOffset, gpx.byteOffset + gpx.byteLength) as ArrayBuffer, 'x.gpx'));
  });

  it('imports GP7 zip', () => {
    const zip = zipSync({ 'Content/score.gpif': strToU8(GPIF) });
    checkGpif(importGuitarPro(zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer, 'x.gp'));
  });
});

// ---------------------------------------------------------------- dispatcher
describe('importFile', () => {
  it('routes by extension and fills title from filename', async () => {
    const f = new File(['X:1\nM:4/4\nL:1/4\nK:C\nCDEF|\n'], 'My Reel.abc');
    const s = await importFile(f);
    expect(s.meta.source).toBe('abc');
    expect(s.meta.title).toBe('My Reel');
    expect(s.tracks[0].notes.length).toBe(4);
  });

  it('falls back to magic bytes', async () => {
    const f = new File([XML], 'weird.dat');
    const s = await importFile(f);
    expect(s.meta.source).toBe('musicxml');
    expect(s.meta.title).toBe('Test Piece');
  });

  it('rejects unknown files', async () => {
    await expect(importFile(new File(['hello'], 'x.bin'))).rejects.toThrow(/Unsupported/);
  });
});
