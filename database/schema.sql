BEGIN;

CREATE SCHEMA IF NOT EXISTS marc;
REVOKE ALL ON SCHEMA marc FROM PUBLIC;

CREATE TABLE IF NOT EXISTS marc.queue_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  max_proof_bytes bigint NOT NULL DEFAULT 402653184 CHECK (max_proof_bytes >= 4194304),
  checked_at timestamptz,
  cleaned_at timestamptz NOT NULL DEFAULT '-infinity'
);

INSERT INTO marc.queue_control (singleton) VALUES (true) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS marc.order_queue (
  queue_key text PRIMARY KEY CHECK (queue_key ~ '^[a-f0-9]{64}$'),
  order_id uuid NOT NULL,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  metadata text,
  proof bytea,
  proof_bytes integer GENERATED ALWAYS AS (COALESCE(octet_length(proof), 0)) STORED,
  order_number text,
  result jsonb,
  completed_at timestamptz,
  CHECK (
    (completed_at IS NULL AND result IS NULL AND metadata IS NOT NULL AND proof_bytes BETWEEN 1 AND 4194304)
    OR
    (completed_at IS NOT NULL AND result IS NOT NULL AND metadata IS NULL AND proof IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS marc_pending_orders
  ON marc.order_queue (queue_key) INCLUDE (proof_bytes) WHERE completed_at IS NULL;
CREATE INDEX IF NOT EXISTS marc_completed_orders
  ON marc.order_queue (completed_at) WHERE completed_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS marc.account_state (
  kind text NOT NULL CHECK (kind IN ('session', 'bag')),
  owner text NOT NULL CHECK (owner ~ '^[a-f0-9]{64}$'),
  version uuid NOT NULL,
  value jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (kind, owner)
);

CREATE INDEX IF NOT EXISTS marc_account_expiry ON marc.account_state (expires_at);

CREATE OR REPLACE FUNCTION marc.enqueue_order(
  p_key text, p_id uuid, p_fingerprint text, p_metadata text, p_proof bytea
)
RETURNS TABLE (disposition text, number text, receipt jsonb)
LANGUAGE plpgsql
SET search_path = pg_catalog, marc
AS $$
DECLARE
  existing marc.order_queue%ROWTYPE;
  queue_limit bigint;
  used_bytes bigint;
BEGIN
  -- Serialize new admissions so concurrent requests share the same byte budget.
  SELECT max_proof_bytes INTO STRICT queue_limit FROM marc.queue_control WHERE singleton FOR UPDATE;
  SELECT queue_key, fingerprint, order_number, result
    INTO existing.queue_key, existing.fingerprint, existing.order_number, existing.result
    FROM marc.order_queue WHERE queue_key = p_key;
  IF FOUND THEN
    IF existing.fingerprint <> p_fingerprint THEN
      RETURN QUERY SELECT 'different'::text, NULL::text, NULL::jsonb;
    ELSE
      RETURN QUERY SELECT 'existing'::text, existing.order_number, existing.result;
    END IF;
    RETURN;
  END IF;

  SELECT COALESCE(SUM(proof_bytes), 0) INTO used_bytes FROM marc.order_queue WHERE completed_at IS NULL;
  IF used_bytes + octet_length(p_proof) > queue_limit THEN
    RETURN QUERY SELECT 'full'::text, NULL::text, NULL::jsonb;
    RETURN;
  END IF;
  INSERT INTO marc.order_queue (queue_key, order_id, fingerprint, metadata, proof)
    VALUES (p_key, p_id, p_fingerprint, p_metadata, p_proof);
  RETURN QUERY SELECT 'queued'::text, NULL::text, NULL::jsonb;
END
$$;
REVOKE ALL ON FUNCTION marc.enqueue_order(text, uuid, text, text, bytea) FROM PUBLIC;

COMMIT;
