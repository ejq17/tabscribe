import { lazy, Suspense } from 'react';
import { useStore } from './store';
import './ui/ui.css';
import TopBar from './ui/TopBar';
import Transport from './ui/Transport';
import Settings from './ui/Settings';
import WarningsBar from './ui/WarningsBar';
import TabView from './ui/TabView';
import StrumChart from './ui/StrumChart';
import SourcePane from './ui/SourcePane';
import { DropOverlay, EmptyState, ErrorNote, ProgressCard } from './ui/FileDrop';
import { useKeyboard } from './ui/useKeyboard';

const NotationView = lazy(() => import('./ui/NotationView'));

export default function App() {
  useKeyboard();
  const score = useStore((s) => s.score);
  const view = useStore((s) => s.view);
  const hasSource = !!score?.meta.sourcePages?.length;
  const split = view.showSource && hasSource;

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
            {split && <SourcePane />}
          </div>
        )}
      </main>
      <Transport />
      <Settings />
    </div>
  );
}
