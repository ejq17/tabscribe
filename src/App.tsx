import { lazy, Suspense, useEffect } from 'react';
import { startAutosave, useStore } from './store';
import Library from './ui/Library';
import './ui/ui.css';
import TopBar from './ui/TopBar';
import Transport from './ui/Transport';
import Settings from './ui/Settings';
import WarningsBar from './ui/WarningsBar';
import TabView from './ui/TabView';
import StrumChart from './ui/StrumChart';
import SourcePane from './ui/SourcePane';
import VideoPanel from './ui/VideoPanel';
import { useUi } from './ui/uiStore';
import { DropOverlay, EmptyState, ErrorNote, ProgressCard } from './ui/FileDrop';
import { useKeyboard } from './ui/useKeyboard';

const NotationView = lazy(() => import('./ui/NotationView'));

export default function App() {
  useKeyboard();
  useEffect(() => {
    const stop = startAutosave();
    void useStore.getState().restoreLastTab();
    return stop;
  }, []);
  const score = useStore((s) => s.score);
  const view = useStore((s) => s.view);
  const hasSource = !!score?.meta.sourcePages?.length;
  const videoOpen = useUi((s) => s.videoOpen);
  const showSourcePane = view.showSource && hasSource;
  const split = showSourcePane || videoOpen;
  const attachedId = score?.meta.video?.youtubeId;
  useEffect(() => {
    if (attachedId) useUi.getState().setVideoOpen(true);
  }, [attachedId]);

  return (
    <div className="app">
      <DropOverlay />
      <TopBar />
      <ErrorNote />
      <WarningsBar />
      <ProgressCard />
      <main className="scroll-area" id="main">
        {!score ? (
          <EmptyState />
        ) : (
          <div className={`workspace${split ? ' split' : ''}`}>
            <div className="doc">
              {view.mode === 'strum' ? <StrumChart /> : <TabView />}
              {view.showNotation && view.mode === 'tab' && (
                <Suspense fallback={<p className="muted pad">Loading notation…</p>}>
                  <NotationView />
                </Suspense>
              )}
            </div>
            {split && (
              <div className="side-col">
                {videoOpen && <VideoPanel />}
                {showSourcePane && <SourcePane />}
              </div>
            )}
          </div>
        )}
      </main>
      <Transport />
      <Settings />
      <Library />
    </div>
  );
}
