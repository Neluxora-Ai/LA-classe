-- =====================================================================
--  La Classe : mise à jour v6
--  (profils complets, infos de la classe, « vu », dernière connexion, sourdine, stickers)
--  À exécuter APRÈS schema.sql, v3.sql, v4.sql et v5.sql, une seule fois.
-- =====================================================================

-- ---------- Profils : surnom, bio, statut, anniversaire, intérêts, dernière connexion ----------
alter table public.profiles
  add column nickname text check (nickname is null or char_length(nickname) between 1 and 30),
  add column bio text check (bio is null or char_length(bio) <= 200),
  add column status text check (status is null or char_length(status) <= 40),
  add column birthday text check (birthday is null or birthday ~ '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'),
  add column interests text check (interests is null or char_length(interests) <= 120),
  add column last_seen timestamptz,
  add column pseudo_changed_at timestamptz;

create or replace function public.set_my_profile(p_nickname text, p_bio text, p_status text, p_birthday text, p_interests text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  n text := nullif(trim(coalesce(p_nickname, '')), '');
  b text := nullif(trim(coalesce(p_bio, '')), '');
  s text := nullif(trim(coalesce(p_status, '')), '');
  d text := nullif(trim(coalesce(p_birthday, '')), '');
  i text := nullif(trim(coalesce(p_interests, '')), '');
begin
  if auth.uid() is null then raise exception 'non connecté'; end if;
  if n is not null and char_length(n) > 30 then raise exception 'surnom trop long (30 caractères max)'; end if;
  if b is not null and char_length(b) > 200 then raise exception 'bio trop longue (200 caractères max)'; end if;
  if s is not null and char_length(s) > 40 then raise exception 'statut trop long (40 caractères max)'; end if;
  if i is not null and char_length(i) > 120 then raise exception 'centres d''intérêt trop longs (120 caractères max)'; end if;
  if d is not null then
    if d !~ '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$' then raise exception 'anniversaire invalide'; end if;
    begin
      perform make_date(2000, substr(d, 1, 2)::int, substr(d, 4, 2)::int);
    exception when others then
      raise exception 'anniversaire invalide';
    end;
  end if;
  update public.profiles set nickname = n, bio = b, status = s, birthday = d, interests = i where id = auth.uid();
end;
$$;
revoke all on function public.set_my_profile(text, text, text, text, text) from public, anon;
grant execute on function public.set_my_profile(text, text, text, text, text) to authenticated;

-- historique des changements de pseudo (visible des admins ; écrit par le serveur /api/rename)
create table public.pseudo_changes (
  id bigint generated always as identity primary key,
  user_id uuid references public.profiles(id) on delete cascade,
  old_pseudo text not null,
  new_pseudo text not null,
  at timestamptz not null default now()
);
alter table public.pseudo_changes enable row level security;
create policy "pseudos: lecture admin" on public.pseudo_changes
  for select to authenticated using (public.is_admin());

-- ---------- Réglages : on ajoute « vu » et « dernière connexion » ----------
create or replace function public.set_my_settings(p_settings jsonb)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  k text;
  v text;
  clean jsonb := '{}'::jsonb;
begin
  if auth.uid() is null then raise exception 'non connecté'; end if;
  if p_settings is null or jsonb_typeof(p_settings) <> 'object' then raise exception 'réglages invalides'; end if;
  for k, v in select key, value #>> '{}' from jsonb_each(p_settings) loop
    if k in ('accent', 'accent2') then
      if v !~ '^#[0-9a-fA-F]{6}$' then raise exception 'couleur invalide'; end if;
    elsif k = 'theme' then
      if v not in ('dark', 'light', 'auto') then raise exception 'thème invalide'; end if;
    elsif k = 'bg' then
      if v not in ('none', 'aurora', 'dots', 'grid', 'dusk', 'mint') then raise exception 'fond invalide'; end if;
    elsif k = 'font' then
      if v not in ('s', 'm', 'l') then raise exception 'taille invalide'; end if;
    elsif k in ('receipts', 'lastseen') then
      if v not in ('on', 'off') then raise exception 'réglage invalide'; end if;
    else
      raise exception 'réglage inconnu';
    end if;
    clean := clean || jsonb_build_object(k, v);
  end loop;
  update public.profiles
  set settings = clean,
      last_seen = case when clean ->> 'lastseen' = 'off' then null else last_seen end
  where id = auth.uid();
end;
$$;

create or replace function public.touch_last_seen()
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null then return; end if;
  update public.profiles set last_seen = now()
  where id = auth.uid() and coalesce(settings ->> 'lastseen', 'on') <> 'off';
end;
$$;
revoke all on function public.touch_last_seen() from public, anon;
grant execute on function public.touch_last_seen() to authenticated;

-- ---------- Infos de la classe (modifiables par les admins) ----------
create table public.class_info (
  id int primary key check (id = 1),
  content jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);
insert into public.class_info (id) values (1);
alter table public.class_info enable row level security;
create policy "infos: lecture (connectés)" on public.class_info
  for select to authenticated using (true);

create or replace function public.set_class_info(p_content jsonb)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  k text;
  v text;
  clean jsonb := '{}'::jsonb;
  links jsonb := '[]'::jsonb;
  l jsonb;
  t text;
  u text;
begin
  if not public.is_admin() then raise exception 'interdit'; end if;
  if p_content is null or jsonb_typeof(p_content) <> 'object' then raise exception 'contenu invalide'; end if;
  foreach k in array array['schedule', 'rules', 'contacts'] loop
    v := p_content ->> k;
    if v is not null then
      if char_length(v) > 3000 then raise exception '% trop long (3000 caractères max)', k; end if;
      clean := clean || jsonb_build_object(k, v);
    end if;
  end loop;
  if p_content ? 'links' then
    if jsonb_typeof(p_content -> 'links') <> 'array' then raise exception 'liens invalides'; end if;
    if jsonb_array_length(p_content -> 'links') > 20 then raise exception '20 liens maximum'; end if;
    for l in select * from jsonb_array_elements(p_content -> 'links') loop
      t := trim(coalesce(l ->> 'title', ''));
      u := trim(coalesce(l ->> 'url', ''));
      if char_length(t) not between 1 and 60 then raise exception 'titre de lien invalide (1 à 60 caractères)'; end if;
      if char_length(u) > 300 or u !~ '^https://[^[:space:]<>"]+$' or char_length(u) < 11 then
        raise exception 'adresse invalide (https:// uniquement, 300 caractères max) : %', t;
      end if;
      links := links || jsonb_build_array(jsonb_build_object('title', t, 'url', u));
    end loop;
    clean := clean || jsonb_build_object('links', links);
  end if;
  update public.class_info set content = clean, updated_at = now(), updated_by = auth.uid() where id = 1;
end;
$$;
revoke all on function public.set_class_info(jsonb) from public, anon;
grant execute on function public.set_class_info(jsonb) to authenticated;

-- ---------- « Vu » (confirmations de lecture) ----------
create table public.room_reads (
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  last_read_id bigint not null,
  updated_at timestamptz not null default now(),
  primary key (room_id, user_id)
);
alter table public.room_reads enable row level security;
create policy "vu: lecture si membre" on public.room_reads
  for select to authenticated using (public.is_member(room_id));

create or replace function public.mark_read(p_room uuid, p_id bigint)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'non connecté'; end if;
  if not public.is_member(p_room) then raise exception 'interdit'; end if;
  if not exists (select 1 from public.messages where id = p_id and room_id = p_room) then
    raise exception 'message introuvable';
  end if;
  insert into public.room_reads (room_id, user_id, last_read_id) values (p_room, auth.uid(), p_id)
  on conflict (room_id, user_id) do update
    set last_read_id = greatest(public.room_reads.last_read_id, excluded.last_read_id), updated_at = now();
end;
$$;
revoke all on function public.mark_read(uuid, bigint) from public, anon;
grant execute on function public.mark_read(uuid, bigint) to authenticated;

-- ---------- Sourdine d'un salon (privée à chacun) ----------
create table public.room_prefs (
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  muted boolean not null default false,
  primary key (room_id, user_id)
);
alter table public.room_prefs enable row level security;
create policy "sourdine: je vois la mienne" on public.room_prefs
  for select to authenticated using (user_id = auth.uid());
create policy "sourdine: j'ajoute la mienne" on public.room_prefs
  for insert to authenticated with check (user_id = auth.uid() and public.is_member(room_id));
create policy "sourdine: je modifie la mienne" on public.room_prefs
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "sourdine: je supprime la mienne" on public.room_prefs
  for delete to authenticated using (user_id = auth.uid());

-- ---------- Stickers de la classe (ajoutés par les admins) ----------
create table public.stickers (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 30),
  path text not null check (path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(png|jpg|gif|webp)$'),
  active boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.stickers enable row level security;
create policy "stickers: lecture (connectés)" on public.stickers
  for select to authenticated using (true);

create or replace function public.add_sticker(p_name text, p_path text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  n text := trim(coalesce(p_name, ''));
  sid uuid;
begin
  if not public.is_admin() then raise exception 'interdit'; end if;
  if char_length(n) not between 1 and 30 then raise exception 'nom invalide (1 à 30 caractères)'; end if;
  if split_part(p_path, '/', 1) <> auth.uid()::text then raise exception 'image invalide'; end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'images' and o.name = p_path) then
    raise exception 'image introuvable';
  end if;
  if (select count(*) from public.stickers where active) >= 60 then raise exception '60 stickers maximum'; end if;
  insert into public.stickers (name, path, created_by) values (n, p_path, auth.uid()) returning id into sid;
  return sid;
end;
$$;

create or replace function public.remove_sticker(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'interdit'; end if;
  -- on le retire du choix mais on garde l'image : les anciens messages continuent de l'afficher
  update public.stickers set active = false where id = p_id;
end;
$$;
revoke all on function public.add_sticker(text, text) from public, anon;
revoke all on function public.remove_sticker(uuid) from public, anon;
grant execute on function public.add_sticker(text, text) to authenticated;
grant execute on function public.remove_sticker(uuid) to authenticated;

alter table public.messages add column sticker_id uuid references public.stickers(id);

alter table public.messages drop constraint messages_content_check;
alter table public.messages
  add constraint messages_content_check
  check (char_length(text) > 0 or image_path is not null or file_path is not null or sticker_id is not null);

drop policy "messages: écriture si membre, sous mon nom" on public.messages;
create policy "messages: écriture si membre, sous mon nom" on public.messages
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and public.is_member(room_id)
    and (image_path is null or image_path like auth.uid()::text || '/%')
    and (file_path is null or file_path like auth.uid()::text || '/%')
    and (reply_to is null or public.message_room(reply_to) = room_id)
    and (sticker_id is null or exists (select 1 from public.stickers s where s.id = sticker_id and s.active))
  );

-- ---------- Temps réel ----------
alter publication supabase_realtime add table public.room_reads;
