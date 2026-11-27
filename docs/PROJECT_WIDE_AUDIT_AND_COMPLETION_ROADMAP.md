# Crushify — Kiểm toán toàn dự án và lộ trình hoàn thiện

**Ngày kiểm toán:** 2026-11-19
**Phạm vi:** Đọc mã nguồn, cấu hình, tài liệu và trạng thái Git hiện có; không thay đổi sản phẩm, không truy cập dịch vụ từ xa và không kiểm tra dữ liệu cục bộ.

## Tóm tắt điều hành

Crushify hiện có năm template độc lập, homepage và các luồng ứng dụng cho thiết kế, upload, checkout, xuất bản và quản trị. Mã nguồn có các lớp bảo vệ theo môi trường và các kiểm thử cục bộ đáng kể. Tuy vậy, không nên coi nhánh hiện tại là sẵn sàng Production hoặc chứng nhận runtime của Preview:

- Worktree có các thay đổi chưa commit, gồm Sharp/chuẩn hóa ảnh; deployment đã xác định ở SHA `747b2a4d0fe6eddacb9e59833be43d66213936a4` không chứa các thay đổi đó.
- Sharp được inject vào adapter Vercel, nhưng bundle/native runtime thực tế chưa được kiểm chứng. Worker không inject image normalizer nên các luồng ảnh liên quan sẽ fail closed.
- Checkout retry hiện có lưu durable idempotency intent bằng IndexedDB, Web Locks, fingerprint payload và server replay. Browser recovery đã được kiểm thử cục bộ, nhưng còn phụ thuộc trình duyệt/profile thực tế và không thay Production evidence.
- Trang dành cho khách hàng chưa có bộ điều khoản/chính sách hỗ trợ và hoàn tiền hoàn chỉnh; email hỗ trợ còn yêu cầu chủ sở hữu xác nhận.
- Những tài liệu và báo cáo QA cũ không phải bằng chứng về trạng thái triển khai hiện tại.

**Kết luận:** `NOT READY` để bật checkout Production hoặc xem Phase 1A.4-R3 là đã hoàn tất. Cần khóa rõ source SHA cần audit, xác minh runtime/bundle, xử lý rủi ro checkout và hoàn thành các điều kiện vận hành/pháp lý trước khi mở Production.

## 1. Git baseline và bảo toàn thay đổi

Baseline ghi nhận trước khi tạo báo cáo:

| Mục | Giá trị |
|---|---|
| Branch | `preview/phase-1a-remediation` |
| HEAD | `747b2a4d0fe6eddacb9e59833be43d66213936a4` |
| Upstream | `origin/preview/phase-1a-remediation` |
| Tracked files đã sửa | 21 |
| Untracked files | 6 |
| Staged changes | Không |

Các thay đổi chưa commit bao gồm chuẩn hóa ảnh bằng Sharp, quota/reservation và staging-preflight. Đây là trạng thái có trước báo cáo và không được sửa, stage, commit, xóa hoặc gộp vào tài liệu này.

Sau kiểm toán, chỉ file báo cáo này được tạo. Không có thay đổi mã nguồn hoặc Git nào khác được thực hiện.

## 2. Kiểm kê và giới hạn phạm vi

Kiểm kê cấu trúc đã ghi nhận:

- 444 đường dẫn tracked không nhạy cảm; `.agents/` có 211 file.
- 23 migration, 35 file test, 8 script, 56 báo cáo trong `docs/qa/`.
- Năm template độc lập, tổng cộng 13 file trong cây template.
- Có các tệp/config local bị ignore như `.dev.vars`, SQLite, `.local`, `.wrangler` và `session.json`; chỉ quan sát tên, không đọc nội dung.

Đây là kiểm toán kiến trúc và các luồng liên quan, không phải review từng dòng của tất cả 444 file. Không đọc `.env`/secret, dữ liệu database, session, credential store hoặc nội dung tệp local bị ignore.

## 3. Kiến trúc và luồng dữ liệu

1. **Giao diện:** [`index.html`](../index.html) giới thiệu sản phẩm và điều hướng tới năm template. Mỗi template giữ CSS/JavaScript/tài nguyên riêng.
2. **API:** [Vercel API handler](../api/%5B...path%5D.ts) gọi shared API. Các module nghiệp vụ dùng chung gồm xác thực, thiết kế, tài sản, thanh toán và xuất bản.
3. **Runtime/provider:** source Vercel hỗ trợ Turso/libSQL và Cloudinary theo cấu hình; [`src/index.ts`](../src/index.ts) là Worker/local path dùng D1/R2. Hai đường chạy không tương đương hoàn toàn.
4. **Upload và ảnh:** ảnh tải lên được giữ riêng tư; thao tác upload/derivative yêu cầu `IMAGE_NORMALIZER`. Vercel inject `normalizeNodeImage`; Worker không inject processor ở trạng thái hiện tại. Các route liên quan vì thế trả lỗi `IMAGE_PROCESSOR_UNAVAILABLE` thay vì nhận ảnh chưa chuẩn hóa.
5. **Thanh toán và xuất bản:** server giữ quyền quyết định giá, trạng thái thanh toán và khả năng public. Checkout Production đang tắt; các kiểm thử thanh toán hiện là test/synthetic, không xác nhận giao dịch với provider.
6. **Lifecycle:** source có route Cron và cleanup/recovery logic. Khai báo cấu hình không chứng minh Cron đang được triển khai hoặc chạy đúng trong môi trường hosted.

### Phân biệt runtime với source

| Bằng chứng | Phân loại | Điều chứng minh |
|---|---|---|
| Mã nguồn, cấu hình, tests và tài liệu đã đọc | `SOURCE_VERIFIED` | Hành vi được định nghĩa hoặc kiểm tra cục bộ theo fixture |
| Một HEAD request homepage Preview đã thực hiện ở Phase 1A.4-R2 | `RUNTIME_VERIFIED` giới hạn | Preview trả HTTP 200 cho đúng request đó |
| GET trang, JavaScript execution, CSS/media, mobile rendering, provider behavior | `NOT_VERIFIED` | Không có kiểm tra runtime tương ứng trong phạm vi này |
| Sharp bundle/native binary, Cron đã deploy, Production provider setup | `NOT_VERIFIED` | Chưa có bằng chứng deployment/account/runtime |

Phase 1A.4-R2 chỉ xác nhận HEAD homepage HTTP 200. Không có GET trang, template/assets, browser console, SRI byte check hay request API tiếp theo. Kiểm toán hiện tại không gửi request HTTP nào.

## 4. Hành trình khách hàng

| Giai đoạn | Hiện trạng mã nguồn | Khoảng trống / điều kiện |
|---|---|---|
| Khám phá template | Homepage liệt kê năm template và điều hướng tới các trang độc lập | Không xác minh browser/mobile trên deployment trong kiểm toán này |
| Tùy chỉnh | Có luồng lưu thiết kế, preview và upload qua API | Chất lượng bundle Sharp trên Vercel chưa được xác nhận; Worker fail closed với luồng ảnh |
| Checkout | Có màn hình giá, xác nhận, durable intent/recovery và tạo order qua API | Cơ chế checkout recovery có bằng chứng unit/browser local; Production checkout và deployment chưa được xác nhận |
| Thanh toán | Có cấu trúc provider và test mode/mock cho môi trường phù hợp | Không có giao dịch provider thật nào được kiểm tra; không bật thanh toán Production |
| Xuất bản | Có luồng public site, asset, QR và vòng đời hết hạn | Cần xác minh hosting, Cron, storage và quyền truy cập trên deployment cụ thể |
| Hỗ trợ / hoàn tiền | Có địa chỉ email trong UI | Homepage nêu hòm thư cần chủ sở hữu xác nhận; README ghi chính sách hỗ trợ/hoàn tiền chưa được triển khai hoặc phê duyệt |

Checkout checkbox hiện là xác nhận trong form, không phải liên kết tới bộ điều khoản dịch vụ. Trong các trang khách hàng đã kiểm tra, chưa tìm thấy bộ trang Terms/Privacy/Refund hoàn chỉnh.

## 5. Rủi ro và vấn đề cần xử lý

| Ưu tiên | Vấn đề | Bằng chứng / tác động | Hướng xử lý |
|---|---|---|---|
| P0 — release gate | Source đang audit không đồng nhất với nội dung deployed | Preview được nhận diện ở SHA `747b2a4…`; thay đổi Sharp hiện nằm trong worktree chưa commit. Không thể suy diễn deployment chứa Sharp từ branch hoặc trạng thái local. | Chốt SHA cần phát hành/audit; đối chiếu deployment với SHA đó trước mọi kết luận runtime. |
| P0 — runtime gate | Chưa xác minh Sharp trên Vercel; Worker không có normalizer | Vercel inject processor trong source nhưng [`vercel.json`](../vercel.json) chỉ nêu `includeFiles: migrations/**`; Worker không inject `IMAGE_NORMALIZER`. Worker upload/derivative bị từ chối có chủ ý. | Thực hiện kiểm tra bundle/runtime trên đúng SHA; quyết định rõ Worker là runtime không hỗ trợ ảnh hay sẽ có processor tương thích. Cập nhật tài liệu theo quyết định. |
| P0 — customer readiness | Điều khoản, quyền riêng tư, hoàn tiền và hỗ trợ chưa sẵn sàng | README ghi chính sách hỗ trợ/hoàn tiền chưa được triển khai/phê duyệt; email support cần xác nhận; checkbox checkout không dẫn tới Terms. | Chủ sở hữu phê duyệt chính sách, xác minh kênh hỗ trợ và liên kết các chính sách trong luồng checkout trước khi mở bán. |
| P1 — checkout reliability | Recovery/idempotency checkout | [`checkout/checkout.js`](../checkout/checkout.js), [`checkout/checkout-intent.js`](../checkout/checkout-intent.js) và server replay theo `(customer_id, idempotency_key)` hiện có cơ chế local recovery, cursor pagination, account scoping và stale-write protection. Cần tiếp tục theo dõi 5000-order safety cap, lost response và browser/profile lifecycle. | Giữ nguyên server replay; dùng các test browser/D1 hiện có để xác minh trước khi mở Production. |
| P1 — tài liệu vận hành | Hướng dẫn migrate Turso mâu thuẫn với script | README hướng dẫn dùng `npm run db:migrate:turso` với URL/token Turso; [`scripts/migrate-turso.ts`](../scripts/migrate-turso.ts) chỉ chấp nhận SQLite `file:` URL và token rỗng. | Viết lại README để mô tả đúng boundary; remote migration cần command và quy trình riêng được phê duyệt. |
| P1 — tài liệu schema | Tài liệu migration đã lệch và đã được đồng bộ trong đợt cleanup | [`DATABASE_SCHEMA.md`](DATABASE_SCHEMA.md) trước đây mô tả phạm vi kết thúc ở 0014 trong khi source có migrations tới 0023; tài liệu hiện đã ghi rõ 23 migrations và migration `0023`. [`FINAL-API-HANDOFF.md`](FINAL-API-HANDOFF.md) đã liệt kê ledger tới 0023. | Giữ sequence/migration ledger bất biến; không dùng tài liệu làm bằng chứng remote migration đã được áp dụng. |
| P1 — tài liệu kiến trúc | Một số tài liệu Preview/auth/Cloudinary là snapshot cũ hoặc mâu thuẫn | [`API_SPECIFICATION.md`](API_SPECIFICATION.md) có các tuyên bố Preview Cloudinary không nhất quán; [`SECURITY_PLAN.md`](SECURITY_PLAN.md) còn yêu cầu Cloudflare Access/MFA và mô tả admin chưa triển khai, trong khi source hiện có route/session admin ở cấp ứng dụng. | Gắn nhãn tài liệu lịch sử hoặc cập nhật một nguồn chuẩn; không coi source admin hiện tại là có MFA nếu chưa có bằng chứng. |
| P2 — vận hành | Hosting Production/provider chưa được quyết định và xác minh | Tài liệu hosting coi các phương án là đánh giá; không có bằng chứng cấu hình account/provider, Cron hosted hay khôi phục backup. | Chủ sở hữu chọn hosting và xác nhận riêng database, media, email, payments, Cron, logging và backup/recovery. |

Các mục trên là rủi ro kỹ thuật/vận hành và thiếu bằng chứng. Kiểm toán này không phải penetration test; không có khai thác hoặc kết luận lỗ hổng bảo mật từ các quan sát đó.

## 6. Tài liệu cần đồng bộ

1. **Migration:** [`README.md`](../README.md) phân biệt `db:migrate:turso` local-file với các lệnh preflight/migrate Turso staging. Script `scripts/migrate-turso.ts` từ chối remote URL/token; migration Preview/Turso dùng `scripts/staging-turso.ts` và cần xác nhận riêng.
2. **Schema:** [`DATABASE_SCHEMA.md`](DATABASE_SCHEMA.md), [`FINAL-API-HANDOFF.md`](FINAL-API-HANDOFF.md) và [`MIGRATION_MANIFEST.md`](MIGRATION_MANIFEST.md) hiện ghi nhận 24 migration trong [`migrations/`](../migrations), từ 0001 đến 0024. Migration 0024 không được coi đã áp dụng ở bất kỳ database remote nào.
3. **Hosting:** [`docs/HOSTING_PRODUCTION_EVALUATION.md`](HOSTING_PRODUCTION_EVALUATION.md) là đánh giá lựa chọn, không phải xác nhận đã chọn provider. Không dùng nó làm bằng chứng account hoặc deployment đã cấu hình.
4. **Preview và storage:** [`API_SPECIFICATION.md`](API_SPECIFICATION.md), [`SECURITY_PLAN.md`](SECURITY_PLAN.md), [`VERCEL_STAGING.md`](VERCEL_STAGING.md) và [`STAGING_DEPLOYMENT.md`](STAGING_DEPLOYMENT.md) có nội dung ở các thời điểm/kiến trúc khác nhau. Phân biệt Vercel/Turso/Cloudinary với Worker/D1/R2 và đánh dấu nội dung lịch sử.
5. **Báo cáo QA:** các báo cáo cũ là evidence theo thời điểm và baseline riêng; không thay thế test/runtime evidence của HEAD hiện tại.

Không sửa tài liệu hiện hữu trong đợt audit này; chúng được liệt kê làm việc cần lên lịch.

## 7. Dọn dẹp và tổ chức file

- **Không có file nào được xác minh là an toàn để xóa hoặc di chuyển.**
- Không xóa template 03–05, module riêng của template, migration, test fixture, hay báo cáo QA lịch sử.
- Giữ [`test-output.txt`](../test-output.txt): file này được tham chiếu bởi [`.vercelignore`](../.vercelignore) và [`tests/release-manifest.test.ts`](../tests/release-manifest.test.ts); chưa có căn cứ để xóa.
- Không đọc hoặc dọn các tệp local/ignored như `.dev.vars`, `.local`, `.wrangler`, SQLite hay session files.
- Không hợp nhất CSS/JavaScript giữa homepage và các template; không có yêu cầu kiến trúc nào cần làm việc đó.

## 8. Kiểm tra đã thực hiện

| Kiểm tra | Kết quả | Giới hạn |
|---|---|---|
| Git baseline/status | Ghi nhận trước khi tạo báo cáo | Không stage, commit, checkout hay sửa source |
| `npm run typecheck` | PASS | Type checking không xác minh deployment |
| `npm test` | Bị dừng sau khoảng 8 phút không có tiến triển/output mới; output một phần có nhiều test pass nhưng không có exit code/tổng kết | Suite chưa được xác nhận PASS/FAIL; cần tìm test/handle làm tiến trình treo trước khi chạy lại |
| `npm run test:integration` | Không chạy | Harness có ghi vào môi trường D1 local tạm; nằm ngoài phạm vi audit chỉ đọc |
| Build, deploy, browser/mobile, remote HTTP | Không chạy | Không có runtime assertion mới trong đợt này |
| Database/provider/payment/storage | Không truy cập từ xa | Không đọc database/credential và không tạo giao dịch |

Các log `*_failed` xuất hiện trong test output có vẻ là fixture của các trường hợp lỗi được kiểm tra; do test suite chưa kết thúc trước khi bị dừng, không dùng chúng để khẳng định toàn bộ suite thành công.

## 9. Lộ trình hoàn thiện đề xuất

| Bước | Ưu tiên | Hoàn tất khi |
|---|---|---|
| 1. Chốt release identity | P0 | Chủ sở hữu chọn commit SHA đích; branch/deployment Preview được xác nhận khớp SHA; các thay đổi chưa commit được phân loại riêng. |
| 2. Chốt mô hình image runtime | P0 | Sharp/native package được xác minh trong Vercel bundle/runtime trên đúng SHA, hoặc có quyết định rõ Worker không hỗ trợ ảnh; tài liệu và tests phản ánh quyết định đó. |
| 3. Xác minh và duy trì retry/recovery idempotency checkout | P0 trước checkout Production | Durable intent, payload fingerprint, server replay, pagination và stale-write guard đã có trong source/test. Cần giữ bằng chứng browser/D1 local và xác nhận không tồn tại race hoặc storage blocker trước Production. |
| 4. Hoàn tất customer/legal readiness | P0 trước checkout Production | Terms, Privacy, Refund/support policy được chủ sở hữu duyệt; email hỗ trợ được xác nhận; luồng checkout liên kết đúng chính sách. |
| 5. Đồng bộ tài liệu vận hành | P1 | Hướng dẫn Turso local/remote phân biệt chính xác; migration count, provider architecture, Preview/auth và Production status có một nguồn chuẩn. |
| 6. Kiểm thử local theo scope | P1 | `npm test` có exit code/tổng kết rõ; integration chạy riêng chỉ khi được cho phép và dùng tài nguyên local tạm đã xác định. |
| 7. Phase 1A.4-R3 read-only runtime audit | P1 — chưa bắt đầu | Có deployment Preview cụ thể và SHA được duyệt; audit chỉ HEAD/GET theo scope, kiểm tra các trang/assets đã chỉ định, headers/CSP/SRI; không gọi API hoặc tạo dữ liệu. |
| 8. Production readiness | P0 trước go-live | Hosting/provider, phân tách credentials, migration/backup/restore, media delivery, email, payment, Cron, logging/alerting và quy trình hỗ trợ được xác nhận trong từng account/môi trường. |

**Gate Phase 1A.4-R3:** trạng thái `NOT READY` để đưa ra kết luận runtime đầy đủ. Trước khi bắt đầu, xác nhận chính xác audit sẽ nhắm SHA `747b2a4…` hay một SHA mới có Sharp; không suy luận thay đổi chưa commit đã có trong Preview. R2 chỉ chứng minh một HEAD response 200.

## 10. Các hành động không thực hiện

- Không chỉnh sửa/xóa/di chuyển source, template, migrations hoặc báo cáo có sẵn.
- Không stage, commit, push, merge, checkout hoặc reset.
- Không build, deploy hoặc chạy integration test có ghi DB local.
- Không truy cập Vercel/Production, HTTP, API, database, storage, email hoặc payment provider trong đợt audit này.
- Không đọc secrets, environment variable values, credential store hoặc nội dung local database.

## 11. Progress update — 2026-11-26

This update supersedes the earlier audit-scope restrictions in section 10 where later work explicitly ran local tests or read-only Vercel CLI inspection. It does not authorize deployment, production writes, or payment activity.

### Verified repository state

- Branch: `preview/guest-mode`
- HEAD and `origin/preview/guest-mode`: `acbad610016879a06974b69b43d8eff77077e836`
- Original worktree: 30 items, 0 staged. The checkout browser fixture is now an additional modified tracked file from this work, so the current total is 31 items, 0 staged.
- No original dirty files were reverted, staged, committed, or pushed.

### Work completed and test evidence

- Repaired `tests/orders-2-10-browser-fixture.mjs`: fixture D1 queries now use the existing local integration Worker test route instead of starting a second Wrangler D1 process against the same temporary database.
- `npm run typecheck`: passed.
- `npm test`: passed, 346 tests, 0 failures.
- `npm run test:integration`: passed, including D1 API and payment contracts, legacy regression, constraints, and batch rollback.
- Checkout recovery browser E2E: passed for lost-response recovery, concurrent order-intent coordination, explicit new intent, and account/ownership isolation. The test used local test data, not a real payment.
- Homepage/template browser checks: homepage and all five template routes loaded; mobile-width checks found no horizontal overflow. Our Universe and Love Letter Three.js primary/fallback checks passed.
- `git diff --check`: passed. Browser checks are not a substitute for Production or full-device QA.

### Current launch gates

- Production checkout creation and SePay settlement remain disabled by application policy. SePay Live readiness is not established; no real payment was attempted.
- Read-only Vercel inspection showed a Ready Production deployment from Nov 20 and a Ready Preview deployment from Nov 25, but did not expose the Production source SHA. The inspected output did not verify current Production-branch configuration.
- Production environment variable names were inspected without reading values. `MAIL_API_KEY` and `MAIL_FROM_EMAIL` were absent from the returned names; database connectivity/schema/backup state and provider credentials remain unverified. Variable presence alone is not proof of service health.
- Production deployment, remote migrations, live payment enablement, and custom-domain work remain blocked pending the appropriate verification and explicit approval.
- Customer-facing policies still require owner review; comprehensive browser/mobile journey and Production smoke testing remain incomplete.

### Phase status

| Phase | Current status |
|---|---|
| 0 — Repository safety and audit | DONE for the current local baseline; preserve the 31-item worktree |
| 1 — Core customer experience | CORE JOURNEY VERIFIED LOCALLY; Love Letter close animation and customer-facing policy/support confirmation remain open |
| 2 — Accounts and customer websites | DONE LOCALLY; magic-link session lifecycle, dashboard login/logout, guest-draft recovery, saved-design reopening, responsive states, and two-customer data isolation passed; local-only website lifecycle remains gated |
| 3 — Orders and SePay | DONE LOCALLY; order/idempotency, server-side pricing, signed SePay Test/mock callbacks, replay, duplicate, failure, expiry, ownership, and fulfillment rollback passed; live SePay and Production settlement remain disabled and unverified |
| 4 — Custom Design | NOT FULLY VERIFIED; inspect full intake/review path and confirm operational handling |
| 5 — Production configuration | BLOCKED; email and remote database/migration readiness are not established |
| 6 — Security, policies, and trust | PARTIAL; existing safeguards/tests exist, but owner policy approval and full launch review are outstanding |
| 7 — Quality assurance | PARTIAL; automated and selected browser tests passed, while full customer journey/device matrix and Production smoke remain |
| 8 — Production test deployment | BLOCKED; do not deploy until branch/source, database, email, migration, payment safety, and explicit release approval are verified |

### Phase 5 read-only production preflight — 2026-11-27

#### Executive status

- **Launch status: BLOCKED / NOT VERIFIED.**
- The Vercel project `crushify` exists and the latest listed Production deployment is Ready, but the Production API currently fails runtime configuration validation.
- Static root and customer routes return HTTP 200; public `/api/v1/health/live` and `/api/v1/catalog` return `RUNTIME_CONFIGURATION_ERROR`.
- Production checkout/payment/fulfillment and deployed database/email/storage readiness remain unverified.

#### Read-only evidence

- Git: branch `preview/guest-mode`, HEAD/upstream `acbad610016879a06974b69b43d8eff77077e836`.
- Remote: `main` currently points to `3c70e4e809329767452b2d808bc8c04a8036305c`; `preview/guest-mode` points to `acbad610016879a06974b69b43d8eff77077e836`.
- Vercel project: `crushify`, project ID `prj_nw874WiBWiUZlIjBzOFn6yG2CeHH`, framework `Other`, root `.`, Node.js `26.x`, region `iad1`.
- Latest inspected Production deployment: ID `dpl_GeRSadFseZJ8KbYdfoVDfqrZSFLH`, Ready, created 2026-11-20, alias `crushify-one.vercel.app`.
- Production aliases include `crushify-git-main-ltdc9divine-5816s-projects.vercel.app`, indicating the main Git alias, but the exact commit represented by the latest deployment was not exposed by read-only CLI metadata.
- Runtime build includes API catch-all, versioned API, and Production lifecycle cron functions. The declared Cron is daily at `03:00 UTC`.
- `https://crushify-one.vercel.app/` returned 200 with HTTPS/HSTS and configured CSP/security headers.
- `/checkout/`, `/account/websites/`, and `/custom-design/` returned 200. `/api/v1/health/live` and `/api/v1/catalog` returned `RUNTIME_CONFIGURATION_ERROR`.

#### Environment name audit

No secret values are recorded below.

| Scope | Variable names observed | Status |
|---|---|---|
| Production | `DATABASE_PROVIDER`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `STORAGE_PROVIDER`, `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `ENVIRONMENT`, `APP_ORIGIN`, `CRON_SECRET`, `MAIL_PROVIDER` | PRESENT by name; validity and runtime compatibility NOT VERIFIED |
| Production email | `MAIL_API_KEY`, `MAIL_FROM_EMAIL` | MISSING from read-only variable-name list |
| Production payment | `PAYMENT_MODE`, `SEPAY_*` / Live webhook variables | ABSENT; source policy remains disabled |
| Preview | Turso, Preview mail, staging lifecycle, Cloudinary, auth allowlist, customer-flow gate, and SePay/preview payment names | PRESENT by name; values, account identity, delivery and deployment behavior NOT VERIFIED |

The observed Production runtime mismatch is independent of the environment-name inventory and must be resolved before accepting traffic.

#### Database and migration

- Source has 24 numbered migrations, `0001`–`0024`, and local D1/Turso adapter/test evidence.
- No remote read-only database identity, migration ledger, backup/PITR, restore, or foreign-key inventory could be verified.
- Status: **NOT VERIFIED / P0 blocker**.

#### Email

- Source supports Resend with `MAIL_PROVIDER`, `MAIL_API_KEY`, and `MAIL_FROM_EMAIL`.
- Read-only metadata shows `MAIL_PROVIDER` present but `MAIL_API_KEY` and `MAIL_FROM_EMAIL` absent.
- Sender/domain verification and actual delivery are NOT VERIFIED.
- Status: **BLOCKED / P0 blocker**.

#### SePay and payment

- Production payment variables are absent and source policy disables checkout/webhook settlement.
- Production recovery code exists but publication mutations and Live checkout remain disabled.
- Merchant account, Sandbox/Live account identity, webhook endpoint, and reconciliations are NOT VERIFIED.
- Status: **BLOCKED / P0 blocker**.

#### Domain, TLS, and public routes

- `crushify-one.vercel.app` is the observed Production alias and responds over HTTPS with HSTS.
- `luubut.work` appears as a Vercel account domain but is not evidence of Crushify attachment.
- No Crushify custom domain is confirmed by read-only evidence.
- Static public routes work, but API routes currently fail runtime validation.
- Status: **NOT VERIFIED / P0 blocker**.

#### Operations

- Production Cron source is configured, but deployed invocation, secret validity, and first execution are NOT VERIFIED.
- No public recovery or reconciliation endpoint was triggered.
- Status: **BLOCKED / P1 blocker**.

#### Phase 5 launch-readiness matrix

| Area | Status | Evidence | Risk / owner action |
|---|---|---|---|
| Source & Git | PASS locally / NOT VERIFIED deployment SHA | Local branch and remote SHAs verified; deployment exact commit mapping is not exposed. | Owner approves source branch/SHA mapping. |
| Vercel Deployment | BLOCKED | Project exists and Production deployment is Ready, but APIs fail runtime configuration validation. | Resolve Production environment scope/APP_ORIGIN/runtime marker; owner approval for changes. |
| Database & Migration | BLOCKED | Names present; remote database/ledger/backup unverified. | Provision/verify isolated Turso, migration ledger and backup/restore. |
| Storage | NOT VERIFIED | Production Cloudinary names present; account/provider behavior unverified. | Verify account separation and credentials. |
| Email | BLOCKED | `MAIL_PROVIDER` present; API key/from absent; no delivery evidence. | Configure/verify sender/domain and secret scope. |
| Payment & SePay | BLOCKED | No Production payment variables; source disables live settlement. | No change until account/security/reconciliation approval. |
| Order & Fulfillment | BLOCKED | Local tests pass; deployed API currently unavailable and fulfillment disabled. | Fix runtime config, then rerun deployed synthetic journey. |
| Hosting & Cron | BLOCKED | Cron source/deployment listed; invocation and secret not verified. | Configure/verify only after Production recovery approval. |
| Security & Privacy | NOT VERIFIED | Static security headers pass; runtime API and independent security review remain unverified. | Review CSP/deployed headers, policies and auth config. |
| Legal & Support | BLOCKED | No owner-approved public policies or verified support mailbox. | Owner supplies approved legal/support decisions. |
| Domain & TLS | PASS for HTTPS alias / NOT VERIFIED custom domain | HSTS/HTTPS works on Vercel alias; custom domain unconfirmed. | Owner decides launch domain and DNS. |
| Monitoring & Recovery | BLOCKED | No monitoring, alert, reconciliation or Cron evidence. | Add owner-approved operations and incident runbook. |

### Phase 1 local verification — 2026-11-26

- Exercised homepage filters, template cards, preview-modal CTA, mobile navigation, and catalog-derived prices/hosting against the local Worker.
- Browser-tested all five templates at 390, 768, and 1280 px: template selection, text personalization, preview, guest draft persistence, local sign-in handoff, saved design restoration, and checkout entry. Four photo-capable templates each accepted an additional uploaded image; the distance template has no image field.
- Exercised Our Universe story/memory navigation, Our Memories album paging, and Say Yes/No response paths. Love Letter's opening animation reached the open state; its close animation did not complete within the headless test window even with reduced motion. WebGL ran at low headless frame rates, so close behavior on a real device remains unverified.
- Our Universe image handoff was separately verified through the local image normalizer and asset upload/completion path. All template journeys left checkout disabled and did not submit orders. The separate checkout-recovery regression exercised only its local synthetic database/payment fixture; no real payment was attempted.
- Checked invalid preview error rendering and customer email required/format validation. Template and checkout journeys completed without uncaught page errors; removed a checkout `data:,` favicon that violated its CSP.
- The browser fixture now optionally enables its existing loopback-only image normalizer using `--with-local-image-normalizer`; default fixture runs retain the processor-unavailable behavior used by existing tests.
- Validation: `npm run typecheck`, `npm test` (346 passed, 0 failed), `npm run test:integration`, `python tests/checkout-recovery-browser.py`, and `python tests/guest-image-handoff-browser.py` passed. The checkout recovery test used local synthetic data and did not submit a real payment.
- Remaining Phase 1 customer-facing gap: the homepage has no privacy, terms, or refund-policy links, and the support mailbox is explicitly marked as needing owner confirmation. Do not invent policy content or mark these business decisions as verified.
- No Production API, Vercel setting, deployment, migration, or live payment was used. Current branch/HEAD/upstream are unchanged; worktree now has 33 status entries and 0 staged files.

### Phase 2 local verification — 2026-11-27

- Added a customer magic-link sign-in form to `/account/websites/`, including email autofill hints, native validation, loading/success/error notices, and an authenticated logout action.
- Added the `/account/websites/` return path to the server-side magic-link allowlist while retaining strict rejection of external, malformed, and unsupported return paths.
- Verified the dashboard establishes a session, persists it after reload, loads only the authenticated customer's designs/websites, reopens a saved design in the template editor, and revokes the session on logout.
- Verified guest-to-account recovery on a synthetic save failure: the browser reports that the original draft remains on-device, the save can be retried, the server design is created, and the temporary draft is deleted only after successful transfer.
- Verified owner-scoped dashboard isolation in the integration suite: a second customer’s `/api/v1/publications` response contains no design or publication belonging to the first customer.
- Verified local dashboard states and responsive layout at 390 px and 1280 px, including unauthenticated, empty, data-error/retry, and logout states.
- Validation: `npm run typecheck`, `npm test` (346 passed, 0 failed), `npm run test:integration`, `python tests/guest-image-handoff-browser.py`, `python tests/account-dashboard-browser.py`, and `git diff --check` passed. The account browser test used only local synthetic accounts and a local D1 fixture; no real email, payment, publication, or production operation was used.
- Existing account/publication lifecycle actions remain explicitly local-test-only where the architecture requires them. Expired sessions, invalid magic links, CSRF, cross-owner read/write requests, and local dashboard isolation remain covered by the passing auth/integration suites.
- Remaining Phase 2 risks: production email delivery is not verified, real-session persistence/expiry must be exercised in an approved deployed test environment, and unsupported/lifecycle actions must not be promoted until runtime credentials and production publication gates are verified.
- Current branch/HEAD/upstream remain `preview/guest-mode` / `acbad610016879a06974b69b43d8eff77077e836` / `acbad610016879a06974b69b43d8eff77077e836`. No commit, push, deployment, Vercel configuration change, production migration, real payment, or live fulfillment was performed.

### Phase 3 local verification — 2026-11-27

- Audited [src/payments.ts](</C:/Users/ltdc9/OneDrive/Desktop/======WORK======/crushify/src/payments.ts>) and confirmed order creation is authenticated, CSRF-protected, owner-scoped, and bound to server-derived product/hosting prices.
- Confirmed the Idempotency-Key is replay-safe and request-hash-bound; a replay after lost response reuses the original order, while a conflicting payload returns `409 IDEMPOTENCY_CONFLICT`.
- Confirmed order states and terminal transitions use existing records: `AWAITING_PAYMENT`, `MANUAL_REVIEW`, `PAID`, `FULFILLING`, `FULFILLED`, `FAILED`, `EXPIRED`, `CANCELLED`, `REFUND_PENDING`, and `REFUNDED`.
- Confirmed SePay Test mode is separate from local mock and Production: raw-body HMAC-SHA256, timestamp window, amount/reference/account matching, atomic evidence/payment/order updates, replay recovery, and duplicate transaction evidence are implemented.
- Confirmed invalid signatures, stale/future timestamps, wrong content type, invalid UTF-8, outgoing transfers, wrong amounts, expired/cancelled orders, settlement rollback, and conflicting webhooks remain unable to settle the original order.
- Confirmed local test-only fulfillment/publication behavior is isolated from Production: Production order creation and SePay webhook processing stay disabled; unknown runtimes and missing configuration fail closed.
- Existing [tests/payment-contract.mjs](</C:/Users/ltdc9/OneDrive/Desktop/======WORK======/crushify/tests/payment-contract.mjs>) provides the primary local end-to-end SePay contract; [tests/payments.test.ts](</C:/Users/ltdc9/OneDrive/Desktop/======WORK======/crushify/tests/payments.test.ts>) covers environment policy and signature safeguards.
- Validation for this phase: `npm run typecheck`, `npm test`, `npm run test:integration`, relevant browser tests, and `git diff --check` must pass in the local-only environment before moving forward.
- Remaining Phase 3 risks: live SePay credentials, merchant account approval, webhook delivery configuration, remote database/migration readiness, and real payment policy remain unverified and require explicit external approval.

### Phase 4 launch-readiness audit — 2026-11-27

#### Completed

- Audited the customer account/dashboard order information, hosting status cards, renewal controls, and checkout tracking surfaces.
- Audited the paid-order-to-publication fulfillment path and confirmed it requires verified payment evidence and settlement.
- Audited expiry, revoke/unpublish, renewal, retry, duplicate fulfillment, and customer ownership behavior.
- Audited the custom-design homepage/navigation copy and changed the public launch treatment to describe custom work only as an unlaunched review/intake idea.
- Audited legal/support surfaces and recorded the existing explicit blockers instead of inventing policies or verifying an email mailbox.

#### Customer operations

- PASS locally: owner-scoped design/order/publication APIs and dashboard isolation have local integration/browser evidence.
- PASS locally: checkout exposes order reference, amount, status, expiry, fulfillment, and test payment instructions only when supported.
- NOT VERIFIED externally: real account sessions, real customer support, deployed dashboard behavior, and a physical-device customer workflow.

#### Hosting and fulfillment

- PASS locally: paid-order fulfillment creates a single publication, storage entitlement, and completed fulfillment job; failed publication remains retryable.
- PASS locally: expiry and revoke/unpublish/republication guards are covered by synthetic lifecycle tests.
- PASS locally: renewal orders are server-priced and owner-bound.
- BLOCKED externally: lifecycle scheduler, Production publication mutations, operator recovery, and real fulfillment are disabled or unverified.

#### Custom Design

- Intake, owner status lookup, admin review communication, and customer replies are implemented locally.
- Quote versions, customer acceptance, custom payment, revision accounting, delivery, and project fulfillment remain unimplemented.
- Public homepage and footer no longer present Custom Design as an active launch service. The direct intake page clearly says it is not an open paid custom-design service.

#### Legal and support

- BLOCKED: privacy policy, terms of service, refund/cancellation policy, retention terms, and hosting-expiration policy require owner-approved content.
- BLOCKED: `hello@crushify.love` is a support address present in UI/docs but owner confirmation of delivery, ownership, inbox coverage, and response process is not established.
- NOT VERIFIED: business/legal entity, tax/accounting, refund authority, and SLA claims.

#### Launch readiness matrix

| Area | Status | Evidence | Next action / decision |
|---|---|---|---|
| Product and customer journey | NOT VERIFIED | Local browser/unit/integration evidence exists for templates and checkout; no approved deployed smoke journey exists. | Owner approves launch scope; run deployed browser smoke. |
| Authentication and account | PASS locally / NOT VERIFIED externally | Magic-link, session, CSRF, guest transfer, dashboard isolation and logout local tests pass. | Owner provisions/verifies Production email, domain and sessions. |
| Order and payment | PASS locally / BLOCKED externally | Server pricing, idempotency, ownership, signature/replay tests pass locally; Live checkout remains disabled. | Owner provisions isolated SePay Test/Live account and approves go-live policy. |
| Fulfillment and hosting | PASS locally / BLOCKED externally | Synthetic paid fulfillment, expiration, retry and publication lifecycle pass; scheduler/deployment are unverified. | Configure and verify isolated deployment, Cron and operator procedures. |
| Email and notifications | BLOCKED | Local email sink and adapters exist; no real sender/domain or mailbox verification exists. | Owner verifies sender domain, support mailbox and notification scope. |
| Database and migration | BLOCKED | 24 migrations and local D1/Turso tests exist; remote migration/backup/restore are unverified. | Owner provisions isolated database and approves preflight/migration/backup rehearsal. |
| Security and privacy | NOT VERIFIED | Auth/CSRF/owner and webhook safeguards pass local tests; independent review/deployed headers are unverified. | Complete deployment verification and independent security/privacy review. |
| Legal and support | BLOCKED | No owner-approved public policies or verified support mailbox/SLA. | Owner supplies approved policies, entity details and support commitments. |
| Deployment and domain | BLOCKED | Vercel routing/source exist; project, domain, HTTPS, headers and Production smoke are unverified. | Owner approves Vercel project and domain setup. |
| Business operations | NOT VERIFIED | Dashboard, refunds/reconciliation/admin procedures exist only partially; no operational runbook evidence. | Owner assigns operators and approves reconciliation/refund/support runbooks. |

#### Remaining launch blockers

- **P0:** Production database, migrations, backup/restore and remote configuration remain unverified.
- **P0:** Production email and payment/provider setup remain unavailable or unverified.
- **P0:** Live checkout, webhook settlement, publication and fulfillment recovery require explicit approval and deployed verification.
- **P0:** Owner-approved Privacy, Terms, Refund/Cancellation and hosting-expiration policies are missing.
- **P1:** Support mailbox ownership, monitoring, incident and reconciliation procedures must be verified.
- **P1:** Custom Design must remain intake-only until quote/payment/fulfillment scope is separately approved.
- **P1:** Scheduler/Cron, renewal, expiry and failed-fulfillment operator recovery require deployed testing.
- **P2:** Physical-device/mobile, Love Letter reduced-motion and public network/CDN smoke checks remain incomplete.

No real order, payment, email, migration, deployment, publication or fulfillment operation was performed during this audit.
