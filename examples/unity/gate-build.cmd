@echo off
setlocal enabledelayedexpansion
rem am commit gate example for Unity: compile check without opening the editor.
rem ASCII only, CRLF only: cmd.exe parses .cmd files in the machine's OEM code page.
rem
rem Place this file one folder below the project root (for example DevTools\gate-build.cmd).
rem Argument 1 = a .csproj or .sln file name at the project root.
rem   Assembly-CSharp.csproj   default assembly only (no asmdef)
rem   MyGame.sln               every assembly, for projects that use asmdef files
rem Unity generates legacy-format project files, so "dotnet build" does not work here: MSBuild only.
rem Unity regenerates the .csproj/.sln files and they are usually gitignored. A new .cs file is not
rem compiled until the editor (or a script recompile) adds it to the project file.
rem
rem Variables read inside parenthesised blocks use !VAR!: the Program Files (x86) path contains ")".

if "%~1"=="" (
  echo [gate-build] usage: gate-build.cmd ^<project.csproj^|solution.sln^>
  exit /b 2
)

set "PROJECT_ROOT=%~dp0.."
set "TARGET=%PROJECT_ROOT%\%~1"

if not exist "%TARGET%" (
  echo [gate-build] not found: "!TARGET!"
  echo [gate-build] Unity generates this file. Open the project in the Unity editor once.
  exit /b 2
)

set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"

if not exist "%VSWHERE%" (
  echo [gate-build] vswhere.exe not found: "!VSWHERE!"
  echo [gate-build] Visual Studio 2022+ or Build Tools is required.
  exit /b 2
)

set "MSBUILD="
for /f "usebackq tokens=*" %%M in (`"!VSWHERE!" -products * -requires Microsoft.Component.MSBuild -latest -find MSBuild\**\Bin\MSBuild.exe`) do set "MSBUILD=%%M"

if not defined MSBUILD (
  echo [gate-build] MSBuild.exe not found. The Visual Studio install needs the "MSBuild" component.
  exit /b 2
)

"%MSBUILD%" "%TARGET%" -t:Build -p:Configuration=Debug -nologo -v:q -clp:"ErrorsOnly;Summary" -m
exit /b %ERRORLEVEL%
