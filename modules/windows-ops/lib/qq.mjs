// qq.mjs —— 通过机器人自己的 QQ 客户端（GUI）发起「屏幕共享 / 邀请对方远程协助」
// 来源：aurabot 模块库 modules/windows-ops（本仓库原创，MIT）。
// 作用：不走截图、不走自建网页，直接用 QQNT 客户端聊天工具栏里的原生按钮：
//       · 屏幕共享：点聊天工具栏「屏幕共享」→ 在「选择你想共享的窗口」里选「桌面」→「确定」；
//       · 远程协助：点「远程协助」右侧箭头 → 菜单「邀请对方远程协助」→ 等主人接受。
//       窗口识别优先按「机器人 QQ 号」：QQ 命令行和窗口树都不暴露 QQ 号，但账号分区
//       %APPDATA%\QQ\Partitions\qqnt_<QQ号> 里的 WAL 文件被该账号的主进程锁着，
//       用 RestartManager 反查 PID 即可精确锁定，与昵称无关；查不到再用昵称兜底。
// 契约：QQ_OPS（操作元数据，danger 交给 lib/safety.mjs）
//   qqScripts({ PREFIX, ARGS }) → { <op>: 静态 PowerShell 脚本模板 }
//   prepareQq(op, args) → { argv, summary }
//   interpretQq(op, out) → { ok, message, data? }
// 参数（argv 全是字符串，经 ps.b64arg 塞进 $a）：
//   qq.windows   —— []
//   qq.share     —— [hwnd(0=自动), botName, ownerName, botQQ, 等待选择框秒数]
//   qq.shareStop —— [hwnd, botName, ownerName, botQQ]
//   qq.assist    —— [hwnd, botName, ownerName, botQQ]
//   qq.assistStop—— [hwnd, botName, ownerName, botQQ]
// 真机铁律：
//   · UIA 元素跨进程不能缓存：每次 FromHandle → 现查现用；
//   · 点击前必须 ShowWindow + SetForegroundWindow，并用 SetProcessDPIAware 修正 200% 缩放；
//   · 找不到窗口/按钮/选择框一律返回 { ok:false, message }，不 throw。

/** QQ 原生操作的元数据：share/assist 会真的把屏幕或控制权交出去 → input。 */
export const QQ_OPS = {
  'qq.windows': { label: '列出机器人 QQ 窗口', danger: 'safe' },
  // 共享只把屏幕给主人看，不接管键鼠；真正的控制权风险在 qq.assist → input。
  'qq.share': { label: 'QQ 屏幕共享（机器人客户端）', danger: 'safe' },
  'qq.shareStop': { label: '停止 QQ 屏幕共享', danger: 'safe' },
  'qq.assist': { label: 'QQ 邀请对方远程协助', danger: 'input' },
  'qq.assistStop': { label: '取消 QQ 远程协助邀请', danger: 'safe' },
}

/** 空值统一成字符串（hwnd 用 '0' 表示自动）。 */
function str(v) {
  return String(v ?? '').trim()
}

/**
 * 参数整理：hwnd 0=自动；botQQ 优先按 QQ 号锁定机器人窗口；botName/ownerName 作兜底。
 * @param {string} op
 * @param {object} args
 */
export function prepareQq(op, args = {}) {
  if (!QQ_OPS[op]) throw new Error(`未知操作：${op}`)
  if (op === 'qq.windows') return { argv: [], summary: '' }
  const hwnd = Math.max(0, Math.round(Number(args.hwnd) || 0))
  const botName = str(args.botName)
  const ownerName = str(args.ownerName)
  const botQQ = str(args.botQQ)
  if (!hwnd && !botQQ && !botName && !ownerName) {
    throw new Error('要定位机器人 QQ 窗口：请填机器人 QQ 号（botQQ）、机器人昵称（botName）、主人昵称（ownerName），或直接给窗口句柄 hwnd')
  }
  if (op === 'qq.share') {
    const wait = Math.min(60, Math.max(5, Math.round(Number(args.waitSec) || 20)))
    return { argv: [String(hwnd), botName, ownerName, botQQ, String(wait)], summary: `机器人窗口${hwnd ? `#${hwnd}` : botQQ ? `QQ ${botQQ}` : `（${botName || ownerName}）`}，等待 ${wait}s` }
  }
  return { argv: [String(hwnd), botName, ownerName, botQQ], summary: `机器人窗口${hwnd ? `#${hwnd}` : botQQ ? `QQ ${botQQ}` : `（${botName || ownerName}）`}` }
}

/** 拆脚本输出：Emit 打的是 UTF-8 base64 JSON；测试注入也兼容直接 JSON。 */
function decode(out) {
  const s = String(out ?? '').trim()
  if (!s) return null
  if (s.startsWith('{') || s.startsWith('[')) {
    try { return JSON.parse(s) } catch { return null }
  }
  try { return JSON.parse(Buffer.from(s, 'base64').toString('utf8').trim()) } catch { return null }
}

/**
 * qq.* 的统一 PowerShell 底座。
 * PREFIX/ARGS 由 lib/ops.mjs 注入，保证「压进度流 + base64 参数」只有一份实现。
 */
export function qqScripts({ PREFIX, ARGS }) {
  // C# 只做四件事：枚举顶层窗口、DPI 感知、前台/点击、读窗口矩形。没有用户输入。
  const PINVOKE = `
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
public class QqWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern void mouse_event(uint f, int x, int y, uint d, int e);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  // RestartManager：账号分区里的 DIPS-wal / SharedStorage-wal 被哪个 QQ 进程占着。
  // 这是「QQ 号 → 进程」唯一可靠的映射（QQ 命令行里没有账号，窗口树里也没有 QQ 号）。
  [StructLayout(LayoutKind.Sequential)] struct RM_UNIQUE_PROCESS {
    public int dwProcessId;
    public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct RM_PROCESS_INFO {
    public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName;
    public int ApplicationType;
    public uint AppStatus;
    public uint TSSessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
  }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, string strSessionKey);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint pSessionHandle);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmRegisterResources(uint pSessionHandle, uint nFiles, string[] rgsFilenames, uint nApplications, RM_UNIQUE_PROCESS[] rgApplications, uint nServices, string[] rgsServiceNames);
  [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint dwSessionHandle, out uint pnProcInfoNeeded, ref uint pnProcInfo, [In, Out] RM_PROCESS_INFO[] rgAffectedApps, ref uint lpdwRebootReasons);
  public static void Aware() { try { SetProcessDPIAware(); } catch {} }
  public static void Show(IntPtr h) { ShowWindow(h, 9); SetForegroundWindow(h); }
  public static void Click(int x, int y) {
    Aware(); SetCursorPos(x, y); System.Threading.Thread.Sleep(70);
    mouse_event(0x0002, 0, 0, 0, 0); System.Threading.Thread.Sleep(40); mouse_event(0x0004, 0, 0, 0, 0);
  }
  public static string[] List() {
    Aware();
    var o = new List<string>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      var cls = new StringBuilder(256); GetClassName(h, cls, 256);
      if (cls.ToString() == "Chrome_WidgetWin_1") {
        uint p = 0; GetWindowThreadProcessId(h, out p); RECT r; GetWindowRect(h, out r);
        o.Add(h + "|" + p + "|" + r.L + "," + r.T + "," + (r.R - r.L) + "," + (r.B - r.T));
      }
      return true;
    }, IntPtr.Zero);
    return o.ToArray();
  }
  static int[] Who(string path) {
    uint h; string key = Guid.NewGuid().ToString();
    if (RmStartSession(out h, 0, key) != 0) return new int[0];
    try {
      if (RmRegisterResources(h, 1, new string[] { path }, 0, null, 0, null) != 0) return new int[0];
      uint needed = 0, count = 0, reason = 0;
      int r = RmGetList(h, out needed, ref count, null, ref reason);
      if (r == 234 && needed > 0) {
        var arr = new RM_PROCESS_INFO[needed]; count = needed;
        r = RmGetList(h, out needed, ref count, arr, ref reason);
        if (r == 0) {
          var ids = new List<int>();
          for (int i = 0; i < count; i++) {
            int id = arr[i].Process.dwProcessId;
            if (!ids.Contains(id)) ids.Add(id);
          }
          return ids.ToArray();
        }
      }
      return new int[0];
    } finally { RmEndSession(h); }
  }
  /** 按 QQ 号找进程：读 %APPDATA%\\QQ\\Partitions\\qqnt_<QQ号> 下被锁住的 WAL 文件。 */
  public static int[] AccountPids(string qq) {
    var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "QQ", "Partitions", "qqnt_" + qq);
    foreach (var f in new string[] { "DIPS-wal", "SharedStorage-wal" }) {
      var p = Path.Combine(dir, f);
      if (!File.Exists(p)) continue;
      var ids = Who(p);
      if (ids.Length > 0) return ids;
    }
    return new int[0];
  }
  /** 枚举所有账号分区 → 进程：返回 "QQ号|pid1,pid2" 行，供 qq.windows 标注窗口属于哪个账号。 */
  public static string[] AccountMap() {
    var o = new List<string>();
    var root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "QQ", "Partitions");
    if (!Directory.Exists(root)) return o.ToArray();
    foreach (var d in Directory.GetDirectories(root)) {
      var name = Path.GetFileName(d);
      if (!name.StartsWith("qqnt_")) continue;
      var qq = name.Substring(5);
      // qqnt_9210 / qqnt_9211 是 QQ 的内部槽位，不是真实 QQ 号（真实 QQ 号至少 5 位）。
      if (qq.Length < 5) continue;
      var ids = AccountPids(qq);
      if (ids.Length == 0) continue;
      var sb = new StringBuilder();
      for (int i = 0; i < ids.Length; i++) { if (i > 0) sb.Append(','); sb.Append(ids[i]); }
      o.Add(qq + "|" + sb.ToString());
    }
    return o.ToArray();
  }
}
'@
`
  const BASE = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
${PINVOKE}
function Num($v){ try{ $d=[double]$v; if([double]::IsInfinity($d) -or [double]::IsNaN($d)){ return 0 }; return [int]$d } catch { return 0 } }
function Emit($o){ Write-Output ([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($o | ConvertTo-Json -Compress -Depth 6)))) }
function CT($e){ $s=''; try{ $s=[string]$e.Current.ControlType.ProgrammaticName }catch{}; if($s.StartsWith('ControlType.')){ $s=$s.Substring(12) }; return $s }
function NameOf($e){ try{ return [string]$e.Current.Name }catch{ return '' } }
function ClassOf($e){ try{ return [string]$e.Current.ClassName }catch{ return '' } }
function AllEl($root){
  $l=New-Object System.Collections.ArrayList
  [void]$l.Add($root)
  foreach($e in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)){ [void]$l.Add($e) }
  return ,$l
}
function ByName($root,$name){
  $c=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,$name)
  return $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$c)
}
function ByClass($root,$cls){
  $c=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty,$cls)
  return $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$c)
}
function HeaderOf($root){
  foreach($e in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)){
    if((ClassOf $e) -like 'chat-header__contact-name*'){ $n=NameOf $e; if($n){ return $n } }
  }
  return ''
}
function OwnOf($root){
  $c=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Button)
  foreach($b in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants,$c)){
    $n=NameOf $b
    if($n.EndsWith('的头像') -and (ClassOf $b) -like 'avatar*'){ return $n.Substring(0,$n.Length-3) }
  }
  return ''
}
function GetQqWindows(){
  $qqPids=@(Get-Process -Name QQ -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  $acctByPid=@{}
  foreach($m in [QqWin]::AccountMap()){
    $parts=$m.Split('|')
    if($parts.Count -lt 2){ continue }
    foreach($id in ($parts[1].Split(','))){ $acctByPid[[int]$id]=$parts[0] }
  }
  $out=@()
  foreach($line in [QqWin]::List()){
    $p=$line.Split('|')
    if($p.Count -lt 3){ continue }
    $pidNum=[int]$p[1]
    if($qqPids -notcontains $pidNum){ continue }
    $rect=$p[2] -split ','
    $w=[int]$rect[2]; $h=[int]$rect[3]
    if($w -lt 800 -or $h -lt 600){ continue }
    try{
      $root=[System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]([int]$p[0]))
      if(-not (ByName $root '屏幕共享')){ continue }
      $acct=''
      if($acctByPid.ContainsKey($pidNum)){ $acct=[string]$acctByPid[$pidNum] }
      $out += [PSCustomObject]@{ hwnd=[int]$p[0]; pid=$pidNum; acct=$acct; own=(OwnOf $root); header=(HeaderOf $root); x=[int]$rect[0]; y=[int]$rect[1]; w=$w; h=$h }
    }catch{}
  }
  return $out
}
function SelectWin($hwnd,$botName,$ownerName,$botQQ){
  $all=@(GetQqWindows)
  if($hwnd -gt 0){ foreach($w in $all){ if($w.hwnd -eq $hwnd){ return $w } } }
  if($botQQ){
    $pids=@([QqWin]::AccountPids($botQQ))
    if($pids.Count -gt 0){
      foreach($w in $all){ if($pids -contains $w.pid){ return $w } }
    }
  }
  if($botName){ foreach($w in $all){ if($w.own -eq $botName){ return $w } } }
  if($ownerName){ foreach($w in $all){ if($w.header -eq $ownerName){ return $w } } }
  $c=@($all | Where-Object { $_.header -ne '' })
  if($c.Count -eq 1){ return $c[0] }
  return $null
}
function InvokeEl($e){
  if($null -eq $e){ return $false }
  try{ $e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); return $true }catch{}
  try{
    $r=$e.Current.BoundingRectangle
    if($r.Width -le 0 -or $r.Height -le 0){ return $false }
    [QqWin]::Click((Num $r.X)+[int]((Num $r.Width)/2),(Num $r.Y)+[int]((Num $r.Height)/2))
    return $true
  }catch{ return $false }
}
function EnsureChat($w,$ownerName){
  $root=[System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$w.hwnd)
  if(-not $ownerName){ return $true }
  if((HeaderOf $root) -eq $ownerName){ return $true }
  $t=ByName $root $ownerName
  if(-not $t){ return $false }
  $item=$t
  for($i=0;$i -lt 5;$i++){
    $parent=[System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($item)
    if($null -eq $parent){ break }
    $item=$parent
    if((ClassOf $item) -like 'recent-contact-item*'){ break }
  }
  $r=$item.Current.BoundingRectangle
  if($r.Width -le 0 -or $r.Height -le 0){ return $false }
  [QqWin]::Show([IntPtr]$w.hwnd)
  Start-Sleep -Milliseconds 250
  [QqWin]::Click((Num $r.X)+[int]((Num $r.Width)/2),(Num $r.Y)+[int]((Num $r.Height)/2))
  Start-Sleep -Milliseconds 1200
  return ((HeaderOf $root) -eq $ownerName)
}
function FindPicker($pidNum){
  foreach($line in [QqWin]::List()){
    $p=$line.Split('|')
    if([int]$p[1] -ne $pidNum){ continue }
    try{
      $root=[System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]([int]$p[0]))
      if(ByName $root '选择你想共享的窗口'){ return [int]$p[0] }
    }catch{}
  }
  return 0
}
function FindStopBtn($pidNum){
  $names=@('停止共享','停止分享','结束共享','停止屏幕共享')
  foreach($line in [QqWin]::List()){
    $p=$line.Split('|')
    if(([int]$p[1]) -ne $pidNum){ continue }
    try{
      $root=[System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]([int]$p[0]))
      foreach($n in $names){ $b=ByName $root $n; if($b){ return $b } }
    }catch{}
  }
  return $null
}
`

  const NO_WIN = "Emit @{ ok=$false; message='没找到机器人 QQ 窗口：请确认机器人 QQ 号对应的客户端已登录，或用 qq.windows 看当前窗口、在面板填机器人昵称/窗口句柄' }; exit 0"
  const NO_CHAT = "Emit @{ ok=$false; message='机器人 QQ 当前不是主人会话：请先在机器人客户端里打开主人私聊，或让主人先给机器人发一条消息' }; exit 0"

  return {
    'qq.windows': `${PREFIX}$ErrorActionPreference='Stop'
${ARGS}
${BASE}
$all=@(GetQqWindows)
$items=@()
foreach($w in $all){ $items += @{ hwnd=$w.hwnd; pid=$w.pid; acct=$w.acct; own=$w.own; header=$w.header; x=$w.x; y=$w.y; w=$w.w; h=$w.h } }
Emit @{ ok=$true; windows=$items }`,

    'qq.share': `${PREFIX}$ErrorActionPreference='Stop'
${ARGS}
${BASE}
$hwnd=[int](D $a[0]); $bot=D $a[1]; $owner=D $a[2]; $botQQ=D $a[3]; $wait=[int](D $a[4])
$w=SelectWin $hwnd $bot $owner $botQQ
if($null -eq $w){ ${NO_WIN} }
if(-not (EnsureChat $w $owner)){ ${NO_CHAT} }
[QqWin]::Show([IntPtr]$w.hwnd)
Start-Sleep -Milliseconds 250
$root=[System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$w.hwnd)
$btn=ByName $root '屏幕共享'
if(-not $btn){ Emit @{ ok=$false; message='机器人 QQ 窗口里没有「屏幕共享」按钮：当前会话不是好友私聊，或 QQ 版本不支持' }; exit 0 }
if(-not (InvokeEl $btn)){ Emit @{ ok=$false; message='「屏幕共享」按钮点不动（可能被遮挡或控件不支持）' }; exit 0 }
$picker=0
for($i=0;$i -lt ($wait*2);$i++){
  Start-Sleep -Milliseconds 500
  $picker=FindPicker $w.pid
  if($picker -gt 0){ break }
}
if($picker -eq 0){ Emit @{ ok=$false; message='点了「屏幕共享」但 QQ 没有弹出「选择你想共享的窗口」（可能聊天窗口不是前台，或 QQ 共享组件没起来）' }; exit 0 }
[QqWin]::Show([IntPtr]$picker)
Start-Sleep -Milliseconds 400
$proot=[System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$picker)
$desk=ByName $proot '桌面'
if(-not $desk){ Emit @{ ok=$false; message='共享选择框里没有「桌面」选项' }; exit 0 }
InvokeEl $desk | Out-Null
$confirm=$null; $ready=$false
for($i=0;$i -lt 40;$i++){
  Start-Sleep -Milliseconds 500
  $confirm=ByName $proot '确定'
  if($confirm){ try{ if($confirm.Current.IsEnabled){ $ready=$true; break } }catch{} }
}
if(-not $ready){ Emit @{ ok=$false; message='共享选择框一直停在加载状态（「确定」不可点）：这台机器上 QQ 的屏幕共享组件没有列出桌面源，先在 QQ 里手动点一次「屏幕共享」确认能否加载' }; exit 0 }
if(-not (InvokeEl $confirm)){ Emit @{ ok=$false; message='「确定」按钮点不动' }; exit 0 }
Start-Sleep -Milliseconds 1500
$stop=FindStopBtn $w.pid
if($null -eq $stop){ Emit @{ ok=$true; message='已点击「确定」，但没找到「停止共享」按钮，无法确认 QQ 是否真的在共享'; picker=$picker; sharing=$false }; exit 0 }
Emit @{ ok=$true; message='已通过机器人 QQ 客户端发起屏幕共享'; picker=$picker; sharing=$true }`,

    'qq.shareStop': `${PREFIX}$ErrorActionPreference='Stop'
${ARGS}
${BASE}
$hwnd=[int](D $a[0]); $bot=D $a[1]; $owner=D $a[2]; $botQQ=D $a[3]
$w=SelectWin $hwnd $bot $owner $botQQ
if($null -eq $w){ ${NO_WIN} }
$stop=FindStopBtn $w.pid
if($null -eq $stop){ Emit @{ ok=$false; message='没有找到「停止共享」按钮：可能现在没有在共享，或 QQ 的悬浮工具条用了别的文案' }; exit 0 }
if(-not (InvokeEl $stop)){ Emit @{ ok=$false; message='「停止共享」按钮点不动' }; exit 0 }
Emit @{ ok=$true; message='已停止 QQ 屏幕共享' }`,

    'qq.assist': `${PREFIX}$ErrorActionPreference='Stop'
${ARGS}
${BASE}
$hwnd=[int](D $a[0]); $bot=D $a[1]; $owner=D $a[2]; $botQQ=D $a[3]
$w=SelectWin $hwnd $bot $owner $botQQ
if($null -eq $w){ ${NO_WIN} }
if(-not (EnsureChat $w $owner)){ ${NO_CHAT} }
[QqWin]::Show([IntPtr]$w.hwnd)
Start-Sleep -Milliseconds 250
$root=[System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$w.hwnd)
$remote=ByName $root '远程协助'
if(-not $remote){ Emit @{ ok=$false; message='机器人 QQ 窗口里没有「远程协助」按钮：当前会话不是好友私聊，或 QQ 版本不支持' }; exit 0 }
$arrow=ByClass $remote 'arrow'
if(-not $arrow){ Emit @{ ok=$false; message='「远程协助」按钮没有右侧箭头（无法打开菜单）' }; exit 0 }
if(-not (InvokeEl $arrow)){ Emit @{ ok=$false; message='「远程协助」下拉箭头点不动' }; exit 0 }
Start-Sleep -Milliseconds 700
$invite=ByName $root '邀请对方远程协助'
if(-not $invite){
  foreach($line in [QqWin]::List()){
    $p=$line.Split('|')
    if([int]$p[1] -ne $w.pid){ continue }
    try{ $r2=[System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]([int]$p[0])); $invite=ByName $r2 '邀请对方远程协助'; if($invite){ break } }catch{}
  }
}
if(-not $invite){ Emit @{ ok=$false; message='没找到「邀请对方远程协助」菜单项：菜单没弹出来，或文案变了' }; exit 0 }
if(-not (InvokeEl $invite)){ Emit @{ ok=$false; message='「邀请对方远程协助」菜单项点不动' }; exit 0 }
Start-Sleep -Milliseconds 1500
$text=$null
foreach($e in (AllEl $root)){
  $n=NameOf $e
  if($n.StartsWith('你正在邀请')){ $text=$n; break }
}
if(-not $text){ $text='已点击「邀请对方远程协助」，请在 QQ 里确认是否出现邀请提示' }
Emit @{ ok=$true; message=$text; hwnd=$w.hwnd; pid=$w.pid }`,

    'qq.assistStop': `${PREFIX}$ErrorActionPreference='Stop'
${ARGS}
${BASE}
$hwnd=[int](D $a[0]); $bot=D $a[1]; $owner=D $a[2]; $botQQ=D $a[3]
$w=SelectWin $hwnd $bot $owner $botQQ
if($null -eq $w){ ${NO_WIN} }
$names=@('停止协助','取消邀请','结束协助','停止远程协助','断开协助')
$btn=$null
foreach($n in $names){ $btn=ByName ([System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$w.hwnd)) $n; if($btn){ break } }
if($null -eq $btn){
  foreach($line in [QqWin]::List()){
    $p=$line.Split('|')
    if([int]$p[1] -ne $w.pid){ continue }
    try{ $r2=[System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]([int]$p[0])); foreach($n in $names){ $btn=ByName $r2 $n; if($btn){ break } }; if($btn){ break } }catch{}
  }
}
if($null -eq $btn){ Emit @{ ok=$false; message='没有找到停止/取消远程协助的按钮：可能邀请已被接受或已过期，可在 QQ 会话里手动断开' }; exit 0 }
if(-not (InvokeEl $btn)){ Emit @{ ok=$false; message='停止/取消按钮点不动' }; exit 0 }
Emit @{ ok=$true; message='已取消 QQ 远程协助邀请' }`,
  }
}

/**
 * 把脚本输出翻成工具面结果。
 * @param {string} op
 * @param {string} out
 */
export function interpretQq(op, out) {
  const r = decode(out)
  if (!r) return { ok: false, message: `QQ 操作输出解析失败（${op}）：${String(out ?? '').trim().slice(0, 200)}` }
  if (r.ok === false) return { ok: false, message: String(r.message || 'QQ 操作失败') }
  if (op === 'qq.windows') {
    const list = Array.isArray(r.windows) ? r.windows : r.windows ? [r.windows] : []
    if (!list.length) return { ok: true, message: '没有找到机器人 QQ 窗口（QQ 客户端可能没登录，或窗口都被关闭了）', data: [] }
    const lines = list.map((w) => `#${w.hwnd} pid=${w.pid} 账号=${w.acct || '?'} 昵称=${w.own || '?'} 当前会话=${w.header || '(非私聊)'} 位置=${w.x},${w.y} ${w.w}×${w.h}`)
    return { ok: true, message: `找到 ${list.length} 个 QQ 窗口：\n${lines.join('\n')}`, data: list }
  }
  return { ok: true, message: String(r.message || '已完成'), data: r }
}
