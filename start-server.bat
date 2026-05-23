@echo off
setlocal
pushd "%~dp0" >nul || exit /b 1
title Clashit Royalol - dev server
echo Serving on http://localhost:8080  (Ctrl+C to stop)
echo.
npx --yes serve -l 8080 .
set "exitCode=%ERRORLEVEL%"
popd >nul
exit /b %exitCode%
