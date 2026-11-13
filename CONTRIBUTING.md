# Contributing

Thanks for looking. Read [AGENTS.md](AGENTS.md) first: it holds the rules that are not negotiable (clean-room, keys stay local, every price names its source, live orders off by default).

## Setup

```bash
npm install
npm test               # unit and contract tests (no network)
npx playwright test    # end-to-end tests on built-in simulated data
npm run dev -- --demo  # server on :4173 with simulated data
npm run dev -w @strikebench/web   # UI with hot reload on :5173
```

Node 20 or newer. The code is TypeScript run directly (no build step for the server in development).

## What a change needs

- **A test that fails without it.** A bug fix ships with the test that would have caught it.
- **Math**: a published value or an identity, with the source cited in the test name. Add it to [docs/test-vectors.md](docs/test-vectors.md).
- **UI**: it must work at 360 px wide with 44 px tap targets, and show a loading state and an error state. Run the end-to-end tests.
- `npm run check:full` clean (types, lint, tests).

## Adding a broker

A broker is one file implementing the [`Broker` interface](packages/data/src/broker/types.ts). Use [`tradier.ts`](packages/data/src/broker/tradier.ts) and its test as the model.

1. Implement the adapter with an injected `fetch` (no global network access), a fixed list of `hosts`, and the live-order guard: `placeOrder` and `cancelOrder` on a live account must throw `LiveTradingDisabledError` before any request unless `allowLiveOrders` is true.
2. Record real responses from the broker's sandbox with a script like [`scripts/tradier-sandbox.ts`](packages/data/scripts/tradier-sandbox.ts), scrubbing account numbers, names and tokens, and replay them in a contract test.
3. Prove the live sandbox flow: preview, place and cancel a multi-leg order. Paste the output in the pull request.
4. Add the entry to [`registry.ts`](packages/data/src/broker/registry.ts). It is marked `available` only after step 3.

Never commit a credential or a real account number. Tests and demos use sandboxes or the built-in simulated data only.

## Adding a market-data source

Implement whichever methods of [`MarketDataSource`](packages/data/src/types.ts) the source can serve, tag every answer with `tag()` so it carries its source and delay, and add a contract test on a recorded payload. See [`cboe.ts`](packages/data/src/cboe.ts).

## Reporting a wrong number

Open an issue with the inputs (symbol, legs, date), what Strikebench showed, and what you expected with a source. A wrong number is the most serious kind of bug here.
