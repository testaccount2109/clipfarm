!include "nsDialogs.nsh"

!macro customHeader
!ifndef BUILD_UNINSTALLER
Var ClipfarmOptionsDialog
Var ClipfarmDesktopCheckbox
Var ClipfarmStartMenuCheckbox
Var ClipfarmDesktopSelected
Var ClipfarmStartMenuSelected

Function ClipfarmOptionsPageCreate
  nsDialogs::Create 1018
  Pop $ClipfarmOptionsDialog
  ${If} $ClipfarmOptionsDialog == error
    Abort
  ${EndIf}

  !insertmacro MUI_HEADER_TEXT "Verknüpfungen" "Lege fest, wo Clipfarm schnell erreichbar sein soll."

  ${NSD_CreateLabel} 0 0 100% 30u "Wähle die Verknüpfungen aus, die beim Installieren angelegt werden sollen. Du kannst Clipfarm später jederzeit über das Startmenü öffnen."
  Pop $0

  ${NSD_CreateGroupBox} 0 38u 100% 76u "Schnellzugriff"
  Pop $0

  ${NSD_CreateCheckbox} 12u 55u 92% 12u "Desktop-Verknüpfung erstellen"
  Pop $ClipfarmDesktopCheckbox
  ${If} $ClipfarmDesktopSelected == "1"
    ${NSD_Check} $ClipfarmDesktopCheckbox
  ${EndIf}

  ${NSD_CreateCheckbox} 12u 82u 92% 12u "Im Startmenü ablegen"
  Pop $ClipfarmStartMenuCheckbox
  ${If} $ClipfarmStartMenuSelected == "1"
    ${NSD_Check} $ClipfarmStartMenuCheckbox
  ${EndIf}

  ${NSD_CreateLabel} 0 128u 100% 28u "Das grüne Clipfarm-Symbol erscheint im Installer, auf Verknüpfungen und in der Taskleiste."
  Pop $0

  nsDialogs::Show
FunctionEnd

Function ClipfarmOptionsPageLeave
  ${NSD_GetState} $ClipfarmDesktopCheckbox $ClipfarmDesktopSelected
  ${NSD_GetState} $ClipfarmStartMenuCheckbox $ClipfarmStartMenuSelected
FunctionEnd
!endif
!macroend

!macro customInit
  StrCpy $ClipfarmDesktopSelected "1"
  StrCpy $ClipfarmStartMenuSelected "1"

  ReadRegStr $0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" "ClipfarmDesktopShortcut"
  ${If} $0 != ""
    StrCpy $ClipfarmDesktopSelected $0
  ${EndIf}

  ReadRegStr $0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" "ClipfarmStartMenuShortcut"
  ${If} $0 != ""
    StrCpy $ClipfarmStartMenuSelected $0
  ${EndIf}
!macroend

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Clipfarm installieren"
  !define MUI_WELCOMEPAGE_TEXT "Clipfarm hält deine Spielmomente lokal fest.$\r$\n$\r$\nIm nächsten Schritt kannst du den Installationsort und deine Verknüpfungen auswählen."
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customPageAfterChangeDir
  Page custom ClipfarmOptionsPageCreate ClipfarmOptionsPageLeave
!macroend

!macro customInstall
  ${If} $ClipfarmDesktopSelected == "1"
    CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
  ${Else}
    Delete "$newDesktopLink"
    Delete "$oldDesktopLink"
  ${EndIf}

  ${If} $ClipfarmStartMenuSelected == "1"
    !ifdef MENU_FILENAME
      CreateDirectory "$SMPROGRAMS\${MENU_FILENAME}"
    !endif
    CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
  ${Else}
    Delete "$newStartMenuLink"
    Delete "$oldStartMenuLink"
    !ifdef MENU_FILENAME
      RMDir "$SMPROGRAMS\${MENU_FILENAME}"
    !endif
  ${EndIf}

  WriteRegStr SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" "ClipfarmDesktopShortcut" $ClipfarmDesktopSelected
  WriteRegStr SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" "ClipfarmStartMenuShortcut" $ClipfarmStartMenuSelected
  WriteRegStr SHELL_CONTEXT "Software\Clipfarm\Updater" "InstallLocation" "$INSTDIR"
!macroend

!macro customUnInstall
  DeleteRegKey SHELL_CONTEXT "Software\Clipfarm\Updater"
  Delete "$newDesktopLink"
  Delete "$oldDesktopLink"
  Delete "$newStartMenuLink"
  Delete "$oldStartMenuLink"
  !ifdef MENU_FILENAME
    RMDir "$SMPROGRAMS\${MENU_FILENAME}"
  !endif
!macroend
