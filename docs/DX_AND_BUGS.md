# T3N DX and bugs

Honest notes from implementing this repo against the public docs and `@terminal3/t3n-sdk@5.7.0` (installed 2026-09-02). Judges: this file is part of the submission, not a complaint.

## Environment name: `sandbox` vs `testnet`

**Challenge / this repo:** `setEnvironment("sandbox")`.

**Installed SDK README** (`node_modules/@terminal3/t3n-sdk/README.md`): `setEnvironment("sandbox" | "production")`. `fetchTrustedManifest("sandbox")` is the example.

**Walkthrough / Quickstart / Reference** still say `testnet`:

- https://docs.terminal3.io/developers/adk/get-started/quickstart.md
- https://docs.terminal3.io/developers/adk/support/ai-coding-assistants.md (skill file)
- https://docs.terminal3.io/developers/adk/reference.md (`setEnvironment("testnet" | "production")`)
- https://docs.terminal3.io/developers/adk/get-started/walkthrough/invoke-contract.md (`fetchTrustedManifest("testnet")`)

**SDK types (`dist/index.d.ts`):** `type Environment = "sandbox" | "testnet" | "production"`.

Runtime in 5.7.0:

```
DEFAULT_ENVIRONMENT = "testnet"
NODE_URLS.sandbox  = https://cn-api.sg.testnet.t3n.terminal3.io
NODE_URLS.testnet  = https://cn-api.sg.testnet.t3n.terminal3.io
NODE_URLS.production = https://cn-api.sg.prod.t3n.terminal3.io
```

`sandbox` and `testnet` are the same public test node. Org-agent docs already say that (`--env sandbox|testnet|production`; “sandbox and testnet are the same test network”) at https://docs.terminal3.io/developers/agents/provision-org-agent.md. Public-agent docs still only mention `testnet|production`: https://docs.terminal3.io/developers/agents/register-agent.md.

**What we did:** trust the installed SDK + the challenge: `sandbox` everywhere. Documented here instead of silently following the stale walkthrough snippets.

## `{{secrets.*}}` placeholders are rejected

https://docs.terminal3.io/developers/adk/tips/placeholders-outbound-calls.md describes `http-with-placeholders` as `{{profile.<field>}}` substitution.

The vendored host WIT from [z-tenant-flight](https://github.com/Terminal-3/z-tenant-flight) (`wit/deps/host-interfaces-2.1.0/package.wit`) is explicit:

> the host enforces only the hard `profile`-namespace gate — `{{secrets.<x>}}` and any namespace other than `profile` is rejected with `placeholder-denied`.

https://docs.terminal3.io/developers/adk/tips/seed-api-key.md is the real secret path: `map-entry-set` → `kv_store::get("z:<hex(tid)>:secrets", b"stripe_secret_key")` inside the TEE.

**What we did:** Stripe key from KV. Receipt email via `{{profile.verified_contacts.email.value}}`. Vendor payout dest is an opaque `acct_…` in the `vendors` map, not a bank number in the invoice.

## Seed API: docs vs typed helper

Docs: `tenant.executeControl("map-entry-set", { map_name: tenant.canonicalName("secrets"), … })`.

SDK 5.7.0: `tenant.maps.entrySet(tail, key, value)` and `tenant.maps.entryGet`. We used the typed helper and kept the doc names in comments.

## Payroll “use case” page has no agent

https://docs.terminal3.io/developers/adk/use-cases/payroll-agent.md is one line: “See Delegate Access to AI Agents”, which is a conceptual essay (https://docs.terminal3.io/t3n/use-cases/delegate-access-to-agent.md) with no WIT, no register/invoke, no threshold code.

The SDK *does* export `Z_PAYROLL_RUN_FUNCTIONS`, `Z_PAYROLL_AUDIT_READ_FUNCTIONS`, and `DEFAULT_INDIVIDUAL_THRESHOLD_CENTS` (`1500000n` = SGD 15,000). Those are for T3’s own payroll contract, not this invoice agent. We mirrored the *shape* (policy → approve → disburse → audit) with original invoice functions.

## `getAuditEvents` is first-class in 5.7.0

https://docs.terminal3.io/developers/adk/reference.md still lists `getAuditEvents()` under “Observed in community code only — not confirmed”. `T3nClient.getAuditEvents` is documented in `dist/index.d.ts` on this install. We did not depend on it; the contract writes its own `audit` map.

## Walkthrough assumes one file and a sibling crate

Quickstart says keep appending to `quickstart.ts`. That fights a maintainable repo. We extracted `src/t3n.ts` and repeated the connect block at the top of each entry script, which the same page allows.

Write-contract says clone `z-tenant-flight` as a **sibling** folder. The challenge wants `contracts/` in-repo. We vendored the official `host-interfaces@2.1.0` and `host-tenant@1.0.0` WIT packages from that repo (not invented).

## Re-register + map ACL

https://docs.terminal3.io/developers/adk/get-started/walkthrough/register-contract.md: re-register allocates a new `contract_id`; there is no API to look up the current id; old map ACLs can go stale. `scripts/register.ts` writes `.t3n-state.json` and re-applies `{ only: [contractId] }` after `map already exists`.

## Agent credits vs tenant credits

https://docs.terminal3.io/developers/adk/overview/agent-auth-adk.md and common-errors: an agent DID starts at zero credits. Reusing `T3N_API_KEY` for a separate agent identity is the usual `InsufficientCreditError`. This repo’s 15-minute path uses a **self-grant** (tenant DID as agent) unless `AGENT_KEY` / `USER_KEY` are set. Production handover should claim a second key.

## No `T3N_API_KEY` in this build VM

The environment had no `T3N_API_KEY`, `AGENT_KEY`, or `STRIPE_SECRET_KEY`. Per the brief we still shipped complete scripts. Live `npx tsx src/quickstart.ts` / register / invoke must be run by a judge or operator with a claimed key (https://www.terminal3.io/claim-page). We will attach sanitized DID-prefix logs here if a key is added later.

## Other friction (no crash, just cost)

- Official walkthrough Rust (`wit-bindgen` 0.49) currently pulls `hashbrown 0.17` / `indexmap 2.14`, which need **Rust 1.85+** (edition 2024). A machine on 1.83 fails at `cargo build` with `feature edition2024 is required`. This repo pins `contracts/rust-toolchain.toml` to `stable`.
- `cargo install wasm-tools` is optional and slow; build works without it.
- Host `http` / `http-with-placeholders` may force JSON Content-Type (flight demo comment). Stripe PaymentIntents want form-urlencoded; if invoke returns a Stripe parse error, that is the first thing to check.
- Skill file at https://docs.terminal3.io/developers/adk/support/ai-coding-assistants.md still hard-codes `setEnvironment("testnet")`.
- Docs date the changelog at 2026-07-06; SDK on npm is already 5.7.0 with sandbox + `maps.entrySet` + `contracts.disable`.
