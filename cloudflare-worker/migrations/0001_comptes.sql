-- Module Comptes, établissements et permissions (Cloudflare D1 / SQLite)
-- Identifiants : texte aléatoire (UUID). Dates : millisecondes depuis l'époque Unix.


-- Utilisateurs : profil seulement. Aucun secret ici.
CREATE TABLE users (
  id               TEXT PRIMARY KEY,
  first_name       TEXT,
  last_name        TEXT,
  photo            TEXT,                     -- URL https ou image redimensionnée (data:image/jpeg) ≤ 80 Ko
  locale           TEXT NOT NULL DEFAULT 'fr-CA',
  job_title        TEXT,                     -- fonction affichée dans le profil (texte libre)
  notif_prefs      TEXT NOT NULL DEFAULT '{"invitations":true,"roleChanges":true,"product":false}',
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','deactivated','suspended')),
  platform_admin   INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

-- Moyens de connexion. Le compte est identifié par (fournisseur, identifiant vérifié « sub »),
-- jamais par l'adresse courriel : deux identités avec la même adresse ne sont jamais fusionnées.
CREATE TABLE identities (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider         TEXT NOT NULL CHECK (provider IN ('google','apple')),
  subject          TEXT NOT NULL,
  email            TEXT,
  email_verified   INTEGER NOT NULL DEFAULT 0,
  is_private_email INTEGER NOT NULL DEFAULT 0,  -- adresse masquée Apple (privaterelay.appleid.com)
  created_at       INTEGER NOT NULL,
  last_login_at    INTEGER,
  UNIQUE (provider, subject)
);
CREATE INDEX idx_identities_user ON identities(user_id);

-- Sessions : seul le hachage SHA-256 du jeton est conservé.
CREATE TABLE sessions (
  id_hash          TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at       INTEGER NOT NULL,
  auth_at          INTEGER NOT NULL,          -- dernière authentification auprès du fournisseur
  last_seen_at     INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,          -- expiration absolue
  active_org_id    TEXT,
  user_agent       TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- Demandes de connexion en cours (état OAuth, usage unique, 10 minutes).
CREATE TABLE auth_requests (
  state_hash       TEXT PRIMARY KEY,
  provider         TEXT NOT NULL,
  nonce            TEXT NOT NULL,
  code_verifier    TEXT,
  mode             TEXT NOT NULL CHECK (mode IN ('login','link','recovery')),
  next_path        TEXT,
  link_user_id     TEXT,
  recovery_id      TEXT,
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL
);

-- Établissements
CREATE TABLE organizations (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  logo             TEXT,
  city             TEXT,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

-- Appartenance : le rôle (permissions) est distinct de la fonction professionnelle.
CREATE TABLE memberships (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role             TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
  function         TEXT NOT NULL DEFAULT 'other' CHECK (function IN ('reception','tsa','veterinarian','manager','other')),
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  UNIQUE (org_id, user_id)
);
CREATE INDEX idx_memberships_user ON memberships(user_id);
CREATE INDEX idx_memberships_org ON memberships(org_id);

-- Invitations : jeton haché, usage unique, révocables, limitées dans le temps.
CREATE TABLE invitations (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email            TEXT NOT NULL,             -- destinataire (minuscules)
  role             TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
  function         TEXT NOT NULL DEFAULT 'other',
  token_hash       TEXT NOT NULL UNIQUE,
  invited_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,
  accepted_at      INTEGER,
  accepted_by      TEXT,
  revoked_at       INTEGER,
  revoked_by       TEXT
);
CREATE INDEX idx_invitations_org ON invitations(org_id);

-- Liens de récupération d'accès (créés par un administrateur de la plateforme, usage unique, 24 h).
CREATE TABLE recovery_links (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email            TEXT NOT NULL,             -- adresse vérifiée exigée du nouveau moyen de connexion
  token_hash       TEXT NOT NULL UNIQUE,
  created_by       TEXT,
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,
  used_at          INTEGER
);

-- Journal : qui a fait quoi. Jamais de jeton, de code ni de secret.
CREATE TABLE audit_log (
  id               TEXT PRIMARY KEY,
  org_id           TEXT,
  actor_user_id    TEXT,
  action           TEXT NOT NULL,
  target_user_id   TEXT,
  details          TEXT,                       -- JSON (rôles avant/après, courriel masqué…)
  created_at       INTEGER NOT NULL
);
CREATE INDEX idx_audit_org ON audit_log(org_id, created_at);

-- Tentatives limitées (ex. activation de l'administrateur de la plateforme)
CREATE TABLE rate_limits (
  key              TEXT PRIMARY KEY,
  count            INTEGER NOT NULL,
  reset_at         INTEGER NOT NULL
);
