/** Sample loading helpers. `nearestSample` is pure and unit-tested. */

export interface SampleManifest {
  instrument?: string;
  click?: string;
  /** MIDI number -> file path relative to the samples dir */
  notes: Record<string, string>;
}

export interface SampleChoice {
  /** MIDI number of the sample that will be used */
  midi: number;
  /** playbackRate needed to reach the target pitch */
  rate: number;
}

/** Pick the nearest available sample for `target` and the playbackRate that shifts it to the target pitch. */
export function nearestSample(available: readonly number[], target: number): SampleChoice | null {
  if (available.length === 0) return null;
  let best = available[0];
  for (const m of available) {
    const d = Math.abs(m - target);
    const bd = Math.abs(best - target);
    // On ties prefer the lower sample (pitching up sounds brighter than pitching down sounds muddy; either is fine).
    if (d < bd || (d === bd && m < best)) best = m;
  }
  return { midi: best, rate: Math.pow(2, (target - best) / 12) };
}

export function samplesBaseUrl(): string {
  let base = '/';
  try {
    base = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  } catch {
    /* ignore */
  }
  if (!base.endsWith('/')) base += '/';
  return `${base}samples/`;
}

async function fetchBuffer(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return res.arrayBuffer();
}

export interface LoadedSamples {
  buffers: Map<number, AudioBuffer>;
  click: AudioBuffer | null;
}

export async function loadSamples(ctx: BaseAudioContext, onProgress?: (fraction: number) => void): Promise<LoadedSamples> {
  const base = samplesBaseUrl();
  const manifest = (await (await fetch(`${base}manifest.json`)).json()) as SampleManifest;
  const entries = Object.entries(manifest.notes);
  const buffers = new Map<number, AudioBuffer>();
  let done = 0;
  await Promise.all(
    entries.map(async ([midi, file]) => {
      try {
        const data = await fetchBuffer(base + file);
        buffers.set(Number(midi), await ctx.decodeAudioData(data));
      } catch (e) {
        console.warn('Sample failed to load', file, e);
      }
      done += 1;
      onProgress?.(done / entries.length);
    }),
  );
  let click: AudioBuffer | null = null;
  try {
    click = await ctx.decodeAudioData(await fetchBuffer(base + (manifest.click ?? 'click.wav')));
  } catch (e) {
    console.warn('Click sample failed to load', e);
  }
  return { buffers, click };
}
