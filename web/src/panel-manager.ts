// Panel manager: owns the open/close state of the docked side panels and
// guarantees at most one panel is open at a time.
//
// The app has two kinds of panels:
//   - tool panels (calibration / sketch / mask / measure / text), whose open state is the
//     controller's `active` flag (they also change the canvas cursor and input
//     routing), and
//   - utility panels (pages / account), whose open state is the element's
//     `hidden` flag.
//
// A panel's open state is *derived* from the registered handle (not stored
// twice), so a controller that deactivates itself (e.g. the sketch panel's
// close button) stays consistent without the manager being notified.

export type PanelId = 'calibration' | 'sketch' | 'mask' | 'measure' | 'text' | 'adjust' | 'pages' | 'account';

export interface PanelHandle {
  isOpen(): boolean;
  open(): void;
  close(): void;
}

export class PanelManager {
  private readonly panels = new Map<PanelId, PanelHandle>();
  private onChange: (openId: PanelId | null) => void = () => {};

  register(id: PanelId, handle: PanelHandle): void {
    this.panels.set(id, handle);
  }

  /** Observe open/close changes (fired once after each open/close/toggle). */
  setOnChange(cb: (openId: PanelId | null) => void): void {
    this.onChange = cb;
  }

  isOpen(id: PanelId): boolean {
    return this.panels.get(id)?.isOpen() ?? false;
  }

  /** Close every open panel except `id` (idempotent). */
  private closeAll(except?: PanelId): void {
    for (const [id, handle] of this.panels) {
      if (id !== except && handle.isOpen()) handle.close();
    }
  }

  open(id: PanelId): void {
    this.closeAll(id);
    this.panels.get(id)?.open();
    this.onChange(this.openId);
  }

  close(id: PanelId): void {
    this.panels.get(id)?.close();
    this.onChange(this.openId);
  }

  toggle(id: PanelId): void {
    if (this.isOpen(id)) this.close(id);
    else this.open(id);
  }

  /** The id of the currently open panel, if any. */
  get openId(): PanelId | null {
    for (const [id, handle] of this.panels) {
      if (handle.isOpen()) return id;
    }
    return null;
  }
}
