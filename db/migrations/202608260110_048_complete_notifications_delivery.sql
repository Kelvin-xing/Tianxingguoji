ALTER TABLE notifications_notifications
  ADD COLUMN IF NOT EXISTS read_at timestamptz,
  ADD COLUMN IF NOT EXISTS target_kind text,
  ADD COLUMN IF NOT EXISTS target_opaque_id text,
  ADD COLUMN IF NOT EXISTS target_action text;

ALTER TABLE notifications_notifications
  DROP CONSTRAINT IF EXISTS notifications_notifications_status_check;

ALTER TABLE notifications_notifications
  ADD CONSTRAINT notifications_notifications_status_check CHECK (status IN ('unread', 'read', 'suppressed'));

ALTER TABLE notifications_delivery_receipts
  ADD COLUMN IF NOT EXISTS recipient_user_id uuid;

UPDATE notifications_delivery_receipts AS receipt
   SET recipient_user_id = notification.recipient_user_id
  FROM notifications_notifications AS notification
 WHERE receipt.notification_id = notification.id
   AND receipt.organization_id = notification.organization_id
   AND receipt.recipient_user_id IS NULL;

ALTER TABLE notifications_delivery_receipts
  ALTER COLUMN notification_id DROP NOT NULL,
  ALTER COLUMN recipient_user_id SET NOT NULL;

ALTER TABLE notifications_delivery_receipts
  DROP CONSTRAINT IF EXISTS notifications_delivery_receipts_notification_fk;

ALTER TABLE notifications_delivery_receipts
  ADD CONSTRAINT notifications_delivery_receipts_notification_fk FOREIGN KEY (
    notification_id,
    organization_id
  ) REFERENCES notifications_notifications (id, organization_id);

ALTER TABLE notifications_delivery_receipts
  DROP CONSTRAINT IF EXISTS notifications_delivery_receipts_outcome_check;

ALTER TABLE notifications_delivery_receipts
  ADD CONSTRAINT notifications_delivery_receipts_outcome_check CHECK (
    outcome IN ('delivered', 'failed', 'compensated')
  );

CREATE INDEX IF NOT EXISTS notifications_notifications_recipient_created_idx
  ON notifications_notifications (organization_id, recipient_user_id, created_at DESC)
  WHERE status IN ('unread', 'read');

CREATE OR REPLACE FUNCTION notifications_validate_delivery_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  notification_row record;
BEGIN
  IF NEW.notification_id IS NOT NULL THEN
    SELECT effect_type, effect_idempotency_key, outbox_id, recipient_user_id
      INTO notification_row
      FROM notifications_notifications
     WHERE id = NEW.notification_id
       AND organization_id = NEW.organization_id;
    IF NOT FOUND
       OR notification_row.effect_type IS DISTINCT FROM NEW.effect_type
       OR notification_row.effect_idempotency_key IS DISTINCT FROM NEW.effect_idempotency_key
       OR notification_row.outbox_id IS DISTINCT FROM NEW.outbox_id
       OR notification_row.recipient_user_id IS DISTINCT FROM NEW.recipient_user_id THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'notifications_delivery_context_check',
        MESSAGE = 'delivery receipt must match the notification effect';
    END IF;
  ELSIF NEW.outcome NOT IN ('compensated', 'failed') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'notifications_delivery_context_check',
      MESSAGE = 'delivered delivery receipt requires a notification';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.record_version <> 1 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'notifications_delivery_receipts_initial_version_check',
        MESSAGE = 'delivery receipt must begin at record_version one';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.outbox_id IS DISTINCT FROM OLD.outbox_id
     OR NEW.notification_id IS DISTINCT FROM OLD.notification_id
     OR NEW.recipient_user_id IS DISTINCT FROM OLD.recipient_user_id
     OR NEW.effect_type IS DISTINCT FROM OLD.effect_type
     OR NEW.effect_idempotency_key IS DISTINCT FROM OLD.effect_idempotency_key
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'notifications_delivery_identity_immutable_check',
      MESSAGE = 'delivery effect identity is immutable';
  END IF;
  IF NEW.record_version <> OLD.record_version + 1 OR NEW.attempt_count < OLD.attempt_count THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'notifications_delivery_version_transition_check',
      MESSAGE = 'delivery receipt version and attempts must be monotonic';
  END IF;
  IF OLD.outcome = 'compensated'
     OR (OLD.outcome = 'delivered' AND NEW.outcome = 'failed') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'notifications_delivery_terminal_state_check',
      MESSAGE = 'delivery receipt outcome cannot regress';
  END IF;
  RETURN NEW;
END;
$$;
