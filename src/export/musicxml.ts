import { guitarTrack, measuresOf, keySignatureAt, spellPitch, spellingToMidi, ticksToNoteValue, noteValueToTicks } from '../core';
import type { Score, GuitarConfig, Note, Measure, KeySignature, Spelling } from '../core';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

const TYPE_NAMES: Record<number, string> = { 1: 'whole', 2: 'half', 4: 'quarter', 8: 'eighth', 16: '16th', 32: '32nd', 64: '64th' };

interface Seg { ticks: number; base: number; dots: number; triplet: boolean }

function splitTicks(ticks: number, ppq: number): Seg[] {
  const nv = ticksToNoteValue(ticks, ppq);
  if (Math.abs(noteValueToTicks(nv, ppq) - ticks) <= 1) return [{ ticks, base: nv.base, dots: nv.dots, triplet: nv.triplet }];
  const vals: Seg[] = [];
  for (const base of [1, 2, 4, 8, 16, 32, 64]) {
    for (const dots of [2, 1, 0]) vals.push({ ticks: noteValueToTicks({ base, dots, triplet: false }, ppq), base, dots, triplet: false });
  }
  vals.sort((a, b) => b.ticks - a.ticks);
  const out: Seg[] = [];
  let rem = ticks;
  const smallest = vals[vals.length - 1].ticks;
  while (rem >= smallest) {
    const v = vals.find((x) => x.ticks <= rem)!;
    out.push({ ...v });
    rem -= v.ticks;
  }
  if (rem > 0) {
    if (out.length) out[out.length - 1].ticks += rem;
    else out.push({ ticks: rem, base: 64, dots: 0, triplet: false });
  }
  return out;
}

interface Piece { note: Note; start: number; dur: number; seg: Seg; tieStart: boolean; tieStop: boolean; }

function pieceNote(piece: Piece, chord: boolean, key: KeySignature, g: GuitarConfig | null, isGuitar: boolean, hammerStop: Set<Note>, voice: number): string {
  const n = piece.note;
  let sp: Spelling = n.spelling && spellingToMidi(n.spelling) === n.pitch ? n.spelling : spellPitch(n.pitch, key);
  const x: string[] = ['<note>'];
  if (chord) x.push('<chord/>');
  x.push(`<pitch><step>${sp.step}</step>${sp.alter ? `<alter>${sp.alter}</alter>` : ''}<octave>${sp.octave}</octave></pitch>`);
  x.push(`<duration>${piece.dur}</duration>`);
  if (piece.tieStop) x.push('<tie type="stop"/>');
  if (piece.tieStart) x.push('<tie type="start"/>');
  x.push(`<voice>${voice}</voice>`);
  x.push(`<type>${TYPE_NAMES[piece.seg.base] ?? 'quarter'}</type>`);
  for (let i = 0; i < piece.seg.dots; i++) x.push('<dot/>');
  if (piece.seg.triplet) x.push('<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>');
  const notations: string[] = [];
  if (piece.tieStop) notations.push('<tied type="stop"/>');
  if (piece.tieStart) notations.push('<tied type="start"/>');
  if (isGuitar && n.tab && g) {
    const tech: string[] = [];
    const arts = n.articulations ?? [];
    if (arts.includes('hammer')) tech.push('<hammer-on type="start" number="1">H</hammer-on>');
    if (arts.includes('pull')) tech.push('<pull-off type="start" number="1">P</pull-off>');
    if (hammerStop.has(n) && piece.tieStop === false) {
      tech.push(arts.includes('pull') ? '<pull-off type="stop" number="1"/>' : '<hammer-on type="stop" number="1"/>');
    }
    tech.push(`<string>${n.tab.string + 1}</string>`, `<fret>${n.tab.fret}</fret>`);
    notations.push(`<technical>${tech.join('')}</technical>`);
  }
  if (notations.length) x.push(`<notations>${notations.join('')}</notations>`);
  x.push('</note>');
  return x.join('');
}

function restXml(seg: Seg, voice: number, whole = false, dur?: number): string {
  if (whole) return `<note><rest measure="yes"/><duration>${dur}</duration><voice>${voice}</voice></note>`;
  return `<note><rest/><duration>${seg.ticks}</duration><voice>${voice}</voice><type>${TYPE_NAMES[seg.base] ?? 'quarter'}</type>${'<dot/>'.repeat(seg.dots)}${seg.triplet ? '<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>' : ''}</note>`;
}

function stepOctave(pitch: number, flats: boolean): { step: string; alter: number; octave: number } {
  return spellPitch(pitch, { tick: 0, fifths: flats ? -1 : 0, mode: 'major' });
}

export function exportMusicXml(score: Score, guitar: GuitarConfig): string {
  const ppq = score.ppq || 480;
  const measures = measuresOf(score);
  const gt = guitarTrack(score);
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8" standalone="no"?>');
  out.push('<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">');
  out.push('<score-partwise version="3.1">');
  out.push(`<work><work-title>${esc(score.meta.title ?? 'Untitled')}</work-title></work>`);
  out.push('<identification>');
  if (score.meta.composer) out.push(`<creator type="composer">${esc(String(score.meta.composer))}</creator>`);
  out.push('<encoding><software>TabScribe</software></encoding></identification>');
  out.push('<part-list>');
  score.tracks.forEach((t, i) => out.push(`<score-part id="P${i + 1}"><part-name>${esc(t.name || `Track ${i + 1}`)}</part-name></score-part>`));
  out.push('</part-list>');

  const flatTuning = guitar.tuning.pitches.some((p) => [3, 8, 10].includes(((p % 12) + 12) % 12));

  score.tracks.forEach((tr, ti) => {
    const isGuitar = tr === gt;
    out.push(`<part id="P${ti + 1}">`);
    const sorted = [...tr.notes].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
    // tie linking between notes
    const tieStartNotes = new Set<Note>();
    const tieStopNotes = new Set<Note>();
    for (const n of sorted) {
      if (!n.tiedFromPrevious) continue;
      const prev = [...sorted].reverse().find((m) => m !== n && m.pitch === n.pitch && m.voice === n.voice && m.start + m.duration === n.start);
      if (prev) { tieStartNotes.add(prev); tieStopNotes.add(n); }
    }
    // next note on same string for hammer/pull stop markers
    const hammerStop = new Set<Note>();
    if (isGuitar) {
      for (const n of sorted) {
        if (!n.tab || !(n.articulations ?? []).some((a) => a === 'hammer' || a === 'pull')) continue;
        const next = sorted.find((m) => m.start > n.start && m.tab && m.tab.string === n.tab!.string);
        if (next) hammerStop.add(next);
      }
    }
    // per-measure pieces
    const piecesByMeasure: Piece[][] = measures.map(() => []);
    for (const n of sorted) {
      const dur = Math.max(1, n.duration);
      let pos = n.start;
      const end = n.start + dur;
      let first = true;
      const all: Piece[] = [];
      while (pos < end) {
        const m = measures.find((mm) => pos >= mm.startTick && pos < mm.endTick);
        if (!m) break;
        const segEnd = Math.min(end, m.endTick);
        let p = pos;
        for (const seg of splitTicks(segEnd - pos, ppq)) {
          const piece: Piece = { note: n, start: p, dur: seg.ticks, seg, tieStart: false, tieStop: false };
          piecesByMeasure[m.index].push(piece);
          all.push(piece);
          p += seg.ticks;
        }
        pos = segEnd;
        first = false;
      }
      void first;
      all.forEach((pc, i) => {
        pc.tieStart = i < all.length - 1 || (i === all.length - 1 && tieStartNotes.has(n));
        pc.tieStop = i > 0 || (i === 0 && tieStopNotes.has(n));
      });
    }

    let prevTs: Measure['timeSignature'] | null = null;
    let prevKey: KeySignature | null = null;
    const pitches = tr.notes.map((n) => n.pitch);
    const avg = pitches.length ? pitches.reduce((a, b) => a + b, 0) / pitches.length : 60;
    measures.forEach((m) => {
      const mLen = m.endTick - m.startTick;
      out.push(`<measure number="${m.index + 1}">`);
      const key = keySignatureAt(score, m.startTick);
      const newTs = !prevTs || prevTs.numerator !== m.timeSignature.numerator || prevTs.denominator !== m.timeSignature.denominator;
      const newKey = !prevKey || prevKey.fifths !== key.fifths || prevKey.mode !== key.mode;
      if (m.index === 0 || newTs || newKey) {
        out.push('<attributes>');
        if (m.index === 0) out.push(`<divisions>${ppq}</divisions>`);
        if (newKey) out.push(`<key><fifths>${key.fifths}</fifths><mode>${key.mode}</mode></key>`);
        if (newTs) out.push(`<time><beats>${m.timeSignature.numerator}</beats><beat-type>${m.timeSignature.denominator}</beat-type></time>`);
        if (m.index === 0) {
          if (isGuitar) {
            out.push('<clef><sign>G</sign><line>2</line><clef-octave-change>-1</clef-octave-change></clef>');
            const lines = guitar.tuning.pitches.length;
            let sd = `<staff-details><staff-lines>${lines}</staff-lines>`;
            // line 1 = lowest string
            [...guitar.tuning.pitches].reverse().forEach((p, i) => {
              const so = stepOctave(p, flatTuning);
              sd += `<staff-tuning line="${i + 1}"><tuning-step>${so.step}</tuning-step>${so.alter ? `<tuning-alter>${so.alter}</tuning-alter>` : ''}<tuning-octave>${so.octave}</tuning-octave></staff-tuning>`;
            });
            if (guitar.capo > 0) sd += `<capo>${guitar.capo}</capo>`;
            sd += '</staff-details>';
            out.push(sd);
          } else if (avg < 55) out.push('<clef><sign>F</sign><line>4</line></clef>');
          else out.push('<clef><sign>G</sign><line>2</line></clef>');
        }
        out.push('</attributes>');
      }
      prevTs = m.timeSignature; prevKey = key;
      // tempo
      const tempo = score.tempos.find((t) => t.tick >= m.startTick && t.tick < m.endTick) ?? (m.index === 0 ? score.tempos[0] : undefined);
      if (tempo) out.push(`<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${Math.round(tempo.bpm * 100) / 100}</per-minute></metronome></direction-type><sound tempo="${Math.round(tempo.bpm * 100) / 100}"/></direction>`);
      // lanes
      interface Group { start: number; dur: number; pieces: Piece[] }
      const lanes: Group[][] = [];
      const ps = [...piecesByMeasure[m.index]].sort((a, b) => a.start - b.start || b.dur - a.dur || a.note.pitch - b.note.pitch);
      for (const p of ps) {
        let placed = false;
        for (const lane of lanes) {
          const last = lane[lane.length - 1];
          if (last.start === p.start && last.dur === p.dur) { last.pieces.push(p); placed = true; break; }
        }
        if (placed) continue;
        for (const lane of lanes) {
          const last = lane[lane.length - 1];
          if (last.start + last.dur <= p.start) { lane.push({ start: p.start, dur: p.dur, pieces: [p] }); placed = true; break; }
        }
        if (!placed) lanes.push([{ start: p.start, dur: p.dur, pieces: [p] }]);
      }
      if (lanes.length === 0) lanes.push([]);
      lanes.forEach((lane, li) => {
        const voice = li + 1;
        if (li > 0) out.push(`<backup><duration>${mLen}</duration></backup>`);
        if (lane.length === 0) { out.push(restXml({ ticks: mLen, base: 1, dots: 0, triplet: false }, voice, true, mLen)); return; }
        let cursor = m.startTick;
        const fill = (to: number): void => { if (to > cursor) for (const seg of splitTicks(to - cursor, ppq)) out.push(restXml(seg, voice)); cursor = Math.max(cursor, to); };
        for (const grp of lane) {
          fill(grp.start);
          grp.pieces.forEach((p, i) => out.push(pieceNote(p, i > 0, key, guitar, isGuitar, hammerStop, voice)));
          cursor = grp.start + grp.dur;
        }
        fill(m.endTick);
      });
      out.push('</measure>');
    });
    out.push('</part>');
  });
  out.push('</score-partwise>');
  return out.join('\n');
}
