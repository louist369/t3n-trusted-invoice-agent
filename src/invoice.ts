/**
 * Invoice intake for the finance-team agent.
 *
 * Accepts JSON or a small plain-text form. Bank / account numbers, API
 * secrets, and card data are rejected here so they never reach the model
 * prompt or the contract input. Destinations live in tenant KV; the Stripe
 * secret lives in z:<tid>:secrets.
 */

export type Invoice = {
  vendor: string;
  amount: string;
  currency: string;
  due_date: string;
  memo: string;
};

const ALLOWED_KEYS = new Set(["vendor", "amount", "currency", "due_date", "memo"]);

const FORBIDDEN = [
  /account[_\s-]?number/i,
  /routing[_\s-]?number/i,
  /\biban\b/i,
  /\bswift\b/i,
  /bank[_\s-]?account/i,
  /api[_\s-]?key/i,
  /secret/i,
  /sk_(live|test)_/i,
  /private[_\s-]?key/i,
  /card[_\s-]?number/i,
  /\bcvv\b/i,
  /\bssn\b/i,
  /password/i,
];

export function assertNoSecrets(text: string): void {
  for (const re of FORBIDDEN) {
    if (re.test(text)) {
      throw new Error(
        `Invoice input looks like it contains a secret or bank field (${re}). ` +
          "Remove it. Destinations belong in tenant KV; the Stripe key belongs in z:<tid>:secrets.",
      );
    }
  }
}

export function parseInvoice(raw: string): Invoice {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("empty invoice");
  assertNoSecrets(trimmed);

  if (trimmed.startsWith("{")) {
    return parseJsonInvoice(trimmed);
  }
  return parseTextInvoice(trimmed);
}

function parseJsonInvoice(raw: string): Invoice {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invoice JSON is invalid: ${String(err)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invoice JSON must be an object");
  }
  const rec = value as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(
        `unknown invoice field "${key}". Allowed: vendor, amount, currency, due_date, memo.`,
      );
    }
  }
  return normalize({
    vendor: mustString(rec, "vendor"),
    amount: mustString(rec, "amount"),
    currency: mustString(rec, "currency"),
    due_date: mustString(rec, "due_date"),
    memo: mustString(rec, "memo"),
  });
}

function parseTextInvoice(raw: string): Invoice {
  const fields: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const cut = line.trim();
    if (!cut) continue;
    const m = cut.match(/^(vendor|amount|currency|due date|due_date|memo)\s*:\s*(.+)$/i);
    if (!m) {
      throw new Error(`unrecognized invoice line: "${cut}". Use "Vendor: …" / "Amount: …".`);
    }
    const label = m[1].toLowerCase().replace(/\s+/g, "_");
    fields[label === "due_date" ? "due_date" : label] = m[2].trim();
  }
  return normalize({
    vendor: fields.vendor ?? "",
    amount: fields.amount ?? "",
    currency: fields.currency ?? "",
    due_date: fields.due_date ?? "",
    memo: fields.memo ?? "",
  });
}

function mustString(rec: Record<string, unknown>, key: string): string {
  const v = rec[key];
  if (typeof v !== "string" || !v.trim()) {
    throw new Error(`invoice field "${key}" must be a non-empty string`);
  }
  return v.trim();
}

function normalize(inv: Invoice): Invoice {
  const currency = inv.currency.toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new Error("currency must be a 3-letter ISO code (e.g. USD)");
  }
  if (!/^\d+(\.\d{1,2})?$/.test(inv.amount)) {
    throw new Error("amount must be a decimal with at most two places, no currency symbol");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(inv.due_date)) {
    throw new Error("due_date must be YYYY-MM-DD");
  }
  if (inv.vendor.length > 120 || inv.memo.length > 280) {
    throw new Error("vendor or memo is too long");
  }
  return {
    vendor: inv.vendor,
    amount: inv.amount,
    currency,
    due_date: inv.due_date,
    memo: inv.memo,
  };
}

export function amountUsdCents(invoice: Invoice): number | null {
  if (invoice.currency !== "USD") return null;
  const [whole, frac = ""] = invoice.amount.split(".");
  return Number(whole) * 100 + Number((frac + "00").slice(0, 2));
}
