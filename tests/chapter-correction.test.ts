import { setupTestWorkspace } from './fixtures/workspace.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { Store } from '../server/store.ts';
import { DayStore } from '../server/day-store.ts';
import { growth } from '../server/growth-store.ts';
import { correctionWrite } from '../server/day-validation.ts';
import type { CorrectionWrite, EventInput, PlanDraft } from '../shared/day-contracts.ts';

const date='2026-09-20';
const range=(first:number,last:number)=>Array.from({length:last-first+1},(_,i)=>first+i);
function fixture() {
  const root=resolve(import.meta.dirname,'..','.runtime','tests');mkdirSync(root,{recursive:true});
  const folder=mkdtempSync(resolve(root,'chapter-correction-'));const store=new Store(folder);const days=new DayStore(store);
  const wedding=setupTestWorkspace(store, randomUUID(),'Asia/Shanghai',135).projects.find(p=>p.name==='示例长篇甲')!;
  const base=(day=date)=>({requestId:randomUUID(),revision:days.findLog(day)?.revision??0});
  const event=(chapters:number[],key:string,task:string|null=null):EventInput=>({project_id:wedding.id,task_id:task,metric_key:'accepted_chapters',value:chapters.length,chapter_numbers:chapters,artifact_key:key,stage:'finalized',source:'用户手填核对',summary:'测试批次'});
  const correct=(chapters:number[]):CorrectionWrite=>({...base(),kind:'replace',value:chapters.length,chapter_numbers:chapters,stage:'finalized',source:'重新核对正文范围',summary:'更正范围',reason:'原先手填章号有误'});
  const close=()=>{store.close();assert.ok(folder.startsWith(root));rmSync(folder,{recursive:true,force:true});};
  return{store,days,wedding,base,event,correct,close};
}

test('手填章号8→7、同数量换号及连续再纠正：保留旧身份和来源，不能恢复成重复记录',()=>{
  const f=fixture();try{
    const draft:PlanDraft={day_mode:'work',available_minutes:135,notes:'',change_reason:'',dimensions:{cashflow:{applicable:true,reason:''},asset:{applicable:false,reason:'无安排'},health:{applicable:false,reason:'无安排'},learning:{applicable:false,reason:'无安排'}},work_blocks:[{id:'block',title:'写作',budget_minutes:60}],tasks:[{candidate_id:'candidate',task_id:null,project_id:f.wedding.id,title:'测试定稿',acceptance:'指定批次',result_type:'quant',metric_key:'accepted_chapters',target_value:8,scoring_dimension:'cashflow',raw_points:50,estimated_minutes:null,work_block_id:'block'}]};
    const task=f.days.confirm(date,{...f.base(),draft,acknowledgeOverCapacity:false}).tasks[0];
    const original=f.days.event(date,{...f.base(),event:f.event(range(193,200),'manual-batch',task.task_id)}).effective_events[0];
    f.days.importEvents(date,f.base(),[{...f.event([193],'github:example/sample-repository:chapter:193',task.task_id),source:'GitHub 文件第193章核验'}]);
    f.days.result(date,task.task_id,{...f.base(),binary_value:null,explanation:'原先确认8章',clear:false});
    const input=f.correct(range(193,199));
    let after=f.days.correct(date,original.id,input);
    const first=after.effective_events[0];
    assert.equal(after.effective_events.length,1);assert.equal(first.value,7);assert.notEqual(first.root_event_id,original.root_event_id);
    assert.deepEqual(after.events.find(e=>e.id===original.id)!.chapter_numbers,range(193,200));
    assert.ok(after.events.find(e=>e.id===original.id)!.evidence_sources!.includes('GitHub 文件第193章核验'));
    assert.ok(first.evidence_sources!.every(source=>!source.includes('GitHub 文件第193章核验')));
    assert.ok(first.evidence_sources!.some(source=>source.includes(original.artifact_key)));
    assert.ok(after.events.find(e=>e.change_kind==='void')!.correction_reason!.includes(first.artifact_key));
    assert.equal(after.tasks[0].result_state,'unknown');assert.equal(growth(f.store,date).projects.find(p=>p.id===f.wedding.id)!.metrics[0].identified,'7');
    assert.deepEqual(f.days.correct(date,original.id,input),after);
    after=f.days.correct(date,first.id,f.correct([...range(193,198),201]));
    const second=after.effective_events[0];assert.deepEqual(second.chapter_numbers,[...range(193,198),201]);
    after=f.days.correct(date,second.id,f.correct(range(193,199)));
    assert.equal(after.effective_events.length,1);assert.deepEqual(after.effective_events[0].chapter_numbers,range(193,199));
    const oldVoid=after.events.find(e=>e.root_event_id===original.root_event_id&&e.change_kind==='void')!;
    assert.throws(()=>f.days.correct(date,oldVoid.id,{...f.correct(range(193,200)),chapter_numbers:undefined}),/重复/u);
  }finally{f.close();}
});

test('身份更正拒绝其他有效批次、跨日及无关撤销批次冲突，失败完全回滚',()=>{
  const f=fixture();try{
    const first=f.days.event(date,{...f.base(),event:f.event([1,2],'manual')}).effective_events[0];
    f.days.event(date,{...f.base(),event:f.event([3],'other')});
    const prior='2026-09-19';f.days.event(prior,{...f.base(prior),event:f.event([4],'prior')});
    const unrelated=f.days.event(date,{...f.base(),event:f.event([5],'unrelated')}).effective_events.find(e=>e.artifact_key==='unrelated')!;
    f.days.correct(date,unrelated.id,{...f.correct([5]),kind:'void',value:null,chapter_numbers:undefined});
    for(const chapter of [3,4,5]){const before=f.days.getState(date);assert.throws(()=>f.days.correct(date,first.id,f.correct([1,chapter])),/冲突/u);assert.deepEqual(f.days.getState(date),before);}
    f.store.database.exec("CREATE TRIGGER fail_test_chapter BEFORE INSERT ON asset_chapters WHEN NEW.chapter=6 BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;");
    const before=f.days.getState(date);assert.throws(()=>f.days.correct(date,first.id,f.correct([1,6])),/synthetic failure/u);assert.deepEqual(f.days.getState(date),before);
  }finally{f.close();}
});

test('GitHub原始根不能改章号，用户不能写内部替换身份；更正接口校验章号',()=>{
  const f=fixture();try{
    const remote=f.days.event(date,{...f.base(),event:f.event([8],'github:example/sample-repository:chapter:8')}).effective_events[0];
    const before=f.days.getState(date);assert.throws(()=>f.days.correct(date,remote.id,f.correct([9])),/远端文件/u);assert.deepEqual(f.days.getState(date),before);
    assert.throws(()=>f.days.event(date,{...f.base(),event:f.event([9],'pcos-internal:chapter-correction:spoof')}),/系统保留/u);
    assert.deepEqual(correctionWrite(f.correct([1,2])).chapter_numbers,[1,2]);
    assert.throws(()=>correctionWrite({...f.correct([1]),chapter_numbers:[1,1]}),/不重复/u);
  }finally{f.close();}
});

test('章号完全换号后，旧根也不能在替代批次有效时恢复',()=>{
  const f=fixture();try{
    const original=f.days.event(date,{...f.base(),event:f.event([1],'original')}).effective_events[0];
    const changed=f.days.correct(date,original.id,f.correct([2]));
    const withdrawn=changed.events.find(e=>e.root_event_id===original.root_event_id&&e.change_kind==='void')!;
    assert.throws(()=>f.days.correct(date,withdrawn.id,{...f.correct([1]),chapter_numbers:undefined}),/有效的章节更正替代/u);
    assert.equal(f.days.getState(date).effective_events.length,1);
  }finally{f.close();}
});
