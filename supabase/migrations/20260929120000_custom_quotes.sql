-- ============================================================================
-- Custom Quotes — intake → partner bids → final quote → PDF emailed to rep
-- ----------------------------------------------------------------------------
-- Sales reps submit requests through the public /intake page (no login). We
-- don't have a service-role key in the dashboard env, so anon never touches
-- the tables directly: intake goes through submit_quote_request(), a
-- SECURITY DEFINER function granted to anon. Everything else (costs,
-- margins, partners) is authenticated-only via RLS.
-- ============================================================================

-- ─── quote numbers ──────────────────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS quote_number_seq START WITH 69420;

-- ─── requests ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS quote_requests (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  quote_number  integer NOT NULL UNIQUE DEFAULT nextval('quote_number_seq'),
  quote_code    text GENERATED ALWAYS AS ('Q-' || quote_number::text) STORED,
  status        text NOT NULL DEFAULT 'new'
                CHECK (status IN ('new','rfq_sent','bids_in','awarded','quote_sent','won','lost','cancelled')),
  revision      text NOT NULL DEFAULT 'A',
  rep_name      text NOT NULL,
  rep_email     text NOT NULL CHECK (rep_email ~* '^[^@\s]+@growmail\.com$'),
  customer_name text NOT NULL,
  product_type  text NOT NULL,
  quantities    integer[] NOT NULL CHECK (cardinality(quantities) BETWEEN 1 AND 2),
  specs         jsonb NOT NULL DEFAULT '{}'::jsonb,  -- keyed by field id in lib/quoteSpecs.js
  artwork_ready_date date,
  in_home_date  date,
  notes         text,
  lost_reason   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
ALTER SEQUENCE quote_number_seq OWNED BY quote_requests.quote_number;
CREATE INDEX IF NOT EXISTS quote_requests_status_idx ON quote_requests (status, created_at DESC);

CREATE TABLE IF NOT EXISTS quote_request_files (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id   bigint NOT NULL REFERENCES quote_requests(id) ON DELETE CASCADE,
  storage_path text NOT NULL,          -- in the quote-files bucket
  file_name    text NOT NULL,
  size_bytes   bigint,
  uploaded_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS quote_request_files_request_idx ON quote_request_files (request_id);

-- ─── partners + bids ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS partners (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name         text NOT NULL UNIQUE,
  contact_name text,
  email        text,
  phone        text,
  capabilities text[] NOT NULL DEFAULT '{}',
  notes        text,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS partner_bids (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id      bigint NOT NULL REFERENCES quote_requests(id) ON DELETE CASCADE,
  partner_id      bigint NOT NULL REFERENCES partners(id),
  revision        text NOT NULL DEFAULT 'A',
  received_at     date NOT NULL DEFAULT current_date,
  lead_time_days  integer,
  lead_time_text  text,              -- e.g. "8 business days from proof approval"
  valid_until     date,
  notes           text,
  attachment_path text,              -- partner's own quote PDF, quote-files bucket
  is_winner       boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS partner_bids_request_idx ON partner_bids (request_id);
-- one winner per request revision
CREATE UNIQUE INDEX IF NOT EXISTS partner_bids_one_winner
  ON partner_bids (request_id, revision) WHERE is_winner;

CREATE TABLE IF NOT EXISTS bid_lines (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bid_id      bigint NOT NULL REFERENCES partner_bids(id) ON DELETE CASCADE,
  quantity    integer NOT NULL,
  line_type   text NOT NULL CHECK (line_type IN ('print','data','lettershop','freight','other')),
  description text,
  setup_cost  numeric(12,2) NOT NULL DEFAULT 0,
  unit_cost   numeric(12,5) NOT NULL DEFAULT 0   -- per piece
);
CREATE INDEX IF NOT EXISTS bid_lines_bid_idx ON bid_lines (bid_id);

-- ─── final quote ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS quote_addon_presets (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  label         text NOT NULL UNIQUE,
  price_type    text NOT NULL DEFAULT 'flat' CHECK (price_type IN ('flat','per_piece','per_m')),
  default_price numeric(12,5),
  sort_order    integer NOT NULL DEFAULT 0,
  active        boolean NOT NULL DEFAULT true
);
INSERT INTO quote_addon_presets (label, price_type, sort_order) VALUES
  ('Mail Service Fee',     'flat', 10),
  ('Post Office Delivery', 'flat', 20),
  ('Design/Art Service',   'flat', 30)
ON CONFLICT (label) DO NOTHING;

-- Lines per final quantity. production = winning bid rolled up (cost + margin),
-- addon/custom = entered price with optional internal cost, postage = pass-through.
CREATE TABLE IF NOT EXISTS quote_line_items (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id  bigint NOT NULL REFERENCES quote_requests(id) ON DELETE CASCADE,
  revision    text NOT NULL DEFAULT 'A',
  quantity    integer NOT NULL,
  line_type   text NOT NULL CHECK (line_type IN ('production','addon','custom','postage')),
  label       text NOT NULL,
  price_type  text NOT NULL DEFAULT 'flat' CHECK (price_type IN ('flat','per_piece','per_m')),
  cost_rate   numeric(12,5),                -- internal; null = no tracked cost
  margin_pct  numeric(6,2),                 -- production only; sell = cost / (1 - margin)
  sell_rate   numeric(12,5) NOT NULL DEFAULT 0,
  sort_order  integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS quote_line_items_request_idx ON quote_line_items (request_id, revision, quantity);

CREATE TABLE IF NOT EXISTS quote_sends (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id  bigint NOT NULL REFERENCES quote_requests(id) ON DELETE CASCADE,
  revision    text NOT NULL,
  sent_by     text NOT NULL,
  sent_to     text NOT NULL,
  resend_id   text,
  pdf_path    text,
  totals      jsonb,
  sent_at     timestamptz NOT NULL DEFAULT now()
);

-- ─── RLS: authenticated only ────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['quote_requests','quote_request_files','partners','partner_bids',
                           'bid_lines','quote_addon_presets','quote_line_items','quote_sends']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_authenticated_all', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO authenticated USING (true) WITH CHECK (true)',
                   t || '_authenticated_all', t);
  END LOOP;
END $$;

-- ─── public intake ──────────────────────────────────────────────────────────
-- p: { rep_name, rep_email, customer_name, product_type, quantities[], specs{},
--      artwork_ready_date, in_home_date, notes, files[{path,name,size}] }
CREATE OR REPLACE FUNCTION submit_quote_request(p jsonb)
RETURNS TABLE (id bigint, quote_code text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_email text := lower(trim(p->>'rep_email'));
  v_qty   integer[];
  v_id    bigint;
  v_code  text;
  f       jsonb;
BEGIN
  IF v_email !~ '^[^@\s]+@growmail\.com$' THEN
    RAISE EXCEPTION 'Email must be an @growmail.com address';
  END IF;
  IF coalesce(trim(p->>'rep_name'), '') = '' OR coalesce(trim(p->>'customer_name'), '') = ''
     OR coalesce(trim(p->>'product_type'), '') = '' THEN
    RAISE EXCEPTION 'Name, customer and product type are required';
  END IF;

  SELECT array_agg(x::integer) INTO v_qty
  FROM jsonb_array_elements_text(coalesce(p->'quantities', '[]'::jsonb)) x
  WHERE x ~ '^\d+$' AND x::bigint > 0;
  IF v_qty IS NULL OR cardinality(v_qty) NOT BETWEEN 1 AND 2 THEN
    RAISE EXCEPTION 'Enter one or two quantities';
  END IF;

  -- flood guard: a single rep address can't file more than 10 an hour
  IF (SELECT count(*) FROM quote_requests r
      WHERE r.rep_email = v_email AND r.created_at > now() - interval '1 hour') >= 10 THEN
    RAISE EXCEPTION 'Too many requests — try again later';
  END IF;

  INSERT INTO quote_requests (rep_name, rep_email, customer_name, product_type, quantities,
                              specs, artwork_ready_date, in_home_date, notes)
  VALUES (left(trim(p->>'rep_name'), 200), v_email, left(trim(p->>'customer_name'), 300),
          left(p->>'product_type', 50), v_qty, coalesce(p->'specs', '{}'::jsonb),
          nullif(p->>'artwork_ready_date', '')::date, nullif(p->>'in_home_date', '')::date,
          left(p->>'notes', 5000))
  RETURNING quote_requests.id, quote_requests.quote_code INTO v_id, v_code;

  FOR f IN SELECT * FROM jsonb_array_elements(coalesce(p->'files', '[]'::jsonb)) LOOP
    -- only files the intake page uploaded to the anon-writable intake/ folder
    CONTINUE WHEN (f->>'path') IS NULL OR (f->>'path') !~ '^intake/[A-Za-z0-9._/-]+$';
    INSERT INTO quote_request_files (request_id, storage_path, file_name, size_bytes)
    VALUES (v_id, f->>'path', left(coalesce(f->>'name', f->>'path'), 300), nullif(f->>'size', '')::bigint);
  END LOOP;

  RETURN QUERY SELECT v_id, v_code;
END $$;

REVOKE ALL ON FUNCTION submit_quote_request(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION submit_quote_request(jsonb) TO anon, authenticated;

-- ─── storage ────────────────────────────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('quote-files', 'quote-files', false, 26214400)  -- 25 MB per file
ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public, file_size_limit = EXCLUDED.file_size_limit;

DROP POLICY IF EXISTS "quote_files_anon_intake_insert"   ON storage.objects;
DROP POLICY IF EXISTS "quote_files_select_authenticated" ON storage.objects;
DROP POLICY IF EXISTS "quote_files_insert_authenticated" ON storage.objects;
DROP POLICY IF EXISTS "quote_files_delete_authenticated" ON storage.objects;

-- Intake page (anon) may only add files under intake/; it can't list or read them.
CREATE POLICY "quote_files_anon_intake_insert"
  ON storage.objects FOR INSERT TO anon
  WITH CHECK (bucket_id = 'quote-files' AND (storage.foldername(name))[1] = 'intake');

CREATE POLICY "quote_files_select_authenticated"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'quote-files');

CREATE POLICY "quote_files_insert_authenticated"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'quote-files');

CREATE POLICY "quote_files_delete_authenticated"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'quote-files');
