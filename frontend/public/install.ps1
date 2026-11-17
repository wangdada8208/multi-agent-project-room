# MAPR 本机助手一键安装脚本（Windows，PowerShell 5.1+）
#
# 用法（网站「我的 Agent」页给出配对码后）：
#   方式 A（推荐，能传参数）：
#     iex "& { $(irm https://hub.wangdada8208.xyz/install.ps1 -UseBasicParsing) } -Pair mpc_xxx"
#   方式 B（先存文件再跑）：
#     irm https://hub.wangdada8208.xyz/install.ps1 -OutFile install.ps1
#     powershell -ExecutionPolicy Bypass -File .\install.ps1 -Pair mpc_xxx
#   管道用法 `iwr ... | iex` 没法传参数，此时配对码可放环境变量 $env:MAPR_PAIR_CODE，
#   或装完后手动运行 mapr up --pair mpc_xxx。
#
# 参数：
#   -Pair <配对码>   装好后立即启动本机助手并完成配对
#   -Hub <Hub 地址>  默认 https://hub.wangdada8208.xyz（或环境变量 MAPR_HUB_ORIGIN）
#   -Uninstall       撤掉开机自启、停掉本机助手进程，保留 %USERPROFILE%\.mapr 数据
#   -Purge           卸载并连数据一起删（默认询问，-Yes 跳过）
#   -Yes             跳过 -Purge 的确认
#
# 环境变量：
#   MAPR_HUB_ORIGIN   Hub 地址
#   MAPR_PKG_URL      发布包（tar.gz）地址，默认 <Hub>/downloads/xmtp-member-latest.tar.gz
#                     WP6 备注：发布流水线就位后这个默认地址即生效（见 install.sh 头部注释）。
#   MAPR_PAIR_CODE    管道方式无法传参时，从这里读配对码
#
# 写文件的位置：%USERPROFILE%\.mapr\ + 当前用户「启动」文件夹里的一个快捷方式。
# 不需要管理员权限。重复运行 = 升级包体并保留 helper.json 等数据（幂等）。
# 自启方式说明：用「启动文件夹快捷方式 → wscript 隐藏运行 mapr-up.vbs」实现；
#   另一种可选是 schtasks 计划任务（schtasks /create /sc onlogon），需要弹控制台
#   窗口或额外配置才能隐藏，本脚本选了更简单的快捷方式方案。
[CmdletBinding()]
param(
  [string]$Pair,
  [string]$Hub,
  [switch]$Uninstall,
  [switch]$Purge,
  [switch]$Yes
)
$ErrorActionPreference = 'Stop'

$Root = Join-Path $env:USERPROFILE '.mapr'
$PkgDir = Join-Path $Root 'pkg'
$BinDir = Join-Path $Root 'bin'
$Port = 8790
$StartupLnk = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\MAPR Helper.lnk'

$HubOrigin = $Hub
if (-not $HubOrigin) { $HubOrigin = $env:MAPR_HUB_ORIGIN }
if (-not $HubOrigin) { $HubOrigin = 'https://hub.wangdada8208.xyz' }
$HubOrigin = $HubOrigin.TrimEnd('/')
$PkgUrl = $env:MAPR_PKG_URL
if (-not $PkgUrl) { $PkgUrl = "$HubOrigin/downloads/xmtp-member-latest.tar.gz" }
if (-not $Pair) { $Pair = $env:MAPR_PAIR_CODE }

function Warn([string]$m) { Write-Host "警告: $m" -ForegroundColor Yellow }
function Die([string]$m) { Write-Host "错误: $m" -ForegroundColor Red; exit 1 }

# ── 卸载 / 清除：委托给安装时落盘的 uninstall.ps1 ──
if ($Uninstall -or $Purge) {
  $un = Join-Path $Root 'uninstall.ps1'
  if (Test-Path $un) {
    $uargs = @('-NoProfile','-ExecutionPolicy','Bypass','-File',$un)
    if ($Purge) { $uargs += '-Purge' }
    if ($Yes)   { $uargs += '-Yes' }
    & powershell @uargs
    exit $LASTEXITCODE
  }
  if (-not (Test-Path $Root)) { Write-Host "未安装（$Root 不存在）。"; exit 0 }
  Die "$Root 存在但 uninstall.ps1 缺失，请手动删除「启动」文件夹里的 MAPR Helper.lnk 后删掉该目录。"
}

# ── 环境检查 ──
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Die "检测不到 Node.js。
本机助手需要 Node.js 22.6 或更高版本，本脚本不会自动安装。
请先从 https://nodejs.org/ 下载 22 LTS（或更新）安装，然后重新运行这条命令。"
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Die "检测不到 npm（应随 Node.js 一起安装）。请装好 Node.js 后重试。"
}
$nodeVer = (& node -v) -replace '^v',''
$parts = $nodeVer -split '\.'
$major = [int]$parts[0]; $minor = 0
if ($parts.Count -gt 1 -and $parts[1] -match '^\d+$') { $minor = [int]$parts[1] }
if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 6)) {
  Die "Node.js 版本太低（当前 v$nodeVer，需要 >= 22.6）。请升级后重新运行。"
}
if (-not (Get-Command tar -ErrorAction SilentlyContinue)) {
  Die "检测不到 tar（Windows 10 1803+ 自带 tar.exe）。请升级系统或手动安装 bsdtar。"
}

# ── 下载并解开发布包到 %USERPROFILE%\.mapr\pkg\ ──
New-Item -ItemType Directory -Force -Path $BinDir,(Join-Path $Root 'agents'),(Join-Path $Root 'seats'),(Join-Path $Root 'sandbox') | Out-Null

$tmp = Join-Path $env:TEMP ("mapr-install-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
try {
  Write-Host "正在下载发布包：$PkgUrl"
  $pkgTgz = Join-Path $tmp 'pkg.tar.gz'
  try {
    if ($PkgUrl -match '^file://(.+)$' -or (Test-Path $PkgUrl -PathType Leaf)) {
      # 本地联调：MAPR_PKG_URL 指向 file:/// 或本地文件路径
      $localPath = $PkgUrl -replace '^file:///?', '' -replace '/', '\'
      Copy-Item $localPath $pkgTgz
    } else {
      Invoke-WebRequest -Uri $PkgUrl -OutFile $pkgTgz -UseBasicParsing
    }
  } catch {
    Die "下载失败：$($_.Exception.Message)。检查网络，或用环境变量 MAPR_PKG_URL 指定其它地址。"
  }
  New-Item -ItemType Directory -Force -Path (Join-Path $tmp 'ex') | Out-Null
  & tar -xzf (Join-Path $tmp 'pkg.tar.gz') -C (Join-Path $tmp 'ex')
  if ($LASTEXITCODE -ne 0) { Die "发布包解压失败（不是有效的 tar.gz）。" }
  $top = @(Get-ChildItem -Force (Join-Path $tmp 'ex'))
  if ($top.Count -eq 1 -and $top[0].PSIsContainer) { $pkgSrc = $top[0].FullName } else { $pkgSrc = Join-Path $tmp 'ex' }
  if (-not (Test-Path (Join-Path $pkgSrc 'package.json'))) { Die "发布包结构不对：里面没有 package.json。" }

  $pkgNew = Join-Path $Root 'pkg.new'
  if (Test-Path $pkgNew) { Remove-Item -Recurse -Force $pkgNew }
  Move-Item $pkgSrc $pkgNew
  Write-Host "正在安装依赖（npm install --omit=dev，在 $pkgNew 里）…"
  Push-Location $pkgNew
  try { & npm install --omit=dev } finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) {
    Remove-Item -Recurse -Force $pkgNew -ErrorAction SilentlyContinue
    Die "npm install 失败（网络问题或依赖源不可用）。原有安装未受影响。"
  }
  $pkgOld = Join-Path $Root 'pkg.old'
  if (Test-Path $pkgOld) { Remove-Item -Recurse -Force $pkgOld }
  if (Test-Path $PkgDir) { Move-Item $PkgDir $pkgOld }
  Move-Item $pkgNew $PkgDir
  if (Test-Path $pkgOld) { Remove-Item -Recurse -Force $pkgOld }
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

# ── 写 bin\mapr.cmd、bin\mapr-up.vbs、uninstall.ps1 ──
$maprCmd = @'
@echo off
rem mapr — MAPR 本机助手命令行入口（install.ps1 生成，重复安装会重写本文件）
if /i "%~1"=="uninstall" goto uninstall
node --experimental-strip-types "%USERPROFILE%\.mapr\pkg\src\cli.ts" %*
exit /b %errorlevel%

:uninstall
rem shift 只影响 %~1，不影响 %*，所以逐个收集剩余参数
shift
set "_uargs="
:ul
if "%~1"=="" goto urun
set "_uargs=%_uargs% "%~1""
shift
goto ul
:urun
powershell -NoProfile -ExecutionPolicy Bypass -File "%USERPROFILE%\.mapr\uninstall.ps1"%_uargs%
exit /b %errorlevel%
'@
Set-Content -Path (Join-Path $BinDir 'mapr.cmd') -Value $maprCmd -Encoding ASCII

# 注意：下面是 VBS 源码，字符串里的 "" 是 VBS 的转义引号（= 一个 "）。
$vbs = @"
' mapr-up.vbs — 隐藏窗口启动本机助手；参数透传（install.ps1 生成）
Dim fso, shell, root, i, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("Wscript.Shell")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
cmd = "cmd.exe /c node --experimental-strip-types """ & root & "\pkg\src\cli.ts""" & " up --hub $HubOrigin"
For i = 0 To WScript.Arguments.Count - 1
  cmd = cmd & " """ & WScript.Arguments(i) & """"
Next
cmd = cmd & " >> """ & root & "\helper.log"" 2>&1"
shell.CurrentDirectory = root
shell.Run cmd, 0, False
"@
Set-Content -Path (Join-Path $BinDir 'mapr-up.vbs') -Value $vbs -Encoding ASCII

$uninst = @'
# MAPR 本机助手卸载（install.ps1 生成）
# 用法: powershell -File uninstall.ps1 [-Purge] [-Yes]
[CmdletBinding()]
param([switch]$Purge,[switch]$Yes)
$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$lnk = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\MAPR Helper.lnk'
if (Test-Path $lnk) { Remove-Item -Force $lnk; Write-Host "已移除「启动」文件夹里的自启项。" }

# 停掉仍在运行的本机助手（命令行里带 cli.ts 路径的 node 进程）。
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like '*\.mapr\pkg\src\cli.ts*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

if (-not $Purge) {
  Remove-Item -Force (Join-Path $Root 'bin\mapr.cmd'),(Join-Path $Root 'bin\mapr-up.vbs'),(Join-Path $Root 'uninstall.ps1') -ErrorAction SilentlyContinue
  Write-Host "卸载完成：自启项和 mapr 命令已移除。$Root 下的数据已保留。"
  Write-Host "要连数据一起删：Remove-Item -Recurse -Force `"$Root`""
  exit 0
}
if (-not $Yes) {
  $ans = Read-Host "确认删除 $Root 下的全部数据（配对信息、席位私钥不可恢复）？输入 yes 继续"
  if ($ans -ne 'yes') { Write-Host "已取消。"; exit 1 }
}
Remove-Item -Recurse -Force $Root
Write-Host "已删除 $Root"
'@
Set-Content -Path (Join-Path $Root 'uninstall.ps1') -Value $uninst -Encoding UTF8

# ── 开机自启：「启动」文件夹快捷方式 → wscript 隐藏运行 vbs ──
$wsh = New-Object -ComObject WScript.Shell
$lnk = $wsh.CreateShortcut($StartupLnk)
$lnk.TargetPath = 'wscript.exe'
$lnk.Arguments = '"' + (Join-Path $BinDir 'mapr-up.vbs') + '"'
$lnk.Description = 'MAPR 本机助手（127.0.0.1:8790）'
$lnk.Save()
Write-Host "已写入开机自启：$StartupLnk（当前用户登录时生效，无需管理员）"

# ── 本机接口探测与配对 ──
function Test-Hello { try { return Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/hello" -TimeoutSec 2 } catch { return $null } }

$pairState = 'not-requested'
if ($Pair) {
  if ($Pair -notmatch '^mpc_.+\..+') { Warn "配对码长得不像 mpc_... ，仍继续尝试" }
  $hello = Test-Hello
  if ($null -ne $hello) {
    Write-Host "检测到本机助手已在运行，直接通过本地接口配对…"
    try {
      Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$Port/api/pair" `
        -Headers @{ 'X-MAPR-Owner' = '1' } -ContentType 'application/json' `
        -Body (@{ code = $Pair } | ConvertTo-Json) -TimeoutSec 8 | Out-Null
      $pairState = 'paired'
    } catch { $pairState = 'pair-failed' }
  } else {
    Write-Host "正在启动本机助手并配对…"
    Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + (Join-Path $BinDir 'mapr-up.vbs') + '"'), '--pair', ('"' + $Pair + '"') -WindowStyle Hidden
    $deadline = (Get-Date).AddSeconds(15)
    do {
      Start-Sleep -Milliseconds 500
      $hello = Test-Hello
      if ($null -ne $hello) { break }
    } while ((Get-Date) -lt $deadline)
    if ($null -ne $hello -and $hello.paired) { $pairState = 'paired' }
    elseif ($null -ne $hello) { $pairState = 'pair-pending' }
    else { $pairState = 'process-died-or-slow' }
  }
} else {
  Write-Host "正在启动本机助手…"
  Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + (Join-Path $BinDir 'mapr-up.vbs') + '"') -WindowStyle Hidden
  Start-Sleep -Seconds 2
}

# ── 结果汇报 ──
Write-Host ""
Write-Host "──── 安装完成 ────"
Write-Host "助手目录: $Root"
Write-Host "mapr 命令: $BinDir\mapr.cmd（要直接在终端用，可把 $BinDir 加进 PATH）"
Write-Host "开机自启: 「启动」文件夹快捷方式（mapr uninstall 可撤销；下次登录生效）"
switch ($pairState) {
  'paired'      { Write-Host "配对: 成功" }
  'pair-failed' { Warn "配对请求被本机助手拒绝（配对码过期或已用？）。可在 http://127.0.0.1:$Port/ 页面里重新输入配对码。" }
  'pair-pending'{ Warn "本机助手已启动但 15 秒内没确认配对结果。看日志 $Root\helper.log。" }
  'process-died-or-slow' { Warn "本机助手 15 秒内没起来。看日志 $Root\helper.log，或手动运行 `"$BinDir\mapr.cmd`" up --hub $HubOrigin" }
}
$hello2 = Test-Hello
if ($null -ne $hello2) { Write-Host "本机助手运行中: http://127.0.0.1:$Port/" }
Write-Host ""
Write-Host "撤销安装: powershell -File `"$Root\uninstall.ps1`"（保留数据）或加 -Purge（连数据一起删）"
