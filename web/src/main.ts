import './styles/tokens.css';
import './styles/global.css';
import { initApp } from './app';
import { loadWasm } from './wasm';

initApp();

// Load the Rust core lazily; expose success for diagnostics/e2e.
void loadWasm()
  .then((wasm) => {
    document.documentElement.dataset.wasm = 'loaded';
    document.documentElement.dataset.coreVersion = wasm.core_version();
  })
  .catch((err) => {
    console.error('wasm load failed', err);
    document.documentElement.dataset.wasm = 'failed';
  });
