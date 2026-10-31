// Account / login + user management (superadmin defines users).
//
// This talks only to the native backend (`/api/auth/*`, `/api/users`). The app
// is server-only, so signing in is required to import and compute.

import { t, tf, type Locale } from './i18n';
import {
  createUser,
  deleteUser,
  getMe,
  listUsers,
  login,
  logout,
  updateUser,
  type AuthUser,
  type UserRow,
} from './backend';

export class AccountController {
  private user: AuthUser | null = null;
  private editingPwUserId: number | null = null;

  constructor(
    private readonly authScreen: HTMLElement,
    private readonly panel: HTMLElement,
    private readonly button: HTMLElement,
    private readonly locale: Locale,
    private readonly onAuthChange: (user: AuthUser | null) => void,
  ) {
    for (const host of [this.authScreen, this.panel]) {
      host.addEventListener('submit', (e) => void this.handleSubmit(e));
      host.addEventListener('click', (e) => void this.handleClick(e));
      host.addEventListener('change', (e) => void this.handleChange(e));
    }
  }

  async init(): Promise<void> {
    this.user = await getMe();
    this.render();
  }

  private setMessage(text: string): void {
    for (const host of [this.authScreen, this.panel]) {
      const el = host.querySelector<HTMLElement>('[data-account-msg]');
      if (el) el.textContent = text;
    }
  }

  private render(): void {
    const label = this.user
      ? `${this.user.username} (${this.user.role})`
      : t(this.locale, 'account.login');
    this.button.textContent = '👤';
    this.button.title = label;
    this.button.setAttribute('aria-label', label);
    this.onAuthChange(this.user);
    if (!this.user) {
      this.authScreen.innerHTML = this.authScreenMarkup();
      this.panel.innerHTML = '';
      // Move focus into the sign-in form for immediate keyboard entry.
      this.authScreen.querySelector<HTMLInputElement>('input[name="username"]')?.focus();
    } else {
      this.authScreen.innerHTML = '';
      this.panel.innerHTML = this.accountMarkup();
      if (this.user.role === 'superadmin') void this.renderUsers();
    }
  }

  private authScreenMarkup(): string {
    return `
      <div class="auth-brand">
        <span class="auth-logo">RasterFit</span>
        <span class="auth-byline">autor: Saša Mladenović &amp; DeepSeek</span>
      </div>
      <form data-action="login" class="account-form auth-login-form">
        <label>${t(this.locale, 'account.username')}
          <input name="username" autocomplete="username" required />
        </label>
        <label>${t(this.locale, 'account.password')}
          <input name="password" type="password" autocomplete="current-password" required />
        </label>
        <button type="submit" class="btn btn-primary">${t(this.locale, 'account.login')}</button>
      </form>
      <p class="account-msg" data-account-msg></p>`;
  }

  private accountMarkup(): string {
    return `
      <h2 class="panel-title">${t(this.locale, 'account.title')}</h2>
      <p class="panel-hint">${tf(this.locale, 'account.signedInAs', {
        user: this.user!.username,
        role: this.user!.role,
      })}</p>
      <button type="button" class="btn" data-action="logout">${t(this.locale, 'account.logout')}</button>
      <p class="account-msg" data-account-msg></p>
      <div data-users></div>`;
  }

  private async renderUsers(): Promise<void> {
    const host = this.panel.querySelector<HTMLElement>('[data-users]');
    if (!host) return;
    let users: UserRow[];
    try {
      users = await listUsers();
    } catch (err) {
      host.innerHTML = `<p class="panel-hint">${(err as Error).message}</p>`;
      return;
    }
    host.innerHTML = `
      <h3 class="panel-subhead">${t(this.locale, 'account.users')}</h3>
      <form data-action="create-user" class="account-form">
        <input name="username" placeholder="${t(this.locale, 'account.username')}" required />
        <input name="password" type="password" placeholder="${t(this.locale, 'account.password')}" required minlength="8" />
        <select name="role" aria-label="${t(this.locale, 'account.role')}">
          <option value="user">${t(this.locale, 'account.role.user')}</option>
          <option value="superadmin">${t(this.locale, 'account.role.superadmin')}</option>
        </select>
        <button type="submit" class="btn">${t(this.locale, 'account.addUser')}</button>
      </form>
      <ul class="account-users">
        ${users.map((u) => this.userRow(u)).join('')}
      </ul>`;
  }

  private userRow(u: UserRow): string {
    if (u.id === this.editingPwUserId) {
      return `
      <li class="account-user" data-id="${u.id}">
        <span class="account-username">${u.username}</span>
        <form data-action="set-pw" data-id="${u.id}" class="account-form">
          <input name="password" type="password" placeholder="${t(this.locale, 'account.password')}" required minlength="8" />
          <button type="submit" class="btn btn-primary">${t(this.locale, 'account.resetPwSave')}</button>
          <button type="button" class="btn" data-action="cancel-pw">${t(this.locale, 'account.cancel')}</button>
        </form>
      </li>`;
    }
    return `
      <li class="account-user" data-id="${u.id}">
        <span class="account-username">${u.username}</span>
        <select data-action="role" data-id="${u.id}" aria-label="${t(this.locale, 'account.role')}">
          <option value="user" ${u.role === 'user' ? 'selected' : ''}>${t(this.locale, 'account.role.user')}</option>
          <option value="superadmin" ${u.role === 'superadmin' ? 'selected' : ''}>${t(this.locale, 'account.role.superadmin')}</option>
        </select>
        <label class="account-active">
          <input type="checkbox" data-action="toggle-active" data-id="${u.id}" ${u.active ? 'checked' : ''} />
          ${t(this.locale, 'account.active')}
        </label>
        <button type="button" class="btn" data-action="reset-pw" data-id="${u.id}">${t(this.locale, 'account.resetPw')}</button>
        <button type="button" class="btn" data-action="delete-user" data-id="${u.id}">${t(this.locale, 'account.delete')}</button>
      </li>`;
  }

  private async handleSubmit(e: Event): Promise<void> {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    this.setMessage('');
    try {
      if (form.dataset.action === 'login') {
        const fd = new FormData(form);
        this.user = await login(String(fd.get('username') ?? ''), String(fd.get('password') ?? ''));
      } else if (form.dataset.action === 'create-user') {
        const fd = new FormData(form);
        await createUser(
          String(fd.get('username') ?? ''),
          String(fd.get('password') ?? ''),
          String(fd.get('role') ?? 'user'),
        );
      } else if (form.dataset.action === 'set-pw') {
        const fd = new FormData(form);
        await updateUser(Number(form.dataset.id), { password: String(fd.get('password') ?? '') });
        this.editingPwUserId = null;
      }
    } catch (err) {
      this.setMessage((err as Error).message);
      return;
    }
    this.render();
  }

  private async handleClick(e: Event): Promise<void> {
    const target = e.target as HTMLElement;
    const action = target.dataset.action;
    if (!action) return;
    this.setMessage('');
    if (action === 'reset-pw') {
      this.editingPwUserId = Number(target.dataset.id);
      await this.renderUsers();
      return;
    }
    if (action === 'cancel-pw') {
      this.editingPwUserId = null;
      await this.renderUsers();
      return;
    }
    try {
      if (action === 'logout') {
        await logout();
        this.user = null;
      } else if (action === 'delete-user') {
        await deleteUser(Number(target.dataset.id));
      } else {
        return;
      }
    } catch (err) {
      this.setMessage((err as Error).message);
      return;
    }
    this.render();
  }

  private async handleChange(e: Event): Promise<void> {
    const target = e.target as HTMLInputElement;
    const id = Number(target.dataset.id);
    if (target.dataset.action !== 'role' && target.dataset.action !== 'toggle-active') return;
    this.setMessage('');
    try {
      if (target.dataset.action === 'role') {
        await updateUser(id, { role: target.value });
      } else {
        await updateUser(id, { active: (target as HTMLInputElement).checked });
      }
    } catch (err) {
      this.setMessage((err as Error).message);
    }
    await this.renderUsers();
  }
}
