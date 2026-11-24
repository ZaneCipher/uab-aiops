#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ServerIp,
    [string]$HostName = $env:COMPUTERNAME,
    [string]$Lab = "LAB 1",
    [Parameter(Mandatory = $true)][string]$CertsDir,
    [string]$AgentExe = (Join-Path $PSScriptRoot "uab_agent.exe"),
    [string]$InstallDir = (Join-Path $env:ProgramFiles "UAB-AIOps"),
    [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$TaskName = "UAB-AIOps Agent"

if ($Uninstall) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Servicio '$TaskName' eliminado. Los archivos en $InstallDir se conservan." -ForegroundColor Yellow
    return
}

if (-not (Test-Path $AgentExe)) { throw "No se encontro el ejecutable: $AgentExe" }
foreach ($f in @("ca.crt", "agent.crt", "agent.key")) {
    if (-not (Test-Path (Join-Path $CertsDir $f))) { throw "Falta $f en $CertsDir" }
}

New-Item -ItemType Directory -Force -Path $InstallDir, (Join-Path $InstallDir "certs") | Out-Null
Copy-Item $AgentExe (Join-Path $InstallDir "uab_agent.exe") -Force
Copy-Item (Join-Path $CertsDir "*") (Join-Path $InstallDir "certs") -Force

[Environment]::SetEnvironmentVariable("UAB_SERVER", $ServerIp, "Machine")
[Environment]::SetEnvironmentVariable("UAB_HOST", $HostName, "Machine")
[Environment]::SetEnvironmentVariable("UAB_LAB", $Lab, "Machine")
[Environment]::SetEnvironmentVariable("UAB_CERTS", (Join-Path $InstallDir "certs"), "Machine")

$log = Join-Path $InstallDir "agent.log"
$inner = "& '$InstallDir\uab_agent.exe' *>> '$log'"
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -WindowStyle Hidden -Command `"$inner`"" `
    -WorkingDirectory $InstallDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

Write-Host "Agente UAB-AIOps instalado como SYSTEM (firewall habilitado)." -ForegroundColor Green
Write-Host "  Servidor : $ServerIp"
Write-Host "  Hostname : $HostName (debe coincidir con el CN del certificado)"
Write-Host "  Lab      : $Lab"
Write-Host "  Log      : $log"
