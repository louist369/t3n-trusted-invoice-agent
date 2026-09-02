use alloc::string::String;
use alloc::string::ToString;

/// Invoice fields the agent is allowed to send. `deny_unknown_fields` is the
/// hygiene gate — a payload that tries to smuggle bank/PII keys fails parse.
#[derive(Debug, serde::Deserialize, serde::Serialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct InvoiceInput {
    pub vendor: String,
    pub amount: String,
    pub currency: String,
    pub due_date: String,
    pub memo: String,
}

pub fn parse_invoice(input: &[u8]) -> Result<InvoiceInput, String> {
    let inv: InvoiceInput = serde_json::from_slice(input)
        .map_err(|e| alloc::format!("bad input: {e}"))?;
    if inv.vendor.trim().is_empty() || inv.vendor.len() > 120 {
        return Err("bad input: vendor".to_string());
    }
    if inv.memo.len() > 280 {
        return Err("bad input: memo".to_string());
    }
    if inv.currency.len() != 3 {
        return Err("bad input: currency must be ISO-4217".to_string());
    }
    if !inv.due_date.chars().all(|c| c.is_ascii_digit() || c == '-') || inv.due_date.len() != 10 {
        return Err("bad input: due_date".to_string());
    }
    let _ = amount_to_cents(&inv.amount)?;
    Ok(inv)
}

pub fn amount_to_cents(amount: &str) -> Result<u64, String> {
    let mut parts = amount.split('.');
    let whole = parts.next().ok_or("bad input: amount")?;
    let frac = parts.next().unwrap_or("00");
    if parts.next().is_some() {
        return Err("bad input: amount".to_string());
    }
    if whole.is_empty() || !whole.chars().all(|c| c.is_ascii_digit()) {
        return Err("bad input: amount".to_string());
    }
    if frac.is_empty() || frac.len() > 2 || !frac.chars().all(|c| c.is_ascii_digit()) {
        return Err("bad input: amount".to_string());
    }
    let whole_n: u64 = whole.parse().map_err(|_| "bad input: amount".to_string())?;
    let frac_padded = if frac.len() == 1 {
        alloc::format!("{frac}0")
    } else {
        frac.to_string()
    };
    let frac_n: u64 = frac_padded
        .parse()
        .map_err(|_| "bad input: amount".to_string())?;
    whole_n
        .checked_mul(100)
        .and_then(|v| v.checked_add(frac_n))
        .ok_or_else(|| "bad input: amount overflow".to_string())
}

/// USD cents for the approval threshold. Non-USD invoices are refused
/// rather than converted with a made-up FX rate.
pub fn usd_cents(inv: &InvoiceInput) -> Result<u64, String> {
    if inv.currency.to_ascii_uppercase() != "USD" {
        return Err("only USD invoices are accepted for the approval threshold".to_string());
    }
    amount_to_cents(&inv.amount)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_json() {
        let err = parse_invoice(b"not json").unwrap_err();
        assert!(err.contains("bad input"));
    }

    #[test]
    fn rejects_inline_bank_field() {
        let input = serde_json::to_vec(&serde_json::json!({
            "vendor": "Acme",
            "amount": "10.00",
            "currency": "USD",
            "due_date": "2026-09-15",
            "memo": "ok",
            "account_number": "000111222"
        }))
        .unwrap();
        let err = parse_invoice(&input).unwrap_err();
        assert!(err.contains("bad input"));
    }

    #[test]
    fn parses_two_decimal_amount() {
        assert_eq!(amount_to_cents("125.50").unwrap(), 12550);
        assert_eq!(amount_to_cents("40").unwrap(), 4000);
    }
}
