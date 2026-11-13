// Market context that explains the numbers, each input paired with what it means for the position.
import * as data from './data.ts';
import type { Json } from './http.ts';
import { rnd, median } from '@strikebench/core';
import type { Leg } from '@strikebench/core';
import { marketState, positionBlock, fillLegs } from './live.ts';

const r = (o: unknown) => data.raw<number | null>(o) ?? null;

async function lastAndMedian(sym: string, days = 252) {
  const b = await data.daily(sym, '1y');
  const closes = b.map((x) => x.close);
  return {
    last: closes[closes.length - 1] ?? null,
    median1y: median(closes.slice(-days)),
    pctile1y: closes.length
      ? closes.filter((c) => c < (closes[closes.length - 1] as number)).length / closes.length
      : null,
  };
}

export async function context(sym: string, legs: Leg[] = []) {
  const ms = await marketState(sym);
  const [s, vix, vix3m, vxn, vvix] = await Promise.all([
    data.summary(
      sym,
      'financialData,defaultKeyStatistics,summaryDetail,recommendationTrend,earningsTrend,calendarEvents,price',
    ),
    lastAndMedian('^VIX'),
    lastAndMedian('^VIX3M'),
    lastAndMedian('^VXN'),
    lastAndMedian('^VVIX'),
  ]);
  const fd = s.financialData ?? {},
    ks = s.defaultKeyStatistics ?? {},
    sd = s.summaryDetail ?? {};
  let pos = null;
  if (legs.length) {
    await fillLegs(legs, ms);
    pos = positionBlock(legs, ms);
  }
  const longDelta = pos ? (pos.greeks.delta ?? 0) > 0 : null,
    longVega = pos ? (pos.greeks.vegaPerVolPoint ?? 0) > 0 : null;
  const target = r(fd.targetMeanPrice),
    price = ms.S;
  const shortPct = r(ks.shortPercentOfFloat);
  const vixTs = vix.last != null && vix3m.last != null ? vix.last / vix3m.last : null;
  const trend = (s.earningsTrend?.trend ?? []).map((t: Json) => ({
    period: t.period,
    endDate: t.endDate,
    epsAvg: r(t.earningsEstimate?.avg),
    epsGrowth: r(t.earningsEstimate?.growth),
    revenueAvg: r(t.revenueEstimate?.avg),
    revisionsUp30d: r(t.epsRevisions?.upLast30days),
    revisionsDown30d: r(t.epsRevisions?.downLast30days),
  }));
  const rec = s.recommendationTrend?.trend?.[0];
  const items = [
    {
      input: 'Analyst price target',
      value: {
        mean: target,
        high: r(fd.targetHighPrice),
        low: r(fd.targetLowPrice),
        analysts: r(fd.numberOfAnalystOpinions),
        recommendation: fd.recommendationKey ?? null,
        upsidePct: target ? rnd((target / price - 1) * 100, 1) : null,
      },
      meaning: target
        ? `Consensus target is ${((target / price - 1) * 100).toFixed(1)}% ${target > price ? 'above' : 'below'} spot. Targets lag price and rarely bind short-dated options; useful only as a sentiment anchor${longDelta != null ? (longDelta ? ' (supports a long-delta thesis if far above spot)' : ' (headwind for a short-delta thesis if far above spot)') : ''}.`
        : 'n/a',
    },
    {
      input: 'Rating distribution (current month)',
      value: rec
        ? { strongBuy: rec.strongBuy, buy: rec.buy, hold: rec.hold, sell: rec.sell, strongSell: rec.strongSell }
        : null,
      meaning: 'Crowded buy ratings mean less room for upgrades; a downgrade cluster is a downside catalyst.',
    },
    {
      input: 'Earnings estimates & revisions',
      value: trend,
      meaning:
        'Rising estimates into the print raise the bar for a beat; net downward revisions lower it. The stock reacts to the surprise vs these numbers and to guidance, not the absolute result.',
    },
    {
      input: 'Short interest',
      value: {
        shortPctFloat: rnd(shortPct, 4),
        sharesShort: r(ks.sharesShort),
        shortRatioDays: r(ks.shortRatio),
        dateShortInterest: ks.dateShortInterest?.fmt ?? null,
      },
      meaning:
        shortPct == null
          ? 'n/a'
          : shortPct > 0.1
            ? 'High short interest: squeeze risk amplifies upside moves (good for long calls, dangerous for short calls).'
            : 'Low short interest: no meaningful squeeze fuel; moves are driven by longs repositioning.',
    },
    {
      input: 'Dividends',
      value: {
        yield: r(sd.dividendYield),
        rate: r(sd.dividendRate),
        exDividendDate: sd.exDividendDate?.fmt ?? null,
        continuousYieldUsed: rnd(ms.q, 5),
      },
      meaning:
        (r(sd.dividendYield) ?? 0) < 0.01
          ? 'Dividend is small: it trims the forward by ~yield×time and only matters for deep-ITM calls just before an ex-date (early-exercise/assignment).'
          : 'Dividend matters: calls lose value by the ex-date drop; deep ITM short calls risk early assignment the day before ex-div.',
    },
    {
      input: 'Beta / valuation',
      value: {
        beta: r(sd.beta ?? ks.beta),
        trailingPE: r(sd.trailingPE),
        forwardPE: r(sd.forwardPE ?? ks.forwardPE),
        marketCap: r(sd.marketCap),
      },
      meaning: `Beta ${rnd(r(sd.beta ?? ks.beta), 2)}: a 1% market move maps to roughly that % move in the stock, so index risk is part of this position's delta.`,
    },
    {
      input: 'VIX (S&P 30-day implied vol)',
      value: { last: rnd(vix.last, 2), median1y: rnd(vix.median1y, 2), percentile1y: rnd(vix.pctile1y, 3) },
      meaning:
        vix.last == null
          ? 'n/a'
          : vix.last > 25
            ? 'Market-wide fear is elevated: single-stock IVs carry extra premium and can fall fast if markets calm (vega risk for long options).'
            : vix.last < 15
              ? 'Complacent market: cheap index vol; single-stock event premium is the main vol driver.'
              : 'Normal market vol regime.',
    },
    {
      input: 'VIX term structure (VIX / VIX3M)',
      value: rnd(vixTs, 3),
      meaning:
        vixTs == null
          ? 'n/a'
          : vixTs > 1
            ? 'Backwardation: near-term stress priced above 3-month — historically associated with sell-offs; expect high realized vol.'
            : 'Contango (normal): no acute stress priced.',
    },
    {
      input: 'VXN (Nasdaq-100 implied vol)',
      value: { last: rnd(vxn.last, 2), median1y: rnd(vxn.median1y, 2) },
      meaning:
        'Tech-sector vol baseline; a single-name IV far above VXN is mostly idiosyncratic (earnings/event) premium that crushes after the event.',
    },
    {
      input: 'VVIX (vol of VIX)',
      value: rnd(vvix.last, 2),
      meaning:
        (vvix.last ?? 0) > 110
          ? 'Vol itself is unstable: IV can gap either way; size vega exposure down.'
          : 'Vol-of-vol normal.',
    },
    {
      input: 'Risk-free rate',
      value: { r: rnd(ms.r, 4), source: ms.rSource },
      meaning: `Carry: each 1% in rates moves this position by its rho${pos ? ` (${pos.greeks.rhoPer1Pct} $/1%)` : ''}; material only for long-dated options.`,
    },
  ];
  return {
    market: {
      symbol: sym,
      price,
      session: ms.session,
      regularClose: ms.regularClose,
      asOf: new Date(ms.now).toISOString(),
    },
    position: pos,
    positionBias: pos ? { longDelta, longVega } : null,
    items,
    notes: [
      'Sources: Yahoo quoteSummary + chart (^VIX, ^VIX3M, ^VXN, ^VVIX, ^IRX). Short interest is bi-monthly FINRA data via Yahoo, lagging ~2 weeks.',
    ],
  };
}
