-- Budg' : schéma Supabase pour un budget de couple partagé en temps réel.
-- Toutes les tables sont préfixées budg_ et protégées par RLS : un utilisateur
-- ne voit que les données du couple (household) dont il est membre.

create table public.budg_households (
  id uuid primary key default gen_random_uuid(),
  name_a text not null,
  name_b text not null,
  default_split int not null default 50 check (default_split between 0 and 100),
  invite_code text not null unique default upper(substr(md5(gen_random_uuid()::text), 1, 6)),
  created_at timestamptz not null default now(),
  check (extra_a + extra_b <= amount)
);

-- Chaque couple a deux places : 'a' (créateur) et 'b' (partenaire invité).
create table public.budg_members (
  household_id uuid not null references public.budg_households (id) on delete cascade,
  user_id uuid not null unique references auth.users (id) on delete cascade,
  person text not null check (person in ('a', 'b')),
  primary key (household_id, user_id),
  unique (household_id, person)
);

create table public.budg_categories (
  id uuid primary key,
  household_id uuid not null references public.budg_households (id) on delete cascade,
  name text not null,
  icon text not null default '📦',
  budget int not null default 0 check (budget >= 0),
  period text not null default 'month' check (period in ('month', 'year')), -- budget par mois ou par an
  position int not null default 0
);

create table public.budg_expenses (
  id uuid primary key,
  household_id uuid not null references public.budg_households (id) on delete cascade,
  date date not null,
  label text not null,
  amount int not null check (amount > 0),
  payer text not null check (payer in ('a', 'b')),
  category_id uuid references public.budg_categories (id) on delete set null,
  split int not null check (split between 0 and 100),
  share_a int check (share_a >= 0 and share_a <= amount), -- montant précis pour 'a' (sinon split en %)
  by_usage boolean not null default false, -- répartie selon l'usage de la voiture du mois
  is_income boolean not null default false, -- entrée d'argent (remboursement EDF…) : déduite
  extra_a int not null default 0 check (extra_a >= 0), -- articles pour 'a' seul (shampoing…)
  extra_b int not null default 0 check (extra_b >= 0),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.budg_recurring (
  id uuid primary key,
  household_id uuid not null references public.budg_households (id) on delete cascade,
  label text not null,
  amount int not null check (amount > 0),
  payer text not null check (payer in ('a', 'b')),
  category_id uuid references public.budg_categories (id) on delete set null,
  split int not null check (split between 0 and 100),
  share_a int check (share_a >= 0 and share_a <= amount),
  by_usage boolean not null default false,
  day int not null default 1 check (day between 1 and 31),
  start_month text not null check (start_month ~ '^\d{4}-\d{2}$'),
  end_month text check (end_month ~ '^\d{4}-\d{2}$')
);

create table public.budg_transfers (
  id uuid primary key,
  household_id uuid not null references public.budg_households (id) on delete cascade,
  date date not null,
  from_person text not null check (from_person in ('a', 'b')),
  to_person text not null check (to_person in ('a', 'b') and to_person <> from_person),
  amount int not null check (amount > 0),
  note text not null default '',
  created_by uuid default auth.uid() references auth.users (id) on delete set null
);

-- Remboursements automatiques mensuels : montant fixe, ou `auto` = la part
-- des charges fixes due par from_person, recalculée chaque mois par l'appli.
create table public.budg_recurring_transfers (
  id uuid primary key,
  household_id uuid not null references public.budg_households (id) on delete cascade,
  from_person text not null check (from_person in ('a', 'b')),
  to_person text not null check (to_person in ('a', 'b') and to_person <> from_person),
  auto boolean not null default false,
  amount int check (amount > 0),
  day int not null default 1 check (day between 1 and 31),
  start_month text not null check (start_month ~ '^\d{4}-\d{2}$'),
  end_month text check (end_month ~ '^\d{4}-\d{2}$'),
  note text not null default '',
  check (auto or amount is not null)
);

-- Usage de la voiture par mois : % d'utilisation par la personne 'a'.
create table public.budg_car_usage (
  household_id uuid not null references public.budg_households (id) on delete cascade,
  month text not null check (month ~ '^\d{4}-\d{2}$'),
  split int not null check (split between 0 and 100),
  primary key (household_id, month)
);

create index on public.budg_categories (household_id);
create index on public.budg_expenses (household_id, date);
create index on public.budg_expenses (category_id);
create index on public.budg_expenses (created_by);
create index on public.budg_recurring (household_id);
create index on public.budg_recurring (category_id);
create index on public.budg_transfers (household_id);
create index on public.budg_recurring_transfers (household_id);

-- Appartenance au couple (security definer pour éviter la récursion RLS sur budg_members).
-- Rangée dans un schéma non exposé par l'API REST.
create schema budg_private;
grant usage on schema budg_private to authenticated;

create function budg_private.budg_is_member(hid uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.budg_members
    where household_id = hid and user_id = (select auth.uid())
  );
$$;

alter table public.budg_households enable row level security;
alter table public.budg_members enable row level security;
alter table public.budg_categories enable row level security;
alter table public.budg_expenses enable row level security;
alter table public.budg_recurring enable row level security;
alter table public.budg_transfers enable row level security;
alter table public.budg_recurring_transfers enable row level security;
alter table public.budg_car_usage enable row level security;

create policy "membres : lecture" on public.budg_households
  for select to authenticated using (budg_private.budg_is_member(id));
create policy "membres : modification" on public.budg_households
  for update to authenticated using (budg_private.budg_is_member(id)) with check (budg_private.budg_is_member(id));

create policy "membres : lecture" on public.budg_members
  for select to authenticated using (budg_private.budg_is_member(household_id));

create policy "membres : tout" on public.budg_categories
  for all to authenticated
  using (budg_private.budg_is_member(household_id)) with check (budg_private.budg_is_member(household_id));
create policy "membres : tout" on public.budg_expenses
  for all to authenticated
  using (budg_private.budg_is_member(household_id)) with check (budg_private.budg_is_member(household_id));
create policy "membres : tout" on public.budg_recurring
  for all to authenticated
  using (budg_private.budg_is_member(household_id)) with check (budg_private.budg_is_member(household_id));
create policy "membres : tout" on public.budg_transfers
  for all to authenticated
  using (budg_private.budg_is_member(household_id)) with check (budg_private.budg_is_member(household_id));
create policy "membres : tout" on public.budg_recurring_transfers
  for all to authenticated
  using (budg_private.budg_is_member(household_id)) with check (budg_private.budg_is_member(household_id));
create policy "membres : tout" on public.budg_car_usage
  for all to authenticated
  using (budg_private.budg_is_member(household_id)) with check (budg_private.budg_is_member(household_id));

-- Création d'un couple : l'appelant devient la personne 'a'.
create function public.budg_create_household(p_name_a text, p_name_b text, p_default_split int)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  hid uuid;
begin
  if auth.uid() is null then
    raise exception 'Non connecté';
  end if;
  if exists (select 1 from public.budg_members where user_id = auth.uid()) then
    raise exception 'Vous faites déjà partie d''un couple';
  end if;
  insert into public.budg_households (name_a, name_b, default_split)
  values (p_name_a, p_name_b, p_default_split)
  returning id into hid;
  insert into public.budg_members (household_id, user_id, person) values (hid, auth.uid(), 'a');
  return hid;
end;
$$;

-- Rejoindre le couple de son/sa partenaire avec le code d'invitation : place 'b'.
create function public.budg_join_household(p_code text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  hid uuid;
begin
  if auth.uid() is null then
    raise exception 'Non connecté';
  end if;
  if exists (select 1 from public.budg_members where user_id = auth.uid()) then
    raise exception 'Vous faites déjà partie d''un couple';
  end if;
  select id into hid from public.budg_households where invite_code = upper(trim(p_code));
  if hid is null then
    raise exception 'Code d''invitation inconnu';
  end if;
  if exists (select 1 from public.budg_members where household_id = hid and person = 'b') then
    raise exception 'Ce couple est déjà complet';
  end if;
  insert into public.budg_members (household_id, user_id, person) values (hid, auth.uid(), 'b');
  return hid;
end;
$$;

revoke execute on function budg_private.budg_is_member(uuid) from public, anon;
revoke execute on function public.budg_create_household(text, text, int) from public, anon;
revoke execute on function public.budg_join_household(text) from public, anon;
grant execute on function budg_private.budg_is_member(uuid) to authenticated;
grant execute on function public.budg_create_household(text, text, int) to authenticated;
grant execute on function public.budg_join_household(text) to authenticated;

-- Temps réel : chacun voit les ajouts de l'autre sans recharger.
alter publication supabase_realtime add table
  public.budg_households,
  public.budg_categories,
  public.budg_expenses,
  public.budg_recurring,
  public.budg_transfers,
  public.budg_recurring_transfers,
  public.budg_car_usage;

-- ---------- Notifications push ----------
-- La fonction Edge « budg-notify » (supabase/functions/budg-notify) envoie les
-- notifications ; elle est appelée par un déclencheur à chaque nouvelle dépense
-- ou nouveau remboursement.

create extension if not exists pg_net with schema extensions;
create index on public.budg_transfers (created_by);

-- Abonnements Web Push : un par appareil.
create table public.budg_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.budg_households (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
create index on public.budg_push_subscriptions (household_id);
create index on public.budg_push_subscriptions (user_id);

alter table public.budg_push_subscriptions enable row level security;
create policy "ses propres appareils" on public.budg_push_subscriptions
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and budg_private.budg_is_member(household_id));

-- Réglages internes du serveur (clés VAPID, secret du webhook) : RLS sans
-- aucune règle, donc illisible depuis l'API ; seule la fonction (service role) y accède.
create table public.budg_server_config (
  key text primary key,
  value text not null
);
alter table public.budg_server_config enable row level security;
revoke all on public.budg_server_config from anon, authenticated;
insert into public.budg_server_config (key, value)
values ('webhook_secret', encode(extensions.gen_random_bytes(32), 'hex'));

-- Remplacer l'URL par celle de votre projet.
create function budg_private.notify_new_entry()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  secret text;
begin
  select value into secret from public.budg_server_config where key = 'webhook_secret';
  perform net.http_post(
    url := 'https://sxnndcxqdsaiqucxvijb.supabase.co/functions/v1/budg-notify',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-budg-secret', secret),
    body := jsonb_build_object('table', TG_TABLE_NAME, 'record', to_jsonb(new), 'actor', auth.uid())
  );
  return new;
end;
$$;
revoke execute on function budg_private.notify_new_entry() from public, anon, authenticated;

create trigger budg_notify_expense after insert on public.budg_expenses
  for each row execute function budg_private.notify_new_entry();
create trigger budg_notify_transfer after insert on public.budg_transfers
  for each row execute function budg_private.notify_new_entry();

-- ---------- Liste de courses partagée ----------
create table public.budg_shopping_items (
  id uuid primary key,
  household_id uuid not null references public.budg_households (id) on delete cascade,
  label text not null check (char_length(label) between 1 and 80),
  done boolean not null default false,
  position double precision not null default 0,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index on public.budg_shopping_items (household_id);
create index on public.budg_shopping_items (created_by);

alter table public.budg_shopping_items enable row level security;
create policy "membres : tout" on public.budg_shopping_items
  for all to authenticated
  using (budg_private.budg_is_member(household_id)) with check (budg_private.budg_is_member(household_id));

alter publication supabase_realtime add table public.budg_shopping_items;
