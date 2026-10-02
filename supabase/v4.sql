-- =====================================================================
--  La Classe : mise à jour v4 (photo de profil, bannissement)
--  À exécuter APRÈS schema.sql et v3.sql (SQL Editor > New query > Run), une seule fois.
-- =====================================================================

-- ---------- Photo de profil ----------
alter table public.profiles
  add column avatar_path text check (avatar_path is null or avatar_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(png|jpg|gif|webp)$');

create or replace function public.set_my_avatar(p_path text)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'non connecté'; end if;
  if p_path is null or p_path = '' then
    update public.profiles set avatar_path = null where id = auth.uid();
    return;
  end if;
  if split_part(p_path, '/', 1) <> auth.uid()::text then raise exception 'photo invalide'; end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'images' and o.name = p_path) then
    raise exception 'photo introuvable';
  end if;
  update public.profiles set avatar_path = p_path where id = auth.uid();
end;
$$;
revoke all on function public.set_my_avatar(text) from public, anon;
grant execute on function public.set_my_avatar(text) to authenticated;

-- ---------- Bannissement ----------
create table public.banned_users (
  pseudo_key text primary key,
  pseudo text not null,
  reason text not null default '' check (char_length(reason) <= 200),
  banned_at timestamptz not null default now(),
  banned_by uuid references public.profiles(id) on delete set null
);
alter table public.banned_users enable row level security;
create policy "banned: lecture admin" on public.banned_users
  for select to authenticated using (public.is_admin());
-- aucune policy d'écriture : tout passe par admin_ban / admin_unban (et le serveur d'inscription)

create or replace function public.admin_ban(p_user uuid, p_reason text default '')
returns void
language plpgsql security definer set search_path = public
as $$
declare
  who text;
begin
  if not public.is_admin() then raise exception 'interdit'; end if;
  if p_user = auth.uid() then raise exception 'tu ne peux pas te bannir toi-même'; end if;
  select pseudo into who from public.profiles where id = p_user;
  if who is null then raise exception 'utilisateur inconnu'; end if;
  if exists (select 1 from public.profiles where id = p_user and is_admin) then
    raise exception 'impossible de bannir un admin';
  end if;
  insert into public.banned_users (pseudo_key, pseudo, reason, banned_by)
  values (lower(who), who, left(coalesce(p_reason, ''), 200), auth.uid())
  on conflict (pseudo_key) do update set reason = excluded.reason, banned_at = now(), banned_by = excluded.banned_by;
  delete from auth.users where id = p_user;
end;
$$;

create or replace function public.admin_unban(p_key text)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'interdit'; end if;
  delete from public.banned_users where pseudo_key = lower(p_key);
end;
$$;

revoke all on function public.admin_ban(uuid, text) from public, anon;
revoke all on function public.admin_unban(text) from public, anon;
grant execute on function public.admin_ban(uuid, text) to authenticated;
grant execute on function public.admin_unban(text) to authenticated;
