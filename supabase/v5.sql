-- =====================================================================
--  La Classe : mise à jour v5
--  (apparence, modification de messages, épinglés, sondages, fichiers)
--  À exécuter APRÈS schema.sql, v3.sql et v4.sql, une seule fois.
-- =====================================================================

-- ---------- Apparence (synchronisée sur le compte) ----------
alter table public.profiles
  add column settings jsonb not null default '{}'::jsonb
  check (jsonb_typeof(settings) = 'object' and octet_length(settings::text) <= 600);

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
    else
      raise exception 'réglage inconnu';
    end if;
    clean := clean || jsonb_build_object(k, v);
  end loop;
  update public.profiles set settings = clean where id = auth.uid();
end;
$$;
revoke all on function public.set_my_settings(jsonb) from public, anon;
grant execute on function public.set_my_settings(jsonb) to authenticated;

-- ---------- Messages : modification et fichiers ----------
alter table public.messages
  add column edited_at timestamptz,
  add column file_path text check (file_path is null or file_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(pdf|txt|csv|zip|doc|docx|xls|xlsx|ppt|pptx|odt|ods|odp)$'),
  add column file_name text check (file_name is null or (char_length(file_name) between 1 and 120 and file_name !~ '[/\\]')),
  add column file_size integer check (file_size is null or file_size between 0 and 10485760),
  add constraint messages_file_check check ((file_path is null) = (file_name is null));

-- l'ancien contrôle « texte ou image » devient « texte, image ou fichier »
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.messages'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) like '%char_length(text) > 0%'
  loop
    execute format('alter table public.messages drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.messages
  add constraint messages_content_check check (char_length(text) > 0 or image_path is not null or file_path is not null);

drop policy "messages: écriture si membre, sous mon nom" on public.messages;
create policy "messages: écriture si membre, sous mon nom" on public.messages
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and public.is_member(room_id)
    and (image_path is null or image_path like auth.uid()::text || '/%')
    and (file_path is null or file_path like auth.uid()::text || '/%')
    and (reply_to is null or public.message_room(reply_to) = room_id)
  );

-- ---------- Stockage des fichiers (bucket privé, 10 Mo, documents uniquement) ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('files', 'files', false, 10485760, array[
  'application/pdf', 'text/plain', 'text/csv', 'application/zip', 'application/x-zip-compressed',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text', 'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation'
])
on conflict (id) do update
  set public = false, file_size_limit = 10485760, allowed_mime_types = excluded.allowed_mime_types;

create policy "files: lecture (connectés)" on storage.objects
  for select to authenticated using (bucket_id = 'files');
create policy "files: envoi dans mon dossier" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'files' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "files: je supprime les miens" on storage.objects
  for delete to authenticated
  using (bucket_id = 'files' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "fichiers et images: l'admin supprime" on storage.objects
  for delete to authenticated
  using (bucket_id in ('images', 'files') and public.is_admin());

-- ---------- Modifier un message ----------
create or replace function public.edit_message(p_id bigint, p_text text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  m public.messages;
  t text := trim(coalesce(p_text, ''));
begin
  if auth.uid() is null then raise exception 'non connecté'; end if;
  select * into m from public.messages where id = p_id and user_id = auth.uid();
  if not found then raise exception 'interdit'; end if;
  if char_length(t) > 1000 then raise exception 'message trop long'; end if;
  if t = '' and m.image_path is null and m.file_path is null then raise exception 'le message ne peut pas être vide'; end if;
  if exists (select 1 from public.polls where message_id = p_id) then raise exception 'on ne modifie pas un sondage'; end if;
  update public.messages set text = t, edited_at = now() where id = p_id;
end;
$$;
revoke all on function public.edit_message(bigint, text) from public, anon;
grant execute on function public.edit_message(bigint, text) to authenticated;

-- ---------- Messages épinglés ----------
create table public.pinned_messages (
  message_id bigint primary key references public.messages(id) on delete cascade,
  room_id uuid not null references public.rooms(id) on delete cascade,
  pinned_by uuid references public.profiles(id) on delete set null,
  pinned_at timestamptz not null default now()
);
create index pinned_messages_room_idx on public.pinned_messages (room_id);
alter table public.pinned_messages enable row level security;
create policy "épinglés: lecture si membre" on public.pinned_messages
  for select to authenticated using (public.is_member(room_id));

create or replace function public.pin_message(p_id bigint, p_pin boolean)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  rid uuid := public.message_room(p_id);
begin
  if auth.uid() is null then raise exception 'non connecté'; end if;
  if rid is null then raise exception 'message introuvable'; end if;
  if not public.is_member(rid) then raise exception 'interdit'; end if;
  if exists (select 1 from public.rooms where id = rid and is_common) and not public.is_admin() then
    raise exception 'seul un admin peut épingler dans le salon commun';
  end if;
  if p_pin then
    if not exists (select 1 from public.pinned_messages where message_id = p_id)
       and (select count(*) from public.pinned_messages where room_id = rid) >= 5 then
      raise exception '5 messages épinglés maximum par salon';
    end if;
    insert into public.pinned_messages (message_id, room_id, pinned_by) values (p_id, rid, auth.uid())
    on conflict do nothing;
  else
    delete from public.pinned_messages where message_id = p_id;
  end if;
end;
$$;
revoke all on function public.pin_message(bigint, boolean) from public, anon;
grant execute on function public.pin_message(bigint, boolean) to authenticated;

-- ---------- Sondages ----------
create table public.polls (
  id uuid primary key default gen_random_uuid(),
  message_id bigint not null unique references public.messages(id) on delete cascade,
  room_id uuid not null references public.rooms(id) on delete cascade,
  created_by uuid references public.profiles(id) on delete set null,
  question text not null check (char_length(question) between 1 and 200),
  multiple boolean not null default false,
  closed boolean not null default false,
  created_at timestamptz not null default now()
);
create table public.poll_options (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references public.polls(id) on delete cascade,
  label text not null check (char_length(label) between 1 and 80),
  position smallint not null
);
create index poll_options_poll_idx on public.poll_options (poll_id);
create table public.poll_votes (
  option_id uuid not null references public.poll_options(id) on delete cascade,
  poll_id uuid not null references public.polls(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  primary key (option_id, user_id)
);
create index poll_votes_poll_idx on public.poll_votes (poll_id);

create or replace function public.poll_room(pid uuid)
returns uuid
language sql stable security definer set search_path = public
as $$
  select room_id from public.polls where id = pid;
$$;
revoke all on function public.poll_room(uuid) from public, anon;
grant execute on function public.poll_room(uuid) to authenticated;

alter table public.polls enable row level security;
alter table public.poll_options enable row level security;
alter table public.poll_votes enable row level security;
create policy "sondages: lecture si membre" on public.polls
  for select to authenticated using (public.is_member(room_id));
create policy "options: lecture si membre" on public.poll_options
  for select to authenticated using (public.is_member(public.poll_room(poll_id)));
create policy "votes: lecture si membre" on public.poll_votes
  for select to authenticated using (public.is_member(public.poll_room(poll_id)));
-- aucune policy d'écriture : tout passe par create_poll / vote_poll / close_poll

create or replace function public.create_poll(p_room uuid, p_question text, p_options text[], p_multiple boolean default false)
returns bigint
language plpgsql security definer set search_path = public
as $$
declare
  q text := trim(coalesce(p_question, ''));
  opts text[];
  mid bigint;
  pid uuid;
  o text;
  i smallint := 0;
begin
  if auth.uid() is null then raise exception 'non connecté'; end if;
  if not public.is_member(p_room) then raise exception 'interdit'; end if;
  if char_length(q) not between 1 and 200 then raise exception 'question invalide (1 à 200 caractères)'; end if;
  select coalesce(array_agg(t order by first_pos), '{}') into opts from (
    select trim(x) as t, min(ord) as first_pos
    from unnest(coalesce(p_options, '{}')) with ordinality as u(x, ord)
    where trim(x) <> ''
    group by trim(x)
  ) s;
  if coalesce(array_length(opts, 1), 0) not between 2 and 6 then raise exception 'un sondage a entre 2 et 6 choix différents'; end if;
  foreach o in array opts loop
    if char_length(o) > 80 then raise exception 'choix trop long (80 caractères max)'; end if;
  end loop;

  insert into public.messages (room_id, user_id, text) values (p_room, auth.uid(), left('📊 ' || q, 1000))
  returning id into mid;
  insert into public.polls (message_id, room_id, created_by, question, multiple)
  values (mid, p_room, auth.uid(), q, coalesce(p_multiple, false))
  returning id into pid;
  foreach o in array opts loop
    insert into public.poll_options (poll_id, label, position) values (pid, o, i);
    i := i + 1;
  end loop;
  return mid;
end;
$$;

create or replace function public.vote_poll(p_poll uuid, p_option uuid, p_on boolean)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  pl public.polls;
begin
  if auth.uid() is null then raise exception 'non connecté'; end if;
  select * into pl from public.polls where id = p_poll;
  if not found then raise exception 'sondage introuvable'; end if;
  if not public.is_member(pl.room_id) then raise exception 'interdit'; end if;
  if pl.closed then raise exception 'ce sondage est terminé'; end if;
  if not exists (select 1 from public.poll_options where id = p_option and poll_id = p_poll) then
    raise exception 'choix invalide';
  end if;
  if p_on then
    if not pl.multiple then
      delete from public.poll_votes where poll_id = p_poll and user_id = auth.uid() and option_id <> p_option;
    end if;
    insert into public.poll_votes (option_id, poll_id, user_id) values (p_option, p_poll, auth.uid())
    on conflict do nothing;
  else
    delete from public.poll_votes where option_id = p_option and user_id = auth.uid();
  end if;
end;
$$;

create or replace function public.close_poll(p_poll uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'non connecté'; end if;
  update public.polls set closed = true
  where id = p_poll and (created_by = auth.uid() or public.is_admin());
  if not found then raise exception 'interdit'; end if;
end;
$$;

revoke all on function public.create_poll(uuid, text, text[], boolean) from public, anon;
revoke all on function public.vote_poll(uuid, uuid, boolean) from public, anon;
revoke all on function public.close_poll(uuid) from public, anon;
grant execute on function public.create_poll(uuid, text, text[], boolean) to authenticated;
grant execute on function public.vote_poll(uuid, uuid, boolean) to authenticated;
grant execute on function public.close_poll(uuid) to authenticated;

-- ---------- Temps réel ----------
alter publication supabase_realtime add table public.pinned_messages;
alter publication supabase_realtime add table public.polls;
alter publication supabase_realtime add table public.poll_votes;
