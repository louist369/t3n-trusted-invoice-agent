/**
 * Walkthrough 4–5: invoke evaluate-policy + propose-payment.
 * execute-payment only runs when the invoice is under threshold (or --approve)
 * and a Stripe TEST key has been seeded.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  approveAndPay,
  autoPayIfAllowed,
  grantStripeEgress,
  openAgent,
  proposeInvoice,
} from "../src/agent.ts";
import { parseInvoice } from "../src/invoice.ts";
import { loadEnv } from "../src/t3n.ts";

loadEnv();

const args = process.argv.slice(2);
const invoicePath = flag(args, "--invoice") ?? "examples/invoice.json";
const approve = args.includes("--approve");

const invoice = parseInvoice(await readFile(resolve(invoicePath), "utf8"));
const ctx = await openAgent();
console.log("invoke", ctx.script, ctx.version);

try {
  await grantStripeEgress(ctx.session.did, ctx.script, ctx.version);
  console.log("grant ok");
} catch (err) {
  console.log("grant:", err instanceof Error ? err.message : String(err));
}

const { policy, proposal } = await proposeInvoice(ctx, invoice);
console.log(JSON.stringify({ policy, proposal }, null, 2));

if (policy.decision === "needs_approval" && !approve) {
  console.log("stopped: human approval required. re-run with --approve");
  process.exit(0);
}

try {
  const paid =
    policy.decision === "needs_approval"
      ? await approveAndPay(ctx, proposal.proposal_id)
      : await autoPayIfAllowed(ctx, proposal.proposal_id);
  console.log("execute-payment", JSON.stringify(paid));
} catch (err) {
  console.log("execute-payment:", err instanceof Error ? err.message : String(err));
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
