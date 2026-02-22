#Requires AutoHotkey v2.0
#SingleInstance Force

; ===== Config =====
configFile := A_ScriptDir "\downvideo.ini"
defaultFolder := EnvGet("USERPROFILE") "\Downloads"
defaultName := "video_" FormatTime(A_Now, "yyyyMMdd_HHmmss") ".mp4"
defaultFfmpeg := FileExist(A_ScriptDir "\ffmpeg.exe") ? (A_ScriptDir "\ffmpeg.exe") : "ffmpeg.exe"
defaultAhk := A_AhkPath

savedFolder := IniRead(configFile, "Paths", "DownloadFolder", defaultFolder)
savedFfmpeg := IniRead(configFile, "Paths", "FfmpegPath", defaultFfmpeg)
savedAhk := IniRead(configFile, "Paths", "AhkPath", defaultAhk)

; ===== UI =====
gui1 := Gui("+AlwaysOnTop +MinSize900x380", "M3U8 Downloader (FFmpeg)")
gui1.BackColor := "F4F6FB"
gui1.SetFont("s10", "Segoe UI")

gui1.AddText("x20 y14 w720 c2F3A56", "M3U8 -> MP4 (nhanh gọn với FFmpeg)")

gui1.AddText("x20 y52 w120", "M3U8 URL")
urlEdit := gui1.AddEdit("x145 y48 w600 h26")

gui1.AddText("x20 y92 w120", "Tên file")
nameEdit := gui1.AddEdit("x145 y88 w600 h26", defaultName)

gui1.AddText("x20 y132 w120", "Thư mục lưu")
folderEdit := gui1.AddEdit("x145 y128 w600 h26", savedFolder)

gui1.AddText("x20 y172 w120", "FFmpeg exe")
ffmpegEdit := gui1.AddEdit("x145 y168 w600 h26", savedFfmpeg)

gui1.AddText("x20 y212 w120", "Đường dẫn AHK")
ahkEdit := gui1.AddEdit("x145 y208 w600 h26", savedAhk)

statusBox := gui1.AddGroupBox("x20 y252 w725 h88", "Trạng thái")
statusTx := gui1.AddText("x36 y282 w690 h44 c324057", "Sẵn sàng")

btnStart := gui1.AddButton("x770 y48 w170 h34", "Tải ngay")
btnOpen := gui1.AddButton("x770 y88 w170 h34", "Mở thư mục")
btnFolder := gui1.AddButton("x770 y128 w170 h34", "Chọn nơi lưu")
btnFfmpeg := gui1.AddButton("x770 y168 w170 h34", "Chọn FFmpeg")
btnAhk := gui1.AddButton("x770 y208 w170 h34", "Chọn AHK")

btnStart.OnEvent("Click", (*) => StartDownload())
btnOpen.OnEvent("Click", (*) => OpenFolder())
btnFolder.OnEvent("Click", (*) => PickFolder())
btnFfmpeg.OnEvent("Click", (*) => PickFfmpeg())
btnAhk.OnEvent("Click", (*) => PickAhk())
gui1.OnEvent("Close", (*) => SaveSettings())

gui1.Show("w960 h360")

PickFolder() {
    global folderEdit
    picked := DirSelect(folderEdit.Value, 3, "Chọn thư mục lưu")
    if (picked != "") {
        folderEdit.Value := picked
        SaveSettings()
    }
}

PickFfmpeg() {
    global ffmpegEdit
    picked := FileSelect(1, ffmpegEdit.Value, "Chọn ffmpeg.exe", "Executable (*.exe)")
    if (picked != "") {
        ffmpegEdit.Value := picked
        SaveSettings()
    }
}

PickAhk() {
    global ahkEdit
    picked := FileSelect(1, ahkEdit.Value, "Chọn AutoHotkey.exe", "Executable (*.exe)")
    if (picked != "") {
        ahkEdit.Value := picked
        SaveSettings()
    }
}

OpenFolder() {
    global folderEdit
    dir := Trim(folderEdit.Value)
    if (dir = "")
        dir := EnvGet("USERPROFILE") "\Downloads"
    if !DirExist(dir)
        DirCreate(dir)
    Run('explorer.exe "' dir '"')
}

StartDownload() {
    global urlEdit, nameEdit, folderEdit, ffmpegEdit, ahkEdit, statusTx

    url := Trim(urlEdit.Value)
    fileName := Trim(nameEdit.Value)
    outDir := Trim(folderEdit.Value)
    ffmpegPath := Trim(ffmpegEdit.Value)

    if (url = "") {
        MsgBox("Bạn chưa nhập link m3u8.")
        return
    }

    if (fileName = "")
        fileName := "video_" FormatTime(A_Now, "yyyyMMdd_HHmmss") ".mp4"
    if !RegExMatch(fileName, "\.mp4$", &_) 
        fileName .= ".mp4"

    if (outDir = "")
        outDir := EnvGet("USERPROFILE") "\Downloads"
    if !DirExist(outDir)
        DirCreate(outDir)

    if (ffmpegPath = "")
        ffmpegPath := "ffmpeg.exe"

    outPath := outDir "\" fileName
    statusTx.Value := "Đang tải... vui lòng chờ"
    SaveSettings()

    cmd := Q(ffmpegPath) " -y -i " Q(url) " -c copy " Q(outPath)
    exitCode := RunWait(cmd, , "Hide")

    if (exitCode = 0) {
        statusTx.Value := "Hoàn tất: " outPath
        MsgBox("Tải xong:`n" outPath)
    } else {
        statusTx.Value := "Lỗi. ExitCode=" exitCode
        MsgBox("FFmpeg lỗi (ExitCode=" exitCode ").`nKiểm tra link m3u8 / quyền truy cập / ffmpeg.")
    }
}

SaveSettings() {
    global configFile, folderEdit, ffmpegEdit, ahkEdit
    IniWrite(Trim(folderEdit.Value), configFile, "Paths", "DownloadFolder")
    IniWrite(Trim(ffmpegEdit.Value), configFile, "Paths", "FfmpegPath")
    IniWrite(Trim(ahkEdit.Value), configFile, "Paths", "AhkPath")
}

Q(text) {
    return '"' StrReplace(text, '"', '""') '"'
}