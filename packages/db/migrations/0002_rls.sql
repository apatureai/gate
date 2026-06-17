-- 0002_rls: tenant isolation as a schema property (TRD §8, §15.6; ARCHITECTURE §8 D6).
-- Defense-in-depth on top of application WHERE clauses: one missed
-- installation_id filter must NOT become a cross-tenant leak.
--
-- The tenant for a request is carried in the transaction-local GUC
-- `app.current_installation_id` (set via set_config(..., true) per request).
-- When unset it reads NULL, so every policy default-denies.
--
-- FORCE ROW LEVEL SECURITY makes even the table owner subject to the policies,
-- so RLS holds regardless of which role the app connects as.

ALTER TABLE installations     ENABLE ROW LEVEL SECURITY;
ALTER TABLE installations     FORCE  ROW LEVEL SECURITY;
ALTER TABLE runs              ENABLE ROW LEVEL SECURITY;
ALTER TABLE runs              FORCE  ROW LEVEL SECURITY;
ALTER TABLE feedback_events   ENABLE ROW LEVEL SECURITY;
ALTER TABLE feedback_events   FORCE  ROW LEVEL SECURITY;
ALTER TABLE billing_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_customers FORCE  ROW LEVEL SECURITY;

-- installations: the tenant id is the row's own id.
DROP POLICY IF EXISTS installations_tenant_isolation ON installations;
CREATE POLICY installations_tenant_isolation ON installations
  USING (id = nullif(current_setting('app.current_installation_id', true), '')::bigint)
  WITH CHECK (id = nullif(current_setting('app.current_installation_id', true), '')::bigint);

DROP POLICY IF EXISTS runs_tenant_isolation ON runs;
CREATE POLICY runs_tenant_isolation ON runs
  USING (installation_id = nullif(current_setting('app.current_installation_id', true), '')::bigint)
  WITH CHECK (installation_id = nullif(current_setting('app.current_installation_id', true), '')::bigint);

DROP POLICY IF EXISTS feedback_events_tenant_isolation ON feedback_events;
CREATE POLICY feedback_events_tenant_isolation ON feedback_events
  USING (installation_id = nullif(current_setting('app.current_installation_id', true), '')::bigint)
  WITH CHECK (installation_id = nullif(current_setting('app.current_installation_id', true), '')::bigint);

DROP POLICY IF EXISTS billing_customers_tenant_isolation ON billing_customers;
CREATE POLICY billing_customers_tenant_isolation ON billing_customers
  USING (installation_id = nullif(current_setting('app.current_installation_id', true), '')::bigint)
  WITH CHECK (installation_id = nullif(current_setting('app.current_installation_id', true), '')::bigint);
