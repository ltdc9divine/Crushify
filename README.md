# Crushify — trang quà tặng số

Trang giới thiệu tĩnh, tương thích với nhiều kích thước màn hình, cho các món quà số của Crushify.

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

## Phạm vi hiện tại

- Trang chủ và điều hướng tương thích với nhiều kích thước màn hình.
- Trái tim hạt 3D dựng bằng Canvas, tự xoay và phản hồi theo vị trí con trỏ.
- Bộ lọc danh mục mẫu quà và cửa sổ xem trước.
- Các mẫu quà chạy độc lập trong thư mục `templates/`.
- Bản xem trước trực tiếp và lưu bản nháp cục bộ trên trình duyệt.
- Các phần hướng dẫn, bảng giá và lời kêu gọi hành động.

## Các tính năng chưa được kết nối

Bản nháp chỉ được lưu trong trình duyệt. Ảnh đã chọn chỉ được xem trước trên thiết bị và không được tải lên máy chủ hoặc lưu cùng bản nháp. Tài khoản người dùng, cơ sở dữ liệu, tải ảnh lên máy chủ, thanh toán và xuất bản liên kết chưa được triển khai. Giá hiển thị chỉ là giá dự kiến để thử nghiệm và cần được xác nhận trước khi mở bán.
