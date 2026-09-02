# Operator page

One page for an AI or human operator who has to keep this agent alive after handover.

## What this is

A finance-team invoice agent on Terminal 3 sandbox. The TypeScript process parses an invoice (vendor, amount, currency, due date, memo) and calls a TEE contract. The contract applies a USD approval threshold (default $500), writes an audit row, and — when allowed — creates a **Stripe TEST** PaymentIntent. Bank numbers and API secrets never enter the invoice payload or the model prompt.

## Daily loop

1. Confirm `T3N_API_KEY` is in the environment (never print it).
2. `npx tsx src/quickstart.ts` — must print `did:t3n:<8 hex>…` and `TenantClient ready.` As of 2026-09-02 this throws `Trust manifest … is malformed` on SDK 5.7.0 before handshake (see `docs/DX_AND_BUGS.md`). Do not bypass with `unsafe_trust_server`.
3. Intake: `npx tsx src/agent.ts --invoice path/to/invoice.json`
4. If the decision is `needs_approval`, a human re-runs with `--approve`.
5. `execute-payment` needs a seeded `sk_test_` key and a finance-user profile email (`{{profile.verified_contacts.email.value}}`).

## Maps (tenant KV)

| Tail | Keys | Who reads |
|---|---|---|
| `secrets` | `stripe_secret_key` | contract only |
| `policy` | `approval_threshold_usd` | contract only |
| `vendors` | lowercase vendor name → opaque Stripe dest (`acct_…`) | contract only |
| `audit` | `inv-<seq>` → audit JSON | contract only |

Seed or rotate with `tenant.maps.entrySet` (see `scripts/register.ts`). Do not put `sk_live_` in `secrets` — the contract refuses it.

## Pause / resume

```bash
npx tsx scripts/pause.ts          # tenant.contracts.disable("invoice-pay")
npx tsx scripts/pause.ts --resume # tenant.contracts.enable("invoice-pay")
```

Also revoke the `agent-auth-update` grant (drop `api.stripe.com`) if you need to cut egress without disabling the contract.

## Do not

- Put bank / IBAN / routing / card / `sk_*` fields on an invoice.
- Point `setEnvironment` at `production`.
- Re-register the same `CONTRACT_VERSION`. Bump it.
- Reuse a tenant key as a long-lived production agent key. Claim a second key (agent credits are separate).

## When something fails

Match the `detail` substring against [Common errors](https://docs.terminal3.io/developers/adk/tips/common-errors.md). Save `request_id` on HTTP 500. Check grant + map ACLs before rewriting contract code. Notes from this build: `docs/DX_AND_BUGS.md`.
