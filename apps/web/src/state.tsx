// App-wide state: the API handle, the symbol in focus, the position being worked on, and status.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { getApi } from './api.ts';
import type { Api, LegInput, Quote, Status } from './api.ts';

export type Tab = 'analyze' | 'trade' | 'earnings' | 'connections';
export const TABS: { id: Tab; label: string }[] = [
  { id: 'analyze', label: 'Analyze' },
  { id: 'trade', label: 'Trade' },
  { id: 'earnings', label: 'Earnings' },
  { id: 'connections', label: 'Brokers' },
];

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Run an async loader whenever its key changes. Keeps the previous data on screen while the next
 * request is in flight (no flash to empty), and ignores answers that arrive out of order.
 */
export function useLoad<T>(key: string | null, load: () => Promise<T>): Loaded<T> {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({
    data: null,
    error: null,
    loading: key != null,
  });
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  const fn = useRef(load);
  fn.current = load;
  useEffect(() => {
    if (key == null) {
      setState({ data: null, error: null, loading: false });
      return;
    }
    const mine = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    fn.current().then(
      (data) => mine === seq.current && setState({ data, error: null, loading: false }),
      (e: unknown) =>
        mine === seq.current &&
        setState((s) => ({ data: s.data, error: e instanceof Error ? e.message : String(e), loading: false })),
    );
  }, [key, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

/** Call `fn` every `ms` while enabled and the page is visible. */
export function usePoll(fn: () => void, ms: number, enabled: boolean): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') ref.current();
    }, ms);
    return () => clearInterval(id);
  }, [ms, enabled]);
}

function readStored<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback; // error-ok: storage is a convenience (private windows block it); defaults apply
  }
}
function writeStored(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // error-ok: storage unavailable (private window): the state simply does not persist
  }
}

interface AppState {
  api: Api;
  /** Identifies the connected data sources; part of every data key so prices refetch when it changes. */
  feed: string;
  /** True when prices can change (not the frozen demo): screens poll while visible. */
  live: boolean;
  status: Loaded<Status>;
  symbol: string;
  setSymbol: (s: string) => void;
  quote: Loaded<Quote>;
  legs: LegInput[];
  setLegs: (legs: LegInput[]) => void;
  tab: Tab;
  go: (t: Tab) => void;
}

const Ctx = createContext<AppState | null>(null);
export const useApp = (): AppState => {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside AppProvider');
  return v;
};

/** Each screen has its own path (/analyze, /trade, …); "/" is Analyze. */
const tabFromPath = (): Tab => {
  const p = location.pathname.replace(/^\/+|\/+$/g, '');
  return (TABS.find((t) => t.id === p)?.id ?? 'analyze') as Tab;
};

export function AppProvider({ children }: { children: (ready: boolean, bootError: string | null) => ReactNode }) {
  const [api, setApi] = useState<Api | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  useEffect(() => {
    getApi().then(setApi, (e: unknown) => setBootError(e instanceof Error ? e.message : String(e)));
  }, []);

  const [symbol, setSymbolRaw] = useState<string>(() => readStored('sb.symbol', 'NVDA'));
  const [legs, setLegsRaw] = useState<LegInput[]>(() => readStored('sb.legs', [] as LegInput[]));
  const [tab, setTab] = useState<Tab>(tabFromPath);

  useEffect(() => {
    const on = () => setTab(tabFromPath());
    addEventListener('popstate', on);
    return () => removeEventListener('popstate', on);
  }, []);
  const go = useCallback((t: Tab) => {
    if (tabFromPath() !== t || location.pathname === '/') history.pushState(null, '', `/${t}`);
    setTab(t);
    scrollTo(0, 0);
  }, []);

  const setSymbol = useCallback((s: string) => {
    const v = s.trim().toUpperCase();
    if (!v) return;
    setSymbolRaw((prev) => {
      if (prev !== v) {
        // A position belongs to its underlying: switching symbols starts a clean one.
        setLegsRaw([]);
        writeStored('sb.legs', []);
      }
      return v;
    });
    writeStored('sb.symbol', v);
  }, []);
  const setLegs = useCallback((l: LegInput[]) => {
    setLegsRaw(l);
    writeStored('sb.legs', l);
  }, []);

  const status = useLoad<Status>(api ? 'status' : null, () => api!.status());
  // Which sources are connected: when that changes (a broker is connected or removed), every
  // price on screen is refetched so it comes from the new top rung.
  const feed = (status.data?.ladder ?? []).map((r) => r.id).join('>');
  const live = status.data?.mode === 'local';
  const quote = useLoad<Quote>(api && status.data ? `quote:${symbol}:${feed}` : null, () => api!.quote(symbol));
  usePoll(quote.reload, 10_000, live);

  // In the demo only some symbols exist: fall back to the first one if the stored symbol is not there.
  const demoSymbols = status.data?.demo?.symbols;
  useEffect(() => {
    if (demoSymbols && !demoSymbols.includes(symbol)) setSymbol(demoSymbols[0]!);
  }, [demoSymbols, symbol, setSymbol]);

  const value = useMemo<AppState | null>(
    () => (api ? { api, feed, live, status, symbol, setSymbol, quote, legs, setLegs, tab, go } : null),
    [api, feed, live, status, symbol, setSymbol, quote, legs, setLegs, tab, go],
  );
  if (!value) return <>{children(false, bootError)}</>;
  return <Ctx.Provider value={value}>{children(true, null)}</Ctx.Provider>;
}
