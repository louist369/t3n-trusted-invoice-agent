import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  T3nClient,
  TenantClient,
  createEthAuthInput,
  eth_get_address,
  fetchTrustedManifest,
  getNodeUrl,
  loadWasmComponent,
  metamask_sign,
  setEnvironment,
} from "@terminal3/t3n-sdk";

/** Public test cluster. Same node as `testnet` in SDK 5.7.0. Never production. */
export const T3N_ENV = "sandbox" as const;

export const CONTRACT_TAIL = "invoice-pay";

export const CONTRACT_FUNCTIONS = [
  "evaluate-policy",
  "propose-payment",
  "approve-payment",
  "execute-payment",
  "get-audit",
] as const;

export const STRIPE_HOST = "api.stripe.com";

const SENSITIVE_ENV = new Set([
  "T3N_API_KEY",
  "AGENT_KEY",
  "USER_KEY",
  "STRIPE_SECRET_KEY",
]);

/**
 * Load `.env` into process.env without overriding values already set.
 * Never logs values of known secret names.
 */
export function loadEnv(cwd = process.cwd()): void {
  const path = resolve(cwd, ".env");
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} is not set. Copy .env.example to .env or export it in your shell. See README.md.`,
    );
  }
  return value;
}

/** `did:t3n:abcd…` — enough to confirm identity, not a full DID dump. */
export function didPrefix(did: string): string {
  const raw = did.startsWith("did:t3n:") ? did.slice("did:t3n:".length) : did;
  return `did:t3n:${raw.slice(0, 8)}…`;
}

export function tenantIdFromDid(did: string): string {
  if (!did.startsWith("did:t3n:")) {
    throw new Error("tenantDid must be read from the authenticated session (did:t3n:…)");
  }
  return did.slice("did:t3n:".length);
}

export function scriptName(tenantDid: string): string {
  return `z:${tenantIdFromDid(tenantDid)}:${CONTRACT_TAIL}`;
}

export function redactUnknown(value: unknown): unknown {
  if (typeof value === "string") {
    if (/sk_(live|test)_/i.test(value)) return "[redacted stripe key]";
    if (/^0x[0-9a-fA-F]{16,}$/.test(value)) return `${value.slice(0, 6)}…[redacted]`;
    if (value.startsWith("t3n_key_")) return "t3n_key_[redacted]";
    return value;
  }
  if (Array.isArray(value)) return value.map(redactUnknown);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_ENV.has(k) || /key|secret|token|authorization/i.test(k)
        ? "[redacted]"
        : redactUnknown(v);
    }
    return out;
  }
  return value;
}

export type Session = {
  t3n: T3nClient;
  did: string;
  address: string;
};

export async function connect(apiKey: string): Promise<Session> {
  setEnvironment(T3N_ENV);
  const wasmComponent = await loadWasmComponent();
  const address = eth_get_address(apiKey);
  const t3n = new T3nClient({
    trustAnchor: await fetchTrustedManifest(T3N_ENV),
    wasmComponent,
    handlers: {
      EthSign: metamask_sign(address, undefined, apiKey),
    },
  });
  await t3n.handshake();
  const did = await t3n.authenticate(createEthAuthInput(address));
  return { t3n, did: did.value, address };
}

export function tenantClient(session: Session): TenantClient {
  return new TenantClient({
    t3n: session.t3n,
    baseUrl: getNodeUrl(),
    tenantDid: session.did,
  });
}

export function assertTestStripeKey(key: string): void {
  if (key.startsWith("sk_live_")) {
    throw new Error("Live Stripe keys are refused. Use a sk_test_ key only.");
  }
  if (!key.startsWith("sk_test_")) {
    throw new Error("STRIPE_SECRET_KEY must start with sk_test_.");
  }
}
