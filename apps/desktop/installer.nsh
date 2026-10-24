; Additions to electron-builder's NSIS installer (scripts/package-desktop.mjs).
;
; Uninstalling removes the tasks the app registers (packages/scheduler): the
; logon task for 开机自启 ("AutoDailyGamePlay") and the one that wakes the
; computer for scheduled times ("AutoDailyGamePlay Wake"), so Windows does not
; try to start a program that is gone. The data in
; %LOCALAPPDATA%\AutoDailyGamePlay (sessions, scripts, settings) is kept:
; reinstalling picks it up again.
; An upgrade runs the old uninstaller too, so the tasks are only removed on a
; real uninstall; the app registers them again on its next start when the
; settings are on.

!macro customUnInstall
  ${ifNot} ${isUpdated}
    nsExec::Exec 'schtasks.exe /Delete /TN "AutoDailyGamePlay" /F'
    Pop $0
    nsExec::Exec 'schtasks.exe /Delete /TN "AutoDailyGamePlay Wake" /F'
    Pop $0
  ${endIf}
!macroend
