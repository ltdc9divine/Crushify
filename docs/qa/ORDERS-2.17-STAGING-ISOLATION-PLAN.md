# ORDERS-2.17 — Staging Isolation & Configuration Plan

**Ngày audit:** 2026-11-12

**Branch / HEAD:** `main` / `5205f730fd0141fb9c8d0697787b700e4bda04ff`
**Verdict: NOT READY FOR STAGING IMPLEMENTATION**

Đây là audit và kế hoạch. Không có source/configuration nào được sửa; không đọc giá trị secret; không kết nối database/provider, gửi email/webhook, triển khai, hoặc thay đổi Production.

## 1. Kết luận

Repository đã có một số guard cục bộ hữu ích: runtime Vercel chọn credential Turso theo scope, từ chối URL database không đúng scope, giới hạn mock storage ở local/Preview, giữ thanh toán ngoài local, và bảo vệ Cron bằng bearer secret. Script migration staging có kiểm tra profile, database/group/region, trạng thái migration và yêu cầu xác nhận riêng khi migrate.

Tuy vậy, môi trường Preview hiện chưa được chứng minh tách biệt hoàn toàn:

1. Không có `.vercel` project link trong workspace, vì vậy không thể xác minh cấu hình Preview/Production hiện hành. Không chạy lệnh có thể link project hoặc tạo trạng thái mới. Tài liệu trước đó ghi nhận Preview chưa có biến môi trường; đó là bằng chứng lịch sử, không phải kiểm tra hiện tại.
2. Quan trọng nhất, Cloudinary guard hiện tại **không chứng minh account/cloud staging khác Production**. Cloud từng được nhận diện trong tài liệu bị từ chối trực tiếp; tuy nhiên code không đối chiếu cloud staging với danh tính Production đã xác minh. Một cloud Production khác có thể vượt qua nếu được đặt trong biến staging cùng cờ xác nhận tự khai báo; khi đó Preview có thể upload hoặc xóa asset trong cloud đó. Không thử thao tác này. Cần một Cloudinary account/cloud staging độc lập đã được owner xác minh; chỉ dùng folder riêng trong cùng cloud không đủ làm ranh giới an toàn.
3. Không có bằng chứng hiện tại về Turso staging DB identity, Preview env vars, email test sink hoặc SePay Test Mode. Tài liệu cho biết candidate Turso chưa xác nhận; không có remote DB nào được truy cập trong task này.
4. Vercel Cron khai báo lịch cho Production; Vercel không chạy lịch Cron trên Preview. Preview lifecycle cần kiểm thử thủ công trên dữ liệu synthetic hoặc một runner staging được phê duyệt riêng.
5. Adapter Vercel không chuyển email/payment credentials vào Preview. Vì vậy không thể xem đăng nhập email hoặc SePay Test Mode trên Preview là khả dụng hiện tại.

Đây không phải kết luận Production readiness. ORDERS-2.16 đã kết luận chưa sẵn sàng cho controlled staging và Production.

## 2. Phạm vi và bằng chứng

Đã đọc [ORDERS-2.16](ORDERS-2.16-FINAL-PRODUCTION-READINESS.md), [VERCEL_STAGING.md](../VERCEL_STAGING.md), [HOSTING_MIGRATION.md](../HOSTING_MIGRATION.md), các báo cáo ORDERS-2.13/2.14/2.15, và kiểm tra có giới hạn các file [src/platform/vercel.ts](../../src/platform/vercel.ts), [src/storage/cloudinary.ts](../../src/storage/cloudinary.ts), [scripts/staging-config.ts](../../scripts/staging-config.ts), [scripts/staging-turso.ts](../../scripts/staging-turso.ts), [src/payments/sepay.ts](../../src/payments/sepay.ts), [src/auth.ts](../../src/auth.ts), [src/scheduler.ts](../../src/scheduler.ts), [src/index.ts](../../src/index.ts), `vercel.json`, và Wrangler configs.

Kiểm tra Vercel trực tiếp không thực hiện: CLI có mặt nhưng không có project link trong workspace. Không lấy/pull env, không yêu cầu login, không link project. Không đọc `.env`, `.dev.vars`, hay giá trị env bất kỳ. Báo cáo Vercel staging cũ ghi Preview không có env vars trong lần kiểm tra trước; Production variable presence chưa được xác minh. Không dùng lịch sử này làm trạng thái hiện thời.

## 3. Isolation risk matrix

| Dịch vụ / luồng | Trạng thái | Bằng chứng hiện có | Nguy cơ dùng chung Production | Tách biệt cần thiết | Cách xác minh an toàn / điều kiện PASS |
|---|---|---|---|---|---|
| Vercel Preview và Production | NOT TESTED | Không có `.vercel` project link; không truy vấn dashboard/CLI. Tài liệu cũ ghi Preview chưa có env vars, nhưng không phải kiểm tra mới. | Preview vars được đặt ở scope Preview có thể áp dụng cho nhiều branch Preview; fork/untrusted Preview có nguy cơ nhận credential nếu protection/scope sai. | Preview deploy bảo vệ; chỉ cấp secrets cho staging branch/project đáng tin cậy; không gắn Production domain. Cân nhắc Vercel project staging riêng nếu không thể giới hạn branch. | Owner kiểm tra project, branch, fork protection, protection và env scopes chỉ bằng tên/presence; chứng minh deploy Preview không nhận credential Production và Production không nhận credential staging. |
| Turso database | PARTIAL | Runtime chỉ chọn `TURSO_STAGING_*` trong staging; từ chối generic Production credentials trong Preview và URL hostname không thuộc staging pattern. Script migration yêu cầu xác nhận database/group/region, migration ledger/checksum và xác nhận riêng. Chưa xác minh account hoặc DB từ xa. | Nếu staging hostname là alias hoặc database thực tế dùng chung, pattern hostname và tên biến không chứng minh dữ liệu tách biệt. Sai token có thể cho phép ghi/sửa DB khác. | DB staging riêng trong cùng organization có thể dùng nếu chắc chắn là database độc lập; token auth giới hạn ở DB đó. Không dùng Production DB hoặc token. | Owner đối chiếu database ID/name, organization, group, region và quyền token trong dashboard; độc lập kiểm tra với Production identity. PASS khi staging identity và token scope tách riêng, synthetic marker chỉ xuất hiện trong staging, không có Production rows/credentials. |
| Cloudinary cloud/account | BLOCKED | Adapter tạo authenticated original, public derivative và có thao tác upload/destroy. Runtime chọn staging vars và chặn cloud từng được nhận diện; `CLOUDINARY_STAGING_ISOLATED_ACCOUNT` chỉ là xác nhận chuỗi do người cấu hình đặt. Không xác minh cloud hiện tại, không gọi Cloudinary. | **Có nguy cơ.** Cấu hình dùng đúng cloud đã bị chặn sẽ thất bại; nhưng code không đối chiếu danh tính Production từ xa và cloud Production khác có thể được cấu hình cùng cờ xác nhận. Khi credentials trỏ tới cùng cloud, Preview có quyền API để ghi/xóa asset. Folder/prefix riêng không phải ranh giới account. | Account riêng và cloud staging riêng cùng credential API key/secret riêng; hoặc `STORAGE_PROVIDER=mock` khi chỉ kiểm tra UI (ephemeral, không phù hợp media persistence). | Owner xác minh account/cloud identity và API credential trong Cloudinary Dashboard, chỉ đọc; so sánh với Production mà không đưa giá trị vào log/chat. PASS khi account/cloud khác hẳn, credentials riêng, synthetic namespace riêng, quyền/delivery private/public được kiểm tra trên staging account. |
| Upload preset/folder/asset namespace Cloudinary | PARTIAL | Upload signing được server thực hiện; private originals dùng authenticated type, derivatives có namespace published. Chưa kiểm tra Cloudinary preset hoặc account-level delivery policy từ xa. | Cùng cloud/API credentials có thể truy cập phạm vi rộng hơn folder. Folder không phải security boundary. Preset cấu hình lỏng có thể làm lộ original. | Không dựa vào upload preset public hoặc folder làm ranh giới account. Nếu dùng preset, chỉ signed và staging-only. | Kiểm tra cấu hình preset, access mode, API key scope, asset delivery và deletion bằng synthetic asset trên account riêng; PASS khi anonymous không đọc original và chỉ publication derivative được public. |
| SePay | BLOCKED | Parser xác minh HMAC-SHA256 trên timestamp + raw body, timing-safe compare, kiểm tra reference/account/amount; test là synthetic. Vercel adapter chỉ cho payment mode/secret trong local development; Preview/Production không được cấu hình payment runtime từ adapter. Provider account không được truy cập. | Nếu sau này Test callback trỏ vào Production endpoint/DB hoặc dùng Production secret, test settlement có thể ảnh hưởng đơn thật. | Provider Test account/config riêng, Preview/Staging DB riêng, webhook URL riêng, test secret/bank account riêng. Không dùng Live credentials. | Trước khi bật, cần thay đổi code được review để staging mode tường minh và mặc định tắt; xác nhận route nhận staging DB; kiểm thử signed synthetic/Test payload và provider test callback. PASS khi test callback không thể truy cập/settle bất kỳ Production order nào. |
| Email/magic link | BLOCKED | Vercel adapter chỉ chuyển `MAIL_*` khi `VERCEL_ENV=production`; Preview không có email service qua adapter. Local test adapter ghi link vào log, chỉ dành local. Provider/delivery chưa kiểm tra. | Dùng Production sender/key trong Preview có thể gửi email cho người thật; log link mang bearer token. | Email sandbox/test provider hoặc sender/key riêng; giới hạn người nhận allowlist. Không dùng Production key/list. | Xác minh sink không deliver ra ngoài allowlist và template link dùng Preview origin; test một mailbox đã được cho phép sau khi owner duyệt. PASS khi không gửi tới địa chỉ ngoài danh sách, token không vào logs/response. |
| Cron / publication lifecycle | PARTIAL | `vercel.json` khai báo route `/api/cron/publication-lifecycle` theo lịch hằng ngày 03:00 UTC. Handler yêu cầu bearer secret dài tối thiểu 32 ký tự và cặp environment hợp lệ. Chưa xác minh deployment hoặc Cron execution; Vercel không chạy lịch Cron trên Preview. Wrangler scheduled handler còn trong code nhưng configs hiện không khai báo Cron trigger. | Dùng nhầm Production secret/URL để chạy staging có thể tác động Production. Nếu bật thêm Cloudflare Cron bên cạnh Vercel, có nguy cơ chạy kép; lease giảm cạnh tranh nhưng không thay thế việc quản lý scheduler rõ ràng. | Preview hiện không có auto Cron. Production dùng Vercel Cron. Local chạy lifecycle trực tiếp với synthetic data. Staging dùng manual protected call hoặc scheduler riêng đã được duyệt và chỉ dùng Preview secret. | PASS cho staging khi synthetic record hết hạn được xử lý, record còn hạn được giữ nguyên, replay/idempotency/retry đạt yêu cầu và route/secret chỉ thuộc Preview. Production cần PASS riêng sau khi quan sát lịch chạy trên deployment Production được ủy quyền. |
| Authentication, cookies, callback/origin | PARTIAL | Cookie session có `HttpOnly`, `SameSite=Lax`, `Secure` trừ local; cookie CSRF client đọc được và có `Secure` ngoài local. Origin có thể lấy từ Vercel Preview URL, nhưng `APP_ORIGIN` override phải chính xác. Preview mail chưa hoạt động. Chưa có browser test remote. | `APP_ORIGIN` sai có thể tạo link/CORS dùng Production origin hoặc từ chối Preview origin. Credentialed CORS dựa trên origin đã cấu hình. Cookie host-only (không có `Domain`) nhưng điều đó không thay thế việc tách DB/session. | Dùng HTTPS origin riêng cho Preview; cookie host-only; không dùng Production custom domain, session store, callback URI hoặc allowlist. Email sandbox chỉ tạo callback Preview. | Owner kiểm tra hostname/redirect URI và cấu hình mà không mở trang protected; browser test sau đó xác nhận cookie flags, origin/CSRF, phạm vi login link và session DB riêng. PASS khi Preview origin/callback không trỏ Production và session chỉ tồn tại trong DB staging. |
| Logs / redaction | PARTIAL | Vercel database-init và Cron handlers log error code/name đã lọc. `src/index.ts` vẫn log raw error object ở catch chung và readiness failure; chi tiết provider/stack có thể chứa dữ liệu nhạy cảm. Local test email logger ghi magic-link text. Chưa audit observability remote. | Secret, URL, payload/PII hoặc magic-link bearer token có thể lọt vào log nếu exception/provider chứa chúng hoặc log local bị chia sẻ. | Tách project/quyền đọc log theo môi trường; redact object/headers/body/URL/token; không bật debug payload. Xem log local có link là secret và không chia sẻ. | Kiểm tra redaction bằng sentinel synthetic (không dùng secret thật); xác nhận log/alert không chứa token, Authorization, cookies, DB URL, webhook body, email/link, ảnh hoặc PII. PASS sau khi reviewer duyệt log đã redact cùng quyền truy cập/retention. |

## 4. Missing configuration matrix

Trạng thái dưới đây phản ánh bằng chứng có trong lúc audit, không khẳng định biến môi trường hiện có hay không có trên dashboard.

| Scope | Status | Tên biến môi trường cần thiết | Ghi chú / điều kiện |
|---|---|---|---|
| Vercel Preview baseline | NOT TESTED | `ENVIRONMENT`, `DATABASE_PROVIDER`, `TURSO_STAGING_DATABASE_URL`, `TURSO_STAGING_AUTH_TOKEN`, `STORAGE_PROVIDER` | Không thể xác minh presence từ dashboard. Với mock storage, không cần Cloudinary. Không đặt generic Production Turso variables. |
| Preview origin | PARTIAL | `APP_ORIGIN`, `VERCEL_URL` | `VERCEL_URL` do Vercel cung cấp có thể làm origin nếu không override. Nếu set `APP_ORIGIN`, phải là HTTPS Preview origin, không phải production alias. |
| Preview Cloudinary (chỉ khi có account độc lập) | BLOCKED | `CLOUDINARY_STAGING_CLOUD_NAME`, `CLOUDINARY_STAGING_API_KEY`, `CLOUDINARY_STAGING_API_SECRET`, `CLOUDINARY_STAGING_ISOLATED_ACCOUNT` | Không set trước khi account/cloud khác Production được xác minh. Chuỗi self-attestation không phải bằng chứng isolation. |
| Preview authentication email | BLOCKED | `MAIL_PROVIDER`, `MAIL_API_KEY`, `MAIL_FROM_EMAIL` | Adapter hiện không forward các biến này vào Preview. Cần thiết kế/triển khai test sink hoặc staging-only mail path trước; không dùng Production sender/key. |
| Preview lifecycle thủ công | NOT TESTED | `CRON_SECRET` | Nếu cần gọi protected Preview route thủ công, dùng secret riêng Preview, không dùng Production secret. Không có Preview Cron đã cấu hình. |
| Preview payment | BLOCKED | `PAYMENT_MODE`, `SEPAY_WEBHOOK_SECRET`, `SEPAY_BANK_CODE`, `SEPAY_BANK_ACCOUNT`, `SEPAY_ACCOUNT_NAME` | Giữ vắng mặt/disabled trong Vercel theo guard hiện tại. Staging SePay chưa được hỗ trợ bởi adapter. |
| Production runtime (đối chiếu tên, chưa kiểm tra presence) | NOT TESTED | `ENVIRONMENT`, `DATABASE_PROVIDER`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `STORAGE_PROVIDER`, `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `APP_ORIGIN`, `MAIL_PROVIDER`, `MAIL_API_KEY`, `MAIL_FROM_EMAIL`, `CRON_SECRET` | Chỉ liệt kê tên theo code/docs; không inspect hoặc ghi lại presence/value. Production không được nhận biến `TURSO_STAGING_*` hoặc `CLOUDINARY_STAGING_*`. |
| Turso migration thao tác local | PARTIAL | `CRUSHIFY_STAGING_PROFILE`, `ENVIRONMENT`, `VERCEL_ENV`, `DATABASE_PROVIDER`, `TURSO_STAGING_DATABASE_URL`, `TURSO_STAGING_AUTH_TOKEN`, `TURSO_CONFIRM_DATABASE`, `TURSO_CONFIRM_GROUP`, `TURSO_CONFIRM_REGION`, `TURSO_MIGRATE_CONFIRM`, `TURSO_SMOKE_TEST` | Script có guard profile/identity và synthetic opt-in; tên được đọc từ code, không thực hiện lệnh. Chỉ migration khi backup và target identity đã xác minh. |
| Cloudinary smoke test local | BLOCKED | `CRUSHIFY_STAGING_PROFILE`, `ENVIRONMENT`, `VERCEL_ENV`, `STORAGE_PROVIDER`, `CLOUDINARY_STAGING_CLOUD_NAME`, `CLOUDINARY_STAGING_API_KEY`, `CLOUDINARY_STAGING_API_SECRET`, `CLOUDINARY_STAGING_ISOLATED_ACCOUNT`, `CLOUDINARY_SMOKE_TEST` | Không chạy đến khi account/cloud staging được xác minh riêng và synthetic-data opt-in được owner duyệt. |

**Không ghi giá trị env vào report, ticket, shell history hay Git.** Tên `SEPAY_*`/payment và Production secret chỉ được nêu để xác định hiện trạng code; không phải yêu cầu bật chúng.

## 5. Safe staging architecture được đề xuất

1. **Vercel:** dùng Preview deployment/project được bảo vệ, chỉ cấp secrets cho branch staging đáng tin cậy. Không gắn production domain; tránh cấp Preview secrets cho untrusted fork/deploy. Nếu không thể giới hạn branch trong cùng project, dùng Vercel project staging độc lập.
2. **Turso:** một database staging riêng với database-scoped auth token riêng. Production tiếp tục dùng database/token Production; không export/import customer data. Vercel serverless filesystem không phải database persistent.
3. **Storage:** giai đoạn UI/API đầu dùng mock storage và chấp nhận rằng asset không durable. Trước khi kiểm thử upload/reload hoặc lifecycle media, dùng Cloudinary account/cloud staging riêng và credentials riêng. Không dùng một cloud cùng Production, kể cả dùng folder/prefix khác.
4. **Auth/email:** hiện chưa có Preview email path. Trước authenticated staging, triển khai/duyệt một sink riêng hoặc provider test giới hạn recipient; chỉ sinh link Preview và không log link. Không bật `LOCAL_TEST_MODE` trong Preview.
5. **Payment:** mock/Test settlement vẫn tắt ở Preview. SePay Test Mode cần một công việc code riêng để có staging-only opt-in, endpoint, secret và DB staging; không nới guard local-only như một phần của task này.
6. **Lifecycle:** local dùng synthetic runner/tests. Preview expiry/cleanup dùng manual invocation có guard với Preview-only secret hoặc runner được phê duyệt; không giả định Vercel Cron chạy Preview. Production dùng duy nhất Vercel Cron cho đến khi một thay đổi được duyệt khác.
7. **Logs:** không log request/response body, credentials, cookies, magic links, signature, DB URL hoặc ảnh. Cấu trúc log chỉ gồm request ID, environment label, sanitized error code, state counters và kết quả job; hạn chế quyền đọc/retention theo môi trường.

## 6. Step-by-step implementation plan

1. **Owner inventory, chỉ đọc:** xác định Vercel project/team/branch/Preview protection; lấy danh sách env var *names/presence* cho Preview và Production qua dashboard được phép. Không pull env/values. Xác nhận ai có quyền thay đổi và quy trình phê duyệt.
2. **Turso isolation:** owner xác nhận hoặc tạo database staging riêng (không tạo nếu candidate chưa rõ); kiểm tra identity, location, state và token scope. Tạo backup trước mọi schema change. Dùng migration preflight trước; migrate chỉ sau xác nhận database cụ thể và phê duyệt riêng.
3. **Cloudinary isolation blocker:** xác nhận bằng dashboard rằng staging account/cloud độc lập với Production. Nếu không thể tạo cloud riêng miễn phí, tiếp tục `STORAGE_PROVIDER=mock` và không tuyên bố media staging đã kiểm thử. Không thay thế bằng folder/prefix trong Production cloud.
4. **Thay đổi code/config cần review trước khi nhập secret:** (a) gia cố Cloudinary isolation, không phụ thuộc riêng vào cờ tự khai báo; xác minh staging không thể chọn cloud Production; (b) email sink/recipient allowlist và origin validation riêng cho staging; (c) structured redaction cho raw error object; (d) payment contract riêng cho staging nếu Test Mode nằm trong scope. Không có thay đổi nào trong số này được thực hiện ở ORDERS-2.17.
5. **Thiết lập Vercel Preview:** sau khi branch/project scope được duyệt, chỉ nhập credential staging qua secret manager/dashboard. Đảm bảo generic `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, Production Cloudinary keys và mọi Live payment values không xuất hiện trong Preview. Không lưu `.env` trong repo.
6. **Migration staging:** từ môi trường local cô lập đã được duyệt, chạy preflight chỉ đọc; xác minh lại database identity; kiểm tra backup/restore; chỉ migrate sau khi có approval riêng. Không chạy migration từ Preview runtime và không trỏ script generic vào Production.
7. **Preview smoke:** chỉ dùng account/design/image synthetic; kiểm tra login sink, cookie/origin/CSRF, ownership, save/reload, upload trên cloud staging, ranh giới derivative/private-original, deletion retry, cleanup và logs. Không bật payment.
8. **Lifecycle:** xác nhận expiry/read denial trên request độc lập với Cron; chạy manual scheduled route bằng Preview-only secret và synthetic DB nếu policy được duyệt. Ghi rõ đây không phải auto-scheduler. Không gọi Production Cron.
9. **Readiness sign-off:** lưu evidence đã sanitize theo từng gate, bảo đảm artefact không có value/PII, rồi cập nhật staging report. Production preflight và payment setup là các gate riêng, cần approval mới.

## 7. Verification checklist

### Vercel

- [ ] Project/branch Preview được xác định; deployment protection và fork policy phù hợp.
- [ ] Inventory env chỉ ghi tên/trạng thái presence; không có Production credential trong Preview và không có staging credential trong Production.
- [ ] Preview hostname HTTPS tách biệt; `APP_ORIGIN`/redirect không trỏ tới production alias/domain.
- [ ] Preview deployment dùng Node runtime và routes dự kiến; không suy diễn rằng deployment đã tồn tại.

### Turso và migration

- [ ] Owner xác minh staging database ID/name, organization/group, region và sự khác biệt với Production.
- [ ] Token giới hạn cho database staging; không đọc/ghi value vào report.
- [ ] Backup staging được xác minh và restore drill thực hiện trên database disposable riêng.
- [ ] Migration preflight kiểm tra ledger/checksum/schema; chỉ migration từ local runner với xác nhận và approval.
- [ ] Preview runtime không dùng file DB ephemeral, không auto-migrate và không fallback sang generic Production credentials.

### Cloudinary

- [ ] Account/cloud staging khác Production và được owner xác minh.
- [ ] Credentials tách biệt; cloud identity không dựa riêng vào folder, prefix hoặc confirmation string.
- [ ] Chỉ upload/delete synthetic asset trên cloud staging sau khi được duyệt.
- [ ] Original vẫn authenticated/private; anonymous original fetch thất bại; chỉ derivative được public sau publication flow được duyệt.
- [ ] Cleanup retry và metadata mismatch được test mà không dùng asset Production.

### Email, auth, SePay và lifecycle

- [ ] Email sink staging không gửi ra ngoài recipient allowlist; link token không xuất hiện trong logs/API response.
- [ ] Cookie session có Secure/HttpOnly/SameSite=Lax; CSRF/origin enforcement đúng trên HTTPS Preview.
- [ ] SePay tiếp tục tắt trừ khi thay đổi staging-only đã được review; Test callback chỉ đến endpoint/database staging.
- [ ] Replay, timestamp/signature invalid, transaction replay, amount/reference mismatch được test bằng synthetic/mock; không gửi webhook thật.
- [ ] Không giả định Preview Cron đang chạy. Manual lifecycle test dùng Preview secret, synthetic rows, retry/idempotency và không truy cập Production.
- [ ] Log sentinel xác nhận không có credential, URL/token, cookies, magic-link, raw payload hoặc PII.

## 8. Rollback plan

1. Nếu Preview cấu hình sai hoặc phát hiện nguy cơ cross-environment, ngừng dùng URL và chặn deployment theo quy trình owner. Không chuyển Preview sang Production làm phương án dự phòng.
2. Chỉ thu hồi/luân chuyển credential staging đã xác định bị ảnh hưởng, thông qua owner và quy trình provider; không luân chuyển Production nếu chưa đánh giá tác động/được duyệt.
3. Nếu migration staging lỗi, dừng ghi vào staging, lưu chẩn đoán đã sanitize và khôi phục backup vào một database staging riêng. Không rollback bằng cách xóa/ghi đè Production database.
4. Nếu upload staging đi nhầm nơi, dừng thao tác Cloudinary; không bulk delete. Xác định asset staging có thẩm quyền và chỉ cleanup từng asset sau khi xác nhận account/namespace.
5. Nếu email/webhook đi nhầm nơi, tắt credential test/provider staging sau khi được duyệt, ngừng endpoint test và kiểm tra log đã sanitize; không xử lý pending/paid order thủ công như workaround.
6. Nếu Preview release có lỗi, chỉ rollback Preview deployment/configuration về last-known-good sau khi kiểm tra database compatibility; không thay đổi Production alias, data, environment hoặc Cron.
7. Mọi hành động thu hồi credential, xóa resource, migration, rollback deployment hoặc thay đổi provider cần owner tương ứng phê duyệt. Kế hoạch này không cấp sự phê duyệt đó.

## 9. Những thao tác cần user/owner authorization

- Link/xác định Vercel project; đọc tên/trạng thái env trên dashboard; thay đổi branch protection hoặc Preview settings.
- Tạo database/token staging; chạy migration; tạo/restore backup hoặc ghi synthetic row lên dịch vụ remote.
- Tạo Cloudinary account/cloud/API key; upload/delete asset, kể cả synthetic asset remote.
- Bật email provider/sink, gửi email test hoặc thêm recipient allowlist.
- Tạo/cấu hình SePay Test account/webhook hoặc gửi callback provider.
- Thêm Preview scheduler/runner, lưu `CRON_SECRET` hoặc gọi lifecycle endpoint remote.
- Thay đổi Production/Live, giao dịch thật, billing/điều khoản account, domain, deployment hoặc thu hồi credential (ngoài phạm vi ORDERS-2.17).

## 10. Repository state và verdict

Status awal `git status --short --untracked-files=all`:

```text
 M _headers
 M docs/HOSTING_MIGRATION.md
 M docs/PAYMENT_FLOW.md
 M docs/PRODUCT_ARCHITECTURE.md
 M docs/PUBLICATION_AND_DELIVERY.md
 M docs/STAGING_DEPLOYMENT.md
 M docs/VERCEL_STAGING.md
 M shared/customer-editor.js
 M src/platform/vercel.ts
 M templates/distance-means-nothing/index.html
 M templates/love-letter/index.html
 M templates/our-memories/index.html
 M templates/our-memories/our-memories.js
 M templates/our-universe/index.html
 M templates/say-yes/index.html
 M templates/say-yes/say-yes.css
 M templates/say-yes/say-yes.js
 M tests/browser-love-letter.mjs
 M tests/integration.mjs
 M tests/payment-contract.mjs
 M tests/publications.test.ts
 M tests/scheduler.test.ts
 M tests/template-registry.test.ts
 M vercel.json
 M wrangler.jsonc
 M wrangler.staging.jsonc
?? docs/qa/ORDERS-2.11C-FIVE-TEMPLATE-CHECKOUT.md
?? docs/qa/ORDERS-2.12-CONSOLIDATED-RELEASE-REVIEW.md
?? docs/qa/ORDERS-2.13-LIFECYCLE-CRON-RESOLUTION.md
?? docs/qa/ORDERS-2.14-TURSO-CLOUDINARY-READINESS.md
?? docs/qa/ORDERS-2.15-SEPAY-PAYMENT-READINESS.md
?? docs/qa/ORDERS-2.16-FINAL-PRODUCTION-READINESS.md
?? docs/qa/ORDERS-2.3-2.6-FINAL-QA-REPORT.md
?? tests/orders-2-10-browser-fixture.mjs
```

Sau khi tạo báo cáo, trạng thái dự kiến là cùng 26 modified tracked files và 8 untracked files ở trên, cộng báo cáo này thành untracked thứ 9:

```text
?? docs/qa/ORDERS-2.17-STAGING-ISOLATION-PLAN.md
```

Không có source code hoặc environment/deployment config nào được sửa. Không reset/checkout/clean/stash; không truy cập `session.json`; không kết nối remote, inspect secret value, upload/delete asset, gửi email, giao dịch, deploy, commit, push, merge hoặc thay đổi Production. `git diff --check` đã được chạy sau khi tạo báo cáo và trả về thành công.

### NOT READY FOR STAGING IMPLEMENTATION

Các bước và điều kiện PASS đã rõ, nhưng chưa an toàn để bắt đầu triển khai staging cho tới khi xác minh Vercel scope và resource identity, đặc biệt là Cloudinary account riêng, đồng thời xử lý Preview email/auth và logging. Mock/local evidence không chứng minh remote isolation. Verdict này không kết luận Production ready và không cấp phép thao tác provider.
