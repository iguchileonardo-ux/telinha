@echo off
rem Conserta releases repetidas no GitHub (a atualizacao automatica nao chega
rem quando a mesma versao fica com duas Releases). Pode rodar quantas vezes quiser.
setlocal
cd /d "%~dp0"
set "PATH=%ProgramFiles%\Git\cmd;%ProgramFiles%\GitHub CLI;%LOCALAPPDATA%\Programs\GitHub CLI;%PATH%"
set "LOG=%~dp0corrigir-log.txt"

where gh >nul 2>nul || goto sem_github
gh auth status >nul 2>nul || goto sem_github

where node >nul 2>nul
if errorlevel 1 (
  if not exist ".node\node.exe" powershell -NoProfile -ExecutionPolicy Bypass -File "ferramentas\baixar-node.ps1" || goto erro
  set "PATH=%~dp0.node;%PATH%"
)

for /f "delims=" %%t in ('gh auth token') do set "GH_TOKEN=%%t"
if not defined GH_TOKEN goto sem_github

echo.
echo  Conferindo as Releases no GitHub...
echo [%date% %time%] Corrigindo releases > "%LOG%"
node ferramentas\corrigir-release.mjs >> "%LOG%" 2>&1
set "GH_TOKEN="
type "%LOG%"
echo.
if /i not "%~1"=="/semPausa" pause
exit /b 0

:sem_github
echo.
echo  O GitHub ainda nao esta configurado. Rode "Configurar GitHub.bat" primeiro.
if /i not "%~1"=="/semPausa" pause
exit /b 1

:erro
set "GH_TOKEN="
echo.
echo  Algo deu errado ao preparar o Node. Veja corrigir-log.txt
if /i not "%~1"=="/semPausa" pause
exit /b 1
