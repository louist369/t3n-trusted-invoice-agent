//! Trusted invoice-pay TEE contract.
//!
//! Invoice fields crossing the WIT boundary: vendor, amount, currency,
//! due date, memo. No bank numbers, no API keys.
//!
//! Stripe TEST secret is read from `z:<tid>:secrets` inside the enclave.
//! Finance-team receipt email is substituted host-side via
//! `{{profile.verified_contacts.email.value}}`.

#![warn(clippy::style)]
#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]

extern crate alloc;

pub const CONTRACT_VERSION: &str = "0.1.0";
pub const DEFAULT_THRESHOLD_USD_CENTS: u64 = 50_000;

wit_bindgen::generate!({
    world: "invoice-pay",
    path: "wit",
    additional_derives: [serde::Deserialize, serde::Serialize],
    generate_all,
});

pub mod audit;
pub mod invoice;
pub mod payment;
pub mod policy;

struct Component;

#[cfg(target_arch = "wasm32")]
impl exports::z::invoice_pay::contracts::Guest for Component {
    fn evaluate_policy(
        req: exports::z::invoice_pay::contracts::GenericInput,
    ) -> Result<alloc::vec::Vec<u8>, alloc::string::String> {
        let input = req.input.ok_or("evaluate-policy: missing input")?;
        policy::evaluate_policy(&input)
    }

    fn propose_payment(
        req: exports::z::invoice_pay::contracts::GenericInput,
    ) -> Result<alloc::vec::Vec<u8>, alloc::string::String> {
        let input = req.input.ok_or("propose-payment: missing input")?;
        payment::propose_payment(&input)
    }

    fn approve_payment(
        req: exports::z::invoice_pay::contracts::GenericInput,
    ) -> Result<alloc::vec::Vec<u8>, alloc::string::String> {
        let input = req.input.ok_or("approve-payment: missing input")?;
        payment::approve_payment(&input)
    }

    fn execute_payment(
        req: exports::z::invoice_pay::contracts::GenericInput,
    ) -> Result<alloc::vec::Vec<u8>, alloc::string::String> {
        let input = req.input.ok_or("execute-payment: missing input")?;
        payment::execute_payment(&input)
    }

    fn get_audit(
        req: exports::z::invoice_pay::contracts::GenericInput,
    ) -> Result<alloc::vec::Vec<u8>, alloc::string::String> {
        let input = req.input.ok_or("get-audit: missing input")?;
        audit::get_audit(&input)
    }
}

#[cfg(target_arch = "wasm32")]
export!(Component);

#[cfg(test)]
mod tests {
    use super::CONTRACT_VERSION;

    #[test]
    fn contract_version_is_semver() {
        let parts: Vec<&str> = CONTRACT_VERSION.split('.').collect();
        assert_eq!(parts.len(), 3);
        for part in parts {
            assert!(part.parse::<u32>().is_ok());
        }
    }
}
