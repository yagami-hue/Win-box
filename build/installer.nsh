; build/installer.nsh - Win-Box custom NSIS fragment (picked up automatically: build/installer.nsh)
;
; !! 2026-09-30 (user request: data dir = <installDir>/data, see src/main/util/dataDir.ts):
;   electron-builder's default uninstall logic moves EVERYTHING under $INSTDIR into
;   $PLUGINSDIR\old-install when updating (--updated), which is cleaned up afterwards.
;   That would also move "<installDir>/data" (user config / cache / watch history)
;   away -> every upgrade would lose user data and re-run "first launch".
;
;   This macro replaces the default file-removal block in the uninstaller:
;     - update (--updated): KEEP the "data" directory. Every other top-level child is
;       moved away like the stock logic:
;         * directories -> un.atomicRMDir (file-by-file; NSIS Rename handles files
;           across volumes but NOT directories, hence the recursion);
;         * plain files  -> direct Rename (cross-volume safe for files).
;       If a move fails, fall back to delete; if that fails too, leave it (the new
;       version overwrites same-named files; the running uninstaller itself cannot be
;       moved/deleted - that is expected and handled by NSIS self-deletion).
;     - full uninstall: same as the default (RMDir /r $INSTDIR, includes data).
;
;   NOTES:
;     * labels inside an NSIS macro are global after expansion - this macro is inserted
;       exactly once (un.install section), so the winboxClear* labels stay unique.
;     * un.atomicRMDir clobbers $R0-$R3, so this loop keeps its handle/name in $R4/$R5.
;     * keep this file ASCII-only (NSIS does not always read includes as UTF-8).
;     * verified locally with makensis 3.0.4.1 + a functional harness (.tmp/nsis-func-check.nsi).
!macro customRemoveFiles
  ${if} ${isUpdated}
    CreateDirectory "$PLUGINSDIR\old-install"
    FindFirst $R4 $R5 "$INSTDIR\*.*"
    winboxClearLoop:
      StrCmp $R5 "" winboxClearDone
      StrCmp $R5 "." winboxClearNext
      StrCmp $R5 ".." winboxClearNext
      StrCmp $R5 "data" winboxClearNext
      IfFileExists "$INSTDIR\$R5\*.*" winboxClearDir winboxClearFile
    winboxClearDir:
      Push "\$R5"
      Call un.atomicRMDir
      Pop $R0
      ${if} $R0 != 0
        RMDir /r "$INSTDIR\$R5"
      ${endif}
      Goto winboxClearNext
    winboxClearFile:
      ClearErrors
      Rename "$INSTDIR\$R5" "$PLUGINSDIR\old-install\$R5"
      IfErrors 0 winboxClearNext
      Delete "$INSTDIR\$R5"
      RMDir "$INSTDIR\$R5"
      Goto winboxClearNext
    winboxClearNext:
      FindNext $R4 $R5
      Goto winboxClearLoop
    winboxClearDone:
    FindClose $R4
  ${else}
    RMDir /r $INSTDIR
  ${endif}
!macroend