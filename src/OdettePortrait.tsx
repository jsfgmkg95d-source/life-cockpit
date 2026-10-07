import type { OdetteMood } from '../shared/odette-mood';

interface Props {
  mood: OdetteMood;
  size?: 'tiny' | 'day' | 'medium' | 'hero';
  label?: string;
  decorative?: boolean;
  className?: string;
}

const LABELS: Record<OdetteMood, string> = {
  expectant: '待开始', encouraging: '推进中', happy: '有收获', ecstatic: '已完成', sad: '待调整', resting: '休息',
};

/** Original compass symbol; progress labels remain the source of meaning. */
export default function OdettePortrait({ mood, size = 'day', label, decorative = false, className = '' }: Props) {
  return <span className={`odette-portrait odette-size-${size} odette-${mood} ${className}`} data-mood={mood} aria-hidden={decorative || undefined}>
    <img src="/life-cockpit.svg" alt={decorative ? '' : `进度 · ${label ?? LABELS[mood]}`} draggable={false} loading={size === 'hero' ? 'eager' : 'lazy'} decoding="async" />
  </span>;
}
