import { useEffect, useRef, useState } from 'react';
import { FolderOpen, Inbox, ListTodo, Search, X } from 'lucide-react';
import type { AppState } from '../shared/contracts';
import type { DayState } from '../shared/day-contracts';
import type { InboxView } from '../shared/inbox-contracts';
import { errorMessage, request } from './api';
interface SearchItem { id: string; title: string; subtitle: string; kind: 'project' | 'task' | 'inbox'; date?: string }
export default function CommandSearch({ app, onClose, onChoose }: { app: AppState; onClose: () => void; onChoose: (item: SearchItem) => void }) {
  const modal = useRef<HTMLDialogElement>(null), input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(''), [items, setItems] = useState<SearchItem[]>([]), [error, setError] = useState('');
  const [loading, setLoading] = useState(true), [selected, setSelected] = useState(0);
  const resultButtons = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; const dialog = modal.current; dialog?.showModal(); input.current?.focus(); return () => { dialog?.close(); previous?.focus(); }; }, []);
  useEffect(() => { let live = true;
    setLoading(true); setError('');
    const projects = app.projects.map(project => ({ id: project.id, title: project.name, subtitle: '项目', kind: 'project' as const }));
    setItems(projects);
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: app.settings.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    void Promise.allSettled([request<DayState>(`/api/days/${date}`), request<InboxView>('/api/inbox')]).then(([day, inbox]) => {
      if (!live) return;
      const tasks = day.status === 'fulfilled' ? day.value.tasks.filter(task => task.eligible && task.status !== 'cancelled').map(task => ({ id: task.task_id, title: task.title, subtitle: task.project_name, kind: 'task' as const, date })) : [];
      const captures = inbox.status === 'fulfilled' ? inbox.value.items.filter(item => item.status === 'inbox').map(item => ({ id: item.id, title: item.title, subtitle: '收件箱', kind: 'inbox' as const })) : [];
      setItems([...projects, ...tasks, ...captures]); setLoading(false);
      const failures = [day, inbox].filter(result => result.status === 'rejected');
      if (failures.length) setError(`部分记录暂未读到。${errorMessage((failures[0] as PromiseRejectedResult).reason)}`);
    }); return () => { live = false; };
  }, [app]);
  const found = items.filter(item => `${item.title} ${item.subtitle}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).slice(0, 12);
  const activeIndex = Math.min(selected, Math.max(0, found.length - 1));
  useEffect(() => { setSelected(0); }, [query]);
  useEffect(() => { resultButtons.current[activeIndex]?.scrollIntoView({ block: 'nearest' }); }, [activeIndex]);
  return <dialog ref={modal} className="modal planner-command-dialog" aria-label="搜索工作空间" onCancel={event => { event.preventDefault(); onClose(); }}><div className="planner-command-input"><Search size={19} /><input ref={input} aria-label="搜索任务、项目或收件箱" aria-controls="command-search-results" aria-activedescendant={found.length ? `command-search-result-${activeIndex}` : undefined} value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => {
    if (event.nativeEvent.isComposing || !found.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setSelected((activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + found.length) % found.length); }
    else if (event.key === 'Enter') { event.preventDefault(); onChoose(found[activeIndex]); }
  }} placeholder="搜索任务、项目或收件箱…" /><button type="button" className="icon-button" aria-label="关闭搜索" onClick={onClose}><X size={18} /></button></div>{error && <p className="planner-error" role="alert">{error}</p>}<div id="command-search-results" className="planner-command-results">{found.map((item, index) => <button type="button" id={`command-search-result-${index}`} ref={element => { resultButtons.current[index] = element; }} key={`${item.kind}:${item.id}`} className={index === activeIndex ? 'selected' : undefined} onMouseMove={() => setSelected(index)} onClick={() => onChoose(item)}>{item.kind === 'project' ? <FolderOpen size={17} /> : item.kind === 'task' ? <ListTodo size={17} /> : <Inbox size={17} />}<span><strong>{item.title}</strong><small>{item.subtitle}</small></span></button>)}{!found.length && <p className="planner-empty">{loading ? '正在读取任务与待安排事项…' : '没有匹配的内容。'}</p>}</div><footer>搜索当前项目、今天的任务与待安排事项 · ↑↓ 选择，Enter 打开</footer></dialog>;
}
