@echo off
echo ========================================
echo Starting Koishi Test Instance
echo ========================================
echo.
echo Checking plugin...
if not exist "..\lib\index.js" (
    echo ERROR: Plugin not compiled!
    echo Please run: cd .. ^&^& npm run build
    pause
    exit /b 1
)
echo Plugin found: ..\lib\index.js
echo.
echo Starting Koishi...
echo Console URL: http://localhost:5140
echo.
npx koishi start
