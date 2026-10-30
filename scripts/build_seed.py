"""발주수량관리.xlsx(9/7 실사) 기준 초기 데이터 → supabase/seed.sql, data/seed.js 생성.

  python3 scripts/build_seed.py
"""
import json, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent

PRODUCTS = [
    # 부모코드, 관리명, 정식 품목명, 박스입수(EA)
    ("AG00229", "달콤사과 20", "헬로아이 달콤사과_100ML*10EA*2(IB)*1CB_좋은영농(20EA)", 20),
    ("AG00230", "달콤사과 40", "헬로아이 달콤사과_100ML*10EA*4(IB)*1CB_좋은영농(40EA)", 40),
    ("AG00358", "달콤사과 80", "헬로아이 달콤사과_100ML*10EA*8(IB)*1CB_좋은영농(80EA)", 80),
    ("AG00207", "배도라지 20", "헬로아이 배도라지_80ML*10EA*2(IB)*1CB_좋은영농(20EA)", 20),
    ("AG00208", "배도라지 40", "헬로아이 배도라지_80ML*10EA*4(IB)*1CB_좋은영농(40EA)", 40),
    ("AG00356", "배도라지 80", "헬로아이 배도라지_80ML*10EA*8(IB)*1CB_좋은영농(80EA)", 80),
    ("AG00336", "보리보리 20", "헬로아이 유기농 보리보리_100ML*10EA*2(IB)*1CB_좋은영농(20EA)", 20),
    ("AG00337", "보리보리 40", "헬로아이 유기농 보리보리_100ML*10EA*4(IB)*1CB_좋은영농(40EA)", 40),
    ("AG00359", "보리보리 80", "헬로아이 유기농 보리보리_100ML*10EA*8(IB)*1CB_좋은영농(80EA)", 80),
]

# (부모코드, 소비기한, 9/7 실사재고, 입고예정(9/10))
LOTS = [
    ("AG00229", "2027-04-01", 4, 0),
    ("AG00229", "2027-04-29", 11, 0),
    ("AG00229", "2027-07-02", 945, 0),
    ("AG00229", "2027-08-05", 838, 0),
    ("AG00229", "2028-03-16", 600, 0),
    ("AG00230", "2026-11-18", 42, 0),
    ("AG00230", "2027-04-29", 220, 0),
    ("AG00230", "2027-08-05", 252, 0),
    ("AG00230", "2028-03-16", 192, 0),
    ("AG00358", "2027-04-29", 3, 0),
    ("AG00358", "2027-06-08", 1, 0),
    ("AG00358", "2027-08-05", 261, 0),
    ("AG00358", "2028-03-16", 360, 0),
    ("AG00207", "2026-11-17", 40, 0),
    ("AG00207", "2026-12-23", 3, 0),
    ("AG00207", "2027-03-30", 825, 0),   # 시트상 7 + 818 두 행 → 같은 자식코드라 합산
    ("AG00207", "2027-08-05", 492, 0),
    ("AG00207", "2028-04-22", 0, 1000),
    ("AG00208", "2026-11-03", 15, 0),
    ("AG00208", "2026-11-17", 131, 0),
    ("AG00208", "2028-02-20", 492, 0),
    ("AG00208", "2028-03-17", 400, 0),
    ("AG00208", "2028-04-22", 0, 530),
    ("AG00356", "2027-03-09", 64, 0),
    ("AG00356", "2027-03-30", 54, 0),
    ("AG00356", "2028-02-20", 583, 0),
    ("AG00356", "2028-03-17", 291, 0),
    ("AG00356", "2028-04-22", 0, 500),
    ("AG00336", "2026-09-23", 281, 0),   # 시트 메모: 폐기
    ("AG00336", "2026-11-04", 345, 0),
    ("AG00336", "2027-03-05", 6, 0),
    ("AG00336", "2028-02-20", 24, 0),
    ("AG00336", "2028-03-03", 972, 0),
    ("AG00337", "2026-11-18", 374, 0),
    ("AG00337", "2027-05-25", 48, 0),
    ("AG00337", "2028-02-20", 15, 0),
    ("AG00337", "2028-03-03", 40, 0),
    ("AG00337", "2028-03-08", 0, 251),
    ("AG00359", "2027-05-25", 2, 0),
    ("AG00359", "2027-06-21", 3, 0),
    ("AG00359", "2028-03-03", 2, 0),
    ("AG00359", "2028-03-08", 0, 231),
]

OPEN_TS = "2026-09-07T09:00:00+09:00"
IN_TS = "2026-09-10T09:00:00+09:00"


def q(s):
    return "'" + str(s).replace("'", "''") + "'"


def build_sql():
    out = ["-- 초기 데이터: 발주수량관리.xlsx (A완제품창고, 2026-09-07 실사 + 9/10 입고예정)",
           "-- schema.sql 실행 후 1회만 실행하세요.", "begin;", ""]
    out.append("insert into products (product_code, name, full_name, box_qty) values")
    out.append(",\n".join(f"  ({q(c)}, {q(n)}, {q(f)}, {b})" for c, n, f, b in PRODUCTS) + ";")
    out.append("")
    out.append("insert into lots (product_code, expiry_date, qty) values")
    out.append(",\n".join(f"  ({q(c)}, {q(e)}, {o + i})" for c, e, o, i in LOTS) + ";")
    out.append("")
    out.append("insert into uploads (kind, file_name, row_count, total_qty, created_at) values")
    out.append(f"  ('count', '초기재고 (9/7 실사)', {sum(1 for l in LOTS if l[2])}, {sum(l[2] for l in LOTS)}, {q(OPEN_TS)}),")
    out.append(f"  ('in', '입고예정 (9/10)', {sum(1 for l in LOTS if l[3])}, {sum(l[3] for l in LOTS)}, {q(IN_TS)});")
    out.append("")
    out.append("insert into movements (lot_id, kind, qty, upload_id, memo, created_at)")
    out.append("select l.id, 'adjust', v.opening, (select id from uploads where file_name = '초기재고 (9/7 실사)'), '9/7 실사재고', " + q(OPEN_TS))
    out.append("from lots l join (values")
    out.append(",\n".join(f"  ({q(c)}, date {q(e)}, {o})" for c, e, o, i in LOTS if o) + "\n) v(code, exp, opening) on l.product_code = v.code and l.expiry_date = v.exp;")
    out.append("")
    out.append("insert into movements (lot_id, kind, qty, upload_id, memo, created_at)")
    out.append("select l.id, 'in', v.incoming, (select id from uploads where file_name = '입고예정 (9/10)'), '입고예정 9/10', " + q(IN_TS))
    out.append("from lots l join (values")
    out.append(",\n".join(f"  ({q(c)}, date {q(e)}, {i})" for c, e, o, i in LOTS if i) + "\n) v(code, exp, incoming) on l.product_code = v.code and l.expiry_date = v.exp;")
    out.append("")
    out.append("commit;")
    (ROOT / "supabase" / "seed.sql").write_text("\n".join(out) + "\n", encoding="utf-8")


def build_js():
    seed = {
        "products": [dict(product_code=c, name=n, full_name=f, box_qty=b) for c, n, f, b in PRODUCTS],
        "lots": [dict(product_code=c, expiry_date=e, opening=o, incoming=i) for c, e, o, i in LOTS],
        "opening_at": OPEN_TS, "incoming_at": IN_TS,
    }
    (ROOT / "data" / "seed.js").write_text(
        "// 로컬 데모 모드 초기 데이터 (scripts/build_seed.py 로 생성)\nwindow.SEED = "
        + json.dumps(seed, ensure_ascii=False, indent=1) + ";\n", encoding="utf-8")


if __name__ == "__main__":
    build_sql(); build_js()
    print("products", len(PRODUCTS), "lots", len(LOTS),
          "opening", sum(l[2] for l in LOTS), "incoming", sum(l[3] for l in LOTS))
