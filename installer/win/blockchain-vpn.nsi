; Blockchain VPN — full Windows installer + uninstaller (NSIS)
;
; Installs the COMPLETE client in one shot:
;   - Tauri desktop UI            (app.exe)
;   - Noise IK tun-client         (bin\blockchain-vpn-tun-client.exe + wintun.dll)
;   - Control-plane daemon        (control-plane\daemon.js) on a bundled Node runtime
;   - Scheduled Task "BlockchainVpnControlPlane" running the daemon as SYSTEM at boot
;
; The uninstaller (uninstall.exe, also surfaced in Add/Remove Programs) stops and
; removes the service, kills the tunnel + UI, deletes program + data dirs, and
; clears shortcuts/registry.
;
; Build (from this dir, in the VM): makensis blockchain-vpn.nsi
; Payload layout expected next to this script (see payload\):
;   payload\app.exe
;   payload\node.exe
;   payload\bin\blockchain-vpn-tun-client.exe
;   payload\bin\wintun.dll
;   payload\control-plane\daemon.js

Unicode true
ManifestDPIAware true

!define APPNAME       "Blockchain VPN"
!define APPVERSION    "0.1.0"
!define PUBLISHER     "blockchainvpn"
!define TASKNAME      "BlockchainVpnControlPlane"
!define REGUNINST     "Software\Microsoft\Windows\CurrentVersion\Uninstall\BlockchainVPN"
; With SetShellVarContext all, $APPDATA == C:\ProgramData on the target.
!define DATADIR       "$APPDATA\BlockchainVpn"

Name "${APPNAME} ${APPVERSION}"
OutFile "blockchain-vpn-${APPVERSION}-full-setup.exe"
InstallDir "$PROGRAMFILES64\${APPNAME}"
RequestExecutionLevel admin
ShowInstDetails show
ShowUninstDetails show

!include "MUI2.nsh"
!include "x64.nsh"

!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\app.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Launch ${APPNAME}"
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

; --------------------------------------------------------------------- install
Section "Install"
  SetShellVarContext all

  ; Stop any prior service + processes so files aren't locked on upgrade.
  nsExec::ExecToLog 'schtasks /end /tn "${TASKNAME}"'
  nsExec::ExecToLog 'schtasks /delete /tn "${TASKNAME}" /f'
  nsExec::ExecToLog 'taskkill /f /im blockchain-vpn-tun-client.exe'
  nsExec::ExecToLog 'taskkill /f /im app.exe'

  ; ---- program files ----
  SetOutPath "$INSTDIR"
  File "payload\app.exe"
  File "payload\node.exe"

  SetOutPath "$INSTDIR\bin"
  File "payload\bin\blockchain-vpn-tun-client.exe"
  File "payload\bin\wintun.dll"

  SetOutPath "$INSTDIR\control-plane"
  File "payload\control-plane\daemon.js"

  ; ---- data + log dirs (ProgramData, persists across upgrades) ----
  CreateDirectory "${DATADIR}"
  CreateDirectory "${DATADIR}\data"
  CreateDirectory "${DATADIR}\logs"

  ; ---- control-plane launcher (env wired so daemon spawns the bundled
  ;      tun-client and uses the bundled node) ----
  FileOpen $0 "$INSTDIR\run-control-plane.cmd" w
  FileWrite $0 "@echo off$\r$\n"
  FileWrite $0 "setlocal$\r$\n"
  FileWrite $0 "set BVPN_HOST=127.0.0.1$\r$\n"
  FileWrite $0 "set BVPN_PORT=8787$\r$\n"
  FileWrite $0 "set BVPN_DATA_DIR=${DATADIR}\data$\r$\n"
  FileWrite $0 "set BVPN_LOG_FILE=${DATADIR}\logs\control-plane.log$\r$\n"
  FileWrite $0 "set BVPN_TUN_CLIENT_BIN=$INSTDIR\bin\blockchain-vpn-tun-client.exe$\r$\n"
  FileWrite $0 "set PATH=$INSTDIR\bin;%PATH%$\r$\n"
  FileWrite $0 '"$INSTDIR\node.exe" "$INSTDIR\control-plane\daemon.js" 1>>"${DATADIR}\logs\control-plane.log" 2>&1$\r$\n'
  FileClose $0

  ; ---- scheduled task: run the daemon as SYSTEM at boot, and now ----
  nsExec::ExecToLog 'schtasks /create /tn "${TASKNAME}" /tr "\"$INSTDIR\run-control-plane.cmd\"" /sc onstart /ru SYSTEM /rl HIGHEST /f'
  nsExec::ExecToLog 'schtasks /run /tn "${TASKNAME}"'

  ; ---- shortcuts ----
  CreateDirectory "$SMPROGRAMS\${APPNAME}"
  CreateShortcut "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk" "$INSTDIR\app.exe"
  CreateShortcut "$SMPROGRAMS\${APPNAME}\Uninstall ${APPNAME}.lnk" "$INSTDIR\uninstall.exe"
  CreateShortcut "$DESKTOP\${APPNAME}.lnk" "$INSTDIR\app.exe"

  ; ---- uninstaller + Add/Remove Programs ----
  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr   HKLM "${REGUNINST}" "DisplayName"     "${APPNAME}"
  WriteRegStr   HKLM "${REGUNINST}" "DisplayVersion"  "${APPVERSION}"
  WriteRegStr   HKLM "${REGUNINST}" "Publisher"       "${PUBLISHER}"
  WriteRegStr   HKLM "${REGUNINST}" "DisplayIcon"     "$INSTDIR\app.exe"
  WriteRegStr   HKLM "${REGUNINST}" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
  WriteRegStr   HKLM "${REGUNINST}" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKLM "${REGUNINST}" "NoModify" 1
  WriteRegDWORD HKLM "${REGUNINST}" "NoRepair" 1
SectionEnd

; ------------------------------------------------------------------- uninstall
Section "Uninstall"
  SetShellVarContext all

  ; Stop service + tunnel + UI.
  nsExec::ExecToLog 'schtasks /end /tn "${TASKNAME}"'
  nsExec::ExecToLog 'schtasks /delete /tn "${TASKNAME}" /f'
  nsExec::ExecToLog 'taskkill /f /im blockchain-vpn-tun-client.exe'
  nsExec::ExecToLog 'taskkill /f /im node.exe'
  nsExec::ExecToLog 'taskkill /f /im app.exe'

  ; Best-effort: remove the wintun tunnel adapter so no bvpntun1 lingers.
  nsExec::ExecToLog 'netsh interface set interface name="bvpntun1" admin=disable'

  ; Remove program files.
  Delete "$INSTDIR\app.exe"
  Delete "$INSTDIR\node.exe"
  Delete "$INSTDIR\run-control-plane.cmd"
  Delete "$INSTDIR\uninstall.exe"
  Delete "$INSTDIR\bin\blockchain-vpn-tun-client.exe"
  Delete "$INSTDIR\bin\wintun.dll"
  Delete "$INSTDIR\control-plane\daemon.js"
  RMDir  "$INSTDIR\bin"
  RMDir  "$INSTDIR\control-plane"
  RMDir  "$INSTDIR"

  ; Remove data + logs (pairing keys, leases, logs).
  RMDir /r "${DATADIR}"

  ; Shortcuts + registry.
  Delete "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk"
  Delete "$SMPROGRAMS\${APPNAME}\Uninstall ${APPNAME}.lnk"
  RMDir  "$SMPROGRAMS\${APPNAME}"
  Delete "$DESKTOP\${APPNAME}.lnk"
  DeleteRegKey HKLM "${REGUNINST}"
SectionEnd
