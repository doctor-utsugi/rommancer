# Rommancer on Windows: rommancer.sh's commands for Podman for Windows (or Podman Desktop), whose containers run in a
# WSL machine. Data stays in volumes inside it; the installer is deploy/install.sh, run in a container.
#   rommancer.ps1 install [--roms PATH] [installer options] | build | up | start | setup | down | logs [api|web|mysql] | status
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
  Invoke-Podman run -d --name rommancer-mysql --network $Net --network-alias mysql --restart=always `
    -v rommancer-mysql:/var/lib/mysql -v rommancer-secrets:/secrets localhost/rommancer-mysql:latest | Out-Null
  while (-not (Test-Podman exec rommancer-mysql mysqladmin ping '-h127.0.0.1' --silent)) { Start-Sleep 2 }
  $opt = @()
  if (Test-Path $EnvFile) { $opt += '--env-file', $EnvFile }
  Invoke-Podman run -d --name rommancer-api --network $Net --network-alias api --restart=always @opt `
    --security-opt label=disable -v rommancer-data:/data -v rommancer-secrets:/data/secrets `
    -v "$(In-Src seed):/seed" -v "${Roms}:/roms" -v "$(In-Src clients):/app/clients:ro" `
    -e DATA_DIR=/data -e SEED_DIR=/seed -e ROMMANCER_BUNDLED_DB=mysql:3306 -e "TZ=$(Get-HostTz)" localhost/rommancer-api:latest | Out-Null
  Invoke-Podman run -d --name rommancer-web --network $Net --restart=always -p "127.0.0.1:${WebPort}:80" localhost/rommancer-web:latest | Out-Null
  if ($env:OS -eq 'Windows_NT') {
    # At login: the machine, then the containers (start)
    $cmd = Join-Path ([Environment]::GetFolderPath('Startup')) 'rommancer.cmd'
    Set-Content $cmd "@start `"`" /min powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`" start"
  }
  Write-Host "Web on http://127.0.0.1:$WebPort"
}

# After install: how Rommancer runs and how to handle it
function Show-Running {
  $cmd = "powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`""
  if ($Es) {
    Write-Host "`nRommancer se queda funcionando en segundo plano: puedes cerrar esta ventana.`nÁbrelo en http://127.0.0.1:$WebPort`n"
    Write-Host "  $cmd status   ver si está en marcha`n  $cmd down     pararlo`n  $cmd up       volver a arrancarlo`n  $cmd logs     ver qué está haciendo`n"
    Write-Host 'Arrancará solo cada vez que inicies sesión en Windows.'
  } else {
    Write-Host "`nRommancer keeps running in the background: you can close this window.`nOpen it at http://127.0.0.1:$WebPort`n"
    Write-Host "  $cmd status   is it running?`n  $cmd down     stop it`n  $cmd up       start it again`n  $cmd logs     see what it is doing`n"
    Write-Host 'It will start by itself every time you log in to Windows.'
  }
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
  'setup' { Invoke-Setup $rest; exit $SetupCode }
  'install' {
    # --roms is this script's; everything else goes to the installer
    $chosen = '' ; $opts = @()
    for ($i = 0; $i -lt $rest.Count; $i++) {
      $a = [string]$rest[$i]
      if ($a -eq '--roms') { $i++; $chosen = [string]$rest[$i] }
      elseif ($a.StartsWith('--roms=')) { $chosen = $a.Substring(7) }
      elseif ($a -eq '-h' -or $a -eq '--help') {
        Write-Host "Usage: rommancer.ps1 install [--roms PATH] [installer options]: builds, starts and installs Rommancer; the installer's options:"
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
    Show-Running
  }
  'down' { Start-Machine; & podman rm -f rommancer-web rommancer-api rommancer-mysql }
  'logs' { $c = if ($rest.Count) { $rest[0] } else { 'api' }; & podman logs --tail 100 -f "rommancer-$c" }
  'status' { & podman ps -a --filter name=rommancer --format '{{.Names}}\t{{.Status}}' }
  default { Write-Host 'Usage: rommancer.ps1 install|build|up|start|setup|down|logs [api|web|mysql]|status'; exit 2 }
}
