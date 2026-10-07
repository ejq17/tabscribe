import { unzipSync } from 'fflate';
import { DEFAULT_PPQ } from '../core';
import type { Note, Score, Track } from '../core';
import { addWarning, decodeUtf8, makeNote, sortScoreMeta } from './util';
import { pickGuitarTarget } from './midi';

const STEP_BASE: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function kids(el: Element, name?: string): Element[] {
  const out: Element[] = [];
  for (let c = el.firstElementChild; c; c = c.nextElementSibling) {
    if (!name || c.localName === name) out.push(c);
  }
  return out;
}
function kid(el: Element | null | undefined, name: string): Element | null {
  if (!el) return null;
  for (let c = el.firstElementChild; c; c = c.nextElementSibling) if (c.localName === name) return c;
  return null;
}
function txt(el: Element | null | undefined, name: string): string | undefined {
  const k = kid(el, name);
  return k ? (k.textContent ?? '').trim() : undefined;
}
function num(el: Element | null | undefined, name: string): number | undefined {
  const t = txt(el, name);
  if (t === undefined || t === '') return undefined;
  const v = Number(t);
  return Number.isFinite(v) ? v : undefined;
}

/** Extract the XML text from raw bytes (plain XML, UTF-16, or .mxl zip). */
export function readMusicXmlText(data: ArrayBuffer | string | Uint8Array): string {
  if (typeof data === 'string') return data.replace(/^﻿/, '');
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const files = unzipSync(bytes);
    let rootPath: string | undefined;
    const container = files['META-INF/container.xml'];
    if (container) {
      const doc = new DOMParser().parseFromString(decodeUtf8(container), 'application/xml');
      const rf = Array.from(doc.getElementsByTagName('rootfile'))[0];
      rootPath = rf?.getAttribute('full-path') ?? undefined;
    }
    if (!rootPath || !files[rootPath]) {
      rootPath = Object.keys(files).find((n) => !n.startsWith('META-INF/') && /\.(xml|musicxml)$/i.test(n));
    }
    if (!rootPath) throw new Error('Invalid .mxl: no MusicXML rootfile found.');
    return decodeUtf8(files[rootPath]);
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes).replace(/^﻿/, '');
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes).replace(/^﻿/, '');
  return decodeUtf8(bytes);
}

interface PartData {
  id: string;
  measures: Element[];
}

/** Normalize partwise/timewise roots into a list of parts, each with its ordered measures. */
function collectParts(root: Element): PartData[] {
  if (root.localName === 'score-partwise') {
    return kids(root, 'part').map((p) => ({ id: p.getAttribute('id') ?? '', measures: kids(p, 'measure') }));
  }
  if (root.localName === 'score-timewise') {
    const map = new Map<string, PartData>();
    for (const m of kids(root, 'measure')) {
      for (const p of kids(m, 'part')) {
        const id = p.getAttribute('id') ?? '';
        let pd = map.get(id);
        if (!pd) map.set(id, (pd = { id, measures: [] }));
        // Treat the <part> element inside a timewise measure as the measure (children are identical).
        pd.measures.push(p);
      }
    }
    return [...map.values()];
  }
  throw new Error('Not a MusicXML score (expected score-partwise or score-timewise).');
}

function pushUnique<T extends { tick: number }>(arr: T[], item: T, same: (a: T, b: T) => boolean): void {
  const last = arr[arr.length - 1];
  if (last && last.tick === item.tick) {
    arr[arr.length - 1] = item;
    return;
  }
  if (last && same(last, item)) return;
  arr.push(item);
}

export function importMusicXml(data: ArrayBuffer | string): Score {
  const text = readMusicXmlText(data);
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const root = doc.documentElement;
  if (!root || doc.getElementsByTagName('parsererror').length > 0) {
    throw new Error('Could not parse MusicXML: invalid XML.');
  }

  const score: Score = {
    ppq: DEFAULT_PPQ,
    tracks: [],
    timeSignatures: [],
    keySignatures: [],
    tempos: [],
    meta: { source: 'musicxml' },
  };

  const title = txt(kid(root, 'work'), 'work-title') ?? txt(root, 'movement-title');
  if (title) score.meta.title = title;
  const creators = kids(kid(root, 'identification') ?? root, 'creator');
  const composer = creators.find((c) => c.getAttribute('type') === 'composer') ?? creators[0];
  if (composer?.textContent?.trim()) score.meta.composer = composer.textContent.trim();

  // Part list
  const partInfo = new Map<string, { name: string; program?: number }>();
  const partList = kid(root, 'part-list');
  if (partList) {
    for (const sp of kids(partList, 'score-part')) {
      const id = sp.getAttribute('id') ?? '';
      const name = txt(sp, 'part-name') ?? '';
      const mi = kid(sp, 'midi-instrument');
      const prog = num(mi, 'midi-program');
      partInfo.set(id, { name, program: prog !== undefined ? Math.max(0, Math.min(127, prog - 1)) : undefined });
    }
  }

  const parts = collectParts(root);
  let sawRepeat = false;
  let sawGrace = false;
  let hasTabAny = false;
  const hasTab: boolean[] = [];

  parts.forEach((part, partIdx) => {
    let divisions = 1;
    let beats = 4;
    let beatType = 4;
    let measureStart = 0;
    const voiceMap = new Map<string, number>();
    const notes: Note[] = [];
    let partHasTab = false;
    // open ties by pitch to keep tiedFromPrevious semantics
    const toTicks = (d: number) => Math.round((d * DEFAULT_PPQ) / divisions);

    for (const m of part.measures) {
      let cursor = 0; // in divisions, relative to measure start
      let extent = 0;
      let lastStart = 0;
      const implicit = m.getAttribute('implicit') === 'yes';
      const at = (c: number) => measureStart + toTicks(c);

      for (const el of kids(m)) {
        switch (el.localName) {
          case 'attributes': {
            const d = num(el, 'divisions');
            if (d && d > 0) divisions = d;
            const time = kid(el, 'time');
            if (time) {
              const b = txt(time, 'beats');
              const bt = num(time, 'beat-type');
              if (b && bt) {
                // "3+2" style additive meters: sum the numerators
                beats = b.split('+').reduce((s, x) => s + (parseInt(x, 10) || 0), 0) || 4;
                beatType = bt;
              } else if (kid(time, 'senza-misura')) {
                // no meter
              }
              if (partIdx === 0) {
                pushUnique(score.timeSignatures, { tick: at(cursor), numerator: beats, denominator: beatType }, (a, b2) => a.numerator === b2.numerator && a.denominator === b2.denominator);
              }
            }
            const key = kid(el, 'key');
            if (key && partIdx === 0) {
              const f = num(key, 'fifths');
              if (f !== undefined) {
                const mode = txt(key, 'mode') === 'minor' ? 'minor' : 'major';
                pushUnique(score.keySignatures, { tick: at(cursor), fifths: Math.max(-7, Math.min(7, f)), mode }, (a, b2) => a.fifths === b2.fifths && a.mode === b2.mode);
              }
            }
            break;
          }
          case 'direction': {
            if (partIdx !== 0) break;
            const sound = kid(el, 'sound');
            let bpm: number | undefined;
            const st = sound?.getAttribute('tempo');
            if (st) bpm = parseFloat(st);
            if (!bpm) {
              const met = kid(kid(el, 'direction-type'), 'metronome');
              if (met) {
                const unit = txt(met, 'beat-unit');
                const pm = parseFloat(txt(met, 'per-minute') ?? '');
                if (unit && pm > 0) {
                  const unitQ: Record<string, number> = { whole: 4, half: 2, quarter: 1, eighth: 0.5, '16th': 0.25, '32nd': 0.125 };
                  let q = unitQ[unit] ?? 1;
                  if (kid(met, 'beat-unit-dot')) q *= 1.5;
                  bpm = pm * q;
                }
              }
            }
            if (bpm && bpm > 0) pushUnique(score.tempos, { tick: at(cursor), bpm: Math.round(bpm * 100) / 100 }, (a, b2) => a.bpm === b2.bpm);
            break;
          }
          case 'sound': {
            const st = el.getAttribute('tempo');
            if (partIdx === 0 && st && parseFloat(st) > 0) {
              pushUnique(score.tempos, { tick: at(cursor), bpm: parseFloat(st) }, (a, b2) => a.bpm === b2.bpm);
            }
            break;
          }
          case 'barline': {
            if (kid(el, 'repeat')) sawRepeat = true;
            break;
          }
          case 'backup': {
            cursor -= num(el, 'duration') ?? 0;
            if (cursor < 0) cursor = 0;
            break;
          }
          case 'forward': {
            cursor += num(el, 'duration') ?? 0;
            extent = Math.max(extent, cursor);
            break;
          }
          case 'note': {
            const isGrace = !!kid(el, 'grace');
            const isChord = !!kid(el, 'chord');
            const isRest = !!kid(el, 'rest');
            const dur = num(el, 'duration') ?? 0;
            if (isGrace) {
              sawGrace = true;
              break;
            }
            const start = isChord ? lastStart : cursor;
            if (!isChord) {
              lastStart = cursor;
              cursor += dur;
              extent = Math.max(extent, cursor);
            }
            if (isRest) break;
            const pitchEl = kid(el, 'pitch');
            if (!pitchEl) break; // unpitched percussion
            const step = (txt(pitchEl, 'step') ?? 'C').toUpperCase();
            const alter = Math.round(num(pitchEl, 'alter') ?? 0);
            const octave = num(pitchEl, 'octave') ?? 4;
            const midi = (octave + 1) * 12 + (STEP_BASE[step] ?? 0) + alter;
            if (midi < 0 || midi > 127) break;
            const vStr = txt(el, 'voice') ?? '1';
            const stf = txt(el, 'staff');
            const vKey = stf && stf !== '1' ? `${stf}:${vStr}` : vStr;
            if (!voiceMap.has(vKey)) voiceMap.set(vKey, voiceMap.size);
            const note = makeNote(midi, at(start), Math.max(1, toTicks(dur)), 90, voiceMap.get(vKey)!);
            if (STEP_BASE[step] !== undefined) {
              note.spelling = { step: step as 'C', alter: Math.max(-2, Math.min(2, alter)), octave };
            }
            const dyn = el.getAttribute('dynamics');
            if (dyn) note.velocity = Math.max(1, Math.min(127, Math.round((parseFloat(dyn) / 100) * 90)));
            // ties
            const tieStop = kids(el, 'tie').some((t) => t.getAttribute('type') === 'stop') ||
              kids(el, 'notations').some((n) => kids(n, 'tied').some((t) => t.getAttribute('type') === 'stop'));
            if (tieStop) note.tiedFromPrevious = true;
            // notations
            const arts: string[] = [];
            for (const nt of kids(el, 'notations')) {
              const tech = kid(nt, 'technical');
              if (tech) {
                const sEl = num(tech, 'string');
                const fEl = num(tech, 'fret');
                if (sEl !== undefined && fEl !== undefined && sEl >= 1) {
                  note.tab = { string: sEl - 1, fret: Math.max(0, fEl) };
                  note.tabLocked = true;
                  partHasTab = true;
                }
                if (kid(tech, 'hammer-on')) arts.push('hammer');
                if (kid(tech, 'pull-off')) arts.push('pull');
                if (kid(tech, 'harmonic')) arts.push('harmonic');
                if (kid(tech, 'bend')) arts.push('bend');
              }
              const ar = kid(nt, 'articulations');
              if (ar) {
                if (kid(ar, 'staccato')) arts.push('staccato');
                if (kid(ar, 'accent') || kid(ar, 'strong-accent')) arts.push('accent');
              }
              if (kid(nt, 'slide')) arts.push('slide');
            }
            if (arts.length) note.articulations = [...new Set(arts)];
            notes.push(note);
            break;
          }
          default:
            break;
        }
      }

      const nominal = Math.round(((divisions * 4 * beats) / beatType));
      let lenDiv = extent;
      if (!implicit && extent < nominal) lenDiv = nominal;
      measureStart += toTicks(lenDiv);
    }

    if (notes.length === 0) return;
    // Merge tied notes? Keep separate; renderer draws ties. Sort for determinism.
    notes.sort((a, b) => a.start - b.start || b.pitch - a.pitch);
    const info = partInfo.get(part.id);
    const track: Track = {
      id: part.id || `P${partIdx + 1}`,
      name: info?.name || `Part ${partIdx + 1}`,
      program: info?.program ?? 0,
      notes,
    };
    score.tracks.push(track);
    hasTab.push(partHasTab);
    if (partHasTab) hasTabAny = true;
  });

  if (!score.timeSignatures.length || score.timeSignatures[0].tick > 0) score.timeSignatures.unshift({ tick: 0, numerator: 4, denominator: 4 });
  if (!score.keySignatures.length || score.keySignatures[0].tick > 0) score.keySignatures.unshift({ tick: 0, fifths: 0, mode: 'major' });
  if (!score.tempos.length || score.tempos[0].tick > 0) score.tempos.unshift({ tick: 0, bpm: 120 });

  if (score.tracks.length === 0) addWarning(score, 'MusicXML contains no pitched notes.');
  if (sawGrace) addWarning(score, 'Grace notes were skipped.');
  if (sawRepeat) addWarning(score, 'Repeat signs are not expanded; the score is shown as written.');

  // Guitar target selection
  let target = -1;
  if (hasTabAny) target = hasTab.findIndex(Boolean);
  if (target < 0) target = score.tracks.findIndex((t) => /guitar|guit|git/i.test(t.name) || (t.program >= 24 && t.program <= 31));
  if (target >= 0) score.tracks[target].isGuitarTarget = true;
  else pickGuitarTarget(score.tracks, score.tracks.map(() => false));

  sortScoreMeta(score);
  return score;
}
