# Rules for anyone (human or AI agent) contributing to Strikecraft

## Clean room

Strikecraft is an independent options workstation with its own design. It is not a copy of any broker platform.

- Never read, decompile, or copy code, assets, icons, fonts, UI strings, or documentation text from thinkorswim, Schwab, or any other proprietary trading platform.
- Do not name anything after another product's trademarks ("thinkorswim", "thinkScript", "TOS"). Referring to them nominatively in docs ("an alternative to …") is fine.
- Workflows are fair game (a risk profile, an option chain, a probability panel are standard finance). The look is ours: our layout, colours, icons and wording.
- Formulas come from public textbooks and papers (Hull; Haug; Cox-Ross-Rubinstein; West 2005 for the normal cdf). Cite the source in a comment and pin it with a test vector.

## Data and money

- No market data ever passes through a server we run. Quotes flow from the user's broker or a public delayed source straight to the user's machine.
- Every price shown or returned carries its source and whether it is delayed.
- API keys stay on the user's machine. The only host a key may be sent to is the broker that issued it. There is a test for this; do not weaken it.
- Live order placement is off by default and gated behind an explicit setting. Tests and demos use broker sandboxes or the built-in demo data only.
- Demo data, screenshots and recordings never contain a real account.

## Engineering

- Math lives in `packages/core`, has zero dependencies, and every public function has a textbook-vector test.
- Broker and market-data adapters live in `packages/data` behind the `MarketData` and `Broker` interfaces, with contract tests on recorded fixtures.
- A bug fix ships with a test that fails before it and passes after.
