// Application controller: wires the DOM, raster viewer, import pipeline, and
// IndexedDB autosave together. No UI framework — plain DOM + Canvas.

import { Autosave, type AutosaveMeta } from './autosave';
import { CalibrationController } from './calibration-ui';
import { MaskController } from './mask-ui';
import { SketchController } from './sketch-ui';
import { IdbStore, MemoryKv, openDatabase } from './idb';
import { detectLocale, t, tf, type Locale } from './i18n';
import { Importer, type ImportDocument, type ImportErrorCode } from './import';
import { blobToBytes, bytesToBlob, unzipProject, zipProject } from './project';
import type { RasterPage } from './raster';
import { initTheme, toggleTheme } from './theme';
import { RasterViewer } from './viewer';

export function initApp(): () => void {
  const app = document.querySelector<HTMLDivElement>('#app');
  if (!app) return () => {};

  const locale: Locale = detectLocale(navigator.language);
  initTheme();

  app.innerHTML = markup(locale);

  const canvas = document.querySelector<HTMLCanvasElement>('#viewer')!;
  const startCard = document.querySelector<HTMLElement>('.start-card')!;
  const toolbar = document.querySelector<HTMLElement>('.toolbar')!;
  const pageNav = document.querySelector<HTMLElement>('#page-nav')!;
  const pagesPanel = document.querySelector<HTMLElement>('#pages-panel')!;
  const pagesList = document.querySelector<HTMLElement>('#pages-list')!;
  const autosavePrompt = document.querySelector<HTMLElement>('#autosave-prompt')!;
  const calibrationPanel = document.querySelector<HTMLElement>('#calibration-panel')!;
  const sketchPanel = document.querySelector<HTMLElement>('#sketch-panel')!;
  const maskPanel = document.querySelector<HTMLElement>('#mask-panel')!;
  const fileInput = document.querySelector<HTMLInputElement>('#file-input')!;
  const projectInput = document.querySelector<HTMLInputElement>('#project-input')!;
  const status = document.querySelector<HTMLElement>('#status')!;
  const coords = document.querySelector<HTMLElement>('#coords')!;
  const zoom = document.querySelector<HTMLElement>('#zoom')!;

  const viewer = new RasterViewer(canvas);
  const importer = new Importer();

  let kv: IdbStore | MemoryKv;
  let autosave: Autosave | null = null;
  let doc: ImportDocument | null = null;
  let activePage: RasterPage | null = null;
  let pageIndex = 0;
  let originalBlob: Blob | null = null;

  const setStatus = (msg: string, isError = false): void => {
    status.textContent = msg;
    status.classList.toggle('is-error', isError);
  };

  const calibration = new CalibrationController(
    viewer,
    calibrationPanel,
    locale,
    setStatus,
    () => (activePage ? { width: activePage.meta.width, height: activePage.meta.height } : null),
  );

  const mask = new MaskController(viewer, maskPanel, locale, setStatus);

  const sketch = new SketchController(
    viewer,
    sketchPanel,
    locale,
    setStatus,
    async () => {
      if (!activePage) return null;
      try {
        return await importer.getGray(activePage.meta.pageIndex);
      } catch {
        return null;
      }
    },
    () => mask.getStrokes(),
  );

  const refreshZoom = (): void => {
    zoom.textContent = tf(locale, 'status.zoom', {
      z: Math.round(viewer.getCamera().zoom * 100),
    });
  };

  viewer.onCameraChange = refreshZoom;
  viewer.onOverlay = (ctx) => {
    calibration.drawOverlay(ctx);
    sketch.drawOverlay(ctx);
    mask.drawOverlay(ctx);
  };
  viewer.onClick = (clientX, clientY) => {
    if (calibration.isActive()) return calibration.handleClick(clientX, clientY);
    if (sketch.isActive()) return sketch.handleClick(clientX, clientY);
    return false;
  };
  viewer.onDrag = (clientX, clientY, phase) => {
    if (mask.isActive()) return mask.handleDrag(clientX, clientY, phase);
    return false;
  };

  canvas.addEventListener('pointermove', (e) => {
    const p = viewer.clientToWorld(e.clientX, e.clientY);
    coords.textContent = tf(locale, 'status.coords', {
      x: Math.round(p.x),
      y: Math.round(p.y),
    });
    const rect = canvas.getBoundingClientRect();
    calibration.setLastMouse(e.clientX - rect.left, e.clientY - rect.top);
  });

  const saveSession = (blob: Blob, meta: AutosaveMeta): void => {
    if (!autosave) return;
    document.documentElement.removeAttribute('data-autosaved');
    void autosave.save(blob, meta).then(() => {
      document.documentElement.dataset.autosaved = 'true';
    });
  };

  const errorMessage = (code: ImportErrorCode): string => {
    switch (code) {
      case 'too-large':
        return t(locale, 'error.tooLarge');
      case 'encrypted':
        return t(locale, 'error.encrypted');
      case 'corrupt':
        return t(locale, 'error.corrupt');
      case 'unsupported':
        return t(locale, 'error.unsupported');
      default:
        return t(locale, 'error.failed');
    }
  };

  const showDocument = (nextDoc: ImportDocument, page: RasterPage, index: number, blob: Blob | null): void => {
    doc = nextDoc;
    activePage = page;
    pageIndex = index;
    originalBlob = blob;

    viewer.setPage(page);
    startCard.hidden = true;
    toolbar.hidden = false;
    pageNav.hidden = nextDoc.pageCount <= 1;
    calibration.deactivate();
    sketch.deactivate();
    mask.deactivate();
    renderPagesList(nextDoc.pageCount, index);
    document.documentElement.dataset.raster = 'loaded';
    document.documentElement.dataset.pageCount = String(nextDoc.pageCount);

    setStatus(tf(locale, 'status.page', { n: index + 1, total: nextDoc.pageCount }));
    refreshZoom();

    if (blob) {
      saveSession(blob, autosaveMeta(nextDoc, index));
    }
  };

  const showPage = async (index: number): Promise<void> => {
    if (!doc) return;
    if (index === pageIndex && activePage) return;
    if (index < 0 || index >= doc.pageCount) return;

    setStatus(t(locale, 'status.importing'));
    try {
      const page = doc.kind === 'pdf' ? await importer.openPdfPage(index + 1) : activePage;
      if (!page) return;
      const previous = pageIndex;
      pageIndex = index;
      activePage = page;
      importer.freeGray(previous);
      viewer.setPage(page);
      renderPagesList(doc.pageCount, index);
      setStatus(tf(locale, 'status.page', { n: index + 1, total: doc.pageCount }));
      if (originalBlob) {
        saveSession(originalBlob, autosaveMeta(doc, index));
      }
    } catch {
      setStatus(t(locale, 'error.failed'), true);
    }
  };

  const renderPagesList = (count: number, active: number): void => {
    pagesList.textContent = '';
    for (let i = 0; i < count; i += 1) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pages-item';
      btn.textContent = String(i + 1);
      btn.setAttribute('aria-current', i === active ? 'page' : 'false');
      btn.addEventListener('click', () => void showPage(i));
      li.appendChild(btn);
      pagesList.appendChild(li);
    }
  };

  const importFromFile = async (file: File): Promise<void> => {
    setStatus(t(locale, 'status.importing'));
    const result = await importer.importFile(file);
    if (!result.ok) {
      setStatus(errorMessage(result.code), true);
      return;
    }
    showDocument(result.doc, result.page, 0, file);
  };

  const importSample = async (): Promise<void> => {
    setStatus(t(locale, 'status.importing'));
    const result = await importer.importSample();
    if (!result.ok) {
      setStatus(errorMessage(result.code), true);
      return;
    }
    showDocument(result.doc, result.page, 0, null);
  };

  const continueAutosave = async (): Promise<void> => {
    if (!autosave) return;
    const record = await autosave.load();
    autosavePrompt.hidden = true;
    if (!record) return;
    const file = new File([record.blob], record.meta.fileName, { type: record.blob.type });
    setStatus(t(locale, 'status.importing'));
    const result = await importer.importFile(file);
    if (!result.ok) {
      setStatus(errorMessage(result.code), true);
      return;
    }
    showDocument(result.doc, result.page, 0, file);
    if (record.meta.pageIndex > 0) {
      await showPage(record.meta.pageIndex);
    }
  };

  // --- Event wiring -------------------------------------------------------
  document.querySelector('#open-btn')!.addEventListener('click', () => fileInput.click());
  document.querySelector('#toolbar-open')!.addEventListener('click', () => fileInput.click());
  document.querySelector('#sample-btn')!.addEventListener('click', () => void importSample());
  document.querySelector('#fit-btn')!.addEventListener('click', () => viewer.fit());
  document.querySelector('#zoom-out-btn')!.addEventListener('click', () => viewer.zoomBy(1 / 1.25));
  document.querySelector('#zoom-in-btn')!.addEventListener('click', () => viewer.zoomBy(1.25));
  document.querySelector('#calibrate-btn')!.addEventListener('click', () => {
    if (!activePage) {
      setStatus(t(locale, 'calibrate.result.none'), true);
      return;
    }
    if (calibration.isActive()) calibration.deactivate();
    else {
      sketch.deactivate();
      mask.deactivate();
      calibration.activate();
    }
  });
  document.querySelector('#sketch-btn')!.addEventListener('click', () => {
    if (!activePage) {
      setStatus(t(locale, 'sketch.none'), true);
      return;
    }
    if (sketch.isActive()) sketch.deactivate();
    else {
      calibration.deactivate();
      mask.deactivate();
      sketch.activate();
    }
  });
  document.querySelector('#mask-btn')!.addEventListener('click', () => {
    if (!activePage) {
      setStatus(t(locale, 'mask.hint'), true);
      return;
    }
    if (mask.isActive()) mask.deactivate();
    else {
      calibration.deactivate();
      sketch.deactivate();
      mask.activate();
    }
  });
  document.querySelector('#save-project')!.addEventListener('click', () => void saveProject());
  document.querySelector('#open-project')!.addEventListener('click', () => projectInput.click());
  document.querySelector('#prev-btn')!.addEventListener('click', () => void showPage(pageIndex - 1));
  document.querySelector('#next-btn')!.addEventListener('click', () => void showPage(pageIndex + 1));
  document.querySelector('#pages-toggle')!.addEventListener('click', () => {
    pagesPanel.hidden = !pagesPanel.hidden;
  });
  document.querySelector('#continue-btn')!.addEventListener('click', () => void continueAutosave());
  document.querySelector('#discard-btn')!.addEventListener('click', () => {
    autosavePrompt.hidden = true;
    void autosave?.clear();
  });

  document.querySelector('#theme-btn')!.addEventListener('click', () => toggleTheme());

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) void importFromFile(file);
    fileInput.value = '';
  });

  const saveProject = async (): Promise<void> => {
    if (!originalBlob || !doc) {
      setStatus(t(locale, 'error.failed'), true);
      return;
    }
    try {
      const raster = await blobToBytes(originalBlob);
      const zip = zipProject(
        { version: 1, savedAt: Date.now(), fileName: doc.fileName, kind: doc.kind, pageIndex },
        raster,
      );
      const blob = bytesToBlob(zip, 'application/zip');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${doc.fileName}.rasterfit.zip`;
      a.click();
      URL.revokeObjectURL(url);
      setStatus(t(locale, 'project.saved'));
    } catch {
      setStatus(t(locale, 'error.failed'), true);
    }
  };

  const openProject = async (file: File): Promise<void> => {
    try {
      const { data, raster } = unzipProject(await blobToBytes(file));
      const rasterFile = new File([raster as BlobPart], data.fileName);
      setStatus(t(locale, 'status.importing'));
      const result = await importer.importFile(rasterFile);
      if (!result.ok) {
        setStatus(errorMessage(result.code), true);
        return;
      }
      showDocument(result.doc, result.page, 0, rasterFile);
      if (data.pageIndex > 0) await showPage(data.pageIndex);
    } catch {
      setStatus(t(locale, 'error.failed'), true);
    }
  };

  projectInput.addEventListener('change', () => {
    const file = projectInput.files?.[0];
    if (file) void openProject(file);
    projectInput.value = '';
  });

  // Drag-and-drop across the whole window.
  let dragDepth = 0;
  const dragEnter = (e: DragEvent): void => {
    e.preventDefault();
    dragDepth += 1;
    document.body.classList.add('is-dragging');
  };
  const dragOver = (e: DragEvent): void => e.preventDefault();
  const dragLeave = (): void => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) document.body.classList.remove('is-dragging');
  };
  const drop = (e: DragEvent): void => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('is-dragging');
    const file = e.dataTransfer?.files[0];
    if (file) void importFromFile(file);
  };
  window.addEventListener('dragenter', dragEnter);
  window.addEventListener('dragover', dragOver);
  window.addEventListener('dragleave', dragLeave);
  window.addEventListener('drop', drop);

  // Keyboard: zoom and fit.
  const keydown = (e: KeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === '+' || e.key === '=') viewer.zoomBy(1.25);
    else if (e.key === '-') viewer.zoomBy(1 / 1.25);
    else if (e.key === '0') viewer.fit();
  };
  window.addEventListener('keydown', keydown);

  // --- Boot: autosave prompt ---------------------------------------------
  void (async () => {
    try {
      const db = await openDatabase();
      kv = new IdbStore(db);
    } catch {
      kv = new MemoryKv();
      setStatus(t(locale, 'autosave.unavailable'));
    }
    autosave = new Autosave(kv);
    if (await autosave.peek()) {
      autosavePrompt.hidden = false;
    }
  })();

  document.documentElement.dataset.booted = 'true';

  return () => {
    viewer.destroy();
    importer.dispose();
    window.removeEventListener('dragenter', dragEnter);
    window.removeEventListener('dragover', dragOver);
    window.removeEventListener('dragleave', dragLeave);
    window.removeEventListener('drop', drop);
    window.removeEventListener('keydown', keydown);
  };
}

function autosaveMeta(doc: ImportDocument, pageIndex: number): AutosaveMeta {
  return {
    version: 1,
    kind: doc.kind,
    fileName: doc.fileName,
    pageIndex,
    pageCount: doc.pageCount,
    savedAt: Date.now(),
  };
}

function markup(locale: Locale): string {
  return `
  <canvas id="viewer" aria-label="RasterFit viewer"></canvas>

  <main class="start-card" role="main" aria-labelledby="title">
    <h1 id="title" class="title">${t(locale, 'app.title')}</h1>
    <p class="tagline">${t(locale, 'app.tagline')}</p>
    <div class="actions">
      <button id="open-btn" class="btn btn-primary" type="button">${t(locale, 'start.open')}</button>
      <button id="sample-btn" class="btn" type="button">${t(locale, 'start.sample')}</button>
    </div>
    <p class="privacy">${t(locale, 'start.privacy')}</p>
  </main>

  <div class="toolbar" role="toolbar" aria-label="Viewer" hidden>
    <button id="toolbar-open" class="tool-btn" type="button" title="${t(locale, 'start.open')}">${t(locale, 'start.open')}</button>
    <span class="toolbar-spacer"></span>
    <button id="calibrate-btn" class="tool-btn" type="button">${t(locale, 'toolbar.calibrate')}</button>
    <button id="sketch-btn" class="tool-btn" type="button">${t(locale, 'toolbar.sketch')}</button>
    <button id="mask-btn" class="tool-btn" type="button">${t(locale, 'toolbar.mask')}</button>
    <span class="toolbar-spacer"></span>
    <button id="save-project" class="tool-btn" type="button">${t(locale, 'project.save')}</button>
    <button id="open-project" class="tool-btn" type="button">${t(locale, 'project.open')}</button>
    <span class="toolbar-spacer"></span>
    <button id="zoom-out-btn" class="tool-btn" type="button" title="${t(locale, 'viewer.zoomOut')}">−</button>
    <button id="fit-btn" class="tool-btn" type="button" title="${t(locale, 'viewer.fit')}">${t(locale, 'viewer.fit')}</button>
    <button id="zoom-in-btn" class="tool-btn" type="button" title="${t(locale, 'viewer.zoomIn')}">+</button>
    <span class="toolbar-spacer"></span>
    <span id="page-nav" class="page-nav" hidden>
      <button id="prev-btn" class="tool-btn" type="button" title="${t(locale, 'pages.prev')}">‹</button>
      <button id="pages-toggle" class="tool-btn" type="button">${t(locale, 'pages.title')}</button>
      <button id="next-btn" class="tool-btn" type="button" title="${t(locale, 'pages.next')}">›</button>
    </span>
  </div>

  <aside class="panel" id="pages-panel" aria-label="${t(locale, 'pages.title')}" hidden>
    <h2 class="panel-title">${t(locale, 'pages.title')}</h2>
    <ol class="pages-list" id="pages-list"></ol>
  </aside>

  <aside class="panel panel-wide" id="calibration-panel" aria-label="${t(locale, 'calibrate.title')}" hidden></aside>

  <aside class="panel panel-wide" id="sketch-panel" aria-label="${t(locale, 'sketch.title')}" hidden></aside>

  <aside class="panel panel-wide" id="mask-panel" aria-label="${t(locale, 'mask.title')}" hidden></aside>

  <div class="autosave-prompt" id="autosave-prompt" role="alertdialog" aria-labelledby="autosave-text" hidden>
    <p id="autosave-text">${t(locale, 'autosave.prompt')}</p>
    <div class="autosave-actions">
      <button id="continue-btn" class="btn btn-primary" type="button">${t(locale, 'autosave.continue')}</button>
      <button id="discard-btn" class="btn" type="button">${t(locale, 'autosave.discard')}</button>
    </div>
  </div>

  <button id="theme-btn" class="icon-btn" type="button" aria-label="${t(locale, 'theme.toggle')}" title="${t(locale, 'theme.toggle')}">
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
    <span class="status-spacer"></span>
    <span id="coords" class="status-text"></span>
    <span id="zoom" class="status-text status-zoom"></span>
  </footer>

  <input id="file-input" type="file" hidden
    accept=".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/png,image/jpeg,image/webp" />
  <input id="project-input" type="file" hidden accept=".rasterfit.zip,application/zip" />
  `;
}
