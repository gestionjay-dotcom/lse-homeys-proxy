# Proxy LSE ↔ Homeys (version alignée sur la doc Apidog)

Reçoit un PDL de Bubble, parle à Homeys, attend les résultats et renvoie
FTA / puissance / segment / kWh par poste à Bubble.

## Flux réel (d'après la doc Homeys)

1. Bâtiment : recherche (`GET /open/v1/building?search=`), sinon parcelle la plus proche →
   bâtiments de la parcelle → `POST /open/v1/building` (code INSEE déduit de l'id de parcelle).
2. Anti-doublon : `GET /open/v1/source?search=<PDL>` ; réutilisée seulement si `consentement.etat = active`.
3. `POST /open/v1/source/consentrequest` (l'id de la demande est `_id`, le quota Homeys est consommé ici).
4. Signature : `PUT /open/v1/source/consentrequest/{_id}` sans corps → état `TERMINATED`.
5. Polling `GET /open/v2/source/{id}` jusqu'à `data_retrieval.historical.state = finished`.
   États d'échec : `noconsent`, `crashed`. PDL absent chez Enedis : `etat = inexistant`.
6. kWh par poste : `GET /open/v1/source/data/daily` (variables `energie_elec_turpe…`), sommés par le proxy.
   Correspondance : HPE→HPB, HCE→HCB, Pointe→PTE. En Base : clé `TOTAL`.

Si une collecte échoue avant signature, la demande est supprimée pour libérer le quota.

## Mise en ligne

1. **GitHub** : dépôt privé, y déposer le contenu de ce dossier (sans `node_modules` ni `dist`).
2. **Railway** : New Project → Deploy from GitHub repo, puis **+ New → Database → PostgreSQL**.
3. Service du proxy → **Variables** : `DATABASE_URL` (Add Reference vers Postgres), `HOMEYS_API_KEY`,
   `HOMEYS_USERNAME`, `HOMEYS_PASSWORD`, `LSE_TOKEN` (chaîne aléatoire à reprendre dans Bubble),
   `BUBBLE_API_TOKEN` (Bubble > Settings > API > Generate a new API token).
4. **Settings → Networking → Generate Domain**, puis **Deployments → View logs** : « Proxy LSE-Homeys démarré ».

## Tests (remplace URL et SECRET)

    curl https://URL/health
    curl -H "x-lse-token: SECRET" https://URL/homeys/test

    curl -X POST https://URL/homeys/collecte \
      -H "x-lse-token: SECRET" -H "Content-Type: application/json" \
      -d '{"collecte_id":"test-1","pdl":"12345678901234","siren":"452413560","raison_sociale":"TEST SAS",
           "signataire":{"prenom":"Jean","nom":"Dupont","email":"j.dupont@exemple.fr"},
           "adresse":{"rue":"12 rue des Lilas","cp":"92300","ville":"Levallois-Perret"},
           "historique_mois":12,"callback_url":"https://httpbin.org/post"}'

    curl -H "x-lse-token: SECRET" https://URL/homeys/collecte/test-1

Attention : une vraie collecte crée une source et consomme du quota Homeys. Utiliser un PDL réel de LSE pour les essais.

## À contrôler au premier test (les logs montrent les réponses brutes)

- **`company`** : placée à la racine du body (schéma OpenAPI). Le guide Homeys la montre dans `user`.
  Si Homeys répond 4xx sur la création de demande, déplacer `body.company` dans `body.user` (`homeys.ts`, `createConsentRequest`).
- **kWh par poste** : noms de variables repris du catalogue du bâtiment, forme de réponse déduite de la doc.
  Comparer les totaux à une facture ; si 1000× trop grand, `HOMEYS_ENERGY_DIVISOR=1000`.
- **Suppression d'une demande** : chemin `DELETE …/consentrequest/{id}` supposé (page non fournie).
- **Profondeur d'historique** : `date_from_data` n'existe que pour le gaz ; pour un PDL, Homeys choisit.
  `historique_mois` ne sert qu'à définir la fenêtre de consommation (12 mois glissants se terminant à la dernière donnée).
