-- Revoke access by disabling, never by deleting: audit_events keeps referencing the user.
ALTER TABLE admin_users ADD COLUMN disabled_at TIMESTAMPTZ;
