-- =====================================================================
--  La Classe : mise à jour v3 (profil, réactions, réponses, messages privés, admin)
--  À exécuter APRÈS schema.sql (SQL Editor > New query > Run), une seule fois.
-- =====================================================================

-- ---------- Profil : couleur d'avatar + rôle admin ----------
alter table public.profiles
  add column color text not null default '' check (color = '' or color ~ '^#[0-9a-fA-F]{6}$'),
  add column is_admin boolean not null default false;

-- ---------- Messages privés (1 à 1) ----------
alter table public.rooms add column is_dm boolean not null default false;

-- ---------- Réponses ----------
alter table public.messages add column reply_to bigint references public.messages(id) on delete set null;

-- ---------- Fonctions utilitaires ----------
create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

create or replace function public.message_room(mid bigint)
returns uuid
language sql stable security definer set search_path = public
as $$
  select room_id from public.messages where id = mid;
$$;

revoke all on function public.is_admin() from public, anon;
revoke all on function public.message_room(bigint) from public, anon;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.message_room(bigint) to authenticated;

-- ---------- Réactions ----------
create table public.message_reactions (
  message_id bigint not null references public.messages(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  emoji text not null check (char_length(emoji) between 1 and 16),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);
create index message_reactions_msg_idx on public.message_reactions (message_id);
alter table public.message_reactions enable row level security;

create policy "reactions: lecture si membre du salon" on public.message_reactions
  for select to authenticated using (public.is_member(public.message_room(message_id)));

create policy "reactions: j'ajoute les miennes (max 10 par message)" on public.message_reactions
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and public.is_member(public.message_room(message_id))
    and (select count(*) from public.message_reactions r where r.message_id = message_reactions.message_id and r.user_id = auth.uid()) < 10
  );

create policy "reactions: je retire les miennes" on public.message_reactions
  for delete to authenticated using (user_id = auth.uid());

-- ---------- Politiques des messages : réponse dans le même salon, suppression admin ----------
drop policy "messages: écriture si membre, sous mon nom" on public.messages;
create policy "messages: écriture si membre, sous mon nom" on public.messages
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and public.is_member(room_id)
    and (image_path is null or image_path like auth.uid()::text || '/%')
    and (reply_to is null or public.message_room(reply_to) = room_id)
  );

drop policy "messages: je supprime les miens" on public.messages;
create policy "messages: je supprime les miens (ou admin)" on public.messages
  for delete to authenticated using (user_id = auth.uid() or public.is_admin());

-- ---------- Fonctions : couleur, MP, exclusion ----------
create or replace function public.set_my_color(p_color text)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'non connecté'; end if;
  if p_color <> '' and p_color !~ '^#[0-9a-fA-F]{6}$' then raise exception 'couleur invalide'; end if;
  update public.profiles set color = p_color where id = auth.uid();
end;
$$;

create or replace function public.create_dm(p_user uuid)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  rid uuid;
begin
  if auth.uid() is null then raise exception 'non connecté'; end if;
  if p_user = auth.uid() then raise exception 'tu ne peux pas t''écrire à toi-même'; end if;
  if not exists (select 1 from public.profiles where id = p_user) then raise exception 'utilisateur inconnu'; end if;

  select r.id into rid
  from public.rooms r
  where r.is_dm
    and exists (select 1 from public.room_members m where m.room_id = r.id and m.user_id = auth.uid())
    and exists (select 1 from public.room_members m where m.room_id = r.id and m.user_id = p_user)
  limit 1;
  if rid is not null then return rid; end if;

  insert into public.rooms (name, emoji, is_dm, created_by) values ('message privé', '💬', true, auth.uid())
  returning id into rid;
  insert into public.room_members (room_id, user_id, added_by)
  values (rid, auth.uid(), auth.uid()), (rid, p_user, auth.uid());
  return rid;
end;
$$;

create or replace function public.add_room_member(p_room uuid, p_user uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_member(p_room) then raise exception 'interdit'; end if;
  if exists (select 1 from public.rooms where id = p_room and is_common) then
    raise exception 'le salon commun est déjà ouvert à tous';
  end if;
  if exists (select 1 from public.rooms where id = p_room and is_dm) then
    raise exception 'on ne peut pas ajouter quelqu''un à un message privé';
  end if;
  if not exists (select 1 from public.profiles where id = p_user) then raise exception 'utilisateur inconnu'; end if;
  insert into public.room_members (room_id, user_id, added_by) values (p_room, p_user, auth.uid())
  on conflict do nothing;
end;
$$;

create or replace function public.admin_kick(p_user uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'interdit'; end if;
  if p_user = auth.uid() then raise exception 'tu ne peux pas t''exclure toi-même'; end if;
  if exists (select 1 from public.profiles where id = p_user and is_admin) then
    raise exception 'impossible d''exclure un admin';
  end if;
  -- supprime le compte : profil, messages, réactions et appartenances partent en cascade
  delete from auth.users where id = p_user;
end;
$$;

revoke all on function public.set_my_color(text) from public, anon;
revoke all on function public.create_dm(uuid) from public, anon;
revoke all on function public.admin_kick(uuid) from public, anon;
grant execute on function public.set_my_color(text) to authenticated;
grant execute on function public.create_dm(uuid) to authenticated;
grant execute on function public.admin_kick(uuid) to authenticated;

alter publication supabase_realtime add table public.message_reactions;

-- ---------- Nommer un admin (remplace PSEUDO, à lancer à la main) ----------
-- update public.profiles set is_admin = true where pseudo = 'PSEUDO';

-- ---------- Contrôle des inscriptions (voir README) ----------
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
  return null;
end;
$$;
revoke all on function public.only_class_signups() from public, anon, authenticated;
drop trigger if exists only_class_signups on auth.users;
create constraint trigger only_class_signups
  after insert on auth.users
  deferrable initially deferred
  for each row execute function public.only_class_signups();
