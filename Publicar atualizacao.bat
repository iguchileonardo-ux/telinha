@echo off
rem Publica a versao atual da Telinha no GitHub. Quem tem a Telinha instalada
rem recebe a atualizacao sozinho. Antes, aumente "version" no package.json.
setlocal
cd /d "%~dp0"
set "PATH=%ProgramFiles%\Git\cmd;%ProgramFiles%\GitHub CLI;%LOCALAPPDATA%\Programs\GitHub CLI;%PATH%"
set "LOG=%~dp0publicar-log.txt"

where gh >nul 2>nul || goto sem_github
gh auth status >nul 2>nul || goto sem_github

where node >nul 2>nul
if errorlevel 1 (
  if not exist ".node\node.exe" powershell -NoProfile -ExecutionPolicy Bypass -File "ferramentas\baixar-node.ps1" || goto erro
  set "PATH=%~dp0.node;%PATH%"
)

rem O token fica so nesta janela, nao e salvo em arquivo.
for /f "delims=" %%t in ('gh auth token') do set "GH_TOKEN=%%t"
if not defined GH_TOKEN goto sem_github

for /f "delims=" %%v in ('node -p "require('./package.json').version"') do set "VERSAO=%%v"
echo.
echo  Publicando a versao %VERSAO%. Isso leva alguns minutos.
echo [%date% %time%] Publicando %VERSAO% > "%LOG%"

rem Codigo no GitHub e marca da versao (a Release precisa dela).
echo [git] >> "%LOG%"
git add -A >> "%LOG%" 2>&1
git commit -q -m "Versao %VERSAO%" >> "%LOG%" 2>&1
git rev-parse --verify HEAD >nul 2>&1 || goto erro
git branch -M main >> "%LOG%" 2>&1
git push -u origin main >> "%LOG%" 2>&1 || goto erro
git tag -f "v%VERSAO%" >> "%LOG%" 2>&1
git push -f origin "v%VERSAO%" >> "%LOG%" 2>&1 || goto erro

echo [build] >> "%LOG%"
call npm install --no-audit --no-fund >> "%LOG%" 2>&1 || goto erro
if not exist "node_modules\electron\dist\electron.exe" call node "node_modules\electron\install.js" >> "%LOG%" 2>&1
call npm run publicar >> "%LOG%" 2>&1 || goto erro
set "GH_TOKEN="

call "%~dp0ferramentas\separar-instalador.bat" >nul 2>&1
echo  Versao %VERSAO% publicada.
echo [%date% %time%] Publicado >> "%LOG%"
start "" "%~dp0release\Telinha-Instalador.exe"
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
echo  Algo deu errado. Os detalhes estao em publicar-log.txt
if /i not "%~1"=="/semPausa" pause
exit /b 1
