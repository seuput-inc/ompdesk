@echo off
cd /d "%~dp0.."
bun scripts/worktree-install.ts || exit /b 1
git config core.hooksPath .githooks
