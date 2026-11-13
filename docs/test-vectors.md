# Test vectors

The pricing core is checked against values published in textbooks and against identities that must hold whatever the inputs. Every row below is an assertion in [`packages/core/test`](../packages/core/test) and runs on every commit (`npm test`).

## Published values

| What                                | Inputs                                 | Published value                        | Source                                                                                        | Test         |
| ----------------------------------- | -------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------- | ------------ |
| European call                       | S=42, K=40, r=10%, σ=20%, T=0.5        | 4.76                                   | Hull, _Options, Futures, and Other Derivatives_, ex. 15.6                                     | `bs.test.ts` |
| European put                        | same                                   | 0.81                                   | Hull, ex. 15.6                                                                                | `bs.test.ts` |
| Put with dividend yield (Merton)    | S=100, K=95, T=0.5, r=10%, q=5%, σ=20% | 2.4648                                 | Haug, _The Complete Guide to Option Pricing Formulas_, p. 4                                   | `bs.test.ts` |
| Call delta                          | S=49, K=50, r=5%, σ=20%, T=20 weeks    | 0.522                                  | Hull, ch. 19                                                                                  | `bs.test.ts` |
| Call gamma                          | same                                   | 0.066                                  | Hull, ch. 19                                                                                  | `bs.test.ts` |
| Call theta (per year)               | same                                   | −4.31                                  | Hull, ch. 19                                                                                  | `bs.test.ts` |
| Call vega (per 1.00 vol)            | same                                   | 12.1                                   | Hull, ch. 19                                                                                  | `bs.test.ts` |
| Call rho                            | same                                   | 8.91                                   | Hull, ch. 19                                                                                  | `bs.test.ts` |
| American put (binomial, 1000 steps) | S=50, K=50, r=10%, σ=40%, T=5/12       | 4.28                                   | Hull, ch. 13 (tree converges to this value)                                                   | `bs.test.ts` |
| Normal CDF                          | N(1.96), N(−3)                         | 0.9750021048517795, 0.0013498980316301 | Tabulated; algorithm from West (2005), _Better approximations to cumulative normal functions_ | `bs.test.ts` |

## Identities

| Identity                                                                        | Checked how                                                            |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Put-call parity with dividends: C − P = S·e^(−qT) − K·e^(−rT)                   | to 10 decimals                                                         |
| Vanna, charm, vomma and speed equal finite differences of delta, vega and gamma | calls and puts                                                         |
| Implied volatility recovers the volatility a price was generated with           | strikes 120 to 250, 2 days to 1.5 years, calls and puts, to 6 decimals |
| A price below intrinsic value has no implied volatility                         | returns null instead of a made-up number                               |
| A European binomial tree converges to Black-Scholes                             | 2000 steps, to 2 decimals                                              |
| An American call on a stock with no dividend equals the European call           | to 2 decimals                                                          |
| N(N⁻¹(p)) = p                                                                   | p from 1e−6 to 0.999, to 10 decimals                                   |

## Units

Greeks are reported the way a trading screen shows them: theta per calendar day, vega per volatility point, rho per 1% in rates, and position greeks multiplied by quantity and contract size. The raw per-year, per-1.00 values the textbooks print are kept in `raw` and are what the Hull comparisons above use.

## Position and probability

From [`position.test.ts`](../packages/core/test/position.test.ts) and [`chain.test.ts`](../packages/core/test/chain.test.ts):

| Check                             | Expected                                                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Long call                         | one break-even at strike + premium, maximum loss = the debit, unlimited profit, probability of profit = P(S_T > break-even)           |
| Iron condor                       | two break-evens, profit and loss bounded on both sides                                                                                |
| Naked short call                  | loss reported as unlimited                                                                                                            |
| A fairly priced option            | expected value ≈ 0 under the risk-neutral measure                                                                                     |
| Probability above a strike        | equals N(d2)                                                                                                                          |
| Probability of touching a barrier | twice the probability of finishing beyond it when drift is zero (reflection principle), and agrees with a Brownian-bridge Monte Carlo |
| Position value today              | Black-Scholes price × contracts × 100                                                                                                 |
| Calendar spread                   | the back month keeps its time value at the front expiry                                                                               |
| Expiry time                       | 16:00 New York, across daylight-saving changes                                                                                        |
| Earnings decomposition            | a term structure built with an 8% event move and 40% ex-event volatility returns those two numbers                                    |
| Constant-maturity IV              | interpolates in total variance                                                                                                        |
| Chain hygiene                     | a one-sided quote falls back to the last trade and is flagged; a stale last trade gets no implied volatility                          |
