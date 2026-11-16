; Additions to electron-builder's NSIS installer (scripts/package-desktop.mjs).
;
; Uninstalling removes the tasks the app registers (packages/scheduler): the
; logon task for 开机自启 ("MultiGameAssistant") and the one that wakes the
; computer for scheduled times ("MultiGameAssistant Wake"), so Windows does not
; try to start a program that is gone. The tasks of versions from before the
; rename ("AutoDailyGamePlay", "AutoDailyGamePlay Wake") go too, in case the
; app was never started after upgrading. The data in
; %LOCALAPPDATA%\MultiGameAssistant (sessions, scripts, settings) is kept:
; reinstalling picks it up again.
; An upgrade runs the old uninstaller too, so the tasks are only removed on a
; real uninstall; the app registers them again on its next start when the
; settings are on.

!macro customUnInstall
  ${ifNot} ${isUpdated}
    nsExec::Exec 'schtasks.exe /Delete /TN "MultiGameAssistant" /F'
    Pop $0
    nsExec::Exec 'schtasks.exe /Delete /TN "MultiGameAssistant Wake" /F'
    Pop $0
    nsExec::Exec 'schtasks.exe /Delete /TN "AutoDailyGamePlay" /F'
    Pop $0
    nsExec::Exec 'schtasks.exe /Delete /TN "AutoDailyGamePlay Wake" /F'
    Pop $0
  ${endIf}
!macroend

; The scripts the app downloads (MAA and the like) live in the install folder,
; in scripts\ (apps/desktop/main.mjs, scriptsDir), on the drive the user picked.
; electron-builder's own removal deletes the whole install folder, also on every
; upgrade (the old version's uninstaller runs first). This one removes the app's
; files and leaves scripts\, as the data in %LOCALAPPDATA% is left: an upgrade
; keeps the scripts, and reinstalling into the same folder finds them again.
; On an upgrade the app's files are first moved aside, as electron-builder does,
; so a file still in use stops the upgrade with the old version back in place.
!macro customRemoveFiles
  ${if} ${isUpdated}
    CreateDirectory "$PLUGINSDIR\old-install"
    FindFirst $R6 $R7 "$INSTDIR\*.*"
    adg_move_loop:
      StrCmp $R7 "" adg_move_done
      StrCmp $R7 "." adg_move_next
      StrCmp $R7 ".." adg_move_next
      StrCmp $R7 "scripts" adg_move_next
      IfFileExists "$INSTDIR\$R7\*.*" 0 adg_move_file
        CreateDirectory "$PLUGINSDIR\old-install\$R7"
        Push "\$R7"
        Call un.atomicRMDir
        Pop $R5
        StrCmp $R5 0 adg_move_next adg_move_failed
      adg_move_file:
        ClearErrors
        Rename "$INSTDIR\$R7" "$PLUGINSDIR\old-install\$R7"
        ; The uninstaller itself may be in use.
        StrCmp $R7 "${UNINSTALL_FILENAME}" adg_move_next
        IfErrors 0 adg_move_next
        StrCpy $R5 "$INSTDIR\$R7"
        Goto adg_move_failed
    adg_move_next:
      FindNext $R6 $R7
      Goto adg_move_loop
    adg_move_failed:
      FindClose $R6
      DetailPrint "File is busy, aborting: $R5"
      Push ""
      Call un.restoreFiles
      Pop $R5
      Abort `Can't rename "$INSTDIR" to "$PLUGINSDIR\old-install".`
    adg_move_done:
    FindClose $R6
  ${endIf}

  SetOutPath $TEMP
  FindFirst $R6 $R7 "$INSTDIR\*.*"
  adg_remove_loop:
    StrCmp $R7 "" adg_remove_done
    StrCmp $R7 "." adg_remove_next
    StrCmp $R7 ".." adg_remove_next
    StrCmp $R7 "scripts" adg_remove_next
    IfFileExists "$INSTDIR\$R7\*.*" 0 adg_remove_file
      RMDir /r "$INSTDIR\$R7"
      Goto adg_remove_next
    adg_remove_file:
      Delete "$INSTDIR\$R7"
  adg_remove_next:
    FindNext $R6 $R7
    Goto adg_remove_loop
  adg_remove_done:
  FindClose $R6
  ; Gone only when nothing is left (no scripts\).
  RMDir "$INSTDIR"
!macroend

; Installing or uninstalling first closes the app. electron-builder's check
; takes every program started from inside the install folder for the app, so
; it would also end a script the user is running from scripts\ (and the adb
; server it started). This one looks only at the app's own files, and never
; at itself (an uninstaller run in place, with _?=, is in the install folder).
!macro adgFindApp _RETURN
  nsExec::Exec `"$PowerShellPath" -NoProfile -NonInteractive -C "if (@(Get-CimInstance -ClassName Win32_Process | ? {$$_.Path -and $$_.ProcessId -ne $adgSelf -and $$_.Path.StartsWith('$INSTDIR\', 'CurrentCultureIgnoreCase') -and -not $$_.Path.StartsWith('$INSTDIR\scripts\', 'CurrentCultureIgnoreCase')}).Count -gt 0) { exit 0 } else { exit 1 }"`
  Pop ${_RETURN}
  ${if} ${_RETURN} != 0
  ${andIf} ${_RETURN} != 1
    ; PowerShell could not run: by the program's name.
    nsExec::Exec `"$CmdPath" /C tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
    Pop ${_RETURN}
  ${endIf}
!macroend

; _PS, _TASKKILL: how to force it for PowerShell ("-Force") and for taskkill ("/F"); empty to ask it to close.
!macro adgCloseApp _PS _TASKKILL
  nsExec::Exec `"$PowerShellPath" -NoProfile -NonInteractive -C "Get-CimInstance -ClassName Win32_Process | ? {$$_.Path -and $$_.ProcessId -ne $adgSelf -and $$_.Path.StartsWith('$INSTDIR\', 'CurrentCultureIgnoreCase') -and -not $$_.Path.StartsWith('$INSTDIR\scripts\', 'CurrentCultureIgnoreCase')} | % { Stop-Process -Id $$_.ProcessId ${_PS} }"`
  Pop $R0
  ${if} $R0 != 0
    nsExec::Exec `"$CmdPath" /C taskkill ${_TASKKILL} /IM "${APP_EXECUTABLE_FILENAME}" /FI "PID ne $adgSelf" /FI "USERNAME eq %USERNAME%"`
    Pop $R0
  ${endIf}
!macroend

!macro customCheckAppRunning
  ; Inserted once per build (installer, uninstaller), as electron-builder's own check is.
  Var /GLOBAL adgSelf
  System::Call 'kernel32::GetCurrentProcessId() i .r0'
  StrCpy $adgSelf $0
  ${if} ${isUpdated}
    ; The app quits by itself to update.
    Sleep 1000
  ${endIf}
  !insertmacro adgFindApp $R0
  ${if} $R0 == 0
    ${ifNot} ${isUpdated}
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK adg_close
      Quit
    ${endIf}
    adg_close:
    DetailPrint "$(appClosing)"
    !insertmacro adgCloseApp "" ""
    Sleep 300
    StrCpy $R1 0
    adg_close_loop:
      IntOp $R1 $R1 + 1
      !insertmacro adgFindApp $R0
      ${if} $R0 == 0
        Sleep 1000
        !insertmacro adgCloseApp "-Force" "/F"
        !insertmacro adgFindApp $R0
        ${if} $R0 == 0
          DetailPrint `Waiting for "${PRODUCT_NAME}" to close.`
          Sleep 2000
        ${else}
          Goto adg_closed
        ${endIf}
      ${else}
        Goto adg_closed
      ${endIf}
      ; Probably running as administrator: ask the user to close it.
      ${if} $R1 > 1
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY adg_close_loop
        Quit
      ${else}
        Goto adg_close_loop
      ${endIf}
    adg_closed:
  ${endIf}
!macroend
