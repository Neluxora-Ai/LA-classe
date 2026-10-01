-- =====================================================================
--  La Classe : schéma Supabase
--  À coller dans Supabase > SQL Editor > New query > Run (une seule fois).
-- =====================================================================

-- ---------- Tables ----------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  pseudo text not null check (char_length(pseudo) between 2 and 20),
  created_at timestamptz not null default now()
);
create unique index profiles_pseudo_key on public.profiles (lower(pseudo));

create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 30),
  emoji text not null default '💬' check (char_length(emoji) <= 8),
  is_common boolean not null default false,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
-- un seul salon commun possible
create unique index one_common_room on public.rooms (is_common) where is_common;

create table public.room_members (
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  added_by uuid references public.profiles(id) on delete set null,
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id)
);
create index room_members_user_idx on public.room_members (user_id);

create table public.messages (
  id bigint generated always as identity primary key,
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  text text not null default '' check (char_length(text) <= 1000),
  image_path text check (image_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(png|jpg|gif|webp)$'),
  created_at timestamptz not null default now(),
  check (char_length(text) > 0 or image_path is not null)
);
create index messages_room_idx on public.messages (room_id, id desc);

-- table interne pour limiter les essais de code de classe (accessible uniquement par le serveur)
create table public.register_attempts (
  id bigint generated always as identity primary key,
  ip text not null,
  at timestamptz not null default now()
);
create index register_attempts_idx on public.register_attempts (ip, at);

-- ---------- Salon commun ----------
insert into public.rooms (name, emoji, is_common) values ('général', '💬', true);

-- ---------- Fonction d'appartenance ----------
-- Vrai si le salon est le salon commun, ou si l'utilisateur connecté en est membre.
create or replace function public.is_member(rid uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.rooms r where r.id = rid and r.is_common)
      or exists (select 1 from public.room_members m where m.room_id = rid and m.user_id = auth.uid());
$$;

-- ---------- Sécurité par ligne (RLS) ----------
alter table public.profiles enable row level security;
alter table public.rooms enable row level security;
alter table public.room_members enable row level security;
alter table public.messages enable row level security;
alter table public.register_attempts enable row level security;  -- aucune policy = personne sauf le serveur

create policy "profiles: lecture (connectés)" on public.profiles
  for select to authenticated using (true);

create policy "rooms: je vois le commun + mes groupes" on public.rooms
  for select to authenticated using (public.is_member(id));

create policy "membres: visibles par les membres du salon" on public.room_members
  for select to authenticated using (public.is_member(room_id));

create policy "messages: lecture si membre" on public.messages
  for select to authenticated using (public.is_member(room_id));

create policy "messages: écriture si membre, sous mon nom" on public.messages
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and public.is_member(room_id)
    and (image_path is null or image_path like auth.uid()::text || '/%')
  );

create policy "messages: je supprime les miens" on public.messages
  for delete to authenticated using (user_id = auth.uid());

-- Pas de policy d'écriture sur profiles / rooms / room_members : tout passe par les fonctions ci-dessous.

-- ---------- Fonctions (création de groupe, ajout, sortie) ----------
create or replace function public.create_room(p_name text, p_emoji text, p_members uuid[])
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  new_id uuid;
begin
  if auth.uid() is null then raise exception 'non connecté'; end if;
  if char_length(trim(p_name)) not between 1 and 30 then raise exception 'nom invalide'; end if;

  insert into public.rooms (name, emoji, created_by)
  values (trim(p_name), coalesce(nullif(trim(p_emoji), ''), '💬'), auth.uid())
  returning id into new_id;

  insert into public.room_members (room_id, user_id, added_by) values (new_id, auth.uid(), auth.uid());

  insert into public.room_members (room_id, user_id, added_by)
  select new_id, p.id, auth.uid()
  from public.profiles p
  where p.id = any (coalesce(p_members, '{}')) and p.id <> auth.uid()
  on conflict do nothing;

  return new_id;
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
  if not exists (select 1 from public.profiles where id = p_user) then raise exception 'utilisateur inconnu'; end if;
  insert into public.room_members (room_id, user_id, added_by) values (p_room, p_user, auth.uid())
  on conflict do nothing;
end;
$$;

create or replace function public.leave_room(p_room uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'non connecté'; end if;
  delete from public.room_members
  where room_id = p_room and user_id = auth.uid()
    and not exists (select 1 from public.rooms where id = p_room and is_common);
  -- groupe vide : on le supprime (messages inclus)
  delete from public.rooms r
  where r.id = p_room and not r.is_common
    and not exists (select 1 from public.room_members m where m.room_id = r.id);
end;
$$;

revoke all on function public.create_room(text, text, uuid[]) from public, anon;
revoke all on function public.add_room_member(uuid, uuid) from public, anon;
revoke all on function public.leave_room(uuid) from public, anon;
grant execute on function public.create_room(text, text, uuid[]) to authenticated;
grant execute on function public.add_room_member(uuid, uuid) to authenticated;
grant execute on function public.leave_room(uuid) to authenticated;

-- ---------- Temps réel ----------
alter publication supabase_realtime add table public.messages;
alter publication supabase_realtime add table public.room_members;

-- ---------- Stockage des images (bucket privé, 5 Mo, images uniquement) ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('images', 'images', false, 5242880, array['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
on conflict (id) do update
  set public = false, file_size_limit = 5242880,
      allowed_mime_types = array['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

create policy "images: lecture (connectés)" on storage.objects
  for select to authenticated using (bucket_id = 'images');

create policy "images: envoi dans mon dossier" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'images' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "images: je supprime les miennes" on storage.objects
  for delete to authenticated
  using (bucket_id = 'images' and (storage.foldername(name))[1] = auth.uid()::text);
