# Module Comptes, établissements et permissions

## Architecture

- **Serveur** : le relais existant `laqualia-agent` (Cloudflare Worker). Le module vit dans `accounts/` :
  - `index.js` gère les routes `/auth/*` (connexion) et `/api/*` (comptes, établissements, membres, invitations, plateforme) ;
  - `oidc.js` gère Google et Apple en OpenID Connect ;
  - `perms.js` contient la matrice des permissions.
- **Données** : la base Cloudflare D1 `laqualia-comptes`, reliée sous le nom `DB`. Le schéma est dans `migrations/0001_comptes.sql`.
- **Routes** : `laqualia.com/auth/*` et `laqualia.com/api/*` passent par le relais, déclarées dans `wrangler.jsonc`. La session est un témoin `__Host-lq_sess` (HttpOnly, Secure, SameSite=Lax) du même site.
- **Pages** : `agent/connexion.html`, `agent/invitation.html` et `agent/compte.html` (avec `compte.js` et `compte.css`). Le lien « Mon compte » est dans le menu de l'assistant.
- **Bibliothèque** : `vendor/jose.js` est la version 5.9.6 de jose (licence MIT). Elle vérifie les jetons d'identité : signature, émetteur, audience, expiration et nonce.

## Sécurité, en bref

- **Identité du compte** : le compte est identifié par `(fournisseur, sub)`, l'identifiant vérifié du fournisseur. Il n'y a jamais de fusion par adresse courriel.
- **Connexion** :
  - flux « authorization code » côté serveur, avec PKCE pour Google et un secret client JWT ES256 pour Apple ;
  - `state` à usage unique, lié au navigateur par un témoin ;
  - `nonce` vérifié dans le jeton d'identité.
- **Session** :
  - jeton aléatoire, dont seul le hachage SHA-256 est stocké ;
  - expiration après 12 h d'inactivité ou 14 jours au total ;
  - déconnexion simple, ou déconnexion de tous les appareils.
- **CSRF** : chaque modification exige l'en-tête `x-lq-csrf: 1` et la même origine.
- **Isolation entre établissements** : chaque requête revérifie l'appartenance active (`orgContext`). Toutes les recherches de membres ou d'invitations sont filtrées par `org_id`. Un identifiant d'un autre établissement ne correspond à rien et la réponse est 404.
- **Désactivation, changement de rôle ou retrait** : l'effet est immédiat, même dans une session ouverte, puisque rien n'est mis en cache dans la session.
- **Invitations** :
  - jeton haché, usage unique (mise à jour conditionnelle), révocables, valables 7 jours ;
  - le destinataire est vérifié : une adresse **vérifiée** du compte doit correspondre exactement ;
  - aucun rattachement selon le domaine.
- **Dernier propriétaire** : il ne peut pas être rétrogradé, désactivé ou retiré, ni quitter l'établissement, sans transfert préalable. C'est vrai aussi pour l'administrateur de la plateforme.
- **Journal (`audit_log`)** : il consigne les rôles, invitations, désactivations, retraits, transferts, associations de moyens de connexion, suspensions et récupérations. Les courriels y sont masqués et aucun jeton ni code n'y figure.

## Configuration restante

### 1. Google (environ 10 minutes)

1. Dans Google Cloud Console › **API et services** › **Écran de consentement OAuth**, configurez :
   - le type « Externe » ;
   - le nom « La Qualia » ;
   - le domaine `laqualia.com` ;
   - les liens de confidentialité.
2. Dans **Identifiants**, choisissez **Créer › ID client OAuth** :
   - type : **Application Web** ;
   - origine JavaScript autorisée : `https://laqualia.com` ;
   - URI de redirection autorisé : `https://laqualia.com/auth/google/callback`.
3. Dans Cloudflare › Workers › `laqualia-agent` › Paramètres › Variables et secrets, ajoutez :
   - `GOOGLE_CLIENT_ID`, de type « Texte » ;
   - `GOOGLE_CLIENT_SECRET`, de type « Secret ».

### 2. Apple (environ 20 minutes, compte Apple Developer requis)

1. Dans Certificates, Identifiers & Profiles › **Identifiers**, sur l'App ID principal, cochez **Sign In with Apple**.
2. Créez un **Services ID**, par exemple `com.laqualia.web` : c'est le `APPLE_CLIENT_ID`.
   - Activez Sign In with Apple ;
   - domaine : `laqualia.com` ;
   - Return URL : `https://laqualia.com/auth/apple/callback`.
3. Dans **Keys**, créez une clé avec Sign In with Apple et téléchargez le fichier `.p8`. Ce téléchargement n'est possible qu'une seule fois.
4. Dans Cloudflare, ajoutez :
   - `APPLE_CLIENT_ID` : le Services ID ;
   - `APPLE_TEAM_ID` : l'identifiant d'équipe, 10 caractères ;
   - `APPLE_KEY_ID` : l'identifiant de la clé ;
   - `APPLE_PRIVATE_KEY` : le contenu complet du fichier `.p8`, de type « Secret ».

### 3. Premier administrateur de la plateforme

1. Connectez-vous sur `https://laqualia.com/agent/connexion.html`.
2. Ouvrez **Mon compte › Plateforme**.
3. Entrez le code `ADMIN_CODE` existant. Cette opération n'est possible qu'une seule fois.

### 4. Boutons officiels

Les boutons de connexion sont pour l'instant textuels. Avant le lancement public, remplacez-les par les éléments officiels de Google et d'Apple, en respectant leurs directives de marque.

### 5. Courriels d'invitation (facultatif)

Aujourd'hui, le responsable copie le lien d'invitation et le transmet lui-même. Aucun courriel n'est envoyé. Pour un envoi automatique, il faudra un service d'envoi transactionnel.

## Essais

```
node --test tests/accounts.test.mjs          # 14 essais serveur (D1 simulé, Google et Apple simulés)
node tests/ui.mjs <dossier du site> <captures>  # parcours d'interface Playwright
```

Les essais génèrent leurs propres clés de signature. Ils ne font aucun appel réseau et n'envoient aucun courriel.

## Migrations futures

Ajoutez `migrations/0002_….sql`, puis lancez :

```
npx wrangler d1 migrations apply laqualia-comptes --remote
```

La migration 0001 est déjà appliquée et consignée dans `d1_migrations`.
