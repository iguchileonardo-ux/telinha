@echo off
rem Copia o instalador gerado para Documentos\Telinha Instalador
rem e cria um atalho para essa pasta na Area de Trabalho.
setlocal
set "ORIGEM=%~dp0..\release\Telinha-Instalador.exe"
set "DESTINO=%USERPROFILE%\Documents\Telinha Instalador"
if not exist "%ORIGEM%" (
  echo Instalador nao encontrado. Rode "Criar instalador.bat" primeiro.
  pause
  exit /b 1
)
if not exist "%DESTINO%" mkdir "%DESTINO%"
copy /Y "%ORIGEM%" "%DESTINO%\Telinha-Instalador.exe" >nul

rem Remove o .zip da versao 1, que nao funciona com a versao 2.
if exist "%DESTINO%\Telinha-Instalador.zip" del /Q "%DESTINO%\Telinha-Instalador.zip"

(
  echo Telinha - instalador
  echo.
  echo Para mandar aos amigos: arraste o Telinha-Instalador.exe para uma conversa do WhatsApp.
  echo O WhatsApp envia como documento, sem perder qualidade.
  echo.
  echo Para instalar: dois cliques no Telinha-Instalador.exe.
  echo Se o Windows mostrar "O Windows protegeu o computador", clique em
  echo "Mais informacoes" e depois em "Executar assim mesmo".
  echo.
  echo Depois de instalado, a Telinha abre pelo atalho na Area de Trabalho ou no Menu Iniciar.
) > "%DESTINO%\LEIA-ME.txt"

rem Atalho "Telinha Instalador" na Area de Trabalho (funciona tambem com OneDrive).
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$d=[Environment]::GetFolderPath('Desktop'); $s=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $d 'Telinha Instalador.lnk')); $s.TargetPath='%DESTINO%'; $s.IconLocation='%DESTINO%\Telinha-Instalador.exe,0'; $s.Save()"

start "" explorer "%DESTINO%"
