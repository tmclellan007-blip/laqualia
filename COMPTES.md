
## Favoris (migration 0005)

- Table `favorites` : une ligne par échange gardé (question + réponse figée au moment de l'ajout, sources, contexte `reception` / `tsa` / `nutrition`).
- Rattachée à la personne **et** à l'établissement actif ; chacun ne voit que ses propres favoris. Le propriétaire ou l'administrateur de l'établissement n'y a pas accès.
- API (session du portail, en-tête `x-lq-csrf: 1` pour les modifications) : `GET /api/favorites` (aperçus), `GET /api/favorites/:id` (complet), `POST /api/favorites`, `DELETE /api/favorites/:id`.
- Limites : 300 favoris par personne et par établissement ; question 8 000 caractères, réponse 60 000 ; sources : liens https ou titres de documents de la clinique.
- Suppression : avec le compte, en quittant l'établissement ou au retrait du membre.
- Offert seulement sur laqualia.com (mode compte). Le miroir GitHub Pages (code d'équipe) n'affiche pas le cœur.
- Un favori est personnel : il ne valide pas l'exactitude de la réponse (rappel affiché à l'ajout et dans la page).
