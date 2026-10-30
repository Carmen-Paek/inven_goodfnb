// =========================================================
// 앱 설정
//   SUPABASE_URL / SUPABASE_ANON_KEY 를 비워두면 "로컬 데모 모드"로 동작합니다.
//   (데이터가 이 브라우저에만 저장됨 — 테스트용)
//   Supabase 프로젝트 → Settings → API 에서 값을 복사해 넣으면 클라우드 모드로 전환됩니다.
//   anon key 는 공개되어도 되는 키입니다. (로그인 + RLS 로 보호)
// =========================================================
window.APP_CONFIG = {
  SUPABASE_URL: "https://kkgdqabjxfnhvqdjonjt.supabase.co/rest/v1/",
  SUPABASE_ANON_KEY: "sb_publishable_1RMCyLWCzbgQgO3Z0olphw_ykNmIJVJ",

  WAREHOUSE_NAME: "A완제품창고",
  ALERT_DAYS: 30,   // 소비기한 D-30 이내 → 임박(빨강)
  WARN_DAYS: 90,    // 소비기한 D-90 이내 → 주의(노랑)
};
