# Map Look — 3D từ OpenStreetMap

Ứng dụng demo: vẽ một khu vực trên bản đồ, tải dữ liệu OSM bằng Overpass và dựng mô hình 3D đơn giản bằng Three.js.

Yêu cầu
- Trình duyệt hiện đại (Chrome/Edge/Firefox)
- Máy có WebGL

Chạy
1. Mở terminal trong thư mục `map-look`.
2. Chạy một static server (ví dụ Python):

```bash
# với Python 3
python -m http.server 8000
```

3. Mở `http://localhost:8000` trong trình duyệt.

Ghi chú
- Ứng dụng dùng Overpass API công khai — tránh gửi nhiều truy vấn lớn.
- Mô hình 3D là xấp xỉ: các tòa nhà được extrude từ footprint, đường và sông hiển thị dưới dạng đường, cây là hình nón.
- Để cải thiện: thêm texturing, chính xác hóa chuyển đổi tọa độ (sử dụng Proj4), dùng height tags, và thêm LOD/hiệu năng.

Files
- `index.html` — giao diện chính
- `src/main.js` — logic map, fetch, và render 3D
