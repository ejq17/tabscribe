import { useEffect, useState, type RefObject } from 'react';

export function useWidth(ref: RefObject<HTMLElement | null>, fallback = 800): number {
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setW(Math.round(el.clientWidth) || fallback);
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, fallback]);
  return w;
}
