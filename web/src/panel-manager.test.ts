import { describe, expect, it } from 'vitest';
import { PanelManager, type PanelHandle } from './panel-manager';

interface MockPanel extends PanelHandle {
  opened: boolean;
  openCalls: number;
  closeCalls: number;
}

function handle(): MockPanel {
  return {
    opened: false,
    openCalls: 0,
    closeCalls: 0,
    isOpen() {
      return this.opened;
    },
    open() {
      this.opened = true;
      this.openCalls += 1;
    },
    close() {
      this.opened = false;
      this.closeCalls += 1;
    },
  };
}

describe('PanelManager', () => {
  it('opens a panel and reports it as open', () => {
    const m = new PanelManager();
    const a = handle();
    m.register('sketch', a);
    m.open('sketch');
    expect(a.opened).toBe(true);
    expect(m.isOpen('sketch')).toBe(true);
    expect(m.openId).toBe('sketch');
  });

  it('guarantees at most one panel open at a time', () => {
    const m = new PanelManager();
    const a = handle();
    const b = handle();
    const c = handle();
    m.register('sketch', a);
    m.register('mask', b);
    m.register('pages', c);

    m.open('sketch');
    m.open('mask');
    m.open('pages');
    expect(a.opened).toBe(false);
    expect(b.opened).toBe(false);
    expect(c.opened).toBe(true);
    expect(m.openId).toBe('pages');
  });

  it('toggle closes an open panel and opens a closed one', () => {
    const m = new PanelManager();
    const a = handle();
    m.register('account', a);

    m.toggle('account');
    expect(a.opened).toBe(true);
    m.toggle('account');
    expect(a.opened).toBe(false);
    expect(m.openId).toBe(null);
  });

  it('closing one panel leaves others closed', () => {
    const m = new PanelManager();
    const a = handle();
    const b = handle();
    m.register('sketch', a);
    m.register('mask', b);

    m.open('sketch');
    m.close('sketch');
    expect(a.opened).toBe(false);
    expect(b.opened).toBe(false);
    expect(m.openId).toBe(null);
  });

  it('derives open state from handles (self-close stays consistent)', () => {
    const m = new PanelManager();
    const a = handle();
    m.register('sketch', a);

    m.open('sketch');
    // A controller closing itself without notifying the manager.
    a.opened = false;
    expect(m.isOpen('sketch')).toBe(false);
    expect(m.openId).toBe(null);
  });
});
