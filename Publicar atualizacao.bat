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

rem Uma versao ja publicada nao e substituida: o electron-builder pula o envio sem dar erro.
gh release view "v%VERSAO%" --json assets -q ".assets[].name" 2>nul | findstr /i "latest.yml" >nul
if not errorlevel 1 goto ja_publicada

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
rem Cria a Release antes do envio. Sem isso o electron-builder pode criar duas
rem Releases para a mesma versao e a atualizacao automatica deixa de funcionar.
echo [release] >> "%LOG%"
gh release view "v%VERSAO%" >nul 2>&1 || gh release create "v%VERSAO%" --title "%VERSAO%" --notes "Versao %VERSAO%." >> "%LOG%" 2>&1
call npm run publicar >> "%LOG%" 2>&1 || goto erro

rem Confere se ficou uma Release so e se o latest.yml esta acessivel.
echo [conferencia] >> "%LOG%"
node ferramentas\corrigir-release.mjs >> "%LOG%" 2>&1
set "GH_TOKEN="

call "%~dp0ferramentas\separar-instalador.bat" >nul 2>&1
rem Versao web (celular) com o mesmo codigo do app. Se falhar, o app continua publicado.
echo [web] >> "%LOG%"
call "%~dp0Publicar versao web.bat" /semPausa >> "%LOG%" 2>&1 || echo  A versao web nao foi publicada. Rode "Publicar versao web.bat".
echo  Versao %VERSAO% publicada.
echo [%date% %time%] Publicado >> "%LOG%"
start "" "%~dp0release\Telinha-Instalador.exe"
if /i not "%~1"=="/semPausa" pause
exit /b 0

:ja_publicada
set "GH_TOKEN="
echo.
echo  A versao %VERSAO% ja foi publicada antes, entao nada foi enviado.
echo  Aumente "version" no package.json (por exemplo, o ultimo numero) e rode de novo.
echo [%date% %time%] Versao %VERSAO% ja publicada; nada enviado >> "%LOG%"
if /i not "%~1"=="/semPausa" pause
exit /b 1

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
