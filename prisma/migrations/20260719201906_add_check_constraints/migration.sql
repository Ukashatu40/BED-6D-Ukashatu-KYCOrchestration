ALTER TABLE customers
  ADD CONSTRAINT chk_customers_risk_score_range
  CHECK (risk_score >= 0 AND risk_score <= 100);

ALTER TABLE customers
  ADD CONSTRAINT chk_customers_ckyc_kin_length
  CHECK (ckyc_kin IS NULL OR length(ckyc_kin) = 14);

ALTER TABLE documents
  ADD CONSTRAINT chk_documents_file_size_positive
  CHECK (file_size_bytes > 0);

ALTER TABLE aml_screening_results
  ADD CONSTRAINT chk_aml_screening_risk_score_range
  CHECK (highest_risk_score >= 0 AND highest_risk_score <= 100);

ALTER TABLE aml_match_details
  ADD CONSTRAINT chk_aml_match_risk_score_range
  CHECK (risk_score >= 0 AND risk_score <= 100);