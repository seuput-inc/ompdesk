@echo off
rem OMPdesk gh guard: every gh a session's command runs from cmd or a Windows program comes here first (resources\gui-bridge\gh-guard.ts).
bun "%~dp0..\gh-guard.ts" %*
