use alloc::string::String;
use serde::Serialize;

use crate::invoice::{parse_invoice, usd_cents};
use crate::DEFAULT_THRESHOLD_USD_CENTS;

#[derive(Serialize)]
pub struct PolicyDecision {
    pub decision: String,
    pub amount_usd_cents: u64,
    pub threshold_usd_cents: u64,
    pub currency: String,
}

pub fn decide(amount_usd_cents: u64, threshold_usd_cents: u64) -> &'static str {
    if amount_usd_cents > threshold_usd_cents {
        "needs_approval"
    } else {
        "auto_approve"
    }
}

/// Native + wasm: parse invoice and apply the default threshold unless a
/// caller-supplied threshold is passed (wasm path reads KV).
pub fn evaluate_policy(input: &[u8]) -> Result<alloc::vec::Vec<u8>, String> {
    let inv = parse_invoice(input)?;
    let amount = usd_cents(&inv)?;
    let threshold = threshold_usd_cents();
    let out = PolicyDecision {
        decision: decide(amount, threshold).into(),
        amount_usd_cents: amount,
        threshold_usd_cents: threshold,
        currency: "USD".into(),
    };
    serde_json::to_vec(&out).map_err(|e| e.to_string())
}

fn threshold_usd_cents() -> u64 {
    #[cfg(target_arch = "wasm32")]
    {
        match crate::audit::kv_get("policy", b"approval_threshold_usd") {
            Ok(Some(bytes)) => {
                if let Ok(s) = alloc::string::String::from_utf8(bytes) {
                    if let Ok(usd) = s.trim().parse::<u64>() {
                        return usd.saturating_mul(100);
                    }
                }
                DEFAULT_THRESHOLD_USD_CENTS
            }
            _ => DEFAULT_THRESHOLD_USD_CENTS,
        }
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        DEFAULT_THRESHOLD_USD_CENTS
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn under_threshold_auto_approves() {
        let input = serde_json::to_vec(&serde_json::json!({
            "vendor": "Acme Supplies",
            "amount": "125.00",
            "currency": "USD",
            "due_date": "2026-09-15",
            "memo": "Office paper"
        }))
        .unwrap();
        let bytes = evaluate_policy(&input).unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["decision"], "auto_approve");
        assert_eq!(v["amount_usd_cents"], 12500);
        assert_eq!(v["threshold_usd_cents"], 50000);
    }

    #[test]
    fn over_threshold_needs_approval() {
        let input = serde_json::to_vec(&serde_json::json!({
            "vendor": "Acme Supplies",
            "amount": "750.00",
            "currency": "USD",
            "due_date": "2026-09-15",
            "memo": "Laptops"
        }))
        .unwrap();
        let bytes = evaluate_policy(&input).unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["decision"], "needs_approval");
    }
}
