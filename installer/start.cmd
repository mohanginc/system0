@echo off
setlocal
chcp 65001 >nul
title system0
cd /d "%~dp0"
if not exist "%~dp0runtime\node.exe" (
  echo Cannot start system0. Please reinstall system0.
  pause
  exit /b 1
)
"%~dp0runtime\node.exe" "%~dp0launch.mjs"
if errorlevel 1 pause
