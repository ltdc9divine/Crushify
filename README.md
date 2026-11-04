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

Vercel Functions adapter dùng chung API router và business logic hiện có. API runtime yêu cầu Turso và Cloudinary (hoặc storage mock chỉ trong local test); Worker D1/R2 vẫn được giữ nguyên để rollback. Chưa deploy lên Vercel và không dùng Vercel Hobby cho hoạt động thương mại, bán hàng, checkout hoặc nhận thanh toán.

Với Node.js 22.6+ và Vercel CLI đã cài:

```powershell
New-Item -ItemType Directory -Force .local
if (-not (Test-Path .env.local)) { Copy-Item .env.example .env.local }
$env:TURSO_DATABASE_URL = "file:.local/crushify-vercel.db"
$env:TURSO_AUTH_TOKEN = ""
npm run db:migrate:turso
vercel dev
```

`.env.local` dùng `STORAGE_PROVIDER=mock` và `LOCAL_TEST_MODE=true` cho dữ liệu thử cục bộ. Không dùng file SQLite trên Vercel Preview/Production; Preview phải dùng Turso test database riêng và Cloudinary account riêng, secrets cấu hình qua Vercel server-side environment. `APP_ORIGIN` phải là origin chính xác của ứng dụng. API routes mặc định không cache; function giới hạn ảnh ở 4 MiB để nằm dưới giới hạn payload của serverless platform. Checkout và thanh toán chưa tồn tại.

Khi import repository lên Vercel, chọn **Other**, giữ project root ở repository root, không cần build command hay `vercel.json` cho static paths và catch-all function. Các trang template tiếp tục được phục vụ từ thư mục tĩnh `templates/`; không rewrite API thành HTML và không thay đổi tài nguyên riêng của template.

## Kiểm tra nhanh

Sau khi cập nhật giao diện hoặc đường dẫn, chạy `node --check` cho các tệp JavaScript và xác nhận trong trình duyệt:

1. `/` tải thành công, bộ lọc và điều hướng menu hoạt động.
2. Các trang `templates/<template>/index.html` tải CSS, JavaScript và tài nguyên của chính mẫu đó.
3. Mở các tương tác chính trên desktop và viewport di động; kiểm tra console và Network không có lỗi tải tài nguyên.

## Phạm vi hiện tại

- Trang chủ responsive, điều hướng menu, bộ lọc mẫu quà và cửa sổ xem trước.
- Các trải nghiệm Canvas/3D chạy độc lập dưới `templates/`.
- Bản nháp được lưu cục bộ trong trình duyệt ở những mẫu có hỗ trợ.
- Các phần hướng dẫn, bảng giá và lời kêu gọi hành động.

## Backend prototype (local only)

Requirements: Node.js 22.6 or newer and npm.

```powershell
npm install
Copy-Item .dev.vars.example .dev.vars
npm run db:apply:local
npm run dev
```

The local Cloudflare Worker serves the existing static site and exposes:

- `GET /api/v1/health/live` — process liveness.
- `GET /api/v1/health/ready` — D1 connectivity readiness.
- Customer email magic-link request/verification, session, and CSRF-protected sign-out.
- Owner-scoped Our Universe drafts with schema validation and optimistic revision checks.
- Private image upload, verification, read, and deletion through the selected adapter.
- Short-lived bearer preview tokens for Our Universe, including private preview photos.

`LOCAL_TEST_MODE=true` makes the local adapter print a one-time sign-in link in the Wrangler console; it does not send email. The Worker proxies image bytes to its private R2 binding; it does not issue presigned R2 URLs. `.dev.vars` is local-only and must not be committed.

Run the local checks:

```powershell
npm run typecheck
npm test
npm run test:integration
```

The integration test exercises local D1 and Wrangler's local R2 emulation. The Cloudflare Worker continues to use D1/R2. The Vercel Node adapter is locally integration-tested against an isolated Turso file database and in-memory storage, but has not been tested on Vercel itself. No remote Turso migration, production storage, email provider, Cloudflare account bindings/secrets, or staging deployment is configured. Do not use production customer data.

To apply the existing numbered SQLite migrations to a **new or verified empty** Turso database, set `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` in the server environment and run:

```powershell
npm run db:migrate:turso
```

The migration command checks applied migration checksums and foreign keys, runs each migration transactionally, and refuses databases containing application tables without a migration ledger. It does not connect automatically or migrate existing D1 data. See [docs/HOSTING_MIGRATION.md](docs/HOSTING_MIGRATION.md) for the staged migration status and safeguards.

The other four templates still use their existing browser-side draft/media flows. Checkout, payment/webhooks, order management, publishing, admin tooling, and production customer workflows are not implemented. Displayed prices remain informational and must not be treated as an active offer.

## Cloudflare staging

Staging uses the separate `wrangler.staging.jsonc` configuration and `crushify-staging-db`; use only `npm run db:apply:staging` and `npm run deploy:staging`. The D1 migrations are applied remotely. Deployment is currently blocked because R2 has not been enabled on the Cloudflare account; see [docs/STAGING_DEPLOYMENT.md](docs/STAGING_DEPLOYMENT.md). Do not use the local config for a remote deployment.
