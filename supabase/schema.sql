-- =========================================================
-- 소비기한별 재고관리 스키마 (Supabase / PostgreSQL)
-- Supabase 대시보드 → SQL Editor 에 붙여넣고 Run
-- =========================================================

-- 1) 상품 마스터 (부모코드)
create table if not exists products (
  product_code text primary key,                 -- 부모코드 예: AG00229
  name         text not null,                    -- 관리명 예: 달콤사과 20
  full_name    text,                             -- 정식 품목명
  box_qty      int,                              -- 박스입수(EA)
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

-- 2) 로트 = 자식코드 (부모코드-소비기한)
create table if not exists lots (
  id           bigserial primary key,
  product_code text not null references products(product_code) on update cascade,
  expiry_date  date not null,
  lot_code     text unique,                      -- 예: AG00229-20270401 (트리거로 자동 생성)
  qty          int  not null default 0,          -- 현재고(박스)
  memo         text,
  created_at   timestamptz not null default now(),
  unique (product_code, expiry_date)
);

create or replace function set_lot_code() returns trigger language plpgsql as $$
begin
  new.lot_code := new.product_code || '-' || to_char(new.expiry_date, 'YYYYMMDD');
  return new;
end $$;

drop trigger if exists trg_lot_code on lots;
create trigger trg_lot_code before insert or update of product_code, expiry_date on lots
  for each row execute function set_lot_code();

-- 3) 업로드 묶음 (엑셀 1개 = 1건)
create table if not exists uploads (
  id          bigserial primary key,
  kind        text not null check (kind in ('in','out','count')),  -- 입고/출고/실사
  file_name   text,
  file_hash   text,                               -- 같은 파일 중복 반영 방지
  row_count   int default 0,
  total_qty   int default 0,
  status      text not null default 'applied' check (status in ('applied','reverted')),
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now()
);
create unique index if not exists uploads_hash_applied
  on uploads(file_hash) where file_hash is not null and status = 'applied';

-- 4) 입출고 원장 (모든 변동 기록, qty 는 +/-)
create table if not exists movements (
  id          bigserial primary key,
  lot_id      bigint not null references lots(id),
  kind        text not null check (kind in ('in','out','adjust','revert')),
  qty         int  not null,
  upload_id   bigint references uploads(id),
  ref         text,                               -- 주문번호/출고처 등
  memo        text,
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now()
);
create index if not exists movements_lot on movements(lot_id);
create index if not exists movements_upload on movements(upload_id);

-- 재고 조회용 뷰
create or replace view stock_view as
select l.id, l.lot_code, l.product_code, p.name, p.full_name, p.box_qty,
       l.expiry_date, (l.expiry_date - current_date) as days_left, l.qty, l.memo
from lots l join products p using (product_code)
order by l.product_code, l.expiry_date;

-- =========================================================
-- 업로드 반영 (전부 성공 or 전부 취소)
--   p_kind : 'out' 출고(차감) / 'in' 입고(가산, 로트 자동생성) / 'count' 실사(수량 맞춤)
--   p_rows : [{"row":2,"product_code":"AG00229","expiry_date":"2027-04-01","qty":10,"ref":"쿠팡"}]
--            출고에서 expiry_date 가 비면 FEFO(소비기한 빠른 순, 경과분 제외)로 자동 배분
-- =========================================================
create or replace function apply_upload(p_kind text, p_file_name text, p_file_hash text, p_rows jsonb)
returns jsonb language plpgsql as $$
declare
  v_upload bigint; r jsonb; v_code text; v_exp date; v_qty int; v_ref text; v_row text;
  v_lot lots%rowtype; v_remain int; v_take int; v_delta int;
  v_total int := 0; v_count int := 0;
begin
  if p_kind not in ('in','out','count') then
    raise exception '알 수 없는 업로드 유형: %', p_kind;
  end if;
  if p_file_hash is not null and exists (select 1 from uploads where file_hash = p_file_hash and status = 'applied') then
    raise exception '이미 반영된 파일입니다: %', p_file_name;
  end if;

  insert into uploads(kind, file_name, file_hash) values (p_kind, p_file_name, p_file_hash) returning id into v_upload;

  for r in select * from jsonb_array_elements(p_rows) loop
    v_count := v_count + 1;
    v_row  := coalesce(r->>'row', v_count::text);
    v_code := r->>'product_code';
    v_exp  := nullif(r->>'expiry_date', '')::date;
    v_qty  := (r->>'qty')::int;
    v_ref  := nullif(r->>'ref', '');

    if not exists (select 1 from products where product_code = v_code) then
      raise exception '%행: 등록되지 않은 상품코드 %', v_row, v_code;
    end if;
    if v_qty is null or v_qty < 0 or (v_qty = 0 and p_kind <> 'count') then
      raise exception '%행: 수량 오류 (%)', v_row, r->>'qty';
    end if;

    if p_kind in ('in','count') then
      if v_exp is null then raise exception '%행: 소비기한이 필요합니다', v_row; end if;
      insert into lots(product_code, expiry_date, qty) values (v_code, v_exp, 0)
        on conflict (product_code, expiry_date) do nothing;
      select * into v_lot from lots where product_code = v_code and expiry_date = v_exp for update;
      v_delta := case when p_kind = 'in' then v_qty else v_qty - v_lot.qty end;
      if v_delta <> 0 then
        update lots set qty = qty + v_delta where id = v_lot.id;
        insert into movements(lot_id, kind, qty, upload_id, ref)
          values (v_lot.id, case when p_kind = 'in' then 'in' else 'adjust' end, v_delta, v_upload, v_ref);
      end if;

    elsif v_exp is not null then              -- 출고: 자식코드 지정
      select * into v_lot from lots where product_code = v_code and expiry_date = v_exp for update;
      if not found then
        raise exception '%행: 재고에 없는 자식코드 %-%', v_row, v_code, to_char(v_exp,'YYYYMMDD');
      end if;
      if v_lot.qty < v_qty then
        raise exception '%행: 재고 부족 % (현재 %, 요청 %)', v_row, v_lot.lot_code, v_lot.qty, v_qty;
      end if;
      update lots set qty = qty - v_qty where id = v_lot.id;
      insert into movements(lot_id, kind, qty, upload_id, ref) values (v_lot.id, 'out', -v_qty, v_upload, v_ref);

    else                                       -- 출고: 소비기한 미지정 → FEFO
      v_remain := v_qty;
      for v_lot in select * from lots
                   where product_code = v_code and qty > 0 and expiry_date >= current_date
                   order by expiry_date for update loop
        v_take := least(v_lot.qty, v_remain);
        update lots set qty = qty - v_take where id = v_lot.id;
        insert into movements(lot_id, kind, qty, upload_id, ref, memo)
          values (v_lot.id, 'out', -v_take, v_upload, v_ref, 'FEFO 자동배분');
        v_remain := v_remain - v_take;
        exit when v_remain = 0;
      end loop;
      if v_remain > 0 then
        raise exception '%행: % 재고 부족 (부족 %)', v_row, v_code, v_remain;
      end if;
    end if;

    v_total := v_total + v_qty;
  end loop;

  update uploads set row_count = v_count, total_qty = v_total where id = v_upload;
  return jsonb_build_object('upload_id', v_upload, 'rows', v_count, 'total_qty', v_total);
end $$;

-- 업로드 되돌리기
create or replace function revert_upload(p_upload_id bigint)
returns jsonb language plpgsql as $$
declare m record; v_cnt int := 0;
begin
  if not exists (select 1 from uploads where id = p_upload_id and status = 'applied') then
    raise exception '되돌릴 수 없는 업로드입니다 (#%)', p_upload_id;
  end if;
  for m in select * from movements where upload_id = p_upload_id and kind <> 'revert' loop
    update lots set qty = qty - m.qty where id = m.lot_id;
    if (select qty from lots where id = m.lot_id) < 0 then
      raise exception '되돌리면 재고가 마이너스가 되는 로트가 있습니다 (lot #%)', m.lot_id;
    end if;
    insert into movements(lot_id, kind, qty, upload_id, memo)
      values (m.lot_id, 'revert', -m.qty, p_upload_id, '업로드 #' || p_upload_id || ' 취소');
    v_cnt := v_cnt + 1;
  end loop;
  update uploads set status = 'reverted' where id = p_upload_id;
  return jsonb_build_object('reverted', v_cnt);
end $$;

-- 단건 수량 수정 (화면에서 직접 조정)
create or replace function adjust_lot(p_lot_id bigint, p_new_qty int, p_memo text)
returns void language plpgsql as $$
declare v_old int;
begin
  if p_new_qty < 0 then raise exception '수량은 0 이상이어야 합니다'; end if;
  select qty into v_old from lots where id = p_lot_id for update;
  if not found then raise exception '로트 없음'; end if;
  if v_old = p_new_qty then return; end if;
  update lots set qty = p_new_qty where id = p_lot_id;
  insert into movements(lot_id, kind, qty, memo) values (p_lot_id, 'adjust', p_new_qty - v_old, p_memo);
end $$;

-- =========================================================
-- 보안: 로그인한 사용자만 읽기/쓰기
-- =========================================================
alter table products  enable row level security;
alter table lots      enable row level security;
alter table uploads   enable row level security;
alter table movements enable row level security;

do $$
declare t text;
begin
  foreach t in array array['products','lots','uploads','movements'] loop
    execute format('drop policy if exists "auth_all" on %I', t);
    execute format('create policy "auth_all" on %I for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;

alter view stock_view set (security_invoker = true);
revoke execute on function apply_upload(text,text,text,jsonb), revert_upload(bigint), adjust_lot(bigint,int,text) from anon, public;
grant  execute on function apply_upload(text,text,text,jsonb), revert_upload(bigint), adjust_lot(bigint,int,text) to authenticated;
