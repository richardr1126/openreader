!include LogicLib.nsh

# The bundled runtime has paths that, with the install directory in front, can
# exceed MAX_PATH. NSIS file operations then fail, so this file moves the runtime
# as one shallow rename and removes it through extended-length paths.

Var openReaderOldRuntime

!macro checkRealDirectory path
  System::Call 'kernel32::GetFileAttributesW(w "${path}") i.r0'
  IntOp $0 $0 & 0x410
  IntCmp $0 16 +2
  Return
!macroend

!macro defineOpenReaderRuntimeFunctions un
# Rename $INSTDIR\resources\runtime to a sibling of $INSTDIR, on the same volume
# even when TEMP is not, and record it in $openReaderOldRuntime.
Function ${un}stageOpenReaderOldRuntime
  StrCpy $2 $INSTDIR 2 1
  ${If} $2 != ":\"
  ${OrIfNot} ${FileExists} "$INSTDIR\resources\runtime\app\server.js"
    Return
  ${EndIf}

  !insertmacro checkRealDirectory "$INSTDIR"
  !insertmacro checkRealDirectory "$INSTDIR\resources"
  !insertmacro checkRealDirectory "$INSTDIR\resources\runtime"

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

# Remove a tree through an extended path. NSIS RMDir /r can follow directory
# junctions, so inspect each directory before enumerating its children.
Function ${un}removeOpenReaderTree
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
            Call ${un}removeOpenReaderTree
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
!macroend

!ifdef BUILD_UNINSTALLER
!insertmacro defineOpenReaderRuntimeFunctions "un."

# Replaces electron-builder's file removal. On an update it moves every file
# into $PLUGINSDIR\old-install to detect busy files, and that destination is
# longer than the install directory, so the deep runtime moves first in one
# rename. A full uninstall removes the tree through extended paths, where
# RMDir /r would leave the deep files behind.
!macro customRemoveFiles
  ${If} ${isUpdated}
    Call un.stageOpenReaderOldRuntime
    CreateDirectory "$PLUGINSDIR\old-install"
    Push ""
    Call un.atomicRMDir
    Pop $R0
    ${If} $R0 != 0
      DetailPrint "File is busy, aborting: $R0"
      Push ""
      Call un.restoreFiles
      Pop $R0
      ${If} $openReaderOldRuntime != ""
        Rename "$openReaderOldRuntime" "$INSTDIR\resources\runtime"
      ${EndIf}
      Abort `Can't rename "$INSTDIR" to "$PLUGINSDIR\old-install".`
    ${EndIf}
  ${EndIf}

  SetOutPath $TEMP
  ${If} $openReaderOldRuntime != ""
    Push "\\?\$openReaderOldRuntime"
    Call un.removeOpenReaderTree
  ${EndIf}
  StrCpy $R0 $INSTDIR 2 1
  ${If} $R0 == ":\"
    Push "\\?\$INSTDIR"
    Call un.removeOpenReaderTree
  ${Else}
    RMDir /r $INSTDIR
  ${EndIf}
!macroend

!else
!insertmacro defineOpenReaderRuntimeFunctions ""

# For updates from 5.5.3 and earlier, whose uninstaller predates
# customRemoveFiles: it aborts with code 2 when it cannot move one deep file.
# Move the runtime aside and retry that uninstaller.
!macro customUnInstallCheck
  ${If} ${Errors}
    DetailPrint "Uninstall was not successful. Not able to launch uninstaller!"
    Return
  ${EndIf}

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
          StrCpy $R1 "Could not restore the previous OpenReader program files. They remain at $openReaderOldRuntime."
          DetailPrint "$R1"
          MessageBox MB_OK|MB_ICONEXCLAMATION "$R1" /SD IDOK
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${EndIf}

  ${If} $R0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0" /SD IDOK
    DetailPrint "Uninstall was not successful. Uninstaller error code: $R0."
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

!macro customInstall
  ${If} $openReaderOldRuntime != ""
    Push "\\?\$openReaderOldRuntime"
    Call removeOpenReaderTree
  ${EndIf}
!macroend
!endif
