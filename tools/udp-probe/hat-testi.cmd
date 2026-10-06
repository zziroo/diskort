@echo off
rem Diskort hat testi: cift tikla, test kodunu ve adini yaz.
rem probe.mjs her calistirmada SHA-256 ile dogrulanir; uymazsa GitHub'dan yeniden indirilir, yine uymazsa calistirilmaz.
rem Bu hash tools/udp-probe/probe.mjs ile birebir ayni olmali (test/lineTest.test.ts denetler).
rem Patlama testi (yonetici koduyla, ~45 sn): hat-testi.cmd --patlama   (diger secenekler: README.md)
setlocal EnableDelayedExpansion
set "PROBE_SHA256=ebd5c4ed637add674fff83bbde02a0f308cbe56af6c8e1f104af2b34811f5372"
set "PROBE_URL=https://raw.githubusercontent.com/zziroo/diskort/main/tools/udp-probe/probe.mjs"
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo  Diskort hat testi (yaklasik 2-3 dakika surer; Wi-Fi yerine kablo daha iyi, test surerken indirme/video acma)
echo.
set /p DK_KOD= Yoneticiden aldigin test kodu:
set /p DK_AD= Adin:
set DK_KOD| findstr /R /X /C:"DK_KOD=[A-Za-z0-9][A-Za-z0-9]*" >nul || (echo Gecersiz kod: yalnizca harf ve rakam. & pause & exit /b 1)
set DK_AD| findstr /R /X /C:"DK_AD=[A-Za-z0-9 _.-][A-Za-z0-9 _.-]*" >nul || (echo Gecersiz ad: yalnizca harf, rakam, bosluk, _ . - & pause & exit /b 1)
call :verify
if errorlevel 1 (
  del probe.mjs >nul 2>nul
  powershell -NoProfile -Command "Invoke-WebRequest '%PROBE_URL%' -OutFile probe.mjs"
  call :verify
  if errorlevel 1 (
    del probe.mjs >nul 2>nul
    echo probe.mjs dogrulanamadi ^(SHA-256 uyusmuyor^); guvenlik icin calistirilmadi.
    pause
    exit /b 1
  )
)
where node >nul 2>nul
if %errorlevel%==0 (
  node probe.mjs --kod "%DK_KOD%" --ad "%DK_AD%" %*
) else (
  rem Node yoksa Diskort uygulamasinin kendi Node'u kullanilir
  set ELECTRON_RUN_AS_NODE=1
  "%LOCALAPPDATA%\Programs\Diskort\Diskort.exe" probe.mjs --kod "%DK_KOD%" --ad "%DK_AD%" %*
)
echo.
pause
exit /b 0

:verify
if not exist probe.mjs exit /b 1
set "DK_HASH="
for /f "skip=1 tokens=* delims=" %%H in ('certutil -hashfile probe.mjs SHA256') do if not defined DK_HASH set "DK_HASH=%%H"
set "DK_HASH=!DK_HASH: =!"
if /i "!DK_HASH!"=="%PROBE_SHA256%" exit /b 0
exit /b 1
