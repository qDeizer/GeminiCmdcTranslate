@echo off
title Gemini1 - Command Code Native Bridge
chcp 65001 >nul
cd /d "%~dp0"

echo ========================================================
echo   Gemini1 - Command Code Native Bridge ^& Dashboard
echo ========================================================
echo.

where node >nul 2>&1
if errorlevel 1 goto :no_node

set PORT=8741

echo [BILGI] Servis baslatiliyor...
echo [BILGI] Dashboard Adresi: http://127.0.0.1:%PORT%/ui
echo.

start "" powershell -NoProfile -Command "Start-Sleep -Milliseconds 1500; Start-Process 'http://127.0.0.1:%PORT%/ui'"

node src/server.mjs
goto :end

:no_node
echo [HATA] Node.js sistemde bulunamadi!
echo Lutfen Node.js v22 veya uzeri yukleyin: https://nodejs.org/
echo.
pause
exit /b 1

:end
echo.
echo [BILGI] Servis durduruldu.
pause
