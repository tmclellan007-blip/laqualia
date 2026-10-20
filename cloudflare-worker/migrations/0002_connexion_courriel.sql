-- Connexion par code à usage unique envoyé par courriel (sans mot de passe).
-- SQLite ne permet pas de modifier une contrainte CHECK : la table identities est reconstruite à l'identique,
-- avec le fournisseur « email » en plus. Rien d'autre ne référence cette table.
CREATE TABLE identities_v2 (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google','apple','email')),
  subject TEXT NOT NULL,
  email TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0,
  is_private_email INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER,
  UNIQUE (provider, subject)
);
INSERT INTO identities_v2 (id, user_id, provider, subject, email, email_verified, is_private_email, created_at, last_login_at)
  SELECT id, user_id, provider, subject, email, email_verified, is_private_email, created_at, last_login_at FROM identities;
DROP TABLE identities;
ALTER TABLE identities_v2 RENAME TO identities;
CREATE INDEX idx_identities_user ON identities(user_id);

-- Codes de connexion : le navigateur garde un jeton secret (témoin) ; la base ne garde que des empreintes.
-- id_hash = SHA-256(jeton) ; code_hash = SHA-256(jeton + code). Sans le témoin, une fuite de la base ne permet pas de deviner le code.
CREATE TABLE email_codes (
  id_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('login','link','recovery')),
  next_path TEXT,
  link_user_id TEXT,
  recovery_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_email_codes_email ON email_codes(email);
