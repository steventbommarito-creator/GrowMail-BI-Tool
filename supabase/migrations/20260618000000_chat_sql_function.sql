-- ============================================================================
-- exec_chat_sql — read-only SQL executor for the AI chat agent
-- ----------------------------------------------------------------------------
-- The chat agent (gpt-4o-mini) generates SELECT queries against our schema
-- and we need to run them safely. This function:
--   1. Runs in a READ ONLY transaction (so even if a malicious query somehow
--      slips through the application-layer SELECT-only check, Postgres
--      itself blocks any DML/DDL)
--   2. Wraps the result in jsonb so we get a clean array back
--   3. Has a statement_timeout of 30s so a runaway query can't lock things
--   4. Is SECURITY DEFINER but ownership is the migration runner — callers
--      get exactly the privileges baked into this function, no more
--
-- Application-layer gates (in /api/chat/route.js):
--   - Email check (steveb@growmail.com only for now)
--   - Pattern check that the SQL starts with SELECT or WITH
--   - No semicolons (single-statement only)
-- The DB layer here is the belt-and-suspenders defense.
-- ============================================================================

CREATE OR REPLACE FUNCTION exec_chat_sql(p_sql text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET statement_timeout = '30s'
AS $$
DECLARE
  result jsonb;
BEGIN
  -- Enforce read-only at the transaction level. Any INSERT/UPDATE/DELETE/DDL
  -- inside p_sql throws "cannot execute X in a read-only transaction".
  SET LOCAL transaction_read_only = on;

  -- Wrap the user query in a jsonb_agg so we always return a JSON array,
  -- regardless of column shapes. COALESCE keeps a no-row result as [] not null.
  EXECUTE format('SELECT COALESCE(jsonb_agg(_chat_t), ''[]''::jsonb) FROM (%s) _chat_t', p_sql)
    INTO result;
  RETURN result;
END;
$$;

REVOKE EXECUTE ON FUNCTION exec_chat_sql(text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION exec_chat_sql(text) TO authenticated;
