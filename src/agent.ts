/**
 * Invoice-pay agent: DID registration helpers + the finance workflow.
 *
 * Bank / account numbers and API secrets never appear in this file's
 * outbound contract input. The TEE contract reads them from tenant KV
 * (secrets) and substitutes finance-team profile fields via
 * http-with-placeholders (profile namespace only — see host WIT).
 */
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getContractVersion, getNodeUrl } from "@terminal3/t3n-sdk";
import { parseInvoice, type Invoice } from "./invoice.ts";
import {
  CONTRACT_FUNCTIONS,
  STRIPE_HOST,
  connect,
  didPrefix,
  loadEnv,
  requireEnv,
  scriptName,
  type Session,
} from "./t3n.ts";

loadEnv();

export type PolicyDecision = {
  decision: "auto_approve" | "needs_approval";
  amount_usd_cents: number;
  threshold_usd_cents: number;
  currency: string;
};

export type Proposal = {
  proposal_id: string;
  status: string;
  decision: string;
  vendor: string;
  amount: string;
  currency: string;
};

export type AgentContext = {
  session: Session;
  script: string;
  version: string;
};

export async function openAgent(): Promise<AgentContext> {
  const key = process.env.AGENT_KEY?.trim() || requireEnv("T3N_API_KEY");
  const session = await connect(key);
  const script = scriptName(session.did);
  let version = "0.1.0";
  try {
    version = await getContractVersion(getNodeUrl(), script);
  } catch {
    // Unregistered until scripts/register.ts runs.
  }
  return { session, script, version };
}

/** Publish a public agent card for the authenticated DID (CLI, as documented). */
export function registerPublicAgentCard(opts: {
  name: string;
  description: string;
}): { did: string; cardUrl?: string } {
  const env = { ...process.env };
  const who = spawnSync(
    "npx",
    ["@terminal3/t3n-sdk", "whoami", "--env", "sandbox"],
    { encoding: "utf8", env },
  );
  if (who.status !== 0) {
    throw new Error(`t3n whoami failed: ${who.stderr || who.stdout}`);
  }
  const didLine = (who.stdout || "").trim().split("\n").find((l) => l.includes("did:t3n:"));
  const did = didLine?.match(/did:t3n:[0-9a-fA-F]+/)?.[0];
  if (!did) throw new Error("t3n whoami did not return a did:t3n value");

  const cardPath = resolve(process.cwd(), "agent-card.json");
  const card = spawnSync(
    "npx",
    [
      "@terminal3/t3n-sdk",
      "agent",
      "create-card",
      "--did",
      did,
      "--name",
      opts.name,
      "--description",
      opts.description,
      "--out",
      cardPath,
      "--force",
    ],
    { encoding: "utf8", env },
  );
  if (card.status !== 0) {
    throw new Error(`create-card failed: ${card.stderr || card.stdout}`);
  }

  const host = spawnSync(
    "npx",
    ["@terminal3/t3n-sdk", "agent", "host-card", "--file", cardPath, "--env", "sandbox"],
    { encoding: "utf8", env },
  );
  if (host.status !== 0) {
    throw new Error(`host-card failed: ${host.stderr || host.stdout}`);
  }
  const cardUrl = (host.stdout || "").match(/https:\/\/\S+/)?.[0];
  return { did, cardUrl };
}

/**
 * Data-owner grant: this contract, these functions, api.stripe.com only.
 * Self-grant when USER_KEY is unset (tenant acts as the finance user).
 */
export async function grantStripeEgress(agentDid: string, script: string, version: string) {
  const userKey = process.env.USER_KEY?.trim() || requireEnv("T3N_API_KEY");
  const user = await connect(userKey);
  const userContractVersion = await getContractVersion(getNodeUrl(), "tee:user/contracts");
  await user.t3n.executeAndDecode({
    contract_id: "tee:user/contracts",
    contract_version: userContractVersion,
    function_name: "agent-auth-update",
    input: {
      agents: [
        {
          agentDid,
          scripts: [
            {
              scriptName: script,
              versionReq: version,
              functions: [...CONTRACT_FUNCTIONS],
              allowedHosts: [STRIPE_HOST],
            },
          ],
        },
      ],
    },
  });
}

export async function callContract<T>(
  ctx: AgentContext,
  functionName: string,
  input: unknown,
): Promise<T> {
  return ctx.session.t3n.executeAndDecode<T>({
    contract_id: ctx.script,
    contract_version: ctx.version,
    function_name: functionName,
    input,
  });
}

export async function proposeInvoice(ctx: AgentContext, invoice: Invoice) {
  const policy = await callContract<PolicyDecision>(ctx, "evaluate-policy", invoice);
  const proposal = await callContract<Proposal>(ctx, "propose-payment", invoice);
  return { policy, proposal };
}

export async function approveAndPay(ctx: AgentContext, proposalId: string, approver = "finance-ops") {
  await callContract(ctx, "approve-payment", { proposal_id: proposalId, approver });
  return callContract(ctx, "execute-payment", { proposal_id: proposalId });
}

export async function autoPayIfAllowed(ctx: AgentContext, proposalId: string) {
  return callContract(ctx, "execute-payment", { proposal_id: proposalId });
}

async function main() {
  const args = process.argv.slice(2);
  const invoicePath = flag(args, "--invoice");
  const approve = args.includes("--approve");
  const registerCard = args.includes("--register-card");

  if (registerCard) {
    const { did, cardUrl } = registerPublicAgentCard({
      name: "Trusted Invoice Pay",
      description:
        "Finance-team agent: invoice intake → policy check → TEE Stripe TEST payment → audit row.",
    });
    console.log("Agent DID:", didPrefix(did));
    if (cardUrl) console.log("Card:", cardUrl);
  }

  if (!invoicePath && !registerCard) {
    console.log("Usage: npx tsx src/agent.ts --invoice examples/invoice.json [--approve]");
    console.log("       npx tsx src/agent.ts --register-card");
    process.exit(1);
  }

  if (!invoicePath) return;

  const raw = await readFile(resolve(invoicePath), "utf8");
  const invoice = parseInvoice(raw);
  const ctx = await openAgent();
  console.log("Agent session:", didPrefix(ctx.session.did));
  console.log("Contract:", ctx.script, ctx.version);

  try {
    await grantStripeEgress(ctx.session.did, ctx.script, ctx.version);
    console.log("Egress grant: api.stripe.com (self-grant or USER_KEY)");
  } catch (err) {
    console.log("Egress grant skipped/failed (propose still works):", messageOf(err));
  }

  const { policy, proposal } = await proposeInvoice(ctx, invoice);
  console.log("Policy:", policy.decision, {
    amount_usd_cents: policy.amount_usd_cents,
    threshold_usd_cents: policy.threshold_usd_cents,
  });
  console.log("Proposal:", proposal.proposal_id, proposal.status);

  if (policy.decision === "needs_approval" && !approve) {
    console.log("Human approval required (default threshold $500). Re-run with --approve.");
    await writeFile(
      ".t3n-state.json",
      JSON.stringify({ last_proposal_id: proposal.proposal_id, script: ctx.script }, null, 2) + "\n",
    );
    return;
  }

  if (policy.decision === "needs_approval" && approve) {
    const paid = await approveAndPay(ctx, proposal.proposal_id);
    console.log("Paid:", redactPay(paid));
    return;
  }

  try {
    const paid = await autoPayIfAllowed(ctx, proposal.proposal_id);
    console.log("Paid:", redactPay(paid));
  } catch (err) {
    console.log("Execute skipped/failed (Stripe TEST key or profile may be unset):", messageOf(err));
  }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1]) return args[i + 1];
  return undefined;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function redactPay(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const rec = value as Record<string, unknown>;
  const { stripe_secret: _s, authorization: _a, ...rest } = rec;
  return rest;
}

const launchedDirectly = process.argv[1]?.endsWith("agent.ts");
if (launchedDirectly) {
  main().catch((err) => {
    console.error(messageOf(err));
    process.exit(1);
  });
}
