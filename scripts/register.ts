/**
 * Walkthrough 3: register the WASM, create maps, seed policy + optional Stripe TEST key.
 * https://docs.terminal3.io/developers/adk/get-started/walkthrough/register-contract.md
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  CONTRACT_TAIL,
  assertTestStripeKey,
  connect,
  didPrefix,
  loadEnv,
  requireEnv,
  scriptName,
  tenantClient,
} from "../src/t3n.ts";

loadEnv();

const WASM_PATH = resolve(
  process.cwd(),
  "contracts/target/wasm32-wasip2/release/z_invoice_pay.wasm",
);
const CONTRACT_VERSION = process.env.CONTRACT_VERSION?.trim() || "0.1.0";
const THRESHOLD = process.env.APPROVAL_THRESHOLD_USD?.trim() || "500";

const session = await connect(requireEnv("T3N_API_KEY"));
const tenant = tenantClient(session);
await tenant.tenant.me();
console.log("Tenant:", didPrefix(session.did));

const wasmBytes = await readFile(WASM_PATH);
const result = await tenant.contracts.register({
  tail: CONTRACT_TAIL,
  version: CONTRACT_VERSION,
  wasm: wasmBytes,
});

const contractId = result.contract_id;
const script = scriptName(session.did);
console.log(`registered ${script} as contract id ${contractId} v${CONTRACT_VERSION}`);

async function ensureMap(tail: string) {
  try {
    await tenant.maps.create({
      tail,
      visibility: "private",
      writers: { only: [contractId] },
      readers: { only: [contractId] },
    });
    console.log(`map created: ${tail}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes("already exists")) {
      console.log(`map exists: ${tail} (idempotent)`);
      try {
        await tenant.maps.update(tail, {
          writers: { only: [contractId] },
          readers: { only: [contractId] },
        });
        console.log(`map ACL updated for contract id ${contractId}: ${tail}`);
      } catch (updateErr) {
        console.log(`map ACL update skipped for ${tail}:`, messageOf(updateErr));
      }
      return;
    }
    throw err;
  }
}

await ensureMap("secrets");
await ensureMap("policy");
await ensureMap("vendors");
await ensureMap("audit");

// Prefer the typed helper (SDK 5.7.0). Docs still show executeControl("map-entry-set").
await tenant.maps.entrySet("policy", "approval_threshold_usd", THRESHOLD);
console.log(`policy.approval_threshold_usd=${THRESHOLD}`);

const stripe = process.env.STRIPE_SECRET_KEY?.trim();
if (stripe) {
  assertTestStripeKey(stripe);
  await tenant.maps.entrySet("secrets", "stripe_secret_key", stripe);
  console.log("stripe_secret_key sealed in z:<tid>:secrets (test key only)");
} else {
  console.log("STRIPE_SECRET_KEY unset — execute-payment will refuse until seeded");
}

// Opaque Stripe destination ref, not a bank account number.
await tenant.maps.entrySet(
  "vendors",
  "acme supplies",
  "acct_test_acme_supplies",
);
console.log("vendor destination seeded for 'Acme Supplies' (opaque TEST ref)");

const state = {
  tenant_did_prefix: didPrefix(session.did),
  script,
  contract_id: contractId,
  version: CONTRACT_VERSION,
  tail: CONTRACT_TAIL,
};
await writeFile(".t3n-state.json", JSON.stringify(state, null, 2) + "\n");
console.log("wrote .t3n-state.json (gitignored)");

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
