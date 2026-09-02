/**
 * Pause the registered invoice-pay contract (tenant.contracts.disable).
 * Resume with: same script --resume
 */
import { CONTRACT_TAIL, connect, didPrefix, loadEnv, requireEnv, tenantClient } from "../src/t3n.ts";

loadEnv();
const session = await connect(requireEnv("T3N_API_KEY"));
const tenant = tenantClient(session);
await tenant.tenant.me();
console.log("Tenant:", didPrefix(session.did));

if (process.argv.includes("--resume")) {
  await tenant.contracts.enable(CONTRACT_TAIL);
  console.log("enabled", CONTRACT_TAIL);
} else {
  await tenant.contracts.disable(CONTRACT_TAIL);
  console.log("disabled", CONTRACT_TAIL);
}
