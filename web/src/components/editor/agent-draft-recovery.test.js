// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, reactive } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import AgentTimeline from './AgentTimeline.vue';
import { api, getToken } from '../../api.js';
import { useAgentStore } from '../../stores/agent.js';
import { buildTimeline } from '../../lib/agentUtils.js';

vi.mock('../../api.js', () => ({ api: { raw: vi.fn(), get: vi.fn(), post: vi.fn() }, getToken: vi.fn(), sseGet: vi.fn(), ssePost: vi.fn(), ApiError: Error }));
vi.mock('../../stores/ui.js', () => ({ useUiStore: () => ({ error: vi.fn(), toast: vi.fn() }) }));
const recovery = { draftId: 7, projectId: 'project-a', chatId: 10, version: 3 };
const step = extra => ({ type: 'activity', source: 'system', phase: 'draft_recovery', text: '旧草稿已保留，当前轮以当前文件继续。', recovery: { ...recovery, ...extra } });
const mounts = [];
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
async function flush() { for (let i=0; i<5; i++) { await Promise.resolve(); await nextTick(); } }
async function mount(steps = [step()]) {
  const props = reactive({ rows: buildTimeline({ steps }).rows, projectId: 'project-a', chatId: 10, active: true, compact: true });
  const host = document.createElement('div'); document.body.append(host);
  const app = createApp({ render: () => h(AgentTimeline, props) });
  app.component('el-icon', { render() { return h('span', null, this.$slots.default?.()); } }); app.mount(host);
  mounts.push({ app, host }); await flush(); return { props, app, host, click: async () => { host.querySelector('.tl-recovery-download')?.click(); await flush(); } };
}
beforeEach(() => {
  vi.clearAllMocks(); setActivePinia(createPinia()); getToken.mockReturnValue('account-a-token');
  URL.createObjectURL = vi.fn(() => 'blob:old-draft'); URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});
afterEach(() => { for (const { app, host } of mounts.splice(0)) { app.unmount(); host.remove(); } vi.restoreAllMocks(); });

it('preserves the recovery identity through SSE, local finalization and persisted timeline shaping', async () => {
  const store = useAgentStore(); store.setProject('project-a'); const stream = store._beginStream();
  store._onEvent(step({ url: 'https://untrusted.example/steal', filename: 'unsafe' }), stream);
  expect(store.liveSteps[0].recovery).toEqual(recovery);
  await store._finishStream(null, { reload: false, stream });
  const saved = JSON.parse(JSON.stringify(store.messages.at(-1).steps));
  expect(buildTimeline({ steps: saved }).rows[0].recovery).toEqual(recovery);
  store.clearLocal();
});

it('downloads only the authenticated local identity and revokes its object URL', async () => {
  const blob = new Blob(['{"files":["complete bytes"]}'], { type: 'application/json' });
  api.raw.mockResolvedValue({ blob: async () => blob });
  const { host, click } = await mount([step({ url: 'https://untrusted.example/file' })]); await click();
  expect(host.textContent).toContain('旧草稿已保留');
  expect(api.raw).toHaveBeenCalledWith('/api/projects/project-a/agent/drafts/7?chatId=10', { cache: 'no-store' });
  expect(URL.createObjectURL).toHaveBeenCalledWith(blob);
  expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce();
  const link = HTMLAnchorElement.prototype.click.mock.instances[0];
  expect(link.download).toBe('corelatex-draft-7-v3.json'); expect(link.href).toBe('blob:old-draft');
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:old-draft');
});

it.each([{ projectId: 'project-b' }, { chatId: 11 }, { draftId: '../secret' }, { projectId: 'https://outside' }])('rejects mismatched or malformed recovery targets %j', async invalid => {
  const { host } = await mount([step(invalid)]);
  expect(host.querySelector('.tl-recovery-download')).toBeNull(); expect(api.raw).not.toHaveBeenCalled();
});

it.each(['project', 'chat', 'inactive', 'unmount', 'logout', 'account'])('does not download a late response after %s changes', async change => {
  const held = deferred(); api.raw.mockReturnValue(held.promise);
  const view = await mount(); await view.click();
  if (change === 'project') { view.props.projectId='project-b'; await flush(); view.props.projectId='project-a'; }
  if (change === 'chat') view.props.chatId=11;
  if (change === 'inactive') view.props.active=false;
  if (change === 'unmount') { view.app.unmount(); mounts.pop(); view.host.remove(); }
  if (change === 'logout') getToken.mockReturnValue('');
  if (change === 'account') getToken.mockReturnValue('account-b-token');
  await flush(); const readBlob=vi.fn(async()=>new Blob(['private'])); held.resolve({ blob: readBlob }); await flush();
  expect(readBlob).not.toHaveBeenCalled(); expect(URL.createObjectURL).not.toHaveBeenCalled(); expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
});

it('checks account identity again after an asynchronous blob body and allows retry after an error', async () => {
  api.raw.mockRejectedValueOnce(new Error('下载失败 fixture'));
  const view=await mount(); await view.click(); expect(view.host.textContent).toContain('下载失败 fixture');
  const held=deferred(); api.raw.mockResolvedValue({ blob: ()=>held.promise }); await view.click();
  getToken.mockReturnValue('other-account'); held.resolve(new Blob(['private'])); await flush();
  expect(URL.createObjectURL).not.toHaveBeenCalled(); expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
});
