# OMR corpus baseline

- Run: 2026-10-07 17:10 EDT, git HEAD `ae70ef6` plus uncommitted work-in-progress edits in `src/omr/*` by other agents (results may be in flux).
- Command: `npx tsx scripts/omr-bench/corpus-bench.ts --degrade --seed 1234 --md scripts/omr-bench/BASELINE-corpus.md` (table below reproduced from `--md`).
- Degraded = `degradeScan(page, { seed: 1234 })`. Whole run takes about 9 s.
- Crashes: none (0 of 28 runs threw). The degraded runs for 8 pieces find no staves at all (see "no staves found" in the dumps), which is the main failure.
- Chord symbols: the OMR emits none yet (`meta.omrChords` absent), so chord columns are n/a; the comparison is implemented and unit-tested.
- Clef accuracy is n/a (the Score model carries no clef; the metric reads `meta.omrClefs` if it ever appears).
- Slash: truth slash measures come from `<measure-style><slash>` / `notehead slash`; recognized from `meta.omrSlashMeasures`. `+Nfp` = false positives.
- "pc F1" is octave-insensitive pitch-class F1; it shows carcassi is almost entirely an octave error (guitar music written an octave up; truth 1% vs pc 73%).
- Fixture bug: `after-youve-gone/score.musicxml` has an unescaped `&` in `<creator>` (invalid XML, `importMusicXml` throws). The bench and test use `sanitizeXml()` to work around it; the fixture itself should be fixed.

| piece | mode | pitch F1 | full F1 | pc F1 | measures ok | key acc | time acc | chords (exact/root) | slash | warn | s |
|---|---|---|---|---|---|---|---|---|---|---|---|
| after-youve-gone | clean | 45% | 38% | 45% | 16/16 ok | 100% | 100% | n/a/n/a | 2/4+1fp | 3 | 0.2 |
| after-youve-gone | degraded | 15% | 13% | 15% | 17/16 | 0% | 0% | n/a/n/a | 3/4 | 2 | 0.1 |
| greensleeves | clean | 77% | 74% | 77% | 14/16 | 88% | 88% | n/a/n/a | n/a | 1 | 0.1 |
| greensleeves | degraded | 12% | 2% | 14% | 14/16 | 88% | 0% | n/a/n/a | n/a | 1 | 0.1 |
| lieder-brahms-magdalena | clean | 7% | 7% | 7% | 32/8 | 0% | 100% | n/a/n/a | n/a | 2 | 0.2 |
| lieder-brahms-magdalena | degraded | 6% | 2% | 9% | 9/8 | 0% | 25% | n/a/n/a | n/a | 2 | 0.1 |
| lieder-hensel-maiabend | clean | 2% | 1% | 3% | 28/12 | 0% | 0% | n/a/n/a | n/a | 4 | 0.2 |
| lieder-hensel-maiabend | degraded | 0% | 0% | 0% | 0/12 | 0% | 0% | n/a/n/a | n/a | 3 | 0.1 |
| lieder-kinkel-nachgefuehl | clean | 11% | 10% | 13% | 24/8 | 0% | 100% | n/a/n/a | n/a | 4 | 0.2 |
| lieder-kinkel-nachgefuehl | degraded | 4% | 3% | 4% | 3/8 | 0% | 38% | n/a/n/a | n/a | 1 | 0.1 |
| lieder-satie-chanson | clean | 7% | 7% | 8% | 32/11 | 0% | 0% | n/a/n/a | n/a | 7 | 0.2 |
| lieder-satie-chanson | degraded | 4% | 2% | 7% | 23/11 | 0% | 0% | n/a/n/a | n/a | 4 | 0.2 |
| lieder-schroeter-an-laura | clean | 13% | 12% | 16% | 12/4 | 0% | 0% | n/a/n/a | n/a | 3 | 0.1 |
| lieder-schroeter-an-laura | degraded | 0% | 0% | 0% | 0/4 | 0% | 0% | n/a/n/a | n/a | 2 | 0.1 |
| lieder-zumsteeg-geburtstag | clean | 11% | 10% | 18% | 9/8 | 100% | 100% | n/a/n/a | n/a | 2 | 0.1 |
| lieder-zumsteeg-geburtstag | degraded | 0% | 0% | 0% | 0/8 | 0% | 0% | n/a/n/a | n/a | 2 | 0.0 |
| lieder-zumsteeg-kapelle | clean | 3% | 2% | 5% | 44/21 | 0% | 48% | n/a/n/a | n/a | 5 | 0.2 |
| lieder-zumsteeg-kapelle | degraded | 0% | 0% | 0% | 0/21 | 0% | 0% | n/a/n/a | n/a | 3 | 0.1 |
| lieder-zumsteeg-romanze | clean | 8% | 8% | 20% | 26/12 | 0% | 0% | n/a/n/a | n/a | 4 | 0.1 |
| lieder-zumsteeg-romanze | degraded | 0% | 0% | 0% | 0/12 | 0% | 0% | n/a/n/a | n/a | 2 | 0.0 |
| londonderry-air | clean | 62% | 54% | 62% | 19/21 | 90% | 90% | n/a/n/a | 0/2+2fp | 3 | 0.1 |
| londonderry-air | degraded | 15% | 13% | 15% | 19/21 | 90% | 0% | n/a/n/a | 0/2+1fp | 2 | 0.1 |
| mutopia-bach-menuet-g | clean | 45% | 44% | 47% | 27/32 | 19% | 84% | n/a/n/a | n/a | 3 | 0.1 |
| mutopia-bach-menuet-g | degraded | 0% | 0% | 0% | 0/32 | 0% | 0% | n/a/n/a | n/a | 2 | 0.0 |
| mutopia-carcassi-op60-01 | clean | 1% | 0% | 73% | 43/43 ok | 100% | 100% | n/a/n/a | n/a | 4 | 0.2 |
| mutopia-carcassi-op60-01 | degraded | 0% | 0% | 0% | 0/43 | 0% | 0% | n/a/n/a | n/a | 2 | 0.0 |
| st-louis-blues | clean | 70% | 68% | 70% | 16/16 ok | 75% | 75% | n/a/n/a | n/a | 2 | 0.1 |
| st-louis-blues | degraded | 9% | 3% | 9% | 20/16 | 0% | 0% | n/a/n/a | n/a | 1 | 0.1 |

## Averages

| set | pieces | crashes | pitch F1 | full F1 | pc F1 | measures ok | key acc | time acc | chords exact | chords root | avg warn |
|---|---|---|---|---|---|---|---|---|---|---|---|
| clean | 14 | 0 | 26% | 24% | 33% | 21% | 41% | 63% | n/a | n/a | 3.4 |
| degraded | 14 | 0 | 5% | 3% | 5% | 0% | 13% | 4% | n/a | n/a | 2.1 |
