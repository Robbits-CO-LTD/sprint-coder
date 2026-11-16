// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
#pragma once

#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>

extern const CGFloat ADRippleSize;
extern const NSWindowLevel ADCursorLevel;
extern const NSWindowLevel ADEffectLevel;

/// Names the window the cursor is drawn at the height of (`named` false for
/// none; named with number 0 for one whose number could not be read, which
/// hides the overlay) and reads where that puts the overlay; true when the
/// named window changed.
bool ADSetAnchor(bool named, uint32_t number);
bool ADAnchored(void);
/// Whether the named window is not on the screen now, so the overlay is held off it.
bool ADPlacementHidden(void);
/// On the screen, or held off it only while the named window is not.
bool ADShown(NSWindow *window);
/// Takes `window` off the screen for good (not held to come back).
void ADHide(NSWindow *window);
void ADForgetHeld(void);
/// Reads again where the named window puts the overlay.
void ADResolvePlacement(void);
/// Whether every window in `visible` already sits where the placement wants it.
bool ADPlacementSettled(NSArray<NSWindow *> *visible);
/// Shows `window` where the placement wants it: at `freeLevel` above every window
/// when none is named, at the named window's height otherwise. `cursorBand`
/// windows (the cursor and its label) go above the effects.
void ADPlace(NSWindow *window, NSWindowLevel freeLevel, bool cursorBand);
NSArray<NSWindow *> *ADEffectWindowsShown(void);

typedef struct {
    double fill[3];
    double rim[3];
    double accent[3];
    double size;
} AgentDesktopCursorStyle;

CGColorRef ADColor(const double *rgb, CGFloat alpha);
const AgentDesktopCursorStyle *ADStyle(void);

NSWindow *ADWindow(NSRect frame);
void ADPump(NSApplication *app);
void ADFreezeLayer(CALayer *layer);
NSWindow *ADRippleWindow(void);
void ADRipplePlay(NSWindow *window);
void ADHighlightShow(NSRect frame, double seconds);
void ADHighlightStop(void);
void ADCaretShow(NSRect frame);
void ADCaretStop(void);
bool ADCaretShowing(void);
void ADTrailBegin(NSPoint point);
void ADTrailAppend(NSPoint point);
void ADTrailFinish(double seconds);
void ADTrailStop(void);
void ADShowBubble(NSTextField *text, NSRect frame, bool changed);
void ADPointerImageApply(NSWindow *window, CALayer *pointer);
void ADPointerImageSelect(NSWindow *window, CALayer *pointer, bool pointing);
void ADPointerImageRelease(NSWindow *window, CALayer *pointer, double seconds);
