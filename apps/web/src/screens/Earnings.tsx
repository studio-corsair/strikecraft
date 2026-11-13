// Earnings: when the next print is, what options price in against what the stock has done,
// how much implied volatility is about to drop, and what that does to the open position.
import { useMemo, useState } from 'react';
import { useApp, useLoad } from '../state.tsx';
import type { Earnings } from '../api.ts';
import { MoveBars, countBeyond } from '../components/MoveBars.tsx';
import { Panel, Skeleton, ErrorNote, Segmented } from '../components/ui.tsx';
import { expiryLabel, num, pct, pnlClass, price, signedPct, usd, usdCompact } from '../format.ts';
import './earnings.css';

type Section = 'next' | 'history' | 'crush' | 'position';

interface Quarter {
  date: string;
  timing: string | null;
  closeBefore: number | null;
  closeAfter: number | null;
  movePct: number | null;
  gapPct: number | null;
}
interface GridRow {
  movePct: number;
  price: number | null;
  changeWithCrush: number | null;
  changeNoCrush: number | null;
  pnlVsEntryWithCrush: number | null;
}
interface EarningsView {
  nextEarnings: { date: string; timing: string | null; daysAway: number | null } | null;
  historicalReactions: {
    stats: {
      quarters: number;
      meanAbsMovePct: number | null;
      medianAbsMovePct: number | null;
      stdevMovePct: number | null;
      maxAbsMovePct: number | null;
      upCount: number;
      downCount: number;
    } | null;
    quarters: Quarter[];
  } | null;
  implied: {
    eventDecomposition: {
      method: string;
      exEventVol: number | null;
      eventMoveStd: number | null;
      postEventIv: Record<string, number | null>;
    } | null;
    impliedEventMoveAbsPct: number | null;
    impliedEventMove1SigmaPct: number | null;
    vsHistory: {
      historicalMeanAbsPct: number | null;
      ratio: number | null;
      quartersExceedingImplied: number | null;
      meaning: string;
    } | null;
  } | null;
  positionThroughEvent?: {
    ivBeforeAfter: { leg: string; ivNow: number | null; ivAfterCrush: number | null }[];
    grid: GridRow[];
    evUnderHistoricalMoves: number | null;
    breakEvenMoveWithCrush: number[] | null;
    thetaPlusCrushCostIfFlat: number | null;
  } | null;
}

export type QuarterKey = 'date' | 'timing' | 'closeBefore' | 'closeAfter' | 'movePct' | 'gapPct';
export type SortDir = 'asc' | 'desc';

/** Sort quarters by one column; empty cells always go last, whichever way it runs. */
export function sortQuarters(rows: Quarter[], key: QuarterKey, dir: SortDir): Quarter[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = a[key];
    const y = b[key];
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * sign;
    return String(x).localeCompare(String(y)) * sign;
  });
}

export const timingLabel = (t: string | null | undefined): string =>
  t === 'AMC' ? 'After close' : t === 'BMO' ? 'Before open' : '–';

const dayWord = (d: number | null | undefined): string => (d == null ? '–' : d < 1 ? 'today' : `${num(d, 1)} days`);

export function EarningsScreen() {
  const { api, symbol, legs, go } = useApp();
  const [section, setSection] = useState<Section>('next');
  const legsKey = JSON.stringify(legs);
  const earn = useLoad<Earnings>(`earnings:${symbol}:${legsKey}`, () => api.earnings(symbol, legs));
  const e = earn.data ? (earn.data as unknown as EarningsView) : null;
  const has = legs.length > 0;

  const pending = !e && !earn.error;
  const fail = earn.error ? <ErrorNote source="earnings" message={earn.error} /> : null;

  const next = e?.nextEarnings ?? null;
  const imp = e?.implied ?? null;
  const hist = e?.historicalReactions ?? null;
  const stats = hist?.stats ?? null;
  const quarters = useMemo(() => hist?.quarters ?? [], [hist]);
  const impliedAbs = imp?.impliedEventMoveAbsPct ?? null;

  const nextPanel = (
    <Panel title="Next earnings">
      {fail ??
        (pending ? (
          <Skeleton height={210} />
        ) : !next ? (
          <p className="note first">No upcoming earnings date is known for {symbol}.</p>
        ) : (
          <>
            <div className="earn-head">
              <div className="big" data-testid="implied-move">
                {impliedAbs != null ? `±${impliedAbs.toFixed(2)}%` : '–'}
              </div>
              <div className="muted">implied move</div>
            </div>
            <dl className="kv">
              <dt>Date</dt>
              <dd>
                {expiryLabel(next.date)} · {timingLabel(next.timing).toLowerCase()}
              </dd>
              <dt>Days away</dt>
              <dd>{dayWord(next.daysAway)}</dd>
              <dt>Historical average move</dt>
              <dd>{stats?.meanAbsMovePct != null ? `${stats.meanAbsMovePct.toFixed(2)}%` : '–'}</dd>
              <dt>Quarters beating implied</dt>
              <dd>
                {imp?.vsHistory?.quartersExceedingImplied != null && stats
                  ? `${imp.vsHistory.quartersExceedingImplied} / ${stats.quarters}`
                  : '–'}
              </dd>
            </dl>
            {imp?.vsHistory?.meaning && <p className="note">{imp.vsHistory.meaning}</p>}
          </>
        ))}
    </Panel>
  );

  const historyPanel = (
    <Panel title="Past reactions">
      {fail ??
        (pending ? (
          <Skeleton height={300} />
        ) : !quarters.length ? (
          <p className="note first">No past earnings reactions are available for {symbol}.</p>
        ) : (
          <>
            <MoveBars
              symbol={symbol}
              bars={[...quarters].sort((a, b) => a.date.localeCompare(b.date))}
              impliedAbsPct={impliedAbs}
            />
            {impliedAbs != null && (
              <p className="note">
                {countBeyond(quarters, impliedAbs)} of {quarters.length} quarters moved more than ±
                {impliedAbs.toFixed(1)}%.
              </p>
            )}
            <QuarterTable quarters={quarters} />
          </>
        ))}
    </Panel>
  );

  const crush = imp?.eventDecomposition ?? null;
  const crushRows = crush ? Object.entries(crush.postEventIv).sort(([a], [b]) => a.localeCompare(b)) : [];
  const crushPanel = (
    <Panel title="IV crush">
      {fail ??
        (pending ? (
          <Skeleton height={260} />
        ) : !next ? (
          <p className="note first">With no earnings date ahead, there is no event premium to lose.</p>
        ) : !crush ? (
          <p className="note first">The event premium could not be separated from this option chain.</p>
        ) : (
          <>
            <div className="table-wrap">
              <table className="data earn-crush" data-nosort>
                <thead>
                  <tr>
                    <th scope="col">Expiry</th>
                    <th scope="col">IV after print</th>
                  </tr>
                </thead>
                <tbody>
                  {crushRows.map(([exp, iv]) => (
                    <tr key={exp}>
                      <td>{expiryLabel(exp)}</td>
                      <td>{pct(iv)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <dl className="kv earn-gap">
              <dt>Ex-event vol</dt>
              <dd>{pct(crush.exEventVol)}</dd>
              <dt>Event move (1σ)</dt>
              <dd>{imp?.impliedEventMove1SigmaPct != null ? `±${imp.impliedEventMove1SigmaPct.toFixed(2)}%` : '–'}</dd>
            </dl>
            <p className="note">IV after print is the vol implied with the earnings jump removed: {crush.method}.</p>
          </>
        ))}
    </Panel>
  );

  const pos = e?.positionThroughEvent ?? null;
  const positionPanel = (
    <Panel title="Your position through the print">
      {!has ? (
        <>
          <p className="note first">Build a position on the Analyze tab to see what the print does to it.</p>
          <div className="row-actions">
            <button type="button" className="btn primary" onClick={() => go('analyze')}>
              Open Analyze
            </button>
          </div>
        </>
      ) : fail ? (
        fail
      ) : pending ? (
        <Skeleton height={380} />
      ) : !next ? (
        <p className="note first">
          No earnings print is ahead for {symbol}, so the position has no event to go through.
        </p>
      ) : !pos ? (
        <p className="note first">The position could not be repriced through the print.</p>
      ) : (
        <PositionThroughPrint pos={pos} />
      )}
    </Panel>
  );

  return (
    <div className="earn" data-section={section}>
      <Segmented<Section>
        className="phone-only"
        label="Earnings sections"
        value={section}
        onChange={setSection}
        options={[
          { value: 'next', label: 'Next' },
          { value: 'history', label: 'History' },
          { value: 'crush', label: 'Crush' },
          { value: 'position', label: 'Position' },
        ]}
      />
      <div className="earn-cell earn-next">{nextPanel}</div>
      <div className="earn-cell earn-crush-cell">{crushPanel}</div>
      <div className="earn-cell earn-history">{historyPanel}</div>
      <div className="earn-cell earn-position">{positionPanel}</div>
    </div>
  );
}

const COLUMNS: { key: QuarterKey; label: string; phone: boolean }[] = [
  { key: 'date', label: 'Date', phone: true },
  { key: 'timing', label: 'Timing', phone: false },
  { key: 'closeBefore', label: 'Close before', phone: false },
  { key: 'closeAfter', label: 'Close after', phone: false },
  { key: 'movePct', label: 'Move', phone: true },
  { key: 'gapPct', label: 'Gap', phone: true },
];

function QuarterTable({ quarters }: { quarters: Quarter[] }) {
  const [sort, setSort] = useState<{ key: QuarterKey; dir: SortDir }>({ key: 'date', dir: 'desc' });
  const rows = useMemo(() => sortQuarters(quarters, sort.key, sort.dir), [quarters, sort]);
  const toggle = (key: QuarterKey) =>
    setSort((s) => ({
      key,
      dir: s.key === key ? (s.dir === 'asc' ? 'desc' : 'asc') : key === 'date' ? 'desc' : 'asc',
    }));
  return (
    <div className="table-wrap earn-quarters">
      <table className="data earn-q" data-sortable>
        <thead>
          <tr>
            {COLUMNS.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={c.phone ? undefined : 'wide-only'}
                aria-sort={sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
              >
                <button type="button" onClick={() => toggle(c.key)}>
                  {c.label}
                  <span className="sort-mark" aria-hidden="true">
                    {sort.key === c.key ? (sort.dir === 'asc' ? '↑' : '↓') : ''}
                  </span>
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((q) => (
            <tr key={q.date}>
              <td>{expiryLabel(q.date)}</td>
              <td className="wide-only">{timingLabel(q.timing)}</td>
              <td className="wide-only">{price(q.closeBefore)}</td>
              <td className="wide-only">{price(q.closeAfter)}</td>
              <td className={`num ${pnlClass(q.movePct)}`}>{signedPct(q.movePct)}</td>
              <td className={`num ${pnlClass(q.gapPct)}`}>{signedPct(q.gapPct)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PositionThroughPrint({ pos }: { pos: NonNullable<EarningsView['positionThroughEvent']> }) {
  const be = pos.breakEvenMoveWithCrush ?? [];
  return (
    <>
      <div className="table-wrap">
        <table className="data earn-iv" data-nosort>
          <thead>
            <tr>
              <th scope="col">Leg</th>
              <th scope="col">IV now</th>
              <th scope="col">After</th>
            </tr>
          </thead>
          <tbody>
            {pos.ivBeforeAfter.map((l) => (
              <tr key={l.leg}>
                <td className="wrap">{l.leg}</td>
                <td>{pct(l.ivNow, 1)}</td>
                <td>{pct(l.ivAfterCrush, 1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <dl className="kv earn-gap">
        <dt>Cost if flat after print</dt>
        <dd className={pnlClass(pos.thetaPlusCrushCostIfFlat)}>{usd(pos.thetaPlusCrushCostIfFlat, 0)}</dd>
        <dt>Break-even move</dt>
        <dd>{be.length ? be.map((m) => signedPct(m, 1)).join(' · ') : 'none in range'}</dd>
        <dt>Expected value, historical moves</dt>
        <dd className={pnlClass(pos.evUnderHistoricalMoves)}>{usd(pos.evUnderHistoricalMoves, 0)}</dd>
      </dl>
      <h3 className="sub">P&L change by move</h3>
      <div className="table-wrap">
        <table className="data earn-grid" data-nosort /* rows run in order of the move */>
          <thead>
            <tr>
              <th scope="col">Move</th>
              <th scope="col" className="wide-only">
                Price
              </th>
              <th scope="col">With crush</th>
              <th scope="col">No crush</th>
              <th scope="col" className="wide-only">
                vs entry
              </th>
            </tr>
          </thead>
          <tbody>
            {pos.grid.map((r) => (
              <tr key={r.movePct}>
                <td className={pnlClass(r.movePct)}>
                  {signedPct(r.movePct, 1)}
                  <span className="muted phone-only-inline"> {price(r.price, 0)}</span>
                </td>
                <td className="wide-only">{price(r.price)}</td>
                <td className={pnlClass(r.changeWithCrush)}>{usdCompact(r.changeWithCrush)}</td>
                <td className={pnlClass(r.changeNoCrush)}>{usdCompact(r.changeNoCrush)}</td>
                <td className={`wide-only ${pnlClass(r.pnlVsEntryWithCrush)}`}>{usdCompact(r.pnlVsEntryWithCrush)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
