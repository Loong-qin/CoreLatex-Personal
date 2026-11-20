// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick } from 'vue';
import ElementPlus from 'element-plus';
import ModelProviderSettings from './ModelProviderSettings.vue';

const services = vi.hoisted(() => ({ agent: { saveSettings: vi.fn(), testConnection: vi.fn() },
  ui: { error: vi.fn(), toast: vi.fn(), confirm: vi.fn(async () => true) } }));
vi.mock('../stores/agent.js', () => ({ useAgentStore: () => services.agent }));
vi.mock('../stores/ui.js', () => ({ useUiStore: () => services.ui }));
let app, host;
const flush = async () => { for (let i=0; i<8; i++) { await Promise.resolve(); await nextTick(); } };
const button = (container, label) => [...container.querySelectorAll('button')].find(b => b.textContent.trim() === label);
const dialog = title => [...document.querySelectorAll('.el-dialog')].find(d => d.querySelector('.el-dialog__title')?.textContent === title);
async function input(node, value) { node.value = value; node.dispatchEvent(new Event('input', { bubbles: true })); await flush(); }
const levels = () => [...dialog('模型配置').querySelectorAll('.reasoning-level-row input')];
async function mount() {
  host=document.createElement('div');document.body.append(host);
  app=createApp(ModelProviderSettings,{providers:[{id:'existing-provider',name:'Existing',apiFormat:'openai',apiKey:'***mask',models:[{id:'existing-model',name:'Legacy',model:'legacy'}]}],activeModelId:'existing-model'});
  app.use(ElementPlus); app.mount(host);await flush();
}
async function addModel() { button(host,'＋ 添加模型').click(); await flush(); return dialog('模型配置'); }
beforeEach(()=>{
  vi.clearAllMocks(); let seed=0;
  // Actual intranet HTTP capability: cryptographic random bytes, no randomUUID.
  vi.stubGlobal('crypto',{getRandomValues:vi.fn(bytes=>{bytes.forEach((_,i)=>bytes[i]=++seed%256);return bytes;})});
  vi.stubGlobal('ResizeObserver',class { observe() {} unobserve() {} disconnect() {} });
  services.agent.saveSettings.mockImplementation(async patch=>JSON.parse(JSON.stringify(patch)));
});
afterEach(()=>{app?.unmount();host?.remove();vi.unstubAllGlobals();});

describe('real supplier and model dialogs on HTTP',()=>{
  it('adds a supplier, preserves existing IDs and credentials, and persists it with Save changes',async()=>{
    await mount(); button(host,'＋ 新增').click();await flush();
    const d=dialog('添加供应商');
    await input(d.querySelector('input[placeholder="例如：我的模型服务"]'),'HTTP supplier');
    button(d,'添加').click();await flush();
    expect(services.ui.error).not.toHaveBeenCalled();
    expect(host.querySelectorAll('.provider-choice')).toHaveLength(2);
    expect(host.querySelector('.provider-heading h3').textContent).toBe('HTTP supplier');
    expect(services.agent.saveSettings).not.toHaveBeenCalled();
    button(host,'保存更改').click();await flush();
    const patch=services.agent.saveSettings.mock.calls[0][0];
    expect(patch.providers[0]).toMatchObject({id:'existing-provider',apiKey:'***mask',models:[{id:'existing-model',reasoningLevels:[]}]});
    expect(patch.providers[1]).toMatchObject({id:expect.stringMatching(/^p_[0-9a-f]{32}$/),name:'HTTP supplier',models:[]});
    expect(button(host,'保存更改').disabled).toBe(true);
  });

  it('validates the supplier name and submits its real form once using Enter semantics',async()=>{
    await mount();button(host,'＋ 新增').click();await flush();const d=dialog('添加供应商');
    button(d,'添加').click();await flush();expect(services.ui.error).toHaveBeenCalledWith('请填写供应商名称');
    await input(d.querySelector('input[placeholder="例如：我的模型服务"]'),'Form supplier');
    d.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
    d.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await flush();
    expect(host.querySelectorAll('.provider-choice')).toHaveLength(2);
  });

  it('starts new models at four levels and saves an edited ordered list with max',async()=>{
    await mount();const d=await addModel();
    expect(levels().map(n=>n.value)).toEqual(['low','medium','high','xhigh']);
    await input(d.querySelector('input[placeholder="服务商提供的模型名称"]'),'new-model');
    button(d,'＋ 添加档位').click();await flush();await input(levels().at(-1),' max ');
    d.querySelector('[aria-label="删除思考强度 1"]').click();await flush();
    button(d,'确认').click();await flush();button(host,'保存更改').click();await flush();
    const model=services.agent.saveSettings.mock.calls[0][0].providers[0].models[1];
    expect(model).toMatchObject({id:expect.stringMatching(/^m_[0-9a-f]{32}$/),model:'new-model',reasoningLevels:['medium','high','xhigh','max']});
    host.querySelector('[aria-label="编辑模型 new-model"]').click();await flush();
    expect(levels().map(n=>n.value)).toEqual(model.reasoningLevels);
    await input(levels()[0],'low');d.querySelector('[aria-label="删除思考强度 2"]').click();await flush();
    button(d,'取消').click();await flush();expect(button(host,'保存更改').disabled).toBe(true);
    host.querySelector('[aria-label="编辑模型 new-model"]').click();await flush();
    expect(levels().map(n=>n.value)).toEqual(model.reasoningLevels);
  });

  it('keeps legacy models disabled and allows removing all configured levels explicitly',async()=>{
    await mount();host.querySelector('[aria-label="编辑模型 Legacy"]').click();await flush();
    expect(levels()).toHaveLength(0);button(dialog('模型配置'),'取消').click();await flush();
    const d=await addModel();await input(d.querySelector('input[placeholder="服务商提供的模型名称"]'),'no-reasoning');
    for(let i=0;i<4;i++){d.querySelector('[aria-label="删除思考强度 1"]').click();await flush();}
    button(d,'确认').click();await flush();button(host,'保存更改').click();await flush();
    expect(services.agent.saveSettings.mock.calls[0][0].providers[0].models[1].reasoningLevels).toEqual([]);
  });

  it('rejects invalid level syntax without closing the dialog or changing saved models',async()=>{
    await mount();const d=await addModel();await input(d.querySelector('input[placeholder="服务商提供的模型名称"]'),'new-model');
    await input(levels()[0],'too many words');button(d,'确认').click();await flush();
    expect(services.ui.error).toHaveBeenCalledWith(expect.stringContaining('不要包含空格'));
    expect(host.querySelectorAll('.provider-model')).toHaveLength(1);
    expect(services.agent.saveSettings).not.toHaveBeenCalled();
    await input(levels()[0],'custom.deep:2');button(d,'确认').click();await flush();button(host,'保存更改').click();await flush();
    expect(services.agent.saveSettings.mock.calls[0][0].providers[0].models[1].reasoningLevels).toEqual(['custom.deep:2','medium','high','xhigh']);
  });
});
