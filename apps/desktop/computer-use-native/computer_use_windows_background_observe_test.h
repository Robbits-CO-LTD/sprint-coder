#pragma once

#include "computer_use_windows_interlock_capture.h"

// Portable P2b seam. The Windows component/live runs must additionally measure OS ownership,
// occluded-window capture and forbidden API attempts; these synthetic facts do not prove those.
inline bool CheckWindowsBackgroundObservation() {
  using namespace sprint_coder::computer_use;
  if (!WindowsBackgroundObservationNodeAdmitted(7, 7, true, true, false, false)) return false;
  if (WindowsBackgroundObservationNodeAdmitted(0, 0, true, true, false, false)) return false;
  if (WindowsBackgroundObservationNodeAdmitted(8, 7, true, true, false, false)) return false;
  if (WindowsBackgroundObservationNodeAdmitted(7, 7, false, true, false, false)) return false;
  if (WindowsBackgroundObservationNodeAdmitted(7, 7, true, false, false, false)) return false;
  if (WindowsBackgroundObservationNodeAdmitted(7, 7, true, true, true, false)) return false;
  if (WindowsBackgroundObservationNodeAdmitted(7, 7, true, true, false, true)) return false;
  return true;
}
