// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, h, nextTick } from 'vue';
import ProjectWorkspaceTabs from './ProjectWorkspaceTabs.vue';
let app, el;
const projects = [{ publicId: 'alpha', name: 'Long research draft', busyLabel: 'AI执行中' }, { publicId: 'beta', name: 'Another paper', busyLabel: '编译中' }];
async function mount(options = {}) {
  const activated = [], closed = [];
  el = document.createElement('div'); document.body.appendChild(el);
  app = createApp(ProjectWorkspaceTabs, { projects, activeProjectId: 'alpha', ...options, onActivate: p => activated.push(p), onClose: p => closed.push(p) });
  app.component('el-icon', { render() { return h('span', this.$slots.default?.()); } });
  app.mount(el); await nextTick();
  return { activated, closed };
}
afterEach(() => { app?.unmount(); el?.remove(); });
describe('project workspace tabs', () => {
  it('switches a project in the same page and exposes which project is active or running', async () => {
    const events = await mount(); const links = el.querySelectorAll('[role="tab"]');
    expect(links[0].getAttribute('aria-selected')).toBe('true'); expect(links[0].textContent).toContain('AI执行中');
    expect(links[1].getAttribute('aria-selected')).toBe('false'); expect(links[1].textContent).toContain('编译中');
    const click = new MouseEvent('click', { button: 0, bubbles: true, cancelable: true });
    links[1].dispatchEvent(click); expect(click.defaultPrevented).toBe(true); expect(events.activated).toEqual([projects[1]]);
  });
  it('supports arrow/Home/End focus, keyboard activation and closing without activating another project', async () => {
    const events = await mount(); const links = el.querySelectorAll('[role="tab"]');
    links[0].focus(); links[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(links[1]); expect(events.activated).toHaveLength(0);
    links[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true })); expect(document.activeElement).toBe(links[0]);
    links[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true })); expect(document.activeElement).toBe(links[1]);
    links[1].dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })); expect(events.activated).toEqual([projects[1]]);
    links[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true })); expect(events.closed).toEqual([projects[1]]);
    el.querySelector('.workspace-tab-close').click(); expect(events.closed).toEqual([projects[1], projects[0]]); expect(events.activated).toHaveLength(1);
    expect(el.querySelector('.workspace-tab-close').title).toContain('后台任务继续运行');
  });
  it('renders a compact vertical project rail with complete names and task status in accessible labels', async () => {
    const events = await mount({ vertical: true }); const links = el.querySelectorAll('[role="tab"]');
    expect(el.querySelector('nav').classList.contains('is-vertical')).toBe(true);
    expect(el.querySelector('[role="tablist"]').getAttribute('aria-orientation')).toBe('vertical');
    expect(links[0].querySelector('.workspace-tab-monogram').textContent).toBe('LR');
    expect(links[0].title).toBe('Long research draft · AI执行中');
    expect(links[0].getAttribute('aria-label')).toBe('Long research draft · AI执行中');
    expect(links[1].getAttribute('aria-selected')).toBe('false');
    expect(links[1].querySelector('.state-dot')).toBeTruthy();
    const click = new MouseEvent('click', { button: 0, cancelable: true, bubbles: true });
    links[1].dispatchEvent(click); expect(click.defaultPrevented).toBe(true); expect(events.activated).toEqual([projects[1]]);
    el.querySelector('.workspace-tab-close').click(); expect(events.closed).toEqual([projects[0]]); expect(events.activated).toHaveLength(1);
  });
  it('navigates vertical projects with up/down and Home/End, then activates with Enter', async () => {
    const events = await mount({ vertical: true }); const links = el.querySelectorAll('[role="tab"]');
    const key = (link, value) => link.dispatchEvent(new KeyboardEvent('keydown', { key: value, cancelable: true, bubbles: true }));
    links[0].focus(); key(links[0], 'ArrowDown'); expect(document.activeElement).toBe(links[1]);
    key(links[1], 'ArrowUp'); expect(document.activeElement).toBe(links[0]);
    key(links[0], 'ArrowUp'); expect(document.activeElement).toBe(links[1]);
    key(links[1], 'Home'); expect(document.activeElement).toBe(links[0]);
    key(links[0], 'End'); expect(document.activeElement).toBe(links[1]);
    expect(events.activated).toHaveLength(0); key(links[1], 'Enter'); expect(events.activated).toEqual([projects[1]]);
    key(links[1], 'Delete'); expect(events.closed).toEqual([projects[1]]);
  });
  it('keeps modified clicks available to the browser', async () => {
    const events = await mount(); const link = el.querySelectorAll('[role="tab"]')[1]; let prevented;
    link.addEventListener('click', e => { prevented = e.defaultPrevented; e.preventDefault(); }, { once: true });
    link.dispatchEvent(new MouseEvent('click', { ctrlKey: true, button: 0, bubbles: true, cancelable: true }));
    expect(prevented).toBe(false); expect(events.activated).toHaveLength(0); expect(link.getAttribute('href')).toBe('/project/beta');
  });
  it('shows pending review counts on the current project and a distinct dot for an unread background result', async () => {
    await mount({ vertical: true, projects: [
      { ...projects[0], pendingReviewCount: 3, unreadCompletion: true },
      { ...projects[1], unreadCompletion: true },
      { publicId: 'gamma', name: 'Gamma' },
    ] });
    const [alpha, beta, gamma] = el.querySelectorAll('[role="tab"]');
    expect(alpha.querySelector('.project-notification-count [aria-hidden="true"]').textContent).toBe('3');
    expect(alpha.querySelector('.project-notification-dot')).toBeNull();
    expect(alpha.querySelector('.state-dot')).toBeTruthy();
    expect(alpha.getAttribute('aria-label')).toBe('Long research draft · AI执行中 · 3 个待审阅文件');
    expect(beta.querySelector('.project-notification-dot')).toBeTruthy();
    expect(beta.querySelector('.state-dot')).toBeTruthy();
    expect(beta.getAttribute('aria-label')).toContain('有未读完成结果');
    expect(gamma.querySelector('.project-notification')).toBeNull();
  });
});
