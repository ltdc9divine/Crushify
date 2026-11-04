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

## Triển khai lên Vercel

1. Tạo kho lưu trữ GitHub và tải nội dung thư mục này lên.
2. Nhập kho lưu trữ vào Vercel.
3. Chọn cấu hình framework: **Other**.
4. Để trống lệnh build.
5. Thư mục đầu ra: `.`
6. Triển khai.

Vercel hosting theo hướng dẫn trên chỉ phục vụ trang tĩnh; Worker/API cần triển khai riêng trên Cloudflare Workers. Chưa cấu hình triển khai backend trên Vercel.

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
- Private R2-compatible image upload, verification, read, and deletion through the Worker.
- Short-lived bearer preview tokens for Our Universe, including private preview photos.

`LOCAL_TEST_MODE=true` makes the local adapter print a one-time sign-in link in the Wrangler console; it does not send email. The Worker proxies image bytes to its private R2 binding; it does not issue presigned R2 URLs. `.dev.vars` is local-only and must not be committed.

Run the local checks:

```powershell
npm run typecheck
npm test
npm run test:integration
```

The integration test exercises local D1 and Wrangler's local R2 emulation. No production R2 bucket, email provider, Cloudflare account bindings/secrets, staging deployment, or remote smoke test is configured. Do not deploy this local setup or use production customer data.

The other four templates still use their existing browser-side draft/media flows. Checkout, payment/webhooks, order management, publishing, admin tooling, and production customer workflows are not implemented. Displayed prices remain informational and must not be treated as an active offer.

## Cloudflare staging

Staging uses the separate `wrangler.staging.jsonc` configuration and `crushify-staging-db`; use only `npm run db:apply:staging` and `npm run deploy:staging`. The D1 migrations are applied remotely. Deployment is currently blocked because R2 has not been enabled on the Cloudflare account; see [docs/STAGING_DEPLOYMENT.md](docs/STAGING_DEPLOYMENT.md). Do not use the local config for a remote deployment.
