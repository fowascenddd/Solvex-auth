@echo off
setlocal enabledelayedexpansion
title Sinfultp AI - GitHub Push Utility
cd /d "%~dp0"

set "REPO_URL=https://github.com/fowascenddd/Solvex-auth.git"
set "REPO_TOKEN_URL=github.com/fowascenddd/Solvex-auth.git"
set "BRANCH=sinfultp-ai"

echo ========================================================
echo           SINFULTP AI - GITHUB PUSH UTILITY
echo ========================================================
echo.

git --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Git is not installed or not in your PATH.
    pause
    exit /b 1
)

if /i "%BRANCH%"=="main" (
    echo WARNING: BRANCH is set to main. This can overwrite your Solvex auth code.
    set "OKMAIN=N"
    set /p "OKMAIN=Continue anyway? (y/N): "
    if /i not "!OKMAIN!"=="y" exit /b 1
)

echo Pushing from: %cd%
echo Target repo : %REPO_URL%
echo Branch      : %BRANCH%
echo.

if not exist ".git" (
    echo No git repo found here, initializing one...
    git init
    echo.
)

if not exist ".gitignore" type nul > .gitignore
call :ignore "node_modules/"
call :ignore ".env"
call :ignore ".env.*"
call :ignore "*.log"
call :ignore "*.zip"

git rm -r --cached --ignore-unmatch .env node_modules >nul 2>&1

git remote remove origin >nul 2>&1
git remote add origin %REPO_URL%

git config user.name >nul 2>&1
if errorlevel 1 git config user.name "fowascenddd"
git config user.email >nul 2>&1
if errorlevel 1 git config user.email "fowascenddd@users.noreply.github.com"

echo Staging files...
git add .
echo.
echo Files staged:
git status --short
echo.

set "MSG=Update sinfultp ai"
set /p "MSG=Commit message (Enter for default): "
if "!MSG!"=="" set "MSG=Update sinfultp ai"

git diff --cached --quiet
if errorlevel 1 (
    git commit -m "!MSG!"
) else (
    echo Nothing new to commit, pushing existing commits...
)

echo.
git branch -M %BRANCH%

echo Pushing to GitHub...
if defined GH_TOKEN (
    git push -u "https://%GH_TOKEN%@%REPO_TOKEN_URL%" %BRANCH%
) else (
    git push -u origin %BRANCH%
)

if not errorlevel 1 goto :success

echo.
echo Push was rejected or failed.
set "FORCE=N"
set /p "FORCE=Force push and overwrite branch %BRANCH% on the remote? (y/N): "
if /i not "!FORCE!"=="y" goto :failed

if defined GH_TOKEN (
    git push --force -u "https://%GH_TOKEN%@%REPO_TOKEN_URL%" %BRANCH%
) else (
    git push --force -u origin %BRANCH%
)
if errorlevel 1 goto :failed

:success
echo.
echo ========================================================
echo  SUCCESS: Pushed to github.com/fowascenddd/Solvex-auth (%BRANCH%)
echo ========================================================
goto :end

:failed
echo.
echo ERROR: Push failed. Check your GitHub login or token permissions.

:end
echo.
pause
exit /b

:ignore
findstr /x /c:"%~1" .gitignore >nul 2>&1
if errorlevel 1 echo %~1>>.gitignore
exit /b
