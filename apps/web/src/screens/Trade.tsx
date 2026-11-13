// Trade: the option chain, a multi-leg ticket that previews with the broker before anything is
// sent, and the account's working and filled orders.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp, useLoad, usePoll } from '../state.tsx';
import type {
  Account,
  Analysis,
  Chain,
  ChainCell,
  ChainRow,
  Expirations,
  LegInput,
  OrderRequest,
  Preview,
} from '../api.ts';
import { Panel, Skeleton, ErrorNote, Segmented } from '../components/ui.tsx';
import { expiryLabel, legLabel, num, pct, pnlClass, price, usd, usdCompact } from '../format.ts';
import { addLeg, legKey, nearestIndex } from '../strategies.ts';
import { buildOrder, contractWords, lotsOf, netMid, priceLabel, sideWords } from '../ticket.ts';
import type { Intent } from '../ticket.ts';
import './trade.css';

type Section = 'chain' | 'ticket' | 'orders';
const WINDOW = 6; // strikes shown each side of the centre of the window
// A page is a whole window: no strike appears on two pages, so a contract never changes place.
const PAGE = 2 * WINDOW + 1;

export function Trade() {
  const { api, feed, live, symbol, legs, setLegs, status, go } = useApp();
  const [section, setSection] = useState<Section>('chain');
  const [expiryPick, setExpiryPick] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);

  const exps = useLoad<Expirations>(`exp:${symbol}:${feed}`, () => api.expirations(symbol));
  const list = exps.data?.expirations ?? [];
  const legExpiry = legs.find((l) => l.expiry)?.expiry ?? null;
  const defaultExpiry =
    (list.find((e) => e.expiry === legExpiry) ?? list.find((e) => e.dte >= 21) ?? list[list.length - 1])?.expiry ??
    null;
  const expiry = expiryPick && list.some((e) => e.expiry === expiryPick) ? expiryPick : defaultExpiry;
  const chain = useLoad<Chain>(expiry ? `chain:${symbol}:${expiry}:${feed}` : null, () => api.chain(symbol, expiry!));
  const account = useLoad<Account>(`account:${feed}`, () => api.account());
  usePoll(chain.reload, 15_000, live);
  usePoll(account.reload, 15_000, live);
  // Brokers apply orders and cancels asynchronously: after any order action, re-read the account a
  // few times so the list settles on what the broker says, without waiting for the next poll.
  const settle = useCallback(() => {
    account.reload();
    for (const ms of [1500, 4000, 9000]) setTimeout(account.reload, ms);
  }, [account.reload]);

  // A fixed number of row slots. The window opens centred on the money and is paged up or down
  // the strike list; a slot with no listed strike stays as an empty row. The table therefore has
  // one size for every expiry and every page, and nothing around it ever moves.
  const rows = useMemo(() => {
    const all = chain.data?.rows ?? [];
    if (!all.length || !chain.data) return { slots: [] as (ChainRow | null)[], atm: -1, lower: false, higher: false };
    const atm = nearestIndex(
      all.map((r) => r.strike),
      chain.data.market.price,
    );
    const centre = atm + offset;
    const slots = Array.from({ length: 2 * WINDOW + 1 }, (_, i) => all[centre - WINDOW + i] ?? null);
    return {
      slots,
      atm: all[atm]!.strike,
      lower: centre - WINDOW > 0,
      higher: centre + WINDOW < all.length - 1,
    };
  }, [chain.data, offset]);
  useEffect(() => setOffset(0), [symbol, expiry]);

  const inTicket = (right: 'C' | 'P', strike: number) =>
    legs.find((l) => l.type === right && l.strike === strike && l.expiry === expiry) ?? null;
  const pick = (right: 'C' | 'P', strike: number, qty: number) => {
    if (!expiry) return;
    setLegs(addLeg(legs, { qty, type: right, strike, expiry }));
  };

  const chainPanel = (
    <Panel title="Option chain" className="tr-chain" busy={chain.loading && !!chain.data}>
      {exps.error && <ErrorNote source="expirations" message={exps.error} />}
      <div className="field expiry-select">
        <label htmlFor="trade-expiry">Expiry</label>
        <select
          id="trade-expiry"
          className="select"
          value={expiry ?? ''}
          onChange={(e) => setExpiryPick(e.target.value)}
          disabled={!list.length}
        >
          {list.map((e) => (
            <option key={e.expiry} value={e.expiry}>
              {expiryLabel(e.expiry)} · {e.dte}d{e.firstAfterEarnings ? ' · earnings' : ''}
            </option>
          ))}
        </select>
      </div>
      <div className="chips expiry-chips" role="group" aria-label="Expiry">
        {list.map((e) => (
          <button
            key={e.expiry}
            type="button"
            className="chip num"
            aria-pressed={e.expiry === expiry}
            onClick={() => setExpiryPick(e.expiry)}
          >
            {expiryLabel(e.expiry).replace(/ '\d\d$/, '')} · {e.dte}d{e.firstAfterEarnings ? ' · earnings' : ''}
          </button>
        ))}
      </div>
      {chain.error ? (
        <ErrorNote source="option chain" message={chain.error} />
      ) : !chain.data ? (
        <Skeleton height={560} />
      ) : (
        <>
          <div className="row-actions strike-pager">
            <button type="button" className="btn" onClick={() => setOffset((x) => x - PAGE)} disabled={!rows.lower}>
              Lower strikes
            </button>
            <button type="button" className="btn" onClick={() => setOffset((x) => x + PAGE)} disabled={!rows.higher}>
              Higher strikes
            </button>
          </div>
          <div className="table-wrap">
            <table
              className="data chain"
              data-nosort /* a chain is read by strike order; calls and puts mirror around it */
            >
              <thead>
                <tr>
                  <th scope="col" className="wide">
                    Call Δ
                  </th>
                  <th scope="col" className="wide">
                    IV
                  </th>
                  <th scope="col" className="wide">
                    Volume
                  </th>
                  <th scope="col">
                    <span className="side-word">Call</span> bid
                  </th>
                  <th scope="col">
                    <span className="side-word">Call</span> ask
                  </th>
                  <th scope="col" className="strike">
                    Strike
                  </th>
                  <th scope="col">
                    <span className="side-word">Put</span> bid
                  </th>
                  <th scope="col">
                    <span className="side-word">Put</span> ask
                  </th>
                  <th scope="col" className="wide">
                    Volume
                  </th>
                  <th scope="col" className="wide">
                    IV
                  </th>
                  <th scope="col" className="wide">
                    Put Δ
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.slots.map((r, slot) => {
                  if (!r)
                    return (
                      <tr key={`blank-${slot}`} className="blank" aria-hidden="true">
                        <td colSpan={11} />
                      </tr>
                    );
                  const c = inTicket('C', r.strike),
                    p = inTicket('P', r.strike);
                  return (
                    <tr key={r.strike} className={r.strike === rows.atm ? 'atm' : undefined}>
                      <td className="wide">{num(r.call?.delta, 2)}</td>
                      <td className="wide">{pct(r.call?.iv)}</td>
                      <td className="wide">{num(r.call?.volume)}</td>
                      <QuoteCell
                        cell={r.call}
                        side="bid"
                        label={`Sell ${r.strike} call at the bid`}
                        active={!!c && c.qty < 0}
                        onPick={() => pick('C', r.strike, -1)}
                      />
                      <QuoteCell
                        cell={r.call}
                        side="ask"
                        label={`Buy ${r.strike} call at the ask`}
                        active={!!c && c.qty > 0}
                        onPick={() => pick('C', r.strike, 1)}
                      />
                      <th scope="row" className="strike num">
                        {r.strike}
                      </th>
                      <QuoteCell
                        cell={r.put}
                        side="bid"
                        label={`Sell ${r.strike} put at the bid`}
                        active={!!p && p.qty < 0}
                        onPick={() => pick('P', r.strike, -1)}
                      />
                      <QuoteCell
                        cell={r.put}
                        side="ask"
                        label={`Buy ${r.strike} put at the ask`}
                        active={!!p && p.qty > 0}
                        onPick={() => pick('P', r.strike, 1)}
                      />
                      <td className="wide">{num(r.put?.volume)}</td>
                      <td className="wide">{pct(r.put?.iv)}</td>
                      <td className="wide">{num(r.put?.delta, 2)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <dl className="kv chain-summary">
            <dt>At-the-money straddle</dt>
            <dd>{chain.data.summary.straddle ? `±${chain.data.summary.straddle.movePct}%` : '–'}</dd>
            <dt>At-the-money IV</dt>
            <dd>{pct(chain.data.summary.atmIv)}</dd>
          </dl>
        </>
      )}
    </Panel>
  );

  return (
    <div className="trade" data-section={section}>
      <Segmented<Section>
        className="phone-only"
        label="Trade sections"
        value={section}
        onChange={setSection}
        options={[
          { value: 'chain', label: 'Chain' },
          { value: 'ticket', label: legs.length ? `Ticket (${legs.length})` : 'Ticket' },
          { value: 'orders', label: 'Orders' },
        ]}
      />
      <div className="tr-col tr-col-chain">{chainPanel}</div>
      <div className="tr-col tr-col-ticket">
        <Ticket
          key={symbol}
          onSent={() => {
            settle();
            setSection('orders');
          }}
          onAnalyze={() => go('analyze')}
          broker={status.data?.activeBroker ?? null}
        />
      </div>
      <div className="tr-col tr-col-orders">
        <Orders account={account} onChanged={settle} onAnalyzeLegs={(l) => (setLegs(l), go('analyze'))} />
      </div>
    </div>
  );
}

function QuoteCell({
  cell,
  side,
  label,
  active,
  onPick,
}: {
  cell: ChainCell | null;
  side: 'bid' | 'ask';
  label: string;
  active: boolean;
  onPick: () => void;
}) {
  const v = cell?.[side];
  return (
    <td className="q">
      <button
        type="button"
        className="qbtn num"
        aria-label={`${label} (${price(v)})`}
        aria-pressed={active}
        onClick={onPick}
        disabled={!cell}
      >
        {price(v)}
      </button>
    </td>
  );
}

interface BrokerInfo {
  id: string;
  label: string;
  env: string;
  liveOrdersAllowed: boolean;
}

function Ticket({
  onSent,
  onAnalyze,
  broker,
}: {
  onSent: () => void;
  onAnalyze: () => void;
  broker: BrokerInfo | null;
}) {
  const { api, symbol, legs, setLegs } = useApp();
  const [intent, setIntent] = useState<Intent>('open');
  const [priceText, setPriceText] = useState('');
  const [market, setMarket] = useState(false);
  const [duration, setDuration] = useState<'day' | 'gtc'>('day');
  const [preview, setPreview] = useState<{ order: OrderRequest; result: Preview } | null>(null);
  const [busy, setBusy] = useState<'preview' | 'send' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [confirmLive, setConfirmLive] = useState(false);

  const legsKey = JSON.stringify(legs.map((l) => ({ ...l, entry: null })));
  const has = legs.length > 0;
  // Marks, greeks and odds for the ticket as a fresh position (entry = current mark).
  const an = useLoad<Analysis>(has ? `ticket:${symbol}:${legsKey}` : null, () =>
    api.analyze(
      symbol,
      legs.map((l) => ({ ...l, entry: null })),
      { ivShifts: [0], moves: [0] },
    ),
  );
  const a = has ? an.data : null;
  const net = a
    ? netMid(
        legs,
        a.position.legs.map((l) => l.mark),
      )
    : null;
  const lots = lotsOf(legs);

  // Any change to the ticket invalidates a preview: the user must preview what will be sent.
  useEffect(() => {
    setPreview(null);
    setSent(null);
    setError(null);
    setConfirmLive(false);
  }, [legsKey, intent, priceText, market, duration]);
  // New legs start at the mid.
  useEffect(() => setPriceText(''), [legsKey]);

  const typed = priceText.trim() === '' ? null : Number(priceText);
  const limit = market ? null : (typed ?? (net != null ? Math.round(Math.abs(net) * 100) / 100 : null));
  const isLive = broker?.env === 'live';
  const liveBlocked = isLive && !broker?.liveOrdersAllowed;

  const order = (): OrderRequest => {
    if (!market && (limit == null || !Number.isFinite(limit)))
      throw new Error('enter a price, or choose a market order');
    return buildOrder(legs, { symbol, intent, price: market ? null : limit, duration, net });
  };

  const doPreview = async () => {
    setBusy('preview');
    setError(null);
    setSent(null);
    try {
      const o = order();
      setPreview({ order: o, result: await api.previewOrder(o) });
    } catch (e) {
      setPreview(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const doSend = async () => {
    if (!preview) return;
    setBusy('send');
    setError(null);
    try {
      const placed = await api.placeOrder(preview.order);
      setSent(`Order ${placed.id} sent to ${placed.broker.label}: ${placed.state}.`);
      setPreview(null);
      onSent();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const setQty = (i: number, n: number) =>
    setLegs(legs.map((l, j) => (j === i ? { ...l, qty: Math.max(1, Math.round(n) || 1) * Math.sign(l.qty) } : l)));
  const flip = (i: number) => setLegs(legs.map((l, j) => (j === i ? { ...l, qty: -l.qty } : l)));
  const priceWord = legs.length === 1 ? 'Limit price' : net != null && net < 0 ? 'Net credit' : 'Net debit';
  const p = preview?.result;

  return (
    <>
      <Panel title="Order ticket" className="tr-ticket" busy={has && an.loading}>
        {
          <>
            <div className="chips" role="group" aria-label="Opening or closing">
              <button
                type="button"
                className="chip"
                aria-pressed={intent === 'open'}
                onClick={() => setIntent('open')}
                disabled={!has}
              >
                Open a position
              </button>
              <button
                type="button"
                className="chip"
                aria-pressed={intent === 'close'}
                onClick={() => setIntent('close')}
                disabled={!has}
              >
                Close a position
              </button>
            </div>
            <ul className="ticket-legs">
              {!has && <li className="muted">No legs</li>}
              {legs.map((l, i) => (
                <li key={legKey(l)} data-testid="ticket-leg">
                  <div className="num ticket-leg-name">{legLabel(l)}</div>
                  <div className="ticket-leg-controls">
                    <button
                      type="button"
                      className="btn small"
                      onClick={() => flip(i)}
                      aria-label={`Switch ${legLabel(l)} between buy and sell`}
                    >
                      {l.qty > 0 ? 'Buying' : 'Selling'}
                    </button>
                    <label className="sr-only" htmlFor={`tq-${i}`}>
                      Quantity for {legLabel(l)}
                    </label>
                    <input
                      id={`tq-${i}`}
                      className="input qty"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      step={1}
                      value={Math.abs(l.qty)}
                      onChange={(e) => setQty(i, Number(e.target.value))}
                    />
                    <button
                      type="button"
                      className="btn small"
                      onClick={() => setLegs(legs.filter((_, j) => j !== i))}
                      aria-label={`Remove ${legLabel(l)} from the ticket`}
                    >
                      Remove
                    </button>
                  </div>
                </li>
              ))}
            </ul>
            <div className="ticket-fields">
              <div className="field">
                <label htmlFor="ticket-price">
                  {priceWord} <span className="muted">(mid {net != null ? price(Math.abs(net)) : '–'})</span>
                </label>
                <input
                  id="ticket-price"
                  className="input"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step={0.01}
                  placeholder={net != null ? price(Math.abs(net)) : ''}
                  value={market ? '' : priceText}
                  onChange={(e) => setPriceText(e.target.value)}
                  disabled={market || !has}
                />
              </div>
              <div className="field">
                <label htmlFor="ticket-duration">Good for</label>
                <select
                  id="ticket-duration"
                  className="select"
                  value={duration}
                  onChange={(e) => setDuration(e.target.value as 'day' | 'gtc')}
                  disabled={!has}
                >
                  <option value="day">Day</option>
                  <option value="gtc">Until canceled</option>
                </select>
              </div>
            </div>
            <label className="check">
              <input type="checkbox" checked={market} onChange={(e) => setMarket(e.target.checked)} disabled={!has} />
              Market order (no price limit)
            </label>
            {an.error && <ErrorNote source="ticket pricing" message={an.error} />}
            {liveBlocked && (
              <p className="banner" data-error-ok>
                {broker?.label} is a live account and live orders are off. You can preview here; sending is blocked
                until you allow live orders on the Connections screen.
              </p>
            )}
            <div className="row-actions">
              <button type="button" className="btn" onClick={onAnalyze} disabled={!has}>
                Analyze first
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={doPreview}
                disabled={!has || busy != null || (!market && limit == null)}
                aria-busy={busy === 'preview'}
              >
                {busy === 'preview' ? 'Asking the broker' : 'Preview order'}
              </button>
            </div>
            {error && (
              <div className="alert" role="alert" data-error-source="order">
                {error}
              </div>
            )}
            {sent && (
              <p className="sent" role="status" data-testid="order-sent">
                {sent}
              </p>
            )}
            {p && preview && (
              <div className="preview" data-testid="order-preview">
                <h3 className="sub">Broker preview</h3>
                <dl className="kv">
                  <dt>Order</dt>
                  <dd>
                    {priceLabel(preview.order)} · {preview.order.duration === 'day' ? 'day' : 'until canceled'} · ×
                    {lots}
                  </dd>
                  {preview.order.legs.map((l) => (
                    <LegLine
                      key={l.symbol + l.side}
                      side={sideWords(l.side)}
                      qty={l.quantity}
                      what={contractWords(l.symbol)}
                    />
                  ))}
                  <dt>{(p.cost ?? 0) < 0 ? 'Estimated credit' : 'Estimated cost'}</dt>
                  <dd>{p.cost != null ? usd(Math.abs(p.cost)) : '–'}</dd>
                  <dt>Commission and fees</dt>
                  <dd>{usd((p.commission ?? 0) + (p.fees ?? 0))}</dd>
                  <dt>Sent to</dt>
                  <dd>{p.broker.label}</dd>
                </dl>
                {p.warnings.map((w) => (
                  <p className="banner" key={w} data-error-ok>
                    {w}
                  </p>
                ))}
                {!p.ok && (
                  <div className="alert" role="alert" data-error-source="order preview">
                    The broker would not accept this order as previewed.
                  </div>
                )}
                {isLive && !liveBlocked && (
                  <label className="check">
                    <input type="checkbox" checked={confirmLive} onChange={(e) => setConfirmLive(e.target.checked)} />
                    This is a real order on a live account, with real money.
                  </label>
                )}
                <button
                  type="button"
                  className="btn primary send"
                  data-uisweep-destructive
                  onClick={doSend}
                  disabled={busy != null || !p.ok || liveBlocked || (isLive && !confirmLive)}
                  aria-busy={busy === 'send'}
                >
                  {busy === 'send' ? 'Sending' : `Send to ${p.broker.label}`}
                </button>
              </div>
            )}
          </>
        }
      </Panel>
      <Panel title="What this order adds" busy={has && an.loading}>
        {!has ? (
          <dl className="kv">
            <dt>Delta</dt>
            <dd>–</dd>
            <dt>Theta / day</dt>
            <dd>–</dd>
            <dt>Vega / vol pt</dt>
            <dd>–</dd>
            <dt>P(profit)</dt>
            <dd>–</dd>
            <dt>Max loss</dt>
            <dd>–</dd>
          </dl>
        ) : a ? (
          <dl className="kv">
            <dt>Delta</dt>
            <dd>{num(a.position.greeks.delta)} sh</dd>
            <dt>Theta / day</dt>
            <dd className={pnlClass(a.position.greeks.thetaPerDay)}>{usd(a.position.greeks.thetaPerDay, 0)}</dd>
            <dt>Vega / vol pt</dt>
            <dd>{usd(a.position.greeks.vegaPerVolPoint, 0)}</dd>
            <dt>P(profit)</dt>
            <dd>{pct(a.probability.probabilityOfProfit, 0)}</dd>
            <dt>Max loss</dt>
            <dd className="loss">
              {typeof a.probability.maxLoss === 'number' ? usdCompact(a.probability.maxLoss) : a.probability.maxLoss}
            </dd>
          </dl>
        ) : an.error ? (
          <ErrorNote source="ticket analysis" message={an.error} />
        ) : (
          <Skeleton height={150} />
        )}
      </Panel>
    </>
  );
}

function LegLine({ side, qty, what }: { side: string; qty: number; what: string }) {
  return (
    <>
      <dt>{side}</dt>
      <dd>
        {qty} × {what}
      </dd>
    </>
  );
}

function Orders({
  account,
  onChanged,
  onAnalyzeLegs,
}: {
  account: ReturnType<typeof useLoad<Account>>;
  onChanged: () => void;
  onAnalyzeLegs: (legs: LegInput[]) => void;
}) {
  const { api, symbol } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const acct = account.data;
  const cancel = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      await api.cancelOrder(id);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const mine = acct?.positions.filter((p) => p.underlying === symbol) ?? [];
  return (
    <>
      <Panel title="Working and filled" className="tr-orders">
        {account.error ? (
          <ErrorNote source="account" message={account.error} />
        ) : !acct ? (
          <Skeleton height={140} />
        ) : (
          <>
            {error && (
              <div className="alert" role="alert" data-error-source="cancel">
                {error}
              </div>
            )}
            {acct.orders.length === 0 ? (
              <p className="note first">No orders yet in {acct.broker.label}.</p>
            ) : (
              <ul className="orders">
                {acct.orders.slice(0, 12).map((o) => (
                  <li key={o.id} data-testid="order-row" data-state={o.state}>
                    <div className="order-main">
                      <div className="num">
                        {o.legs.map((l) => `${sideWords(l.side)} ${l.quantity} ${contractWords(l.symbol)}`).join(' / ')}
                      </div>
                      <div className="muted">
                        {o.type}
                        {o.price != null ? ` ${price(o.price)}` : ''} · {o.duration}
                      </div>
                    </div>
                    <div className={`order-state state-${o.state}`}>{o.state.replace('_', ' ')}</div>
                    <button
                      type="button"
                      className="btn small"
                      data-uisweep-destructive
                      onClick={() => cancel(o.id)}
                      disabled={busy != null || (o.state !== 'open' && o.state !== 'pending')}
                      aria-label={`Cancel order ${o.id}`}
                      aria-busy={busy === o.id}
                    >
                      {busy === o.id ? 'Canceling' : 'Cancel'}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Panel>
      <Panel title="Account">
        {account.error ? null : !acct ? (
          <Skeleton height={120} />
        ) : (
          <>
            <dl className="kv">
              <dt>Broker</dt>
              <dd>
                {acct.broker.label} {acct.accountMasked !== 'Paper' ? acct.accountMasked : ''}
              </dd>
              <dt>Equity</dt>
              <dd>{usd(acct.balances.equity)}</dd>
              <dt>Option buying power</dt>
              <dd>{usd(acct.balances.optionBuyingPower)}</dd>
            </dl>
            {mine.length > 0 && (
              <button type="button" className="btn analyze-pos" onClick={() => onAnalyzeLegs(mine.map((p) => p.leg))}>
                Analyze my {symbol} position
              </button>
            )}
          </>
        )}
      </Panel>
    </>
  );
}
