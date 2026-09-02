import assert from "node:assert/strict";
import { test } from "node:test";
import { amountUsdCents, parseInvoice } from "./invoice.ts";

test("parses JSON invoices", () => {
  const inv = parseInvoice(
    JSON.stringify({
      vendor: "Acme Supplies",
      amount: "125.50",
      currency: "usd",
      due_date: "2026-09-15",
      memo: "Office paper Q3",
    }),
  );
  assert.equal(inv.currency, "USD");
  assert.equal(amountUsdCents(inv), 12550);
});

test("parses plain-text invoices", () => {
  const inv = parseInvoice(`Vendor: Northwind Paper
Amount: 40.00
Currency: USD
Due date: 2026-10-01
Memo: Toner`);
  assert.equal(inv.vendor, "Northwind Paper");
  assert.equal(inv.amount, "40.00");
});

test("rejects bank and secret fields", () => {
  assert.throws(
    () =>
      parseInvoice(
        JSON.stringify({
          vendor: "Acme",
          amount: "10.00",
          currency: "USD",
          due_date: "2026-09-15",
          memo: "pay to account_number 000111",
        }),
      ),
    /secret or bank field/,
  );
  assert.throws(
    () => parseInvoice(`Vendor: Acme
Amount: 10.00
Currency: USD
Due date: 2026-09-15
Memo: sk_test_leak`),
    /secret or bank field/,
  );
});

test("rejects unknown JSON keys so PII cannot be smuggled", () => {
  assert.throws(
    () =>
      parseInvoice(
        JSON.stringify({
          vendor: "Acme",
          amount: "10.00",
          currency: "USD",
          due_date: "2026-09-15",
          memo: "ok",
          given_name: "Jane",
        }),
      ),
    /unknown invoice field/,
  );
});
