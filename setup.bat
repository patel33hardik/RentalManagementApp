@echo off
echo ================================================
echo   Rental Manager — Setup
echo ================================================
echo.

:: Check Node.js
node -v >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found!
    echo Please download and install Node.js LTS from https://nodejs.org
    pause
    exit /b 1
)

echo [OK] Node.js found:
node -v
echo.

:: Check npm
npm -v >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] npm not found. Reinstall Node.js from https://nodejs.org
    pause
    exit /b 1
)

echo [OK] npm found:
npm -v
echo.

echo Installing dependencies (this may take a few minutes)...
echo.
npm install

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] npm install failed.
    echo.
    echo Try running this in PowerShell as Administrator first:
    echo   npm install -g windows-build-tools
    echo.
    echo Then run setup.bat again.
    pause
    exit /b 1
)

echo.
echo ================================================
echo   Setup complete! Starting Rental Manager...
echo ================================================
echo.
npm start
