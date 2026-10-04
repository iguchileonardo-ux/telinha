@echo off
rem Configuracao unica do GitHub neste PC (vale para projetos futuros)
rem e publicacao da Telinha com atualizacao automatica.
setlocal EnableDelayedExpansion
cd /d "%~dp0"
set "PATH=%ProgramFiles%\Git\cmd;%ProgramFiles%\GitHub CLI;%LOCALAPPDATA%\Programs\GitHub CLI;%PATH%"

echo.
echo  === 1/5  Git e GitHub CLI ===
where git >nul 2>nul
if errorlevel 1 (
  echo  Instalando o Git. Se o Windows pedir permissao, aceite.
  winget install --id Git.Git -e --source winget
)
where gh >nul 2>nul
if errorlevel 1 (
  echo  Instalando o GitHub CLI. Se o Windows pedir permissao, aceite.
  winget install --id GitHub.cli -e --source winget
)
where git >nul 2>nul || goto falta_programa
where gh >nul 2>nul || goto falta_programa

echo.
echo  === 2/5  Login no GitHub ===
gh auth status >nul 2>nul
if errorlevel 1 (
  echo  O navegador vai abrir. Entre na sua conta do GitHub, ou crie uma,
  echo  e digite o codigo que aparecer aqui embaixo.
  echo.
  gh auth login --hostname github.com --git-protocol https --web --scopes "repo,workflow"
  if errorlevel 1 goto erro
)
gh auth setup-git >nul 2>nul

for /f "delims=" %%a in ('gh api user --jq .login') do set "GHUSER=%%a"
for /f "delims=" %%a in ('gh api user --jq .id') do set "GHID=%%a"
if not defined GHUSER goto erro
echo  Conectado como !GHUSER!

echo.
echo  === 3/5  Identidade do Git ===
git config --global user.name >nul 2>nul || git config --global user.name "!GHUSER!"
rem E-mail privado do GitHub: o seu e-mail real nao aparece nos commits publicos.
git config --global user.email >nul 2>nul || git config --global user.email "!GHID!+!GHUSER!@users.noreply.github.com"
git config --global init.defaultBranch main
echo  Nome:   & git config --global user.name
echo  E-mail: & git config --global user.email

echo.
echo  === 4/5  Repositorio da Telinha ===
call :node || goto erro
node ferramentas\configurar-repo.mjs !GHUSER! || goto erro
if not exist ".git" git init -q
git add -A
git commit -q -m "Telinha 2.0" >nul 2>nul
gh repo view "!GHUSER!/telinha" >nul 2>nul
if errorlevel 1 (
  gh repo create telinha --public --source . --remote origin --push --description "Compartilhamento de tela entre amigos" || goto erro
) else (
  git remote get-url origin >nul 2>nul || git remote add origin "https://github.com/!GHUSER!/telinha.git"
  git push -u origin main || goto erro
)
echo  https://github.com/!GHUSER!/telinha

echo.
echo  === 5/5  Primeira publicacao ===
call "%~dp0Publicar atualizacao.bat" /semPausa || goto erro

echo.
echo  Pronto. O GitHub esta configurado neste PC e a Telinha agora se atualiza sozinha.
echo  O instalador novo abriu: instale por cima para o seu app tambem receber atualizacoes.
echo  Mande aos amigos o Telinha-Instalador.exe da pasta "Telinha Instalador".
pause
exit /b 0

:node
where node >nul 2>nul && exit /b 0
if not exist ".node\node.exe" powershell -NoProfile -ExecutionPolicy Bypass -File "ferramentas\baixar-node.ps1" || exit /b 1
set "PATH=%~dp0.node;%PATH%"
exit /b 0

:falta_programa
echo.
echo  A instalacao terminou, mas o Windows ainda nao encontrou o programa.
echo  Feche esta janela e abra o "Configurar GitHub.bat" de novo.
pause
exit /b 1

:erro
echo.
echo  Algo deu errado. A mensagem acima mostra o motivo.
pause
exit /b 1
