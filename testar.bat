@echo off
rem Prepara e abre duas instancias da Telinha para teste no mesmo PC.
rem Usa o Node do sistema ou baixa uma versao portatil para a pasta .node
setlocal
cd /d "%~dp0"
set "LOG=%~dp0teste-log.txt"
set "LOG2=%~dp0teste-log-2.txt"
echo [%date% %time%] Inicio > "%LOG%"

where node >nul 2>nul
if errorlevel 1 (
  if not exist ".node\node.exe" (
    echo Baixando Node.js portatil...
    powershell -NoProfile -ExecutionPolicy Bypass -File "ferramentas\baixar-node.ps1" >> "%LOG%" 2>&1
    if errorlevel 1 (
      echo Falha ao baixar o Node.js. Veja teste-log.txt
      echo [%date% %time%] ERRO ao baixar o Node >> "%LOG%"
      pause
      exit /b 1
    )
  )
  set "PATH=%~dp0.node;%PATH%"
)

echo Node: >> "%LOG%"
call node -v >> "%LOG%" 2>&1

if not exist "node_modules\electron\dist\electron.exe" (
  echo Instalando dependencias, pode levar alguns minutos...
  echo [%date% %time%] npm install >> "%LOG%"
  call npm install --no-audit --no-fund >> "%LOG%" 2>&1
  if errorlevel 1 (
    echo Falha no npm install. Veja teste-log.txt
    echo [%date% %time%] ERRO no npm install >> "%LOG%"
    pause
    exit /b 1
  )
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo Baixando o Electron...
  call node "node_modules\electron\install.js" >> "%LOG%" 2>&1
)

echo [%date% %time%] Build >> "%LOG%"
call npm run build >> "%LOG%" 2>&1

echo [%date% %time%] Abrindo as duas instancias >> "%LOG%"
start "Telinha 2" /min cmd /c ""%~dp0node_modules\.bin\electron.cmd" . --perfil=2 > "%LOG2%" 2>&1"
call "%~dp0node_modules\.bin\electron.cmd" . >> "%LOG%" 2>&1
echo [%date% %time%] Fim >> "%LOG%"
