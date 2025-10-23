@echo off
echo Starting DDEnter script at %date% %time%
cd /d "F:\automation\src\ConfidantDDE"
"C:\Program Files\nodejs\node.exe" DDEnter.js >> "F:\automation\src\ConfidantDDE\DDEnter_log.txt" 2>&1
echo Script finished at %date% %time%
pause
