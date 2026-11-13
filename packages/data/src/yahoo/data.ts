// Free market data: Yahoo Finance (quotes, history, option chains, fundamentals; cookie+crumb
// dance ported from the finance skill's yahoo.mjs) and SEC EDGAR (full history of earnings
// release dates + release time, from 8-K Item 2.02 filings). Read-only, no keys.
import { httpFetch } from './http.ts';
import type { Json } from './http.ts';
import type { RawOptionRow } from '@strikecraft/core';
const UA = { 'User-Agent': 'Mozilla/5.0' };
// SEC asks automated clients to identify themselves; a generic tool name (no personal contact) is used.
const SEC_UA = { 'User-Agent': 'finance-analytics research-tool', Accept: 'application/json' };

let auth: { cookie: string; crumb: string } | undefined;
async function crumb() {
  if (auth) return auth;
  const c = await httpFetch('https://fc.yahoo.com', { headers: UA });
  const cookie = (c.headers.getSetCookie?.() ?? []).map((x) => x.split(';')[0]).join('; ');
  const t = await (
    await httpFetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { ...UA, Cookie: cookie } })
  ).text();
  if (!t || t.includes('<')) throw new Error('could not get Yahoo crumb (rate-limited?)');
  return (auth = { cookie, crumb: t });
}
async function yget(url: string, withCrumb = true): Promise<Json> {
  const headers: Record<string, string> = { ...UA };
  if (withCrumb) {
    const a = await crumb();
    url += `${url.includes('?') ? '&' : '?'}crumb=${encodeURIComponent(a.crumb)}`;
    Object.assign(headers, { Cookie: a.cookie });
  }
  const res = await httpFetch(url, { headers });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status} ${url.split('?')[0]}`);
  return res.json();
}

export const iso = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
/** Yahoo wraps most numbers as `{raw, fmt}`; unwrap when present. */
export const raw = <T = number>(o: unknown): T => (o && typeof o === 'object' && 'raw' in o ? o.raw : o) as T;

/** quoteSummary modules. */
export async function summary(sym: string, modules: string): Promise<Json> {
  const j = await yget(
    `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=${modules}`,
  );
  return j.quoteSummary?.result?.[0] ?? {};
}

/** Raw chart result. */
export async function chart(sym: string, range: string, interval: string, prepost = false): Promise<Json> {
  const j = await yget(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=${interval}&includePrePost=${prepost}&events=div,split`,
    false,
  );
  const r = j.chart?.result?.[0];
  if (!r) throw new Error(`no chart for ${sym}: ${j.chart?.error?.description ?? 'empty'}`);
  return r;
}

export type DailyBar = {
  date: string;
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
  adjclose: number;
  volume: number;
};

/** Daily OHLCV bars (nulls dropped). */
export async function daily(sym: string, range = '1y'): Promise<DailyBar[]> {
  const r = await chart(sym, range, '1d');
  const q = r.indicators.quote[0],
    adj = r.indicators.adjclose?.[0]?.adjclose;
  const out: DailyBar[] = [];
  ((r.timestamp ?? []) as number[]).forEach((t, i) => {
    if (q.close[i] == null) return;
    out.push({
      date: iso(t),
      t,
      open: q.open[i],
      high: q.high[i],
      low: q.low[i],
      close: q.close[i],
      adjclose: adj?.[i] ?? q.close[i],
      volume: q.volume[i] ?? 0,
    });
  });
  return out;
}

export type Quote = {
  symbol: string;
  regularPrice: number;
  regularTime: number;
  lastPrice: number;
  lastTime: number;
  prevClose: number;
  session: 'regular' | 'pre' | 'post' | 'closed';
  currency: string;
};

/** Live-ish quote: regular price, latest extended-hours print, session, previous close. */
export async function quote(sym: string): Promise<Quote> {
  const r = await chart(sym, '1d', '1m', true),
    m = r.meta;
  const cl: (number | null)[] = r.indicators.quote[0].close ?? [],
    ts: number[] = r.timestamp ?? [];
  let last = m.regularMarketPrice,
    lastT = m.regularMarketTime;
  for (let i = cl.length - 1; i >= 0; i--)
    if (cl[i] != null) {
      if ((ts[i] as number) > lastT) {
        last = cl[i];
        lastT = ts[i];
      }
      break;
    }
  const now = Date.now() / 1000,
    p = m.currentTradingPeriod;
  const session = !p
    ? 'regular'
    : now >= p.regular.start && now < p.regular.end
      ? 'regular'
      : now >= p.pre.start && now < p.pre.end
        ? 'pre'
        : now >= p.post.start && now < p.post.end
          ? 'post'
          : 'closed';
  return {
    symbol: sym,
    regularPrice: m.regularMarketPrice,
    regularTime: m.regularMarketTime,
    lastPrice: last,
    lastTime: lastT,
    prevClose: m.chartPreviousClose,
    session,
    currency: m.currency,
  };
}

/**
 * Option chain. No expiry → expirations list; with one → raw calls/puts rows.
 * @param expiry YYYY-MM-DD
 */
export async function optionChain(
  sym: string,
  expiry?: string,
): Promise<{ symbol: string; quote: Json; expirations: string[]; calls: RawOptionRow[]; puts: RawOptionRow[] }> {
  const base = `https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(sym)}`;
  const first = (await yget(base)).optionChain.result[0];
  const expirations: string[] = first.expirationDates.map(iso);
  if (!expiry) return { symbol: sym, quote: first.quote, expirations, calls: [], puts: [] };
  const t = first.expirationDates.find((d: number) => iso(d) === expiry);
  if (!t) throw new Error(`no expiry ${expiry}; have ${expirations.join(' ')}`);
  const res = (await yget(`${base}?date=${t}`)).optionChain.result[0];
  const o = res.options[0] ?? { calls: [], puts: [] };
  return { symbol: sym, quote: res.quote, expirations, calls: o.calls, puts: o.puts };
}

/** OCC contract symbol, e.g. NVDA261218C00185000. */
export const occ = (sym: string, expiry: string, right: 'C' | 'P', strike: number) =>
  `${sym.toUpperCase()}${expiry.slice(2).replace(/-/g, '')}${right}${String(Math.round(strike * 1000)).padStart(8, '0')}`;

/** Risk-free rate from the 13-week T-bill (^IRX, percent). Falls back to 4% with a flag. */
export async function riskFree(): Promise<{ r: number; source: string }> {
  try {
    const r = await chart('^IRX', '5d', '1d');
    return { r: r.meta.regularMarketPrice / 100, source: '^IRX 13-week T-bill' };
  } catch (e) {
    return { r: 0.04, source: `fallback 4% (${(e as Error).message})` }; // error-ok: surfaced in output.source
  }
}

/** Continuous dividend yield from summaryDetail (0 when none). */
export async function dividendYield(sym: string): Promise<{ q: number; exDividendDate: string | null }> {
  const s = await summary(sym, 'summaryDetail');
  const y = raw(s.summaryDetail?.dividendYield) ?? raw(s.summaryDetail?.trailingAnnualDividendYield) ?? 0;
  return { q: Math.log(1 + (y || 0)), exDividendDate: s.summaryDetail?.exDividendDate?.fmt ?? null };
}

let cikMap: Record<string, string> | undefined;
async function cikOf(sym: string) {
  if (!cikMap) {
    const res = await httpFetch('https://www.sec.gov/files/company_tickers.json', { headers: SEC_UA });
    if (!res.ok) throw new Error(`SEC tickers HTTP ${res.status}`);
    const j = await res.json();
    cikMap = Object.fromEntries(
      Object.values(j).map((x: { ticker: string; cik_str: number | string }) => [
        x.ticker,
        String(x.cik_str).padStart(10, '0'),
      ]),
    );
  }
  const c = cikMap[sym.toUpperCase()];
  if (!c) throw new Error(`no SEC CIK for ${sym} (non-US issuer or ETF?)`);
  return c;
}

export type EarningsDate = { date: string; acceptedET: string; timing: 'AMC' | 'BMO' | 'DURING' };

/**
 * Historical earnings releases from SEC 8-K filings carrying Item 2.02 (Results of Operations).
 * `timing` comes from the EDGAR acceptance time (ET): after 16:00 → AMC, before 09:30 → BMO.
 */
export async function earningsDatesSEC(sym: string): Promise<EarningsDate[]> {
  const cik = await cikOf(sym);
  const res = await httpFetch(`https://data.sec.gov/submissions/CIK${cik}.json`, { headers: SEC_UA });
  if (!res.ok) throw new Error(`SEC submissions HTTP ${res.status}`);
  const f = (await res.json()).filings.recent;
  const out: EarningsDate[] = [];
  for (let i = 0; i < f.form.length; i++) {
    if (!/^8-K/.test(f.form[i]) || !/2\.02/.test(f.items[i] ?? '')) continue;
    const acc = new Date(f.acceptanceDateTime[i]);
    const et = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    }).format(acc);
    const [h, mi] = et.split(':').map(Number);
    const mins = (h as number) * 60 + (mi as number);
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(acc);
    out.push({ date, acceptedET: et, timing: mins >= 16 * 60 ? 'AMC' : mins < 9 * 60 + 30 ? 'BMO' : 'DURING' });
  }
  // 8-K/A amendments can duplicate a date — keep the first filing per date.
  const seen = new Set();
  return out
    .filter((e) => (seen.has(e.date) ? false : (seen.add(e.date), true)))
    .sort((a, b) => a.date.localeCompare(b.date));
}
