@echo off
rem Coloca o servidor da Telinha no ar, no Cloudflare (gratis), e aponta o app para ele.
rem O servidor ajuda os PCs a se encontrarem e libera o TURN para redes que bloqueiam
rem conexao direta. Voz e video continuam indo direto entre os PCs sempre que possivel.
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  if not exist ".node\node.exe" powershell -NoProfile -ExecutionPolicy Bypass -File "ferramentas\baixar-node.ps1" || goto erro
  set "PATH=%~dp0.node;%PATH%"
)

echo.
echo  === 1/4  Preparando ===
pushd servidor-cloudflare
call npm install --no-audit --no-fund >nul 2>&1 || goto erro_pop

echo.
echo  === 2/4  Login no Cloudflare ===
echo  O navegador vai abrir. Entre na sua conta do Cloudflare, ou crie uma de graca,
echo  e clique em "Allow".
call npx wrangler whoami >nul 2>&1
if errorlevel 1 call npx wrangler login || goto erro_pop

echo.
echo  === 3/4  Publicando o servidor ===
rem Primeira vez: o Cloudflare pode pedir para escolher um subdominio workers.dev.
call npx wrangler deploy || goto erro_pop
call npx wrangler deploy > "%~dp0servidor-log.txt" 2>&1 || goto erro_pop
popd
for /f "delims=" %%u in ('node ferramentas\configurar-servidor.mjs servidor-log.txt') do set "SERVIDOR=%%u"
if not defined SERVIDOR goto erro
echo  Servidor no ar: %SERVIDOR%

echo.
echo  === 4/4  TURN (para redes que bloqueiam conexao direta) ===
echo  No painel do Cloudflare que vai abrir:
echo    Realtime  ^>  TURN Server  ^>  Create
echo  Copie o "Turn Token ID" e o "API Token" que aparecem.
echo.
choice /c SN /m " Configurar o TURN agora"
if errorlevel 2 goto fim
start "" "https://dash.cloudflare.com/?to=/:account/realtime/turn"
pushd servidor-cloudflare
echo.
echo  Cole o Turn Token ID e aperte Enter:
call npx wrangler secret put TURN_KEY_ID || goto erro_pop
echo.
echo  Cole o API Token e aperte Enter:
call npx wrangler secret put TURN_KEY_API_TOKEN || goto erro_pop
popd

:fim
echo.
echo  Pronto. Agora rode "Publicar atualizacao.bat" para a nova versao usar o servidor.
pause
exit /b 0

:erro_pop
popd
:erro
echo.
echo  Algo deu errado. A mensagem acima mostra o motivo.
pause
exit /b 1
