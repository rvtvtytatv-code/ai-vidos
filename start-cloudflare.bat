@echo off
chcp 65001 >nul
cloudflared tunnel --url http://localhost:3000
pause
