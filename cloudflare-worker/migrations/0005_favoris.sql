-- Favoris : échanges (question + réponse) enregistrés par une personne, dans un établissement.
-- Ajout seulement : aucune donnée existante n'est modifiée.
-- La réponse est conservée telle qu'elle était au moment de l'ajout (copie figée).
-- Un favori est personnel : il n'indique pas que la réponse a été validée.
-- org_id : établissement actif au moment de l'ajout ('_plateforme' pour l'administrateur de la plateforme sans établissement).
-- fkey   : empreinte (SHA-256) du contexte, de la question et de la réponse ; évite les doublons et permet d'afficher le cœur rempli.
CREATE TABLE favorites (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  fkey TEXT NOT NULL,
  context TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  sources TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, org_id, fkey)
);
CREATE INDEX idx_favorites_owner ON favorites(user_id, org_id, created_at);
