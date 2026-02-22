# InstallVideo

Tiện ích hỗ trợ bắt link stream video và script AHK mini để tải `m3u8` thành `mp4` bằng FFmpeg.

## Tổng quan (flow hoạt động)

Project này là **combo 2 phần**:

1. **Extension (InstallVideo)**
	- Chạy trên trình duyệt.
	- Nhiệm vụ chính: phát hiện/bắt link stream (đặc biệt là `m3u8`) từ trang video.
	- Extension **không xử lý remux/convert mạnh** như FFmpeg.

2. **AHK mini app (`downvideo.ahk`) + FFmpeg**
	- Bạn paste link `m3u8` lấy từ extension vào app AHK.
	- AHK gọi `ffmpeg.exe` để tải và ghép thành file `mp4`.
	- Có chọn thư mục lưu và lưu lại cấu hình.

Tóm tắt: **Extension để lấy link** -> **AHK + FFmpeg để tải/ghép MP4**.

## 1) Cài AutoHotkey + FFmpeg

Nếu máy chưa có:

- AutoHotkey v2: https://www.autohotkey.com/
- FFmpeg (Windows builds): https://www.gyan.dev/ffmpeg/builds/

Gợi ý nhanh:
- Cài AutoHotkey v2 bản installer.
- Tải FFmpeg bản **release full/build** (zip), giải nén, dùng `ffmpeg.exe` trong thư mục `bin`.

## 2) Chạy script AHK

File script: `downvideo.ahk`

- Double click `downvideo.ahk` để mở app mini.
- Dán link `m3u8` vào ô **M3U8 URL**.
- Nhập **Tên file** (mặc định sẽ tự sinh, đuôi `.mp4`).
- Chọn **Thư mục lưu** (mặc định `Downloads`).
- Chọn đường dẫn **FFmpeg exe** nếu chưa có trong PATH.
- (Tuỳ chọn) chọn đường dẫn **AHK**.
- Bấm **Tải ngay**.

## 3) Lưu cấu hình

App sẽ tự lưu config vào `downvideo.ini`:
- `DownloadFolder`
- `FfmpegPath`
- `AhkPath`

## 4) Lưu ý

- Một số nguồn `m3u8` có DRM/mã hoá sẽ không tải được.
- Nếu nguồn yêu cầu cookie/header đặc biệt, cần truyền thêm tham số FFmpeg nâng cao.
- Khuyến nghị dùng link `m3u8` hợp lệ lấy từ project extension.
