; Custom installer page -- a pre-checked acknowledgement that this is
; company equipment subject to monitoring, shown once during install.
;
; This is deliberately NOT the real consent mechanism. It can't be:
; the installer runs before anyone has signed in, so there's no
; employee ID or company ID yet to write a real record against. The
; actual consent that matters -- tied to a real employee and a real
; monitoring_policies version, in monitoring_acknowledgements -- still
; happens in-app, after login, and still cannot be skipped. This page
; only adds an additional install-time notice on top of that, per the
; existing signed equipment-use agreement companies already have
; employees complete separately.

!include "nsDialogs.nsh"
!include "LogicLib.nsh"

Var ConsentCheckbox

!macro customHeader
  Page custom MonitoringNoticePageCreate MonitoringNoticePageLeave
!macroend

Function MonitoringNoticePageCreate
  nsDialogs::Create 1018
  Pop $0

  ${NSD_CreateLabel} 0 0 100% 60u "This is company-owned equipment. As described in your employment agreement, activity on this device may be tracked and periodically monitored, including screenshots, while checked in for work.$\r$\n$\r$\nYou'll still review and confirm your company's specific monitoring policy the first time you sign in to the app."
  Pop $0

  ${NSD_CreateCheckbox} 0 70u 100% 12u "I acknowledge this device is company equipment subject to monitoring"
  Pop $ConsentCheckbox
  ${NSD_SetState} $ConsentCheckbox ${BST_CHECKED}

  nsDialogs::Show
FunctionEnd

Function MonitoringNoticePageLeave
  ; Intentionally does not block installation either way -- this is a
  ; notice, not a gate. The real, mandatory consent gate is the in-app
  ; screen after login, which enforces this properly with an actual
  ; database record.
FunctionEnd
