# Documentation de référence de l'Assistant La Qualia

Les documents de ce dossier servent de base de connaissances à l'agent des téléphonistes.

## Ajouter un document

1. Enregistrez le document en texte : un fichier `.md` ou `.txt` (pour un PDF ou un Word, copiez-collez son texte dans un fichier `.md`).
2. Placez-le dans ce dossier `agent/docs/`.
3. Ajoutez-le à la liste `index.json`, avec un titre lisible :

```json
[
  { "file": "politique-annulation.md", "title": "Politique d'annulation et de retard" },
  { "file": "lexique.md", "title": "Lexique vétérinaire" }
]
```

4. Enregistrez (commit) sur GitHub. GitHub Pages republie le site en une à deux minutes, et l'agent utilise le nouveau document dans les 5 minutes qui suivent.

Le nom de fichier ne doit contenir ni barre oblique ni espace ; utilisez des tirets.

## Important : ce dépôt est public

Tout fichier placé ici est lisible par n'importe qui sur GitHub et en ligne dans le dossier `agent/docs/` du site. N'y mettez pas de renseignements personnels sur des clients ou des employés, ni d'information confidentielle.

## Modifier le comportement de l'agent

Le nom, le sous-titre, l'avertissement, les questions d'exemple et les instructions se trouvent dans `agent/config.json`.
Le champ `tier` règle la profondeur des réponses : `quick` (rapide, moins cher), `default` (standard) ou `complex` (approfondie, plus cher).
