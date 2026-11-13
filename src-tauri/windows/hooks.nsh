; Fork installer hooks (bundle.windows.nsis.installerHooks), included by installer.nsi.

; Explorer "Open Folder as OpenIDEA Project" on a folder (%1) and on a folder's
; background (%V), under the same root as the install scope, like deep links.
!define OPENIDEA_FOLDER_MENU "Software\Classes\Directory\shell\OpenIDEA"
!define OPENIDEA_BACKGROUND_MENU "Software\Classes\Directory\Background\shell\OpenIDEA"

!macro OPENIDEA_WRITE_FOLDER_MENU key arg
  WriteRegStr SHCTX "${key}" "" "Open Folder as ${PRODUCTNAME} Project"
  WriteRegStr SHCTX "${key}" "Icon" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
  WriteRegStr SHCTX "${key}\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"${arg}$\""
!macroend

; Only removes an entry that still starts this installation's binary.
!macro OPENIDEA_DELETE_FOLDER_MENU key arg
  ReadRegStr $R7 SHCTX "${key}\command" ""
  ${If} $R7 == "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"${arg}$\""
    DeleteRegKey SHCTX "${key}"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro OPENIDEA_WRITE_FOLDER_MENU "${OPENIDEA_FOLDER_MENU}" "%1"
  !insertmacro OPENIDEA_WRITE_FOLDER_MENU "${OPENIDEA_BACKGROUND_MENU}" "%V"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro OPENIDEA_DELETE_FOLDER_MENU "${OPENIDEA_FOLDER_MENU}" "%1"
  !insertmacro OPENIDEA_DELETE_FOLDER_MENU "${OPENIDEA_BACKGROUND_MENU}" "%V"
!macroend
