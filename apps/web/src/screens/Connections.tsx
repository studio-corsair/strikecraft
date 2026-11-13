// Connections: brokers (connect / disconnect), the market-data ladder, the live-order switch and
// facts about this install. Every control shows what the server says after a reload, not the click.
import { Fragment, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useApp } from '../state.tsx';
import type { BrokerEnv, Status } from '../api.ts';
import { Panel, Skeleton, ErrorNote } from '../components/ui.tsx';
import './connections.css';

type Broker = Status['brokers'][number];
type Connection = Status['connections'][number];
type Rung = Status['ladder'][number];
type SortKey = 'name' | 'status' | 'optionOrders' | 'multiLeg' | 'quotes' | 'paper' | 'signIn';

const DEMO_SENTENCE =
  'The demo runs on simulated data. Install Strikebench on your own machine (npx strikebench) to connect a broker.';

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const envLabel = (env: string): string =>
  env === 'sandbox' ? 'Sandbox (paper money)' : env === 'live' ? 'Live account' : env;

/** Tracks a media query so only one layout (table or list) is in the DOM, never two copies of a form. */
function useMedia(query: string): boolean {
  const [match, setMatch] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const m = matchMedia(query);
    const on = () => setMatch(m.matches);
    on();
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [query]);
  return match;
}

function YesNo({ value }: { value: boolean }) {
  return (
    <span className={`yn ${value ? 'yes' : 'no'}`}>
      <span className="dot" aria-hidden="true" />
      {value ? 'Yes' : 'No'}
    </span>
  );
}

function Quotes({ b }: { b: Broker }) {
  const q = b.capabilities.realTimeQuality;
  return (
    <span className={`q-${q}`}>
      <span className="dot" aria-hidden="true" />
      {b.capabilities.realTimeOptionQuotes}
      <span className="sr-only">
        {q === 'yes' ? ' (real-time)' : q === 'partial' ? ' (partly real-time)' : ' (not real-time)'}
      </span>
    </span>
  );
}

function Paper({ b }: { b: Broker }) {
  return (
    <span className="paper">
      <YesNo value={b.capabilities.paperTrading} />
      {b.capabilities.paperNote ? <span className="muted"> {b.capabilities.paperNote}</span> : null}
    </span>
  );
}

const QUALITY_RANK = { yes: 0, partial: 1, no: 2 } as const;

function sortValue(b: Broker, key: SortKey, conn: Connection | undefined): string | number {
  const c = b.capabilities;
  switch (key) {
    case 'name':
      return b.label.toLowerCase();
    case 'status':
      return conn ? 0 : b.status === 'available' ? 1 : 2;
    case 'optionOrders':
      return c.optionOrders ? 0 : 1;
    case 'multiLeg':
      return c.multiLeg ? 0 : 1;
    case 'quotes':
      return QUALITY_RANK[c.realTimeQuality] * 1000 + c.realTimeOptionQuotes.charCodeAt(0);
    case 'paper':
      return c.paperTrading ? 0 : 1;
    case 'signIn':
      return c.signIn.toLowerCase();
  }
}

interface ConnectFormProps {
  broker: Broker;
  onDone: () => void;
  onCancel: () => void;
}

function ConnectForm({ broker, onDone, onCancel }: ConnectFormProps) {
  const { api } = useApp();
  const [env, setEnv] = useState<BrokerEnv>(broker.envs[0] ?? 'sandbox');
  const [values, setValues] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = `conn-${broker.id}`;

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await api.connect(broker.id, env, values);
      setValues({});
      onDone();
    } catch (e) {
      setError(errText(e));
      setPending(false);
    }
  };

  return (
    <form className="conn-form" onSubmit={submit} aria-label={`Connect ${broker.label}`}>
      <div className="field">
        <label htmlFor={`${id}-env`}>Environment</label>
        <select
          id={`${id}-env`}
          className="select"
          value={env}
          onChange={(e) => setEnv(e.target.value as BrokerEnv)}
          disabled={pending}
        >
          {broker.envs.map((e) => (
            <option key={e} value={e}>
              {envLabel(e)}
            </option>
          ))}
        </select>
      </div>
      {broker.credentials.map((c) => (
        <div className="field" key={c.key}>
          <label htmlFor={`${id}-${c.key}`}>{c.label}</label>
          <input
            id={`${id}-${c.key}`}
            className="input"
            type={c.secret ? 'password' : 'text'}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            value={values[c.key] ?? ''}
            onChange={(e) => setValues((v) => ({ ...v, [c.key]: e.target.value }))}
            disabled={pending}
          />
        </div>
      ))}
      <p className="note first">{broker.credentialHelp}</p>
      {env === 'live' && (
        <p className="note first">Live orders stay blocked until you turn on Allow live orders below.</p>
      )}
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}
      <div className="row-actions conn-actions">
        <button type="submit" className="btn primary" disabled={pending} data-uisweep-destructive>
          {pending ? 'Checking key' : 'Connect'}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={pending}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function BrokerStatus({
  b,
  conn,
  onConnect,
  onDisconnect,
  busy,
  error,
  canConnect,
}: {
  b: Broker;
  conn: Connection | undefined;
  onConnect: () => void;
  onDisconnect: () => void;
  busy: boolean;
  error: string | null;
  canConnect: boolean;
}) {
  if (conn) {
    return (
      <div className="stat">
        <span className="pill live">
          Connected · {conn.env} {conn.accountMasked}
        </span>
        <button type="button" className="btn small" onClick={onDisconnect} disabled={busy} data-uisweep-destructive>
          {busy ? 'Disconnecting' : 'Disconnect'}
        </button>
        {error && (
          <div className="alert" role="alert">
            {error}
          </div>
        )}
      </div>
    );
  }
  if (b.status === 'available') {
    return canConnect ? (
      <button type="button" className="btn small" onClick={onConnect} aria-label={`Connect ${b.label}`}>
        Connect
      </button>
    ) : (
      <span className="muted">Not available in the demo</span>
    );
  }
  return (
    <div className="planned">
      <span>Planned</span>
      {b.plannedNote && <span className="muted"> {b.plannedNote}</span>}
    </div>
  );
}

function BrokersPanel({ status }: { status: Status }) {
  const { api, status: st } = useApp();
  const phone = useMedia('(max-width: 719px)');
  const demo = status.mode === 'demo';
  const [open, setOpen] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: 'ascending' | 'descending' }>({
    key: 'status',
    dir: 'ascending',
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  const connFor = (id: string) => status.connections.find((c) => c.id === id);
  const rows = status.brokers
    .map((b, i) => ({ b, i, conn: connFor(b.id) }))
    .sort((x, y) => {
      const a = sortValue(x.b, sort.key, x.conn);
      const c = sortValue(y.b, sort.key, y.conn);
      const d = a < c ? -1 : a > c ? 1 : 0;
      return (sort.dir === 'ascending' ? d : -d) || x.i - y.i;
    });

  const disconnect = async (id: string) => {
    setBusy(id);
    setRowErrors((e) => Object.fromEntries(Object.entries(e).filter(([k]) => k !== id)));
    try {
      await api.disconnect(id);
      st.reload();
    } catch (e) {
      setRowErrors((r) => ({ ...r, [id]: errText(e) }));
    } finally {
      setBusy(null);
    }
  };

  const done = () => {
    setOpen(null);
    st.reload();
  };
  const form = (b: Broker) => <ConnectForm broker={b} onDone={done} onCancel={() => setOpen(null)} />;
  const statusCell = (b: Broker, conn: Connection | undefined) => (
    <BrokerStatus
      b={b}
      conn={conn}
      onConnect={() => setOpen(b.id)}
      onDisconnect={() => void disconnect(b.id)}
      busy={busy === b.id}
      error={rowErrors[b.id] ?? null}
      canConnect={!demo}
    />
  );

  const COLS: { key: SortKey; label: string }[] = [
    { key: 'name', label: 'Broker' },
    { key: 'status', label: 'Status' },
    { key: 'optionOrders', label: 'Options orders' },
    { key: 'multiLeg', label: 'Multi-leg' },
    { key: 'quotes', label: 'Real-time option quotes' },
    { key: 'paper', label: 'Paper trading' },
    { key: 'signIn', label: 'Sign-in' },
  ];

  return (
    <Panel title="Brokers" className="conn-brokers">
      {demo && <p className="note first demo-note">{DEMO_SENTENCE}</p>}
      {phone ? (
        <ul className="broker-list">
          {rows.map(({ b, conn }) => (
            <li key={b.id} className="broker-item">
              <div className="broker-head">
                <strong>{b.label}</strong>
                {statusCell(b, conn)}
              </div>
              <dl className="kv">
                <dt>Options orders</dt>
                <dd>
                  <YesNo value={b.capabilities.optionOrders} />
                </dd>
                <dt>Multi-leg</dt>
                <dd>
                  <YesNo value={b.capabilities.multiLeg} />
                </dd>
                <dt>Real-time option quotes</dt>
                <dd>
                  <Quotes b={b} />
                </dd>
                <dt>Paper trading</dt>
                <dd>
                  <Paper b={b} />
                </dd>
                <dt>Sign-in</dt>
                <dd>{b.capabilities.signIn}</dd>
              </dl>
              {open === b.id && !demo && form(b)}
            </li>
          ))}
        </ul>
      ) : (
        <div className="table-wrap">
          <table className="data broker-table">
            <thead>
              <tr>
                {COLS.map((c) => (
                  <th key={c.key} scope="col" aria-sort={sort.key === c.key ? sort.dir : 'none'}>
                    <button
                      type="button"
                      onClick={() =>
                        setSort((s) => ({
                          key: c.key,
                          dir: s.key === c.key && s.dir === 'ascending' ? 'descending' : 'ascending',
                        }))
                      }
                    >
                      {c.label}
                      <span aria-hidden="true">
                        {sort.key === c.key ? (sort.dir === 'ascending' ? ' ▲' : ' ▼') : ''}
                      </span>
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ b, conn }) => (
                <Fragment key={b.id}>
                  <tr>
                    <th scope="row" className="broker-name">
                      {b.label}
                    </th>
                    <td>{statusCell(b, conn)}</td>
                    <td>
                      <YesNo value={b.capabilities.optionOrders} />
                    </td>
                    <td>
                      <YesNo value={b.capabilities.multiLeg} />
                    </td>
                    <td>
                      <Quotes b={b} />
                    </td>
                    <td>
                      <Paper b={b} />
                    </td>
                    <td>{b.capabilities.signIn}</td>
                  </tr>
                  {open === b.id && !demo && (
                    <tr className="form-row">
                      <td colSpan={COLS.length}>{form(b)}</td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function latency(r: Rung): string {
  if (r.id === 'demo') return 'simulated';
  return r.delayMinutes === 0 ? 'real-time' : `${r.delayMinutes} min delayed`;
}

function LadderPanel({ ladder }: { ladder: Rung[] }) {
  const rungs = [...ladder].sort((a, b) => a.rank - b.rank);
  return (
    <Panel title="Market data" className="conn-ladder">
      <ol className="ladder">
        {rungs.map((r) => (
          <li key={r.id} className="rung">
            <span className="num rank">{r.rank}</span>
            <span className="rung-label">{r.label}</span>
            <span className="num rung-lat">{latency(r)}</span>
            <span className="rung-state">
              {r.state === 'live' && <span className="pill live">live</span>}
              {r.state === 'delayed' && <span className="pill delayed">delayed</span>}
              {r.state === 'error' && <span className="pill error">error</span>}
              {r.state === 'idle' && <span className="muted">not asked yet</span>}
            </span>
            {r.state === 'error' && r.lastError && <span className="rung-err">{r.lastError}</span>}
          </li>
        ))}
      </ol>
    </Panel>
  );
}

function SafetyPanel({ status }: { status: Status }) {
  const { api, status: st } = useApp();
  const on = status.settings.allowLiveOrders;
  const demo = status.mode === 'demo';
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = async (value: boolean) => {
    setPending(true);
    setError(null);
    try {
      await api.setSettings({ allowLiveOrders: value });
      setConfirming(false);
      st.reload();
    } catch (e) {
      setError(errText(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <Panel title="Order safety" className="conn-safety">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        className="switch"
        disabled={pending || demo}
        onClick={() => (on ? void set(false) : setConfirming(true))}
        data-uisweep-destructive
      >
        <span className="switch-track" aria-hidden="true">
          <span className="switch-knob" />
        </span>
        <span>Allow live orders</span>
      </button>
      <p className="note">
        {demo
          ? 'Live trading is not available in the demo. Paper orders always work.'
          : 'While this is off, no order can reach a live account. Sandbox and paper orders always work.'}
      </p>
      {confirming && !on && (
        <div className="confirm" role="group" aria-label="Confirm live orders">
          <p>Real orders will be sent to your live broker account with real money.</p>
          <div className="row-actions conn-actions">
            <button
              type="button"
              className="btn primary"
              disabled={pending}
              onClick={() => void set(true)}
              data-uisweep-destructive
            >
              {pending ? 'Turning on' : 'Turn on live orders'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={pending}
              onClick={() => {
                setConfirming(false);
                setError(null);
              }}
            >
              Keep off
            </button>
          </div>
        </div>
      )}
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}
    </Panel>
  );
}

function AboutPanel({ status }: { status: Status }) {
  const demo = status.mode === 'demo';
  const ab = status.activeBroker;
  return (
    <Panel title="About this install" className="conn-about">
      <dl className="kv">
        <dt>Version</dt>
        <dd>{status.version}</dd>
        <dt>Mode</dt>
        <dd>{demo ? 'Demo' : 'Local'}</dd>
        <dt>Where keys are kept</dt>
        <dd className="wrap">
          {demo ? 'Nowhere: the demo stores nothing' : 'On this machine only, in a file only you can read'}
        </dd>
        <dt>Active broker</dt>
        <dd className="wrap">
          {ab.label} · {ab.env}
        </dd>
      </dl>
    </Panel>
  );
}

export function Connections() {
  const { status } = useApp();
  const s = status.data;
  // Source states change as prices are fetched elsewhere in the app: read them fresh on arrival.
  const reload = status.reload;
  useEffect(() => reload(), [reload]);
  if (!s) {
    return status.error ? (
      <Panel title="Connections">
        <ErrorNote source="status" message={status.error} />
      </Panel>
    ) : (
      <div className="connections">
        <div className="conn-main">
          <Panel title="Brokers">
            <Skeleton height={320} />
          </Panel>
        </div>
        <div className="conn-side">
          <Panel title="Market data">
            <Skeleton height={120} />
          </Panel>
          <Panel title="Order safety">
            <Skeleton height={100} />
          </Panel>
          <Panel title="About this install">
            <Skeleton height={140} />
          </Panel>
        </div>
      </div>
    );
  }
  return (
    <div className="connections">
      {status.error && <ErrorNote source="status" message={status.error} />}
      <div className="conn-main">
        <BrokersPanel status={s} />
      </div>
      <div className="conn-side">
        <LadderPanel ladder={s.ladder} />
        <SafetyPanel status={s} />
        <AboutPanel status={s} />
      </div>
    </div>
  );
}
