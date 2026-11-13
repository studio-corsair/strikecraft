// Analyze: the position, its greeks, the risk profile by date and IV shift, a scenario grid,
// the odds, and what the next earnings print does to it.
import { useEffect, useMemo, useState } from 'react';
import { useApp, useLoad } from '../state.tsx';
import type { Analysis, Chain, Earnings, Expirations, LegInput } from '../api.ts';
import { RiskChart, RiskLegend } from '../components/RiskChart.tsx';
import { LegEditor } from '../components/LegEditor.tsx';
import { Panel, Skeleton, ErrorNote, Segmented } from '../components/ui.tsx';
import { expiryLabel, num, pct, pnlClass, price, signedPct, usd, usdCompact } from '../format.ts';
import { STRATEGIES, buildStrategy } from '../strategies.ts';
import type { StrategyId } from '../strategies.ts';

interface GridView {
  riskProfile: { movesPct: number[]; prices: (number | null)[]; rows: { date: string; pnl: (number | null)[] }[] };
}

const IV_SHIFTS = [-0.15, 0, 0.15];
const MOVES = [-15, -10, -5, 0, 5, 10, 15];
type Section = 'position' | 'risk' | 'scenarios' | 'odds';

export function Analyze() {
  const { api, feed, symbol, legs, setLegs, quote, go } = useApp();
  const [ivShift, setIvShift] = useState(0);
  const [section, setSection] = useState<Section>('position');
  const [strategyError, setStrategyError] = useState<string | null>(null);

  const exps = useLoad<Expirations>(`exp:${symbol}:${feed}`, () => api.expirations(symbol));
  // Default expiry for strategy templates: the first one at least three weeks out.
  const defaultExpiry = useMemo(() => {
    const list = exps.data?.expirations ?? [];
    return (list.find((e) => e.dte >= 21) ?? list[list.length - 1])?.expiry ?? null;
  }, [exps.data]);
  const [expiryPick, setExpiryPick] = useState<string | null>(null);
  const expiry = expiryPick && exps.data?.expirations.some((e) => e.expiry === expiryPick) ? expiryPick : defaultExpiry;
  const chain = useLoad<Chain>(expiry ? `chain:${symbol}:${expiry}:${feed}` : null, () => api.chain(symbol, expiry!));

  const legsKey = JSON.stringify(legs);
  const has = legs.length > 0;
  const spot = quote.data?.symbol === symbol ? quote.data.price : null;
  // One request prices both the curve and the scenario grid: the chart's price points plus the
  // grid's exact moves, sorted.
  const allMoves = useMemo(
    () =>
      spot
        ? [...new Set([...chartRange(JSON.parse(legsKey) as LegInput[], spot), ...MOVES])].sort((x, y) => x - y)
        : null,
    [legsKey, spot],
  );
  const curve = useLoad<Analysis>(has && allMoves ? `an:${symbol}:${legsKey}:${allMoves[0]}:${feed}` : null, () =>
    api.analyze(symbol, legs, { ivShifts: IV_SHIFTS, moves: allMoves! }),
  );
  const earn = useLoad<Earnings>(has ? `earn:${symbol}:${legsKey}` : null, () => api.earnings(symbol, legs));

  const a = has ? curve.data : null;
  const lines = useMemo(
    () =>
      a
        ? a.riskProfile.rows.filter((r) => r.ivShift === ivShift).map((r) => ({ label: shortDate(r.date), pnl: r.pnl }))
        : [],
    [a, ivShift],
  );

  // First visit with nothing stored: open on a long call so the screen shows a worked example.
  useEffect(() => {
    // Once there has been a position in this session, an empty one is the user's choice (Clear).
    if (legs.length) sessionStorage.setItem('sb.seeded', '1');
    if (legs.length || !chain.data || !expiry || sessionStorage.getItem('sb.seeded')) return;
    sessionStorage.setItem('sb.seeded', '1');
    setLegs(
      buildStrategy('long-call', {
        spot: chain.data.market.price,
        strikes: chain.data.rows.filter((r) => r.call?.mark != null).map((r) => r.strike),
        expiry,
      }),
    );
  }, [legs.length, chain.data, expiry, setLegs]);

  const applyStrategy = (id: StrategyId) => {
    setStrategyError(null);
    try {
      if (!chain.data || !expiry) throw new Error('the option chain is still loading');
      const list = exps.data?.expirations ?? [];
      const later =
        list[list.findIndex((e) => e.expiry === expiry) + 4]?.expiry ?? list[list.length - 1]?.expiry ?? null;
      setLegs(
        buildStrategy(id, {
          spot: chain.data.market.price,
          strikes: chain.data.rows.filter((r) => r.call?.mark != null && r.put?.mark != null).map((r) => r.strike),
          expiry,
          laterExpiry: later !== expiry ? later : null,
        }),
      );
      setSection('risk');
    } catch (e) {
      setStrategyError(e instanceof Error ? e.message : String(e));
    }
  };

  const position = (
    <Panel title="Position" className="an-position" busy={(has && curve.loading) || chain.loading || exps.loading}>
      {has && a ? (
        <>
          <div className="pnl-head">
            <div>
              <div className="muted">Open P&L</div>
              <div className={`big ${pnlClass(a.position.pnl)}`} data-testid="open-pnl">
                {usdCompact(a.position.pnl)}
              </div>
            </div>
            <dl className="kv compact">
              <dt>Value</dt>
              <dd>{usdCompact(a.position.value)}</dd>
              <dt>Cost</dt>
              <dd>{usdCompact(a.position.cost)}</dd>
            </dl>
          </div>
        </>
      ) : has ? (
        curve.error ? null : (
          <Skeleton height={64} />
        )
      ) : (
        <div className="pnl-head">
          <div>
            <div className="muted">Open P&L</div>
            <div className="big">–</div>
          </div>
        </div>
      )}
      {curve.error && has && <ErrorNote source="analysis" message={curve.error} />}

      <h3 className="sub">Try a strategy</h3>
      <div className="field strategy-expiry">
        <label htmlFor="strategy-expiry">Expiry for new strategies</label>
        <select
          id="strategy-expiry"
          className="select"
          value={expiry ?? ''}
          onChange={(e) => setExpiryPick(e.target.value)}
          disabled={!exps.data}
        >
          {(exps.data?.expirations ?? []).map((e) => (
            <option key={e.expiry} value={e.expiry}>
              {expiryLabel(e.expiry)} · {e.dte}d{e.firstAfterEarnings ? ' · earnings' : ''}
            </option>
          ))}
        </select>
      </div>
      <div className="chips" role="group" aria-label="Strategy templates">
        {STRATEGIES.map((s) => (
          <button key={s.id} type="button" className="chip" onClick={() => applyStrategy(s.id)} disabled={!chain.data}>
            {s.label}
          </button>
        ))}
      </div>
      {strategyError && <ErrorNote source="strategy" message={strategyError} />}
      {exps.error && <ErrorNote source="expirations" message={exps.error} />}
      {chain.error && <ErrorNote source="option chain" message={chain.error} />}

      {has && (
        <div className="row-actions">
          <button type="button" className="btn primary" onClick={() => go('trade')}>
            Trade this
          </button>
          <button type="button" className="btn" onClick={() => setLegs([])}>
            Clear position
          </button>
        </div>
      )}

      <h3 className="sub">Legs</h3>
      <LegEditor
        legs={legs}
        marks={a?.position.legs}
        onChange={setLegs}
        expirations={exps.data?.expirations.map((e) => e.expiry) ?? []}
        strikes={chain.data?.rows.map((r) => r.strike) ?? []}
        defaultExpiry={expiry}
        spot={quote.data?.price ?? null}
      />
    </Panel>
  );

  const risk = (
    <Panel
      title="Risk profile"
      className="an-risk"
      busy={has && curve.loading}
      actions={
        <div className="chips" role="group" aria-label="Implied volatility shift">
          {IV_SHIFTS.map((s) => (
            <button key={s} type="button" className="chip" aria-pressed={ivShift === s} onClick={() => setIvShift(s)}>
              IV {s === 0 ? '±0' : `${s > 0 ? '+' : '−'}${Math.abs(s * 100)}`}
            </button>
          ))}
        </div>
      }
    >
      {!has ? (
        <Empty text="The profit and loss curve of your position appears here." height={402} />
      ) : a ? (
        <>
          <RiskChart
            symbol={symbol}
            prices={a.riskProfile.prices as number[]}
            lines={lines}
            spot={a.riskProfile.underlying}
            breakevens={a.probability.breakevens as number[]}
            sigmaRange={a.probability.oneSigmaRange as [number | null, number | null]}
          />
          <RiskLegend lines={lines} spot={a.riskProfile.underlying} breakevens={a.probability.breakevens as number[]} />
        </>
      ) : curve.error ? (
        <ErrorNote source="risk profile" message={curve.error} />
      ) : (
        <Skeleton height={402} />
      )}
    </Panel>
  );

  const g = useMemo<GridView | null>(() => {
    if (!a || !allMoves) return null;
    const idx = MOVES.map((m) => allMoves.indexOf(m));
    return {
      riskProfile: {
        movesPct: MOVES,
        prices: idx.map((i) => a.riskProfile.prices[i] ?? null),
        rows: a.riskProfile.rows
          .filter((r) => r.ivShift === 0)
          .map((r) => ({ date: r.date, pnl: idx.map((i) => r.pnl[i] ?? null) })),
      },
    };
  }, [a, allMoves]);
  const scenarios = (
    <Panel title="Scenario grid: P&L vs entry" className="an-grid" busy={has && curve.loading}>
      {!has ? (
        <Empty text="P&L for each date and price move appears here." height={244} />
      ) : g ? (
        <>
          <ScenarioPhone g={g} />
          <div className="table-wrap scen-wide">
            <table className="data" data-nosort /* rows are dates in time order: sorting would scramble the timeline */>
              <thead>
                <tr>
                  <th scope="col">Date \ move</th>
                  {g.riskProfile.movesPct.map((m, i) => (
                    <th scope="col" key={i}>
                      {signedPct(m, 0)}
                      <span className="th2">{price(g.riskProfile.prices[i], 0)}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {g.riskProfile.rows.map((r) => (
                  <tr key={r.date}>
                    <td>{shortDate(r.date)}</td>
                    {r.pnl.map((v, i) => (
                      <td key={i} className={pnlClass(v)}>
                        {usdCompact(v)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : curve.error ? (
        <ErrorNote source="scenario grid" message={curve.error} />
      ) : (
        <Skeleton height={244} />
      )}
    </Panel>
  );

  const greeksPanel = (
    <Panel title="Greeks (whole position)" className="an-greeks" busy={has && curve.loading}>
      {!has ? (
        <Empty text="Delta, gamma, theta and vega of the whole position appear here." height={116} />
      ) : a ? (
        <dl className="kv greeks-grid" data-testid="greeks">
          <dt>Delta (shares)</dt>
          <dd>{num(a.position.greeks.delta)}</dd>
          <dt>Delta $</dt>
          <dd>{usdCompact(a.position.greeks.deltaDollars)}</dd>
          <dt>Gamma / $1</dt>
          <dd>{num(a.position.greeks.gamma, 2)}</dd>
          <dt>Theta / day</dt>
          <dd className={pnlClass(a.position.greeks.thetaPerDay)}>{usd(a.position.greeks.thetaPerDay, 0)}</dd>
          <dt>Vega / vol pt</dt>
          <dd>{usd(a.position.greeks.vegaPerVolPoint, 0)}</dd>
          <dt>Rho / 1%</dt>
          <dd>{usd(a.position.greeks.rhoPer1Pct, 0)}</dd>
          <dt>Vanna / vol pt</dt>
          <dd>{num(a.position.greeks.vannaPerVolPoint, 1)} sh</dd>
          <dt>Charm / day</dt>
          <dd>{num(a.position.greeks.charmPerDay, 1)} sh</dd>
        </dl>
      ) : curve.error ? (
        <ErrorNote source="greeks" message={curve.error} />
      ) : (
        <Skeleton height={116} />
      )}
    </Panel>
  );

  const p = a?.probability;
  const e = has ? earn.data : null;
  const odds = (
    <div className="an-odds">
      <Panel
        title={p ? `Probability to ${shortDate(p.horizon.slice(0, 10))}` : 'Probability'}
        busy={has && curve.loading}
      >
        {!has ? (
          <Empty text="Chance of profit, break-evens and expected value appear here." height={300} />
        ) : p ? (
          <>
            <div className="odds-head">
              <div>
                <div className="muted">P(profit) vs entry</div>
                <div className="big" data-testid="pop">
                  {pct(p.probabilityOfProfit, 0)}
                </div>
              </div>
              <div>
                <div className="muted">P(gain from today)</div>
                <div className="big">{pct(p.probProfitFromNow, 0)}</div>
              </div>
            </div>
            <dl className="kv">
              <dt>Break-even</dt>
              <dd>{p.breakevens.length ? p.breakevens.map((b) => usd(b)).join(' · ') : 'none in range'}</dd>
              <dt>Max loss</dt>
              <dd className="loss">{typeof p.maxLoss === 'number' ? usdCompact(p.maxLoss) : p.maxLoss}</dd>
              <dt>Max profit</dt>
              <dd className="gain">{typeof p.maxProfit === 'number' ? usdCompact(p.maxProfit) : p.maxProfit}</dd>
              <dt>EV vs entry</dt>
              <dd className={pnlClass(p.expectedValue)}>{usdCompact(p.expectedValue)}</dd>
              <dt>EV from today</dt>
              <dd className={pnlClass(p.expectedValueFromNow)}>{usdCompact(p.expectedValueFromNow)}</dd>
              <dt>1σ range</dt>
              <dd>
                {price(p.oneSigmaRange[0], 0)}–{price(p.oneSigmaRange[1], 0)}
              </dd>
              <dt>Vol used</dt>
              <dd>{pct(p.sigmaUsed)}</dd>
            </dl>
          </>
        ) : curve.error ? (
          <ErrorNote source="probability" message={curve.error} />
        ) : (
          <Skeleton height={300} />
        )}
      </Panel>
      <EarningsPanel has={has} e={e} error={earn.error} busy={has && earn.loading} />
      {p && p.strikes.length > 0 && (
        <Panel title="Odds at each strike">
          <dl className="kv">
            {p.strikes.map((s) => (
              <StrikeOdds key={s.strike} strike={s.strike} above={s.probAbove} touch={s.probTouch} />
            ))}
          </dl>
        </Panel>
      )}
    </div>
  );

  return (
    <div className="analyze" data-section={section}>
      <Segmented<Section>
        className="phone-only"
        label="Analyze sections"
        value={section}
        onChange={setSection}
        options={[
          { value: 'position', label: 'Position' },
          { value: 'risk', label: 'Risk' },
          { value: 'scenarios', label: 'Scenarios' },
          { value: 'odds', label: 'Odds' },
        ]}
      />
      <div className="an-col an-col-position">{position}</div>
      <div className="an-col an-center">
        <div className="an-risk-wrap">
          {risk}
          {greeksPanel}
        </div>
        <div className="an-scen-wrap">{scenarios}</div>
      </div>
      <div className="an-col an-col-odds">{odds}</div>
    </div>
  );
}

/** The scenario grid turned on its side for a phone: one row per price move, three dates across. */
function ScenarioPhone({ g }: { g: GridView }) {
  const rows = g.riskProfile.rows;
  const cols = [rows[0]!, rows[Math.floor(rows.length / 2)]!, rows[rows.length - 1]!];
  return (
    <div className="scen-phone">
      <table className="data" data-nosort /* rows are price moves in order */>
        <thead>
          <tr>
            <th scope="col">Move</th>
            {cols.map((c) => (
              <th scope="col" key={c.date}>
                {shortDate(c.date).replace('expiry ', 'exp ')}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {g.riskProfile.movesPct.map((m, i) => (
            <tr key={i}>
              <td>
                {signedPct(m, 0)} <span className="muted">{price(g.riskProfile.prices[i], 0)}</span>
              </td>
              {cols.map((c) => (
                <td key={c.date} className={pnlClass(c.pnl[i])}>
                  {usdCompact(c.pnl[i])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StrikeOdds({ strike, above, touch }: { strike: number; above: number | null; touch: number | null }) {
  return (
    <>
      <dt>P(touch {usd(strike, 0)})</dt>
      <dd>{pct(touch, 0)}</dd>
      <dt>P(above {usd(strike, 0)})</dt>
      <dd>{pct(above, 0)}</dd>
    </>
  );
}

function EarningsPanel({
  has,
  e,
  error,
  busy,
}: {
  has: boolean;
  e: Earnings | null;
  error: string | null;
  busy: boolean;
}) {
  const next = e?.nextEarnings as { date: string; timing: string } | null | undefined;
  const title = next
    ? `Earnings: ${shortDate(next.date)} ${next.timing === 'AMC' ? 'after close' : 'before open'}`
    : 'Earnings';
  const imp = e?.implied;
  const pos = e?.positionThroughEvent;
  const stats = e?.historicalReactions?.stats;
  return (
    <Panel title={title} busy={busy}>
      {!has ? (
        <Empty text="How the next earnings print changes this position appears here." height={290} />
      ) : error ? (
        <ErrorNote source="earnings" message={error} />
      ) : !e ? (
        <Skeleton height={290} />
      ) : !next ? (
        <p className="note first">No upcoming earnings date is known for this symbol.</p>
      ) : (
        <>
          <dl className="kv">
            <dt>Implied move</dt>
            <dd>{imp?.impliedEventMoveAbsPct != null ? `±${imp.impliedEventMoveAbsPct.toFixed(2)}%` : '–'}</dd>
            <dt>Average past move</dt>
            <dd>{stats?.meanAbsMovePct != null ? `${stats.meanAbsMovePct.toFixed(2)}%` : '–'}</dd>
            <dt>Beat implied</dt>
            <dd>{imp?.vsHistory ? `${imp.vsHistory.quartersExceedingImplied} / ${stats?.quarters}` : '–'}</dd>
            {pos?.ivBeforeAfter?.[0] && (
              <>
                <dt>Your IV now → after</dt>
                <dd>
                  {pct(pos.ivBeforeAfter[0].ivNow, 0)} → {pct(pos.ivBeforeAfter[0].ivAfterCrush, 0)}
                </dd>
              </>
            )}
            {pos && (
              <>
                <dt>If flat after print</dt>
                <dd className={pnlClass(pos.thetaPlusCrushCostIfFlat)}>{usdCompact(pos.thetaPlusCrushCostIfFlat)}</dd>
                <dt>Break-even move</dt>
                <dd>
                  {pos.breakEvenMoveWithCrush?.length
                    ? (pos.breakEvenMoveWithCrush as number[]).map((m) => signedPct(m, 1)).join(' · ')
                    : 'none within ±40%'}
                </dd>
              </>
            )}
          </dl>
          {imp?.vsHistory?.meaning && <p className="note">{imp.vsHistory.meaning}</p>}
        </>
      )}
    </Panel>
  );
}

/** Space held for a panel that has nothing to show until there is a position. */
function Empty({ text, height }: { text: string; height: number }) {
  return (
    <div className="empty" style={{ minHeight: height }}>
      <p className="sr-only">{text}</p>
      <span aria-hidden="true">No position</span>
    </div>
  );
}

/**
 * Price moves (percent) the chart covers: wide enough to show every strike with room either
 * side, and never narrower than ±20% around the current price. 81 evenly spaced points.
 */
export function chartRange(legs: LegInput[], spot: number): number[] {
  const strikes = legs.map((l) => l.strike).filter((k): k is number => typeof k === 'number');
  const lo = Math.min(spot * 0.8, ...strikes.map((k) => k * 0.9));
  const hi = Math.max(spot * 1.2, ...strikes.map((k) => k * 1.1));
  const n = 81;
  return Array.from({ length: n }, (_, i) => +(((lo + ((hi - lo) * i) / (n - 1)) / spot - 1) * 100).toFixed(4));
}

/** Risk-grid date labels come as "now (T+0)", "expiry 2026-12-18" or an ISO date. */
export function shortDate(label: string): string {
  if (label.startsWith('now')) return 'now';
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(label);
  if (!m) return label;
  const out = expiryLabel(`${m[1]}-${m[2]}-${m[3]}`).replace(/ '\d\d$/, '');
  return label.startsWith('expiry') ? `expiry ${out}` : out;
}

export type { LegInput };
