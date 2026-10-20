-- Codes d'accès d'établissement : un administrateur génère un code et le transmet lui-même.
-- La personne connectée le saisit une fois ; elle devient Membre de cet établissement.
-- code_hash : SHA-256 du code normalisé (sert à la vérification).
-- code_enc  : code chiffré (AES-GCM, clé du relais) pour que l'administrateur puisse le revoir et le copier.
CREATE TABLE access_codes (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  label TEXT,
  code_hash TEXT NOT NULL UNIQUE,
  code_enc TEXT NOT NULL,
  code_hint TEXT NOT NULL,
  max_uses INTEGER,
  uses INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER,
  revoked_by TEXT,
  replaced_by TEXT
);
CREATE INDEX idx_access_codes_org ON access_codes(org_id, created_at);
-- Trace de l'origine de chaque appartenance (invitation ou code d'accès), sans le code lui-même.
ALTER TABLE memberships ADD COLUMN joined_via TEXT;
