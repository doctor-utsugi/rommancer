# Rommancer on Windows: rommancer.sh's commands for Podman for Windows (or Podman Desktop), whose containers run in a
# WSL machine. Data stays in volumes inside it; the installer is deploy/install.sh, run in a container.
#   rommancer.ps1 install [--roms PATH] [--service yes|no] [installer options] | build | up | start | stop | service [on|off]
#                 | setup | down | logs [api|web|mysql] | status
# Run it with: powershell -ExecutionPolicy Bypass -File rommancer\deploy\podman\rommancer.ps1 install
$ErrorActionPreference = 'Continue'
$Src = [IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot, '..', '..'))
# A path inside the release folder
function In-Src { [IO.Path]::Combine([string[]](@($Src) + $args)) }
$ConfDir = [IO.Path]::Combine($HOME, '.config', 'rommancer')
$EnvFile = if ($env:ROMMANCER_ENV) { $env:ROMMANCER_ENV } else { Join-Path $ConfDir 'rommancer.env' }
# Deployment choices made by install (the rom folder), kept for the next up
$Conf = if ($env:ROMMANCER_CONF) { $env:ROMMANCER_CONF } else { Join-Path $ConfDir 'deploy.conf' }
$WebPort = if ($env:ROMMANCER_WEB_PORT) { $env:ROMMANCER_WEB_PORT } else { '8096' }
$Net = 'rommancer'
$Es = (Get-Culture).TwoLetterISOLanguageName -eq 'es'

function Get-ConfValue($file, $name) {
  if (Test-Path $file) {
    foreach ($l in Get-Content $file) { if ($l.StartsWith("$name=")) { return $l.Substring($name.Length + 1) } }
  }
  ''
}
$Roms = if ($env:ROMMANCER_ROMS) { $env:ROMMANCER_ROMS } else { Get-ConfValue $Conf 'ROMMANCER_ROMS' }
if (-not $Roms) { $Roms = Join-Path $HOME 'rommancer-roms' }

function Invoke-Podman {
  & podman @args
  if ($LASTEXITCODE -ne 0) { Write-Error "podman $($args -join ' ') failed"; exit 1 }
}
function Test-Podman { & podman @args *> $null; $LASTEXITCODE -eq 0 }

# Podman's machine: made the first time, started when stopped
function Start-Machine {
  if (-not (Get-Command podman -ErrorAction SilentlyContinue)) {
    Write-Error 'Podman is not installed: winget install RedHat.Podman (or Podman Desktop), then open a new terminal'
    exit 1
  }
  if (Test-Podman info) { return }
  if (-not (Test-Podman machine inspect)) { Invoke-Podman machine init --memory 4096 }
  Invoke-Podman machine start
}

# The folder with your roms, asked by install
function Read-Roms($def) {
  if ($Es) {
    $q = "¿Dónde tienes tus roms?`n`nElige la carpeta donde están (puedes arrastrarla aquí). Si las tienes en varios discos, una que los contenga a todos.`n`nRommancer no moverá, renombrará ni borrará nada de lo que haya dentro. Si aún no tienes roms, deja la que viene propuesta."
  } else {
    $q = "Where are your roms?`n`nPick the folder they're in (you can drag it here). If they're spread across several disks, pick one that holds them all.`n`nRommancer won't move, rename or delete anything inside it. No roms yet? Keep the one suggested."
  }
  Write-Host $q
  $v = Read-Host "[$def]"
  $v = $v.Trim().Trim('"')
  if ($v) { $v } else { $def }
}

function Get-HostTz {
  if ($env:TZ) { return $env:TZ }
  $id = (Get-TimeZone).Id
  if ($id.Contains('/')) { return $id }
  try {
    $iana = $null
    if ([TimeZoneInfo]::TryConvertWindowsIdToIanaId($id, [ref]$iana)) { return $iana }
  } catch {}
  'UTC'
}

function Invoke-Build {
  Start-Machine
  Invoke-Podman build -t rommancer-mysql -f (In-Src deploy mysql Containerfile) $Src
  Invoke-Podman build -t rommancer-api -f (In-Src backend Containerfile) $Src
  Invoke-Podman build -t rommancer-web -f (In-Src frontend Containerfile) $Src
}

function Invoke-Up {
  # A rom folder given now (ROMMANCER_ROMS, or install's question) is the one every later up mounts
  New-Item -ItemType Directory -Force $Roms | Out-Null
  $script:Roms = (Resolve-Path $Roms).Path
  if ($env:ROMMANCER_ROMS) {
    New-Item -ItemType Directory -Force (Split-Path $Conf) | Out-Null
    $kept = if (Test-Path $Conf) { @(Get-Content $Conf | Where-Object { -not $_.StartsWith('ROMMANCER_ROMS=') }) } else { @() }
    Set-Content $Conf ($kept + "ROMMANCER_ROMS=$Roms")
  }
  Start-Machine
  if (-not (Test-Podman network exists $Net)) { Invoke-Podman network create $Net | Out-Null }
  & podman rm -f rommancer-web rommancer-api rommancer-mysql *> $null
  Invoke-Podman run -d --name rommancer-mysql --network $Net --network-alias mysql --restart=on-failure `
    -v rommancer-mysql:/var/lib/mysql -v rommancer-secrets:/secrets localhost/rommancer-mysql:latest | Out-Null
  while (-not (Test-Podman exec rommancer-mysql mysqladmin ping '-h127.0.0.1' --silent)) { Start-Sleep 2 }
  $opt = @()
  if (Test-Path $EnvFile) { $opt += '--env-file', $EnvFile }
  Invoke-Podman run -d --name rommancer-api --network $Net --network-alias api --restart=on-failure @opt `
    --security-opt label=disable -v rommancer-data:/data -v rommancer-secrets:/data/secrets `
    -v "$(In-Src seed):/seed" -v "${Roms}:/roms" -v "$(In-Src clients):/app/clients:ro" `
    -e DATA_DIR=/data -e SEED_DIR=/seed -e ROMMANCER_BUNDLED_DB=mysql:3306 -e "TZ=$(Get-HostTz)" localhost/rommancer-api:latest | Out-Null
  Invoke-Podman run -d --name rommancer-web --network $Net --restart=on-failure -p "127.0.0.1:${WebPort}:80" localhost/rommancer-web:latest | Out-Null
  Write-Host "Web on http://127.0.0.1:$WebPort"
}

$Cmd = "powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`""
# Rommancer as a service: a shortcut in the Startup folder starts it at every login
$StartupCmd = if ($env:OS -eq 'Windows_NT') { Join-Path ([Environment]::GetFolderPath('Startup')) 'rommancer.cmd' } else { '' }

function Set-RommancerService($on) {
  if ($on) {
    Set-Content $StartupCmd "@start `"`" /min powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`" start"
    if ($Es) { Write-Host "Rommancer está instalado como servicio y arrancará cada vez que inicies sesión. Para quitarlo: $Cmd service off" }
    else { Write-Host "Rommancer is installed as a service and starts every time you log in. To remove it: $Cmd service off" }
  } else {
    if ($StartupCmd) { Remove-Item -Force -ErrorAction SilentlyContinue $StartupCmd }
    if ($Es) { Write-Host "Rommancer no está instalado como servicio, así que no arrancará solo después de reiniciar.`n`n  Arrancarlo:  $Cmd start`n  Pararlo:     $Cmd stop`n`nPara instalarlo como servicio más adelante: $Cmd service on" }
    else { Write-Host "Rommancer is not installed as a service, so it won't start by itself after a reboot.`n`n  Start it:  $Cmd start`n  Stop it:   $Cmd stop`n`nTo install it as a service later: $Cmd service on" }
  }
}

# After install: how Rommancer runs and how to handle it, then whether to install it as a service (yes, no or '' to ask)
function Show-Running($want) {
  if ($Es) {
    Write-Host "`nRommancer está funcionando en segundo plano: puedes cerrar esta ventana.`nÁbrelo en http://127.0.0.1:$WebPort`n"
    Write-Host "  $Cmd status        ver si está en marcha`n  $Cmd stop          pararlo`n  $Cmd start         arrancarlo`n  $Cmd logs          ver qué está haciendo`n  $Cmd service on    instalarlo como servicio (off para quitarlo)`n"
  } else {
    Write-Host "`nRommancer is running in the background: you can close this window.`nOpen it at http://127.0.0.1:$WebPort`n"
    Write-Host "  $Cmd status        is it running?`n  $Cmd stop          stop it`n  $Cmd start         start it`n  $Cmd logs          see what it is doing`n  $Cmd service on    install it as a service (off removes it)`n"
  }
  if (-not $StartupCmd) { return }
  if (Test-Path $StartupCmd) {
    if ($Es) { Write-Host "Rommancer ya está instalado como servicio. Para quitarlo: $Cmd service off" }
    else { Write-Host "Rommancer is already installed as a service. To remove it: $Cmd service off" }
    return
  }
  if (-not $want) {
    if ([Console]::IsInputRedirected) { $want = 'no' }
    else {
      if ($Es) { $a = Read-Host "¿Instalar Rommancer como servicio?`n`nAsí arranca solo cada vez que inicias sesión en Windows. Si no, tendrás que arrancarlo tú con «$Cmd start».`n[s/N]" }
      else { $a = Read-Host "Install Rommancer as a service?`n`nThen it starts by itself every time you log in to Windows. Otherwise you start it with `"$Cmd start`".`n[y/N]" }
      $want = if ($a -match '^[sSyY]') { 'yes' } else { 'no' }
    }
  }
  Set-RommancerService ($want -eq 'yes')
}

# deploy/install.sh in a container on the machine's own network, where the web answers at the address it shows you
function Invoke-Setup($opts) {
  $tty = if ([Console]::IsInputRedirected) { '-i' } else { '-it' }
  $lang = if ($Es) { 'es_ES.UTF-8' } else { 'en_US.UTF-8' }
  & podman run --rm $tty --network host -e "LANG=$lang" -e ROMMANCER_DB_PASSWORD -e ROMMANCER_ADMIN_PASSWORD `
    -v "$(In-Src deploy install.sh):/install.sh:ro" --entrypoint sh localhost/rommancer-web:latest `
    /install.sh "http://127.0.0.1:$WebPort" @opts
  $script:SetupCode = $LASTEXITCODE
}

$rest = @($args | Select-Object -Skip 1)
switch ($args[0]) {
  'build' { Invoke-Build }
  'up' { Invoke-Up }
  'start' { Start-Machine; Invoke-Podman start rommancer-mysql rommancer-api rommancer-web }
  'stop' { & podman stop rommancer-web rommancer-api rommancer-mysql }
  'service' {
    if (-not $StartupCmd) { Write-Error 'rommancer.ps1 service is for Windows; elsewhere use rommancer.sh service'; exit 2 }
    $v = if ($rest.Count) { $rest[0] } else { 'on' }
    if ($v -ne 'on' -and $v -ne 'off') { Write-Host 'Usage: rommancer.ps1 service on|off'; exit 2 }
    Set-RommancerService ($v -eq 'on')
  }
  'setup' { Invoke-Setup $rest; exit $SetupCode }
  'install' {
    # --roms is this script's; everything else goes to the installer
    $chosen = '' ; $svc = '' ; $opts = @()
    for ($i = 0; $i -lt $rest.Count; $i++) {
      $a = [string]$rest[$i]
      if ($a -eq '--roms') { $i++; $chosen = [string]$rest[$i] }
      elseif ($a.StartsWith('--roms=')) { $chosen = $a.Substring(7) }
      elseif ($a -eq '--service') { $i++; $svc = [string]$rest[$i] }
      elseif ($a.StartsWith('--service=')) { $svc = $a.Substring(10) }
      elseif ($a -eq '-h' -or $a -eq '--help') {
        Write-Host "Usage: rommancer.ps1 install [--roms PATH] [--service yes|no] [installer options]: builds, starts and installs Rommancer"
        Write-Host "  --service yes|no   install it as a service, started at every login (asked when not given); the installer's options:"
        # install.sh's own --help text
        $sh = [IO.File]::ReadAllText((In-Src deploy install.sh))
        Write-Host ([regex]::Match($sh, "(?s)cat <<'EOF'\n(.*?)\nEOF").Groups[1].Value)
        exit 0
      }
      else { $opts += $a }
    }
    if (-not $chosen -and -not [Console]::IsInputRedirected) { $chosen = Read-Roms $Roms }
    if ($chosen) { $Roms = $chosen }
    $env:ROMMANCER_ROMS = $Roms
    Invoke-Build
    Invoke-Up
    Invoke-Setup $opts
    if ($SetupCode -ne 0) { exit $SetupCode }
    Show-Running $svc
  }
  'down' { Start-Machine; & podman rm -f rommancer-web rommancer-api rommancer-mysql }
  'logs' { $c = if ($rest.Count) { $rest[0] } else { 'api' }; & podman logs --tail 100 -f "rommancer-$c" }
  'status' { & podman ps -a --filter name=rommancer --format '{{.Names}}\t{{.Status}}' }
  default { Write-Host 'Usage: rommancer.ps1 install|build|up|start|stop|service [on|off]|setup|down|logs [api|web|mysql]|status'; exit 2 }
}
