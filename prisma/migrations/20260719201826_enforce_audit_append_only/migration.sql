DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'kyc_app_role') THEN
    CREATE ROLE kyc_app_role LOGIN PASSWORD 'change_me_in_production';
  END IF;
END
$$;

GRANT CONNECT ON DATABASE kyc_orchestration TO kyc_app_role;
GRANT USAGE ON SCHEMA public TO kyc_app_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO kyc_app_role;

REVOKE UPDATE, DELETE ON audit_events FROM kyc_app_role;
GRANT SELECT, INSERT ON audit_events TO kyc_app_role;

CREATE OR REPLACE FUNCTION reject_audit_event_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only: % operations are not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_events_no_update
  BEFORE UPDATE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_audit_event_mutation();

CREATE TRIGGER trg_audit_events_no_delete
  BEFORE DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_audit_event_mutation();