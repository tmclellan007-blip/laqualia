-- Premier accès simplifié (prénom, courriel, code d'invitation).
-- Ajouts seulement : aucune donnée existante n'est modifiée.
-- contact_email : coordonnée saisie, NON vérifiée. Elle ne sert jamais à retrouver ni à fusionner un compte.
ALTER TABLE users ADD COLUMN contact_email TEXT;
-- signup : « invite » pour un compte créé par le premier accès ; NULL pour les comptes existants.
ALTER TABLE users ADD COLUMN signup TEXT;
-- kind : « auth » (Google, Apple, code courriel ; comportement actuel) ou « invite » (premier accès par code).
ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'auth';
