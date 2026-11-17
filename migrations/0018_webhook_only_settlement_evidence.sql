DELETE FROM payment_settlement_evidence
WHERE evidence_source <> 'SEPAY_WEBHOOK';

CREATE TRIGGER payment_settlement_evidence_webhook_insert
BEFORE INSERT ON payment_settlement_evidence
WHEN NEW.evidence_source <> 'SEPAY_WEBHOOK'
BEGIN
  SELECT RAISE(ABORT, 'settlement evidence must originate from a verified webhook');
END;

CREATE TRIGGER payment_settlement_evidence_webhook_update
BEFORE UPDATE OF evidence_source ON payment_settlement_evidence
WHEN NEW.evidence_source <> 'SEPAY_WEBHOOK'
BEGIN
  SELECT RAISE(ABORT, 'settlement evidence must originate from a verified webhook');
END;
