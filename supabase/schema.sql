-- Chronova storefront starter schema. Apply only after reviewing and confirming the owner's product/pricing data.
create extension if not exists pgcrypto;

create table if not exists public.products (
  id text primary key,
  name text not null,
  brand text not null default 'Chronova',
  category text not null,
  price integer not null check (price >= 0),
  compare_at integer check (compare_at is null or compare_at >= price),
  description text not null default '',
  image_url text,
  movement text,
  case_size text,
  strap text,
  dial_color text,
  case_color text,
  stock integer not null default 0 check (stock >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique,
  idempotency_key text,
  customer_name text not null,
  customer_email text not null,
  customer_phone text not null,
  address_line text not null,
  area text not null,
  city text not null,
  postal_code text,
  notes text,
  payment_method text not null,
  subtotal integer not null check (subtotal >= 0),
  shipping_fee integer not null check (shipping_fee >= 0),
  total integer not null check (total = subtotal + shipping_fee),
  status text not null default 'Order received',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.orders add column if not exists idempotency_key text;
create unique index if not exists orders_idempotency_key_unique on public.orders(idempotency_key);

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id text not null references public.products(id),
  product_name text not null,
  unit_price integer not null check (unit_price >= 0),
  quantity integer not null check (quantity > 0),
  line_total integer not null check (line_total = unit_price * quantity)
);

create table if not exists public.order_status_history (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  status text not null,
  customer_note text,
  created_at timestamptz not null default now()
);

alter table public.products enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.order_status_history enable row level security;

-- Customers can see only active catalogue items. Writes/orders are handled by the Edge Function.
drop policy if exists "Public can read active products" on public.products;
create policy "Public can read active products" on public.products for select to anon, authenticated using (active = true);
-- No public policies on orders/items/history. Do not add broad public read access.

grant select on public.products to anon, authenticated;
revoke all on public.orders, public.order_items, public.order_status_history from anon, authenticated;

-- Atomic order creation: reads authoritative prices, reserves stock, and writes order + line items in one transaction.
drop function if exists public.create_public_order(jsonb,jsonb,text,integer,text);
create or replace function public.create_public_order(p_customer jsonb, p_items jsonb, p_payment_method text, p_shipping_zone text, p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order_id uuid := gen_random_uuid();
  v_order_number text := 'CB-' || to_char(now() at time zone 'UTC', 'YYMMDD') || '-' || upper(substr(encode(gen_random_bytes(4), 'hex'), 1, 6));
  v_subtotal integer := 0;
  v_total integer;
  v_shipping_fee integer;
  v_status text := 'Order received';
  v_item jsonb;
  v_product public.products%rowtype;
  v_qty integer;
  v_customer_name text := trim(coalesce(p_customer->>'name',''));
  v_email text := lower(trim(coalesce(p_customer->>'email','')));
  v_phone text := trim(coalesce(p_customer->>'phone',''));
  v_address text := trim(coalesce(p_customer->>'address',''));
  v_area text := trim(coalesce(p_customer->>'area',''));
  v_city text := trim(coalesce(p_customer->>'city',''));
  v_existing public.orders%rowtype;
begin
  if p_idempotency_key is null or length(p_idempotency_key) < 16 then
    raise exception 'Invalid checkout request key';
  end if;
  perform pg_advisory_xact_lock(hashtext(p_idempotency_key));
  select * into v_existing from public.orders where idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object('id',v_existing.id,'orderNumber',v_existing.order_number,'status',v_existing.status,'subtotal',v_existing.subtotal,'shippingFee',v_existing.shipping_fee,'total',v_existing.total,'created',false);
  end if;
  if v_customer_name = '' or v_email = '' or v_phone = '' or v_address = '' or v_area = '' or v_city = '' then
    raise exception 'Please provide all required delivery details';
  end if;
  if p_payment_method not in ('Cash on delivery','bKash manual') then
    raise exception 'Unsupported payment method';
  end if;
  if p_shipping_zone not in ('dhaka','outside','pickup') or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 20 then
    raise exception 'Invalid order items or delivery option';
  end if;
  v_shipping_fee := case p_shipping_zone when 'dhaka' then 80 when 'outside' then 130 else 0 end;

  insert into public.orders (id, order_number, idempotency_key, customer_name, customer_email, customer_phone, address_line, area, city, postal_code, notes, payment_method, subtotal, shipping_fee, total, status)
  values (v_order_id, v_order_number, p_idempotency_key, v_customer_name, v_email, v_phone, v_address, v_area, v_city,
          nullif(trim(coalesce(p_customer->>'postalCode','')), ''), nullif(trim(coalesce(p_customer->>'notes','')), ''), p_payment_method, 0, v_shipping_fee, v_shipping_fee, v_status);

  for v_item in select value from jsonb_array_elements(p_items) loop
    v_qty := greatest(0, least(20, coalesce((v_item->>'quantity')::integer, 0)));
    if v_qty < 1 then raise exception 'Invalid product quantity'; end if;
    select * into v_product from public.products where id = v_item->>'productId' and active = true for update;
    if not found then raise exception 'A selected product is no longer available'; end if;
    if v_product.stock < v_qty then raise exception 'Insufficient stock for %', v_product.name; end if;
    update public.products set stock = stock - v_qty, updated_at = now() where id = v_product.id;
    v_subtotal := v_subtotal + (v_product.price * v_qty);
    insert into public.order_items (order_id, product_id, product_name, unit_price, quantity, line_total)
    values (v_order_id, v_product.id, v_product.name, v_product.price, v_qty, v_product.price * v_qty);
  end loop;

  v_total := v_subtotal + v_shipping_fee;
  update public.orders set subtotal = v_subtotal, total = v_total where id = v_order_id;
  insert into public.order_status_history (order_id, status) values (v_order_id, v_status);
  return jsonb_build_object('id', v_order_id, 'orderNumber', v_order_number, 'status', v_status, 'subtotal', v_subtotal, 'shippingFee', v_shipping_fee, 'total', v_total, 'created', true);
end;
$$;

revoke all on function public.create_public_order(jsonb,jsonb,text,text,text) from public;
grant execute on function public.create_public_order(jsonb,jsonb,text,text,text) to service_role;

-- Seed data intentionally omitted: import only owner-approved catalogue/prices.
