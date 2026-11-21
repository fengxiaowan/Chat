# 小喵的桌面提醒脚本
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File notify.ps1 -Title "标题" -Message "内容" [-Urgent]
# 或（推荐，避免参数转义问题）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File notify.ps1 -Title "标题" -Message "内容" -Urgent
#
# -Urgent 会用更响的提示音（报警），适合「需要你决定/报错卡住」这类必须立刻看的场景。
param(
  [Parameter(Mandatory = $true)][string]$Title,
  [Parameter(Mandatory = $true)][string]$Message,
  [switch]$Urgent
)

# 音效：普通用默认提示音，紧急用提醒音
$sound = 'ms-winsoundevent:Notification.Default'
if ($Urgent) { $sound = 'ms-winsoundevent:Notification.Reminder' }

# 转义 XML 特殊字符，避免标题/内容里有 <>&" 导致 toast 解析失败
function Esc([string]$s) {
  return $s.Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;').Replace('"', '&quot;')
}

$t = Esc $Title
$m = Esc $Message

$xml = @"
<toast activationType="protocol" launch="">
  <visual>
    <binding template="ToastGeneric">
      <text>$t</text>
      <text>$m</text>
    </binding>
  </visual>
  <audio src="$sound" />
</toast>
"@

try {
  $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
  $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
  $doc.LoadXml($xml)
  $toast = New-Object Windows.UI.Notifications.ToastNotification $doc
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('DSH Companion').Show($toast)
  Write-Output 'ok'
} catch {
  # 现代 toast 失败时，退回 NotifyIcon balloon（老式气泡，兼容性更好）
  try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $n = New-Object System.Windows.Forms.NotifyIcon
    $n.Icon = if ($Urgent) { [System.Drawing.SystemIcons]::Warning } else { [System.Drawing.SystemIcons]::Information }
    $n.Visible = $true
    $n.BalloonTipTitle = $Title
    $n.BalloonTipText = $Message
    $n.BalloonTipIcon = if ($Urgent) { [System.Windows.Forms.ToolTipIcon]::Warning } else { [System.Windows.Forms.ToolTipIcon]::Info }
    $n.ShowBalloonTip(5000)
    Start-Sleep -Seconds 6
    $n.Dispose()
    Write-Output 'ok-fallback'
  } catch {
    Write-Output "fail: $($_.Exception.Message)"
    exit 1
  }
}
