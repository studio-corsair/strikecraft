// The broker catalog: what each broker can do, how you sign in, and whether its adapter ships.
// Capabilities are from November 2026 research and are re-verified against each live API before
// its adapter is marked available. "planned" brokers are listed (so the Connections screen is
// honest about what is coming) but cannot be connected: connecting one throws a clear error.
import type { Broker, BrokerCapabilities, BrokerEnv, BrokerId, FetchLike } from './types.ts';
import { tradierBroker, TRADIER_CAPABILITIES } from './tradier.ts';
import type { SocketLike } from './tradier.ts';
import { tastytradeBroker, TASTYTRADE_CAPABILITIES } from './tastytrade.ts';

export interface CredentialField {
  key: string;
  label: string;
  secret: boolean;
}

export interface BrokerDeps {
  fetch: FetchLike;
  WebSocket?: new (url: string) => SocketLike;
  allowLiveOrders?: boolean;
}

export interface BrokerEntry {
  id: BrokerId;
  label: string;
  status: 'available' | 'planned';
  capabilities: BrokerCapabilities;
  /** Environments the adapter can connect to; the first is the default. */
  envs: BrokerEnv[];
  credentials: CredentialField[];
  /** Where a user gets the credential. */
  credentialHelp: string;
  docsUrl: string;
  /** Why a planned adapter is not shipped yet. */
  plannedNote?: string;
  create?(credentials: Record<string, string>, env: BrokerEnv, deps: BrokerDeps): Broker;
}

const TOKEN: CredentialField[] = [{ key: 'token', label: 'API token', secret: true }];

export const BROKERS: BrokerEntry[] = [
  {
    id: 'tradier',
    label: 'Tradier',
    status: 'available',
    capabilities: TRADIER_CAPABILITIES,
    envs: ['sandbox', 'live'],
    credentials: TOKEN,
    credentialHelp:
      'dash.tradier.com → Settings → API Access. The sandbox token is for paper trading; the production token trades your real account.',
    docsUrl: 'https://docs.tradier.com',
    create: (c, env, deps) =>
      tradierBroker({
        token: need(c, 'token', 'Tradier'),
        env,
        fetch: deps.fetch,
        WebSocket: deps.WebSocket,
        allowLiveOrders: deps.allowLiveOrders,
      }),
  },
  {
    id: 'tastytrade',
    label: 'tastytrade',
    status: 'available',
    capabilities: TASTYTRADE_CAPABILITIES,
    envs: ['sandbox', 'live'],
    credentials: [
      { key: 'refreshToken', label: 'OAuth refresh token', secret: true },
      { key: 'clientSecret', label: 'OAuth client secret', secret: true },
    ],
    credentialHelp:
      'developer.tastytrade.com → Sandbox tools: create a sandbox user, an OAuth application (read + trade scopes) and a grant.',
    docsUrl: 'https://developer.tastytrade.com',
    create: (c, env, deps) =>
      tastytradeBroker({
        auth: {
          refreshToken: need(c, 'refreshToken', 'tastytrade'),
          clientSecret: need(c, 'clientSecret', 'tastytrade'),
        },
        env,
        fetch: deps.fetch,
        WebSocket: deps.WebSocket,
        allowLiveOrders: deps.allowLiveOrders,
      }),
  },
  {
    id: 'schwab',
    label: 'Charles Schwab',
    status: 'planned',
    capabilities: {
      optionOrders: true,
      multiLeg: true,
      realTimeOptionQuotes: 'streaming L1',
      realTimeQuality: 'yes',
      paperTrading: false,
      paperNote: 'sandbox is synthetic',
      signIn: 'OAuth, re-login every 7 days',
      streaming: true,
    },
    envs: ['live'],
    credentials: [
      { key: 'appKey', label: 'App key', secret: false },
      { key: 'appSecret', label: 'App secret', secret: true },
    ],
    credentialHelp: 'developer.schwab.com → register an individual app (approval takes a few days).',
    docsUrl: 'https://developer.schwab.com',
    plannedNote:
      'No paper environment: orders cannot be tested without a live account, so it ships after preview-only support.',
  },
  {
    id: 'ibkr',
    label: 'Interactive Brokers',
    status: 'planned',
    capabilities: {
      optionOrders: true,
      multiLeg: true,
      realTimeOptionQuotes: 'OPRA sub ~$1.50/mo',
      realTimeQuality: 'partial',
      paperTrading: true,
      signIn: 'Gateway login daily (2FA)',
      streaming: true,
    },
    envs: ['sandbox', 'live'],
    credentials: [{ key: 'gatewayUrl', label: 'Client Portal Gateway URL', secret: false }],
    credentialHelp: 'Run the IBKR Client Portal Gateway locally and log in; Strikebench talks to it on localhost.',
    docsUrl: 'https://www.interactivebrokers.com/campus/ibkr-api-page/cpapi-v1/',
    plannedNote: 'Needs the local gateway running; adapter follows the same interface.',
  },
  {
    id: 'alpaca',
    label: 'Alpaca',
    status: 'planned',
    capabilities: {
      optionOrders: true,
      multiLeg: true,
      realTimeOptionQuotes: 'indicative free, OPRA paid',
      realTimeQuality: 'partial',
      paperTrading: true,
      signIn: 'API key',
      streaming: true,
    },
    envs: ['sandbox', 'live'],
    credentials: [
      { key: 'keyId', label: 'Key ID', secret: false },
      { key: 'secretKey', label: 'Secret key', secret: true },
    ],
    credentialHelp: 'app.alpaca.markets → Paper Trading → API keys.',
    docsUrl: 'https://docs.alpaca.markets',
    plannedNote: 'Paper API available; adapter not written yet.',
  },
  {
    id: 'tradestation',
    label: 'TradeStation',
    status: 'planned',
    capabilities: {
      optionOrders: true,
      multiLeg: true,
      realTimeOptionQuotes: 'with account',
      realTimeQuality: 'yes',
      paperTrading: true,
      signIn: 'OAuth',
      streaming: true,
    },
    envs: ['sandbox', 'live'],
    credentials: [
      { key: 'clientId', label: 'Client ID', secret: false },
      { key: 'clientSecret', label: 'Client secret', secret: true },
    ],
    credentialHelp: 'developer.tradestation.com → request an API key.',
    docsUrl: 'https://api.tradestation.com/docs/',
    plannedNote: 'Simulated-trading API available; adapter not written yet.',
  },
  {
    id: 'etrade',
    label: 'E*TRADE',
    status: 'planned',
    capabilities: {
      optionOrders: true,
      multiLeg: true,
      realTimeOptionQuotes: 'for customers',
      realTimeQuality: 'yes',
      paperTrading: true,
      signIn: 'OAuth 1.0a, daily token',
      streaming: false,
    },
    envs: ['sandbox', 'live'],
    credentials: [
      { key: 'consumerKey', label: 'Consumer key', secret: false },
      { key: 'consumerSecret', label: 'Consumer secret', secret: true },
    ],
    credentialHelp: 'developer.etrade.com → get a sandbox consumer key.',
    docsUrl: 'https://developer.etrade.com',
    plannedNote: 'OAuth 1.0a with a daily token; adapter not written yet.',
  },
];

function need(c: Record<string, string>, key: string, broker: string): string {
  const v = c[key]?.trim();
  if (!v) throw new Error(`${broker} needs a value for "${key}"`);
  return v;
}

export function brokerEntry(id: string): BrokerEntry {
  const e = BROKERS.find((b) => b.id === id);
  if (!e) throw new Error(`unknown broker "${id}" (have ${BROKERS.map((b) => b.id).join(', ')})`);
  return e;
}

/** Build a connected broker adapter, or explain why that broker cannot be connected yet. */
export function createBroker(
  id: string,
  credentials: Record<string, string>,
  env: BrokerEnv,
  deps: BrokerDeps,
): Broker {
  const e = brokerEntry(id);
  if (e.status !== 'available' || !e.create)
    throw new Error(`${e.label} is not available yet: ${e.plannedNote ?? 'adapter not written'}`);
  if (!e.envs.includes(env)) throw new Error(`${e.label} has no ${env} environment (have ${e.envs.join(', ')})`);
  return e.create(credentials, env, deps);
}
