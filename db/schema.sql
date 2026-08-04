BEGIN;

CREATE SCHEMA IF NOT EXISTS governance;
CREATE SCHEMA IF NOT EXISTS raw;
CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS analytics;

-- Source tracking and data trust (6 tables)

CREATE TABLE IF NOT EXISTS governance.import_run (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  files_seen integer NOT NULL DEFAULT 0 CHECK (files_seen >= 0),
  rows_seen integer NOT NULL DEFAULT 0 CHECK (rows_seen >= 0),
  core_records_written integer NOT NULL DEFAULT 0 CHECK (core_records_written >= 0),
  issue_count integer NOT NULL DEFAULT 0 CHECK (issue_count >= 0),
  error_message text
);

CREATE TABLE IF NOT EXISTS governance.source_contract (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workbook_name text NOT NULL,
  sheet_name text NOT NULL,
  header_row integer NOT NULL CHECK (header_row > 0),
  owner_name text,
  cadence text,
  maximum_age_hours integer CHECK (maximum_age_hours > 0),
  authoritative_for text,
  required boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  UNIQUE (workbook_name, sheet_name)
);

CREATE TABLE IF NOT EXISTS governance.source_file (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  import_run_id bigint NOT NULL REFERENCES governance.import_run(id),
  relative_path text NOT NULL,
  file_name text NOT NULL,
  file_hash text NOT NULL UNIQUE,
  file_size_bytes bigint NOT NULL CHECK (file_size_bytes >= 0),
  file_modified_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS raw.source_row (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_file_id bigint NOT NULL REFERENCES governance.source_file(id),
  sheet_name text NOT NULL,
  row_number integer NOT NULL CHECK (row_number > 0),
  row_hash text NOT NULL,
  raw_data jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_file_id, sheet_name, row_number)
);

CREATE TABLE IF NOT EXISTS governance.data_issue (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  import_run_id bigint REFERENCES governance.import_run(id),
  rule_code text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
  entity_name text NOT NULL,
  entity_key text,
  source_row_id bigint REFERENCES raw.source_row(id),
  message text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolution_note text
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_open_data_issue
  ON governance.data_issue (
    COALESCE(import_run_id, 0), rule_code, entity_name,
    COALESCE(entity_key, ''), COALESCE(source_row_id, 0), message
  ) WHERE resolved_at IS NULL;

CREATE TABLE IF NOT EXISTS governance.calculation_rule (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  definition text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'retired')),
  effective_from date,
  effective_to date,
  approved_by text,
  approved_at timestamptz,
  UNIQUE (code, version),
  CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from)
);

-- Master data (7 tables)

CREATE TABLE IF NOT EXISTS core.organization (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_code text NOT NULL UNIQUE,
  legal_name text NOT NULL,
  normalized_name text NOT NULL UNIQUE,
  tax_id text,
  active boolean NOT NULL DEFAULT true,
  source_row_id bigint REFERENCES raw.source_row(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS core.organization_alias (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id bigint NOT NULL REFERENCES core.organization(id),
  alias text NOT NULL,
  normalized_alias text NOT NULL UNIQUE,
  source_row_id bigint REFERENCES raw.source_row(id)
);

CREATE TABLE IF NOT EXISTS core.organization_role (
  organization_id bigint NOT NULL REFERENCES core.organization(id),
  role text NOT NULL CHECK (role IN ('customer', 'supplier', 'transporter', 'mine_owner', 'competitor', 'laboratory')),
  source_row_id bigint REFERENCES raw.source_row(id),
  PRIMARY KEY (organization_id, role)
);

CREATE TABLE IF NOT EXISTS core.site (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id bigint REFERENCES core.organization(id),
  site_code text NOT NULL UNIQUE,
  name text NOT NULL,
  normalized_name text NOT NULL,
  site_type text NOT NULL CHECK (site_type IN ('mine', 'plant', 'warehouse', 'customer', 'other')),
  address text,
  state text,
  source_row_id bigint REFERENCES raw.source_row(id),
  UNIQUE (organization_id, normalized_name)
);

CREATE TABLE IF NOT EXISTS core.material (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  material_code text NOT NULL UNIQUE,
  mineral text NOT NULL,
  category text NOT NULL CHECK (category IN ('lump', 'fine', 'cleaning_screening', 'tailings', 'manganese', 'other')),
  size_spec text,
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS core.lot (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kej_lot_number text NOT NULL UNIQUE,
  material_id bigint NOT NULL REFERENCES core.material(id),
  supplier_id bigint REFERENCES core.organization(id),
  source_lot_number text,
  description text,
  created_on date,
  lifecycle_status text NOT NULL DEFAULT 'unknown' CHECK (lifecycle_status IN ('unlifted', 'unprocessed', 'finished', 'consumed', 'closed', 'unknown')),
  source_row_id bigint REFERENCES raw.source_row(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS core.lot_alias (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lot_id bigint NOT NULL REFERENCES core.lot(id),
  alias text NOT NULL,
  normalized_alias text NOT NULL,
  source_organization_id bigint REFERENCES core.organization(id),
  source_row_id bigint REFERENCES raw.source_row(id),
  UNIQUE (lot_id, normalized_alias)
);

CREATE INDEX IF NOT EXISTS ix_lot_alias_normalized ON core.lot_alias(normalized_alias);

-- Business facts (15 tables)

CREATE TABLE IF NOT EXISTS core.purchase_lot (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_key text NOT NULL UNIQUE,
  supplier_id bigint NOT NULL REFERENCES core.organization(id),
  lot_id bigint REFERENCES core.lot(id),
  material_id bigint REFERENCES core.material(id),
  source_lot_number text NOT NULL,
  purchase_date date NOT NULL,
  purchased_quantity_mt numeric(18,3) NOT NULL CHECK (purchased_quantity_mt >= 0),
  purchase_rate_inr_per_mt numeric(18,4) CHECK (purchase_rate_inr_per_mt >= 0),
  reported_landed_cost_inr_per_mt numeric(18,4) CHECK (reported_landed_cost_inr_per_mt >= 0),
  reported_lifted_quantity_mt numeric(18,3) CHECK (reported_lifted_quantity_mt >= 0),
  reported_balance_to_lift_mt numeric(18,3),
  reported_payment_balance_mt numeric(18,3),
  reported_permit_balance_mt numeric(18,3),
  reported_payment_status text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'cancelled', 'unknown')),
  source_row_id bigint NOT NULL REFERENCES raw.source_row(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS core.sales_order_line (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_key text NOT NULL UNIQUE,
  customer_id bigint NOT NULL REFERENCES core.organization(id),
  po_number text NOT NULL,
  po_date date NOT NULL,
  material_id bigint REFERENCES core.material(id),
  ordered_quantity_mt numeric(18,3) NOT NULL CHECK (ordered_quantity_mt >= 0),
  selling_rate_inr_per_mt numeric(18,4) CHECK (selling_rate_inr_per_mt >= 0),
  target_fe_pct numeric(8,4) CHECK (target_fe_pct BETWEEN 0 AND 100),
  size_spec text,
  due_date date,
  reported_dispatched_quantity_mt numeric(18,3) CHECK (reported_dispatched_quantity_mt >= 0),
  reported_balance_to_dispatch_mt numeric(18,3),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'cancelled', 'unknown')),
  source_row_id bigint NOT NULL REFERENCES raw.source_row(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, po_number, business_key)
);

CREATE TABLE IF NOT EXISTS core.permit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  permit_number text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('inward', 'outward')),
  organization_id bigint REFERENCES core.organization(id),
  purchase_lot_id bigint REFERENCES core.purchase_lot(id),
  sales_order_line_id bigint REFERENCES core.sales_order_line(id),
  issued_on date,
  expires_on date,
  permitted_quantity_mt numeric(18,3) CHECK (permitted_quantity_mt >= 0),
  material_id bigint REFERENCES core.material(id),
  status text NOT NULL DEFAULT 'unknown',
  source_row_id bigint REFERENCES raw.source_row(id),
  CHECK (num_nonnulls(purchase_lot_id, sales_order_line_id) <= 1),
  CHECK (expires_on IS NULL OR issued_on IS NULL OR expires_on >= issued_on),
  UNIQUE (permit_number, direction)
);

CREATE TABLE IF NOT EXISTS core.inward_receipt (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_key text NOT NULL UNIQUE,
  receipt_at timestamptz NOT NULL,
  purchase_lot_id bigint REFERENCES core.purchase_lot(id),
  lot_id bigint REFERENCES core.lot(id),
  source_lot_number text NOT NULL,
  permit_id bigint REFERENCES core.permit(id),
  supplier_id bigint REFERENCES core.organization(id),
  transporter_id bigint REFERENCES core.organization(id),
  vehicle_number text,
  weighbridge_slip_number text,
  quantity_mt numeric(18,3) NOT NULL CHECK (quantity_mt >= 0),
  trip_count integer CHECK (trip_count >= 0),
  source_row_id bigint NOT NULL REFERENCES raw.source_row(id)
);

CREATE TABLE IF NOT EXISTS core.dispatch (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_key text NOT NULL UNIQUE,
  dispatch_at timestamptz NOT NULL,
  sales_order_line_id bigint REFERENCES core.sales_order_line(id),
  customer_id bigint NOT NULL REFERENCES core.organization(id),
  lot_id bigint REFERENCES core.lot(id),
  permit_id bigint REFERENCES core.permit(id),
  transporter_id bigint REFERENCES core.organization(id),
  vehicle_number text,
  weighbridge_slip_number text,
  quantity_mt numeric(18,3) NOT NULL CHECK (quantity_mt >= 0),
  vehicle_count integer CHECK (vehicle_count >= 0),
  source_row_id bigint NOT NULL REFERENCES raw.source_row(id)
);

CREATE TABLE IF NOT EXISTS core.inventory_movement (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_key text NOT NULL UNIQUE,
  occurred_at timestamptz NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('opening', 'inward_receipt', 'production_feed', 'production_output', 'customer_dispatch', 'transfer', 'shortage_loss', 'adjustment', 'other')),
  lot_id bigint NOT NULL REFERENCES core.lot(id),
  site_id bigint REFERENCES core.site(id),
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  quantity_mt numeric(18,3) NOT NULL CHECK (quantity_mt >= 0),
  reference_type text,
  reference_key text,
  source_row_id bigint NOT NULL REFERENCES raw.source_row(id)
);

CREATE TABLE IF NOT EXISTS core.stock_snapshot (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  snapshot_at timestamptz NOT NULL,
  lot_id bigint NOT NULL REFERENCES core.lot(id),
  site_id bigint REFERENCES core.site(id),
  recorded_quantity_mt numeric(18,3) NOT NULL CHECK (recorded_quantity_mt >= 0),
  reported_fe_pct numeric(8,4) CHECK (reported_fe_pct BETWEEN 0 AND 100),
  reported_landed_cost_inr_per_mt numeric(18,4) CHECK (reported_landed_cost_inr_per_mt >= 0),
  reported_status text,
  source_row_id bigint NOT NULL REFERENCES raw.source_row(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_snapshot_lot_site
  ON core.stock_snapshot(snapshot_at, lot_id, COALESCE(site_id, 0));

CREATE TABLE IF NOT EXISTS core.auction_lot (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_key text NOT NULL UNIQUE,
  auction_number text NOT NULL,
  external_lot_number text NOT NULL,
  closes_at timestamptz,
  seller_id bigint REFERENCES core.organization(id),
  site_id bigint REFERENCES core.site(id),
  material_id bigint REFERENCES core.material(id),
  offered_quantity_mt numeric(18,3) CHECK (offered_quantity_mt >= 0),
  sold_quantity_mt numeric(18,3) CHECK (sold_quantity_mt >= 0),
  indicative_fe_pct numeric(8,4) CHECK (indicative_fe_pct BETWEEN 0 AND 100),
  opening_price_inr_per_mt numeric(18,4) CHECK (opening_price_inr_per_mt >= 0),
  current_price_inr_per_mt numeric(18,4) CHECK (current_price_inr_per_mt >= 0),
  reported_landed_price_inr_per_mt numeric(18,4) CHECK (reported_landed_price_inr_per_mt >= 0),
  reported_premium_pct numeric(8,4),
  source_row_id bigint NOT NULL REFERENCES raw.source_row(id),
  UNIQUE (auction_number, external_lot_number)
);

CREATE TABLE IF NOT EXISTS core.auction_bid_award (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_key text NOT NULL UNIQUE,
  auction_lot_id bigint NOT NULL REFERENCES core.auction_lot(id),
  buyer_id bigint NOT NULL REFERENCES core.organization(id),
  event_at timestamptz,
  bid_quantity_mt numeric(18,3) CHECK (bid_quantity_mt >= 0),
  bid_rate_inr_per_mt numeric(18,4) CHECK (bid_rate_inr_per_mt >= 0),
  allocated_quantity_mt numeric(18,3) CHECK (allocated_quantity_mt >= 0),
  result text NOT NULL DEFAULT 'unknown' CHECK (result IN ('bid', 'won', 'lost', 'allocated', 'cancelled', 'unknown')),
  source_row_id bigint NOT NULL REFERENCES raw.source_row(id)
);

CREATE TABLE IF NOT EXISTS core.lot_cost_component (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_key text NOT NULL UNIQUE,
  lot_id bigint NOT NULL REFERENCES core.lot(id),
  component_code text NOT NULL CHECK (component_code IN ('PURCHASE_PRICE', 'ROYALTY', 'DMF', 'NMET', 'INWARD_TRANSPORT', 'HANDLING', 'PROCESSING', 'REPORTED_LANDED_COST')),
  rate_inr_per_mt numeric(18,4) CHECK (rate_inr_per_mt >= 0),
  amount_inr numeric(18,2) CHECK (amount_inr >= 0),
  effective_on date NOT NULL,
  included_in_landed_cost boolean NOT NULL DEFAULT false,
  approval_status text NOT NULL DEFAULT 'reported' CHECK (approval_status IN ('reported', 'approved', 'rejected')),
  approved_by text,
  source_row_id bigint REFERENCES raw.source_row(id),
  CHECK (num_nonnulls(rate_inr_per_mt, amount_inr) >= 1)
);

CREATE TABLE IF NOT EXISTS core.payment_allocation (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payment_allocation_id text NOT NULL UNIQUE,
  payment_reference text NOT NULL,
  payment_date date NOT NULL,
  purchase_lot_id bigint NOT NULL REFERENCES core.purchase_lot(id),
  invoice_reference text,
  obligation_amount_inr numeric(18,2) NOT NULL CHECK (obligation_amount_inr >= 0),
  allocated_paid_amount_inr numeric(18,2) NOT NULL CHECK (allocated_paid_amount_inr >= 0),
  status text NOT NULL CHECK (status IN ('unpaid', 'partly_paid', 'paid', 'returned', 'disputed', 'unknown')),
  source_row_id bigint NOT NULL REFERENCES raw.source_row(id),
  CHECK (allocated_paid_amount_inr <= obligation_amount_inr)
);

CREATE TABLE IF NOT EXISTS core.production_run (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_key text NOT NULL UNIQUE,
  run_date date NOT NULL,
  shift text,
  process text,
  plant_site_id bigint REFERENCES core.site(id),
  source_material_name text,
  reported_recovery_pct numeric(8,4),
  status text NOT NULL DEFAULT 'completed',
  source_row_id bigint NOT NULL REFERENCES raw.source_row(id)
);

CREATE TABLE IF NOT EXISTS core.production_input (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  production_run_id bigint NOT NULL REFERENCES core.production_run(id),
  lot_id bigint REFERENCES core.lot(id),
  quantity_mt numeric(18,3) NOT NULL CHECK (quantity_mt >= 0),
  source_row_id bigint NOT NULL REFERENCES raw.source_row(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_production_input
  ON core.production_input(production_run_id, COALESCE(lot_id, 0));

CREATE TABLE IF NOT EXISTS core.production_output (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  production_run_id bigint NOT NULL REFERENCES core.production_run(id),
  lot_id bigint REFERENCES core.lot(id),
  material_id bigint REFERENCES core.material(id),
  output_type text NOT NULL,
  quantity_mt numeric(18,3) NOT NULL CHECK (quantity_mt >= 0),
  source_row_id bigint NOT NULL REFERENCES raw.source_row(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_production_output
  ON core.production_output(production_run_id, output_type, COALESCE(lot_id, 0), COALESCE(material_id, 0));

CREATE TABLE IF NOT EXISTS core.quality_sample (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_key text NOT NULL UNIQUE,
  sample_at timestamptz NOT NULL,
  sample_stage text NOT NULL CHECK (sample_stage IN ('indicative', 'inward', 'third_party', 'stock_snapshot', 'production_input', 'production_output', 'dispatch', 'customer_claim')),
  lot_id bigint REFERENCES core.lot(id),
  source_lot_number text,
  inward_receipt_id bigint REFERENCES core.inward_receipt(id),
  dispatch_id bigint REFERENCES core.dispatch(id),
  production_run_id bigint REFERENCES core.production_run(id),
  represented_quantity_mt numeric(18,3) CHECK (represented_quantity_mt >= 0),
  laboratory_id bigint REFERENCES core.organization(id),
  fe_pct numeric(12,5) CHECK (fe_pct BETWEEN 0 AND 100),
  sio2_pct numeric(12,5) CHECK (sio2_pct BETWEEN 0 AND 100),
  al2o3_pct numeric(12,5) CHECK (al2o3_pct BETWEEN 0 AND 100),
  loi_pct numeric(12,5) CHECK (loi_pct BETWEEN 0 AND 100),
  p_pct numeric(12,5) CHECK (p_pct BETWEEN 0 AND 100),
  moisture_pct numeric(12,5) CHECK (moisture_pct BETWEEN 0 AND 100),
  mn_pct numeric(12,5) CHECK (mn_pct BETWEEN 0 AND 100),
  mass_balance_pct numeric(12,5) CHECK (mass_balance_pct BETWEEN 0 AND 100),
  approved boolean NOT NULL DEFAULT false,
  source_row_id bigint NOT NULL REFERENCES raw.source_row(id)
);

-- Decision and workflow (5 tables)

CREATE TABLE IF NOT EXISTS core.business_target (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  target_id text NOT NULL UNIQUE,
  metric_code text NOT NULL,
  scope_type text NOT NULL,
  scope_id text,
  period_start date NOT NULL,
  period_end date NOT NULL,
  target_value numeric(18,5) NOT NULL,
  minimum_value numeric(18,5),
  maximum_value numeric(18,5),
  warning_deviation numeric(18,5) CHECK (warning_deviation >= 0),
  critical_deviation numeric(18,5) CHECK (critical_deviation >= 0),
  unit text NOT NULL,
  approved_by text NOT NULL,
  approved_at timestamptz NOT NULL,
  active boolean NOT NULL DEFAULT true,
  source_row_id bigint REFERENCES raw.source_row(id),
  CHECK (period_end >= period_start)
);

CREATE TABLE IF NOT EXISTS core.plan (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_key text NOT NULL UNIQUE,
  plan_type text NOT NULL CHECK (plan_type IN ('blend', 'production', 'dispatch', 'purchase')),
  version integer NOT NULL CHECK (version > 0),
  created_by text NOT NULL,
  period_start date,
  period_end date,
  objective text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'approved', 'rejected', 'superseded', 'completed')),
  calculation_rule_id bigint REFERENCES governance.calculation_rule(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end IS NULL OR period_start IS NULL OR period_end >= period_start),
  UNIQUE (plan_type, business_key, version)
);

CREATE TABLE IF NOT EXISTS core.plan_allocation (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plan_id bigint NOT NULL REFERENCES core.plan(id),
  lot_id bigint NOT NULL REFERENCES core.lot(id),
  sales_order_line_id bigint REFERENCES core.sales_order_line(id),
  selected_quantity_mt numeric(18,3) NOT NULL CHECK (selected_quantity_mt > 0),
  reservation_state text NOT NULL DEFAULT 'proposed' CHECK (reservation_state IN ('proposed', 'active', 'released', 'consumed')),
  reserved_at timestamptz,
  released_at timestamptz,
  UNIQUE (plan_id, lot_id, sales_order_line_id),
  CHECK (released_at IS NULL OR reserved_at IS NULL OR released_at >= reserved_at)
);

CREATE TABLE IF NOT EXISTS core.plan_approval (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plan_id bigint NOT NULL REFERENCES core.plan(id),
  action text NOT NULL CHECK (action IN ('submitted', 'approved', 'rejected', 'reopened')),
  actor text NOT NULL,
  acted_at timestamptz NOT NULL DEFAULT now(),
  remarks text
);

CREATE TABLE IF NOT EXISTS core.alert_event (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  target_id bigint REFERENCES core.business_target(id),
  metric_code text NOT NULL,
  scope_type text NOT NULL,
  scope_id text,
  actual_value numeric(18,5),
  expected_value numeric(18,5),
  deviation_value numeric(18,5),
  severity text NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

-- Draft formulas must be approved with the client before an answer is Verified.

INSERT INTO governance.calculation_rule (code, version, definition, status) VALUES
  ('STOCK_BALANCE', 1, 'Opening + inward - outward - production feed + finished production, subject to approved adjustments.', 'draft'),
  ('WEIGHTED_QUALITY', 1, 'Sum of available quantity multiplied by approved quality, divided by quantity covered by approved quality.', 'draft'),
  ('PRODUCTION_RECOVERY', 1, 'Approved recovered output quantity divided by feed quantity, multiplied by 100.', 'draft'),
  ('LANDED_COST', 1, 'Purchase price + Royalty + DMF + NMET + approved inward transport and other approved components.', 'draft')
ON CONFLICT (code, version) DO UPDATE SET definition = EXCLUDED.definition;

-- Provenance and open issues live with governance rather than business analytics.

CREATE OR REPLACE VIEW governance.source_provenance AS
SELECT
  sr.id AS source_row_id,
  sf.relative_path AS workbook_path,
  sf.file_name AS workbook_name,
  sr.sheet_name,
  sr.row_number,
  sf.file_hash,
  sf.received_at,
  sr.row_hash
FROM raw.source_row sr
JOIN governance.source_file sf ON sf.id = sr.source_file_id;

CREATE OR REPLACE VIEW governance.open_data_issues AS
SELECT di.*
FROM governance.data_issue di
WHERE di.resolved_at IS NULL;

-- Nine approved read models for dashboards, deterministic services and Ask kejAI.

CREATE OR REPLACE VIEW analytics.current_lot_inventory AS
SELECT
  l.id AS lot_id,
  l.kej_lot_number,
  m.material_code,
  m.mineral,
  m.category,
  m.size_spec,
  COALESCE(SUM(CASE im.direction WHEN 'in' THEN im.quantity_mt ELSE -im.quantity_mt END), 0)::numeric(18,3) AS physical_quantity_mt,
  count(im.id)::integer AS movement_count,
  MAX(im.occurred_at) AS last_movement_at,
  MAX(im.source_row_id) AS latest_source_row_id
FROM core.lot l
JOIN core.material m ON m.id = l.material_id
LEFT JOIN core.inventory_movement im ON im.lot_id = l.id
GROUP BY l.id, l.kej_lot_number, m.material_code, m.mineral, m.category, m.size_spec;

CREATE OR REPLACE VIEW analytics.lot_availability AS
SELECT
  ci.*,
  COALESCE(r.reserved_quantity_mt, 0)::numeric(18,3) AS reserved_quantity_mt,
  (ci.physical_quantity_mt - COALESCE(r.reserved_quantity_mt, 0))::numeric(18,3) AS available_quantity_mt
FROM analytics.current_lot_inventory ci
LEFT JOIN (
  SELECT lot_id, SUM(selected_quantity_mt)::numeric(18,3) AS reserved_quantity_mt
  FROM core.plan_allocation
  WHERE reservation_state = 'active'
  GROUP BY lot_id
) r ON r.lot_id = ci.lot_id;

CREATE OR REPLACE VIEW analytics.stock_quality_cost AS
WITH latest_quality AS (
  SELECT DISTINCT ON (lot_id) lot_id, fe_pct, approved, source_row_id
  FROM core.quality_sample
  WHERE lot_id IS NOT NULL AND fe_pct IS NOT NULL
  ORDER BY lot_id, approved DESC, sample_at DESC, id DESC
), latest_snapshot AS (
  SELECT lot_id, recorded_quantity_mt, reported_fe_pct, reported_landed_cost_inr_per_mt, source_row_id
  FROM core.stock_snapshot
  WHERE snapshot_at = (SELECT MAX(snapshot_at) FROM core.stock_snapshot)
), latest_component AS (
  SELECT DISTINCT ON (lot_id, component_code)
    lot_id, component_code, rate_inr_per_mt, included_in_landed_cost, approval_status
  FROM core.lot_cost_component
  WHERE rate_inr_per_mt IS NOT NULL
  ORDER BY lot_id, component_code, effective_on DESC, id DESC
), costs AS (
  SELECT
    lot_id,
    COALESCE(
      SUM(rate_inr_per_mt) FILTER (WHERE included_in_landed_cost AND approval_status = 'approved'),
      MAX(rate_inr_per_mt) FILTER (WHERE component_code = 'REPORTED_LANDED_COST')
    ) AS landed_cost_inr_per_mt,
    CASE
      WHEN count(*) FILTER (WHERE included_in_landed_cost AND approval_status = 'approved') > 0 THEN 'approved'
      WHEN count(*) FILTER (WHERE component_code = 'REPORTED_LANDED_COST') > 0 THEN 'reported'
      ELSE 'missing'
    END AS cost_status
  FROM latest_component
  GROUP BY lot_id
), lot_position AS (
  SELECT
    ls.lot_id,
    m.category,
    ls.recorded_quantity_mt AS available_quantity_mt,
    COALESCE(lq.fe_pct, ls.reported_fe_pct) AS fe_pct,
    CASE WHEN lq.approved THEN 'approved' WHEN ls.reported_fe_pct IS NOT NULL THEN 'reported' ELSE 'missing' END AS quality_status,
    COALESCE(c.landed_cost_inr_per_mt, ls.reported_landed_cost_inr_per_mt) AS landed_cost_inr_per_mt,
    COALESCE(c.cost_status, CASE WHEN ls.reported_landed_cost_inr_per_mt IS NULL THEN 'missing' ELSE 'reported' END) AS cost_status
  FROM latest_snapshot ls
  JOIN core.lot l ON l.id = ls.lot_id
  JOIN core.material m ON m.id = l.material_id
  LEFT JOIN latest_quality lq ON lq.lot_id = ls.lot_id
  LEFT JOIN costs c ON c.lot_id = ls.lot_id
  WHERE ls.recorded_quantity_mt > 0
)
SELECT
  category,
  SUM(available_quantity_mt)::numeric(18,3) AS total_quantity_mt,
  SUM(available_quantity_mt) FILTER (WHERE fe_pct IS NOT NULL)::numeric(18,3) AS quality_covered_quantity_mt,
  (SUM(available_quantity_mt * fe_pct) FILTER (WHERE fe_pct IS NOT NULL)
    / NULLIF(SUM(available_quantity_mt) FILTER (WHERE fe_pct IS NOT NULL), 0))::numeric(12,5) AS weighted_fe_pct,
  SUM(available_quantity_mt) FILTER (WHERE landed_cost_inr_per_mt IS NOT NULL)::numeric(18,3) AS cost_covered_quantity_mt,
  (SUM(available_quantity_mt * landed_cost_inr_per_mt) FILTER (WHERE landed_cost_inr_per_mt IS NOT NULL)
    / NULLIF(SUM(available_quantity_mt) FILTER (WHERE landed_cost_inr_per_mt IS NOT NULL), 0))::numeric(18,4) AS weighted_landed_cost_inr_per_mt,
  CASE
    WHEN bool_and(quality_status = 'approved') AND bool_and(cost_status = 'approved') THEN 'verified'
    WHEN bool_and(fe_pct IS NOT NULL) AND bool_and(landed_cost_inr_per_mt IS NOT NULL) THEN 'flagged'
    ELSE 'incomplete'
  END AS status
FROM lot_position
GROUP BY category;

CREATE OR REPLACE VIEW analytics.daily_customer_dispatch AS
SELECT
  d.dispatch_at::date AS business_date,
  d.customer_id,
  o.legal_name AS customer,
  SUM(d.quantity_mt)::numeric(18,3) AS dispatched_quantity_mt,
  count(*)::integer AS dispatch_count,
  count(*) FILTER (WHERE d.lot_id IS NULL)::integer AS rows_missing_lot
FROM core.dispatch d
JOIN core.organization o ON o.id = d.customer_id
GROUP BY d.dispatch_at::date, d.customer_id, o.legal_name;

CREATE OR REPLACE VIEW analytics.customer_monthly_activity AS
SELECT customer_id, customer, month, metric, SUM(quantity_mt)::numeric(18,3) AS quantity_mt
FROM (
  SELECT sol.customer_id, o.legal_name AS customer, date_trunc('month', sol.po_date)::date AS month,
    'ordered_from_kej'::text AS metric, sol.ordered_quantity_mt AS quantity_mt
  FROM core.sales_order_line sol JOIN core.organization o ON o.id = sol.customer_id
  UNION ALL
  SELECT d.customer_id, o.legal_name, date_trunc('month', d.dispatch_at)::date,
    'dispatched_by_kej', d.quantity_mt
  FROM core.dispatch d JOIN core.organization o ON o.id = d.customer_id
  UNION ALL
  SELECT aba.buyer_id, o.legal_name, date_trunc('month', COALESCE(aba.event_at, al.closes_at))::date,
    'external_auction_allocated', COALESCE(aba.allocated_quantity_mt, aba.bid_quantity_mt)
  FROM core.auction_bid_award aba
  JOIN core.auction_lot al ON al.id = aba.auction_lot_id
  JOIN core.organization o ON o.id = aba.buyer_id
) activity
WHERE month IS NOT NULL AND quantity_mt IS NOT NULL
GROUP BY customer_id, customer, month, metric;

CREATE OR REPLACE VIEW analytics.quality_deviation AS
SELECT
  inward.lot_id,
  COALESCE(l.kej_lot_number, inward.source_lot_number) AS kej_lot_number,
  'inbound_vs_indicative'::text AS comparison,
  indicative.fe_pct::numeric(12,5) AS expected_fe_pct,
  inward.fe_pct::numeric(12,5) AS actual_fe_pct,
  (inward.fe_pct - indicative.fe_pct)::numeric(12,5) AS deviation_fe_points,
  inward.source_row_id AS actual_source_row_id,
  indicative.source_row_id AS expected_source_row_id
FROM core.quality_sample inward
JOIN core.quality_sample indicative
  ON indicative.source_row_id = inward.source_row_id
  AND indicative.sample_stage = 'indicative'
LEFT JOIN core.lot l ON l.id = inward.lot_id
WHERE inward.sample_stage = 'inward'
  AND inward.fe_pct IS NOT NULL
  AND indicative.fe_pct IS NOT NULL
UNION ALL
SELECT
  d.lot_id,
  COALESCE(l.kej_lot_number, d.business_key) AS kej_lot_number,
  'dispatch_vs_order'::text AS comparison,
  sol.target_fe_pct::numeric(12,5) AS expected_fe_pct,
  dispatched.fe_pct::numeric(12,5) AS actual_fe_pct,
  (dispatched.fe_pct - sol.target_fe_pct)::numeric(12,5) AS deviation_fe_points,
  dispatched.source_row_id AS actual_source_row_id,
  sol.source_row_id AS expected_source_row_id
FROM core.quality_sample dispatched
JOIN core.dispatch d ON d.id = dispatched.dispatch_id
JOIN core.sales_order_line sol ON sol.id = d.sales_order_line_id
LEFT JOIN core.lot l ON l.id = d.lot_id
WHERE dispatched.sample_stage = 'dispatch'
  AND dispatched.fe_pct IS NOT NULL
  AND sol.target_fe_pct IS NOT NULL;

CREATE OR REPLACE VIEW analytics.production_recovery AS
SELECT
  pr.id AS production_run_id,
  pr.run_date,
  pr.shift,
  pr.process,
  COALESCE(i.feed_quantity_mt, 0)::numeric(18,3) AS feed_quantity_mt,
  COALESCE(o.recovered_quantity_mt, 0)::numeric(18,3) AS recovered_quantity_mt,
  COALESCE(o.tailings_quantity_mt, 0)::numeric(18,3) AS tailings_quantity_mt,
  (100 * COALESCE(o.recovered_quantity_mt, 0) / NULLIF(i.feed_quantity_mt, 0))::numeric(12,5) AS calculated_recovery_pct,
  pr.reported_recovery_pct,
  pr.source_row_id
FROM core.production_run pr
LEFT JOIN (
  SELECT production_run_id, SUM(quantity_mt) AS feed_quantity_mt
  FROM core.production_input GROUP BY production_run_id
) i ON i.production_run_id = pr.id
LEFT JOIN (
  SELECT production_run_id,
    SUM(quantity_mt) FILTER (WHERE output_type = 'recovered_total') AS recovered_quantity_mt,
    SUM(quantity_mt) FILTER (WHERE output_type = 'tailings') AS tailings_quantity_mt
  FROM core.production_output GROUP BY production_run_id
) o ON o.production_run_id = pr.id;

CREATE OR REPLACE VIEW analytics.target_drift AS
SELECT
  bt.target_id,
  bt.metric_code,
  bt.scope_type,
  bt.scope_id,
  bt.period_start,
  bt.period_end,
  bt.target_value,
  ae.actual_value,
  ae.deviation_value,
  ae.severity,
  ae.status,
  ae.detected_at
FROM core.business_target bt
LEFT JOIN LATERAL (
  SELECT alert.* FROM core.alert_event alert
  WHERE alert.target_id = bt.id
  ORDER BY alert.detected_at DESC, alert.id DESC LIMIT 1
) ae ON true
WHERE bt.active;

CREATE OR REPLACE VIEW analytics.answer_readiness AS
WITH latest_run AS (
  SELECT id FROM governance.import_run WHERE status = 'completed' ORDER BY id DESC LIMIT 1
), issues AS (
  SELECT di.* FROM governance.data_issue di JOIN latest_run lr ON lr.id = di.import_run_id
  WHERE di.resolved_at IS NULL
)
SELECT
  CASE
    WHEN count(*) FILTER (WHERE severity = 'critical') > 0 THEN 'incomplete'
    WHEN count(*) FILTER (WHERE severity = 'warning') > 0 THEN 'flagged'
    ELSE 'verified'
  END AS status,
  count(*) FILTER (WHERE severity = 'critical')::integer AS critical_issues,
  count(*) FILTER (WHERE severity = 'warning')::integer AS warnings,
  count(*) FILTER (WHERE severity = 'info')::integer AS informational_issues
FROM issues;

CREATE OR REPLACE VIEW analytics.transporter_work_order_activity AS
SELECT
  sr.id AS source_row_id,
  sr.raw_data->>0 AS work_order_number,
  sr.raw_data->>2 AS work_order_date_text,
  btrim(sr.raw_data->>5) AS transporter,
  btrim(sr.raw_data->>7) AS mine,
  sr.raw_data->>8 AS quantity_text,
  CASE
    WHEN sr.raw_data->>8 ~ '^\s*[0-9]+(?:\.[0-9]+)?(?:\s*\+\s*[0-9]+(?:\.[0-9]+)?)*\s*$'
      THEN (SELECT sum(part::numeric) FROM regexp_split_to_table(sr.raw_data->>8, '\s*\+\s*') part)
    ELSE NULL
  END::numeric(18,3) AS awarded_quantity_mt,
  sr.raw_data->>9 AS source_lot_text,
  sr.raw_data->>11 AS rate_text
FROM raw.source_row sr
JOIN governance.source_file sf ON sf.id = sr.source_file_id
WHERE sf.import_run_id = (SELECT id FROM governance.import_run WHERE status = 'completed' ORDER BY id DESC LIMIT 1)
  AND sf.file_name = 'INWARD TRANSPORTER -WORK ORDER FILE-CONTROL SHEET FORMAT.xlsm'
  AND sr.sheet_name = 'INWARD FINAL 26-27'
  AND sr.row_number > 2
  AND nullif(btrim(sr.raw_data->>5), '') IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kejai_agent_reader') THEN
    CREATE ROLE kejai_agent_reader NOLOGIN;
  END IF;
END $$;
GRANT kejai_agent_reader TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
GRANT USAGE ON SCHEMA core, analytics TO kejai_agent_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA core, analytics TO kejai_agent_reader;

COMMIT;
