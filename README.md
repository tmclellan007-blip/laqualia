# La Qualia — site et identité

Site statique HTML, CSS et JavaScript. Déployer le contenu de `dist/` à la racine d’un hébergement HTTPS. Aucun outil de compilation n’est nécessaire.

## Direction visuelle et contenus

La nouvelle direction visuelle suit le PPTX fourni : fond pâle, titres noirs imposants, orange, corail, violet, bleu et lime ; trois piliers, bénéfices interactifs, évolution qualitative sur bleu nuit. Les textes sont issus du DOCX. Les interfaces illustratives sont reconstruites en HTML et explicitement identifiées. Aucune diapositive complète n’est utilisée comme page Web.

Le header utilise une employée et un chien détourés, des halos diffus, des orbites SVG et des cartes HTML cliquables « Formation », « Vos procédures » et « Accompagnement ». Le visuel a été généré/édité avec imagegen intégré : préserver l’employée en tenue bleue et le chien, retirer le décor et la table, créer un fond transparent et garder les visages dégagés. Il représente une scène illustrative. Le portrait au centre des six bénéfices provient de la diapositive 8.

Le logo est désormais le concept approuvé « 02 — Q facetté » : cinq facettes, une diagonale bleue et trois éclats. Le symbole a été reconstruit en tracés SVG, avec les cinq couleurs exactes. Le mot-symbole géométrique est vectorisé (URW Gothic Demi), sans dépendance à une police externe. Les déclinaisons SVG/PNG pour fonds clairs et sombres et l’icône sont dans `dist/assets/`. Les PNG ont un fond transparent.

## Éléments repris de l’ancien site fourni

La photo et le contenu de la section Amélie Brunelle sont repris de `index(6).html` et présentés avant le pied de page dans le nouveau thème. La section contient son titre de directrice et ses trois volets : santé animale et gestion ; formation et technopédagogie ; IA et transformation numérique.

Les coordonnées reprises du fichier fourni sont masquées et révélées au clic dans le site. Lien LinkedIn :
- https://www.linkedin.com/company/la-qualia/about/?viewAsMember=true

Le formulaire reprend exactement les champs, noms, choix et obligations de l’ancien site. Il envoie par POST à `https://formspree.io/f/xrewzbqp`. Son traitement et la confirmation relèvent de Formspree, comme dans la version source. Aucun intercepteur JavaScript ne transforme l’envoi en simulation. Aucun message de test n’a été envoyé ; la réception finale par la boîte destinataire n’est pas vérifiée.

Google Analytics utilise `G-7WQ2G8JCFT`. Le script de consentement provient de l’ancien site : aucun script Google chargé avant acceptation, refus possible, préférences modifiables depuis le pied de page, choix conservé 180 jours. Publicité et signaux publicitaires désactivés. Le bandeau et les paramètres reprennent le nouveau thème. Le fichier `analytics.js` contient cette logique. L’arrivée effective de données dans le tableau de bord GA n’est pas vérifiée.

## Interactions

Navigation mobile, ancrages, exemples de parcours, exemples d’accompagnant, six bénéfices sélectionnables, légende interactive des courbes, FAQ native, formulaire Formspree et consentement aux cookies. Les fenêtres modales se ferment avec Échap ou leur bouton. La préférence de réduction des animations est respectée.

Les courbes sont qualitatives et ne représentent pas des résultats mesurés ni garantis. Les démonstrations de formation et d’IA ne sont pas des logiciels connectés.

## Mise en ligne et référencement

La version Sites est privée et conserve son audience. Pour une mise en ligne publique, choisir le domaine et le partage appropriés. Pour configurer un autre domaine, exécuter `node tools/configurer-domaine.mjs https://votre-domaine.ca`, puis déployer `dist/`.

HTML sémantique, un H1, métadescription, URL canonique, Open Graph, image de partage, sitemap XML et robots.txt. JSON-LD : organisation, site et service, avec les coordonnées et LinkedIn issus de l’ancien site. Aucun témoignage, client, certification ou résultat n’est inventé. Aucun classement ni citation par un assistant n’est garanti.

## Vérifications et limites

Vérification des fichiers, images, liens locaux, ancrages, identifiants uniques, métadonnées et JSON-LD. Syntaxe JavaScript vérifiée. Comparaison automatisée du formulaire avec l’ancien : endpoint, méthode, champs, obligations et options identiques. Logique de chargement Analytics vérifiée sans envoyer de données : aucun chargement sans accord, bon identifiant après accord. Transparence des images détourées vérifiée.

Le navigateur de contrôle n’est pas disponible dans cet environnement. Le rendu à 375, 768 et 1440 px, l’absence de débordement horizontal et le parcours clavier réel restent à vérifier avant le lancement public. Les points de rupture CSS sont préparés, mais leur seule présence ne constitue pas un contrôle visuel.

## Protection des coordonnées

Les coordonnées ne figurent plus en clair dans le HTML ni dans les données structurées. Les boutons « Afficher le courriel » et « Afficher le téléphone » les révèlent au clic, avec un lien mailto/tel et le focus clavier. Les valeurs sont encodées dans le JavaScript. Le formulaire reste accessible sans JavaScript. Il s’agit d’une réduction de la collecte par les robots simples, pas d’une protection absolue : un robot capable d’exécuter le code ou de décoder les valeurs peut les retrouver. Les anciennes versions ou le site historique peuvent également les contenir.

## Mise à jour du 11 octobre 2026 — Q facetté
Logo appliqué à l’en-tête, au pied de page, aux trois filigranes des piliers et au filigrane du pied de page. SVG et PNG transparents pour fonds clairs/sombres, favicon SVG/ICO/PNG, icône Apple et image de partage régénérés. Le site se déploie en plaçant le contenu de cette archive à la racine de l’hébergement (aucun dossier dist requis dans cette archive). Vérification structurelle et visuelle des exports effectuée ; rendu du site dans un navigateur non vérifié dans cette session.
