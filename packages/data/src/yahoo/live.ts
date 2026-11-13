// The engine bound to Yahoo + SEC, plus the on-disk chain-logger history (Node only).
// Kept as the zero-config entry point for the CLI, the daily chain logger and agents; the app
// builds its own engine over the full source ladder (see ../engine.ts, ../ladder.ts).
import fs from 'node:fs';
import type { Json } from './http.ts';
import { firstExpiry } from '@strikebench/core';
import type { Leg } from '@strikebench/core';
import { createEngine } from '../engine.ts';
import type { MarketState } from '../engine.ts';
import { yahooSource } from './source.ts';

export type { Leg, MarketState };

/** Read the chain logger's summary series for a symbol. */
export function readLoggedSummary(sym: string, dir = defaultLogDir()): Json[] {
  const f = `${dir}/${sym.toUpperCase()}/summary.jsonl`;
  try {
    return fs
      .readFileSync(f, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; // error-ok: no logger history yet is a normal state; other errors rethrow
    throw e;
  }
}
export const defaultLogDir = () =>
  process.env.OPT_LOG_DIR ?? `${process.env.HOME}/.local/share/finance-analytics/chains`;

const engine = createEngine(yahooSource(), { loggedSummary: (sym) => readLoggedSummary(sym) });

export const {
  marketState,
  expiryChain,
  expirations,
  fillLegs,
  termStructure,
  positionBlock,
  analyze,
  chain,
  vol,
  ivhist,
  earnings,
  impliedVsActual,
  ivFromQuote,
} = engine;

export { firstExpiry };
