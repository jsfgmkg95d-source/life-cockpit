import { useSyncExternalStore } from 'react';

export const THEMES = [
  { id: 'ice', label: '冰蓝紫', description: '清爽轻盈，陪你从容推进' },
  { id: 'peach', label: '蜜桃珊瑚', description: '温暖明亮，多一点活力' },
  { id: 'midnight', label: '午夜靛蓝', description: '沉静柔和，适合夜间专注' },
] as const;
export type ThemeId = typeof THEMES[number]['id'];
export const DEFAULT_THEME: ThemeId = 'midnight';
const COOKIE_NAME = 'pcos_theme_v1';
const listeners = new Set<() => void>();
let snapshot: { theme: ThemeId; saved: boolean } = { theme: DEFAULT_THEME, saved: true };
let initialized = false;

export function isTheme(value: unknown): value is ThemeId {
  return THEMES.some(theme => theme.id === value);
}

function readTheme(): ThemeId | null {
  const value = document.cookie.split(';').map(part => part.trim()).find(part => part.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length + 1);
  return isTheme(value) ? value : null;
}

function applyTheme(theme: ThemeId, saved = true) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme === 'midnight' ? 'dark' : 'light';
  const canvas = getComputedStyle(document.documentElement).getPropertyValue('--theme-canvas').trim();
  if (canvas) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', canvas);
  if (snapshot.theme === theme && snapshot.saved === saved) return;
  snapshot = { theme, saved };
  listeners.forEach(notify => notify());
}

export function refreshTheme() {
  if (!snapshot.saved) return;
  try { const stored = readTheme(); if (stored) applyTheme(stored); }
  catch { /* Keep the current appearance when storage is unavailable. */ }
}

export function initializeTheme() {
  if (initialized) return;
  initialized = true;
  try { applyTheme(readTheme() ?? DEFAULT_THEME); }
  catch { applyTheme(DEFAULT_THEME, false); }
  // The desktop backend can change ports between launches. A host-scoped
  // preference survives this without coupling the UI to Electron or the ledger.
  window.addEventListener('focus', refreshTheme);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshTheme(); });
}

export function setTheme(theme: ThemeId) {
  if (!isTheme(theme)) return;
  let saved = false;
  try {
    document.cookie = `${COOKIE_NAME}=${theme}; Path=/; Max-Age=31536000; SameSite=Strict`;
    saved = readTheme() === theme;
  } catch { /* Apply the choice for this window even if saving is blocked. */ }
  applyTheme(theme, saved);
}

function subscribe(notify: () => void) {
  listeners.add(notify);
  return () => { listeners.delete(notify); };
}
const getSnapshot = () => snapshot;
export const useTheme = () => useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
