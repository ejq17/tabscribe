import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../store';
import { deleteEntry, duplicateEntry, libraryAvailable, listEntries, renameEntry, type LibrarySummary } from '../store/library';
import { useUi } from './uiStore';

function when(t: number): string {
  return new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export default function Library() {
  const open = useUi((s) => s.libraryOpen);
  const setOpen = useUi((s) => s.setLibraryOpen);
  const currentId = useStore((s) => s.libraryId);
  const hasScore = useStore((s) => !!s.score);
  const [items, setItems] = useState<LibrarySummary[] | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setItems(await listEntries());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setItems([]);
    }
  }, []);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  if (!open) return null;
  const st = useStore.getState;

  const run = async (fn: () => Promise<unknown>) => {
    try {
      setErr(null);
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    await refresh();
  };

  return (
    <div className="drawer-wrap">
      <div className="scrim" onClick={() => setOpen(false)} />
      <aside className="drawer" role="dialog" aria-label="Library" aria-modal="true">
        <div className="drawer-head">
          <h2>Library</h2>
          <button className="btn icon" aria-label="Close library" onClick={() => setOpen(false)}>×</button>
        </div>
        <p className="muted">Tabs are saved in this browser. Use Export → Save tab file to back them up or move them to another device.</p>
        {hasScore && (
          <div className="btn-row">
            <button
              className="btn primary"
              onClick={() => {
                const name = window.prompt('Save a copy as…', st().libraryName || st().score?.meta.title || 'My tab');
                if (name?.trim()) void run(() => st().saveAs(name.trim()));
              }}
            >
              Save as…
            </button>
          </div>
        )}
        {err && <p className="field-err" role="alert">{err}</p>}
        {!libraryAvailable() && <p className="field-err">Saving is not available in this browser.</p>}
        {items && items.length === 0 && <p className="muted">No saved tabs yet. Open a file and it will be saved here automatically.</p>}
        <ul className="lib-list">
          {items?.map((it) => (
            <li key={it.id} className={`lib-item${it.id === currentId ? ' current' : ''}`} data-testid="lib-item">
              {it.thumbnail ? <img className="lib-thumb" src={it.thumbnail} alt="" /> : <div className="lib-thumb" aria-hidden>♪</div>}
              <div className="lib-meta">
                {renaming === it.id ? (
                  <form
                    className="lib-rename"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const name = draft.trim();
                      setRenaming(null);
                      if (!name) return;
                      void run(() => (it.id === currentId ? st().renameCurrent(name) : renameEntry(it.id, name)));
                    }}
                  >
                    <input autoFocus value={draft} aria-label="Tab name" onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setRenaming(null))} />
                    <button className="btn" type="submit">Save</button>
                  </form>
                ) : (
                  <span className="lib-name" title={it.name}>{it.name}{it.id === currentId ? ' (open)' : ''}</span>
                )}
                <span className="lib-sub">{when(it.updatedAt)}{it.preview ? ` · ${it.preview}` : ''}</span>
                <div className="lib-actions">
                  <button
                    className="btn"
                    disabled={it.id === currentId}
                    onClick={() => void run(async () => { if (await st().openFromLibrary(it.id)) setOpen(false); })}
                  >
                    Open
                  </button>
                  <button className="btn" onClick={() => { setRenaming(it.id); setDraft(it.name); }}>Rename</button>
                  <button className="btn" onClick={() => void run(() => duplicateEntry(it.id))}>Duplicate</button>
                  <button
                    className="btn"
                    onClick={() => {
                      if (!window.confirm(`Delete “${it.name}”? This can’t be undone.`)) return;
                      void run(async () => {
                        await deleteEntry(it.id);
                        if (it.id === currentId) st().detachLibrary();
                      });
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}
