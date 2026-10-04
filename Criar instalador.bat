@echo off
rem Cria o instalador da Telinha e o executa. Depois disso, use o atalho "Telinha" na area de trabalho.
setlocal
cd /d "%~dp0"
set "LOG=%~dp0instalador-log.txt"
echo [%date% %time%] Inicio > "%LOG%"
echo.
echo  Preparando a Telinha. Isso leva alguns minutos so na primeira vez.
echo.

where node >nul 2>nul
if errorlevel 1 (
  if not exist ".node\node.exe" (
    echo  Baixando o Node.js...
    powershell -NoProfile -ExecutionPolicy Bypass -File "ferramentas\baixar-node.ps1" >> "%LOG%" 2>&1
    if errorlevel 1 goto erro
  )
  set "PATH=%~dp0.node;%PATH%"
)

echo  Conferindo dependencias...
call npm install --no-audit --no-fund >> "%LOG%" 2>&1
if errorlevel 1 goto erro
if not exist "node_modules\electron\dist\electron.exe" (
  call node "node_modules\electron\install.js" >> "%LOG%" 2>&1
)

echo  Criando o instalador...
call npm run dist >> "%LOG%" 2>&1
if errorlevel 1 goto erro
if not exist "release\Telinha-Instalador.exe" goto erro

call "%~dp0ferramentas\separar-instalador.bat" >nul 2>&1
echo  Instalando...
echo [%date% %time%] Instalador criado >> "%LOG%"
start "" "%~dp0release\Telinha-Instalador.exe"
exit /b 0

:erro
echo.
echo  Algo deu errado. Os detalhes estao em instalador-log.txt
echo [%date% %time%] ERRO >> "%LOG%"
pause
exit /b 1
