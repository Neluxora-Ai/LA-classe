// Copie la librairie Supabase (navigateur) dans public/vendor pour ne dépendre d'aucun CDN.
import fs from 'node:fs';
const src = 'node_modules/@supabase/supabase-js/dist/umd/supabase.js';
if (fs.existsSync(src)) {
  fs.mkdirSync('public/vendor', { recursive: true });
  fs.copyFileSync(src, 'public/vendor/supabase.js');
  console.log('vendor: supabase.js copié');
}
