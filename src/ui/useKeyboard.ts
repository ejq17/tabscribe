import { useEffect } from 'react';
import { noteValueToTicks, ticksToNoteValue } from '../core';
import { useStore } from '../store';
import { guitarNotes, playableStrings, sortedNotes } from '../store/ops';
import { auditionPitch, togglePlay } from './playback';
import { useUi } from './uiStore';

function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

let lastDigit: { at: number; digit: number; pushed: boolean } | null = null;

function applyFret(fretRel: number): boolean {
  const st = useStore.getState();
  if (!st.score) return false;
  const before = st.history.past.length;
  const { guitar, selection, cursor } = st;
  const fret = fretRel + guitar.capo;
  if (fret > guitar.maxFret) return false;
  if (selection.length) {
    st.updateNotes(selection, (n) => {
      const string = n.tab?.string ?? Math.max(0, guitar.tuning.pitches.findIndex((p) => p <= n.pitch));
      return { tab: { string, fret } };
    });
  } else if (cursor) {
    const string = cursor.string;
    const pitch = guitar.tuning.pitches[string] + fret;
    st.addNote({ pitch, start: cursor.tick, duration: st.score.ppq, voice: 0, tab: { string, fret } });
  }
  return useStore.getState().history.past.length > before;
}

function moveSelection(dir: 1 | -1) {
  const st = useStore.getState();
  const list = sortedNotes(st.score);
  if (!list.length) return;
  const cur = st.selection[st.selection.length - 1];
  const i = list.findIndex((n) => n.id === cur);
  const next = i < 0 ? (dir === 1 ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, i + dir));
  st.setSelection([list[next].id]);
  st.setCursor(null);
  const n = list[next];
  void auditionPitch(n.pitch);
}

export function useKeyboard() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const st = useStore.getState();
      const key = e.key;
      if (mod) {
        if (isTyping(e.target) && !(key.toLowerCase() === 'z' || key.toLowerCase() === 'y')) return;
        if (isTyping(e.target)) return; // let inputs keep native undo
        const k = key.toLowerCase();
        if (k === 'z') {
          e.preventDefault();
          if (e.shiftKey) st.redo();
          else st.undo();
        } else if (k === 'y') {
          e.preventDefault();
          st.redo();
        }
        return;
      }
      if (e.altKey || isTyping(e.target)) return;
      const onButton = (e.target as HTMLElement | null)?.tagName === 'BUTTON';
      if (!st.score) return;
      const sel = st.selection;

      if (/^[0-9]$/.test(key)) {
        e.preventDefault();
        const d = Number(key);
        const now = Date.now();
        if (lastDigit && now - lastDigit.at < 600) {
          const combined = lastDigit.digit * 10 + d;
          if (combined + st.guitar.capo <= st.guitar.maxFret) {
            if (lastDigit.pushed) st.undo();
            const pushed = applyFret(combined);
            lastDigit = null;
            void pushed;
            return;
          }
        }
        lastDigit = { at: now, digit: d, pushed: applyFret(d) };
        return;
      }
      lastDigit = null;

      switch (key) {
        case 'ArrowUp':
        case 'ArrowDown': {
          if (!sel.length) return;
          e.preventDefault();
          const step = e.shiftKey ? 12 : 1;
          st.transposeSelection(key === 'ArrowUp' ? step : -step);
          const n = guitarNotes(useStore.getState().score).find((x) => x.id === sel[sel.length - 1]);
          if (n) void auditionPitch(n.pitch);
          break;
        }
        case 'ArrowLeft':
          e.preventDefault();
          moveSelection(-1);
          break;
        case 'ArrowRight':
          e.preventDefault();
          moveSelection(1);
          break;
        case 'Delete':
        case 'Backspace':
          if (sel.length) {
            e.preventDefault();
            st.deleteNotes(sel);
          }
          break;
        case 'Escape':
          st.setSelection([]);
          st.setCursor(null);
          useUi.getState().setEditorOpen(false);
          break;
        case 'Enter':
          if (onButton) return;
          if (sel.length) {
            e.preventDefault();
            useUi.getState().setEditorOpen(true);
          }
          break;
        case ' ':
          if (onButton) return;
          e.preventDefault();
          void togglePlay();
          break;
        case '+':
        case '=':
        case '-':
        case '_': {
          if (!sel.length) return;
          e.preventDefault();
          const grow = key === '+' || key === '=';
          const min = Math.round(st.score.ppq / 8);
          st.updateNotes(sel, (n) => ({
            duration: Math.max(min, Math.min(st.score!.ppq * 8, Math.round(grow ? n.duration * 2 : n.duration / 2))),
          }));
          break;
        }
        case '.': {
          if (!sel.length) return;
          e.preventDefault();
          const ppq = st.score.ppq;
          st.updateNotes(sel, (n) => {
            const v = ticksToNoteValue(n.duration, ppq);
            return { duration: noteValueToTicks({ ...v, dots: v.dots > 0 ? 0 : 1, triplet: false }, ppq) };
          });
          break;
        }
        default: {
          const k = key.toLowerCase();
          if (k === 's' && sel.length) {
            e.preventDefault();
            for (const id of sel) {
              const n = guitarNotes(useStore.getState().score).find((x) => x.id === id);
              if (!n) continue;
              const list = playableStrings(n.pitch, st.guitar);
              if (!list.length) continue;
              const i = n.tab ? list.indexOf(n.tab.string) : -1;
              useStore.getState().moveNoteToString(id, list[(i + 1) % list.length]);
            }
          } else if (k === 'l' && sel.length) {
            e.preventDefault();
            const first = guitarNotes(st.score).find((x) => x.id === sel[0]);
            const target = !first?.tabLocked;
            st.updateNotes(sel, { tabLocked: target });
          } else if (k === 'a' && sel.length) {
            e.preventDefault();
            const n = guitarNotes(st.score).find((x) => x.id === sel[sel.length - 1]);
            if (n) void auditionPitch(n.pitch);
          }
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
