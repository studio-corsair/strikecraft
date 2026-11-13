import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { AppProvider, TABS, useApp } from './state.tsx';
import { Analyze } from './screens/Analyze.tsx';
import { Trade } from './screens/Trade.tsx';
import { EarningsScreen } from './screens/Earnings.tsx';
import { Connections } from './screens/Connections.tsx';
import { ErrorNote } from './components/ui.tsx';
import { pnlClass, price, sessionLabel, signedPct, sourceKind, sourceText } from './format.ts';

export function App() {
  return (
    <AppProvider>
      {(ready, bootError) =>
        ready ? (
          <Shell />
        ) : (
          <div className="app boot">
            {bootError ? (
              <ErrorNote source="Strikebench" message={bootError} />
            ) : (
              <p id="boot" aria-busy="true">
                Starting Strikebench
              </p>
            )}
          </div>
        )
      }
    </AppProvider>
  );
}

function Shell() {
  const { tab, go, status } = useApp();
  return (
    <div className="app">
      <TopBar />
      <nav className="tabs" aria-label="Screens">
        {TABS.map((t) => (
          <a
            key={t.id}
            className="tab"
            href={`/${t.id}`}
            aria-current={tab === t.id ? 'page' : undefined}
            onClick={(e) => {
              // Plain clicks switch screens in place; modified clicks (new tab) keep the browser's behaviour.
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
              e.preventDefault();
              go(t.id);
            }}
          >
            {t.label}
          </a>
        ))}
      </nav>
      <main className="main" data-tab={tab}>
        {status.error && <ErrorNote source="status" message={status.error} />}
        {tab === 'analyze' && <Analyze />}
        {tab === 'trade' && <Trade />}
        {tab === 'earnings' && <EarningsScreen />}
        {tab === 'connections' && <Connections />}
      </main>
    </div>
  );
}

function TopBar() {
  const { symbol, setSymbol, quote, status } = useApp();
  const [draft, setDraft] = useState(symbol);
  useEffect(() => setDraft(symbol), [symbol]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSymbol(draft);
  };
  const q = quote.data && quote.data.symbol === symbol ? quote.data : null;
  const demoSymbols = status.data?.demo?.symbols;
  const st = status.data;
  return (
    <header className="topbar">
      <h1 className="brand">
        <img src="/icon.svg" alt="" width={24} height={24} />
        Strikebench
      </h1>
      <form className="symbol-form" onSubmit={submit} role="search" aria-label="Symbol">
        <label className="sr-only" htmlFor="symbol">
          Symbol
        </label>
        {demoSymbols ? (
          <select id="symbol" className="symbol-input" value={symbol} onChange={(e) => setSymbol(e.target.value)}>
            {demoSymbols.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        ) : (
          <>
            <input
              id="symbol"
              className="symbol-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value.toUpperCase())}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              maxLength={10}
            />
            <button type="submit" className="btn">
              Go
            </button>
          </>
        )}
      </form>
      <div className="quote" aria-live="polite">
        {q ? (
          <>
            <span className="px num" data-testid="last-price">
              {price(q.price)}
            </span>
            <span className={`num ${pnlClass(q.changePct)}`}>{signedPct(q.changePct)}</span>
            <span className="muted">{sessionLabel(q.session)}</span>
          </>
        ) : quote.error ? (
          <span className="alert" role="alert" data-error-source="quote">
            {quote.error}
          </span>
        ) : (
          <span className="skel quote-skel" aria-busy="true" role="progressbar" aria-label="Loading quote" />
        )}
      </div>
      <div className="sources">
        {!q && !quote.error && <span className="skel pill-skel" aria-hidden="true" />}
        {q && (
          <span className={`pill ${sourceKind(q.source)}`} data-testid="quote-source">
            <span className="dot" />
            {sourceText(q.source)}
          </span>
        )}
      </div>
      {st && (
        <div className="account">
          <div>{st.activeBroker.label}</div>
          <div className="muted">
            {st.activeBroker.id === 'paper'
              ? 'simulated fills'
              : st.activeBroker.env === 'sandbox'
                ? 'paper trading'
                : st.activeBroker.liveOrdersAllowed
                  ? 'LIVE orders on'
                  : 'live orders off'}
          </div>
        </div>
      )}
    </header>
  );
}
