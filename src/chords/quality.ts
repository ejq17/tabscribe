/**
 * Compositional chord-quality parser: turns a quality string ("maj9", "7#9", "m69", "9sus4", "7alt" ...)
 * into semitone intervals above the root. Independent of the note-detection template table.
 */

export interface QualityIntervals {
  /** pitch classes above the root (0..11), sorted and de-duplicated */
  tones: number[];
  /** subset a guitar voicing must contain, sorted and de-duplicated */
  required: number[];
}

const sortedUnique = (xs: Iterable<number>): number[] => [...new Set([...xs].map((v) => ((v % 12) + 12) % 12))].sort((a, b) => a - b);

/** Returns null when `quality` is not a chord quality (so callers can fall back). */
export function chordIntervals(quality: string): QualityIntervals | null {
  let s = quality
    .replace(/maj/gi, 'maj')
    .replace(/[()\s]/g, '')
    .replace(/[–−—]/g, '-')
    .replace(/[Δ∆△]/g, 'maj')
    .replace(/6\/9/g, '69')
    .replace(/ø7?/g, 'm7b5')
    .replace(/[°º˚]/g, 'dim')
    .replace(/aug/g, '+')
    .replace(/M/g, 'maj')
    .replace(/ma(?=\d)/g, 'maj')
    .replace(/^o/, 'dim')
    .replace(/(\d)\+/g, '$1#5');
  let minor = false;
  const mm = /^(min|mi|m(?!aj)|-)/.exec(s);
  if (mm) { minor = true; s = s.slice(mm[0].length); }
  let dim = false, aug = false, maj = false;
  if (s.startsWith('dim')) { dim = true; s = s.slice(3); }
  else if (s.startsWith('+')) { aug = true; s = s.slice(1); }
  else if (s.startsWith('maj')) { maj = true; s = s.slice(3); }
  const em = /^(69|13|11|9|7|6|5|4|2)/.exec(s);
  const ext = em ? em[1] : '';
  s = s.slice(ext.length);

  let third: number | null = dim || minor ? 3 : 4;
  let fifth = dim ? 6 : aug ? 8 : 7;
  let fifthAltered = dim || aug;
  let seventh: number | null = null;
  let sixth = false;
  let top: number | null = null; // highest named extension (required)
  const natural = new Set<number>();
  const altered = new Set<number>();
  let sus: number | null = null;
  let alt = false;
  let implied = false; // a tension that implies the dominant seventh

  if (maj && ext && !['6', '69', '7', '9', '11', '13'].includes(ext)) return null;
  if (ext === '5') {
    if (minor || dim || aug || maj || s) return null;
    return { tones: [0, 7], required: [0, 7] };
  }
  if (ext === '6') sixth = true;
  else if (ext === '69') { sixth = true; natural.add(2); top = 2; }
  else if (ext === '7') seventh = maj ? 11 : dim ? 9 : 10;
  else if (ext === '9' || ext === '11' || ext === '13') {
    seventh = maj ? 11 : 10;
    natural.add(2);
    top = 2;
    if (ext === '11') { natural.add(5); top = 5; }
    if (ext === '13') { natural.add(9); top = 9; }
  } else if (ext === '2') { natural.add(2); top = 2; }
  else if (ext === '4') { natural.add(5); top = 5; }
  else if (maj && minor) seventh = 11; // mmaj

  while (s) {
    let m: RegExpExecArray | null;
    if ((m = /^sus(2|4)?/.exec(s))) sus = m[1] === '2' ? 2 : 5;
    else if ((m = /^add(2|4|6|9|11|13)/.exec(s))) {
      const n = Number(m[1]);
      if (n === 2 || n === 9) { natural.add(2); top = 2; }
      else if (n === 4 || n === 11) { natural.add(5); top = 5; }
      else { natural.add(9); top = 9; }
    } else if ((m = /^alt/.exec(s))) alt = true;
    else if ((m = /^b5/.exec(s))) { fifth = 6; fifthAltered = true; }
    else if ((m = /^#5/.exec(s))) { fifth = 8; fifthAltered = true; }
    else if ((m = /^b9/.exec(s))) { altered.add(1); implied = true; }
    else if ((m = /^#9/.exec(s))) { altered.add(3); implied = true; }
    else if ((m = /^#11/.exec(s))) { altered.add(6); implied = true; }
    else if ((m = /^b13/.exec(s))) { altered.add(8); implied = true; }
    else return null;
    s = s.slice(m[0].length);
  }

  if (alt) {
    const t = minor ? 3 : 4;
    return { tones: sortedUnique([0, t, 8, 10, 3]), required: sortedUnique([0, t, 8, 10, 3]) };
  }
  if (implied && seventh === null && !sixth && !natural.size) seventh = 10;
  // b9 / #9 replace the natural 9 of a larger extension chord
  if (altered.has(1) || altered.has(3)) {
    natural.delete(2);
    if (top === 2) top = null;
  }
  if (sus !== null) third = null;
  // a #11 / b13 sits a semitone from the natural fifth, which is dropped
  const dropFifth = fifth === 7 && (altered.has(6) || altered.has(8));

  const tones = new Set<number>([0]);
  if (!dropFifth) tones.add(fifth);
  const required = new Set<number>([0]);
  const thirdTone = third ?? sus;
  if (thirdTone !== null) { tones.add(thirdTone); required.add(thirdTone); }
  if (seventh !== null) { tones.add(seventh); required.add(seventh); }
  if (sixth) { tones.add(9); required.add(9); }
  for (const n of natural) tones.add(n);
  if (top !== null) required.add(top);
  for (const a of altered) { tones.add(a); required.add(a); }
  // dominant 11th: guitar voicings omit the third (it clashes with the 11th), so it stays a tone but is not required
  if (ext === '11' && third === 4) required.delete(4);
  if (!dropFifth && (fifthAltered || tones.size < 4)) required.add(fifth);
  return { tones: sortedUnique(tones), required: sortedUnique(required) };
}
