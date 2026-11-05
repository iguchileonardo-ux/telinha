@echo off
rem Publica a versao web da Telinha, para assistir pelo celular (navegador do Android e do iPhone).
rem Ela fica no mesmo endereco do servidor da Telinha, no Cloudflare (gratis).
rem Publicar reinicia o servidor: quem estiver na Telinha reconecta sozinho em alguns segundos.
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  if not exist ".node\node.exe" powershell -NoProfile -ExecutionPolicy Bypass -File "ferramentas\baixar-node.ps1" || goto erro
  set "PATH=%~dp0.node;%PATH%"
)

echo.
echo  === 1/3  Montando a versao web ===
if not exist "node_modules\esbuild" call npm install --no-audit --no-fund >nul 2>&1
call node ferramentas\montar-web.mjs || goto erro

echo.
echo  === 2/3  Preparando o servidor ===
pushd servidor-cloudflare
call npm install --no-audit --no-fund >nul 2>&1 || goto erro_pop
call npx wrangler whoami >nul 2>&1
if errorlevel 1 (
  rem Chamado pelo "Publicar atualizacao.bat": sem login, nao fica esperando o navegador.
  if /i "%~1"=="/semPausa" goto erro_pop
  call npx wrangler login || goto erro_pop
)

echo.
echo  === 3/3  Publicando ===
call npx wrangler deploy || goto erro_pop
popd

for /f "delims=" %%u in ('node -p "require('./package.json').telinha.server"') do set "SITE=%%u"
echo.
echo  Versao web publicada: %SITE%
echo  Para convidar alguem pelo celular: no app, clique no nome da turma e em "Copiar link para celular".
if /i "%~1"=="/semPausa" exit /b 0
start "" "%SITE%"
pause
exit /b 0

:erro_pop
popd
:erro
echo.
echo  Algo deu errado. A mensagem acima mostra o motivo.
if /i not "%~1"=="/semPausa" pause
exit /b 1
