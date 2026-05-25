import { useState } from 'react';
import DataExplorer from './components/explorer/DataExplorer';
import EpsteinApp from './EpsteinApp';

type Mode = 'explorer' | 'epstein';

// Epstein viewer requires the local api_server.ts backend, so only expose its
// toggle in dev. Production builds (e.g. GitHub Pages) lock into the generic
// Data Explorer mode.
const ALLOW_EPSTEIN_MODE = import.meta.env.DEV;

function App() {
  const [mode, setMode] = useState<Mode>('explorer');

  if (ALLOW_EPSTEIN_MODE && mode === 'epstein') {
    return <EpsteinApp onSwitchMode={() => setMode('explorer')} />;
  }

  return (
    <DataExplorer
      onSwitchMode={ALLOW_EPSTEIN_MODE ? () => setMode('epstein') : undefined}
    />
  );
}

export default App;
