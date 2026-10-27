// Application controller: wires the DOM, raster viewer, import pipeline,
// per-page workspace persistence, and IndexedDB autosave together.
// No UI framework — plain DOM + Canvas.

import { AccountController } from './account';
import { AdjustController } from './adjust-ui';
import { Autosave, type AutosaveMeta } from './autosave';
import {
  checkNativeBackend,
  getActiveRasterSession,
  renderBackendPdfPage,
  uploadRasterToBackend,
} from './backend';
import { CalibrationController } from './calibration-ui';
import { MaskController } from './mask-ui';
import { PanelManager } from './panel-manager';
import { SketchController } from './sketch-ui';
import { IdbStore, MemoryKv, openDatabase } from './idb';
import { detectLocale, t, tf, type Locale } from './i18n';
import { Importer, type ImportDocument, type ImportErrorCode } from './import';
import {
  blobToBytes,
  bytesToBlob,
  hashBytes,
  unzipProject,
  zipProject,
  type PageWorkspaceState,
} from './project';
import type { RasterPage } from './raster';
import { createSampleBlob } from './sample';
import { MAX_IMPORT_BYTES, sniffBlob } from './sniff';
import { toggleTheme } from './theme';
import { RasterViewer } from './viewer';

type ShellState = 'signed-out' | 'empty' | 'importing' | 'ready' | 'editing';

export function initApp(): () => void {
  const app = document.querySelector<HTMLDivElement>('#app');
  if (!app) return () => {};

  const locale: Locale = detectLocale(navigator.language);

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
  const adjustPanel = document.querySelector<HTMLElement>('#adjust-panel')!;
  const accountBtn = document.querySelector<HTMLElement>('#account-btn')!;
  const accountPanel = document.querySelector<HTMLElement>('#account-panel')!;
  const authScreen = document.querySelector<HTMLElement>('#auth-screen')!;
  const fileInput = document.querySelector<HTMLInputElement>('#file-input')!;
  const projectInput = document.querySelector<HTMLInputElement>('#project-input')!;
  const status = document.querySelector<HTMLElement>('#status')!;
  const dofEl = document.querySelector<HTMLElement>('#dof')!;
  const coords = document.querySelector<HTMLElement>('#coords')!;
  const zoom = document.querySelector<HTMLElement>('#zoom')!;

  const viewer = new RasterViewer(canvas);
  const importer = new Importer();
  const account = new AccountController(authScreen, accountPanel, accountBtn, locale, (user) => {
    document.documentElement.dataset.user = user ? user.username : '';
    document.documentElement.dataset.auth = user ? 'signed-in' : 'signed-out';
    setState(user ? 'empty' : 'signed-out');
  });

  let kv: IdbStore | MemoryKv;
  let autosave: Autosave | null = null;
  let doc: ImportDocument | null = null;
  let activePage: RasterPage | null = null;
  let pageIndex = 0;
  let originalBlob: Blob | null = null;
  let pageWorkspaces: Record<number, PageWorkspaceState> = {};

  const setStatus = (msg: string, isError = false): void => {
    status.textContent = msg;
    status.classList.toggle('is-error', isError);
  };

  let state: ShellState = 'signed-out';

  // Single place that maps the shell state to visible chrome + default status.
  const setState = (next: ShellState): void => {
    if (next === state) return;
    state = next;
    document.documentElement.dataset.state = next;
    const hasDoc = next === 'ready' || next === 'editing';
    const showCard = next === 'empty' || next === 'importing';
    startCard.hidden = !showCard;
    toolbar.hidden = !hasDoc;
    switch (next) {
      case 'signed-out':
        setStatus('');
        break;
      case 'empty':
        setStatus(t(locale, 'start.drop'));
        break;
      case 'importing':
        setStatus(t(locale, 'status.importing'));
        break;
      case 'ready':
        setStatus(t(locale, 'status.ready'));
        break;
      case 'editing':
        break;
    }
  };

  const captureCurrentPageState = (): PageWorkspaceState => {
    const cal = calibration.exportState();
    const sk = sketch.exportState();
    return {
      rasterTransform: viewer.getRasterTransform(),
      calibrationSegments: cal.segments,
      calibrationScale: cal.scale,
      sketch: sk.sketch,
      maskStrokes: mask.exportState(),
      lastFitReportJson: sk.lastFitReportJson,
    };
  };

  const applyPageState = (state: PageWorkspaceState | undefined): void => {
    if (!state) {
      viewer.resetRasterTransform();
      calibration.importState({ segments: [] });
      sketch.importState({
        points: [],
        lines: [],
        circles: [],
        arcs: [],
        constraints: [],
        reference_constraints: [],
      });
      mask.importState([]);
      return;
    }
    viewer.setRasterTransform(state.rasterTransform);
    calibration.importState({
      segments: state.calibrationSegments ?? [],
      scale: state.calibrationScale,
    });
    sketch.importState(state.sketch, state.lastFitReportJson);
    mask.importState(state.maskStrokes ?? []);
  };

  const syncWorkspaceAndAutosave = (): void => {
    if (!doc) return;
    pageWorkspaces[pageIndex] = captureCurrentPageState();
    if (originalBlob) {
      saveSession(originalBlob, autosaveMeta(doc, pageIndex, pageWorkspaces));
    }
  };

  const calibration = new CalibrationController(
    viewer,
    calibrationPanel,
    locale,
    setStatus,
    () => (activePage ? { width: activePage.meta.width, height: activePage.meta.height } : null),
    syncWorkspaceAndAutosave,
  );

  let sketch: SketchController;

  const mask = new MaskController(
    viewer,
    maskPanel,
    locale,
    setStatus,
    () => sketch.getLineSegments(),
    syncWorkspaceAndAutosave,
  );

  sketch = new SketchController(
    viewer,
    sketchPanel,
    locale,
    setStatus,
    () => mask.getStrokes(),
    (dof, dofStatus) => {
      dofEl.textContent = tf(locale, 'status.dof', { dof });
      dofEl.dataset.status = dofStatus;
    },
    syncWorkspaceAndAutosave,
  );

  const adjust = new AdjustController(viewer, adjustPanel, locale, setStatus, async (session) => {
    if (!doc || !activePage) return;
    setStatus(t(locale, 'status.importing'));
    try {
      const page = await importer.buildFromServer(session);
      activePage = page;
      viewer.replacePage(page);
      preloadPageGray(page);
      refreshZoom();
      setStatus(tf(locale, 'status.page', { n: pageIndex + 1, total: doc.pageCount }));
    } catch {
      setStatus(errorMessage('failed'), true);
    }
  });

  // Centralized panel open/close state (at most one panel open at a time).
  const panels = new PanelManager();
  panels.register('calibration', {
    isOpen: () => calibration.isActive(),
    open: () => calibration.activate(),
    close: () => calibration.deactivate(),
  });
  panels.register('sketch', {
    isOpen: () => sketch.isActive(),
    open: () => sketch.activate(),
    close: () => sketch.deactivate(),
  });
  panels.register('mask', {
    isOpen: () => mask.isActive(),
    open: () => mask.activate(),
    close: () => mask.deactivate(),
  });
  panels.register('adjust', {
    isOpen: () => adjust.isActive(),
    open: () => adjust.activate(),
    close: () => adjust.deactivate(),
  });
  panels.register('pages', {
    isOpen: () => !pagesPanel.hidden,
    open: () => {
      pagesPanel.hidden = false;
    },
    close: () => {
      pagesPanel.hidden = true;
    },
  });
  panels.register('account', {
    isOpen: () => !accountPanel.hidden,
    open: () => {
      accountPanel.hidden = false;
    },
    close: () => {
      accountPanel.hidden = true;
    },
  });

  // A tool panel opening means editing; closing the last panel returns to the
  // ready (document loaded) or empty state.
  panels.setOnChange((openId) => {
    if (state === 'signed-out' || state === 'importing') return;
    const editing = openId === 'calibration' || openId === 'sketch' || openId === 'mask';
    setState(editing ? 'editing' : doc ? 'ready' : 'empty');
  });

  const refreshZoom = (): void => {
    zoom.textContent = tf(locale, 'status.zoom', {
      z: Math.round(viewer.getCamera().zoom * 100),
    });
  };

  const syncModeButtons = (): void => {
    const calBtn = document.querySelector<HTMLButtonElement>('#calibrate-btn');
    const skBtn = document.querySelector<HTMLButtonElement>('#sketch-btn');
    const mkBtn = document.querySelector<HTMLButtonElement>('#mask-btn');
    const adjBtn = document.querySelector<HTMLButtonElement>('#adjust-btn');
    if (calBtn) calBtn.setAttribute('aria-pressed', String(calibration.isActive()));
    if (skBtn) skBtn.setAttribute('aria-pressed', String(sketch.isActive()));
    if (mkBtn) mkBtn.setAttribute('aria-pressed', String(mask.isActive()));
    if (adjBtn) adjBtn.setAttribute('aria-pressed', String(adjust.isActive()));
    canvas.style.cursor = sketch.isActive()
      ? sketch.getCursor()
      : calibration.isActive() || mask.isActive()
        ? 'crosshair'
        : 'grab';
  };

  viewer.onCameraChange = refreshZoom;
  viewer.onOverlay = (ctx) => {
    syncModeButtons();
    calibration.drawOverlay(ctx);
    sketch.drawOverlay(ctx);
    mask.drawOverlay(ctx);
  };
  viewer.onClick = (clientX, clientY, altKey) => {
    if (calibration.isActive()) return calibration.handleClick(clientX, clientY, altKey);
    if (sketch.isActive()) return sketch.handleClick(clientX, clientY, altKey);
    if (mask.isActive()) return mask.handleClick(clientX, clientY);
    return false;
  };
  viewer.onDoubleClick = () => {
    if (sketch.isActive()) return sketch.finishChain();
    if (mask.isActive()) return mask.finishPolygon();
    return false;
  };
  viewer.onContextMenu = () => {
    if (calibration.isActive()) return calibration.cancelPending();
    if (sketch.isActive()) return sketch.finishChain();
    if (mask.isActive()) return mask.finishPolygon();
    return false;
  };
  viewer.onPointerHover = (clientX, clientY, altKey) => {
    const rect = canvas.getBoundingClientRect();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    calibration.setLastMouse(mx, my);
    sketch.setLastMouse(mx, my, altKey);
    mask.setLastMouse(mx, my);
  };
  viewer.onDrag = (clientX, clientY, phase) => {
    if (calibration.isActive()) return calibration.handleDrag(clientX, clientY, phase);
    if (mask.isActive()) return mask.handleDrag(clientX, clientY, phase);
    if (sketch.isActive()) return sketch.handleDrag(clientX, clientY, phase);
    return false;
  };

  // Clicking the canvas moves keyboard focus back to the viewer so shortcuts
  // (e.g. Delete/Backspace) aren't swallowed by a focused panel input/select.
  canvas.addEventListener('pointerdown', () => {
    const ae = document.activeElement;
    if (
      ae instanceof HTMLInputElement ||
      ae instanceof HTMLTextAreaElement ||
      ae instanceof HTMLSelectElement
    ) {
      ae.blur();
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    const p = viewer.clientToWorld(e.clientX, e.clientY);
    coords.textContent = tf(locale, 'status.coords', {
      x: p.x.toFixed(1),
      y: p.y.toFixed(1),
    });
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

  const preloadPageGray = (page: RasterPage): void => {
    void importer
      .getGray(page.meta.pageIndex)
      .then((g) => {
        calibration.setGrayBuffer(g);
        sketch.setGrayBuffer(g);
      })
      .catch(() => {
        calibration.setGrayBuffer(null);
        sketch.setGrayBuffer(null);
      });
  };

  const showDocument = (
    nextDoc: ImportDocument,
    page: RasterPage,
    index: number,
    blob: Blob | null,
    restoredPages?: Record<number, PageWorkspaceState>,
  ): void => {
    doc = nextDoc;
    activePage = page;
    pageIndex = index;
    originalBlob = blob;
    pageWorkspaces = restoredPages ? { ...restoredPages } : {};

    viewer.setPage(page);
    applyPageState(pageWorkspaces[index]);
    preloadPageGray(page);
    adjust.refresh();

    setState('ready');
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
      saveSession(blob, autosaveMeta(nextDoc, index, pageWorkspaces));
    }
  };

  const showPage = async (index: number): Promise<void> => {
    if (!doc) return;
    if (index === pageIndex && activePage) return;
    if (index < 0 || index >= doc.pageCount) return;

    // Persist current page state before switching.
    pageWorkspaces[pageIndex] = captureCurrentPageState();

    setStatus(t(locale, 'status.importing'));
    try {
      let page: RasterPage | null;
      if (doc.kind === 'pdf') {
        const rasterId = getActiveRasterSession()?.raster_id;
        if (!rasterId) throw new Error('No server raster session');
        const session = await renderBackendPdfPage(rasterId, index + 1, 200);
        if (!session) throw new Error('Failed to render page on server');
        page = await importer.buildFromServer(session);
      } else {
        page = activePage;
      }
      if (!page) return;
      const previous = pageIndex;
      pageIndex = index;
      activePage = page;
      importer.freeGray(previous);
      viewer.setPage(page);
      applyPageState(pageWorkspaces[index]);
      preloadPageGray(page);
      adjust.refresh();
      renderPagesList(doc.pageCount, index);
      setStatus(tf(locale, 'status.page', { n: index + 1, total: doc.pageCount }));
      if (originalBlob) {
        saveSession(originalBlob, autosaveMeta(doc, index, pageWorkspaces));
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
    setState('importing');
    if (file.size > MAX_IMPORT_BYTES) {
      setStatus(errorMessage('too-large'), true);
      return;
    }
    const kind = await sniffBlob(file);
    if (kind === 'unsupported') {
      setStatus(errorMessage('unsupported'), true);
      return;
    }
    // The server renders/decode the raster; the browser displays its PNG so the
    // sketch pixel frame always matches the server-side ridge frame.
    const session = await uploadRasterToBackend(file, file.name, 200, 1);
    if (!session) {
      setStatus(t(locale, 'error.server'), true);
      return;
    }
    try {
      const page = await importer.buildFromServer(session);
      showDocument(
        { kind: kind === 'pdf' ? 'pdf' : 'image', fileName: file.name, pageCount: session.page_count },
        page,
        0,
        file,
      );
    } catch {
      setStatus(errorMessage('failed'), true);
    }
  };

  const importSample = async (): Promise<void> => {
    setState('importing');
    try {
      const blob = await createSampleBlob();
      const session = await uploadRasterToBackend(blob, 'sample.png', 200, 1);
      if (!session) {
        setStatus(t(locale, 'error.server'), true);
        return;
      }
      const page = await importer.buildFromServer(session);
      showDocument({ kind: 'sample', fileName: 'sample', pageCount: 1 }, page, 0, null);
    } catch {
      setStatus(errorMessage('failed'), true);
    }
  };

  const continueAutosave = async (): Promise<void> => {
    if (!autosave) return;
    const record = await autosave.load();
    autosavePrompt.hidden = true;
    if (!record) return;
    const file = new File([record.blob], record.meta.fileName, { type: record.blob.type });
    setState('importing');
    const kind = await sniffBlob(file);
    const session = await uploadRasterToBackend(file, record.meta.fileName, 200, 1);
    if (!session) {
      setStatus(t(locale, 'error.server'), true);
      return;
    }
    try {
      const page = await importer.buildFromServer(session);
      showDocument(
        { kind: kind === 'pdf' ? 'pdf' : 'image', fileName: record.meta.fileName, pageCount: session.page_count },
        page,
        0,
        file,
        record.meta.pages,
      );
      if (record.meta.pageIndex > 0) await showPage(record.meta.pageIndex);
    } catch {
      setStatus(errorMessage('failed'), true);
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
    panels.toggle('calibration');
  });
  document.querySelector('#sketch-btn')!.addEventListener('click', () => {
    panels.toggle('sketch');
  });
  document.querySelector('#mask-btn')!.addEventListener('click', () => {
    if (!activePage) {
      setStatus(t(locale, 'mask.hint'), true);
      return;
    }
    panels.toggle('mask');
  });
  document.querySelector('#adjust-btn')!.addEventListener('click', () => {
    if (!activePage) {
      setStatus(t(locale, 'adjust.needsRaster'), true);
      return;
    }
    panels.toggle('adjust');
  });
  document.querySelector('#origin-tool-btn')!.addEventListener('click', () => {
    panels.open('sketch');
    sketch.setTool('origin');
  });
  document.querySelector('#origin-reset-btn')!.addEventListener('click', () => {
    viewer.resetOrigin();
    const o = viewer.getOrigin();
    setStatus(`(0,0) → (${o.x.toFixed(0)}, ${o.y.toFixed(0)}) px`);
  });
  document.querySelector('#save-project')!.addEventListener('click', () => void saveProject());
  document.querySelector('#open-project')!.addEventListener('click', () => projectInput.click());
  document.querySelector('#prev-btn')!.addEventListener('click', () => void showPage(pageIndex - 1));
  document.querySelector('#next-btn')!.addEventListener('click', () => void showPage(pageIndex + 1));
  document.querySelector('#pages-toggle')!.addEventListener('click', () => {
    panels.toggle('pages');
  });
  document.querySelector('#continue-btn')!.addEventListener('click', () => void continueAutosave());
  document.querySelector('#discard-btn')!.addEventListener('click', () => {
    autosavePrompt.hidden = true;
    void autosave?.clear();
  });

  document.querySelector('#theme-btn')!.addEventListener('click', () => toggleTheme());
  accountBtn.addEventListener('click', () => {
    panels.toggle('account');
  });

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) void importFromFile(file);
    fileInput.value = '';
  });

  const saveProject = async (): Promise<void> => {
    if (!doc) {
      setStatus(t(locale, 'error.failed'), true);
      return;
    }
    try {
      const blobToSave = originalBlob ?? (await createSampleBlob());
      const raster = await blobToBytes(blobToSave);
      pageWorkspaces[pageIndex] = captureCurrentPageState();
      const zip = zipProject(
        {
          version: 1,
          savedAt: Date.now(),
          fileName: doc.fileName,
          kind: doc.kind,
          pageIndex,
          rasterHash: hashBytes(raster),
          pages: pageWorkspaces,
        },
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
      setState('importing');
      const kind = await sniffBlob(rasterFile);
      const session = await uploadRasterToBackend(rasterFile, data.fileName, 200, 1);
      if (!session) {
        setStatus(t(locale, 'error.server'), true);
        return;
      }
      const page = await importer.buildFromServer(session);
      showDocument(
        { kind: kind === 'pdf' ? 'pdf' : 'image', fileName: data.fileName, pageCount: session.page_count },
        page,
        0,
        rasterFile,
        data.pages,
      );
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

  // Keyboard: tool shortcuts, zoom and fit.
  const keydown = (e: KeyboardEvent): void => {
    if (
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLTextAreaElement ||
      e.target instanceof HTMLSelectElement
    ) {
      return;
    }
    if (e.key === 'Escape' && calibration.isActive() && calibration.cancelPending()) return;
    if (mask.handleKey(e)) return;
    if (sketch.handleKey(e)) return;
    if (e.key === '+' || e.key === '=') viewer.zoomBy(1.25);
    else if (e.key === '-') viewer.zoomBy(1 / 1.25);
    else if (e.key === '0') viewer.fit();
  };
  window.addEventListener('keydown', keydown);

  // --- Boot: empty workspace + autosave check ---------------------------
  setState('empty');
  refreshZoom();
  void checkNativeBackend();
  void account.init();

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

function autosaveMeta(
  doc: ImportDocument,
  pageIndex: number,
  pages: Record<number, PageWorkspaceState>,
): AutosaveMeta {
  return {
    version: 1,
    kind: doc.kind,
    fileName: doc.fileName,
    pageIndex,
    pageCount: doc.pageCount,
    savedAt: Date.now(),
    pages: Object.keys(pages).length > 0 ? pages : undefined,
  };
}

function markup(locale: Locale): string {
  return `
  <header class="app-bar">
    <div class="toolbar" role="toolbar" aria-label="Viewer" hidden>
      <div class="toolbar-group">
        <button id="toolbar-open" class="tool-btn" type="button" title="${t(locale, 'start.open')}">${t(locale, 'start.open')}</button>
        <button id="save-project" class="tool-btn" type="button" title="${t(locale, 'project.save')}">${t(locale, 'project.save')}</button>
        <button id="open-project" class="tool-btn" type="button" title="${t(locale, 'project.open')}">${t(locale, 'project.open')}</button>
      </div>
      <span class="toolbar-divider" aria-hidden="true"></span>
      <div class="toolbar-group">
        <button id="calibrate-btn" class="tool-btn" type="button" title="${t(locale, 'toolbar.calibrate')} (C)">${t(locale, 'toolbar.calibrate')}</button>
        <button id="sketch-btn" class="tool-btn" type="button" title="${t(locale, 'toolbar.sketch')} (S)">${t(locale, 'toolbar.sketch')}</button>
        <button id="mask-btn" class="tool-btn" type="button" title="${t(locale, 'toolbar.mask')} (M)">${t(locale, 'toolbar.mask')}</button>
        <button id="adjust-btn" class="tool-btn" type="button" title="${t(locale, 'toolbar.adjust')}">${t(locale, 'toolbar.adjust')}</button>
      </div>
      <span class="toolbar-divider" aria-hidden="true"></span>
      <div class="toolbar-group">
        <button id="origin-tool-btn" class="tool-btn" type="button" title="Move (0,0) Coordinate System Origin">🎯 (0,0)</button>
        <button id="origin-reset-btn" class="tool-btn" type="button" title="Reset (0,0) to bottom-left corner of raster">↺ (0,0)</button>
      </div>
      <span class="toolbar-divider" aria-hidden="true"></span>
      <div class="toolbar-group">
        <button id="zoom-out-btn" class="tool-btn" type="button" title="${t(locale, 'viewer.zoomOut')} (-)">−</button>
        <button id="fit-btn" class="tool-btn" type="button" title="${t(locale, 'viewer.fit')} (0)">${t(locale, 'viewer.fit')}</button>
        <button id="zoom-in-btn" class="tool-btn" type="button" title="${t(locale, 'viewer.zoomIn')} (+)">+</button>
      </div>
      <span class="toolbar-divider" aria-hidden="true"></span>
      <span id="page-nav" class="page-nav" hidden>
        <button id="prev-btn" class="tool-btn" type="button" title="${t(locale, 'pages.prev')}">‹</button>
        <button id="pages-toggle" class="tool-btn" type="button">${t(locale, 'pages.title')}</button>
        <button id="next-btn" class="tool-btn" type="button" title="${t(locale, 'pages.next')}">›</button>
      </span>
    </div>
  </header>

  <div class="workspace">
    <canvas id="viewer" role="region" aria-label="${t(locale, 'workspace.label')}"></canvas>

    <aside class="panel" id="pages-panel" aria-label="${t(locale, 'pages.title')}" hidden>
      <h2 class="panel-title">${t(locale, 'pages.title')}</h2>
      <ol class="pages-list" id="pages-list"></ol>
    </aside>

    <aside class="panel" id="account-panel" aria-label="${t(locale, 'account.title')}" hidden></aside>

    <aside class="panel panel-wide" id="calibration-panel" aria-label="${t(locale, 'calibrate.title')}" hidden></aside>

    <aside class="panel panel-wide" id="sketch-panel" aria-label="${t(locale, 'sketch.title')}" hidden></aside>

    <aside class="panel panel-wide" id="mask-panel" aria-label="${t(locale, 'mask.title')}" hidden></aside>

    <aside class="panel panel-wide" id="adjust-panel" aria-label="${t(locale, 'adjust.title')}" hidden></aside>

    <main class="start-card" role="main" aria-labelledby="title">
      <h1 id="title" class="title">${t(locale, 'app.title')}</h1>
      <p class="tagline">${t(locale, 'app.tagline')}</p>
      <div class="actions">
        <button id="open-btn" class="btn btn-primary" type="button">${t(locale, 'start.open')}</button>
        <button id="sample-btn" class="btn" type="button">${t(locale, 'start.sample')}</button>
      </div>
      <p class="privacy">${t(locale, 'start.privacy')}</p>
    </main>

    <div class="autosave-prompt" id="autosave-prompt" role="alertdialog" aria-labelledby="autosave-text" hidden>
      <p id="autosave-text">${t(locale, 'autosave.prompt')}</p>
      <div class="autosave-actions">
        <button id="continue-btn" class="btn btn-primary" type="button">${t(locale, 'autosave.continue')}</button>
        <button id="discard-btn" class="btn" type="button">${t(locale, 'autosave.discard')}</button>
      </div>
    </div>
  </div>

  <button id="account-btn" class="icon-btn" type="button" aria-label="${t(locale, 'account.login')}" title="${t(locale, 'account.login')}">👤</button>

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

  <input id="file-input" type="file" hidden
    accept=".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/png,image/jpeg,image/webp" />
  <input id="project-input" type="file" hidden accept=".rasterfit.zip,application/zip" />

  <section class="auth-screen" id="auth-screen" aria-label="${t(locale, 'account.login')}"></section>

  <footer class="status-bar" aria-live="polite" aria-atomic="true">
    <span id="status" class="status-text">${t(locale, 'status.ready')}</span>
    <span class="status-spacer"></span>
    <span id="dof" class="status-text"></span>
    <span id="coords" class="status-text"></span>
    <span id="zoom" class="status-text status-zoom"></span>
  </footer>
  `;
}
