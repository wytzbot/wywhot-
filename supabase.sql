-- WYWHOT v4.3 / Supabase migration
-- Safe to run after the earlier WYWHOT SQL. Anonymous Auth must be enabled.
create extension if not exists pgcrypto;

create table if not exists rooms (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  host_id uuid not null,
  status text not null default 'lobby',
  rules jsonb not null default '{}'::jsonb,
  virtual_bank_enabled boolean not null default false,
  virtual_currency text check (virtual_currency in ('NGN','USD','EUR')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists players (
  id uuid primary key,
  room_id uuid not null references rooms(id) on delete cascade,
  name text not null,
  avatar text not null,
  connected boolean not null default true,
  is_host boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists game_states (
  room_id uuid primary key references rooms(id) on delete cascade,
  deck_count integer not null default 0,
  discard_top jsonb,
  called_shape text,
  market_pile jsonb not null default '[]'::jsonb,
  turn_order uuid[] not null default '{}',
  current_turn uuid,
  hand_counts jsonb not null default '{}'::jsonb,
  last_action jsonb,
  status text not null default 'active',
  winner uuid,
  updated_at timestamptz not null default now()
);

create table if not exists game_decks (
  room_id uuid primary key references rooms(id) on delete cascade,
  deck jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists player_hands (
  room_id uuid not null references rooms(id) on delete cascade,
  player_id uuid not null,
  hand jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (room_id, player_id)
);

create table if not exists pro_orders (
  reference text primary key,
  email text not null,
  amount numeric not null check (amount > 0),
  currency text not null check (currency in ('NGN','USD')),
  status text not null default 'pending',
  charge_id text,
  customer_id text,
  payment_method_id text,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists pro_entitlements (
  email text primary key,
  status text not null default 'active',
  expires_at timestamptz not null,
  flutterwave_reference text,
  updated_at timestamptz not null default now()
);

create table if not exists payment_events (
  event_id text primary key,
  charge_id text,
  status text,
  reference text,
  email text,
  amount numeric,
  currency text,
  payload jsonb,
  created_at timestamptz not null default now()
);

create table if not exists virtual_bankrolls (
  player_id uuid primary key,
  currency text not null check (currency in ('NGN','USD','EUR')),
  balance numeric not null default 10000 check (balance >= 0),
  last_reset_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Add columns that older WYWHOT SQL versions may not have.
alter table rooms add column if not exists created_at timestamptz not null default now();
alter table rooms add column if not exists updated_at timestamptz not null default now();
alter table players add column if not exists created_at timestamptz not null default now();
alter table players add column if not exists updated_at timestamptz not null default now();
alter table game_decks add column if not exists updated_at timestamptz not null default now();
alter table player_hands add column if not exists updated_at timestamptz not null default now();
alter table pro_orders add column if not exists updated_at timestamptz not null default now();
alter table virtual_bankrolls add column if not exists updated_at timestamptz not null default now();

create index if not exists idx_rooms_host_id on rooms(host_id);
create index if not exists idx_rooms_code on rooms(code);
create index if not exists idx_players_room_id on players(room_id);
create index if not exists idx_players_connected on players(room_id, connected);
create index if not exists idx_game_states_updated_at on game_states(updated_at);
create index if not exists idx_player_hands_player_id on player_hands(player_id);
create index if not exists idx_pro_orders_email on pro_orders(email);
create index if not exists idx_pro_orders_status on pro_orders(status);
create index if not exists idx_pro_entitlements_expires_at on pro_entitlements(expires_at);
create index if not exists idx_payment_events_reference on payment_events(reference);
create index if not exists idx_virtual_bankroll_reset on virtual_bankrolls(last_reset_at);

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists rooms_set_updated_at on rooms;
create trigger rooms_set_updated_at before update on rooms for each row execute function public.set_updated_at();
drop trigger if exists players_set_updated_at on players;
create trigger players_set_updated_at before update on players for each row execute function public.set_updated_at();
drop trigger if exists game_states_set_updated_at on game_states;
create trigger game_states_set_updated_at before update on game_states for each row execute function public.set_updated_at();
drop trigger if exists game_decks_set_updated_at on game_decks;
create trigger game_decks_set_updated_at before update on game_decks for each row execute function public.set_updated_at();
drop trigger if exists player_hands_set_updated_at on player_hands;
create trigger player_hands_set_updated_at before update on player_hands for each row execute function public.set_updated_at();
drop trigger if exists pro_orders_set_updated_at on pro_orders;
create trigger pro_orders_set_updated_at before update on pro_orders for each row execute function public.set_updated_at();
drop trigger if exists pro_entitlements_set_updated_at on pro_entitlements;
create trigger pro_entitlements_set_updated_at before update on pro_entitlements for each row execute function public.set_updated_at();
drop trigger if exists virtual_bankrolls_set_updated_at on virtual_bankrolls;
create trigger virtual_bankrolls_set_updated_at before update on virtual_bankrolls for each row execute function public.set_updated_at();

alter table rooms enable row level security;
alter table players enable row level security;
alter table game_states enable row level security;
alter table game_decks enable row level security;
alter table player_hands enable row level security;
alter table pro_orders enable row level security;
alter table pro_entitlements enable row level security;
alter table payment_events enable row level security;
alter table virtual_bankrolls enable row level security;

drop policy if exists rooms_select_all on rooms;
create policy rooms_select_all on rooms for select using (true);
drop policy if exists rooms_insert_self_host on rooms;
create policy rooms_insert_self_host on rooms for insert with check (host_id = auth.uid());
drop policy if exists rooms_update_own on rooms;
create policy rooms_update_own on rooms for update using (host_id = auth.uid()) with check (host_id = auth.uid());
drop policy if exists rooms_delete_own on rooms;
create policy rooms_delete_own on rooms for delete using (host_id = auth.uid());

drop policy if exists players_select_all on players;
create policy players_select_all on players for select using (true);
drop policy if exists players_insert_self on players;
create policy players_insert_self on players for insert with check (id = auth.uid());
drop policy if exists players_update_own on players;
create policy players_update_own on players for update using (id = auth.uid()) with check (id = auth.uid());
drop policy if exists players_delete_own on players;
create policy players_delete_own on players for delete using (id = auth.uid());

drop policy if exists game_states_select_all on game_states;
create policy game_states_select_all on game_states for select using (true);

drop policy if exists player_hands_select_own on player_hands;
create policy player_hands_select_own on player_hands for select using (player_id = auth.uid());

-- No browser policies on game_decks, pro_orders, pro_entitlements,
-- payment_events, or virtual_bankrolls. Service-role/server code only.


create or replace function public.is_pro_email(p_email text)
returns boolean language sql security definer set search_path = public as $$
  select exists (
    select 1 from public.pro_entitlements
    where lower(email) = lower(trim(p_email))
      and status = 'active'
      and expires_at > now()
  );
$$;
revoke all on function public.is_pro_email(text) from public;
grant execute on function public.is_pro_email(text) to service_role;

create or replace function public.expire_pro_entitlements()
returns integer language plpgsql security definer set search_path = public as $$
declare changed integer;
begin
  update public.pro_entitlements set status='expired', updated_at=now()
  where status='active' and expires_at <= now();
  get diagnostics changed = row_count;
  return changed;
end;
$$;
revoke all on function public.expire_pro_entitlements() from public;
grant execute on function public.expire_pro_entitlements() to service_role;

create or replace function public.reset_virtual_bankrolls()
returns integer language plpgsql security definer set search_path = public as $$
declare changed integer;
begin
  update public.virtual_bankrolls
  set balance=10000, last_reset_at=now(), updated_at=now()
  where last_reset_at <= now() - interval '24 hours';
  get diagnostics changed = row_count;
  return changed;
end;
$$;
revoke all on function public.reset_virtual_bankrolls() from public;
grant execute on function public.reset_virtual_bankrolls() to service_role;

do $$
begin
  begin alter publication supabase_realtime add table public.rooms; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.players; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.game_states; exception when duplicate_object then null; end;
exception when undefined_object then null;
end $$;

-- If pg_cron is enabled, schedule the maintenance jobs.
do $$
begin
  begin
    create extension if not exists pg_cron;
    begin
      perform cron.schedule('wywhot-reset-virtual-bankrolls','0 * * * *','select public.reset_virtual_bankrolls();');
    exception when duplicate_object then null; end;
    begin
      perform cron.schedule('wywhot-expire-pro','*/15 * * * *','select public.expire_pro_entitlements();');
    exception when duplicate_object then null; end;
  exception when others then
    raise notice 'pg_cron unavailable; configure the two jobs in Supabase Cron.';
  end;
end $$;
