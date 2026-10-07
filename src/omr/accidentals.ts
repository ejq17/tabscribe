/**
 * Accidental detection beside noteheads, working on vertical strokes of the staff-line-free image so that signs
 * merged with beams, stems or parentheses are still found:
 *  - natural: two thin verticals whose tops are offset by about a staff space (the right one lower)
 *  - sharp:   two thin verticals at nearly the same height (plus slanted bars between them)
 *  - flat:    one thin vertical with a bulb at its lower right
 * Parentheses around courtesy accidentals are short curved strokes and never reach the stroke length threshold, so
 * they are simply ignored.
 */
import { findStrokes, type GImg, type Stroke } from './glyphs';
import type { AccidentalKind, Notehead } from './types';

export interface AccidentalHit {
  kind: AccidentalKind;
  /** right edge (local x) of the glyph */
  x1: number;
  /** x extent of the strokes the glyph was made of (a stroke belongs to one glyph only) */
  sx0: number;
  sx1: number;
  /** how far the glyph's vertical position is from the ideal for this head (staff spaces) */
  vcost: number;
}

function fill(img: GImg, xa: number, xb: number, ya: number, yb: number): number {
  let n = 0;
  let c = 0;
  for (let y = Math.max(0, Math.round(ya)); y <= Math.min(img.h - 1, Math.round(yb)); y++)
    for (let x = Math.max(0, Math.round(xa)); x <= Math.min(img.w - 1, Math.round(xb)); x++) {
      n++;
      c += img.d[y * img.w + x];
    }
  return n ? c / n : 0;
}

/**
 * All accidental readings that fit one head (local coordinates). `blockedX` lists x positions of stems / barlines whose
 * columns must not be mistaken for accidental strokes.
 */
export function accidentalsFor(img: GImg, d: number, t: number, cx: number, cy: number, blockedX: number[]): AccidentalHit[] {
  const xa = Math.round(cx - 4.2 * d);
  const xb = Math.round(cx - 0.8 * d);
  const out: AccidentalHit[] = [];
  if (xb - xa < d) return out;
  const ya = Math.round(cy - 2.5 * d);
  const yb = Math.round(cy + 2.3 * d);
  const maxW = Math.max(3, Math.round(0.42 * d), 2 * t + 1);
  let strokes = findStrokes(img, xa, xb, ya, yb, Math.round(1.55 * d), maxW);
  strokes = strokes.filter((s) => !blockedX.some((bx) => bx >= s.x0 - 1.2 && bx <= s.x1 + 1.2));
  strokes.sort((a, b) => b.x1 - a.x1);
  const len = (s: Stroke) => s.bot - s.top + 1;
  for (const s1 of strokes) {
    const lowRel = (s1.bot - cy) / d;
    // pairs: a stroke to the left within 0.18 .. 0.95 spaces
    for (const s0 of strokes) {
      if (s0 === s1 || s1.x0 - s0.x1 < 0.18 * d || s1.x0 - s0.x1 > 0.95 * d) continue;
      const dBot = s1.bot - s0.bot;
      if (dBot >= 0.55 * d && lowRel >= 0.9 && lowRel <= 2.4 && s0.bot - cy >= -0.3 * d && s0.bot - cy <= 1.5 * d && s1.x1 >= cx - 3.1 * d) {
        out.push({ kind: 'natural', x1: s1.x1, sx0: s0.x0, sx1: s1.x1, vcost: Math.abs(lowRel - 1.85) });
      } else if (Math.abs(dBot) <= 0.5 * d && lowRel >= 0.7 && lowRel <= 2.0 && s1.x1 >= cx - 3.1 * d) {
        // slanted bars between the strokes: the middle band is inked
        const mid = fill(img, s0.x1 + 1, s1.x0 - 1, cy - 0.9 * d, cy + 0.9 * d);
        if (mid >= 0.2) out.push({ kind: 'sharp', x1: s1.x1, sx0: s0.x0, sx1: s1.x1, vcost: Math.abs(lowRel - 1.4) });
      }
    }
    // flat: single stroke with a bulb to the lower right
    const hasRightPartner = strokes.some((o) => o !== s1 && o.x0 - s1.x1 >= 0.18 * d && o.x0 - s1.x1 <= 0.95 * d);
    if (!hasRightPartner && len(s1) >= 1.7 * d && Math.abs(s1.bot - 0.9 * d - cy) <= 0.7 * d) {
      const bulb = fill(img, s1.x1 + 1, s1.x1 + 0.85 * d, s1.bot - 1.4 * d, s1.bot - 0.1 * d);
      if (bulb >= 0.28 && s1.x1 + 0.85 * d >= cx - 3.3 * d && s1.x1 <= cx - 0.8 * d) out.push({ kind: 'flat', x1: s1.x1 + 0.85 * d, sx0: s1.x0, sx1: s1.x1, vcost: Math.abs(lowRel - 1.0) });
    }
  }
  return out;
}

export function detectAccidentals(img: GImg, d: number, t: number, heads: Notehead[], ox: number, oy: number, blockedX: number[], musicStart: number): Map<number, AccidentalHit> {
  const out = new Map<number, AccidentalHit>();
  const cand: { i: number; hit: AccidentalHit; cost: number }[] = [];
  heads.forEach((h, i) => {
    if (h.cx <= musicStart + 0.5 * d) return;
    const cx = h.cx - ox;
    for (const hit of accidentalsFor(img, d, t, cx, h.cy - oy, blockedX)) cand.push({ i, hit, cost: hit.vcost + 0.15 * ((cx - hit.x1) / d) });
  });
  // one glyph belongs to one head and vice versa: best vertical fit first
  cand.sort((a, b) => a.cost - b.cost);
  const used: { sx0: number; sx1: number }[] = [];
  for (const c of cand) {
    if (out.has(c.i)) continue;
    if (used.some((u) => c.hit.sx0 <= u.sx1 + 1 && c.hit.sx1 >= u.sx0 - 1)) continue;
    used.push({ sx0: c.hit.sx0, sx1: c.hit.sx1 });
    out.set(c.i, c.hit);
  }
  return out;
}
