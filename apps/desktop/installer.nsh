; Additions to electron-builder's NSIS installer (scripts/package-desktop.mjs).
;
; Uninstalling removes the logon task the app registers for 开机自启
; (packages/scheduler, task "AutoDailyGamePlay"), so Windows does not try to
; start a program that is gone. The data in %LOCALAPPDATA%\AutoDailyGamePlay
; (sessions, scripts, settings) is kept: reinstalling picks it up again.
; An upgrade runs the old uninstaller too, so the task is only removed on a
; real uninstall; the app registers it again on its next start when 开机自启 is on.

!macro customUnInstall
  ${ifNot} ${isUpdated}
    nsExec::Exec 'schtasks.exe /Delete /TN "AutoDailyGamePlay" /F'
    Pop $0
  ${endIf}
!macroend
