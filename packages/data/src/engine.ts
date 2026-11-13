// The analysis engine: turns a MarketData provider into the decision-grade JSON the UI, the CLI
// and agents consume (analyze, chain, vol, earnings). It is provider-agnostic and has no Node
// imports, so the same code runs in the local server and in the browser-only hosted demo.
// The math it calls lives in @strikecraft/core and is unit-tested against textbook vectors.
import {
  buildExpiry,
  expirySummary,
  constantMaturityIv,
  eventVariance,
  positionValue,
  probability,
  riskGrid,
  cost,
  expiryMs,
  YEAR_MS,
  legValue,
  impliedVol,
  realizedVol,
  parkinsonVol,
  yangZhangVol,
  rollingRealized,
  ivRank,
  backoutIvSeries,
  earningsReactions,
  reactionStats,
  rnd,
  mean,
} from '@strikecraft/core';
import type { Leg, Expiry } from '@strikecraft/core';
import { occ } from './symbols.ts';
import type { MarketData, Session, SourceTag } from './types.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

export interface MarketState {
  symbol: string;
  /** Latest print (extended hours included). */
  S: number;
  /** The price option marks are consistent with (the regular close outside the regular session). */
  Smarks: number;
  /** Epoch seconds that Smarks refers to. */
  markTime: number;
  session: Session;
  regularClose: number;
  prevClose: number;
  r: number;
  rSource: string;
  q: number;
  exDividendDate: string | null;
  now: number;
  /** Where the underlying quote came from. */
  quoteSource: SourceTag;
  /** Sources of the option chains fetched for this state (filled as chains are read). */
  chainsUsed: SourceTag[];
}

export interface EngineOptions {
  /** Clock, injectable for tests and for demo data frozen at its recording time. */
  now?: () => number;
  /** Chain-logger summary rows for a symbol (IV rank and implied-vs-actual history); none by default. */
  loggedSummary?: (sym: string) => Json[];
  /** How long a fetched chain slice is reused (ms). Default 20 s. */
  chainTtlMs?: number;
}

export type Engine = ReturnType<typeof createEngine>;

export function createEngine(md: MarketData, opts: EngineOptions = {}) {
  const clock = opts.now ?? Date.now;
  const readLogged = opts.loggedSummary ?? (() => []);

  /**
   * Market state. `S` = latest print (extended hours included); `Smarks` = the price option marks
   * are consistent with (the regular close outside the regular session — options don't trade then).
   */
  async function marketState(sym: string): Promise<MarketState> {
    const [qt, rf, dy] = await Promise.all([md.quote(sym), md.riskFree(), md.dividendYield(sym)]);
    return {
      quoteSource: {
        source: qt.source,
        sourceLabel: qt.sourceLabel,
        delayed: qt.delayed,
        delayMinutes: qt.delayMinutes,
        asOf: qt.asOf,
      },
      symbol: sym,
      S: qt.lastPrice,
      Smarks: qt.session === 'regular' ? qt.lastPrice : qt.regularPrice,
      markTime: qt.session === 'regular' ? qt.lastTime : qt.regularTime, // epoch s that Smarks refers to
      session: qt.session,
      regularClose: qt.regularPrice,
      prevClose: qt.prevClose,
      r: rf.r,
      rSource: rf.source,
      q: dy.q,
      exDividendDate: dy.exDividendDate,
      now: clock(),
      chainsUsed: [],
    };
  }

  // Chains are cached briefly: long enough to build a term structure from one consistent set of
  // slices, short enough that a long-running server keeps showing current marks.
  const chainTtlMs = opts.chainTtlMs ?? 20_000;
  const chainCache = new Map<string, { at: number; e: Expiry; tag: SourceTag }>();
  async function expiryChain(ms: MarketState, expiry: string): Promise<Expiry> {
    const k = `${ms.symbol}:${expiry}`;
    const hit = chainCache.get(k);
    if (!hit || clock() - hit.at > chainTtlMs) {
      const c = await md.optionChain(ms.symbol, expiry);
      chainCache.set(k, {
        at: clock(),
        tag: {
          source: c.source,
          sourceLabel: c.sourceLabel,
          delayed: c.delayed,
          delayMinutes: c.delayMinutes,
          asOf: c.asOf,
        },
        e: buildExpiry(c.calls, c.puts, { expiry, S: ms.Smarks, r: ms.r, q: ms.q, now: ms.now, markTime: ms.markTime }),
      });
    }
    const entry = chainCache.get(k)!;
    // Record the source on this call's market state, so a result names exactly the slices it used.
    if (!ms.chainsUsed.some((t) => t.source === entry.tag.source)) ms.chainsUsed.push(entry.tag);
    return entry.e;
  }

  const expirations = async (sym: string) => (await md.expirations(sym)).expirations;

  /**
   * Fill missing IV (and missing entry price → current mark) on option legs from the live chain.
   */
  async function fillLegs(legs: Leg[], ms: MarketState) {
    const notes = [];
    for (const l of legs) {
      if (l.type === 'S') {
        if (!Number.isFinite(l.entry)) l.entry = ms.S;
        continue;
      }
      const needIv = l.iv == null,
        needEntry = !Number.isFinite(l.entry);
      if (!needIv && !needEntry) continue;
      const e = await expiryChain(ms, l.expiry as string);
      const c = e.contracts.find((x) => x.right === l.type && Math.abs(x.strike - (l.strike as number)) < 1e-6);
      if (!c) throw new Error(`no ${l.type} ${l.strike} in ${ms.symbol} ${l.expiry} chain`);
      if (needEntry) {
        l.entry = c.mark as number;
        notes.push(`${c.contract}: entry = current mark ${c.mark} (${c.markSource})`);
      }
      if (needIv) {
        if (c.iv == null) throw new Error(`${c.contract}: no usable price to back out IV — pass iv=`);
        l.iv = c.iv;
        notes.push(`${c.contract}: IV ${rnd(c.iv, 4)} from ${c.markSource} vs underlying ${ms.Smarks}`);
      }
    }
    return notes;
  }

  /** Term structure across the next `maxDte` days. */
  async function termStructure(ms: MarketState, maxDte = 120) {
    const exps = (await expirations(ms.symbol)).filter(
      (d) => (expiryMs(d) - ms.now) / 864e5 <= maxDte && expiryMs(d) > ms.now,
    );
    const out = [];
    for (const d of exps) out.push(expirySummary(await expiryChain(ms, d)));
    return out;
  }

  /** Position block shared by analyze / earnings / context. */
  function positionBlock(legs: Leg[], ms: MarketState, model: 'bs' | 'american' = 'bs') {
    const m = { S: ms.S, r: ms.r, q: ms.q, now: ms.now, model };
    const v = positionValue(legs, m);
    return {
      legs: legs.map((l) => ({
        ...l,
        iv: rnd(l.iv ?? null, 4),
        mark: l.type === 'S' ? ms.S : rnd(legValue(l, m).price, 4),
      })),
      cost: rnd(cost(legs), 2),
      value: rnd(v.value, 2),
      pnl: rnd(v.pnl, 2),
      pnlPct: cost(legs) ? rnd(v.pnl / Math.abs(cost(legs)), 4) : null,
      greeks: {
        delta: rnd(v.delta, 2), // share-equivalents
        deltaDollars: rnd(v.delta * ms.S, 0),
        gamma: rnd(v.gamma, 4), // delta change per $1
        thetaPerDay: rnd(v.theta, 2),
        vegaPerVolPoint: rnd(v.vega, 2),
        rhoPer1Pct: rnd(v.rho, 2),
        vannaPerVolPoint: rnd(v.vanna, 3), // delta change per +1 vol pt
        charmPerDay: rnd(v.charm, 3), // delta change per day
        vommaPerVolPoint: rnd(v.vomma, 3),
        pnlFor1PctMove: rnd(v.delta * ms.S * 0.01 + 0.5 * v.gamma * (ms.S * 0.01) ** 2, 2),
      },
    };
  }

  /**
   * The thinkorswim "Analyze" tab as JSON.
   */
  async function analyze(
    sym: string,
    legs: Leg[],
    o: {
      ivShifts?: number[];
      dates?: string[];
      prices?: number[];
      moves?: number[];
      sigma?: number;
      steps?: number;
      model?: 'bs' | 'american';
      drift?: 'riskneutral' | 'zero';
    } = {},
  ) {
    const ms = await marketState(sym);
    const notes = await fillLegs(legs, ms);
    const m = { S: ms.S, r: ms.r, q: ms.q, now: ms.now, model: o.model ?? 'bs' };
    const prices = o.prices ?? (o.moves ? o.moves.map((p) => ms.S * (1 + p / 100)) : undefined);
    return {
      market: summarizeMarket(ms),
      sources: sourcesOf(ms),
      position: positionBlock(legs, ms, o.model),
      probability: probability(legs, m, { sigma: o.sigma, drift: o.drift }),
      riskProfile: riskGrid(legs, m, {
        ivShifts: o.ivShifts ?? [-0.1, 0, 0.1],
        dates: o.dates,
        prices,
        sigma: o.sigma,
        steps: o.steps,
      }),
      notes: [...notes, 'IV shifts are absolute vol points applied to every leg; P&L in $ for the whole position.'],
    };
  }

  const summarizeMarket = (ms: MarketState) => ({
    symbol: ms.symbol,
    price: ms.S,
    session: ms.session,
    regularClose: ms.regularClose,
    r: rnd(ms.r, 4),
    q: rnd(ms.q, 4),
    asOf: new Date(ms.now).toISOString(),
  });

  /** Where the numbers in a result came from: the underlying quote and the option chains used. */
  const sourcesOf = (ms: MarketState) => ({
    quote: ms.quoteSource,
    /** Every source an option chain in this result came from. */
    get chains(): SourceTag[] {
      return ms.chainsUsed;
    },
    /** The least fresh of them: what a single "chain source" label must say. */
    get chain(): SourceTag | null {
      return (
        [...ms.chainsUsed].sort(
          (a, b) => Number(b.delayed) - Number(a.delayed) || b.delayMinutes - a.delayMinutes,
        )[0] ?? null
      );
    },
  });

  /** Chain analytics verb. */
  async function chain(sym: string, o: { expiry?: string; maxDte?: number; strikes?: number } = {}) {
    const ms = await marketState(sym);
    const term = await termStructure(ms, o.maxDte ?? 120);
    const tsForCm = term.map((t) => ({ T: (t.dte as number) / 365, iv: t.atmIv }));
    const out: Json = {
      market: summarizeMarket(ms),
      sources: sourcesOf(ms),
      constantMaturityAtmIv: {
        d7: rnd(constantMaturityIv(tsForCm, 7), 4),
        d30: rnd(constantMaturityIv(tsForCm, 30), 4),
        d60: rnd(constantMaturityIv(tsForCm, 60), 4),
        d90: rnd(constantMaturityIv(tsForCm, 90), 4),
      },
      termStructure: term,
      notes: [
        ms.session === 'regular'
          ? 'Marks are live mids.'
          : `Session is ${ms.session}: option marks are from the last regular session; IVs solved against the regular close ${ms.regularClose}.`,
        'IVs are recomputed from marks (Yahoo impliedVolatility ignored). Skew: riskReversal25 = IV(25Δ call) − IV(25Δ put); butterfly25 = wing average − ATM.',
        'GEX sign assumes dealers long calls / short puts — a convention, not observed positioning.',
      ],
    };
    if (o.expiry) {
      const e = await expiryChain(ms, o.expiry);
      const n = o.strikes ?? 10;
      const strikes = [...new Set(e.contracts.map((c) => c.strike))]
        .sort((a, b) => Math.abs(a - ms.Smarks) - Math.abs(b - ms.Smarks))
        .slice(0, 2 * n);
      out.contracts = e.contracts
        .filter((c) => strikes.includes(c.strike))
        .sort((a, b) => a.strike - b.strike || a.right.localeCompare(b.right))
        .map((c) => ({
          contract: c.contract,
          right: c.right,
          strike: c.strike,
          bid: c.bid,
          ask: c.ask,
          mark: rnd(c.mark, 3),
          markSource: c.markSource,
          volume: c.volume,
          oi: c.oi,
          iv: rnd(c.iv, 4),
          yahooIv: rnd(c.yahooIv, 4),
          delta: rnd(c.delta, 4),
          gamma: rnd(c.gamma, 5),
          thetaPerDay: rnd(c.theta, 4),
          vegaPerVolPt: rnd(c.vega, 4),
        }));
    }
    return out;
  }

  /** Realized vol windows + HV rank + IV-vs-RV. */
  async function vol(sym: string) {
    const ms = await marketState(sym);
    const bars = await md.daily(sym, '2y');
    const closes = bars.map((b) => b.close);
    const windows = [10, 20, 30, 60, 120, 252];
    const rv20 = rollingRealized(bars, 20)
      .map((x) => x.rv)
      .filter((x) => x != null)
      .slice(-252);
    const term = await termStructure(ms, 70);
    const iv30 = constantMaturityIv(
      term.map((t) => ({ T: (t.dte as number) / 365, iv: t.atmIv })),
      30,
    );
    const rv30 = realizedVol(closes, 30);
    const hist = readLogged(sym);
    const loggedIv = hist.map((h) => h.cm30).filter((x) => x != null);
    return {
      market: summarizeMarket(ms),
      sources: sourcesOf(ms),
      realized: Object.fromEntries(windows.map((n) => [`closeToClose${n}d`, rnd(realizedVol(closes, n), 4)])),
      parkinson20d: rnd(parkinsonVol(bars, 20), 4),
      yangZhang20d: rnd(yangZhangVol(bars, 20), 4),
      hv20Rank1y: ivRank(rv20 as number[]),
      atmIv30dConstantMaturity: rnd(iv30, 4),
      ivMinusRv30: iv30 != null && rv30 != null ? rnd(iv30 - rv30, 4) : null,
      ivToRvRatio30: iv30 != null && rv30 ? rnd(iv30 / rv30, 3) : null,
      ivRank:
        loggedIv.length >= 20
          ? {
              source: `chain logger (${loggedIv.length} days of 30d constant-maturity ATM IV)`,
              ...ivRank([...loggedIv, iv30 as number]),
            }
          : {
              source: 'unavailable',
              reason: `IV rank needs a history of constant-maturity IV; the chain logger has ${loggedIv.length} day(s) so far (needs ≥20, meaningful at ≥252). Use hv20Rank1y and ivhist (per-contract backout) meanwhile.`,
            },
      meaning: interpretVol(iv30, rv30),
    };
  }

  function interpretVol(iv: number | null, rv: number | null) {
    if (iv == null || rv == null) return 'insufficient data';
    const r = iv / rv;
    if (r > 1.2)
      return `Options are pricing ${((r - 1) * 100).toFixed(0)}% more movement than the stock has realized over 30 days — rich premium (typical before earnings). Long options need a move bigger than recent history to pay; sellers are paid for that gap.`;
    if (r < 0.9)
      return 'Implied vol is below realized — options are cheap relative to recent movement; long premium has an edge if the regime persists.';
    return 'Implied vol is roughly in line with realized movement — no strong vol edge either way.';
  }

  /**
   * Per-contract IV history backed out of daily closes, aligned with realized vol.
   */
  async function ivhist(sym: string, o: { expiry: string; strike: number; right: 'C' | 'P'; range?: string }) {
    const ms = await marketState(sym);
    const contract = occ(sym, o.expiry, o.right, o.strike);
    const [ob, ub] = await Promise.all([md.daily(contract, o.range ?? '1y'), md.daily(sym, '2y')]);
    const rows = backoutIvSeries(ob, ub, { strike: o.strike, right: o.right, expiry: o.expiry, r: ms.r, q: ms.q });
    const rv = new Map(rollingRealized(ub, 20).map((x) => [x.date, x.rv]));
    const series = rows.map((r) => ({
      ...r,
      S: rnd(r.S, 2),
      optClose: rnd(r.optClose, 3),
      iv: rnd(r.iv, 4),
      rv20: rnd(rv.get(r.date) ?? null, 4),
      ivMinusRv20: r.iv != null && rv.get(r.date) != null ? rnd(r.iv - (rv.get(r.date) as number), 4) : null,
    }));
    const good = series.filter((r) => r.iv != null);
    return {
      contract,
      market: summarizeMarket(ms),
      sources: sourcesOf(ms),
      daysTotal: rows.length,
      daysUsable: good.length,
      rejected: rows
        .filter((r) => r.flag)
        .reduce((a: Record<string, number>, r) => {
          const k = String(r.flag).replace(/ \(median.*/, '');
          a[k] = (a[k] ?? 0) + 1;
          return a;
        }, {}),
      contractIvRank: ivRank(good.map((r) => r.iv as number)),
      series,
      caveat:
        'A single contract’s IV drifts with moneyness and shrinking tenor, so its IV rank is not the constant-maturity IV rank thinkorswim shows. The chain logger builds the real series going forward.',
    };
  }

  /**
   * Earnings-event analytics: next date, history of actual moves, implied event move from the term
   * structure, expected IV crush per expiry, and (with legs) P&L through the event.
   */
  async function earnings(sym: string, legs: Leg[] = [], o: { model?: 'bs' | 'american' } = {}) {
    const ms = await marketState(sym);
    const [cal, events, bars] = await Promise.all([
      md.earningsInfo(sym),
      md.earningsDates(sym).catch((e: Error) => ({ error: e.message })),
      md.daily(sym, '10y'),
    ]);
    const next = cal.next;
    const callTime = cal.callTime;
    // Infer timing for the next release from history (most companies keep their slot).
    const hist = Array.isArray(events) ? events : [];
    const slot: 'AMC' | 'BMO' = hist.length
      ? hist.slice(-4).filter((e) => e.timing === 'AMC').length >= 2
        ? 'AMC'
        : 'BMO'
      : 'AMC';
    const reactions = earningsReactions(
      hist.filter((e) => e.date < new Date(ms.now).toISOString().slice(0, 10)),
      bars,
    );
    const stats = reactionStats(reactions);
    const out: Json = {
      market: summarizeMarket(ms),
      sources: sourcesOf(ms),
      nextEarnings: next
        ? {
            date: next,
            timing: slot,
            callTimeUtc: callTime ? new Date(callTime * 1000).toISOString() : null,
            daysAway: rnd((expiryMs(next) - ms.now) / 864e5, 1),
          }
        : null,
      epsSurprises: cal.epsSurprises,
      historicalReactions: {
        source: Array.isArray(events)
          ? 'SEC 8-K Item 2.02 dates + EDGAR acceptance time'
          : `unavailable: ${events.error}`,
        stats,
        quarters: reactions,
      },
    };
    if (!next) return { ...out, note: 'no upcoming earnings date from Yahoo' };
    const term = await termStructure(ms, Math.max(45, (expiryMs(next) - ms.now) / 864e5 + 40));
    const tsT = term.map((t) => ({ expiry: t.expiry, T: (t.dte as number) / 365, iv: t.atmIv }));
    const ev = eventVariance(tsT, next, slot);
    const frontPost = term.find((t) => expiryMs(t.expiry) >= expiryMs(next) + (slot === 'AMC' ? 864e5 : 0));
    const impliedPct = ev?.eventMoveExpectedAbs != null ? ev.eventMoveExpectedAbs * 100 : null;
    out.implied = {
      eventDecomposition: ev,
      frontPostEventStraddle: frontPost?.straddle ? { expiry: frontPost.expiry, ...frontPost.straddle } : null,
      impliedEventMoveAbsPct: rnd(impliedPct, 2),
      impliedEventMove1SigmaPct: ev?.eventMoveStd != null ? rnd(ev.eventMoveStd * 100, 2) : null,
      vsHistory:
        stats && impliedPct != null
          ? {
              historicalMeanAbsPct: stats.meanAbsMovePct,
              ratio: rnd(impliedPct / (stats.meanAbsMovePct as number), 3),
              quartersExceedingImplied: reactions.filter((r) => Math.abs(r.movePct as number) > impliedPct).length,
              meaning:
                impliedPct > (stats.meanAbsMovePct as number) * 1.1
                  ? 'Options price a bigger move than the historical average — premium is rich into the print; long options need an above-average move.'
                  : impliedPct < (stats.meanAbsMovePct as number) * 0.9
                    ? 'Options price a smaller move than the historical average — event premium looks cheap.'
                    : 'Implied event move is in line with the historical average.',
            }
          : null,
      historyOfImpliedVsActual: impliedVsActual(sym, reactions),
    };
    if (legs.length) {
      const notes = await fillLegs(legs, ms);
      const after = expiryMs(next) + (slot === 'AMC' ? 864e5 : 0) - 0.5 * 3600e3; // 15:30 ET on the reaction day
      const crush = (ev?.postEventIv ?? {}) as Record<string, number | null>;
      // Each leg's IV after the print: strip the event variance from its own total variance.
      const E2 = ev?.eventMoveStd != null ? ev.eventMoveStd ** 2 : 0;
      const crushed = legs.map((l) => {
        if (l.type === 'S' || l.iv == null) return l;
        const T = (expiryMs(l.expiry as string) - ms.now) / YEAR_MS;
        const spans = expiryMs(l.expiry as string) >= after;
        const v = l.iv ** 2 * T - E2;
        return { ...l, iv: spans && v > 0 ? Math.sqrt(v / T) : l.iv };
      });
      const m = { S: ms.S, r: ms.r, q: ms.q, now: ms.now, model: o.model ?? 'bs' };
      const sd = ev?.eventMoveStd ?? (stats ? (stats.stdevMovePct as number) / 100 : 0.08);
      const moves = [-2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2].map((k) => k * sd);
      const pnlToday = positionValue(legs, m).pnl;
      // change in position value from TODAY's mark to the close after the print
      const pnl = (mv: number, L: Leg[]) => positionValue(L, m, { S: ms.S * (1 + mv), at: after }).pnl - pnlToday;
      const histMoves = reactions.map((r) => (r.movePct as number) / 100);
      out.positionThroughEvent = {
        position: positionBlock(legs, ms, o.model),
        evaluatedAt: new Date(after).toISOString(),
        ivBeforeAfter: legs
          .filter((l) => l.type !== 'S')
          .map((l, i) => ({
            leg: `${l.qty > 0 ? '+' : ''}${l.qty} ${l.type} ${l.strike} ${l.expiry}`,
            ivNow: rnd(l.iv ?? null, 4),
            ivAfterCrush: rnd((crushed.filter((x) => x.type !== 'S')[i] as Leg).iv ?? null, 4),
          })),
        grid: moves.map((mv) => ({
          movePct: rnd(mv * 100, 2),
          price: rnd(ms.S * (1 + mv), 2),
          changeWithCrush: rnd(pnl(mv, crushed), 0),
          changeNoCrush: rnd(pnl(mv, legs), 0),
          pnlVsEntryWithCrush: rnd(pnl(mv, crushed) + pnlToday, 0),
        })),
        gridNote:
          'change* = $ change from today’s mark to the close after the print; pnlVsEntry* = total P&L vs the entry cost.',
        evUnderHistoricalMoves: histMoves.length ? rnd(mean(histMoves.map((mv) => pnl(mv, crushed))), 0) : null,
        evUnderHistoricalMovesBothSigns: histMoves.length
          ? rnd(mean(histMoves.flatMap((mv) => [pnl(Math.abs(mv), crushed), pnl(-Math.abs(mv), crushed)])), 0)
          : null,
        breakEvenMoveWithCrush: breakEvenMoves((mv) => pnl(mv, crushed)),
        thetaPlusCrushCostIfFlat: rnd(pnl(0, crushed), 0),
        notes: [
          ...notes,
          `Crushed IV per leg = sqrt((σ²T − E²)/T) with event std E = ${ev?.eventMoveStd ?? 'n/a'}; postEventIv per expiry: ${JSON.stringify(crush)}`,
        ],
      };
    }
    return out;
  }

  /**
   * Join the chain logger's last pre-event implied move with the realized reaction for each past print.
   */
  function impliedVsActual(sym: string, reactions: { date: string; movePct: number | null }[]) {
    const logs = readLogged(sym);
    const rows = [];
    for (const rx of reactions) {
      const pre = logs.filter((l) => l.nextEarnings === rx.date && l.date <= rx.date && l.eventMoveAbs != null).pop();
      if (pre)
        rows.push({
          date: rx.date,
          impliedAbsPct: rnd(pre.eventMoveAbs * 100, 2),
          actualPct: rx.movePct,
          actualOverImplied: rnd(Math.abs(rx.movePct as number) / (pre.eventMoveAbs * 100), 3),
          loggedOn: pre.date,
        });
    }
    return rows.length
      ? rows
      : 'No logged pre-event implied moves yet — Yahoo keeps no option history; the chain logger fills this from the next print on.';
  }

  /** Underlying moves (fraction) where P&L crosses zero, searched in ±40%. */
  function breakEvenMoves(f: (mv: number) => number) {
    const out = [];
    let prev = f(-0.4);
    for (let i = 1; i <= 800; i++) {
      const mv = -0.4 + (0.8 * i) / 800,
        y = f(mv);
      if (Math.sign(y) !== Math.sign(prev)) out.push(rnd(mv * 100, 2));
      prev = y;
    }
    return out;
  }

  /** Back out IV of a single quote (helper for `iv` verb with live S). */
  const ivFromQuote = (
    price: number,
    p: { S: number; K: number; expiry: string; right: 'C' | 'P'; r: number; q: number },
  ) =>
    impliedVol(price, { S: p.S, K: p.K, T: (expiryMs(p.expiry) - clock()) / YEAR_MS, r: p.r, q: p.q, right: p.right });

  return {
    marketState,
    expiryChain,
    expirations,
    fillLegs,
    termStructure,
    positionBlock,
    analyze,
    chain,
    vol,
    ivhist,
    earnings,
    impliedVsActual,
    ivFromQuote,
  };
}
