# Rommancer on Windows: rommancer.sh's commands for Podman (the default) or Docker Desktop, whose containers run in a
# WSL machine. Data stays in volumes inside it; the installer is deploy/install.sh, run in a container.
#   rommancer.ps1 install [--roms PATH] [--engine podman|docker] [--service yes|no] [installer options] | build | up | start | stop | service [on|off]
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
$Engine = if ($env:ROMMANCER_ENGINE) { $env:ROMMANCER_ENGINE } else { Get-ConfValue $Conf 'ROMMANCER_ENGINE' }
if (-not $Engine) { $Engine = 'podman' }

function Set-ConfValue($name, $value) {
  New-Item -ItemType Directory -Force (Split-Path $Conf) | Out-Null
  $kept = if (Test-Path $Conf) { @(Get-Content $Conf | Where-Object { -not $_.StartsWith("$name=") }) } else { @() }
  Set-Content $Conf ($kept + "$name=$value")
}

function Invoke-Engine {
  & $Engine @args
  if ($LASTEXITCODE -ne 0) { Write-Error "$Engine $($args -join ' ') failed"; exit 1 }
}
function Test-Engine { & $Engine @args *> $null; $LASTEXITCODE -eq 0 }
$Has = @{ podman = [bool](Get-Command podman -ErrorAction SilentlyContinue); docker = [bool](Get-Command docker -ErrorAction SilentlyContinue) }

# install's choice of engine: the one given, the only one there is, or the person's pick (Podman first)
function Select-Engine($given) {
  if ($given) {
    if ($given -ne 'podman' -and $given -ne 'docker') { Write-Host '--engine: podman or docker'; exit 2 }
    return $given
  }
  if (-not $Has.podman -and -not $Has.docker) {
    if ($Es) { Write-Host "Rommancer necesita Podman (recomendado) o Docker, y no encuentro ninguno de los dos.`n`n  Podman:  winget install RedHat.Podman, o Podman Desktop (https://podman-desktop.io)`n  Docker:  Docker Desktop (https://docs.docker.com/get-docker/)`n`nInstala uno, abre una ventana nueva de PowerShell y vuelve a lanzar la instalación." }
    else { Write-Host "Rommancer needs Podman (recommended) or Docker, and neither is installed.`n`n  Podman:  winget install RedHat.Podman, or Podman Desktop (https://podman-desktop.io)`n  Docker:  Docker Desktop (https://docs.docker.com/get-docker/)`n`nInstall one, open a new PowerShell window and run the installation again." }
    exit 1
  }
  if ($Has.podman -and $Has.docker -and -not [Console]::IsInputRedirected) {
    if ($Es) { $a = Read-Host "¿Con qué quieres ejecutar los contenedores?`n`nTienes Podman y Docker. Podman funciona con tu usuario, sin un servicio con permisos de administrador; Docker usa su propio servicio.`n`n 1) Podman (recomendado)`n 2) Docker`n[1]" }
    else { $a = Read-Host "Which one should run the containers?`n`nYou have Podman and Docker. Podman runs as your user, with no service running as administrator; Docker uses its own service.`n`n 1) Podman (recommended)`n 2) Docker`n[1]" }
    if ($a -match '^(2|docker)$') { return 'docker' } else { return 'podman' }
  }
  if ($Has.podman) { 'podman' } else { 'docker' }
}

# Podman's machine: made the first time, started when stopped. Docker Desktop starts on its own: wait for it
function Start-Machine {
  if (-not $Has[$Engine]) { Write-Error "$Engine is not installed"; exit 1 }
  if (Test-Engine info) { return }
  if ($Engine -eq 'docker') {
    for ($i = 0; $i -lt 60 -and -not (Test-Engine info); $i++) { Start-Sleep 2 }
    if (Test-Engine info) { return }
    if ($Es) { Write-Error 'Docker no responde: abre Docker Desktop y vuelve a intentarlo.' } else { Write-Error 'Docker does not answer: open Docker Desktop and try again.' }
    exit 1
  }
  if (-not (Test-Engine machine inspect)) { Invoke-Engine machine init --memory 4096 }
  Invoke-Engine machine start
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
  Invoke-Engine build -t rommancer-mysql -f (In-Src deploy mysql Containerfile) $Src
  Invoke-Engine build -t rommancer-api -f (In-Src backend Containerfile) $Src
  Invoke-Engine build -t rommancer-web -f (In-Src frontend Containerfile) $Src
}

function Invoke-Up {
  # A rom folder given now (ROMMANCER_ROMS, or install's question) is the one every later up mounts
  New-Item -ItemType Directory -Force $Roms | Out-Null
  $script:Roms = (Resolve-Path $Roms).Path
  if ($env:ROMMANCER_ROMS) { Set-ConfValue 'ROMMANCER_ROMS' $Roms }
  if ($env:ROMMANCER_ENGINE) { Set-ConfValue 'ROMMANCER_ENGINE' $Engine }
  Start-Machine
  if (-not (Test-Engine network inspect $Net)) { Invoke-Engine network create $Net | Out-Null }
  & $Engine rm -f rommancer-web rommancer-api rommancer-mysql *> $null
  Invoke-Engine run -d --name rommancer-mysql --network $Net --network-alias mysql --restart=on-failure `
    -v rommancer-mysql:/var/lib/mysql -v rommancer-secrets:/secrets rommancer-mysql:latest | Out-Null
  while (-not (Test-Engine exec rommancer-mysql mysqladmin ping '-h127.0.0.1' --silent)) { Start-Sleep 2 }
  $opt = @()
  if (Test-Path $EnvFile) { $opt += '--env-file', $EnvFile }
  Invoke-Engine run -d --name rommancer-api --network $Net --network-alias api --restart=on-failure @opt `
    --security-opt label=disable -v rommancer-data:/data -v rommancer-secrets:/data/secrets `
    -v "$(In-Src seed):/seed" -v "${Roms}:/roms" -v "$(In-Src clients):/app/clients:ro" `
    -e DATA_DIR=/data -e SEED_DIR=/seed -e ROMMANCER_BUNDLED_DB=mysql:3306 -e "TZ=$(Get-HostTz)" rommancer-api:latest | Out-Null
  Invoke-Engine run -d --name rommancer-web --network $Net --restart=on-failure -p "127.0.0.1:${WebPort}:80" rommancer-web:latest | Out-Null
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

# deploy/install.sh in a container on Rommancer's network; it shows you the address on this computer
function Invoke-Setup($opts) {
  $tty = if ([Console]::IsInputRedirected) { '-i' } else { '-it' }
  $lang = if ($Es) { 'es_ES.UTF-8' } else { 'en_US.UTF-8' }
  & $Engine run --rm $tty --network $Net -e "LANG=$lang" -e "ROMMANCER_SHOW_URL=http://127.0.0.1:$WebPort" -e ROMMANCER_DB_PASSWORD -e ROMMANCER_ADMIN_PASSWORD `
    -v "$(In-Src deploy install.sh):/install.sh:ro" --entrypoint sh rommancer-web:latest `
    /install.sh http://rommancer-web @opts
  $script:SetupCode = $LASTEXITCODE
}

$rest = @($args | Select-Object -Skip 1)
switch ($args[0]) {
  'build' { Invoke-Build }
  'up' { Invoke-Up }
  'start' { Start-Machine; Invoke-Engine start rommancer-mysql rommancer-api rommancer-web }
  'stop' { & $Engine stop rommancer-web rommancer-api rommancer-mysql }
  'service' {
    if (-not $StartupCmd) { Write-Error 'rommancer.ps1 service is for Windows; elsewhere use rommancer.sh service'; exit 2 }
    $v = if ($rest.Count) { $rest[0] } else { 'on' }
    if ($v -ne 'on' -and $v -ne 'off') { Write-Host 'Usage: rommancer.ps1 service on|off'; exit 2 }
    Set-RommancerService ($v -eq 'on')
  }
  'setup' { Invoke-Setup $rest; exit $SetupCode }
  'install' {
    # --roms is this script's; everything else goes to the installer
    $chosen = '' ; $svc = '' ; $eng = '' ; $opts = @()
    for ($i = 0; $i -lt $rest.Count; $i++) {
      $a = [string]$rest[$i]
      if ($a -eq '--roms') { $i++; $chosen = [string]$rest[$i] }
      elseif ($a.StartsWith('--roms=')) { $chosen = $a.Substring(7) }
      elseif ($a -eq '--engine') { $i++; $eng = [string]$rest[$i] }
      elseif ($a.StartsWith('--engine=')) { $eng = $a.Substring(9) }
      elseif ($a -eq '--service') { $i++; $svc = [string]$rest[$i] }
      elseif ($a.StartsWith('--service=')) { $svc = $a.Substring(10) }
      elseif ($a -eq '-h' -or $a -eq '--help') {
        Write-Host "Usage: rommancer.ps1 install [--roms PATH] [--engine podman|docker] [--service yes|no] [installer options]: builds, starts and installs Rommancer"
        Write-Host "  --engine podman|docker   what runs the containers (Podman when both are there and it is not given)"
        Write-Host "  --service yes|no   install it as a service, started at every login (asked when not given); the installer's options:"
        # install.sh's own --help text
        $sh = [IO.File]::ReadAllText((In-Src deploy install.sh))
        Write-Host ([regex]::Match($sh, "(?s)cat <<'EOF'\n(.*?)\nEOF").Groups[1].Value)
        exit 0
      }
      else { $opts += $a }
    }
    $script:Engine = Select-Engine $eng
    $env:ROMMANCER_ENGINE = $Engine
    if (-not $chosen -and -not [Console]::IsInputRedirected) { $chosen = Read-Roms $Roms }
    if ($chosen) { $Roms = $chosen }
    $env:ROMMANCER_ROMS = $Roms
    Invoke-Build
    Invoke-Up
    Invoke-Setup $opts
    if ($SetupCode -ne 0) { exit $SetupCode }
    Show-Running $svc
  }
  'down' { Start-Machine; & $Engine rm -f rommancer-web rommancer-api rommancer-mysql }
  'logs' { $c = if ($rest.Count) { $rest[0] } else { 'api' }; & $Engine logs --tail 100 -f "rommancer-$c" }
  'status' { & $Engine ps -a --filter name=rommancer --format '{{.Names}}\t{{.Status}}' }
  default { Write-Host 'Usage: rommancer.ps1 install|build|up|start|stop|service [on|off]|setup|down|logs [api|web|mysql]|status'; exit 2 }
}
