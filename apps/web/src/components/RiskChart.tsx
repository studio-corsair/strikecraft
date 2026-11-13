// Risk profile: P&L against the underlying price, one line per evaluation date.
// Drawn at the container's real pixel size (no scaled viewBox), so text stays 14px on a phone.
import { useEffect, useMemo, useRef, useState } from 'react';
import { price as fmtPrice, usdCompact } from '../format.ts';

export interface RiskLine {
  label: string;
  pnl: (number | null)[];
}

interface Props {
  symbol: string;
  prices: number[];
  lines: RiskLine[];
  spot: number;
  breakevens: number[];
  /** One-sigma price range at the horizon. */
  sigmaRange?: [number | null, number | null] | null;
  height?: number;
}

const LINE_COLORS = ['#8fb8ff', '#6aa2ff', '#4c8dff', '#3a73d9', '#e8ecf2'];

/** "Nice" tick values covering [lo, hi]. */
export function ticks(lo: number, hi: number, target: number): number[] {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / Math.max(1, target);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  // Smallest of 1, 2, 5, 10 (× a power of ten) that is not finer than the raw spacing.
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step)
    out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

export function RiskChart({ symbol, prices, lines, spot, breakevens, sigmaRange, height = 340 }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setWidth(Math.floor(entries[0]!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const g = useMemo(() => {
    const all = lines.flatMap((l) => l.pnl).filter((v): v is number => v != null);
    if (!prices.length || !all.length || width < 120) return null;
    const m = { l: 62, r: 14, t: 12, b: 34 };
    const w = width - m.l - m.r;
    const h = height - m.t - m.b;
    const x0 = prices[0]!,
      x1 = prices[prices.length - 1]!;
    let y0 = Math.min(0, ...all),
      y1 = Math.max(0, ...all);
    const pad = (y1 - y0) * 0.06 || 1;
    y0 -= pad;
    y1 += pad;
    const sx = (p: number) => m.l + ((p - x0) / (x1 - x0)) * w;
    const sy = (v: number) => m.t + (1 - (v - y0) / (y1 - y0)) * h;
    const path = (pnl: (number | null)[]) =>
      pnl
        .map((v, i) => (v == null ? '' : `${i === 0 ? 'M' : 'L'}${sx(prices[i]!).toFixed(1)},${sy(v).toFixed(1)}`))
        .join(' ');
    const last = lines[lines.length - 1]!;
    const area = `${path(last.pnl)} L${sx(x1).toFixed(1)},${sy(0).toFixed(1)} L${sx(x0).toFixed(1)},${sy(0).toFixed(1)} Z`;
    return {
      m,
      w,
      h,
      x0,
      x1,
      y0,
      y1,
      sx,
      sy,
      path,
      area,
      xt: ticks(x0, x1, Math.max(3, Math.floor(w / 64))),
      yt: ticks(y0, y1, 6),
    };
  }, [prices, lines, width, height]);

  const summary = useMemo(() => {
    const last = lines[lines.length - 1];
    if (!last) return `Risk profile for ${symbol}: no position.`;
    const vals = last.pnl.filter((v): v is number => v != null);
    const be = breakevens.length
      ? `break-even at ${breakevens.map((b) => fmtPrice(b)).join(' and ')}`
      : 'no break-even in range';
    return `Risk profile for ${symbol}. At ${last.label}: profit and loss from ${usdCompact(Math.min(...vals))} to ${usdCompact(Math.max(...vals))} across ${fmtPrice(prices[0])} to ${fmtPrice(prices[prices.length - 1])}; ${be}.`;
  }, [lines, breakevens, prices, symbol]);

  const onMove = (clientX: number) => {
    if (!g || !wrap.current) return;
    const x = clientX - wrap.current.getBoundingClientRect().left;
    const p = g.x0 + ((x - g.m.l) / g.w) * (g.x1 - g.x0);
    let best = 0;
    for (let i = 1; i < prices.length; i++) if (Math.abs(prices[i]! - p) < Math.abs(prices[best]! - p)) best = i;
    setHover(best);
  };

  const tipWidth = 190;
  const tipLeft = g && hover != null ? Math.max(4, Math.min(width - tipWidth - 4, g.sx(prices[hover]!) + 12)) : 0;

  return (
    <div className="risk-chart" ref={wrap} style={{ position: 'relative', height }}>
      {g && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={summary}
          onPointerMove={(e) => onMove(e.clientX)}
          onPointerDown={(e) => onMove(e.clientX)}
          onPointerLeave={() => setHover(null)}
          style={{ display: 'block', touchAction: 'pan-y' }}
        >
          <clipPath id="risk-above">
            <rect x={g.m.l} y={g.m.t} width={g.w} height={Math.max(0, g.sy(0) - g.m.t)} />
          </clipPath>
          <clipPath id="risk-below">
            <rect x={g.m.l} y={g.sy(0)} width={g.w} height={Math.max(0, g.m.t + g.h - g.sy(0))} />
          </clipPath>
          {g.yt.map((v) => (
            <g key={`y${v}`}>
              <line
                x1={g.m.l}
                x2={g.m.l + g.w}
                y1={g.sy(v)}
                y2={g.sy(v)}
                stroke={v === 0 ? '#5b6678' : '#262e3b'}
                strokeWidth={1}
              />
              <text
                x={g.m.l - 8}
                y={g.sy(v) + 5}
                textAnchor="end"
                fontSize={14}
                fill="#9aa4b5"
                fontFamily="var(--mono)"
              >
                {usdCompact(v)}
              </text>
            </g>
          ))}
          {g.xt.map((v) => (
            <text
              key={`x${v}`}
              x={g.sx(v)}
              y={height - 10}
              textAnchor="middle"
              fontSize={14}
              fill="#9aa4b5"
              fontFamily="var(--mono)"
            >
              {v % 1 === 0 ? v : v.toFixed(1)}
            </text>
          ))}
          {sigmaRange && sigmaRange[0] != null && sigmaRange[1] != null && (
            <rect
              x={g.sx(Math.max(g.x0, sigmaRange[0]))}
              y={g.m.t}
              width={Math.max(0, g.sx(Math.min(g.x1, sigmaRange[1])) - g.sx(Math.max(g.x0, sigmaRange[0])))}
              height={g.h}
              fill="rgba(76,141,255,0.06)"
            />
          )}
          <path d={g.area} fill="rgba(62,207,110,0.16)" clipPath="url(#risk-above)" />
          <path d={g.area} fill="rgba(255,107,120,0.16)" clipPath="url(#risk-below)" />
          {lines.map((l, i) => (
            <path
              key={l.label}
              d={g.path(l.pnl)}
              fill="none"
              stroke={LINE_COLORS[Math.max(0, LINE_COLORS.length - lines.length + i)]}
              strokeWidth={i === lines.length - 1 ? 2.5 : 1.75}
              strokeLinejoin="round"
            />
          ))}
          {spot >= g.x0 && spot <= g.x1 && (
            <line
              x1={g.sx(spot)}
              x2={g.sx(spot)}
              y1={g.m.t}
              y2={g.m.t + g.h}
              stroke="#9aa4b5"
              strokeDasharray="4 4"
              strokeWidth={1}
            />
          )}
          {breakevens
            .filter((b) => b >= g.x0 && b <= g.x1)
            .map((b) => (
              <circle key={b} cx={g.sx(b)} cy={g.sy(0)} r={5} fill="#0e1116" stroke="#3ecf6e" strokeWidth={2} />
            ))}
          {hover != null && (
            <line
              x1={g.sx(prices[hover]!)}
              x2={g.sx(prices[hover]!)}
              y1={g.m.t}
              y2={g.m.t + g.h}
              stroke="#e8ecf2"
              strokeWidth={1}
            />
          )}
        </svg>
      )}
      {g && hover != null && (
        <div className="chart-tip" style={{ left: tipLeft, top: g.m.t + 4, width: tipWidth }}>
          <div className="chart-tip-head num">
            {symbol} {fmtPrice(prices[hover])}
          </div>
          {lines.map((l) => (
            <div key={l.label} className="chart-tip-row">
              <span>{l.label}</span>
              <span className={`num ${(l.pnl[hover] ?? 0) >= 0 ? 'gain' : 'loss'}`}>{usdCompact(l.pnl[hover])}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function RiskLegend({ lines, spot, breakevens }: { lines: RiskLine[]; spot: number; breakevens: number[] }) {
  return (
    <ul className="legend">
      {lines.map((l, i) => (
        <li key={l.label}>
          <span
            className="swatch"
            style={{ background: LINE_COLORS[Math.max(0, LINE_COLORS.length - lines.length + i)] }}
          />
          {l.label}
        </li>
      ))}
      <li>
        <span className="swatch dashed" />
        {fmtPrice(spot)} today
      </li>
      {breakevens.length > 0 && (
        <li>
          <span className="swatch ring" />
          break-even {breakevens.map((b) => fmtPrice(b)).join(', ')}
        </li>
      )}
    </ul>
  );
}
