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
   Puis une 2ᵉ requête avec [`supabase/v3.sql`](supabase/v3.sql) → **Run** (profil, réactions, réponses, messages privés, admin),
   puis une 3ᵉ avec [`supabase/v4.sql`](supabase/v4.sql) → **Run** (photo de profil, bannissement),
   puis une 4ᵉ avec [`supabase/v5.sql`](supabase/v5.sql) → **Run** (apparence, modification, épinglés, sondages, fichiers),
   puis une 5ᵉ avec [`supabase/v6.sql`](supabase/v6.sql) → **Run** (profils complets, infos de la classe, « vu », sourdine, stickers),
   puis une 6ᵉ avec [`supabase/v7.sql`](supabase/v7.sql) → **Run** (nouveaux types de fichiers : audio, vidéo, archives, dossiers en .zip),
   puis une 7ᵉ avec [`supabase/v8.sql`](supabase/v8.sql) → **Run** (limites, anti-flood, journal des admins, double authentification, canaux privés).
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
- **Messages privés** : clique sur un pseudo « En ligne » (ou sur le nom d'un auteur, ou sur ＋ dans « Messages privés »). Une seule conversation par paire de personnes.
- **Réactions et réponses** : passe la souris sur un message (ou appuie dessus sur téléphone) → 😊 réagir, ↩ répondre, 🗑 supprimer.
- **Modifier un message** (✏, tes propres messages) : affiché « (modifié) » chez tout le monde. Un sondage ne se modifie pas.
- **@mentions** : tape `@` puis le début d'un pseudo (↑ ↓ Entrée / Tab). La personne mentionnée voit le message en surbrillance et reçoit une notification, même si elle regarde déjà le salon.
- **Messages épinglés** (📌) : jusqu'à 5 par salon, barre en haut du salon. Dans le salon commun, seuls les admins épinglent ; dans un groupe ou un message privé, tous les membres.
- **Recherche** (🔍) : dans le salon ouvert ou dans tous tes salons ; un clic mène au message (même ancien).
- **Sondages** (📊) : 2 à 6 choix, choix unique ou multiple, votes en direct (le survol d'un choix montre qui a voté), le créateur ou un admin peut le terminer.
- **Fichiers** (📎 ou glisser-déposer, plusieurs à la fois, 10 maximum) : PDF, Word, Excel, PowerPoint, OpenDocument, texte, Markdown, JSON, RTF, CSV, ZIP, 7z, RAR, audio (mp3, m4a, wav, ogg) et vidéo (mp4, webm), 10 Mo max chacun. Stockés dans un bucket privé, téléchargés via des liens temporaires. Pas d'exécutables, ni HTML, ni SVG, ni macros Office. Les fichiers audio se lisent directement dans le chat.
- **Dossiers** (📁 ou glisser-déposer un dossier) : le dossier est compressé en un `.zip` dans ton navigateur puis envoyé comme un fichier (10 Mo au total, 300 fichiers max ; les fichiers système comme `.DS_Store`, `.git` ou `node_modules` sont écartés).
- **Messages vocaux** (🎤) : 1 minute maximum, tu peux les réécouter avant d'envoyer. Le navigateur demande l'autorisation du micro. Enregistrés en `.weba` (Chrome, Firefox, Edge) ou `.m4a` (Safari).
- **Application installable** : le site peut s'installer sur l'écran d'accueil (téléphone ou ordinateur), avec une icône et en plein écran (⚙ → « Application »). Il ouvre même sans réseau (la coquille seulement : les messages restent en direct). Fichiers : `public/manifest.webmanifest`, `public/sw.js`, `public/icons/` (régénérables avec `npm run icons`).
- **Apparence (⚙ Profil)** : thème sombre / clair / automatique, couleur du site (9 thèmes ou n'importe quelle couleur), fond du chat, taille du texte. Réglages synchronisés sur le compte, donc retrouvés sur le téléphone et l'ordinateur.
- **Fiche de profil** : clique sur un pseudo ou un avatar (messages, listes) pour voir surnom, statut, bio, centres d'intérêt, anniversaire et dernière connexion, avec un bouton « Écrire ».
  Tu les règles dans ⚙ → « Mon pseudo » / « Mes infos ». Tout est facultatif et visible des comptes de la classe.
- **Changer de pseudo** (⚙) : une fois par jour. Le pseudo sert aussi à se connecter : après un changement, on se reconnecte avec le nouveau. L'ancien pseudo se libère. Les admins voient l'historique des changements dans la base (table `pseudo_changes`). Route serveur : `api/rename.js`.
- **Infos de la classe** (ℹ️) : emploi du temps, règles, contacts, liens utiles (https uniquement) et anniversaires des 30 prochains jours. Les admins modifient avec ✏.
- **« Vu »** : « ✓✓ Vu » sous ton dernier message dans un message privé, « 👁 Vu par … » dans un groupe. Réglable dans ⚙ → Confidentialité : si tu désactives, tu ne vois pas non plus celles des autres.
- **Dernière connexion** : liste « Hors ligne » avec « il y a 5 min » ; masquable dans ⚙ → Confidentialité (elle est alors effacée, pas seulement cachée).
- **Sourdine** (🔔 en haut du salon) : coupe son et notifications de ce salon pour toi seul ; les @mentions te préviennent quand même.
- **Stickers** (🎟) : emojis géants pour tous (un message de 1 à 3 emojis s'affiche en grand) et stickers de la classe ajoutés par les admins (＋). Retirer un sticker le cache du choix mais les anciens messages le gardent. Les fichiers `.gif` s'envoient comme des images ; une recherche de GIF (Giphy / Tenor) demanderait une clé d'API et n'est pas incluse.
- **Profil (⚙)** : photo de profil (recadrée en carré 256 px, 5 Mo max avant réduction), couleur de l'avatar si pas de photo,
  changement de mot de passe, son et notifications du navigateur (réglages gardés dans ton navigateur).
- **Inscription** : passe par `api/register.js` (fonction Vercel) qui vérifie le code de classe (avec limite d'essais par IP).
  Mot de passe de **8 caractères minimum**, saisi **deux fois**, avec barre de force et bouton œil.
- **Connexion** : pseudo + mot de passe (Supabase Auth, mots de passe hachés par Supabase).

## Admin

Un admin peut supprimer n'importe quel message et gérer les comptes depuis le **panneau admin 🛡** (barre latérale) :
- **Supprimer** : le compte, ses messages et ses réactions sont effacés ; la personne peut se réinscrire avec le code de classe.
- **Bannir** : pareil, et en plus le pseudo ne peut plus créer de compte (même avec des majuscules). Raison facultative, visible seulement des admins.
- **Débannir** : redonne le droit de s'inscrire.

Limite du bannissement : il porte sur le **pseudo**. Quelqu'un de déterminé peut s'inscrire avec un autre pseudo
(on ne bannit pas par adresse IP, pour ne pas bloquer toute une classe sur le même Wi-Fi). Dans ce cas, **change le code de classe**
(variable `CLASS_CODE` dans Vercel, puis redéploie).

Un admin ne peut ni supprimer/bannir un autre admin, ni lui-même.

Pour nommer un admin, dans Supabase → SQL Editor :
```sql
update public.profiles set is_admin = true where pseudo = 'LePseudo';
```
(en mode démo, le premier compte créé est admin.)

## Limites

- **50 messages par conversation** : dès que le 51ᵉ arrive, le plus ancien est supprimé (messages privés, groupes et salon commun, chacun séparément). Les sondages, épinglés et réactions du message supprimé partent avec lui ; ses fichiers sont retirés du stockage par le nettoyage quotidien. Ça s'applique aux messages épinglés aussi.
- **20 comptes maximum** : au-delà, l'inscription est refusée (« La classe est complète »). Les comptes déjà existants ne sont jamais supprimés automatiquement : un admin les retire depuis le panneau 🛡, qui affiche « Comptes : N / 20 ».
- **Changer ces nombres** (Supabase → SQL Editor) :
  ```sql
  update public.app_limits set value = 30 where key = 'max_accounts';   -- comptes
  update public.app_limits set value = 100 where key = 'keep_messages'; -- messages gardés par conversation
  ```

## Sécurité

- **Anti-abus** : 8 messages max en 10 secondes et 30 par minute par personne ; 20 réactions en 10 secondes ; 15 envois de fichiers par minute ; inscriptions limitées à 10 par heure et par connexion internet ; 10 essais ratés du code de classe par IP.
- **Pseudos** : les pseudos qui imitent l'autorité (admin, modérateur, prof, système…) et ceux qui mélangent plusieurs alphabets (a latin + а cyrillique) sont refusés, pour éviter l'usurpation.
- **Mots de passe** : 8 caractères minimum, refus des mots de passe trop courants (`password123`, `azertyuiop`…) et de ceux qui contiennent le pseudo. Après un changement de mot de passe, les autres appareils sont déconnectés ; ⚙ → « Déconnecter tous mes appareils » existe aussi.
- **Double authentification (⚙ → Sécurité du compte)** : code à 6 chiffres d'une application (Google Authenticator, Microsoft Authenticator, Authy…). Pour un **admin qui l'a activée, les pouvoirs admin ne marchent plus sans le code**, même si quelqu'un connaît son mot de passe (c'est vérifié par la base, pas seulement par le site). Conseillée à tous les admins.
- **Journal des admins** (panneau 🛡) : suppression de comptes et de messages d'autres personnes, bannissements, modifications des infos de la classe et des stickers. Visible seulement des admins ; les 500 dernières lignes sont gardées.
- **Temps réel** : les canaux de présence et de « X écrit… » sont privés et ne transportent que des identifiants (jamais de pseudo). Pour aller plus loin, dans Supabase → Realtime → Settings, désactive « Allow public access ».
- **Appels serveur** : `api/*` refuse les appels venus d'un autre site (contrôle de l'origine). Le nettoyage quotidien `api/cleanup.js` (tâche planifiée Vercel) est protégé par la variable secrète `CRON_SECRET` ; il supprime les fichiers du stockage qui ne servent plus.
- **En-têtes** : CSP stricte (aucun script ni style en ligne), HSTS, `X-Frame-Options`, isolation des fenêtres (COOP / CORP), micro autorisé seulement pour le site lui-même.

- Règles RLS Postgres : on ne lit/écrit que dans ses salons, jamais sous le nom d'un autre, on ne supprime que ses messages.
- Images : bucket **privé**, 5 Mo, png/jpg/gif/webp seulement, liens signés temporaires, dossier par utilisateur.
- Messages affichés sans HTML (pas de XSS), CSP et en-têtes de sécurité dans `vercel.json`.
- Mot de passe oublié : il n'y a pas d'e-mail de récupération. Réinitialise-le depuis Supabase → Authentication → Users.
- Pour exclure quelqu'un : Supabase → Authentication → Users → supprimer.
- Les messages privés n'ont que deux membres, personne d'autre ne peut les lire (RLS) ; l'admin non plus depuis le site.
- Le code de classe se change dans Vercel (variable `CLASS_CODE`, puis redéployer) et dans `.env` en local ; il est sensible aux majuscules.
- Limite connue : quand quelqu'un retire une réaction, l'événement temps réel (qui contient l'identifiant du message, de la personne et l'emoji, jamais le texte) est visible par les autres comptes connectés, même hors du salon.
- Limite connue : un message de « X écrit… » dans un groupe privé transite par un canal partagé (il révèle seulement un pseudo et un identifiant de groupe, jamais le contenu).
