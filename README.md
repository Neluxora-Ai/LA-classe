# 🎒 La Classe

Chat de classe : **un salon commun** pour tout le monde + **des groupes privés** où chacun choisit qui il ajoute.
Images, historique, « en ligne », « X écrit… », comptes individuels. Hébergé sur **Vercel**, données sur **Supabase** (gratuits).

## Tester tout de suite (mode démo, sans rien installer de plus)

```bash
npm install
npm run dev
```

Ouvre http://localhost:3000. Tant que `public/config.js` est vide, le site tourne en **mode démo** (données dans ton navigateur,
code de classe : `demo`). Ouvre un 2ᵉ onglet et crée un 2ᵉ compte pour voir le temps réel.

## Mise en ligne (≈ 15 min)

### 1. Créer le projet Supabase
1. Crée un compte sur https://supabase.com → **New project** (choisis une région proche, ex. Paris/Frankfurt, et un mot de passe de base de données).
2. **SQL Editor → New query** : colle tout le contenu de [`supabase/schema.sql`](supabase/schema.sql) → **Run**.
3. **Authentication → Sign In / Providers** : **désactive « Allow new users to sign up »**.
   ⚠️ Indispensable : sinon n'importe qui pourrait créer un compte en contournant le code de classe.
4. **Project Settings → API** : note
   - `Project URL`
   - la clé **anon / public** (visible dans le navigateur, c'est normal : la sécurité est dans la base)
   - la clé **service_role** (🔒 **secrète**, ne la mets jamais dans le code ni sur GitHub)

### 2. Configurer le site
Dans [`public/config.js`](public/config.js), renseigne `SUPABASE_URL` et `SUPABASE_ANON_KEY` (clé anon uniquement).

### 3. Déployer sur Vercel
1. Mets le dossier sur GitHub (`.env` et `node_modules` sont déjà ignorés).
2. https://vercel.com → **Add New → Project** → ton repo. Aucun réglage de build à changer.
3. **Settings → Environment Variables** (Production) :

   | Nom | Valeur |
   |---|---|
   | `SUPABASE_URL` | l'URL du projet Supabase |
   | `SUPABASE_SERVICE_ROLE_KEY` | la clé **service_role** |
   | `CLASS_CODE` | le code secret à donner à tes potes |

4. **Redeploy**. Donne le lien Vercel + le code de classe à tes potes. 🎉

### Tester en local avec le vrai Supabase (optionnel)
Crée un fichier `.env` (ignoré par git) :
```
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
CLASS_CODE=...
```
puis `npm run dev`.

## Comment ça marche

- **Salon commun** : tous les comptes y sont d'office.
- **Groupes privés** (＋ dans la barre latérale) : le créateur choisit les premiers membres ; ensuite **tout membre peut ajouter quelqu'un**
  (bouton 👥). Quand le dernier membre part, le groupe est supprimé.
- **Inscription** : passe par `api/register.js` (fonction Vercel) qui vérifie le code de classe (avec limite d'essais par IP).
- **Connexion** : pseudo + mot de passe (Supabase Auth, mots de passe hachés par Supabase).

## Sécurité

- Règles RLS Postgres : on ne lit/écrit que dans ses salons, jamais sous le nom d'un autre, on ne supprime que ses messages.
- Images : bucket **privé**, 5 Mo, png/jpg/gif/webp seulement, liens signés temporaires, dossier par utilisateur.
- Messages affichés sans HTML (pas de XSS), CSP et en-têtes de sécurité dans `vercel.json`.
- Mot de passe oublié : il n'y a pas d'e-mail de récupération. Réinitialise-le depuis Supabase → Authentication → Users.
- Pour exclure quelqu'un : Supabase → Authentication → Users → supprimer.
- Limite connue : un message de « X écrit… » dans un groupe privé transite par un canal partagé (il révèle seulement un pseudo et un identifiant de groupe, jamais le contenu).
