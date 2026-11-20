// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createApp, h, nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import AgentPanel from './AgentPanel.vue';
import { useAgentStore } from '../../stores/agent.js';
const mounts = [];
afterEach(() => { vi.restoreAllMocks(); mounts.splice(0).forEach(({app,host}) => { app.unmount(); host.remove(); }); });
async function mount(messages) {
  const host=document.createElement('div'); document.body.append(host);
  const pinia=createPinia();setActivePinia(pinia);const agent=useAgentStore();
  agent.loadSettings=async()=>{agent.settings={hasKey:true,model:'test'};return agent.settings;};
  agent.messages=messages;
  const app=createApp({render:()=>h(AgentPanel)}); app.use(pinia);app.use(createRouter({history:createMemoryHistory(),routes:[{path:'/',component:{render:()=>null}}]}));
  for(const name of ['el-select','el-option','el-button','el-input','el-icon'])app.component(name,{render(){return h('div',this.$slots.default?.());}});
  app.mount(host);mounts.push({app,host});await new Promise(resolve=>setTimeout(resolve,0));await nextTick();return{host,agent};
}
const prompt={id:1,role:'user',content:'Review the appendix'};
const report={id:2,role:'assistant',runId:'r1',runState:'completed',content:'The appendix review is complete.'};
const answer=(id,q,text)=>({id,role:'user',content:`[回答] very long question\n${text}`,inputText:text,inputKind:'answer',runId:'r1',parentMessageId:2,questionId:q,question:'Which format should be used?',consumed:true});

describe('question answer history presentation',()=>{
  it('associates consecutive answers with the completed turn and shows only the user answer as primary content',async()=>{
    const {host}=await mount([prompt,report,answer(3,'q1','Use A'),answer(4,'q2','Keep captions')]);
    expect([...host.querySelectorAll('.msg-wrap')].map(node=>node.classList.contains('assistant')?'assistant':'user')).toEqual(['user','user','user','assistant']);
    expect(host.querySelector('.orphan-bar')).toBeNull();
    const answers=[...host.querySelectorAll('[data-input-kind="answer"]')];
    expect(answers).toHaveLength(2); expect(answers[0].querySelector('.md-chat').textContent.trim()).toBe('Use A');
    expect(answers[0].textContent).toContain('回答智能体 · 已接收');expect(answers[0].querySelector('details').open).toBe(false);
    expect(host.textContent).not.toContain('[回答] very long question');expect(host.querySelector('.tl-answer').textContent).toContain(report.content);
  });
  it.each([['failed','执行失败'],['interrupted','执行已中断'],['cancelled','本轮已停止']])('keeps a real %s outcome visible after refresh even when the parent assistant has no final content',async(state,label)=>{
    const {host}=await mount([prompt,{...report,content:'',runState:state},answer(3,'q1','Use A')]);
    expect(host.querySelector('.orphan-bar')).toBeNull();
    expect(host.querySelector('.run-outcome-notice').textContent).toContain(label);
    expect(host.querySelector('[data-input-kind="answer"] .md-chat').textContent.trim()).toBe('Use A');
  });
  it('never hides a real standalone request solely because it starts with an answer prefix',async()=>{
    const {host}=await mount([prompt,report,{id:3,role:'user',content:'[回答] Please start a different task'}]);
    expect(host.querySelector('.orphan-bar').textContent).toContain('上一轮未获得回复');expect(host.querySelector('[data-input-kind]')).toBeNull();
  });
  it('keeps an unconsumed supplement visible with a specific recovery message and clears it only when consumed',async()=>{
    const steering={id:3,role:'user',content:'Please check tables too',inputText:'Please check tables too',inputKind:'steering',runId:'r1',parentMessageId:2,inputId:9,consumed:false};
    const {host,agent}=await mount([prompt,report,steering]);
    expect(host.querySelector('.orphan-bar').textContent).toContain('未处理这条补充要求');
    expect(host.querySelector('[data-input-kind="steering"]').textContent).toContain('补充要求 · 未处理');
    agent.messages.find(m=>m.id===3).consumed=true;await nextTick();
    expect(host.querySelector('.orphan-bar')).toBeNull();expect(host.querySelector('[data-input-kind="steering"]').textContent).toContain('已纳入本轮');
    agent.messages.push({id:4,role:'user',content:'A genuinely new request'});await nextTick();
    expect(host.querySelector('.orphan-bar').textContent).toContain('上一轮未获得回复');
  });
});
