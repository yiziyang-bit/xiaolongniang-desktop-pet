!macro customInstall
  IfFileExists "$INSTDIR\使用说明与功能介绍.html" 0 +2
    CreateShortCut "$SMPROGRAMS\小龙娘桌宠（公开版）- 使用说明.lnk" "$INSTDIR\使用说明与功能介绍.html"
!macroend

!macro customUnInstall
  Delete "$SMPROGRAMS\小龙娘桌宠（公开版）- 使用说明.lnk"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.小龙娘桌宠"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.xiaolongniang-desktop-pet"
!macroend