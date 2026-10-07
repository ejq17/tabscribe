/**
 * Guitar Pro importers: GP3/GP4/GP5 binary, GPX (GP6, BCFZ/BCFS container + GPIF XML) and GP7 (.gp zip + GPIF).
 * Every note produced here carries `tab` + `tabLocked = true` (except percussion tracks, which have no tab).
 */
import { unzipSync } from 'fflate';
import { DEFAULT_PPQ } from '../core';
import type { KeySignature, Note, Score, Tempo, TimeSignature, Track } from '../core';
import { addWarning, decodeUtf8, makeNote, sortScoreMeta, toBytes } from './util';

// ---------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------

const WHOLE = DEFAULT_PPQ * 4;

const DYNAMIC_VELOCITY: Record<string, number> = {
  PPP: 30, PP: 42, P: 58, MP: 74, MF: 90, F: 104, FF: 118, FFF: 127,
};

function finishScore(score: Score, meta: { targets: { guitar: boolean; perc: boolean; strings: number }[] }): void {
  if (!score.timeSignatures.length || score.timeSignatures[0].tick > 0) score.timeSignatures.unshift({ tick: 0, numerator: 4, denominator: 4 });
  if (!score.keySignatures.length || score.keySignatures[0].tick > 0) score.keySignatures.unshift({ tick: 0, fifths: 0, mode: 'major' });
  if (!score.tempos.length || score.tempos[0].tick > 0) score.tempos.unshift({ tick: 0, bpm: 120 });
  // Target: first guitar program track, else first non-percussion track with >= 6 strings, else first non-percussion.
  const info = meta.targets;
  let idx = score.tracks.findIndex((t, i) => !info[i].perc && t.program >= 24 && t.program <= 31 && info[i].strings <= 8);
  if (idx < 0) idx = score.tracks.findIndex((_, i) => !info[i].perc && info[i].strings >= 6);
  if (idx < 0) idx = score.tracks.findIndex((_, i) => !info[i].perc);
  if (idx >= 0) score.tracks[idx].isGuitarTarget = true;
  sortScoreMeta(score);
}

// ---------------------------------------------------------------------------------------------
// GP3 / GP4 / GP5 binary reader
// ---------------------------------------------------------------------------------------------

class Reader {
  p = 0;
  readonly b: Uint8Array;
  constructor(b: Uint8Array) { this.b = b; }
  private need(n: number) {
    if (this.p + n > this.b.length) throw new Error('Guitar Pro file is truncated or corrupt.');
  }
  u8(): number { this.need(1); return this.b[this.p++]; }
  i8(): number { const v = this.u8(); return v > 127 ? v - 256 : v; }
  bool(): boolean { return this.u8() !== 0; }
  i16(): number { this.need(2); const v = this.b[this.p] | (this.b[this.p + 1] << 8); this.p += 2; return (v << 16) >> 16; }
  i32(): number {
    this.need(4);
    const v = this.b[this.p] | (this.b[this.p + 1] << 8) | (this.b[this.p + 2] << 16) | (this.b[this.p + 3] << 24);
    this.p += 4;
    return v;
  }
  skip(n: number) { this.need(n); this.p += n; }
  private text(n: number): string {
    this.need(n);
    const s = new TextDecoder('windows-1252').decode(this.b.subarray(this.p, this.p + n));
    this.p += n;
    return s;
  }
  /** length byte, then `size` bytes of which the first `len` are the string */
  byteSizeString(size: number): string {
    const len = this.u8();
    const s = this.text(size);
    return s.slice(0, Math.min(len, size));
  }
  intSizeString(): string {
    const n = this.i32();
    if (n < 0 || n > 1 << 24) throw new Error('Guitar Pro file is corrupt (bad string length).');
    return this.text(n);
  }
  intByteSizeString(): string {
    const d = this.i32();
    if (d < 1 || d > 1 << 24) {
      if (d === 0) return '';
      throw new Error('Guitar Pro file is corrupt (bad string length).');
    }
    return this.byteSizeString(d - 1);
  }
}

interface TrackCtx {
  name: string;
  strings: number;
  tuning: number[];
  capo: number;
  perc: boolean;
  program: number;
  notes: Note[];
  lastFret: number[];
}

interface HeaderInfo { start: number; len: number }

export function parseGuitarPro345(data: Uint8Array): Score {
  const r = new Reader(data);
  const versionStr = r.byteSizeString(30);
  const vm = /v(\d+)\.(\d+)/.exec(versionStr);
  if (!/GUITAR PRO/i.test(versionStr) || !vm) throw new Error('Not a Guitar Pro file.');
  const major = parseInt(vm[1], 10);
  const minor = parseInt(vm[2], 10);
  if (major < 3 || major > 5) throw new Error(`Unsupported Guitar Pro version ${vm[1]}.${vm[2]}.`);
  const v4 = major >= 4;
  const v5 = major >= 5;
  const v510 = v5 && minor > 0;

  const score: Score = { ppq: DEFAULT_PPQ, tracks: [], timeSignatures: [], keySignatures: [], tempos: [], meta: { source: 'guitarpro' } };

  // --- info
  const title = r.intByteSizeString();
  r.intByteSizeString(); // subtitle
  const artist = r.intByteSizeString();
  r.intByteSizeString(); // album
  const words = r.intByteSizeString();
  const music = v5 ? r.intByteSizeString() : '';
  r.intByteSizeString(); // copyright
  r.intByteSizeString(); // tabber
  r.intByteSizeString(); // instructions
  const noticeCount = r.i32();
  if (noticeCount < 0 || noticeCount > 10000) throw new Error('Guitar Pro file is corrupt.');
  for (let i = 0; i < noticeCount; i++) r.intByteSizeString();
  if (title) score.meta.title = title;
  const composer = music || words || artist;
  if (composer) score.meta.composer = composer;
  if (artist) score.meta.artist = artist;

  if (!v5) r.bool(); // triplet feel
  if (v4) {
    r.i32(); // lyrics track
    for (let i = 0; i < 5; i++) { r.i32(); r.intSizeString(); }
  }
  if (v5) {
    if (v510) r.skip(19); // RSE master effect
    // page setup
    r.skip(28 + 2);
    for (let i = 0; i < 10; i++) r.intByteSizeString();
    r.intByteSizeString(); // tempo name
  }
  const songTempo = r.i32();
  if (v510) r.bool(); // hide tempo
  let songKey: number;
  if (v5) { songKey = r.i8(); r.skip(4); }
  else if (v4) { songKey = r.i8(); r.skip(3); r.skip(1); }
  else { songKey = r.i8(); r.skip(3); }
  // midi channels
  const channelPrograms: number[] = [];
  for (let i = 0; i < 64; i++) {
    const instr = r.i32();
    r.skip(8);
    channelPrograms.push(instr);
  }
  if (v5) { r.skip(19 * 2); r.i32(); } // directions + master reverb
  const measureCount = r.i32();
  const trackCount = r.i32();
  if (measureCount < 0 || measureCount > 100000 || trackCount < 0 || trackCount > 256) throw new Error('Guitar Pro file is corrupt.');

  score.tempos.push({ tick: 0, bpm: songTempo > 0 ? songTempo : 120 });
  if (songKey >= -7 && songKey <= 7) score.keySignatures.push({ tick: 0, fifths: songKey, mode: 'major' });

  // --- measure headers
  const headers: HeaderInfo[] = [];
  let num = 4;
  let den = 4;
  let tick = 0;
  let sawRepeat = false;
  let lastKey: KeySignature | undefined;
  for (let m = 0; m < measureCount; m++) {
    if (v5 && m > 0) r.skip(1);
    const flags = r.u8();
    if (flags & 0x01) num = r.i8();
    if (flags & 0x02) den = r.i8();
    if (flags & 0x04) sawRepeat = true;
    if (flags & 0x08) { r.i8(); sawRepeat = true; }
    if (!v5 && flags & 0x10) r.u8();
    let keyHere: KeySignature | undefined;
    if (flags & 0x20) { r.intByteSizeString(); r.skip(4); }
    if (flags & 0x40) {
      const fifths = r.i8();
      const minorKey = r.i8() === 1;
      keyHere = { tick, fifths: Math.max(-7, Math.min(7, fifths)), mode: minorKey ? 'minor' : 'major' };
    }
    if (v5) {
      if (flags & 0x10) r.u8();
      if (flags & 0x03) r.skip(4);
      if (!(flags & 0x10)) r.skip(1);
      r.u8(); // triplet feel
    }
    if (num <= 0 || den <= 0) { num = 4; den = 4; }
    const len = (WHOLE * num) / den;
    const prev = score.timeSignatures[score.timeSignatures.length - 1];
    if (!prev || prev.numerator !== num || prev.denominator !== den) {
      const ts: TimeSignature = { tick, numerator: num, denominator: den };
      score.timeSignatures.push(ts);
    }
    if (keyHere) {
      const pk = lastKey ?? score.keySignatures[score.keySignatures.length - 1];
      if (m === 0) {
        score.keySignatures = [keyHere];
      } else if (!pk || pk.fifths !== keyHere.fifths || pk.mode !== keyHere.mode) score.keySignatures.push(keyHere);
      lastKey = keyHere;
    }
    headers.push({ start: tick, len });
    tick += len;
  }

  // --- tracks
  const ctxs: TrackCtx[] = [];
  for (let t = 0; t < trackCount; t++) {
    if (v5 && (t === 0 || (major === 5 && minor === 0))) r.skip(1);
    const flags = r.u8();
    const name = r.byteSizeString(40);
    const stringCount = r.i32();
    const tuning: number[] = [];
    for (let i = 0; i < 7; i++) tuning.push(r.i32());
    const port = r.i32();
    const chan = r.i32();
    r.i32(); // effect channel
    r.i32(); // fret count
    const capo = r.i32();
    r.skip(4); // color
    if (v5) {
      r.i16(); // flags2
      r.u8(); // auto accentuation
      r.u8(); // midi bank
      r.u8(); // humanize
      r.skip(12 + 12);
      r.skip(12); // rse instrument
      if (major === 5 && minor === 0) { r.i16(); r.skip(1); } else r.i32();
      if (v510) {
        r.skip(4); // equalizer
        r.intByteSizeString();
        r.intByteSizeString();
      }
    }
    if (stringCount < 0 || stringCount > 7) throw new Error('Guitar Pro file is corrupt (string count).');
    const chIdx = (port - 1) * 16 + (chan - 1);
    const program = chIdx >= 0 && chIdx < 64 ? channelPrograms[chIdx] : 0;
    const perc = !!(flags & 0x01) || chan === 10 || (chIdx >= 0 && chIdx % 16 === 9);
    ctxs.push({
      name: name || `Track ${t + 1}`,
      strings: stringCount,
      tuning: tuning.slice(0, stringCount),
      capo: Math.max(0, capo),
      perc,
      program: Math.max(0, Math.min(127, program)),
      notes: [],
      lastFret: new Array(8).fill(0),
    });
  }
  if (v5) r.skip(major === 5 && minor === 0 ? 2 : 1);

  // --- measures
  const tempoEvents: Tempo[] = [];

  const readDuration = (flags: number): number => {
    const value = r.i8();
    const dotted = (flags & 0x01) !== 0;
    let ticks = WHOLE / Math.pow(2, value + 2);
    if (dotted) ticks *= 1.5;
    if (flags & 0x20) {
      const tup = r.i32();
      const times: Record<number, number> = { 3: 2, 5: 4, 6: 4, 7: 4, 9: 8, 10: 8, 11: 8, 12: 8, 13: 8 };
      if (times[tup]) ticks = (ticks * times[tup]) / tup;
    }
    return ticks;
  };

  const readBend = () => {
    r.u8();
    r.i32();
    const n = r.i32();
    if (n < 0 || n > 1000) throw new Error('Guitar Pro file is corrupt (bend).');
    for (let i = 0; i < n; i++) { r.i32(); r.i32(); r.u8(); }
  };

  const readBeatEffects = (): Set<string> => {
    const arts = new Set<string>();
    if (!v4) {
      const f = r.u8();
      if (f & 0x20) { r.u8(); r.i32(); }
      if (f & 0x40) r.skip(2);
      if (f & 0x04 || f & 0x08) arts.add('harmonic');
      return arts;
    }
    const f1 = r.u8();
    const f2 = r.u8();
    if (f1 & 0x20) r.u8();
    if (f2 & 0x04) readBend();
    if (f1 & 0x40) r.skip(2);
    if (f2 & 0x02) r.u8();
    return arts;
  };

  const readNoteEffects = (): Set<string> => {
    const arts = new Set<string>();
    if (!v4) {
      const f = r.u8();
      if (f & 0x01) { readBend(); arts.add('bend'); }
      if (f & 0x02) arts.add('hammer');
      if (f & 0x04) arts.add('slide');
      if (f & 0x10) r.skip(4);
      return arts;
    }
    const f1 = r.u8();
    const f2 = r.u8();
    if (f1 & 0x01) { readBend(); arts.add('bend'); }
    if (f1 & 0x02) arts.add('hammer');
    if (f1 & 0x10) r.skip(v5 ? 5 : 4);
    if (f2 & 0x01) arts.add('staccato');
    if (f2 & 0x02) arts.add('palm-mute');
    if (f2 & 0x04) r.u8();
    if (f2 & 0x08) { r.u8(); arts.add('slide'); }
    if (f2 & 0x10) {
      const type = r.i8();
      arts.add('harmonic');
      if (v5) { if (type === 2) r.skip(3); else if (type === 3) r.skip(1); }
    }
    if (f2 & 0x20) r.skip(2);
    return arts;
  };

  const readMix = (): number => {
    r.i8(); // instrument
    if (v5) { r.skip(12); if (major === 5 && minor === 0) { r.i16(); r.skip(1); } else r.i32(); }
    const vol = r.i8(), bal = r.i8(), cho = r.i8(), rev = r.i8(), pha = r.i8(), tre = r.i8();
    if (v5) r.intByteSizeString();
    const tempo = r.i32();
    for (const v of [vol, bal, cho, rev, pha, tre]) if (v >= 0) r.u8();
    if (tempo >= 0) { r.u8(); if (v510) r.u8(); }
    if (v4) r.u8();
    if (v5) { r.i8(); if (v510) { r.intByteSizeString(); r.intByteSizeString(); } }
    return tempo;
  };

  const readChord = () => {
    if (v5) { r.skip(106); return; }
    const flags = r.u8();
    if ((flags & 0x01) === 0) {
      r.intByteSizeString();
      const first = r.i32();
      if (first) for (let i = 0; i < 6; i++) r.i32();
    } else r.skip(105);
  };

  for (let m = 0; m < measureCount; m++) {
    const hdr = headers[m];
    for (let t = 0; t < trackCount; t++) {
      const ctx = ctxs[t];
      const voiceCount = v5 ? 2 : 1;
      for (let v = 0; v < voiceCount; v++) {
        const beats = r.i32();
        if (beats < 0 || beats > 1000) throw new Error('Guitar Pro file is corrupt (beat count).');
        let cursor = hdr.start;
        for (let b = 0; b < beats; b++) {
          const flags = r.u8();
          let rest = false;
          if (flags & 0x40) { const st = r.u8(); rest = st === 0 || st === 2; }
          const dur = readDuration(flags);
          if (flags & 0x02) readChord();
          if (flags & 0x04) r.intByteSizeString();
          let beatArts = new Set<string>();
          if (flags & 0x08) beatArts = readBeatEffects();
          if (flags & 0x10) {
            const tempo = readMix();
            if (tempo > 0) tempoEvents.push({ tick: Math.round(cursor), bpm: tempo });
          }
          const sflags = r.u8();
          for (let s = 0; s < 7; s++) {
            if (!(sflags & (1 << (6 - s)))) continue;
            const nf = r.u8();
            let type = 1;
            let velocity = 90;
            let fret = 0;
            if (nf & 0x20) type = r.u8();
            if (!v5 && nf & 0x01) r.skip(2);
            if (nf & 0x10) velocity = Math.max(1, Math.min(127, 15 + 16 * r.i8() - 16));
            if (nf & 0x20) fret = r.i8();
            if (nf & 0x80) r.skip(2);
            if (v5) {
              if (nf & 0x01) r.skip(8);
              r.u8(); // flags2
            }
            let arts = new Set<string>(beatArts);
            if (nf & 0x08) arts = new Set([...arts, ...readNoteEffects()]);
            if (nf & 0x02) arts.add('accent');
            if (type === 3) arts.add('dead');
            if (rest || (s >= ctx.strings && !ctx.perc)) continue;
            const tied = type === 2;
            if (tied) fret = ctx.lastFret[s];
            if (fret < 0) fret = 0;
            ctx.lastFret[s] = fret;
            let note: Note;
            const start = Math.round(cursor);
            const dTicks = Math.max(1, Math.round(cursor + dur) - start);
            if (ctx.perc) {
              note = makeNote(Math.max(0, Math.min(127, fret)), start, dTicks, velocity, v);
            } else {
              const pitch = ctx.tuning[s] + ctx.capo + fret;
              if (pitch < 0 || pitch > 127) continue;
              note = makeNote(pitch, start, dTicks, velocity, v, {
                tab: { string: s, fret: fret + ctx.capo },
                tabLocked: true,
              });
            }
            if (tied) note.tiedFromPrevious = true;
            if (arts.size) note.articulations = [...arts];
            ctx.notes.push(note);
          }
          if (v5) {
            const f2 = r.i16();
            if (f2 & 0x0800) r.skip(1);
          }
          cursor += dur;
        }
      }
      if (v5) r.u8(); // line break
    }
  }

  for (const t of tempoEvents) {
    const last = score.tempos[score.tempos.length - 1];
    if (!last || last.bpm !== t.bpm) score.tempos.push(t);
  }
  const trackInfos: { guitar: boolean; perc: boolean; strings: number }[] = [];
  ctxs.forEach((c, i) => {
    if (c.notes.length === 0) return;
    const track: Track = { id: `t${i}`, name: c.name, program: c.perc ? 0 : c.program, notes: c.notes };
    score.tracks.push(track);
    trackInfos.push({ guitar: false, perc: c.perc, strings: c.strings });
    if (!c.perc) {
      // expose the tuning/capo of the first pitched track for UI use
      if (!score.meta.tracksTuning) score.meta.tracksTuning = {};
      (score.meta.tracksTuning as Record<string, unknown>)[track.id] = { pitches: c.tuning, capo: c.capo };
    }
  });
  if (sawRepeat) addWarning(score, 'Repeat signs are not expanded; the score is shown as written.');
  if (ctxs.some((c) => c.perc && c.notes.length)) addWarning(score, 'Percussion tracks are included but have no tab.');
  finishScore(score, { targets: trackInfos });
  setTuningMeta(score);
  return score;
}

function setTuningMeta(score: Score): void {
  const target = score.tracks.find((t) => t.isGuitarTarget);
  const all = score.meta.tracksTuning as Record<string, { pitches: number[]; capo: number }> | undefined;
  if (target && all?.[target.id]) {
    score.meta.tuning = all[target.id].pitches;
    score.meta.capo = all[target.id].capo;
  }
}

// ---------------------------------------------------------------------------------------------
// GPX (GP6) container: BCFZ decompression + BCFS file system
// ---------------------------------------------------------------------------------------------

class BitReader {
  private bytePos: number;
  private bitPos = 0; // 0..7, MSB first
  private readonly data: Uint8Array;
  constructor(data: Uint8Array, startByte: number) {
    this.data = data;
    this.bytePos = startByte;
  }
  get atEnd(): boolean { return this.bytePos >= this.data.length; }
  readBit(): number {
    if (this.bytePos >= this.data.length) return -1;
    const bit = (this.data[this.bytePos] >> (7 - this.bitPos)) & 1;
    this.bitPos++;
    if (this.bitPos === 8) { this.bitPos = 0; this.bytePos++; }
    return bit;
  }
  /** MSB first */
  readBits(n: number): number {
    let v = 0;
    for (let i = n - 1; i >= 0; i--) {
      const b = this.readBit();
      if (b < 0) return v;
      v |= b << i;
    }
    return v;
  }
  /** LSB first */
  readBitsReversed(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const b = this.readBit();
      if (b < 0) return v;
      v |= b << i;
    }
    return v;
  }
}

function i32le(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);
}

/** Decompress a BCFZ block (including its 4-byte magic and 4-byte expected-length header). */
export function decompressBcfz(data: Uint8Array): Uint8Array {
  if (data.length < 8 || String.fromCharCode(data[0], data[1], data[2], data[3]) !== 'BCFZ') {
    throw new Error('Not a BCFZ stream.');
  }
  const expected = i32le(data, 4);
  if (expected < 0 || expected > 1 << 28) throw new Error('Corrupt GPX: bad decompressed size.');
  const out = new Uint8Array(expected);
  let n = 0;
  const br = new BitReader(data, 8);
  while (n < expected && !br.atEnd) {
    const flag = br.readBits(1);
    if (flag === 1) {
      const wordSize = br.readBits(4);
      const offset = br.readBitsReversed(wordSize);
      const size = br.readBitsReversed(wordSize);
      const src = n - offset;
      const toRead = Math.min(offset, size);
      if (src < 0) throw new Error('Corrupt GPX: invalid back-reference.');
      for (let i = 0; i < toRead && n < expected; i++) out[n++] = out[src + i];
    } else {
      const size = br.readBitsReversed(2);
      for (let i = 0; i < size && n < expected; i++) out[n++] = br.readBits(8);
    }
  }
  return n === expected ? out : out.subarray(0, n);
}

/** Parse a BCFS file system (4-byte 'BCFS' magic then 0x1000-byte sectors) into a file map. */
export function readBcfs(data: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  if (String.fromCharCode(data[0], data[1], data[2], data[3]) !== 'BCFS') throw new Error('Not a BCFS file system.');
  const SECTOR = 0x1000;
  for (let offset = SECTOR; offset + SECTOR <= data.length; offset += SECTOR) {
    if (i32le(data, offset) !== 2) continue;
    let name = '';
    for (let i = 0; i < 127; i++) {
      const c = data[offset + 4 + i];
      if (!c) break;
      name += String.fromCharCode(c);
    }
    const size = i32le(data, offset + 0x8c);
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (let k = 0; ; k++) {
      const po = offset + 0x94 + 4 * k;
      if (po + 4 > data.length) break;
      const blockId = i32le(data, po);
      if (blockId === 0) break;
      const bo = blockId * SECTOR;
      if (bo >= data.length) break;
      const chunk = data.subarray(bo, Math.min(bo + SECTOR, data.length));
      chunks.push(chunk);
      total += chunk.length;
    }
    const buf = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) { buf.set(c, o); o += c.length; }
    files.set(name, size >= 0 && size < buf.length ? buf.subarray(0, size) : buf);
  }
  return files;
}

// ---------------------------------------------------------------------------------------------
// GPIF XML (GP6 / GP7)
// ---------------------------------------------------------------------------------------------

function kids(el: Element, name?: string): Element[] {
  const out: Element[] = [];
  for (let c = el.firstElementChild; c; c = c.nextElementSibling) if (!name || c.localName === name) out.push(c);
  return out;
}
function kid(el: Element | null | undefined, name: string): Element | null {
  if (!el) return null;
  for (let c = el.firstElementChild; c; c = c.nextElementSibling) if (c.localName === name) return c;
  return null;
}
function ktxt(el: Element | null | undefined, name: string): string | undefined {
  const k = kid(el, name);
  return k ? (k.textContent ?? '').trim() : undefined;
}
function ints(s: string | undefined): number[] {
  if (!s) return [];
  return s.trim().split(/\s+/).filter(Boolean).map((x) => parseInt(x, 10)).filter((x) => Number.isFinite(x));
}
function byId(parent: Element | null, childName: string): Map<string, Element> {
  const m = new Map<string, Element>();
  if (parent) for (const c of kids(parent, childName)) m.set(c.getAttribute('id') ?? '', c);
  return m;
}
function props(el: Element | null): Map<string, Element> {
  const m = new Map<string, Element>();
  const p = kid(el, 'Properties');
  if (p) for (const c of kids(p, 'Property')) m.set(c.getAttribute('name') ?? '', c);
  return m;
}

const NOTE_VALUES: Record<string, number> = {
  whole: 1, half: 2, quarter: 4, eighth: 8, '16th': 16, '32nd': 32, '64th': 64, '128th': 128, '256th': 256,
};

export function parseGpif(xml: string): Score {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const root = doc.documentElement;
  if (!root || root.localName !== 'GPIF' || doc.getElementsByTagName('parsererror').length > 0) {
    throw new Error('Invalid Guitar Pro score.gpif XML.');
  }
  const score: Score = { ppq: DEFAULT_PPQ, tracks: [], timeSignatures: [], keySignatures: [], tempos: [], meta: { source: 'guitarpro' } };

  const sc = kid(root, 'Score');
  const title = ktxt(sc, 'Title');
  if (title) score.meta.title = title;
  const comp = ktxt(sc, 'Music') || ktxt(sc, 'Words') || ktxt(sc, 'Artist');
  if (comp) score.meta.composer = comp;

  const tracksEl = kid(root, 'Tracks');
  const trackEls = tracksEl ? kids(tracksEl, 'Track') : [];
  const masterBars = kid(root, 'MasterBars') ? kids(kid(root, 'MasterBars')!, 'MasterBar') : [];
  const bars = byId(kid(root, 'Bars'), 'Bar');
  const voicesMap = byId(kid(root, 'Voices'), 'Voice');
  const beatsMap = byId(kid(root, 'Beats'), 'Beat');
  const notesMap = byId(kid(root, 'Notes'), 'Note');
  const rhythms = byId(kid(root, 'Rhythms'), 'Rhythm');

  // Track descriptors
  interface TInfo { name: string; tuning: number[]; capo: number; perc: boolean; program: number; notes: Note[]; lastFret: number[]; strings: number }
  const infos: TInfo[] = trackEls.map((te, i) => {
    const p = props(te);
    const tuning = ints(ktxt(p.get('Tuning') ?? null, 'Pitches')); // low → high
    const capo = ints(ktxt(p.get('CapoFret') ?? null, 'Fret'))[0] ?? 0;
    const setType = (ktxt(kid(te, 'InstrumentSet'), 'Type') ?? '').toLowerCase();
    const perc = setType === 'drumkit' || !!kid(te, 'DrumKit');
    const program = parseInt(ktxt(kid(te, 'GeneralMidi'), 'Program') ?? '', 10);
    return {
      name: ktxt(te, 'Name') || `Track ${i + 1}`,
      tuning,
      capo: Math.max(0, capo),
      perc,
      program: Number.isFinite(program) ? Math.max(0, Math.min(127, program)) : 25,
      notes: [],
      lastFret: [],
      strings: tuning.length,
    };
  });

  // Master bars: time + key; compute starts
  const starts: number[] = [];
  const lens: number[] = [];
  let tick = 0;
  let lastKey: { f: number; m: string } | undefined;
  masterBars.forEach((mb, idx) => {
    const t = (ktxt(mb, 'Time') ?? '4/4').split('/');
    const n = parseInt(t[0], 10) || 4;
    const d = parseInt(t[1], 10) || 4;
    const prev = score.timeSignatures[score.timeSignatures.length - 1];
    if (!prev || prev.numerator !== n || prev.denominator !== d) score.timeSignatures.push({ tick, numerator: n, denominator: d });
    const key = kid(mb, 'Key');
    if (key) {
      const f = parseInt(ktxt(key, 'AccidentalCount') ?? '0', 10) || 0;
      const mode = (ktxt(key, 'Mode') ?? 'Major').toLowerCase() === 'minor' ? 'minor' : 'major';
      if (!lastKey || lastKey.f !== f || lastKey.m !== mode || idx === 0) {
        score.keySignatures.push({ tick, fifths: Math.max(-7, Math.min(7, f)), mode });
        lastKey = { f, m: mode };
      }
    }
    starts.push(tick);
    const len = (WHOLE * n) / d;
    lens.push(len);
    tick += len;
  });

  // Tempo automations
  const mt = kid(root, 'MasterTrack');
  const autos = kid(mt, 'Automations');
  if (autos) {
    for (const a of kids(autos, 'Automation')) {
      if ((ktxt(a, 'Type') ?? '').toLowerCase() !== 'tempo') continue;
      const bpm = parseFloat((ktxt(a, 'Value') ?? '').split(/\s+/)[0]);
      const bar = parseInt(ktxt(a, 'Bar') ?? '0', 10) || 0;
      const pos = parseFloat(ktxt(a, 'Position') ?? '0') || 0;
      if (!(bpm > 0) || bar < 0 || bar >= starts.length) continue;
      const frac = pos <= 1 ? pos : 0;
      const tk = Math.round(starts[bar] + frac * lens[bar]);
      const last = score.tempos[score.tempos.length - 1];
      if (last && last.tick === tk) last.bpm = bpm;
      else if (!last || last.bpm !== bpm) score.tempos.push({ tick: tk, bpm });
    }
  }
  score.tempos.sort((a, b) => a.tick - b.tick);

  const rhythmTicks = (rid: string | null): number => {
    const r = rid !== null ? rhythms.get(rid) : undefined;
    if (!r) return WHOLE / 4;
    const base = NOTE_VALUES[(ktxt(r, 'NoteValue') ?? 'Quarter').toLowerCase()] ?? 4;
    let t = WHOLE / base;
    const dots = parseInt(kid(r, 'AugmentationDot')?.getAttribute('count') ?? '0', 10) || 0;
    let add = t;
    for (let i = 0; i < dots; i++) { add /= 2; t += add; }
    const tup = kid(r, 'PrimaryTuplet');
    if (tup) {
      const n = parseInt(tup.getAttribute('num') ?? '1', 10) || 1;
      const d = parseInt(tup.getAttribute('den') ?? '1', 10) || 1;
      t = (t * d) / n;
    }
    return t;
  };

  const ART_PROPS: Record<string, string> = { HopoOrigin: 'hammer', Slide: 'slide', PalmMuted: 'palm-mute', Bended: 'bend', HarmonicType: 'harmonic', Slapped: 'accent' };

  masterBars.forEach((mb, mIdx) => {
    const barIds = ints(ktxt(mb, 'Bars'));
    barIds.forEach((barId, tIdx) => {
      const ti = infos[tIdx];
      if (!ti || barId < 0) return;
      const bar = bars.get(String(barId));
      if (!bar) return;
      const voiceIds = ints(ktxt(bar, 'Voices'));
      let dynVel = 90;
      voiceIds.forEach((vid, vIdx) => {
        if (vid < 0) return;
        const voice = voicesMap.get(String(vid));
        if (!voice) return;
        let cursor = starts[mIdx];
        for (const bid of ints(ktxt(voice, 'Beats'))) {
          const beat = beatsMap.get(String(bid));
          if (!beat) continue;
          const dyn = ktxt(beat, 'Dynamic');
          if (dyn && DYNAMIC_VELOCITY[dyn.toUpperCase()]) dynVel = DYNAMIC_VELOCITY[dyn.toUpperCase()];
          const dur = rhythmTicks(kid(beat, 'Rhythm')?.getAttribute('ref') ?? null);
          const grace = !!kid(beat, 'GraceNotes');
          const noteIds = ints(ktxt(beat, 'Notes'));
          if (!grace) {
            for (const nid of noteIds) {
              const ne = notesMap.get(String(nid));
              if (!ne) continue;
              const p = props(ne);
              const strP = ktxt(p.get('String') ?? null, 'String');
              const fretP = ktxt(p.get('Fret') ?? null, 'Fret');
              const tie = kid(ne, 'Tie');
              const tiedIn = tie?.getAttribute('destination') === 'true';
              const gpString = strP !== undefined ? parseInt(strP, 10) : NaN;
              let fret = fretP !== undefined ? parseInt(fretP, 10) : NaN;
              const start = Math.round(cursor);
              const dTicks = Math.max(1, Math.round(cursor + dur) - start);
              if (ti.perc) {
                const midiN = parseInt(ktxt(p.get('Midi') ?? null, 'Number') ?? '', 10);
                if (Number.isFinite(midiN)) ti.notes.push(makeNote(Math.max(0, Math.min(127, midiN)), start, dTicks, dynVel, vIdx));
                continue;
              }
              if (!Number.isFinite(gpString)) continue;
              if (!Number.isFinite(fret)) fret = tiedIn ? (ti.lastFret[gpString] ?? 0) : 0;
              if (gpString < 0 || gpString >= ti.strings) continue;
              ti.lastFret[gpString] = fret;
              const pitch = ti.tuning[gpString] + ti.capo + fret;
              if (pitch < 0 || pitch > 127) continue;
              const note = makeNote(pitch, start, dTicks, dynVel, vIdx, {
                tab: { string: ti.strings - 1 - gpString, fret: fret + ti.capo },
                tabLocked: true,
              });
              if (tiedIn) note.tiedFromPrevious = true;
              const arts: string[] = [];
              for (const [k, v] of Object.entries(ART_PROPS)) {
                const pe = p.get(k);
                if (pe && (kid(pe, 'Enable') || kid(pe, 'Flags') || kid(pe, 'HType'))) arts.push(v);
              }
              if (arts.length) note.articulations = arts;
              ti.notes.push(note);
            }
            cursor += dur;
          }
        }
      });
    });
  });

  const trackInfos: { guitar: boolean; perc: boolean; strings: number }[] = [];
  const tuningMeta: Record<string, { pitches: number[]; capo: number }> = {};
  infos.forEach((ti, i) => {
    if (ti.notes.length === 0) return;
    const id = `t${i}`;
    score.tracks.push({ id, name: ti.name, program: ti.perc ? 0 : ti.program, notes: ti.notes });
    trackInfos.push({ guitar: false, perc: ti.perc, strings: ti.strings });
    if (!ti.perc) tuningMeta[id] = { pitches: [...ti.tuning].reverse(), capo: ti.capo };
  });
  score.meta.tracksTuning = tuningMeta;
  if (infos.some((t) => t.perc && t.notes.length)) addWarning(score, 'Percussion tracks are included but have no tab.');
  finishScore(score, { targets: trackInfos });
  setTuningMeta(score);
  return score;
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

function startsWith(b: Uint8Array, s: string): boolean {
  if (b.length < s.length) return false;
  for (let i = 0; i < s.length; i++) if (b[i] !== s.charCodeAt(i)) return false;
  return true;
}

export function importGuitarPro(data: ArrayBuffer, filename: string): Score {
  const bytes = toBytes(data);
  void filename;
  if (startsWith(bytes, 'BCFZ') || startsWith(bytes, 'BCFS')) {
    const fsBytes = startsWith(bytes, 'BCFZ') ? decompressBcfz(bytes) : bytes;
    const files = readBcfs(fsBytes);
    const gpif = files.get('score.gpif') ?? [...files.entries()].find(([n]) => n.endsWith('.gpif'))?.[1];
    if (!gpif) throw new Error('GPX file does not contain score.gpif.');
    return parseGpif(decodeUtf8(gpif));
  }
  if (startsWith(bytes, 'PK')) {
    const files = unzipSync(bytes);
    const name = Object.keys(files).find((n) => /(^|\/)score\.gpif$/i.test(n)) ?? Object.keys(files).find((n) => n.toLowerCase().endsWith('.gpif'));
    if (!name) throw new Error('Guitar Pro archive does not contain Content/score.gpif.');
    return parseGpif(decodeUtf8(files[name]));
  }
  return parseGuitarPro345(bytes);
}
