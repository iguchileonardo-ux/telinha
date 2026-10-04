# Baixa o Node.js LTS portátil (oficial, nodejs.org) para a pasta .node do projeto.
# Não instala nada no sistema. Confere o SHA-256 antes de extrair.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$root = Split-Path -Parent $PSScriptRoot
$target = Join-Path $root '.node'
if (Test-Path (Join-Path $target 'node.exe')) { Write-Output 'Node portátil já existe.'; exit 0 }

$index = Invoke-RestMethod 'https://nodejs.org/dist/index.json'
$release = $index | Where-Object { $_.lts -and ($_.files -contains 'win-x64-zip') } | Select-Object -First 1
if (-not $release) { throw 'Não encontrei uma versão LTS para Windows x64.' }

$version = $release.version
$name = "node-$version-win-x64"
$base = "https://nodejs.org/dist/$version"
$zip = Join-Path $env:TEMP "$name.zip"
Write-Output "Baixando $name.zip"
Invoke-WebRequest "$base/$name.zip" -OutFile $zip

$sums = (Invoke-WebRequest "$base/SHASUMS256.txt" -UseBasicParsing).Content
$line = ($sums -split "`n") | Where-Object { $_ -match "\s$([regex]::Escape("$name.zip"))\s*$" } | Select-Object -First 1
$expected = ($line -split '\s+')[0].ToLower()
$actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
if ($expected -ne $actual) { throw "SHA-256 não confere ($actual)." }
Write-Output 'SHA-256 conferido.'

$tmp = Join-Path $env:TEMP "telinha-node-$([guid]::NewGuid())"
Expand-Archive $zip -DestinationPath $tmp -Force
Move-Item (Join-Path $tmp $name) $target
Remove-Item $zip -Force
Remove-Item $tmp -Recurse -Force
Write-Output "Node $version pronto em .node"
