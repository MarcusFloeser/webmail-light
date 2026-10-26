-- Idempotentes Schema; wird bei jedem Start ausgeführt.

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL DEFAULT '',
  is_admin      BOOLEAN NOT NULL DEFAULT false,
  settings      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_agent  TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS persistent BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS mail_accounts (
  id                 SERIAL PRIMARY KEY,
  user_id            INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  email              TEXT NOT NULL,
  imap_host          TEXT NOT NULL,
  imap_port          INT  NOT NULL DEFAULT 993,
  imap_security      TEXT NOT NULL DEFAULT 'ssl',      -- ssl | starttls | none
  imap_user          TEXT NOT NULL,
  imap_pass          TEXT NOT NULL,                    -- verschlüsselt
  smtp_host          TEXT NOT NULL,
  smtp_port          INT  NOT NULL DEFAULT 465,
  smtp_security      TEXT NOT NULL DEFAULT 'ssl',
  smtp_user          TEXT NOT NULL DEFAULT '',
  smtp_pass          TEXT NOT NULL DEFAULT '',         -- verschlüsselt
  allow_insecure_tls BOOLEAN NOT NULL DEFAULT false,
  save_sent          BOOLEAN NOT NULL DEFAULT true,
  enabled            BOOLEAN NOT NULL DEFAULT true,
  color              TEXT NOT NULL DEFAULT '#3b6fd8',
  sort_order         INT  NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'pending',  -- pending | syncing | ok | error
  last_error         TEXT,
  last_sync          TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mail_accounts_user_idx ON mail_accounts(user_id);

CREATE TABLE IF NOT EXISTS identities (
  id          SERIAL PRIMARY KEY,
  account_id  INT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  name        TEXT NOT NULL DEFAULT '',
  email       TEXT NOT NULL,
  reply_to    TEXT NOT NULL DEFAULT '',
  bcc         TEXT NOT NULL DEFAULT '',
  signature   TEXT NOT NULL DEFAULT '',  -- HTML
  is_default  BOOLEAN NOT NULL DEFAULT false,
  sort_order  INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS identities_account_idx ON identities(account_id);

CREATE TABLE IF NOT EXISTS folders (
  id             SERIAL PRIMARY KEY,
  account_id     INT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  path           TEXT NOT NULL,
  name           TEXT NOT NULL,
  delimiter      TEXT,
  parent_path    TEXT,
  special_use    TEXT,
  selectable     BOOLEAN NOT NULL DEFAULT true,
  subscribed     BOOLEAN NOT NULL DEFAULT true,
  uidvalidity    BIGINT,
  uidnext        BIGINT,
  highestmodseq  BIGINT,
  min_synced_uid BIGINT,
  total          INT NOT NULL DEFAULT 0,
  unseen         INT NOT NULL DEFAULT 0,
  last_sync      TIMESTAMPTZ,
  UNIQUE (account_id, path)
);

CREATE SEQUENCE IF NOT EXISTS thread_seq;

CREATE TABLE IF NOT EXISTS messages (
  id              BIGSERIAL PRIMARY KEY,
  account_id      INT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  folder_id       INT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  uid             BIGINT NOT NULL,
  message_id      TEXT,
  in_reply_to     TEXT,
  refs            TEXT[] NOT NULL DEFAULT '{}',
  thread_id       BIGINT NOT NULL,
  subject         TEXT NOT NULL DEFAULT '',
  from_name       TEXT NOT NULL DEFAULT '',
  from_addr       TEXT NOT NULL DEFAULT '',
  to_list         JSONB NOT NULL DEFAULT '[]'::jsonb,
  cc_list         JSONB NOT NULL DEFAULT '[]'::jsonb,
  date            TIMESTAMPTZ,
  flags           TEXT[] NOT NULL DEFAULT '{}',
  size            INT NOT NULL DEFAULT 0,
  has_attachments BOOLEAN NOT NULL DEFAULT false,
  preview         TEXT,
  UNIQUE (folder_id, uid)
);
CREATE INDEX IF NOT EXISTS messages_msgid_idx   ON messages(account_id, message_id);
CREATE INDEX IF NOT EXISTS messages_irt_idx     ON messages(account_id, in_reply_to);
CREATE INDEX IF NOT EXISTS messages_refs_idx    ON messages USING GIN (refs);
CREATE INDEX IF NOT EXISTS messages_thread_idx  ON messages(thread_id);
CREATE INDEX IF NOT EXISTS messages_folder_date ON messages(folder_id, date DESC);
CREATE INDEX IF NOT EXISTS messages_from_idx    ON messages(account_id, from_addr);

-- CalDAV/CardDAV-Server des Benutzers
CREATE TABLE IF NOT EXISTS dav_sources (
  id          SERIAL PRIMARY KEY,
  user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  url         TEXT NOT NULL,
  username    TEXT NOT NULL DEFAULT '',
  password    TEXT NOT NULL DEFAULT '',   -- verschlüsselt
  allow_insecure_tls BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dav_sources_user_idx ON dav_sources(user_id);

-- v2: Anmeldung über IMAP
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_source TEXT NOT NULL DEFAULT 'local';  -- local | imap

-- v3: Passwort vergessen (nur Hash des Tokens wird gespeichert)
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash  TEXT PRIMARY KEY,
  login       TEXT NOT NULL,
  dn          TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip          TEXT
);

-- Eigenes Hintergrundbild pro Benutzer (Base64, max. ~4 MB)
CREATE TABLE IF NOT EXISTS user_backgrounds (
  user_id     INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  mime        TEXT NOT NULL,
  data        TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
