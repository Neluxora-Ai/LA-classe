-- =====================================================================
--  La Classe : mise à jour v8 (limites + sécurité)
--  - 50 messages maximum par conversation (les plus anciens sont supprimés)
--  - 20 comptes maximum
--  - anti-flood (messages, réactions, envois de fichiers), pseudos réservés
--  - journal des actions des admins, double authentification pour les admins
--  - canaux temps réel privés
--  À exécuter APRÈS schema.sql, v3 à v7, une seule fois.
-- =====================================================================

-- ---------- Limites réglables (modifiables en SQL, voir README) ----------
create table public.app_limits (
  key text primary key,
  value int not null check (value > 0)
);
insert into public.app_limits (key, value) values ('max_accounts', 20), ('keep_messages', 50);
alter table public.app_limits enable row level security;
create policy "limites: lecture (connectés)" on public.app_limits
  for select to authenticated using (true);

create or replace function public.app_limit(k text)
returns int
language sql stable security definer set search_path = public
as $$
  select value from public.app_limits where key = k;
$$;
revoke all on function public.app_limit(text) from public, anon;
grant execute on function public.app_limit(text) to authenticated;

-- ---------- 50 messages maximum par conversation ----------
create or replace function public.prune_room(p_room uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  keep int := coalesce(public.app_limit('keep_messages'), 50);
begin
  perform set_config('app.skip_log', '1', true); -- ce n'est pas une suppression faite par un admin
  -- on garde les `keep` derniers : tout ce qui est plus ancien que le (keep+1)ᵉ message le plus récent part
  delete from public.messages m
  where m.room_id = p_room
    and m.id <= (select id from public.messages where room_id = p_room order by id desc offset keep limit 1);
end;
$$;
revoke all on function public.prune_room(uuid) from public, anon, authenticated;

create or replace function public.trim_room_messages()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  perform public.prune_room(new.room_id);
  return null;
end;
$$;
revoke all on function public.trim_room_messages() from public, anon, authenticated;
create trigger trim_room_messages
  after insert on public.messages
  for each row execute function public.trim_room_messages();

-- ---------- 20 comptes maximum ----------
create or replace function public.cap_accounts()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if (select count(*) from public.profiles) >= coalesce(public.app_limit('max_accounts'), 20) then
    raise exception 'La classe est complète (% comptes maximum).', coalesce(public.app_limit('max_accounts'), 20);
  end if;
  return new;
end;
$$;
revoke all on function public.cap_accounts() from public, anon, authenticated;
create trigger cap_accounts
  before insert on public.profiles
  for each row execute function public.cap_accounts();

-- le contrôle des inscriptions vérifie aussi le plafond (défense en plus, côté comptes d'authentification)
create or replace function public.only_class_signups()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  meta jsonb;
begin
  select u.raw_app_meta_data into meta from auth.users u where u.id = new.id;
  if not found then
    return null;
  end if;
  if coalesce(meta ->> 'via', '') <> 'class-register' then
    raise exception 'Inscription refusee : utilise le code de classe.';
  end if;
  if (select count(*) from auth.users) > coalesce(public.app_limit('max_accounts'), 20) then
    raise exception 'La classe est complète.';
  end if;
  return null;
end;
$$;

-- ---------- Anti-flood ----------
create index messages_user_time_idx on public.messages (user_id, created_at desc);

create or replace function public.flood_messages()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if (select count(*) from public.messages where user_id = new.user_id and created_at > now() - interval '10 seconds') >= 8 then
    raise exception 'Doucement ! Tu envoies trop de messages à la suite.';
  end if;
  if (select count(*) from public.messages where user_id = new.user_id and created_at > now() - interval '1 minute') >= 30 then
    raise exception 'Trop de messages en une minute : attends un peu.';
  end if;
  return new;
end;
$$;
revoke all on function public.flood_messages() from public, anon, authenticated;
create trigger flood_messages
  before insert on public.messages
  for each row execute function public.flood_messages();

create or replace function public.flood_reactions()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if (select count(*) from public.message_reactions where user_id = new.user_id and created_at > now() - interval '10 seconds') >= 20 then
    raise exception 'Doucement ! Trop de réactions à la suite.';
  end if;
  return new;
end;
$$;
revoke all on function public.flood_reactions() from public, anon, authenticated;
create trigger flood_reactions
  before insert on public.message_reactions
  for each row execute function public.flood_reactions();

-- envois de fichiers / images : 15 par minute et par personne
drop policy "images: envoi dans mon dossier" on storage.objects;
create policy "images: envoi dans mon dossier" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'images' and (storage.foldername(name))[1] = auth.uid()::text
    and (select count(*) from storage.objects o where o.owner_id = auth.uid()::text and o.created_at > now() - interval '1 minute') < 15
  );
drop policy "files: envoi dans mon dossier" on storage.objects;
create policy "files: envoi dans mon dossier" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'files' and (storage.foldername(name))[1] = auth.uid()::text
    and (select count(*) from storage.objects o where o.owner_id = auth.uid()::text and o.created_at > now() - interval '1 minute') < 15
  );

-- compteur d'appels pour les routes serveur (inscription, changement de pseudo…) : réservé au serveur
create table public.rate_limits (
  id bigint generated always as identity primary key,
  key text not null,
  at timestamptz not null default now()
);
create index rate_limits_key_idx on public.rate_limits (key, at);
alter table public.rate_limits enable row level security; -- aucune policy : personne sauf le serveur

-- ---------- Pseudos réservés (anti-usurpation) ----------
create or replace function public.reserved_pseudos()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.is_admin then
    return new;
  end if;
  if lower(regexp_replace(new.pseudo, '[\s_-]+', '', 'g')) in
     ('admin', 'administrateur', 'administrator', 'moderateur', 'moderator', 'modo', 'staff', 'support', 'system', 'systeme', 'système', 'root', 'delegue', 'délégué', 'prof', 'professeur', 'direction') then
    raise exception 'Ce pseudo est réservé.';
  end if;
  return new;
end;
$$;
revoke all on function public.reserved_pseudos() from public, anon, authenticated;
create trigger reserved_pseudos
  before insert or update of pseudo on public.profiles
  for each row execute function public.reserved_pseudos();

-- ---------- Journal des actions des admins ----------
create table public.admin_log (
  id bigint generated always as identity primary key,
  admin_id uuid references public.profiles(id) on delete set null,
  admin_pseudo text not null,
  action text not null,
  target text,
  detail text,
  at timestamptz not null default now()
);
create index admin_log_at_idx on public.admin_log (at desc);
alter table public.admin_log enable row level security;

-- les admins qui ont activé la double authentification doivent l'avoir validée (niveau aal2) pour agir
create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce((select p.is_admin from public.profiles p where p.id = auth.uid()), false)
     and (
       coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
       or not exists (select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status = 'verified')
     );
$$;

create policy "journal: lecture admin" on public.admin_log
  for select to authenticated using (public.is_admin());

create or replace function public.log_admin(p_action text, p_target text, p_detail text default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  ap text;
begin
  select pseudo into ap from public.profiles where id = auth.uid();
  insert into public.admin_log (admin_id, admin_pseudo, action, target, detail)
  values (auth.uid(), coalesce(ap, '?'), p_action, p_target, left(p_detail, 120));
end;
$$;
revoke all on function public.log_admin(text, text, text) from public, anon, authenticated;

-- suppression d'un message par un admin (pas la sienne, pas un nettoyage automatique)
create or replace function public.log_message_delete()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if coalesce(current_setting('app.skip_log', true), '') <> '1'
     and auth.uid() is not null and old.user_id <> auth.uid() and public.is_admin() then
    perform public.log_admin('supprimer un message', (select pseudo from public.profiles where id = old.user_id), left(old.text, 60));
  end if;
  return null;
end;
$$;
revoke all on function public.log_message_delete() from public, anon, authenticated;
create trigger log_message_delete
  after delete on public.messages
  for each row execute function public.log_message_delete();

-- suppression d'un compte par un admin
create or replace function public.log_profile_delete()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is not null and old.id <> auth.uid() and public.is_admin() then
    perform set_config('app.skip_log', '1', true); -- ses messages partent avec lui : un seul enregistrement suffit
    if coalesce(current_setting('app.skip_account_log', true), '') <> '1' then
      perform public.log_admin('supprimer le compte', old.pseudo, null);
    end if;
  end if;
  return old;
end;
$$;
revoke all on function public.log_profile_delete() from public, anon, authenticated;
create trigger log_profile_delete
  before delete on public.profiles
  for each row execute function public.log_profile_delete();

create or replace function public.log_ban()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform set_config('app.skip_account_log', '1', true); -- le bannissement inclut la suppression du compte
    perform public.log_admin('bannir', new.pseudo, new.reason);
  else
    perform public.log_admin('débannir', old.pseudo, null);
  end if;
  return null;
end;
$$;
revoke all on function public.log_ban() from public, anon, authenticated;
create trigger log_ban
  after insert or delete on public.banned_users
  for each row execute function public.log_ban();

create or replace function public.log_class_info()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  perform public.log_admin('modifier les infos de la classe', null, null);
  return null;
end;
$$;
revoke all on function public.log_class_info() from public, anon, authenticated;
create trigger log_class_info
  after update on public.class_info
  for each row execute function public.log_class_info();

create or replace function public.log_stickers()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform public.log_admin('ajouter un sticker', new.name, null);
  elsif old.active and not new.active then
    perform public.log_admin('retirer un sticker', new.name, null);
  end if;
  return null;
end;
$$;
revoke all on function public.log_stickers() from public, anon, authenticated;
create trigger log_stickers
  after insert or update of active on public.stickers
  for each row execute function public.log_stickers();

-- quitter un groupe peut supprimer la salle et ses messages : pas à journaliser
create or replace function public.leave_room(p_room uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'non connecté'; end if;
  perform set_config('app.skip_log', '1', true);
  delete from public.room_members
  where room_id = p_room and user_id = auth.uid()
    and not exists (select 1 from public.rooms where id = p_room and is_common);
  delete from public.rooms r
  where r.id = p_room and not r.is_common
    and not exists (select 1 from public.room_members m where m.room_id = r.id);
end;
$$;

-- ---------- Canaux temps réel privés (réservés aux comptes connectés) ----------
create policy "classe: realtime lecture (connectés)" on realtime.messages
  for select to authenticated using (true);
create policy "classe: realtime écriture (connectés)" on realtime.messages
  for insert to authenticated with check (true);
