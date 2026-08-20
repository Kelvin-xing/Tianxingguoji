CREATE TABLE identity_invite_delivery_receipts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES access_organizations (id),
  invite_id uuid NOT NULL REFERENCES identity_invites (id),
  channel_policy_id text NOT NULL,
  receipt_reference text NOT NULL,
  delivered_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT identity_invite_delivery_receipts_channel_policy_check CHECK (
    channel_policy_id = 'hk_dpa_reviewed_transactional'
  ),
  CONSTRAINT identity_invite_delivery_receipts_reference_check CHECK (
    receipt_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT identity_invite_delivery_receipts_invite_key UNIQUE (invite_id)
);

REVOKE ALL ON TABLE identity_invite_delivery_receipts FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE identity_invite_delivery_receipts TO tianxing_app;
ALTER TABLE identity_invite_delivery_receipts ENABLE ROW LEVEL SECURITY;
CREATE POLICY tianxing_tenant_boundary ON identity_invite_delivery_receipts
  FOR ALL TO tianxing_app
  USING (organization_id::text = current_setting('app.organization_id', true))
  WITH CHECK (organization_id::text = current_setting('app.organization_id', true));
