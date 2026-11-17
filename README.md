# Crushify — trang quà tặng số

Trang giới thiệu tĩnh, tương thích với nhiều kích thước màn hình, cho các món quà số của Crushify.

## Cấu trúc dự án

```text
crushify/
├── index.html                 # Trang chủ, danh mục và cửa sổ xem trước
├── css/
│   └── style.css              # Kiểu dáng dùng chung cho trang chủ
├── js/
│   ├── main.js                # Điều hướng, bộ lọc và cửa sổ xem trước
│   └── particle-heart.js      # Hiệu ứng Canvas trên trang chủ
└── templates/
    ├── distance-means-nothing/ # Mẫu chia múi giờ/khoảng cách; ES modules
    ├── love-letter/            # Mẫu thư tình 3D; CSS/JS nằm trong HTML
    ├── our-memories/           # Album 3D và CSS/JS riêng
    ├── our-universe/           # Mẫu vũ trụ 3D; CSS/JS nằm trong HTML
    └── say-yes/                # Mẫu lời tỏ tình và CSS/JS riêng
```

Mỗi mẫu là một trải nghiệm độc lập: tài nguyên riêng nằm trong thư mục của mẫu; không đưa CSS hoặc JavaScript của mẫu vào các tệp dùng chung ở trang chủ. Giữ nguyên đường dẫn tương đối trong từng `index.html` để các trang tiếp tục hoạt động khi chạy cục bộ và triển khai tại thư mục gốc trên Vercel.

## Chạy trên máy

Mở `index.html` bằng trình duyệt. Hoặc chạy máy chủ cục bộ:

```bash
python -m http.server 5500
```

Sau đó truy cập `http://localhost:5500`.

## Vercel Development và API

Vercel Functions adapter dùng chung API router và business logic hiện có. Vercel là nền tảng hosting/deployment dự kiến; Cloudflare Worker/D1/R2 chỉ còn là đường local/legacy, không phải đích deployment đã được phê duyệt. Mã nguồn không xác nhận trạng thái project, deployment hoặc cấu hình Vercel hiện tại (**NOT VERIFIED**). Khả năng sử dụng gói Vercel hiện tại cho hoạt động thương mại cũng **NOT VERIFIED**; chủ sở hữu phải kiểm tra điều khoản và eligibility trước khi mở bán.

Với Node.js 22.6+ và Vercel CLI đã cài:

```powershell
New-Item -ItemType Directory -Force .local
if (-not (Test-Path .env.local)) { Copy-Item .env.example .env.local }
$env:TURSO_DATABASE_URL = "file:.local/crushify-vercel.db"
$env:TURSO_AUTH_TOKEN = ""
npm run db:migrate:turso
vercel dev
```

`.env.local` dùng `STORAGE_PROVIDER=mock` và `LOCAL_TEST_MODE=true` cho dữ liệu thử cục bộ. Không dùng file SQLite trên Vercel Preview/Production; Preview cần Turso staging database riêng. Source hỗ trợ customer flow và SePay Test-mode checkout trên Preview **chỉ khi** `PREVIEW_CUSTOMER_FLOW_ENABLED=true` và toàn bộ cấu hình Preview cô lập hợp lệ được cung cấp, bao gồm `PREVIEW_PAYMENT_MODE=sepay-test`, Test-mode webhook secret/account, database, storage, email và lifecycle secret. Đây là khả năng trong source, không phải bằng chứng rằng credentials, tài khoản, deployment hay giao dịch Sandbox đã được cấu hình/kiểm chứng (**NOT VERIFIED**). Production checkout và webhook settlement **NOT ENABLED**; Production fulfillment/publication chưa được chứng minh sẵn sàng. `APP_ORIGIN` phải là origin chính xác của ứng dụng. API routes mặc định không cache; function giới hạn ảnh ở 4 MiB.

Khi import repository lên Vercel, chọn **Other**, giữ project root ở repository root, không cần build command hay `vercel.json` cho static paths và catch-all function. Các trang template tiếp tục được phục vụ từ thư mục tĩnh `templates/`; không rewrite API thành HTML và không thay đổi tài nguyên riêng của template.

## Kiểm tra nhanh

Sau khi cập nhật giao diện hoặc đường dẫn, chạy `node --check` cho các tệp JavaScript và xác nhận trong trình duyệt:

1. `/` tải thành công, bộ lọc và điều hướng menu hoạt động.
2. Các trang `templates/<template>/index.html` tải CSS, JavaScript và tài nguyên của chính mẫu đó.
3. Mở các tương tác chính trên desktop và viewport di động; kiểm tra console và Network không có lỗi tải tài nguyên.

Responsive baseline đã được kiểm tra trên trình duyệt tại 1366×768, 1440×900, 390×844 và 375×812. Đã sửa tràn ngang trang chủ; Distance Means Nothing mở canvas hoặc fallback khi xem trên mobile. Các kiểm tra này không thay thế kiểm thử thiết bị thật hoặc Vercel Preview.

## Phạm vi hiện tại

- Trang chủ responsive, điều hướng menu, bộ lọc mẫu quà và cửa sổ xem trước.
- Các trải nghiệm Canvas/3D chạy độc lập dưới `templates/`.
- Bản nháp được lưu cục bộ trong trình duyệt ở những mẫu có hỗ trợ.
- Các phần hướng dẫn, bảng giá và lời kêu gọi hành động.

## Backend prototype (local only)

Requirements: Node.js 22.6 or newer and npm.

```powershell
npm install
if (-not (Test-Path .dev.vars)) { Copy-Item .dev.vars.example .dev.vars }
npm run db:apply:local
npm run dev
```

The local/legacy Cloudflare Worker serves the existing static site and exposes:

- `GET /api/v1/health/live` — process liveness.
- `GET /api/v1/health/ready` — D1 connectivity readiness.
- Customer email magic-link request/verification, session, and CSRF-protected sign-out.
- Owner-scoped Our Universe drafts with schema validation and optimistic revision checks.
- Private image upload, verification, read, and deletion through the selected adapter.
- Short-lived bearer preview tokens for Our Universe, including private preview photos.

For interactive local sign-in, start `npm run dev:email-sink` in a second terminal and set `LOCAL_TEST_MAIL_SINK_URL` in the ignored `.dev.vars` to the loopback URL printed by the command. Open the inbox URL in a browser and refresh it after requesting a sign-in link. The inbox sends no email, binds only to `127.0.0.1`, keeps links in memory, and never prints tokens. Without the sink, local sign-in mail is discarded. The Worker proxies image bytes to its private R2 binding; it does not issue presigned R2 URLs. `.dev.vars` is local-only and must not be committed.

Run the local checks:

```powershell
npm run typecheck
npm test
npm run test:integration
```

The integration test source uses local D1 and Wrangler's local R2 emulation. Its disposable database migrations run before the Worker starts, avoiding concurrent SQLite initialization. The Vercel Node adapter has local test coverage against an isolated Turso file database and in-memory storage; this does not verify a hosted Vercel deployment. Remote migrations, provider settings, account bindings/secrets, and staging deployment status are **NOT VERIFIED** here. Do not use production customer data.

To apply the existing numbered SQLite migrations to a **new or verified empty** Turso database, set `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` in the server environment and run:

```powershell
npm run db:migrate:turso
```

The migration command checks applied migration checksums and foreign keys, runs each migration transactionally, and refuses databases containing application tables without a migration ledger. It does not connect automatically or migrate existing D1 data. See [docs/HOSTING_MIGRATION.md](docs/HOSTING_MIGRATION.md) for the staged migration status and safeguards.

All five templates are connected in source to server-backed drafts, private previews, and checkout navigation; templates with photo editors also use private media APIs. The approved standard catalog is defined in `src/product-catalog.ts`: 59,000 VND including the first hosting month, 10,000 VND per additional month, or 199,000 VND Lifetime. Local tests use synthetic data. Preview checkout is an explicit opt-in requiring isolated resources and SePay Test-mode configuration; no such configuration, provider transaction, or deployed Preview journey is verified here. Production checkout and webhook settlement are **NOT ENABLED**. The custom-project portal/admin workflow and customer-facing refund/support terms are not implemented or approved. See [docs/SEPAY_SETUP.md](docs/SEPAY_SETUP.md) and [docs/INTEGRATION-STATUS.md](docs/INTEGRATION-STATUS.md).

## Legacy Cloudflare staging — not approved

Vercel is the intended hosting/deployment platform. Cloudflare staging is a legacy path and is not an approved deployment or migration target. The existing `npm run db:apply:staging` and `npm run deploy:staging` scripts still invoke remote Wrangler operations and have **no explicit confirmation gate**. Do not run them unless the owner separately approves Cloudflare staging and its target. No Cloudflare deployment/resource status was verified for this update; do not infer it from historical documentation.
