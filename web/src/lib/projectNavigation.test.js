import { describe, expect, it, vi } from 'vitest';
import { navigateProjectLink, projectPath } from './projectNavigation.js';
describe('native project link navigation', () => {
  const project = { id: 10, publicId: 'paper-id' };
  it('routes ordinary clicks without reloading and uses the public identifier', () => {
    const router = { push: vi.fn() }; const event = { button: 0, preventDefault: vi.fn() };
    navigateProjectLink(event, project, router);
    expect(event.preventDefault).toHaveBeenCalled(); expect(router.push).toHaveBeenCalledWith('/project/paper-id');
    expect(projectPath({ publicId: 'odd/id' })).toBe('/project/odd%2Fid');
  });
  it.each([{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { defaultPrevented: true }])('preserves browser navigation for %o', modifier => {
    const router = { push: vi.fn() }; const event = { button: 0, preventDefault: vi.fn(), ...modifier };
    navigateProjectLink(event, project, router);
    expect(event.preventDefault).not.toHaveBeenCalled(); expect(router.push).not.toHaveBeenCalled();
  });
});
