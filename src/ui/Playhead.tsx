import { useEffect } from 'react';
import { useStore } from '../store';
import { LINE_GAP, findSystem, tickToX, type TabLayout } from './tabLayout';

/** Separate component so high-frequency tick updates don't re-render the tab. */
export default function Playhead({ layout, scroller }: { layout: TabLayout; scroller: React.RefObject<HTMLElement | null> }) {
  const tick = useStore((s) => s.playback.tick);
  const isPlaying = useStore((s) => s.playback.isPlaying);
  const f = findSystem(layout, tick);
  const x = f ? tickToX(f.m, tick) : 0;
  const sysY = f?.sys.staffTop ?? 0;
  const top = f?.sys.y ?? 0;
  const sysH = f?.sys.height ?? 0;
  useEffect(() => {
    if (!isPlaying || !f) return;
    const sc = (scroller.current?.closest('.scroll-area') as HTMLElement | null) ?? null;
    const svg = sc?.querySelector('svg.tab-svg');
    if (!sc || !svg) return;
    const rect = svg.getBoundingClientRect();
    const scRect = sc.getBoundingClientRect();
    const scale = rect.width / layout.width;
    const yTop = rect.top - scRect.top + top * scale;
    const yBot = yTop + sysH * scale;
    if (yTop < 0 || yBot > sc.clientHeight) sc.scrollBy?.({ top: yTop - 12, behavior: 'smooth' });
  }, [isPlaying, f?.sys.index]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!f) return null;
  const n = layout.nStrings;
  return <line className="playhead" x1={x} x2={x} y1={sysY - 8} y2={sysY + (n - 1) * LINE_GAP + 8} pointerEvents="none" />;
}
