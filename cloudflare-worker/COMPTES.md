# Module Comptes, établissements et permissions

## Architecture

- **Serveur** : le relais existant `laqualia-agent` (Cloudflare Worker). Le module vit dans `accounts/` :
  - `index.js` gère les routes `/auth/*` (connexion) et `/api/*` (comptes, établissements, membres, invitations, plateforme) ;
  - `oidc.js` gère Google et Apple en OpenID Connect ;
  - le code par courriel (sans mot de passe) est dans `index.js` (routes `/auth/email/start` et `/auth/email/verify`) ;
  - `perms.js` contient la matrice des permissions.
- **Données** : la base Cloudflare D1 `laqualia-comptes`, reliée sous le nom `DB`. Le schéma est dans `migrations/0001_comptes.sql`, `0002_connexion_courriel.sql` et `0003_codes_acces.sql`.
- **Routes** : `laqualia.com/auth/*` et `laqualia.com/api/*` passent par le relais, déclarées dans `wrangler.jsonc`. La session est un témoin `__Host-lq_sess` (HttpOnly, Secure, SameSite=Lax) du même site.
- **Pages** : `agent/connexion.html`, `agent/invitation.html` et `agent/compte.html` (avec `compte.js` et `compte.css`). Le lien « Mon compte » est dans le menu de l'assistant.
- **Bibliothèque** : `vendor/jose.js` est la version 5.9.6 de jose (licence MIT). Elle vérifie les jetons d'identité : signature, émetteur, audience, expiration et nonce.

## Accès au portail (laqualia.com/agent)

### Premier accès des personnes invitées (`agent/acces.html`)
- **Saisie** : trois champs seulement (prénom, adresse courriel, code d'invitation), puis « Accéder au portail ».
- **Vérification** : le serveur (`POST /auth/invite`) vérifie le code. S'il est valide :
  - il crée un profil minimal (prénom, courriel) ;
  - il rattache la personne à l'établissement du code avec le rôle Membre ;
  - il ouvre une session.
  - Aucun mot de passe, aucun courriel de confirmation, aucune autre étape.
- **Courriel** : c'est une coordonnée non vérifiée (`users.contact_email`). Il ne sert jamais à retrouver un compte ni à se connecter, et ne déclenche aucune fusion : chaque premier accès crée un compte distinct.
- **Session** :
  - session « invite », gardée sur l'appareil ;
  - expire après 30 jours d'inactivité, ou 90 jours au total ;
  - les sessions des comptes existants gardent leurs règles (12 h d'inactivité, 14 jours au total).
- **Profil** : une invitation discrète (« Compléter mon profil » / « Plus tard ») propose d'ajouter le nom et d'associer une adresse courriel, vérifiée par code, pour pouvoir se reconnecter depuis un autre appareil. Elle ne bloque jamais le portail.
- **Limites** : 10 essais par adresse IP par 15 minutes, 40 par jour. Une saisie refusée ne crée aucun compte et ne consomme pas le code.
- **Appareil partagé** : un nouveau premier accès ferme la session précédente de ce navigateur.

### Association d'une adresse par les Membres (désactivée pour l'instant)
- **Aujourd'hui** : un Membre ne peut pas associer une adresse courriel à son compte. L'interface ne le propose pas et le serveur le refuse (`link_disabled`). Les propriétaires, les administrateurs d'établissement et l'administrateur de la plateforme gardent cette option.
- **Mise en production** : ajoutez la variable `MEMBER_EMAIL_LINK` = `on` au relais `laqualia-agent`. Aucun déploiement n'est nécessaire.

### Connexion administrateur (`agent/connexion.html`)
- L'authentification existante (code par courriel, Google ou Apple), sans code d'invitation.
- Pour les administrateurs, et pour les personnes qui ont associé un moyen de connexion à leur profil.
- Les comptes existants ne sont pas modifiés par le nouveau parcours.

### Codes d'invitation (Mon compte › Codes d'accès, administrateurs de l'établissement seulement)
- **Gestion** : générer, consulter, copier, renouveler, révoquer.
- **Validité** : choisie par l'administrateur en heures, de 1 à 720 (30 jours), 24 heures par défaut. Le renouvellement reprend la même durée.
- **Utilisations** : usage unique par défaut, ou un nombre choisi, ou illimité.
- **Format** : 12 caractères, sans caractères ambigus.
- **Stockage** : la vérification se fait par empreinte SHA-256. Le code est aussi chiffré (AES-GCM) pour être revu par l'administrateur tant qu'il est actif. La clé vient de `ACCESS_CODE_KEY`, sinon de `ADMIN_CODE`.
- **Révoquer ou retirer** :
  - révoquer un code bloque seulement les nouvelles entrées ;
  - retirer l'accès d'une personne est une action distincte (Membres et invitations), effective immédiatement ;
  - le code ne rétablit pas un accès retiré.

### Portail
- **Vérification** : sur laqualia.com, l'interface appelle `/api/agent`. La session, le compte actif et l'appartenance active sont vérifiés à chaque requête.
- **Droits** :
  - un Membre utilise la Réception, la TSA et le tableau de bord ;
  - la page Admin de l'agent est réservée à l'administrateur de la plateforme.
- **Miroir** : le miroir GitHub Pages `nc` garde l'ancien accès par codes d'équipe.

### Protection anti-robots (Cloudflare Turnstile)
- **Où** : la page d'accès (« Accéder au portail ») et l'envoi du code par courriel de la Connexion administrateur.
- **Vérification** : le jeton Turnstile est vérifié côté serveur, avant toute vérification de code ou tout envoi de courriel ; le domaine qui a émis le jeton est contrôlé.
- **Clé de site** (publique) : `0x4AAAAAAFeXR1_bJkXdINQm`, dans `accounts/index.js`. On peut la remplacer par la variable `TURNSTILE_SITEKEY`.
- **Activation** : seulement quand le secret `TURNSTILE_SECRET` est ajouté au relais. Sans lui, rien n'est demandé.
- **Exception** : l'association d'une adresse depuis Mon profil exige déjà une session et n'est pas concernée.

## Sécurité, en bref

- **Identité du compte** : le compte est identifié par `(fournisseur, sub)`, l'identifiant vérifié du fournisseur. Il n'y a jamais de fusion par adresse courriel.
- **Connexion** :
  - flux « authorization code » côté serveur, avec PKCE pour Google et un secret client JWT ES256 pour Apple ;
  - `state` à usage unique, lié au navigateur par un témoin ;
  - `nonce` vérifié dans le jeton d'identité.
- **Code par courriel** :
  - 6 chiffres tirés sans biais, valables 10 minutes, 5 essais au plus (compteur incrémenté avant la comparaison), usage unique ;
  - lié au navigateur qui l'a demandé par un témoin `__Secure-lq_ecode` (HttpOnly, SameSite=Strict) ; la base ne garde que SHA-256(jeton) et SHA-256(jeton + code) ;
  - un nouveau code annule le précédent ; 5 envois par adresse et 20 par adresse IP, par heure ;
  - même réponse que l'adresse ait un compte ou non ;
  - le compte est identifié par l'adresse ainsi vérifiée (fournisseur `email`) et n'est jamais fusionné avec un compte Google ou Apple de même adresse ; on peut associer une adresse depuis Mon profil (code exigé, authentification récente exigée).
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

### 0. Code par courriel (déjà actif)

Il utilise la liaison d'envoi `ALERT_EMAIL` (Cloudflare Email Service) déjà en place, avec l'expéditeur `connexion@notif.laqualia.com`. Le domaine `notif.laqualia.com` doit rester intégré dans Email Service › Email Sending. Facultatif : une variable `AUTH_FROM` change l'expéditeur, une liaison `AUTH_EMAIL` sépare les envois de connexion des alertes. Surveillez le quota quotidien d'envoi dans Email Service.

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
node --test tests/accounts.test.mjs tests/email.test.mjs tests/portal.test.mjs tests/premier-acces.test.mjs tests/turnstile.test.mjs  # 33 essais serveur
node tests/ui.mjs <dossier du site> <captures>            # parcours d'interface Playwright
node tests/ui-email.mjs <dossier du site> <captures>      # parcours de connexion par code courriel
node tests/ui-portal.mjs <dossier du site> <captures>     # premier accès, codes expirés ou déjà utilisés, reconnexion, retrait, accès administrateur
```

Les essais génèrent leurs propres clés de signature. Ils ne font aucun appel réseau et n'envoient aucun courriel.

## Migrations futures

Ajoutez `migrations/0002_….sql`, puis lancez :

```
npx wrangler d1 migrations apply laqualia-comptes --remote
```

Les migrations 0001 à 0004 sont déjà appliquées et consignée dans `d1_migrations`.

## Espace TSA › Nutrition — Aide au conseil client

- **Interface** : aucune fenêtre séparée. La tuile jaune orangé « Nutrition », première des outils de l'équipe technique (mode TSA seulement), active le mode Nutrition dans la même conversation : un bandeau « Mode Nutrition · Quitter » apparaît au-dessus du champ, qui prend la couleur de l'outil, et les réponses arrivent dans le fil, avec les étapes, les sources et, si on demande une comparaison, un comparatif. Il n'y a ni suggestions, ni volet de contexte, ni formulaire de comparaison : seulement la question libre. Quitter le mode, passer à la Réception ou lancer une simulation ramène l'agent TSA habituel.
- **Accès** : en mode TSA seulement. Mêmes droits que l'espace TSA : Membre et plus sur laqualia.com (session vérifiée à chaque requête), ou code TSA sur le miroir. Aucun droit d'administration requis ni accordé.
- **Fonctionnement** :
  - le relais (`nutrition.js`) appelle Claude avec les outils serveur `web_search` et `web_fetch` d'Anthropic ;
  - les domaines sont limités à royalcanin.com/ca, hillspet.ca et purina.ca ;
  - au plus 4 recherches et 6 consultations par demande, 14 000 jetons par page.
- **Sources** :
  - la page reçoit la liste des fiches **réellement consultées** (succès ou échec, avec la date) ;
  - un produit du comparateur sans fiche consultée est affiché comme non vérifié, avec « Non précisé dans la source » partout ;
  - « Prix et disponibilité à confirmer auprès de la clinique » apparaît toujours, puisqu'aucune donnée de prix ou de stock n'est connectée.
- **Protocoles** : les protocoles de la clinique viennent de la base de connaissances TSA (page Admin).
- **Si l'API refuse les outils** : un nouvel essai est fait sans réflexion, puis une réponse prudente sans fiche, signalée à l'utilisateur.
- **Prérequis** : la recherche web doit être activée pour l'organisation dans la console Anthropic (Settings › Privacy / Web search).
- **Coût** : 10 $ US par 1 000 recherches, plus les jetons des pages consultées. Chaque demande compte pour une question dans la limite quotidienne.

## Favoris (migration 0005)

- Table `favorites` : une ligne par échange gardé (question + réponse figée au moment de l'ajout, sources, contexte `reception` / `tsa` / `nutrition`).
- Rattachée à la personne **et** à l'établissement actif ; chacun ne voit que ses propres favoris. Le propriétaire ou l'administrateur de l'établissement n'y a pas accès.
- API (session du portail, en-tête `x-lq-csrf: 1` pour les modifications) : `GET /api/favorites` (aperçus), `GET /api/favorites/:id` (complet), `POST /api/favorites`, `DELETE /api/favorites/:id`.
- Limites : 300 favoris par personne et par établissement ; question 8 000 caractères, réponse 60 000 ; sources : liens https ou titres de documents de la clinique.
- Suppression : avec le compte, en quittant l'établissement ou au retrait du membre.
- Sur laqualia.com (mode compte) : gardés dans la base. En mode test (miroir GitHub Pages, code d'équipe, sans compte) : mêmes écrans, favoris gardés seulement dans le navigateur, par prénom (100 au plus) ; rien n'est envoyé à la base.
- Un favori est personnel : il ne valide pas l'exactitude de la réponse (rappel affiché à l'ajout et dans la page).
