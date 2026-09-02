@echo off
REM Kept for double-clicking from Explorer. The launcher itself is tools/edge.js —
REM see the comment at the top of that file for why it is node and not batch.
REM
REM From a terminal, prefer:  npm run edge
node "%~dp0tools/edge.js" %*
if errorlevel 1 pause
