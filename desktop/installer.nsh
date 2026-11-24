!ifndef BUILD_UNINSTALLER
!include LogicLib.nsh

Var openReaderOldRuntime

!macro checkRealDirectory path
  System::Call 'kernel32::GetFileAttributesW(w "${path}") i.r0'
  IntOp $0 $0 & 0x410
  IntCmp $0 16 +2
  Return
!macroend

Function stageOpenReaderOldRuntime
  StrCpy $2 $INSTDIR 2 1
  ${If} $2 != ":\"
  ${OrIfNot} ${FileExists} "$INSTDIR\resources\runtime\app\server.js"
    Return
  ${EndIf}

  !insertmacro checkRealDirectory "$INSTDIR"
  !insertmacro checkRealDirectory "$INSTDIR\resources"
  !insertmacro checkRealDirectory "$INSTDIR\resources\runtime"

  # A sibling directory stays on the same volume, even when TEMP does not.
  GetFullPathName $1 "$INSTDIR\.."
  ClearErrors
  GetTempFileName $2 "$1"
  ${If} ${Errors}
    Return
  ${EndIf}
  Delete "$2"
  ClearErrors
  Rename "$INSTDIR\resources\runtime" "$2"
  ${IfNot} ${Errors}
    StrCpy $openReaderOldRuntime $2
  ${EndIf}
FunctionEnd

!macro customUnInstallCheck
  ${If} ${Errors}
    DetailPrint "Uninstall was not successful. Not able to launch uninstaller!"
    Return
  ${EndIf}

  # The old NSIS uninstaller aborts if it cannot rename an individual file.
  # Move the bundled runtime at its shallow path and retry the original uninstall.
  ${If} $R0 == 2
    ReadRegStr $R1 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${If} $R1 == $INSTDIR
    ${AndIf} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      Call stageOpenReaderOldRuntime
    ${EndIf}
    ${If} $openReaderOldRuntime != ""
      Push "SHELL_CONTEXT"
      Call uninstallOldVersion
      ${If} ${Errors}
        StrCpy $R0 2
      ${EndIf}
      ${If} $R0 != 0
        ClearErrors
        Rename "$openReaderOldRuntime" "$INSTDIR\resources\runtime"
        ${If} ${Errors}
          MessageBox MB_OK|MB_ICONEXCLAMATION "Could not restore the previous OpenReader program files. They remain at $openReaderOldRuntime."
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${EndIf}

  ${If} $R0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0"
    DetailPrint "Uninstall was not successful. Uninstaller error code: $R0."
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

# Use extended paths for cleanup. NSIS RMDir /r can follow directory junctions,
# so inspect each directory before enumerating its children.
Function removeOpenReaderOldRuntime
  Exch $0
  Push $1
  Push $2
  Push $3
  System::Call 'kernel32::GetFileAttributesW(w r0) i.r3'
  IntOp $3 $3 & 0x400
  ${If} $3 == 0
    ClearErrors
    FindFirst $1 $2 "$0\*"
    ${IfNot} ${Errors}
      ${While} $2 != ""
        ${If} $2 != "."
        ${AndIf} $2 != ".."
          System::Call 'kernel32::GetFileAttributesW(w "$0\$2") i.r3'
          IntOp $3 $3 & 0x10
          ${If} $3 == 0
            Delete "$0\$2"
          ${Else}
            Push "$0\$2"
            Call removeOpenReaderOldRuntime
          ${EndIf}
        ${EndIf}
        FindNext $1 $2
      ${EndWhile}
      FindClose $1
    ${EndIf}
  ${EndIf}
  RMDir "$0"
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

!macro customInstall
  ${If} $openReaderOldRuntime != ""
    Push "\\?\$openReaderOldRuntime"
    Call removeOpenReaderOldRuntime
  ${EndIf}
!macroend
!endif
