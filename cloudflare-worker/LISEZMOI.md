# Activer l'Assistant La Qualia (relais Cloudflare)

Le site est hébergé sur GitHub Pages, qui ne sert que des fichiers statiques. Pour que l'assistant réponde sans exposer la clé API, un petit relais tourne sur Cloudflare Workers (gratuit à ce volume). Il se configure une seule fois, en une dizaine de minutes.

## 1. Créer la clé API Anthropic

1. Allez sur https://console.anthropic.com et créez un compte.
2. Dans **Billing**, ajoutez des crédits.
3. Dans **Limits**, fixez une limite de dépenses mensuelle, par exemple 20 $.
4. Dans **API Keys**, cliquez **Create Key** et copiez la clé. Elle commence par `sk-ant-`.

## 2. Créer le Worker

1. Dans Cloudflare, ouvrez **Workers & Pages** → **Create** → **Create Worker**.
2. Nommez-le `laqualia-agent`, puis cliquez **Deploy**.
3. Cliquez **Edit code**, remplacez tout le contenu par celui du fichier `agent-worker.js` de ce dossier, puis cliquez **Deploy**.
4. Notez l'adresse du Worker affichée en haut, par exemple `https://laqualia-agent.votre-compte.workers.dev`.

## 3. Ajouter les variables du Worker

Dans le Worker, ouvrez **Settings** → **Variables and Secrets** → **Add** :

| Nom | Type | Valeur |
|---|---|---|
| `ANTHROPIC_API_KEY` | Secret | la clé `sk-ant-…` |
| `AGENT_CODE` | Secret | le code d'accès que vous donnerez à l'équipe |
| `SITE_URL` | Text | `https://tmclellan007-blip.github.io/nc` |
| `ALLOWED_ORIGINS` | Text | `https://tmclellan007-blip.github.io,https://www.laqualia.com,https://laqualia.com` |

Cliquez **Deploy** pour enregistrer.

## 4. Brancher la page sur le Worker

Dans GitHub, ouvrez `agent/config.json` et mettez l'adresse du Worker dans `apiUrl` :

```json
"apiUrl": "https://laqualia-agent.votre-compte.workers.dev",
```

Faites un commit. GitHub Pages republie le site en une à deux minutes.

## Quand le site passera sur laqualia.com

Mettez `SITE_URL` à `https://www.laqualia.com` dans le Worker. `ALLOWED_ORIGINS` accepte déjà laqualia.com.

## Voix naturelles pour la simulation (Microsoft Azure, facultatif)

Sans ces variables, la simulation à la voix utilise les voix du navigateur. Avec elles, le client parle avec une voix neuronale québécoise (Sylvie, Antoine, Jean ou Thierry) et la dictée fonctionne de la même façon dans tous les navigateurs.

1. Sur https://portal.azure.com, créez une ressource **Speech** (service « Speech » d'Azure AI services), niveau tarifaire **Free F0**, région **Canada Central**.
2. Dans la ressource, ouvrez **Keys and Endpoint** et copiez **KEY 1** et la **Location/Region** (ex. `canadacentral`).
3. Dans le Worker `laqualia-agent` → **Settings** → **Variables and Secrets**, ajoutez :

| Nom | Type | Valeur |
|---|---|---|
| `AZURE_SPEECH_KEY` | Secret | la KEY 1 |
| `AZURE_SPEECH_REGION` | Text | `canadacentral` |

4. Cliquez **Deploy**. Rechargez l'agent : la liste « Voix du client » propose alors Sylvie, Antoine, Jean et Thierry.

## Espace Équipe technique — TSA (accès protégé)

L'onglet « Équipe technique — TSA » ne s'ouvre qu'avec un code TSA, vérifié par ce relais à chaque demande. Sans ce code, le relais refuse toute demande de l'espace TSA, même si quelqu'un modifie la page.

Dans le Worker `laqualia-agent` → **Settings** → **Variables and Secrets**, ajoutez :

| Nom | Type | Valeur |
|---|---|---|
| `TSA_CODE` | Secret | le code remis seulement au personnel technique |

Pour retirer l'accès à quelqu'un, changez la valeur de `TSA_CODE` : tous les appareils devront entrer le nouveau code.
