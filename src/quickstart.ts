/**
 * First authenticated call — follows
 * https://docs.terminal3.io/developers/adk/get-started/quickstart.md
 *
 * Difference vs the doc snippet: this repo uses setEnvironment("sandbox")
 * and fetchTrustedManifest("sandbox") as required by the challenge and as
 * documented in the installed @terminal3/t3n-sdk README (v5.7.0).
 * Official walkthrough pages still say "testnet"; both names resolve to
 * the same public test node. See docs/DX_AND_BUGS.md.
 */
import { TenantClient, getNodeUrl } from "@terminal3/t3n-sdk";
import { connect, didPrefix, loadEnv, requireEnv } from "./t3n.ts";

loadEnv();

const T3N_API_KEY = requireEnv("T3N_API_KEY");

const { t3n, did: tenantDid } = await connect(T3N_API_KEY);
console.log("Connected as:", didPrefix(tenantDid));

const tenant = new TenantClient({
  t3n,
  baseUrl: getNodeUrl(),
  tenantDid,
});

await tenant.tenant.me();
console.log("TenantClient ready.");
