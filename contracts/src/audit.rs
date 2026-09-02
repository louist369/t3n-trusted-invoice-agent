use alloc::string::String;
use alloc::string::ToString;
use alloc::vec::Vec;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AuditRow {
    pub proposal_id: String,
    pub vendor: String,
    pub amount: String,
    pub currency: String,
    pub amount_usd_cents: u64,
    pub due_date: String,
    pub memo: String,
    pub decision: String,
    pub status: String,
    pub threshold_usd_cents: u64,
    pub stripe_payment_intent_id: Option<String>,
    pub stripe_livemode: Option<bool>,
    pub approver: Option<String>,
}

#[derive(Deserialize)]
struct GetAuditReq {
    proposal_id: String,
}

pub fn get_audit(input: &[u8]) -> Result<Vec<u8>, String> {
    let req: GetAuditReq =
        serde_json::from_slice(input).map_err(|e| alloc::format!("get-audit: bad input: {e}"))?;
    let row = read_row(&req.proposal_id)?;
    serde_json::to_vec(&row).map_err(|e| e.to_string())
}

pub fn read_row(proposal_id: &str) -> Result<AuditRow, String> {
    let bytes = kv_get("audit", proposal_id.as_bytes())?
        .ok_or_else(|| alloc::format!("audit row not found: {proposal_id}"))?;
    serde_json::from_slice(&bytes).map_err(|e| alloc::format!("corrupt audit row: {e}"))
}

pub fn write_row(row: &AuditRow) -> Result<(), String> {
    let bytes = serde_json::to_vec(row).map_err(|e| e.to_string())?;
    kv_put("audit", row.proposal_id.as_bytes(), &bytes)
}

pub fn kv_get(tail: &str, key: &[u8]) -> Result<Option<Vec<u8>>, String> {
    #[cfg(target_arch = "wasm32")]
    {
        use crate::host::{interfaces::kv_store, tenant::tenant_context};
        let tid = tenant_context::tenant_did();
        let map_name = alloc::format!("z:{}:{tail}", hex::encode(&tid));
        kv_store::get(&map_name, key).map_err(|e| alloc::format!("kv read {tail}: {e}"))
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = (tail, key);
        Ok(None)
    }
}

pub fn kv_put(tail: &str, key: &[u8], value: &[u8]) -> Result<(), String> {
    #[cfg(target_arch = "wasm32")]
    {
        use crate::host::{interfaces::kv_store, tenant::tenant_context};
        let tid = tenant_context::tenant_did();
        let map_name = alloc::format!("z:{}:{tail}", hex::encode(&tid));
        kv_store::put(&map_name, key, value).map_err(|e| alloc::format!("kv write {tail}: {e}"))
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = (tail, key, value);
        Err("kv_put is only implemented on the wasm32 target".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn get_audit_bad_input() {
        let err = get_audit(b"nope").unwrap_err();
        assert!(err.contains("bad input"));
    }
}
