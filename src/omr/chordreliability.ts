/**
 * Decides, per page, whether OCR chord symbols are trustworthy enough to show.
 *
 * Evidence (five hand-lettered jazz-font scans, 128 labels, 11 correct; clean-font charts, 47 labels, all correct):
 *  - tesseract's own per-word confidence and the parser's confidence do not separate right from wrong on a single label: wrong reads
 *    in a bad font are often confident (bare "A" at 0.96 is an accent mark) and right ones are often unsure (0 .. 0.78);
 *  - what does separate them is the PAGE: in a readable font nearly every label parses as written (no character repairs) with a
 *    solid OCR confidence (clean charts: 94-100 % of labels), in an unreadable one at most 64 % do (scans: 0-64 %).
 * A label is "confident" when it needed no repair and tesseract gave it at least CONFIDENT_OCR. A page is reliable when at least
 * MIN_CONFIDENT_SHARE of its OCR labels are confident. Pages with fewer than MIN_PAGE_LABELS labels are judged together with
 * every other such page, because a share over two or three labels means nothing.
 * Labels without `ocrConf` (PDF text layer, Claude reader, hand-made) are never judged and never counted.
 */
import type { ChordLabel } from './chordtext';

export const CONFIDENT_OCR = 0.25;
export const MIN_CONFIDENT_SHARE = 0.75;
export const MIN_PAGE_LABELS = 4;

export interface PageChordLabels {
  page: number;
  labels: Pick<ChordLabel, 'repaired' | 'ocrConf'>[];
}

export function isConfidentLabel(l: Pick<ChordLabel, 'repaired' | 'ocrConf'>): boolean {
  return !l.repaired && (l.ocrConf ?? 0) >= CONFIDENT_OCR;
}

/** Page numbers (as given in `pages[].page`) whose OCR chord labels should be withheld. */
export function unreliableChordPages(pages: PageChordLabels[]): Set<number> {
  const bad = new Set<number>();
  const judged = pages.map((p) => ({ page: p.page, ocr: p.labels.filter((l) => l.ocrConf !== undefined) })).filter((p) => p.ocr.length > 0);
  const share = (ls: PageChordLabels['labels']) => ls.filter(isConfidentLabel).length / ls.length;
  const small: typeof judged = [];
  for (const p of judged) {
    if (p.ocr.length >= MIN_PAGE_LABELS) { if (share(p.ocr) < MIN_CONFIDENT_SHARE) bad.add(p.page); }
    else small.push(p);
  }
  const pooled = small.flatMap((p) => p.ocr);
  if (pooled.length > 0 && share(pooled) < MIN_CONFIDENT_SHARE) for (const p of small) bad.add(p.page);
  return bad;
}
