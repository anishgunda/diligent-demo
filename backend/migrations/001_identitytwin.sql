create schema if not exists identitytwin;
set search_path to identitytwin, public;
revoke all on schema identitytwin from public;

create table organisations (
  id text primary key,
  clerk_organization_id text unique not null check (clerk_organization_id = id),
  name text not null,
  created_at timestamptz not null default now()
);

create table memberships (
  organization_id text not null references organisations(id),
  clerk_user_id text not null,
  role text not null check (role in ('AP_ANALYST','FINANCE_CONTROLLER')),
  created_at timestamptz not null default now(),
  seen_at timestamptz not null default now(),
  primary key (organization_id, clerk_user_id)
);

create table suppliers (
  id uuid not null,
  organization_id text not null references organisations(id),
  company_name text not null,
  verified_company_name text,
  company_number text not null,
  trusted_email_domain text not null default '',
  trusted_contact_reference text not null default '',
  verification_status text not null default 'UNVERIFIED',
  verification_source text,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (organization_id, id),
  unique (organization_id, company_number)
);

create table trusted_supplier_payment_records (
  id uuid not null,
  organization_id text not null,
  supplier_id uuid not null,
  payment_fingerprint text not null,
  masked_payment_label text not null,
  status text not null check (status in ('PENDING','VERIFIED','SUPERSEDED')),
  proposed_by text not null,
  proposed_at timestamptz not null default now(),
  approved_by text,
  verified_at timestamptz,
  verification_reference text,
  previous_payment jsonb,
  primary key (organization_id, id),
  foreign key (organization_id, supplier_id) references suppliers(organization_id, id),
  check (approved_by is null or approved_by <> proposed_by)
);
create unique index one_verified_payment on trusted_supplier_payment_records(organization_id, supplier_id)
  where status = 'VERIFIED';
create unique index one_pending_destination on trusted_supplier_payment_records(organization_id, supplier_id, payment_fingerprint)
  where status = 'PENDING';

create table invoice_uploads (
  id uuid not null,
  organization_id text not null references organisations(id),
  uploaded_by text not null,
  storage_path text unique not null,
  expires_at timestamptz not null default now() + interval '1 day',
  primary key (organization_id, id)
);

create table payment_candidates (
  id uuid not null,
  organization_id text not null references organisations(id),
  created_by text not null,
  payment_fingerprint text not null,
  masked_payment_label text not null,
  expires_at timestamptz not null default now() + interval '1 day',
  primary key (organization_id, id)
);

create table invoices (
  id uuid not null,
  organization_id text not null references organisations(id),
  supplier_id uuid,
  invoice_number text not null,
  claimed_supplier text not null,
  claimed_company_number text not null,
  amount numeric(11,2) not null check (amount > 0),
  currency text not null default 'GBP' check (currency = 'GBP'),
  invoice_date date not null,
  due_date date not null check (due_date >= invoice_date),
  claimed_sender text not null,
  claimed_signer text not null,
  claimed_payment_fingerprint text,
  masked_payment_label text,
  payment_reference text not null,
  message_redacted text not null,
  document_storage_path text,
  upload_id uuid,
  intake_source text not null default 'Upload',
  status text not null default 'QUEUED',
  created_at timestamptz not null default now(),
  primary key (organization_id, id),
  unique (organization_id, upload_id),
  foreign key (organization_id, supplier_id) references suppliers(organization_id,id),
  foreign key (organization_id, upload_id) references invoice_uploads(organization_id,id)
);

create table investigations (
  id uuid not null,
  organization_id text not null,
  invoice_id uuid not null,
  execution_mode text,
  ai_status text,
  provider text,
  model text,
  status text not null check (status in ('running','completed','error')),
  policy_verdict text,
  policy_result jsonb,
  baseline jsonb,
  mandatory_checks jsonb,
  sequence_number integer not null default 0,
  started_at timestamptz not null default now(),
  expires_at timestamptz not null,
  finished_at timestamptz,
  verification_requested_at timestamptz,
  verification_requested_by text,
  primary key (organization_id, id),
  foreign key (organization_id, invoice_id) references invoices(organization_id,id)
);
create unique index one_running_case on investigations(organization_id, invoice_id) where status = 'running';

create table investigation_events (
  id text not null,
  organization_id text not null,
  investigation_id uuid not null,
  sequence_number integer not null,
  event_type text not null,
  status text not null,
  tool_name text,
  summary text not null,
  structured_payload jsonb not null,
  provenance text not null,
  timestamp timestamptz not null,
  primary key (organization_id, investigation_id, sequence_number),
  foreign key (organization_id, investigation_id) references investigations(organization_id,id)
);

create table evidence_records (
  organization_id text not null,
  investigation_id uuid not null,
  sequence_number integer not null,
  tool_name text not null,
  evidence_type text not null,
  source text not null,
  structured_result jsonb not null,
  observed_at timestamptz not null,
  status text not null,
  primary key (organization_id, investigation_id, sequence_number),
  foreign key (organization_id, investigation_id, sequence_number)
    references investigation_events(organization_id,investigation_id,sequence_number)
);

create table verification_events (
  id uuid not null,
  organization_id text not null,
  investigation_id uuid not null,
  reviewer_id text not null,
  verification_method text not null,
  verification_outcome text not null,
  trusted_contact_source text not null,
  notes text not null,
  timestamp timestamptz not null default now(),
  primary key (organization_id, id),
  foreign key (organization_id, investigation_id) references investigations(organization_id,id)
);

create table audit_reports (
  id uuid not null,
  organization_id text not null,
  investigation_id uuid not null,
  report_version integer not null,
  report_payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (organization_id,id),
  unique (organization_id,investigation_id,report_version),
  foreign key (organization_id,investigation_id) references investigations(organization_id,id)
);

create index invoice_intake on invoices(organization_id,created_at desc);
create index invoice_supplier on invoices(organization_id,supplier_id,created_at desc);
create index investigation_latest on investigations(organization_id,invoice_id,started_at desc);
create index verification_latest on verification_events(organization_id,investigation_id,timestamp,id);
create index supplier_payments on trusted_supplier_payment_records(organization_id,supplier_id,proposed_at);

do $$
declare item text; tenant_column text;
begin
  foreach item in array array[
    'organisations','memberships','suppliers','trusted_supplier_payment_records','invoice_uploads',
    'payment_candidates','invoices','investigations','investigation_events','evidence_records',
    'verification_events','audit_reports'
  ] loop
    tenant_column := case when item = 'organisations' then 'id' else 'organization_id' end;
    execute format('alter table identitytwin.%I enable row level security', item);
    execute format('alter table identitytwin.%I force row level security', item);
    execute format(
      'create policy tenant_boundary on identitytwin.%I using (%I = current_setting(''app.organization_id'', true)) '
      'with check (%I = current_setting(''app.organization_id'', true))', item, tenant_column, tenant_column
    );
  end loop;
end $$;
