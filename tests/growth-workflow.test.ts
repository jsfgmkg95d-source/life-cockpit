import { setupTestWorkspace } from './fixtures/workspace.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../server/store.ts';
import { DayStore } from '../server/day-store.ts';
import { GitHubStore } from '../server/github-store.ts';
import { TimerStore } from '../server/timer-store.ts';
import { BackupStore } from '../server/backup-store.ts';
import { RestoreStore } from '../server/restore-store.ts';
import { growth } from '../server/growth-store.ts';
import { migrate, SCHEMA_VERSION } from '../server/migrations.ts';
import { createApp } from '../server/app.ts';
import { parseChapters, resultDisabled } from '../shared/chapters.ts';
import type { EventInput, PlanDraft } from '../shared/day-contracts.ts';

const date = '2026-09-20';
function fixture() {
  const root = resolve(import.meta.dirname, '..', '.runtime', 'tests'); mkdirSync(root, { recursive: true });
  const folder = mkdtempSync(resolve(root, 'growth-')); const data = resolve(folder, 'data'); const store = new Store(data); const days = new DayStore(store);
  const app = setupTestWorkspace(store, randomUUID(), 'Asia/Shanghai', 180); const wedding = app.projects.find(p => p.name === '示例长篇甲')!;
  const base = (day = date) => ({ requestId: randomUUID(), revision: days.findLog(day)?.revision ?? 0 });
  const event = (key: string, chapters?: number[], task: string | null = null): EventInput => ({ project_id: wedding.id, task_id: task, artifact_key: key, metric_key: 'accepted_chapters', value: chapters?.length ?? 2, chapter_numbers: chapters, stage: 'finalized', source: '隔离测试手填', summary: '隔离测试成果' });
  const plan = (day = date) => {
    const draft: PlanDraft = { day_mode: 'work', available_minutes: 180, notes: '', change_reason: '', dimensions: { cashflow: {applicable:true,reason:''}, asset:{applicable:false,reason:'测试无安排'},health:{applicable:false,reason:'测试无安排'},learning:{applicable:false,reason:'测试无安排'} },
      work_blocks:[{id:'shared-block',title:'隔离共享时段',budget_minutes:15}], tasks:[{ candidate_id:'candidate',task_id:null,project_id:wedding.id,title:'测试定稿',acceptance:'指定2章定稿',result_type:'quant',metric_key:'accepted_chapters',target_value:2,scoring_dimension:'cashflow',raw_points:50,estimated_minutes:null,work_block_id:'shared-block'}] };
    return days.confirm(day, { ...base(day), draft, acknowledgeOverCapacity:false }).tasks[0];
  };
  // Intentionally reproduce pre-0.9 unstructured legacy rows without using the stricter new-write validation.
  const legacy = (day: string, event: EventInput) => {
    const id=randomUUID();days.mutate(day,'legacy-fixture',base(day),log=>days.insertEvent({...event,id,root_event_id:id,daily_log_id:log.id,occurred_on:day,occurrence_precision:'date',timezone:log.timezone,measurement_scope:'project',period_key:'lifetime',confirmation_state:'user_confirmed',change_kind:'record',supersedes_event_id:null,correction_reason:null,created_at:new Date().toISOString()}));
    return days.getState(day).effective_events.find(e=>e.id===id)!;
  };
  return { folder, data, store, days, wedding, app, base, event, plan, legacy, close() { store.close(); assert.ok(folder.startsWith(root)); rmSync(folder,{recursive:true,force:true}); } };
}

test('章节范围与确认按钮：计量可确认，离散选择后可确认，拒绝重复/非法章号', () => {
  assert.deepEqual(parseChapters('193-195,197'), [193,194,195,197]); assert.throws(() => parseChapters('193,193')); assert.throws(() => parseChapters('8章')); assert.throws(() => parseChapters('0-1')); assert.throws(() => parseChapters('1-9999'));
  assert.equal(resultDisabled(false,'quant',''),false); assert.equal(resultDisabled(false,'binary',''),true); assert.equal(resultDisabled(false,'binary','0'),false); assert.equal(resultDisabled(false,'binary','1'),false); assert.equal(resultDisabled(true,'quant',''),true);
});

test('手填章号与GitHub匹配只补来源；重复导入不增量，跨日同章拒绝；统一结束原子保存', async () => {
  const f=fixture(); try {
    const task=f.plan(); let paths=['正文/第001章.md']; const github=new GitHubStore(f.days,f.data,async()=>({head:'a'.repeat(40),paths}));
    await github.scan(f.wedding.id); paths=[...paths,'正文/第002章.md','正文/第003章.md']; await github.scan();
    f.days.event(date,{...f.base(),event:f.event('manual-range',[2,3],task.task_id)});
    assert.deepEqual(github.status().candidates.map(c=>c.disposition),['recorded','recorded']);
    const input={...f.base(),event:null,github_chapters:[2,3],actual:null,result:{binary_value:null,explanation:'已核对'},mark_done:true};
    const result=f.days.finish(date,task.task_id,input,github.events([2,3],task.task_id));
    assert.equal(result.effective_events.length,1); assert.equal(result.tasks[0].confirmed_result!.actual_value,2); assert.equal(result.tasks[0].status,'done'); assert.equal(result.effective_events[0].evidence_sources!.length,2);
    assert.deepEqual(f.days.finish(date,task.task_id,input,github.events([2,3],task.task_id)),result);
    github.import(date,f.base(),[2,3],task.task_id,true); assert.equal(f.days.getState(date).effective_events[0].value,2);
    assert.throws(()=>f.days.event('2026-09-21',{...f.base('2026-09-21'),event:f.event('another-key',[2])}),/已有记录/u);
    assert.equal(f.days.findLog('2026-09-21'),null); assert.equal(github.status().candidates.length,0);
  } finally {f.close();}
});

test('未知历史批次先核对；用户确认同批后保留历史、只计一次；拒绝部分重叠与恢复重复', async () => {
  const f=fixture(); try {
    let paths=['正文/第001章.md']; const github=new GitHubStore(f.days,f.data,async()=>({head:'a'.repeat(40),paths})); await github.scan(f.wedding.id); paths.push('正文/第002章.md','正文/第003章.md'); await github.scan();
    github.import(date,f.base(),[2,3],null,true);
    assert.throws(()=>f.days.event(date,{...f.base(),event:f.event('legacy-eight')}),/真实章号/u);
    const manual=f.legacy(date,f.event('legacy-eight'));
    assert.equal(growth(f.store,date).projects[0].metrics[0].unresolved,1);
    const before=f.days.getState(date);
    assert.throws(()=>f.days.identifyChapters(date,manual.id,{...f.base(),chapters:[2,3],merge:false}),/同一批/u);
    assert.deepEqual(f.days.getState(date),before);
    const merged=f.days.identifyChapters(date,manual.id,{...f.base(),chapters:[2,3],merge:true});
    assert.equal(merged.effective_events.length,1); assert.equal(merged.effective_events[0].value,2); assert.equal(merged.events.length,5);
    assert.equal(growth(f.store,date).projects[0].metrics[0].identified,'2'); assert.equal(growth(f.store,date).projects[0].metrics[0].unresolved,0);
    const voided=merged.events.find(e=>e.change_kind==='void')!;
    assert.throws(()=>f.days.correct(date,voided.id,{...f.base(),kind:'replace',value:1,stage:'finalized',summary:'重复恢复',source:'测试',reason:'测试拒绝'}),/重复/u);
    f.legacy(date,f.event('new-unknown'));
    paths.push('正文/第004章.md'); await github.scan(); assert.throws(()=>github.import(date,f.base(),[4],null,true),/章号/u);
  }finally{f.close();}
});

test('合并只允许同日完整包含，跨日与部分重叠不改账',()=>{
  const f=fixture();try{
    f.days.event(date,{...f.base(),event:f.event('three',[2,3,4])});
    const manual=f.legacy(date,f.event('unidentified'));
    assert.throws(()=>f.days.identifyChapters(date,manual.id,{...f.base(),chapters:[3,4],merge:true}),/部分重叠/u);
    assert.equal(f.days.getState(date).effective_events.length,2);
    const next='2026-09-21';const other=f.days.event(next,{...f.base(next),event:f.event('other-day')}).effective_events[0];
    assert.throws(()=>f.days.identifyChapters(next,other.id,{...f.base(next),chapters:[2,3],merge:true}),/跨日期/u);
  }finally{f.close();}
});

test('失败的统一结束回滚已导入成果、计时和任务状态',async()=>{
  const f=fixture();try{
    const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());const task=f.plan(today); const timers=new TimerStore(f.days); timers.start(today,task.work_block_id,f.base(today));
    f.store.database.prepare('UPDATE work_sessions SET started_at=?').run(new Date(Date.now()-120000).toISOString());
    const before=f.days.getState(today);
    assert.throws(()=>f.days.finish(today,task.task_id,{...f.base(today),event:f.event('fail-batch',[8],task.task_id),result:{binary_value:1,explanation:''},actual:null,mark_done:true}));
    assert.deepEqual(f.days.getState(today),before);assert.ok(timers.view(today).active);
    const done=f.days.finish(today,task.task_id,{...f.base(today),event:f.event('good-batch',[8],task.task_id),result:{binary_value:null,explanation:''},actual:null,mark_done:true});
    assert.equal(done.log!.work_block_actuals[0].minutes,2);assert.equal(timers.view(today).active,null);assert.equal(done.tasks[0].confirmed_result!.actual_value,1);
    timers.start(today,task.work_block_id,f.base(today)); assert.throws(()=>timers.start(today,task.work_block_id,f.base(today)),/已有计时/u);
    timers.stop(today,{...f.base(today),discard:true});assert.equal(f.days.getState(today).log!.work_block_actuals[0].minutes,2);
  }finally{f.close();}
});

test('7/30日累计保留未知，基线截至日不再叠加；更正重算、指标分开',()=>{
  const f=fixture();try{
    const {id,revision,created_at,updated_at,...project}=f.wedding;
    f.store.updateProject(id,revision,{...project,primary_metric_key:'accepted_chapters',baseline_value:10,baseline_at:'2026-09-18',baseline_source:'测试截至日基线',target_value:20});
    f.days.event('2026-09-18',{...f.base('2026-09-18'),event:f.event('before',[10])});
    f.days.event(date,{...f.base(),event:f.event('after',[11,12])});
    let view=growth(f.store,date);assert.equal(view.projects[0].stock,'12');assert.equal(view.projects[0].remaining,'8');assert.equal(view.recordedDays7,2);assert.equal(view.actualMinutes7,null);
    const unknown=f.legacy(date,f.event('unknown'));
    view=growth(f.store,date);assert.equal(view.projects[0].stock,null);assert.equal(view.projects[0].metrics[0].identified,'3');
    f.days.correct(date,unknown.id,{...f.base(),kind:'void',value:null,stage:'finalized',summary:'撤销测试',source:'测试',reason:'撤销未核实演练'});
    assert.equal(growth(f.store,date).projects[0].stock,'12');
  }finally{f.close();}
});

test('完整备份恢复采集基线、候选及章节身份，恢复后重新发现后续章节',async()=>{
  const f=fixture();try{
    let paths=['正文/第001章.md'];const github=new GitHubStore(f.days,f.data,async()=>({head:'a'.repeat(40),paths})); await github.scan(f.wedding.id); paths.push('正文/第002章.md');await github.scan();
    const backups=new BackupStore(f.store,resolve(f.folder,'backups'));const restores=new RestoreStore(f.store,backups,()=>false);const saved=backups.create(randomUUID());
    assert.equal(saved.schemaVersion,SCHEMA_VERSION);assert.equal(saved.rowCounts.connector_states,1);
    github.import(date,f.base(),[2],null,true); paths.push('正文/第003章.md');await github.scan();
    const preview=restores.preview(saved.id);restores.restore(randomUUID(),preview.token,'恢复本地账本');
    assert.equal(github.status().known_count,2);assert.deepEqual(github.status().candidates.map(c=>c.chapter),[2]);assert.equal(f.days.getState(date).effective_events.length,0);
    await github.scan();assert.deepEqual(github.status().candidates.map(c=>c.chapter),[2,3]);
  }finally{f.close();}
});

test('公开版升级保留数据库架构但不读取未发布的旧采集文件',()=>{
  const root=resolve(import.meta.dirname,'..','.runtime','tests');mkdirSync(root,{recursive:true});const folder=mkdtempSync(resolve(root,'legacy-'));
  let store:Store|undefined;
  try{
    const db=new DatabaseSync(resolve(folder,'personal-company.sqlite'));migrate(db,5);db.close();
    store=new Store(folder);setupTestWorkspace(store, randomUUID(),'Asia/Shanghai',135);const project=store.getState().projects[0];store.close();
    const old=new DatabaseSync(resolve(folder,'personal-company.sqlite'));old.exec('DROP TABLE work_session_context; DROP TABLE day_schedule; DROP TABLE inbox_items; DROP TABLE timer_points; DROP TABLE daily_fortune_records; DROP TABLE task_pins; DROP TABLE work_sessions; DROP TABLE asset_evidence; DROP TABLE asset_chapters; DROP TABLE connector_states; PRAGMA user_version=5;');old.close();
    const dir=resolve(folder,'integrations','wedding');mkdirSync(dir,{recursive:true});writeFileSync(resolve(dir,'connection.json'),JSON.stringify({project_id:project.id,baseline_at:'2026-09-19T00:00:00Z',checked_at:'2026-09-19T00:00:00Z',head:'a'.repeat(40),known:[1],candidates:[]}));
    store=new Store(folder);assert.equal(new GitHubStore(new DayStore(store),folder).status().known_count,0);store.close();
    writeFileSync(resolve(dir,'connection.json'),'not-json');store=new Store(folder);assert.equal(new GitHubStore(new DayStore(store),folder).status().known_count,0);
  }finally{store?.close();assert.ok(folder.startsWith(root));rmSync(folder,{recursive:true,force:true});}
});

test('公开服务不暴露远端采集路由且不会自动修改保留的连接记录',async()=>{
  const f=fixture(); let app:ReturnType<typeof createApp>|undefined;
  try{
    const github=new GitHubStore(f.days,f.data,async()=>({head:'a'.repeat(40),paths:['正文/第001章.md']}));await github.scan(f.wedding.id);const before=github.status();f.store.close();
    app=createApp({dataDir:f.data}); const {url}=await app.listen();
    assert.equal((await fetch(url+'/api/github')).status,404);
    await app.close();app=undefined;
    const reopened=new Store(f.data);try{assert.deepEqual(new GitHubStore(new DayStore(reopened),f.data).status(),before);}finally{reopened.close();}
  }finally{await app?.close();f.close();}
});
