/** Pure helpers for YouTube links and m:ss times. No DOM access. */

const ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** "1:30", "01:02:03", "90", "90.5", "1m30s", "1h2m3s", "45s" -> seconds, or null when unparseable. */
export function parseTime(input: string): number | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  if (/^\d+(:\d{1,2}(\.\d+)?){1,2}$/.test(s)) {
    const parts = s.split(':').map(Number);
    if (parts.slice(1).some((p) => p >= 60)) return null;
    return parts.reduce((acc, p) => acc * 60 + p, 0);
  }
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(s);
  if (m && (m[1] || m[2] || m[3])) return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  return null;
}

/** Seconds -> "m:ss" (or "h:mm:ss" from an hour up). Negative / non-finite values show as 0:00. */
export function formatTime(sec: number): string {
  const t = Number.isFinite(sec) && sec > 0 ? Math.floor(sec) : 0;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const ss = String(t % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

const YT_HOSTS = /^(?:www\.|m\.|music\.)?(?:youtube\.com|youtube-nocookie\.com)$/;

/** Accepts a bare 11-char id or a watch / youtu.be / shorts / embed / live URL (incl. music.youtube.com). */
export function parseYouTubeUrl(input: string): { id: string; t?: number } | null {
  const raw = input.trim();
  if (!raw) return null;
  if (ID_RE.test(raw)) return { id: raw };
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  let id: string | null = null;
  const segs = url.pathname.split('/').filter(Boolean);
  if (host === 'youtu.be' || host === 'www.youtu.be') {
    id = segs[0] ?? null;
  } else if (YT_HOSTS.test(host)) {
    if (segs[0] === 'watch') id = url.searchParams.get('v');
    else if (['shorts', 'embed', 'live', 'v'].includes(segs[0])) id = segs[1] ?? null;
  } else {
    return null;
  }
  if (!id || !ID_RE.test(id)) return null;
  const hashT = /(?:^|[#&])t=([^&]+)/.exec(url.hash)?.[1];
  const tRaw = url.searchParams.get('t') ?? url.searchParams.get('start') ?? hashT;
  const t = tRaw ? parseTime(tRaw) : null;
  return t !== null ? { id, t } : { id };
}
