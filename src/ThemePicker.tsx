import { useId } from 'react';
import { Check, Palette } from 'lucide-react';
import { isTheme, setTheme, THEMES, useTheme } from './theme';
import './theme-picker.css';

export default function ThemePicker({ compact = false }: { compact?: boolean }) {
  const { theme, saved } = useTheme();
  const group = useId();
  if (compact) return <label className="theme-quick-picker">
    <Palette size={16} aria-hidden="true" />
    <select aria-label="界面配色" value={theme} onChange={event => { if (isTheme(event.target.value)) setTheme(event.target.value); }}>
      {THEMES.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
    </select>
  </label>;

  return <section className="settings-section theme-settings" aria-labelledby={`${group}-heading`}>
    <h2 id={`${group}-heading`}>界面配色</h2>
    <p>随时换一种心情。选择后立即生效，下次打开也会记住。</p>
    <fieldset className="theme-options">
      <legend className="sr-only">选择界面配色</legend>
      {THEMES.map(option => <label className="theme-option" key={option.id}>
        <input className="theme-radio" type="radio" name={group} value={option.id} checked={theme === option.id} onChange={() => setTheme(option.id)} />
        <span className="theme-option-card">
          <span className="theme-preview" data-theme={option.id} aria-hidden="true">
            <span className="theme-preview-sidebar"><span /><span /><span /></span>
            <span className="theme-preview-main"><span className="theme-preview-line" /><span className="theme-preview-stats"><i /><i /><i /></span><span className="theme-preview-work"><span className="theme-preview-ring"><img src="/life-cockpit.svg" alt="" loading="lazy" /></span><span className="theme-preview-lines"><i /><i /><i /></span></span></span>
          </span>
          <span className="theme-option-title"><strong>{option.label}</strong>{theme === option.id && <Check size={17} aria-hidden="true" />}</span>
          <span className="theme-option-description">{option.description}</span>
        </span>
      </label>)}
    </fieldset>
    <div className="theme-save-state" role="status">{saved ? `当前：${THEMES.find(option => option.id === theme)!.label}` : '已切换；当前环境未允许保存外观偏好。'}</div>
  </section>;
}
