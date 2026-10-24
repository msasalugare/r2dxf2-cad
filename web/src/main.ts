import './styles/tokens.css';
import './styles/global.css';
import { detectLocale, t } from './i18n';
import { initTheme, toggleTheme } from './theme';
import { initViewer } from './viewer';

const locale = detectLocale(navigator.language);
const theme = initTheme();

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <canvas id="viewer" aria-hidden="true"></canvas>

  <main class="start-card" role="main" aria-labelledby="title">
    <h1 id="title" class="title">${t(locale, 'app.title')}</h1>
    <p class="tagline">${t(locale, 'app.tagline')}</p>
    <div class="actions">
      <button id="open-btn" class="btn btn-primary" type="button">
        ${t(locale, 'start.open')}
      </button>
      <button id="sample-btn" class="btn" type="button">
        ${t(locale, 'start.sample')}
      </button>
    </div>
    <p class="privacy">${t(locale, 'start.privacy')}</p>
  </main>

  <button id="theme-btn" class="icon-btn" type="button"
    aria-label="${t(locale, 'theme.toggle')}" title="${t(locale, 'theme.toggle')}">
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <circle cx="12" cy="12" r="5"></circle>
      <g stroke-linecap="round">
        <line x1="12" y1="1" x2="12" y2="4"></line>
        <line x1="12" y1="20" x2="12" y2="23"></line>
        <line x1="4.22" y1="4.22" x2="6.34" y2="6.34"></line>
        <line x1="17.66" y1="17.66" x2="19.78" y2="19.78"></line>
        <line x1="1" y1="12" x2="4" y2="12"></line>
        <line x1="20" y1="12" x2="23" y2="12"></line>
        <line x1="4.22" y1="19.78" x2="6.34" y2="17.66"></line>
        <line x1="17.66" y1="6.34" x2="19.78" y2="4.22"></line>
      </g>
    </svg>
  </button>

  <footer class="status-bar" role="status" aria-live="polite">
    <span id="status" class="status-text">${t(locale, 'status.ready')}</span>
  </footer>
`;

initViewer(document.querySelector<HTMLCanvasElement>('#viewer')!);

document.querySelector('#theme-btn')!.addEventListener('click', () => {
  toggleTheme();
});

const status = document.querySelector<HTMLSpanElement>('#status')!;
const setStatus = (msg: string): void => {
  status.textContent = msg;
};

// Placeholder actions for M0 — real import/sample land in M1.
document.querySelector('#open-btn')!.addEventListener('click', () => {
  setStatus(t(locale, 'status.loading'));
});
document.querySelector('#sample-btn')!.addEventListener('click', () => {
  setStatus(t(locale, 'status.loading'));
});

// Drag-and-drop across the whole window (M1 wires the actual import).
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth += 1;
  document.body.classList.add('is-dragging');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) document.body.classList.remove('is-dragging');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('is-dragging');
  if (e.dataTransfer?.files.length) {
    setStatus(t(locale, 'start.drop'));
  }
});

// Expose for the e2e smoke test to assert the boot path completed.
document.documentElement.dataset.booted = 'true';
void theme;
