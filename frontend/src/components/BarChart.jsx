import { useState } from 'react';
import { cx } from './ui.jsx';

/**
 * Small single-series bar chart (one measure, one axis). Bars are anchored to the baseline with
 * 4px rounded tops and a 2px gap; each bar has a hover/focus tooltip and the chart has a text summary.
 * data: [{ label, value }]
 */
export default function BarChart({ title, data = [], color = 'bg-accent', unit = '', height = 96 }) {
  const [hover, setHover] = useState(null);
  const max = Math.max(1, ...data.map(d => d.value));
  const last = data[data.length - 1];
  const peak = data.reduce((m, d) => (d.value > (m?.value ?? -1) ? d : m), null);

  return (
    <figure className="min-w-0">
      <figcaption className="flex items-baseline justify-between gap-2">
        <span className="text-[13px] font-medium">{title}</span>
        <span className="text-xs text-muted">
          {hover !== null ? `${data[hover].label}: ${data[hover].value}${unit}` : last ? `Latest ${last.value}${unit}, peak ${peak.value}${unit}` : ''}
        </span>
      </figcaption>
      <div
        className="relative mt-3 flex items-end gap-[2px] border-b border-line"
        style={{ height }}
        role="img"
        aria-label={`${title}. ${data.map(d => `${d.label} ${d.value}`).join(', ')}`}
        onMouseLeave={() => setHover(null)}
      >
        {/* recessive gridline at max */}
        <span className="pointer-events-none absolute inset-x-0 top-0 border-t border-dashed border-line" aria-hidden />
        {data.map((d, i) => (
          <button
            key={d.label}
            className="group flex h-full flex-1 items-end focus:outline-none"
            onMouseEnter={() => setHover(i)}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(null)}
            aria-label={`${d.label}: ${d.value}${unit}`}
          >
            <span
              className={cx('w-full rounded-t-[4px]', color, hover !== null && hover !== i && 'opacity-40')}
              style={{ height: `${d.value === 0 ? 0 : Math.max(2, (d.value / max) * 100)}%` }}
            />
          </button>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-faint">
        <span>{data[0]?.label}</span>
        <span>{last?.label}</span>
      </div>
    </figure>
  );
}
