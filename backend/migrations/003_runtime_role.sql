do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'identitytwin_runtime') then
    create role identitytwin_runtime nologin nobypassrls;
  end if;
end $$;

grant usage on schema identitytwin to identitytwin_runtime;
grant select, insert, update on identitytwin.organisations, identitytwin.memberships,
  identitytwin.suppliers, identitytwin.trusted_supplier_payment_records,
  identitytwin.invoices, identitytwin.investigations to identitytwin_runtime;
grant select, insert on identitytwin.invoice_uploads, identitytwin.payment_candidates,
  identitytwin.investigation_events, identitytwin.evidence_records,
  identitytwin.verification_events, identitytwin.audit_reports to identitytwin_runtime;

-- Saving an upload acquires a row lock to make retries idempotent.
grant update (expires_at) on identitytwin.invoice_uploads to identitytwin_runtime;
