// The legs of the position. Each leg is one compact row (what it is, its mark and IV); "Edit"
// opens that leg's fields in place. The list is the last thing in its panel and "Add leg" sits
// above it, so adding, removing or swapping legs never moves another control. Controls are named
// by slot ("leg 2"), so a control keeps its identity when a different contract takes the slot.
import { useState } from 'react';
import type { LegInput } from '../api.ts';
import { expiryLabel, legLabel, pct, price } from '../format.ts';
import { legKey, nearestIndex } from '../strategies.ts';

interface Mark {
  mark?: number | null;
  iv?: number | null;
}

interface Props {
  legs: LegInput[];
  /** Current mark and IV per leg, in the same order, once analysis has run. */
  marks?: Mark[];
  onChange: (legs: LegInput[]) => void;
  expirations: string[];
  strikes: number[];
  defaultExpiry: string | null;
  spot: number | null;
}

export const MAX_LEGS = 4;

export function LegEditor({ legs, marks, onChange, expirations, strikes, defaultExpiry, spot }: Props) {
  const [open, setOpen] = useState<number | null>(null);
  const set = (i: number, patch: Partial<LegInput>) => onChange(legs.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const remove = (i: number) => {
    setOpen(null);
    onChange(legs.filter((_, j) => j !== i));
  };
  const add = () => {
    if (!defaultExpiry || !strikes.length) return;
    const atm = strikes[nearestIndex(strikes, spot ?? strikes[Math.floor(strikes.length / 2)]!)]!;
    // The first strike at or above the money that is not already a leg.
    const taken = new Set(legs.map(legKey));
    const free = strikes.filter((k) => k >= atm).find((k) => !taken.has(`C:${k}:${defaultExpiry}`)) ?? atm;
    onChange([...legs, { qty: 1, type: 'C', strike: free, expiry: defaultExpiry }]);
  };
  const canAdd = !!defaultExpiry && strikes.length > 0 && legs.length < MAX_LEGS;

  return (
    <div className="legs">
      <button type="button" className="btn add-leg" onClick={add} disabled={!canAdd}>
        Add leg
      </button>
      <ol className="leg-rows">
        {legs.map((l, i) => {
          const n = i + 1;
          const isStock = l.type === 'S';
          const id = `leg-${n}`;
          const strikeOptions =
            l.strike != null && !strikes.includes(l.strike) ? [...strikes, l.strike].sort((a, b) => a - b) : strikes;
          const expiryOptions =
            l.expiry && !expirations.includes(l.expiry) ? [...expirations, l.expiry].sort() : expirations;
          const isOpen = open === i;
          return (
            <li className="leg-row" key={i} data-testid="leg">
              <div className="leg-line">
                <div className="leg-what">
                  <div className="num leg-name">{legLabel(l)}</div>
                  <div className="muted num leg-meta">
                    mark {price(marks?.[i]?.mark)}
                    {!isStock && ` · IV ${pct(marks?.[i]?.iv)}`}
                  </div>
                </div>
                <div className="leg-buttons">
                  <button
                    type="button"
                    className="btn small"
                    aria-expanded={isOpen}
                    aria-controls={`${id}-fields`}
                    aria-label={`Edit leg ${n}`}
                    onClick={() => setOpen(isOpen ? null : i)}
                  >
                    Edit
                  </button>
                  <button type="button" className="btn small" onClick={() => remove(i)} aria-label={`Remove leg ${n}`}>
                    Remove
                  </button>
                </div>
              </div>
              {isOpen && (
                <div className="leg-grid" id={`${id}-fields`} role="group" aria-label={`Leg ${n} fields`}>
                  <div className="field">
                    <label htmlFor={`${id}-side`}>Side</label>
                    <select
                      id={`${id}-side`}
                      className="select"
                      value={l.qty > 0 ? 'buy' : 'sell'}
                      onChange={(e) => set(i, { qty: Math.abs(l.qty) * (e.target.value === 'buy' ? 1 : -1) })}
                    >
                      <option value="buy">Buy</option>
                      <option value="sell">Sell</option>
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor={`${id}-qty`}>{isStock ? 'Shares' : 'Contracts'}</label>
                    <input
                      id={`${id}-qty`}
                      className="input"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      step={1}
                      value={Math.abs(l.qty)}
                      onChange={(e) => {
                        const v = Math.max(1, Math.round(Number(e.target.value) || 1));
                        set(i, { qty: v * (l.qty > 0 ? 1 : -1) });
                      }}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor={`${id}-type`}>Type</label>
                    <select
                      id={`${id}-type`}
                      className="select"
                      value={l.type}
                      onChange={(e) => {
                        const type = e.target.value as LegInput['type'];
                        if (type === 'S')
                          set(i, {
                            type,
                            strike: undefined,
                            expiry: undefined,
                            qty: Math.sign(l.qty) * 100,
                            entry: null,
                          });
                        else
                          set(i, {
                            type,
                            strike: l.strike ?? strikes[nearestIndex(strikes, spot ?? 0)],
                            expiry: l.expiry ?? defaultExpiry ?? undefined,
                            qty: isStock ? Math.sign(l.qty) : l.qty,
                            entry: null,
                          });
                      }}
                    >
                      <option value="C">Call</option>
                      <option value="P">Put</option>
                      <option value="S">Stock</option>
                    </select>
                  </div>
                  {!isStock && (
                    <>
                      <div className="field">
                        <label htmlFor={`${id}-strike`}>Strike</label>
                        <select
                          id={`${id}-strike`}
                          className="select"
                          value={l.strike ?? ''}
                          onChange={(e) => set(i, { strike: Number(e.target.value), entry: null })}
                          disabled={strikeOptions.length < 2}
                        >
                          {strikeOptions.map((k) => (
                            <option key={k} value={k}>
                              {k}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="field">
                        <label htmlFor={`${id}-expiry`}>Expiry</label>
                        <select
                          id={`${id}-expiry`}
                          className="select"
                          value={l.expiry ?? ''}
                          onChange={(e) => set(i, { expiry: e.target.value, entry: null })}
                          disabled={expiryOptions.length < 2}
                        >
                          {expiryOptions.map((d) => (
                            <option key={d} value={d}>
                              {expiryLabel(d)}
                            </option>
                          ))}
                        </select>
                      </div>
                    </>
                  )}
                  <div className="field">
                    <label htmlFor={`${id}-entry`}>Entry price</label>
                    <input
                      id={`${id}-entry`}
                      className="input"
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step={0.01}
                      placeholder={marks?.[i]?.mark != null ? price(marks[i]!.mark) : 'mark'}
                      value={l.entry ?? ''}
                      onChange={(e) =>
                        set(i, { entry: e.target.value === '' ? null : Math.max(0, Number(e.target.value)) })
                      }
                    />
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
