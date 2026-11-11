/**
 * Optional chord-symbol reader backed by Claude (bring-your-own-key, runs in the browser).
 *
 * For every system the chord band is cropped from the page canvas (see `strip.ts`), sent to Claude with a JSON schema and
 * the answer is mapped onto `score.meta.omrChords` exactly like the OCR path produces it. Any failure for a system falls back
 * to the OCR labels of that system and adds ONE human-readable warning; nothing here ever throws into the recognition flow.
 *
 * The network lives in `callClaude`; `readChordsWithClaude` takes an injected caller so tests never touch the network.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { OmrChord, OmrSystem, Score } from '../core';
import { parseChordText } from '../omr/chordtext';
import { claudeReaderActive, useAiSettings, type ClaudeModel } from './settings';
import { renderStrip, type CanvasFactory, type Strip } from './strip';

export interface ClaudeChord {
  /** 1-based measure number as printed in the strip */
  measure: number;
  /** 1-based beat inside the measure, fractional allowed */
  beat: number;
  symbol: string;
}
export interface ClaudeChordResult {
  chords: ClaudeChord[];
}
/** (PNG base64, number of measures in the strip) -> Claude's reading. Throws on any API failure. */
export type ClaudeCaller = (png: string, measureCount: number) => Promise<ClaudeChordResult>;

export const SYSTEM_PROMPT = `You read chord symbols from strips of printed sheet music.

Each image is one system (a line of music) cropped from a score. Red tick marks below the staff mark the barlines and red numbers under the staff number the measures 1, 2, 3 ... from left to right. The red markings were added by the software; they are not part of the score.

Report every chord symbol printed above the staff, with the measure number it belongs to and the beat inside that measure where the symbol starts (1 is the first beat; fractional beats such as 2.5 are allowed). Beats are counted from the left barline of the measure to its right barline.

Rules:
- Only chord symbols: a letter A-G with optional b or # and a quality (m, maj7, 7, m7b5, dim, aug, sus4, 6/9, add9, ...), optionally a slash bass note (C/E), or "N.C." for no chord.
- Ignore rehearsal letters or numbers (often boxed), tempo and metronome marks, dynamics, lyrics, fingering digits, articulation marks such as accents and staccato dots, and section titles or other words.
- Write symbols as printed, using b and # for flats and sharps. Write a triangle as maj7 (for example C triangle 7 becomes Cmaj7), a circle with a slash as m7b5 and a small circle as dim.
- Do not infer or repeat chords for measures that have no printed symbol.
- List the chords in left-to-right order. If the strip has no chord symbols, return an empty list.`;

export function chordSchema(measureCount: number) {
  return {
    type: 'object',
    properties: {
      chords: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            measure: { type: 'integer', description: `measure number from the red markers, 1 to ${measureCount}` },
            beat: { type: 'number', description: '1-based beat within the measure; fractional allowed' },
            symbol: { type: 'string', description: 'the chord symbol as printed, e.g. Bbmaj7 or Ebm6/F' },
          },
          required: ['measure', 'beat', 'symbol'],
          additionalProperties: false,
        },
      },
    },
    required: ['chords'],
    additionalProperties: false,
  } as const;
}

/** The one network call. Works with a browser client (`dangerouslyAllowBrowser`) or a Node client. */
export async function callClaude(client: Anthropic, model: ClaudeModel | string, png: string, measureCount: number): Promise<ClaudeChordResult> {
  const { jsonSchemaOutputFormat } = await import('@anthropic-ai/sdk/helpers/json-schema');
  const msg = await client.messages.parse({
    model,
    max_tokens: 2000,
    system: SYSTEM_PROMPT,
    output_config: { effort: 'low', format: jsonSchemaOutputFormat(chordSchema(measureCount)) },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
          {
            type: 'text',
            text: `This strip holds ${measureCount} measure${measureCount === 1 ? '' : 's'}, numbered 1 to ${measureCount} by the red markers. List every chord symbol printed above the staff.`,
          },
        ],
      },
    ],
  });
  const out = msg.parsed_output as ClaudeChordResult | null | undefined;
  if (!out || !Array.isArray(out.chords)) throw new Error('Claude returned no readable chord list.');
  return out;
}

/** Build a caller backed by the Anthropic SDK in the browser (loaded lazily so the SDK stays out of the main bundle). */
export async function makeBrowserCaller(apiKey: string, model: ClaudeModel): Promise<ClaudeCaller> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  return (png, n) => callClaude(client, model, png, n);
}

/** Human-readable reason for a failed call, using the SDK's typed errors (most specific first). */
export async function describeClaudeError(e: unknown): Promise<{ kind: 'auth' | 'rate' | 'network' | 'api' | 'other'; text: string }> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  if (e instanceof Anthropic.AuthenticationError) {
    if (/CORS requests are not allowed/i.test(e.message)) {
      return { kind: 'auth', text: 'your Anthropic organization does not allow requests from a browser' };
    }
    return { kind: 'auth', text: 'the API key was rejected (check it in Settings)' };
  }
  if (e instanceof Anthropic.RateLimitError) return { kind: 'rate', text: 'the rate limit was reached' };
  if (e instanceof Anthropic.APIConnectionError) return { kind: 'network', text: 'Claude could not be reached (network error)' };
  if (e instanceof Anthropic.APIError) return { kind: 'api', text: `the API returned an error${e.status ? ` (${e.status})` : ''}` };
  return { kind: 'other', text: e instanceof Error && e.message ? e.message : 'an unexpected error occurred' };
}

/**
 * Map Claude's answer for one strip to OmrChord entries. Symbols that do not parse, measures out of range and
 * duplicates are dropped; beats snap to the nearest beat of the measure like the OCR path.
 */
export function mapClaudeChords(strip: Pick<Strip, 'measures'>, chords: ClaudeChord[]): OmrChord[] {
  const out: OmrChord[] = [];
  const seen = new Set<string>();
  for (const c of chords) {
    const mi = Number(c?.measure);
    if (!Number.isInteger(mi) || mi < 1 || mi > strip.measures.length) continue;
    if (typeof c.symbol !== 'string') continue;
    const parsed = parseChordText(c.symbol);
    if (!parsed) continue;
    const m = strip.measures[mi - 1];
    const nBeats = Math.max(1, Math.round(m.length / m.beatTicks));
    const beat = Number.isFinite(c.beat) ? c.beat : 1;
    const idx = Math.min(nBeats - 1, Math.max(0, Math.round(beat - 1)));
    const tick = m.tick + idx * m.beatTicks;
    const key = `${tick}|${parsed.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ measure: m.measure, tick, text: parsed.text, chord: parsed.chord, confidence: 0.95 });
  }
  return out;
}

export interface ReadChordsOptions {
  caller: ClaudeCaller;
  onProgress?: (p: { stage: string; fraction: number; page?: number }) => void;
  /** systems in flight at once (default 3) */
  concurrency?: number;
  /** canvas factory for strip rendering (Node / tests); defaults to OffscreenCanvas or a DOM canvas */
  canvasFactory?: CanvasFactory;
}

type PageCanvas = CanvasImageSource & { width: number; height: number };

/**
 * Read chord symbols of every system with Claude and merge them into `score.meta.omrChords`. Mutates and returns `score`.
 * Systems that fail keep their OCR chords; at most one warning is added for all failures.
 */
export async function readChordsWithClaude(score: Score, pages: PageCanvas[], opts: ReadChordsOptions): Promise<Score> {
  // chords read from the PDF text layer are exact: those systems are neither sent to Claude nor overwritten by it
  const systems: OmrSystem[] = (score.meta.omrSystems ?? []).filter((s) => !s.textLayer);
  if (systems.length === 0) return score;
  const results = new Map<number, OmrChord[]>();
  let failed = 0;
  let firstFailure: string | undefined;
  let stop = false; // an auth failure will repeat on every system: do not keep calling
  let done = 0;
  let next = 0;
  const total = systems.length;
  const fail = async (e: unknown) => {
    failed++;
    try {
      const d = await describeClaudeError(e);
      firstFailure ??= d.text;
      if (d.kind === 'auth') stop = true;
    } catch {
      firstFailure ??= 'an unexpected error occurred';
    }
  };
  const worker = async () => {
    while (!stop) {
      const i = next++;
      if (i >= total) return;
      const sys = systems[i];
      try {
        const page = pages[sys.page];
        const strip = page ? await renderStrip(page, sys, opts.canvasFactory) : undefined;
        if (!strip) throw new Error('strip unavailable');
        const res = await opts.caller(strip.png, strip.measures.length);
        results.set(i, mapClaudeChords(strip, res.chords));
      } catch (e) {
        await fail(e);
      }
      done++;
      opts.onProgress?.({ stage: 'Reading chord symbols with Claude', fraction: done / total, page: sys.page });
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 3, total)) }, worker));
  } catch {
    /* never throw out of the recognition flow */
  }
  // systems skipped after an auth failure count as failed too
  const skipped = total - results.size - failed;
  if (skipped > 0) failed += skipped;

  if (results.size > 0) {
    const covered = (m: number) => [...results.keys()].some((i) => m >= systems[i].firstMeasure && m < systems[i].firstMeasure + systems[i].measureCount);
    const kept = (score.meta.omrChords ?? []).filter((c) => !covered(c.measure));
    const merged = [...kept, ...[...results.values()].flat()].sort((a, b) => a.tick - b.tick);
    if (merged.length > 0) score.meta.omrChords = merged;
    else delete score.meta.omrChords;
  }
  if (failed === 0 && results.size > 0 && score.meta.warnings) {
    // every system was read by Claude: the "chords left out" warning from the OCR stage no longer applies
    score.meta.warnings = score.meta.warnings.filter((w) => !w.startsWith('Chord symbols on page'));
  }
  if (failed > 0) {
    const all = failed >= total;
    score.meta.warnings = [
      ...(score.meta.warnings ?? []),
      `Claude could not read the chord symbols${all ? '' : ` for ${failed} of ${total} system${total === 1 ? '' : 's'}`}: ${firstFailure ?? 'an unexpected error occurred'}. ${score.meta.omrChordsSuppressed ? 'Chords are inferred from the notes' : `The OCR chord labels were used${all ? '' : ' for those systems'}`}.`,
    ];
  }
  return score;
}

/**
 * Entry point for `recognizeScore`: does nothing unless the reader is enabled and has a key. `caller` is injectable for tests.
 */
export async function maybeReadChordsWithClaude(
  score: Score,
  pages: PageCanvas[],
  opts: { onProgress?: ReadChordsOptions['onProgress']; caller?: ClaudeCaller } = {},
): Promise<Score> {
  if (!claudeReaderActive()) return score;
  try {
    const caller = opts.caller ?? (await makeBrowserCaller(useAiSettings.getState().apiKey.trim(), useAiSettings.getState().model));
    return await readChordsWithClaude(score, pages, { caller, onProgress: opts.onProgress });
  } catch {
    score.meta.warnings = [...(score.meta.warnings ?? []), 'Claude could not read the chord symbols: the reader could not start. The OCR chord labels were used.'];
    return score;
  }
}
