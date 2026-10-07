import { useEffect, useRef, useState } from 'react';
import { Clock3, Pause } from 'lucide-react';
import type { DayState } from '../shared/day-contracts';
import type { TimerView } from '../shared/timer-contracts';
import { timerDuration } from '../shared/timer-time';
import { ApiError, errorMessage, request } from './api';

export default function GlobalFocusBar({ timezone, onOpen }: { timezone: string; onOpen: (date: string) => void }) {
  const [active, setActive] = useState<TimerView['active']>(null);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const attempts = useRef(new Map<string, { revision: number; requestId: string }>());
  const pausing = useRef(false), mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    let live = true, pending = false, queued = false, version = 0;
    const load = async () => { if (pending) { queued = true; return; } pending = true; const reading = version; try {
      const date = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      const value = await request<TimerView>(`/api/days/${date}/timer`); if (live && reading === version) { setActive(value.active); setNow(Date.now()); }
    } catch { /* Keep the last running context while the local service is unavailable. */ }
    finally { pending = false; if (live && queued) { queued = false; void load(); } } };
    void load(); const interval = window.setInterval(() => void load(), 30000);
    const changed = () => { version++; void load(); }; window.addEventListener('pcos-timer-change', changed);
    return () => { live = false; mounted.current = false; clearInterval(interval); window.removeEventListener('pcos-timer-change', changed); };
  }, [timezone]);
  useEffect(() => { if (!active) return; const interval = window.setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(interval); }, [active]);
  async function pause() {
    if (!active || pausing.current) return;
    const selected = active;
    pausing.current = true; setBusy(true); setError('');
    try {
      let attempt = attempts.current.get(selected.id);
      if (!attempt) {
        // Read the revision before the timer so a concurrent switch cannot pause
        // a different session with a freshly acquired revision.
        const day = await request<DayState>(`/api/days/${selected.business_date}`);
        const current = await request<TimerView>(`/api/days/${selected.business_date}/timer`);
        if (current.active?.id !== selected.id) {
          if (mounted.current) { setActive(current.active); setError(current.active ? '专注已在其他页面切换，请核对当前任务后再暂停。' : ''); }
          window.dispatchEvent(new Event('pcos-timer-change')); return;
        }
        attempt = { revision: day.log?.revision ?? 0, requestId: crypto.randomUUID() };
        attempts.current.set(selected.id, attempt);
      }
      // A lost response retries the exact saved write, even if its revision has
      // advanced. The server will return the original receipt without stopping a new session.
      await request(`/api/days/${selected.business_date}/timer/stop`, 'POST', { ...attempt, discard: false, expected_session_id: selected.id });
      attempts.current.delete(selected.id);
      if (mounted.current) setActive(null);
      window.dispatchEvent(new Event('pcos-timer-change'));
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 409) { attempts.current.delete(selected.id); window.dispatchEvent(new Event('pcos-timer-change')); }
      if (mounted.current) setError(errorMessage(failure));
    }
    finally { pausing.current = false; if (mounted.current) setBusy(false); }
  }
  if (!active) return null;
  const seconds = Math.max(0, Math.floor((now - Date.parse(active.started_at)) / 1000));
  return <div className="global-focus-bar" aria-label="正在专注"><button type="button" className="global-focus-context" onClick={() => onOpen(active.business_date)}><Clock3 size={15} /><span>{active.task_title ?? active.block_title}</span><strong>{timerDuration(seconds)}</strong></button><button type="button" className="icon-button" aria-label="暂停当前计时" disabled={busy} onClick={() => void pause()}><Pause size={15} /></button>{error && <span role="alert" className="global-focus-error">{error}</span>}</div>;
}
