// The application service: everything the UI can ask for, as plain JSON in and out.
// It is the single place the UI's API is implemented, and it has no Node imports, so:
//   - the local server exposes these methods over HTTP (apps/server), and
//   - the hosted demo calls them directly in the browser over demo data.
// Keys never pass through here to anywhere except the adapter of the broker they belong to.
import { expiryMs, expirySummary, cost as legCost } from '@strikecraft/core';
import type { Leg } from '@strikecraft/core';
import { createEngine } from './engine.ts';
import type { Engine, EngineOptions, MarketState } from './engine.ts';
import { createLadder } from './ladder.ts';
import type { Ladder } from './ladder.ts';
import { occ, parseOcc } from './symbols.ts';
import type { MarketDataSource, SourceTag } from './types.ts';
import { BROKERS, createBroker } from './broker/registry.ts';
import type { BrokerDeps } from './broker/registry.ts';
import { paperBroker, PAPER_ACCOUNT } from './broker/paper.ts';
import type { Broker, BrokerEnv, BrokerPosition, OrderRequest, OrderStatus } from './broker/types.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

export interface SavedConnection {
  broker: string;
  env: BrokerEnv;
  credentials: Record<string, string>;
  accountId: string;
}

export interface Settings {
  /** Off by default. While off, no order can reach a live account. */
  allowLiveOrders: boolean;
}

export interface SavedState {
  connections: SavedConnection[];
  settings: Settings;
}

/** Where connections and settings are kept (a 0600 file for the local server, memory for the demo). */
export interface StateStore {
  load(): Promise<SavedState>;
  save(s: SavedState): Promise<void>;
}

export const memoryStore = (initial?: Partial<SavedState>): StateStore => {
  let state: SavedState = {
    connections: initial?.connections ?? [],
    settings: initial?.settings ?? { allowLiveOrders: false },
  };
  return {
    load: async () => structuredClone(state),
    save: async (s) => {
      state = structuredClone(s);
    },
  };
};

export interface LegInput {
  qty: number;
  type: 'C' | 'P' | 'S';
  strike?: number;
  expiry?: string;
  /** Price paid per share; omit to use the current mark. */
  entry?: number | null;
  iv?: number | null;
}

export interface ServiceOptions {
  /** 'demo' = recorded/simulated data only, no broker connections, nothing leaves the page. */
  mode: 'local' | 'demo';
  /** Public sources under the broker rungs, in order (Yahoo, Cboe) or the demo source. */
  baseSources: MarketDataSource[];
  store: StateStore;
  deps: Omit<BrokerDeps, 'allowLiveOrders'>;
  engine?: EngineOptions;
  demo?: { simulated: boolean; symbols: string[]; asOf: number } | null;
  /** Seed for the built-in paper account. */
  paper?: { cash?: number; positions?: BrokerPosition[]; orders?: OrderStatus[] };
  version?: string;
}

export type Service = Awaited<ReturnType<typeof createService>>;

const toLegs = (legs: LegInput[]): Leg[] =>
  legs.map((l) => {
    if (!Number.isFinite(l.qty) || l.qty === 0) throw new Error('every leg needs a non-zero quantity');
    if (l.type === 'S') return { qty: l.qty, type: 'S', entry: l.entry ?? NaN, mult: 1 };
    if (!(typeof l.strike === 'number' && l.strike > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(l.expiry ?? ''))
      throw new Error('an option leg needs a strike and an expiry (YYYY-MM-DD)');
    return {
      qty: l.qty,
      type: l.type,
      strike: l.strike,
      expiry: l.expiry,
      entry: l.entry ?? NaN,
      iv: l.iv ?? null,
      mult: 100,
    };
  });

const symOk = (s: unknown): string => {
  const v = String(s ?? '')
    .trim()
    .toUpperCase();
  if (!/^[A-Z^][A-Z0-9.\-^]{0,9}$/.test(v)) throw new Error(`"${String(s ?? '')}" is not a valid symbol`);
  return v;
};

export async function createService(o: ServiceOptions) {
  let saved = await o.store.load();
  const connected = new Map<string, { broker: Broker; env: BrokerEnv; accountId: string }>();
  let ladder!: Ladder;
  let engine!: Engine;

  const paper = paperBroker({
    cash: o.paper?.cash,
    positions: o.paper?.positions,
    orders: o.paper?.orders,
    now: o.engine?.now,
    mid: async (underlying, legSymbol) => {
      const ms = await engine.marketState(underlying);
      const id = parseOcc(legSymbol);
      if (!id) return ms.S;
      const e = await engine.expiryChain(ms, id.expiry);
      return e.contracts.find((c) => c.right === id.right && Math.abs(c.strike - id.strike) < 1e-6)?.mark ?? null;
    },
  });

  function rebuild() {
    connected.clear();
    for (const c of saved.connections) {
      const broker = createBroker(c.broker, c.credentials, c.env, {
        ...o.deps,
        allowLiveOrders: saved.settings.allowLiveOrders,
      });
      connected.set(c.broker, { broker, env: c.env, accountId: c.accountId });
    }
    ladder = createLadder([...[...connected.values()].map((c) => c.broker.marketData()), ...o.baseSources], {
      now: o.engine?.now,
    });
    engine = createEngine(ladder, o.engine);
  }
  rebuild();

  /**
   * Change connections or settings: write to the store first, and only when that succeeded make it
   * the state in effect. A failed save leaves memory, status and the brokers exactly as they were.
   */
  async function commit(next: SavedState) {
    await o.store.save(next);
    saved = next;
    rebuild();
  }

  /** The broker orders go to: the most recently connected one, else the built-in paper account. */
  const active = () => {
    const last = [...connected.entries()].at(-1);
    return last
      ? { id: last[0], broker: last[1].broker, env: last[1].env, accountId: last[1].accountId }
      : { id: 'paper', broker: paper, env: 'sandbox' as BrokerEnv, accountId: PAPER_ACCOUNT };
  };

  const market = (ms: MarketState) => ({
    symbol: ms.symbol,
    price: ms.S,
    change: ms.S - ms.prevClose,
    changePct: ms.prevClose ? (ms.S / ms.prevClose - 1) * 100 : null,
    session: ms.session,
    regularClose: ms.regularClose,
    prevClose: ms.prevClose,
    r: ms.r,
    rSource: ms.rSource,
    asOf: ms.now,
    source: ms.quoteSource,
  });

  const noDemo = (what: string) => {
    if (o.mode === 'demo')
      throw new Error(
        `${what} is not available in the demo: install Strikecraft locally (npx strikecraft) to connect your own broker.`,
      );
  };

  return {
    async status() {
      const a = active();
      return {
        version: o.version ?? 'dev',
        mode: o.mode,
        demo: o.demo ?? null,
        ladder: ladder.status(),
        activeBroker: { id: a.id, label: a.broker.label, env: a.env, liveOrdersAllowed: a.broker.liveOrdersAllowed },
        connections: [...connected.entries()].map(([id, c]) => ({
          id,
          label: c.broker.label,
          env: c.env,
          accountMasked: `••${c.accountId.slice(-4)}`,
          hosts: c.broker.hosts,
        })),
        settings: saved.settings,
        brokers: BROKERS.map((b) => ({
          id: b.id,
          label: b.label,
          status: b.status,
          capabilities: b.capabilities,
          envs: b.envs,
          credentials: b.credentials,
          credentialHelp: b.credentialHelp,
          docsUrl: b.docsUrl,
          plannedNote: b.plannedNote ?? null,
        })),
      };
    },

    async quote(symbol: string) {
      return market(await engine.marketState(symOk(symbol)));
    },

    /** Expiry chips: days to expiry, ATM IV, and whether the expiry spans the next earnings print. */
    async expirations(symbol: string) {
      const sym = symOk(symbol);
      const ms = await engine.marketState(sym);
      const [list, info] = await Promise.all([
        engine.expirations(sym),
        ladder.earningsInfo(sym).catch(() => ({ next: null })), // error-ok: earnings date is optional context for the chips
      ]);
      const eventEnd = info.next ? expiryMs(info.next) : null;
      const live = list.filter((d) => expiryMs(d) > ms.now);
      const firstSpanning = eventEnd == null ? null : (live.find((d) => expiryMs(d) >= eventEnd) ?? null);
      return {
        market: market(ms),
        nextEarnings: info.next,
        expirations: live.map((d) => ({
          expiry: d,
          dte: Math.max(0, Math.round((expiryMs(d) - ms.now) / 864e5)),
          spansEarnings: eventEnd != null && expiryMs(d) >= eventEnd,
          firstAfterEarnings: d === firstSpanning,
        })),
      };
    },

    /** One expiry as strike rows with call and put side by side, plus that expiry's summary. */
    async chain(symbol: string, expiry: string) {
      const sym = symOk(symbol);
      const ms = await engine.marketState(sym);
      const e = await engine.expiryChain(ms, expiry);
      const strikes = [...new Set(e.contracts.map((c) => c.strike))].sort((a, b) => a - b);
      const cell = (strike: number, right: 'C' | 'P') => {
        const c = e.contracts.find((x) => x.strike === strike && x.right === right);
        return c
          ? {
              symbol: occ(sym, expiry, right, strike),
              bid: c.bid,
              ask: c.ask,
              mark: c.mark,
              markSource: c.markSource,
              iv: c.iv,
              delta: c.delta,
              gamma: c.gamma,
              theta: c.theta,
              vega: c.vega,
              volume: c.volume,
              oi: c.oi,
            }
          : null;
      };
      return {
        market: market(ms),
        expiry,
        dte: Math.max(0, (expiryMs(expiry) - ms.now) / 864e5),
        summary: expirySummary(e),
        rows: strikes.map((k) => ({ strike: k, call: cell(k, 'C'), put: cell(k, 'P') })),
        sources: { quote: ms.quoteSource, chain: ms.chainsUsed[0] ?? null } as {
          quote: SourceTag;
          chain: SourceTag | null;
        },
      };
    },

    async analyze(
      symbol: string,
      legs: LegInput[],
      opts: { ivShifts?: number[]; dates?: string[]; moves?: number[]; steps?: number; model?: 'bs' | 'american' } = {},
    ) {
      if (!legs.length) throw new Error('add at least one leg to analyze');
      const out = await engine.analyze(symOk(symbol), toLegs(legs), opts);
      return { ...out, sources: { quote: out.sources.quote, chains: out.sources.chains, chain: out.sources.chain } };
    },

    async earnings(symbol: string, legs: LegInput[] = []): Promise<Json> {
      const out = await engine.earnings(symOk(symbol), toLegs(legs));
      return { ...out, sources: { quote: out.sources.quote, chains: out.sources.chains, chain: out.sources.chain } };
    },

    async vol(symbol: string) {
      return engine.vol(symOk(symbol));
    },

    /** The active broker's account: balances, positions (with analyzable legs) and orders. */
    async account() {
      const a = active();
      const [balances, positions, orders] = await Promise.all([
        a.broker.balances(a.accountId),
        a.broker.positions(a.accountId),
        a.broker.orders(a.accountId),
      ]);
      return {
        broker: { id: a.id, label: a.broker.label, env: a.env, liveOrdersAllowed: a.broker.liveOrdersAllowed },
        accountMasked: a.id === 'paper' ? 'Paper' : `••${a.accountId.slice(-4)}`,
        balances: { ...balances, accountId: undefined },
        positions: positions.map((p) => ({
          ...p,
          leg:
            p.kind === 'option'
              ? ({
                  qty: p.quantity,
                  type: p.right!,
                  strike: p.strike!,
                  expiry: p.expiry!,
                  entry: Math.abs(p.costBasis / (p.quantity * 100)),
                } satisfies LegInput)
              : ({ qty: p.quantity, type: 'S', entry: Math.abs(p.costBasis / p.quantity) } satisfies LegInput),
        })),
        // Newest first, whatever order the broker lists them in.
        orders: [...orders].sort(
          (x, y) => (y.createdAt ?? '').localeCompare(x.createdAt ?? '') || Number(y.id) - Number(x.id),
        ),
      };
    },

    async previewOrder(order: OrderRequest) {
      const a = active();
      const preview = await a.broker.previewOrder(a.accountId, order);
      return { ...preview, broker: { id: a.id, label: a.broker.label, env: a.env } };
    },

    async placeOrder(order: OrderRequest) {
      const a = active();
      const placed = await a.broker.placeOrder(a.accountId, order);
      return { ...placed, broker: { id: a.id, label: a.broker.label, env: a.env } };
    },

    async cancelOrder(orderId: string) {
      const a = active();
      return a.broker.cancelOrder(a.accountId, String(orderId));
    },

    /** Verify the credentials against the broker (a read-only accounts call), then keep them. */
    async connect(brokerId: string, env: BrokerEnv, credentials: Record<string, string>) {
      noDemo('Connecting a broker');
      const broker = createBroker(brokerId, credentials, env, { ...o.deps, allowLiveOrders: false });
      const accounts = await broker.accounts();
      if (!accounts.length) throw new Error(`${broker.label} accepted the key but returned no accounts`);
      await commit({
        ...saved,
        connections: [
          ...saved.connections.filter((c) => c.broker !== brokerId),
          { broker: brokerId, env, credentials, accountId: accounts[0]!.id },
        ],
      });
      return { ok: true, broker: brokerId, env, accounts: accounts.length };
    },

    async disconnect(brokerId: string) {
      noDemo('Disconnecting a broker');
      await commit({ ...saved, connections: saved.connections.filter((c) => c.broker !== brokerId) });
      return { ok: true };
    },

    async setSettings(patch: Partial<Settings>) {
      if (patch.allowLiveOrders === true) noDemo('Live trading');
      await commit({ ...saved, settings: { ...saved.settings, ...patch } });
      return saved.settings;
    },

    /** Cost of a set of legs at their entry prices (debit > 0). */
    cost: (legs: LegInput[]) => legCost(toLegs(legs)),
    /** For tests and the server's stream endpoint. */
    internals: () => ({ ladder, engine, active }),
  };
}
