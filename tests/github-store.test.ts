import { setupTestWorkspace } from './fixtures/workspace.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { Store } from '../server/store.ts';
import { DayStore } from '../server/day-store.ts';
import { chapterInventory, GitHubStore } from '../server/github-store.ts';
import { metricWarning, orderedMetrics } from '../shared/workflow.ts';

test('GitHub 首次仅建基线；新章节候选、断线保留、修订不重复、导入幂等与回滚', async () => {
  const root = resolve(import.meta.dirname, '..', '.runtime', 'tests'); await mkdir(root, { recursive: true });
  const folder = await mkdtemp(resolve(root, 'github-'));
  const store = new Store(folder); const days = new DayStore(store);
  const app = setupTestWorkspace(store, randomUUID(), 'Asia/Shanghai', 180);
  const project = app.projects.find(item => item.name === '示例长篇甲')!;
  let snapshot = { head: 'a'.repeat(40), paths: ['正文/第001章.md', '正文/第002章.md', '废稿/第003章.md', '当前状态.md'] };
  let offline = false;
  const reader = async () => { if (offline) throw new Error('offline'); return snapshot; };
  const github = new GitHubStore(days, folder, reader);
  try {
    const baseline = await github.scan(project.id);
    assert.equal(baseline.known_count, 2); assert.equal(baseline.candidates.length, 0);
    assert.equal(days.getState('2026-09-20').log, null);
    snapshot = { head: 'b'.repeat(40), paths: [...snapshot.paths, '正文/第003章.md', '正文/第004章.md'] };
    const scanned = await github.scan(); assert.equal(scanned.candidates.length, 2);
    assert.ok(scanned.candidates.every(item => item.commit === snapshot.head));
    offline = true; await assert.rejects(github.scan()); assert.deepEqual(github.status(), scanned); offline = false;
    snapshot = { head: 'c'.repeat(40), paths: snapshot.paths.filter(path => !path.includes('003')) };
    await github.scan(); snapshot.paths.push('正文/第003章.md');
    assert.equal((await github.scan()).candidates.length, 2);
    const reloaded = new GitHubStore(days, folder, reader); assert.equal(reloaded.status().known_count, 4);
    const base = { requestId: randomUUID(), revision: 0 };
    assert.throws(() => github.import('2026-09-20', base, [3], null, false));
    assert.throws(() => github.import('2026-09-20', base, [3, 99], null, true));
    assert.equal(days.getState('2026-09-20').log, null);
    const first = github.import('2026-09-20', base, [3], null, true);
    assert.equal(first.effective_events.length, 1);
    assert.equal(first.effective_events[0].stage, 'finalized');
    assert.equal(first.effective_events[0].metric_key, 'accepted_chapters');
    assert.match(first.effective_events[0].source, /GitHub 远端文件已核验/u);
    assert.deepEqual(github.import('2026-09-20', base, [3], null, true), first);
    assert.equal(github.status().candidates.length, 1);
    // The first event in this batch succeeds internally; duplicate second event must roll all of it back.
    assert.throws(() => github.import('2026-09-21', { requestId: randomUUID(), revision: 0 }, [4, 3], null, true));
    assert.equal(days.getState('2026-09-21').log, null);
    assert.equal(github.status().candidates.length, 1);
    assert.throws(() => github.import('2026-09-21', { requestId: randomUUID(), revision: 0 }, [3], null, true));
    const second = github.import('2026-09-21', { requestId: randomUUID(), revision: 0 }, [4], null, true);
    assert.equal(second.effective_events[0].value, 1);
    assert.equal(github.status().candidates.length, 0);
  } finally { store.close(); await rm(folder, { recursive: true, force: true }); }
});

test('章节身份按章号归一，重复命名拒绝；公众号指标建议和阶段提醒', () => {
  assert.equal(chapterInventory(['正文/第003章.md', '废稿/第004章.md', '正文/第3章草稿.md']).size, 1);
  assert.throws(() => chapterInventory(['正文/第003章.md', '正文/第3章.md']));
  const project = { project_type: 'publication' } as Parameters<typeof orderedMetrics>[0];
  assert.equal(orderedMetrics(project)[0].key, 'accepted_articles');
  assert.match(metricWarning(project, 'published_chapters')!, /按“章”计量/u);
  assert.match(metricWarning(undefined, 'published_chapters', '后台上传5章')!, /不足以证明/u);
  assert.equal(metricWarning(project, 'accepted_articles', '定稿推送'), null);
});

test('已核实连接按项目ID绑定：项目改名不停止采集，也不改绑同名新项目', async () => {
  const root = resolve(import.meta.dirname, '..', '.runtime', 'tests'); await mkdir(root, { recursive: true });
  const folder = await mkdtemp(resolve(root, 'github-rename-'));
  const store = new Store(folder); const days = new DayStore(store);
  try {
    const state = setupTestWorkspace(store, randomUUID(), 'Asia/Shanghai', 180);
    const project = state.projects.find(item => item.name === '示例长篇甲')!;
    const other = state.projects.find(item => item.name === '示例长篇乙')!;
    const paths = ['正文/第001章.md'];
    const github = new GitHubStore(days, folder, async () => ({ head: 'a'.repeat(40), paths }));
    await assert.rejects(github.scan(other.id), /已核实/u);
    await github.scan(project.id);
    store.updateProject(project.id, project.revision, { ...project, name: '示例长篇甲（连载）' });
    store.updateProject(other.id, other.revision, { ...other, name: '示例长篇甲' });
    paths.push('正文/第002章.md');
    const scanned = await github.scan(project.id);
    assert.equal(scanned.project_id, project.id);
    assert.equal(scanned.known_count, 2);
    assert.deepEqual(scanned.candidates.map(item => item.chapter), [2]);
    await assert.rejects(github.scan(other.id), /不能重新归属/u);
    assert.equal(github.status().project_id, project.id);
  } finally { store.close(); await rm(folder, { recursive: true, force: true }); }
});
