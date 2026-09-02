use alloc::string::String;
use alloc::string::ToString;
use alloc::vec::Vec;
use serde::Deserialize;

use crate::audit::{read_row, AuditRow};
#[cfg(target_arch = "wasm32")]
use crate::audit::write_row;
use crate::invoice::{parse_invoice, usd_cents};
use crate::policy::decide;

#[derive(Deserialize)]
struct ApproveReq {
    proposal_id: String,
    approver: String,
}

#[derive(Deserialize)]
struct ExecuteReq {
    proposal_id: String,
}

pub fn propose_payment(input: &[u8]) -> Result<Vec<u8>, String> {
    let inv = parse_invoice(input)?;
    let amount = usd_cents(&inv)?;
    let threshold = threshold_cents();
    let decision = decide(amount, threshold);
    let proposal_id = new_proposal_id();

    let row = AuditRow {
        proposal_id: proposal_id.clone(),
        vendor: inv.vendor,
        amount: inv.amount,
        currency: inv.currency.to_ascii_uppercase(),
        amount_usd_cents: amount,
        due_date: inv.due_date,
        memo: inv.memo,
        decision: decision.into(),
        status: if decision == "auto_approve" {
            "auto_approved".into()
        } else {
            "proposed".into()
        },
        threshold_usd_cents: threshold,
        stripe_payment_intent_id: None,
        stripe_livemode: None,
        approver: None,
    };

    persist_or_native_err(&row)?;

    serde_json::to_vec(&serde_json::json!({
        "proposal_id": row.proposal_id,
        "status": row.status,
        "decision": row.decision,
        "vendor": row.vendor,
        "amount": row.amount,
        "currency": row.currency,
    }))
    .map_err(|e| e.to_string())
}

pub fn approve_payment(input: &[u8]) -> Result<Vec<u8>, String> {
    let req: ApproveReq =
        serde_json::from_slice(input).map_err(|e| alloc::format!("approve-payment: bad input: {e}"))?;
    if req.approver.trim().is_empty() || req.approver.len() > 64 {
        return Err("approve-payment: bad input: approver".to_string());
    }
    let mut row = read_row(&req.proposal_id)?;
    if row.status == "paid" {
        return Err("proposal already paid".to_string());
    }
    row.status = "approved".into();
    row.approver = Some(req.approver);
    persist_or_native_err(&row)?;
    serde_json::to_vec(&row).map_err(|e| e.to_string())
}

pub fn execute_payment(input: &[u8]) -> Result<Vec<u8>, String> {
    let req: ExecuteReq =
        serde_json::from_slice(input).map_err(|e| alloc::format!("execute-payment: bad input: {e}"))?;

    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = req;
        return Err("execute_payment is only implemented on the wasm32 target".to_string());
    }

    #[cfg(target_arch = "wasm32")]
    {
        execute_payment_wasm(req.proposal_id)
    }
}

#[cfg(target_arch = "wasm32")]
fn execute_payment_wasm(proposal_id: String) -> Result<Vec<u8>, String> {
    use crate::host::interfaces::{http_with_placeholders as hwp, logging};

    let mut row = read_row(&proposal_id)?;
    if row.status == "paid" {
        return Err("proposal already paid".to_string());
    }
    let allowed = row.status == "auto_approved" || row.status == "approved";
    if !allowed {
        return Err("human approval required before execute-payment".to_string());
    }

    let api_key = stripe_test_key()?;
    // Opaque vendor destination (not a bank number). Optional.
    let destination = crate::audit::kv_get("vendors", row.vendor.to_ascii_lowercase().as_bytes())
        .ok()
        .flatten()
        .and_then(|b| alloc::string::String::from_utf8(b).ok());

    // Form body. receipt_email is a profile placeholder — host substitutes
    // inside the TEE. {{secrets.*}} is rejected by the host ABI.
    let mut form = alloc::format!(
        "amount={}&currency=usd&confirm=false&payment_method_types[0]=card&description=invoice {} {}&metadata[proposal_id]={}&metadata[vendor]={}&receipt_email={{{{profile.verified_contacts.email.value}}}}",
        row.amount_usd_cents,
        urlenc(&row.proposal_id),
        urlenc(&row.memo),
        urlenc(&row.proposal_id),
        urlenc(&row.vendor),
    );
    if let Some(dest) = destination.as_deref() {
        if dest.starts_with("acct_") {
            form.push_str("&on_behalf_of=");
            form.push_str(&urlenc(dest.trim()));
        }
    }

    let _ = logging::info(&alloc::format!(
        "stripe TEST payment_intents for {}",
        row.proposal_id
    ));

    let resp = hwp::call(&hwp::Request {
        method: hwp::Verb::Post,
        url: "https://api.stripe.com/v1/payment_intents".to_string(),
        headers: Some(alloc::vec![
            (
                "Authorization".to_string(),
                alloc::format!("Bearer {api_key}"),
            ),
            (
                "Content-Type".to_string(),
                "application/x-www-form-urlencoded".to_string(),
            ),
            ("Accept".to_string(), "application/json".to_string()),
        ]),
        payload: Some(form.into_bytes()),
    })
    .map_err(format_http_error)?;

    if resp.code != 200 {
        let body = alloc::string::String::from_utf8_lossy(&resp.payload);
        return Err(alloc::format!(
            "Stripe TEST payment_intents failed: HTTP {} — {body}",
            resp.code
        ));
    }

    let json: serde_json::Value =
        serde_json::from_slice(&resp.payload).map_err(|e| e.to_string())?;
    let livemode = json["livemode"].as_bool().unwrap_or(true);
    if livemode {
        return Err("refusing Stripe live-mode response".to_string());
    }
    let id = json["id"]
        .as_str()
        .ok_or("Stripe response missing id")?
        .to_string();
    let status = json["status"].as_str().unwrap_or("unknown").to_string();

    row.status = "paid".into();
    row.stripe_payment_intent_id = Some(id.clone());
    row.stripe_livemode = Some(false);
    write_row(&row)?;

    serde_json::to_vec(&serde_json::json!({
        "proposal_id": row.proposal_id,
        "status": row.status,
        "stripe_payment_intent_id": id,
        "stripe_status": status,
        "stripe_livemode": false,
    }))
    .map_err(|e| e.to_string())
}

fn persist_or_native_err(row: &AuditRow) -> Result<(), String> {
    #[cfg(target_arch = "wasm32")]
    {
        write_row(row)
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = row;
        // Native unit tests exercise parse + policy, not KV.
        Ok(())
    }
}

fn new_proposal_id() -> String {
    #[cfg(target_arch = "wasm32")]
    {
        use crate::host::tenant::tenant_context;
        alloc::format!("inv-{}", tenant_context::seq_no())
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        "inv-native-test".to_string()
    }
}

fn threshold_cents() -> u64 {
    #[cfg(target_arch = "wasm32")]
    {
        match crate::audit::kv_get("policy", b"approval_threshold_usd") {
            Ok(Some(bytes)) => alloc::string::String::from_utf8(bytes)
                .ok()
                .and_then(|s| s.trim().parse::<u64>().ok())
                .map(|usd| usd.saturating_mul(100))
                .unwrap_or(crate::DEFAULT_THRESHOLD_USD_CENTS),
            _ => crate::DEFAULT_THRESHOLD_USD_CENTS,
        }
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        crate::DEFAULT_THRESHOLD_USD_CENTS
    }
}

#[cfg(target_arch = "wasm32")]
fn stripe_test_key() -> Result<String, String> {
    let bytes = crate::audit::kv_get("secrets", b"stripe_secret_key")?
        .ok_or("stripe_secret_key not found in z:<tid>:secrets — seed a sk_test_ key via the tenant SDK")?;
    let key = String::from_utf8(bytes).map_err(|e| e.to_string())?;
    if key.starts_with("sk_live_") {
        return Err("refusing sk_live_ Stripe key".to_string());
    }
    if !key.starts_with("sk_test_") {
        return Err("stripe_secret_key must be a Stripe TEST key (sk_test_)".to_string());
    }
    Ok(key)
}

#[cfg(target_arch = "wasm32")]
fn format_http_error(e: crate::host::interfaces::http_with_placeholders::HttpError) -> String {
    use crate::host::interfaces::http_with_placeholders::HttpError;
    match e {
        HttpError::EgressDenied(host) => alloc::format!("egress denied for host {host}"),
        HttpError::PlaceholderDenied(marker) => {
            alloc::format!("placeholder not permitted: {marker}")
        }
        HttpError::PlaceholderUnknown(field) => {
            alloc::format!("user profile missing field: {field}")
        }
        HttpError::PlaceholderNoUserContext => {
            "no user context bound for placeholder resolution".to_string()
        }
        HttpError::UpstreamError(reason) => alloc::format!("upstream: {reason}"),
    }
}

fn urlenc(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            b' ' => out.push_str("%20"),
            _ => out.push_str(&alloc::format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn propose_rejects_pii_fields() {
        let input = serde_json::to_vec(&serde_json::json!({
            "vendor": "Acme",
            "amount": "10.00",
            "currency": "USD",
            "due_date": "2026-09-15",
            "memo": "ok",
            "iban": "DE00"
        }))
        .unwrap();
        let err = propose_payment(&input).unwrap_err();
        assert!(err.contains("bad input"));
    }

    #[test]
    fn execute_native_is_stubbed() {
        let input = serde_json::to_vec(&serde_json::json!({ "proposal_id": "inv-1" })).unwrap();
        let err = execute_payment(&input).unwrap_err();
        assert!(err.contains("wasm32"));
    }

    #[test]
    fn propose_under_threshold() {
        let input = serde_json::to_vec(&serde_json::json!({
            "vendor": "Acme Supplies",
            "amount": "40.00",
            "currency": "USD",
            "due_date": "2026-09-15",
            "memo": "Toner"
        }))
        .unwrap();
        let bytes = propose_payment(&input).unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["decision"], "auto_approve");
        assert_eq!(v["status"], "auto_approved");
    }
}
