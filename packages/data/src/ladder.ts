// The market-data ladder: an ordered stack of sources where the first one that answers wins.
//   connected broker stream → any other connected broker → Yahoo (delayed) → Cboe (delayed reference)
// Each answer keeps the tag of the source that produced it, so the UI can always say where a
// price came from. A source that just failed a method sits out a short cooldown before it is
// asked again, so a dead rung does not add its timeout to every request.
import type {
  MarketData,
  MarketDataMethod,
  MarketDataMethods,
  MarketDataSource,
  SourceId,
  SourceInfo,
} from './types.ts';

export interface RungStatus extends SourceInfo {
  /** Position in the ladder, 1 = asked first. */
  rank: number;
  /** Methods this source implements. */
  serves: MarketDataMethod[];
  /**
   * live     = answered its most recent request and is real-time
   * delayed  = answered its most recent request and is a delayed source
   * error    = failed its most recent request (see lastError)
   * idle     = not asked yet
   */
  state: 'live' | 'delayed' | 'error' | 'idle';
  lastOk: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
}

export interface Ladder extends MarketData {
  /** One row per source, in ladder order. */
  status(): RungStatus[];
  /** Which source answered the most recent call of each method. */
  lastServedBy(): Partial<Record<MarketDataMethod, SourceId>>;
}

const METHODS: MarketDataMethod[] = [
  'quote',
  'expirations',
  'optionChain',
  'daily',
  'riskFree',
  'dividendYield',
  'earningsInfo',
  'earningsDates',
];

export interface LadderOptions {
  /** How long a source sits out a method after failing it (ms). Default 30 s. */
  cooldownMs?: number;
  now?: () => number;
}

export function createLadder(sources: MarketDataSource[], opts: LadderOptions = {}): Ladder {
  if (!sources.length) throw new Error('a ladder needs at least one market-data source');
  const cooldownMs = opts.cooldownMs ?? 30_000;
  const now = opts.now ?? Date.now;
  const state = sources.map(() => ({
    lastOk: null as number | null,
    lastError: null as string | null,
    lastErrorAt: null as number | null,
    failedAt: new Map<MarketDataMethod, number>(),
  }));
  const served: Partial<Record<MarketDataMethod, SourceId>> = {};

  async function call<M extends MarketDataMethod>(
    method: M,
    args: Parameters<MarketDataMethods[M]>,
  ): Promise<Awaited<ReturnType<MarketDataMethods[M]>>> {
    const errors: string[] = [];
    const candidates = sources.map((s, i) => ({ s, i })).filter(({ s }) => typeof s[method] === 'function');
    if (!candidates.length) throw new Error(`no market-data source provides ${method}`);
    // Sources in cooldown go last rather than being skipped, so a ladder of one still answers.
    const ready = candidates.filter(({ i }) => now() - (state[i]!.failedAt.get(method) ?? -Infinity) >= cooldownMs);
    const cooling = candidates.filter((c) => !ready.includes(c));
    for (const { s, i } of [...ready, ...cooling]) {
      const st = state[i]!;
      try {
        const fn = s[method] as (...a: unknown[]) => Promise<unknown>;
        const out = await fn.apply(s, args);
        st.lastOk = now();
        st.lastError = null;
        st.failedAt.delete(method);
        served[method] = s.id;
        return out as Awaited<ReturnType<MarketDataMethods[M]>>;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        st.lastError = `${method}: ${msg}`;
        st.lastErrorAt = now();
        st.failedAt.set(method, now());
        errors.push(`${s.label}: ${msg}`);
      }
    }
    throw new Error(`no market-data source answered ${method} (${errors.join('; ')})`);
  }

  const top = sources[0]!;
  return {
    id: top.id,
    label: top.label,
    delayMinutes: top.delayMinutes,
    quote: (sym) => call('quote', [sym]),
    expirations: (sym) => call('expirations', [sym]),
    optionChain: (sym, expiry) => call('optionChain', [sym, expiry]),
    daily: (sym, range) => call('daily', [sym, range]),
    riskFree: () => call('riskFree', []),
    dividendYield: (sym) => call('dividendYield', [sym]),
    earningsInfo: (sym) => call('earningsInfo', [sym]),
    earningsDates: (sym) => call('earningsDates', [sym]),
    status: () =>
      sources.map((s, i) => {
        const st = state[i]!;
        const failedLast = st.lastErrorAt != null && (st.lastOk == null || st.lastErrorAt > st.lastOk);
        return {
          id: s.id,
          label: s.label,
          delayMinutes: s.delayMinutes,
          rank: i + 1,
          serves: METHODS.filter((m) => typeof s[m] === 'function'),
          state: failedLast ? 'error' : st.lastOk == null ? 'idle' : s.delayMinutes > 0 ? 'delayed' : 'live',
          lastOk: st.lastOk,
          lastError: failedLast ? st.lastError : null,
          lastErrorAt: st.lastErrorAt,
        };
      }),
    lastServedBy: () => ({ ...served }),
  };
}
