// Past earnings reactions as bars (green up, red down, oldest to newest) with a band at the
// move the options market prices now. Drawn at the container's real pixel width, text stays 14px.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ticks } from './RiskChart.tsx';
import { expiryLabel, signedPct } from '../format.ts';

export interface MoveBar {
  date: string;
  /** Close-to-close move over the print, percent. */
  movePct: number | null;
}

interface Props {
  symbol: string;
  bars: MoveBar[];
  /** The options-implied absolute move, percent; null draws no band. */
  impliedAbsPct: number | null;
  height?: number;
}

/**
 * Year labels along the time axis: the first bar of each year, thinned so neighbours are at least
 * `minGap` px apart. Walks from the newest so a lone early quarter never crowds out a full year.
 */
export function yearLabels(dates: string[], xOf: (i: number) => number, minGap: number): { i: number; text: string }[] {
  const out: { i: number; text: string }[] = [];
  let lastX = Infinity;
  for (let i = dates.length - 1; i >= 0; i--) {
    const year = dates[i]!.slice(0, 4);
    if (i > 0 && dates[i - 1]!.slice(0, 4) === year) continue;
    const x = xOf(i);
    if (lastX - x < minGap) continue;
    out.push({ i, text: year });
    lastX = x;
  }
  return out.reverse();
}

/** How many of the bars moved further than the implied move. */
export function countBeyond(bars: MoveBar[], impliedAbsPct: number | null): number {
  if (impliedAbsPct == null) return 0;
  return bars.filter((b) => b.movePct != null && Math.abs(b.movePct) > impliedAbsPct).length;
}

export function MoveBars({ symbol, bars, impliedAbsPct, height = 300 }: Props) {
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
    const vals = bars.map((b) => b.movePct).filter((v): v is number => v != null);
    if (!vals.length || width < 120) return null;
    const m = { l: 58, r: 14, t: 28, b: 34 };
    const w = width - m.l - m.r;
    const h = height - m.t - m.b;
    const raw = Math.max(1, ...vals.map(Math.abs), impliedAbsPct ?? 0);
    const tk = ticks(-raw, raw, 4);
    const step = (tk[1] ?? 1) - (tk[0] ?? 0);
    const reach = Math.ceil(raw / step) * step;
    const sy = (v: number) => m.t + (1 - (v + reach) / (2 * reach)) * h;
    const slot = w / bars.length;
    const bw = Math.max(3, Math.min(28, slot * 0.7));
    const cx = (i: number) => m.l + slot * (i + 0.5);
    return {
      m,
      w,
      h,
      sy,
      slot,
      bw,
      cx,
      yt: ticks(-reach, reach, 4),
      years: yearLabels(
        bars.map((b) => b.date),
        cx,
        72,
      ),
    };
  }, [bars, width, height, impliedAbsPct]);

  const summary = useMemo(() => {
    const vals = bars.map((b) => b.movePct).filter((v): v is number => v != null);
    if (!vals.length) return `Past earnings moves for ${symbol}: no data.`;
    const beyond = countBeyond(bars, impliedAbsPct);
    const implied =
      impliedAbsPct != null
        ? `; ${beyond} of ${vals.length} moved more than the implied plus or minus ${impliedAbsPct.toFixed(1)} percent`
        : '';
    return `Past earnings moves for ${symbol}, ${vals.length} quarters from ${signedPct(Math.min(...vals), 1)} to ${signedPct(Math.max(...vals), 1)}${implied}.`;
  }, [bars, impliedAbsPct, symbol]);

  const onMove = (clientX: number) => {
    if (!g || !wrap.current) return;
    const x = clientX - wrap.current.getBoundingClientRect().left - g.m.l;
    setHover(Math.max(0, Math.min(bars.length - 1, Math.floor(x / g.slot))));
  };

  const tipWidth = 168;
  const hb = hover != null ? bars[hover] : undefined;
  const tipLeft = g && hover != null ? Math.max(4, Math.min(width - tipWidth - 4, g.cx(hover) + 12)) : 0;

  return (
    <div className="move-bars" ref={wrap} style={{ position: 'relative', height }}>
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
          {g.yt.map((v) => (
            <g key={`y${v}`}>
              <line className={v === 0 ? 'mb-zero' : 'mb-grid'} x1={g.m.l} x2={g.m.l + g.w} y1={g.sy(v)} y2={g.sy(v)} />
              <text className="mb-text" x={g.m.l - 8} y={g.sy(v) + 5} textAnchor="end">
                {signedPct(v, 0).replace('+', '')}
              </text>
            </g>
          ))}
          {impliedAbsPct != null && (
            <>
              <rect
                className="mb-band"
                x={g.m.l}
                y={g.sy(impliedAbsPct)}
                width={g.w}
                height={Math.max(0, g.sy(-impliedAbsPct) - g.sy(impliedAbsPct))}
              />
              <line
                className="mb-implied"
                x1={g.m.l}
                x2={g.m.l + g.w}
                y1={g.sy(impliedAbsPct)}
                y2={g.sy(impliedAbsPct)}
              />
              <line
                className="mb-implied"
                x1={g.m.l}
                x2={g.m.l + g.w}
                y1={g.sy(-impliedAbsPct)}
                y2={g.sy(-impliedAbsPct)}
              />
            </>
          )}
          {bars.map((b, i) =>
            b.movePct == null ? null : (
              <rect
                key={b.date}
                className={b.movePct >= 0 ? 'mb-up' : 'mb-down'}
                x={g.cx(i) - g.bw / 2}
                y={Math.min(g.sy(0), g.sy(b.movePct))}
                width={g.bw}
                height={Math.max(1, Math.abs(g.sy(b.movePct) - g.sy(0)))}
                opacity={hover == null || hover === i ? 1 : 0.55}
              />
            ),
          )}
          {impliedAbsPct != null && (
            <text className="mb-text mb-label" x={g.m.l + g.w - 4} y={g.m.t - 10} textAnchor="end">
              {`implied ±${impliedAbsPct.toFixed(1)}%`}
            </text>
          )}
          {g.years.map((y) => (
            <text key={y.text} className="mb-text" x={g.cx(y.i)} y={height - 10} textAnchor="middle">
              {y.text}
            </text>
          ))}
        </svg>
      )}
      {g && hb && (
        <div className="chart-tip" style={{ left: tipLeft, top: g.m.t + 4, width: tipWidth }}>
          <div className="chart-tip-head num">{expiryLabel(hb.date)}</div>
          <div className="chart-tip-row">
            <span>Move</span>
            <span className={`num ${(hb.movePct ?? 0) >= 0 ? 'gain' : 'loss'}`}>{signedPct(hb.movePct, 2)}</span>
          </div>
        </div>
      )}
    </div>
  );
}
