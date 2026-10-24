# Budg' 💞

Le Tricount du couple : chacun saisit ce qu'il paie, Budg' calcule **qui doit combien à qui**,
suit les **budgets du mois** et prévient quand ça dérape.

## Fonctionnalités

- **Dépenses** : montant, qui a payé, catégorie, répartition (50/50, au prorata des revenus,
  « tout pour l'autre », personnalisée).
- **Charges fixes** : loyer, assurances, abonnements… saisis une fois, comptés automatiquement
  chaque mois (jour de prélèvement, date de début et de fin).
- **Solde du couple** : « Léa doit 468,25 € à Max », avec un bouton *Régler* qui enregistre le remboursement.
- **Budgets mensuels** par catégorie (Courses 400 €, Restaurants 100 €, Vacances 150 €…).
- **Analyse** :
  - alertes « 🚨 Courses : 140 % du budget, hors budget de 160,50 € » ;
  - projection de fin de mois au rythme actuel (« à ce rythme, 110 % du budget resto ») ;
    les charges fixes ne sont pas extrapolées ;
  - comparaison avec la moyenne des 3 mois précédents, par catégorie et au total ;
  - évolution sur 4 mois, qui a payé et quelle est la part de chacun.
- **En ligne et en temps réel** avec Supabase : chacun a son compte, le couple est relié par
  un code d'invitation, et ce que l'un saisit apparaît aussitôt chez l'autre.
- Mode **hors ligne** (sans compte, données dans le navigateur), export / import JSON.
- Installable sur l'écran d'accueil du téléphone (PWA), thème clair et sombre.

## Mise en route

### 1. Base de données Supabase

1. Dans le projet Supabase, ouvrez **SQL Editor** et exécutez le contenu de
   [`supabase/schema.sql`](supabase/schema.sql).
2. **Authentication → URL Configuration** : mettez l'adresse où l'appli est publiée dans *Site URL*
   (sinon le lien de confirmation reçu par e-mail renvoie vers `localhost`).
3. **Project Settings → API** : copiez l'URL du projet et la clé *publishable* (ou *anon*)
   dans [`config.js`](config.js). Ces deux valeurs sont publiques ; la protection des données
   repose sur les règles RLS du schéma (chacun ne voit que les données de son couple).

### 2. Lancer l'appli

C'est un site statique, sans compilation :

```bash
npm start        # sert le dossier sur http://localhost:8080
npm test         # tests du calcul (solde, charges fixes, analyse)
```

Pour l'utiliser à deux, publiez le dossier sur un hébergeur statique (Netlify, Vercel,
Cloudflare Pages, GitHub Pages…).

### 3. À deux

1. La première personne crée un compte, puis **Créer notre budget**.
2. Elle donne le **code d'invitation** (Accueil ou Réglages) à sa moitié.
3. La seconde personne crée son compte, puis **Rejoindre avec un code**.

## Organisation du code

| Fichier | Rôle |
| --- | --- |
| `logic.js` | Calculs purs : solde, charges fixes, résumé et analyse du mois (montants en centimes) |
| `store.js` | Données : mode hors ligne (localStorage) ou Supabase + temps réel |
| `app.js` | Interface (écrans, formulaires, alertes) |
| `supabase/schema.sql` | Tables, règles RLS, fonctions de création / d'invitation du couple |
| `tests/logic.test.js` | Tests (`node --test`) |
