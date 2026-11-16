// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
#import "cursor_overlay_chrome.h"
#import <unistd.h>

const CGFloat ADRippleSize = 108.0;
const NSWindowLevel ADCursorLevel = NSPopUpMenuWindowLevel + 2;
const NSWindowLevel ADEffectLevel = NSPopUpMenuWindowLevel + 1;
static const NSUInteger ADRippleRings = 2;
// Room around the highlight for its glow and the pop it starts with, both of
// which draw outside the outline and would be clipped at the window's edge.
static const CGFloat ADHighlightBleed = 24.0;

static AgentDesktopCursorStyle ADCurrentStyle = {
    .fill = {1.0, 1.0, 1.0},
    .rim = {0.07, 0.07, 0.09},
    .accent = {0.26, 0.60, 1.0},
    .size = 1.0,
};

static __strong NSWindow *ADHighlightWindow = nil;
static __strong CALayer *ADHighlightBorder = nil;
static __strong NSWindow *ADTrailWindow = nil;
static __strong CAShapeLayer *ADTrailLayer = nil;
static CGMutablePathRef ADTrailPath = NULL;
static NSRect ADTrailDesktop = {{0.0, 0.0}, {0.0, 0.0}};
static NSPoint ADTrailLast = {0.0, 0.0};
static NSUInteger ADTrailPointCount = 0;

// Where the overlay's windows go in the stacking order (Sprint Coder).
//
// With no window named (a bare coordinate, the greeting), the windows sit
// above every window, as before. With one named, they sit at that window's
// height: directly above the window and the windows of its own process just
// above it (its menus and popups), below the first window of any other process
// that covers them. So the cursor is hidden where the user's window covers the
// worked-in window, and seen where it is seen. A named window that is not on
// the screen now (closed, minimized, its app hidden, on another Space), or that
// cannot be confirmed to be (the list cannot be read, the id is not a window
// number), hides them: they are held out of the screen and shown again above it
// once it is back. A named window never puts them at the front or the back of
// the current Space. Nothing here activates an app, raises or reorders another
// process's window, or makes an overlay window key: only the overlay's own
// windows are ordered, and only relative to the others.
typedef enum {
    ADPlacementFree = 0,
    ADPlacementAbove,
    ADPlacementGone,
} ADPlacementKind;

static bool ADAnchorNamed = false;
static CGWindowID ADAnchorNumber = 0;
// The overlay windows that are meant to be shown but are held off the screen
// while the named window is not on it, with whether each is of the cursor band.
static __strong NSMapTable<NSWindow *, NSNumber *> *ADHeld = nil;
static ADPlacementKind ADPlacementState = ADPlacementFree;
static CGWindowID ADPlacementTarget = 0;
static NSWindowLevel ADPlacementLevel = NSNormalWindowLevel;
static CGWindowID ADPlacementTop = 0;
static __strong NSSet<NSNumber *> *ADPlacementOurs = nil;

static bool ADNumberOf(NSDictionary *entry, NSString *key, long long *value) {
    id number = entry[key];
    if (![number isKindOfClass:NSNumber.class]) {
        return false;
    }
    *value = [number longLongValue];
    return true;
}

static bool ADBoundsOf(NSDictionary *entry, CGRect *bounds) {
    id dictionary = entry[(__bridge NSString *)kCGWindowBounds];
    return [dictionary isKindOfClass:NSDictionary.class] &&
           CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)dictionary, bounds);
}

static bool ADIsOverlayProcess(NSDictionary *entry, pid_t pid) {
    if (pid == getpid()) {
        return true;
    }
    // Another agent's renderer is the same executable in another process.
    id name = entry[(__bridge NSString *)kCGWindowOwnerName];
    return [name isKindOfClass:NSString.class] &&
           [name isEqualToString:NSProcessInfo.processInfo.processName];
}

void ADResolvePlacement(void) {
    ADPlacementOurs = nil;
    if (!ADAnchorNamed) {
        ADPlacementState = ADPlacementFree;
        return;
    }
    // Hidden unless the named window is found on the screen now.
    ADPlacementState = ADPlacementGone;
    if (ADAnchorNumber == 0) {
        return;
    }
    CFArrayRef raw = CGWindowListCopyWindowInfo(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
    if (raw == NULL) {
        return;
    }
    NSArray *windows = CFBridgingRelease(raw);
    NSString *numberKey = (__bridge NSString *)kCGWindowNumber;
    NSString *ownerKey = (__bridge NSString *)kCGWindowOwnerPID;
    NSString *layerKey = (__bridge NSString *)kCGWindowLayer;
    NSString *alphaKey = (__bridge NSString *)kCGWindowAlpha;
    NSInteger anchorIndex = NSNotFound;
    for (NSUInteger index = 0; index < windows.count; index += 1) {
        long long number = 0;
        if ([windows[index] isKindOfClass:NSDictionary.class] &&
            ADNumberOf(windows[index], numberKey, &number) && number == ADAnchorNumber) {
            anchorIndex = (NSInteger)index;
            break;
        }
    }
    if (anchorIndex == NSNotFound) {
        return;
    }
    NSDictionary *anchor = windows[(NSUInteger)anchorIndex];
    long long anchorPid = 0;
    long long layer = 0;
    CGRect covered = CGRectNull;
    if (!ADNumberOf(anchor, ownerKey, &anchorPid) || !ADNumberOf(anchor, layerKey, &layer) ||
        !ADBoundsOf(anchor, &covered)) {
        return;
    }
    const long long anchorLayer = layer;
    const CGRect anchorBounds = covered;
    // The list runs front to back: walk toward the front from the anchor.
    NSInteger topIndex = anchorIndex;
    for (NSInteger index = anchorIndex - 1; index >= 0; index -= 1) {
        NSDictionary *entry = windows[(NSUInteger)index];
        if (![entry isKindOfClass:NSDictionary.class]) {
            continue;
        }
        long long pid = 0;
        double alphaValue = [entry[alphaKey] isKindOfClass:NSNumber.class]
                                ? [entry[alphaKey] doubleValue]
                                : 1.0;
        CGRect bounds = CGRectNull;
        if (!ADNumberOf(entry, ownerKey, &pid) || !ADBoundsOf(entry, &bounds)) {
            continue;
        }
        if (ADIsOverlayProcess(entry, (pid_t)pid) || alphaValue <= 0.0) {
            continue;
        }
        long long entryLayer = 0;
        // The named window's own menus, popups and panels (a higher level), and
        // its sheets and popovers (inside its frame). Another document window
        // of the same app at the same level covers it like any other window.
        if (pid == anchorPid && ADNumberOf(entry, layerKey, &entryLayer) &&
            (entryLayer > anchorLayer ||
             CGRectContainsRect(CGRectInset(anchorBounds, -1.0, -1.0), bounds))) {
            topIndex = index;
            layer = entryLayer;
            covered = CGRectUnion(covered, bounds);
            continue;
        }
        if (CGRectIntersectsRect(bounds, covered)) {
            break;
        }
    }
    long long top = 0;
    if (!ADNumberOf(windows[(NSUInteger)topIndex], numberKey, &top)) {
        return;
    }
    NSMutableSet<NSNumber *> *ours = [NSMutableSet set];
    for (NSInteger index = topIndex - 1; index >= 0; index -= 1) {
        NSDictionary *entry = windows[(NSUInteger)index];
        long long pid = 0;
        long long number = 0;
        if (![entry isKindOfClass:NSDictionary.class] || !ADNumberOf(entry, ownerKey, &pid) ||
            pid != getpid() || !ADNumberOf(entry, numberKey, &number)) {
            break;
        }
        [ours addObject:@(number)];
    }
    ADPlacementState = ADPlacementAbove;
    ADPlacementTarget = (CGWindowID)top;
    ADPlacementLevel = (NSWindowLevel)layer;
    ADPlacementTop = (CGWindowID)top;
    ADPlacementOurs = ours;
}

bool ADSetAnchor(bool named, uint32_t number) {
    bool changed = ADAnchorNamed != named || ADAnchorNumber != number;
    ADAnchorNamed = named;
    ADAnchorNumber = named ? number : 0;
    ADResolvePlacement();
    return changed;
}

bool ADAnchored(void) {
    return ADAnchorNamed;
}

bool ADPlacementHidden(void) {
    return ADPlacementState == ADPlacementGone;
}

bool ADShown(NSWindow *window) {
    return window != nil && (window.isVisible || [ADHeld objectForKey:window] != nil);
}

void ADHide(NSWindow *window) {
    if (window == nil) {
        return;
    }
    [ADHeld removeObjectForKey:window];
    [window orderOut:nil];
}

void ADForgetHeld(void) {
    [ADHeld removeAllObjects];
}

bool ADPlacementSettled(NSArray<NSWindow *> *visible) {
    if (ADPlacementState != ADPlacementAbove || ADPlacementOurs == nil ||
        ADHeld.count > 0) {
        return false;
    }
    NSMutableSet<NSNumber *> *numbers = [NSMutableSet set];
    for (NSWindow *window in visible) {
        if (window.level != ADPlacementLevel) {
            return false;
        }
        [numbers addObject:@(window.windowNumber)];
    }
    return [numbers isEqualToSet:ADPlacementOurs];
}

void ADPlace(NSWindow *window, NSWindowLevel freeLevel, bool cursorBand) {
    if (window == nil) {
        return;
    }
    if (ADPlacementState != ADPlacementGone) {
        [ADHeld removeObjectForKey:window];
    }
    switch (ADPlacementState) {
    case ADPlacementFree:
        window.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces |
                                    NSWindowCollectionBehaviorFullScreenAuxiliary;
        window.level = freeLevel;
        [window orderFrontRegardless];
        return;
    case ADPlacementAbove:
        // Belongs to the Space it is shown on (the named window's, which is on
        // the screen now), never every Space, and is not an auxiliary of a
        // full-screen app's Space: on a Space switch it stays behind, and a
        // full-screen app the user works in never has it above. A named window
        // that is itself in full screen therefore gets no cursor (hidden).
        window.collectionBehavior = NSWindowCollectionBehaviorDefault;
        window.level = ADPlacementLevel;
        // Effects go directly above the named window; the cursor and its label
        // above every overlay window already placed, as their levels did.
        CGWindowID below = cursorBand && ADPlacementTop != (CGWindowID)window.windowNumber
                               ? ADPlacementTop
                               : ADPlacementTarget;
        [window orderWindow:NSWindowAbove relativeTo:(NSInteger)below];
        if (cursorBand) {
            ADPlacementTop = (CGWindowID)window.windowNumber;
        }
        return;
    case ADPlacementGone:
        if (ADHeld == nil) {
            ADHeld = [NSMapTable weakToStrongObjectsMapTable];
        }
        [ADHeld setObject:@(cursorBand) forKey:window];
        [window orderOut:nil];
        return;
    }
}

static void ADTrailRender(void) {
    CGRect bounds = CGPathGetBoundingBox(ADTrailPath);
    NSRect frame = NSIntersectionRect(NSInsetRect(bounds, -10.0, -10.0),
                                      NSInsetRect(ADTrailDesktop, -10.0, -10.0));
    if (NSIsEmptyRect(frame)) {
        return;
    }
    if (ADTrailWindow == nil) {
        ADTrailWindow = ADWindow(frame);
        ADTrailWindow.level = ADEffectLevel;
        ADTrailLayer = [CAShapeLayer layer];
        ADTrailLayer.fillColor = ADColor(ADCurrentStyle.accent, 0.9);
        ADTrailLayer.strokeColor = ADColor(ADCurrentStyle.accent, 0.9);
        ADTrailLayer.lineWidth = 4.0;
        ADTrailLayer.lineCap = kCALineCapRound;
        ADTrailLayer.lineJoin = kCALineJoinRound;
        ADTrailLayer.shadowColor = ADColor(ADCurrentStyle.accent, 1.0);
        ADTrailLayer.shadowOpacity = 0.45;
        ADTrailLayer.shadowRadius = 6.0;
        ADFreezeLayer(ADTrailLayer);
        [ADTrailWindow.contentView.layer addSublayer:ADTrailLayer];
    } else {
        [ADTrailWindow setFrame:frame display:NO];
    }
    ADTrailLayer.frame = ADTrailWindow.contentView.bounds;
    CGAffineTransform translation = CGAffineTransformMakeTranslation(-frame.origin.x,
                                                                      -frame.origin.y);
    CGPathRef localPath = CGPathCreateCopyByTransformingPath(ADTrailPath, &translation);
    ADTrailLayer.path = localPath;
    CGPathRelease(localPath);
    if (!ADTrailWindow.isVisible) {
        ADPlace(ADTrailWindow, ADEffectLevel, false);
    }
}

CGColorRef ADColor(const double *rgb, CGFloat alpha) {
    return [NSColor colorWithSRGBRed:rgb[0] green:rgb[1] blue:rgb[2] alpha:alpha].CGColor;
}

const AgentDesktopCursorStyle *ADStyle(void) {
    return &ADCurrentStyle;
}

void agent_desktop_cursor_overlay_style(const AgentDesktopCursorStyle *style) {
    if (style != NULL) {
        ADCurrentStyle = *style;
    }
}

void ADFreezeLayer(CALayer *layer) {
    layer.actions = @{
        @"transform" : NSNull.null,
        @"opacity" : NSNull.null,
        @"position" : NSNull.null,
        @"bounds" : NSNull.null,
        @"hidden" : NSNull.null,
    };
}

NSWindow *ADWindow(NSRect frame) {
    NSWindow *window = [[NSWindow alloc]
        initWithContentRect:frame
                  styleMask:NSWindowStyleMaskBorderless
                    backing:NSBackingStoreBuffered
                      defer:NO];
    window.opaque = NO;
    window.backgroundColor = NSColor.clearColor;
    window.hasShadow = NO;
    window.ignoresMouseEvents = YES;
    window.releasedWhenClosed = NO;
    window.hidesOnDeactivate = NO;
    window.level = ADCursorLevel;
    window.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces |
                                NSWindowCollectionBehaviorFullScreenAuxiliary;
    NSView *view = [[NSView alloc]
        initWithFrame:NSMakeRect(0.0, 0.0, frame.size.width, frame.size.height)];
    view.wantsLayer = YES;
    window.contentView = view;
    ADFreezeLayer(view.layer);
    return window;
}

void ADPump(NSApplication *app) {
    [app updateWindows];
    [[NSRunLoop currentRunLoop]
        runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.0005]];
}

static CAShapeLayer *ADRing(CGFloat radius, BOOL filled) {
    CAShapeLayer *layer = [CAShapeLayer layer];
    layer.bounds = CGRectMake(0.0, 0.0, ADRippleSize, ADRippleSize);
    layer.position = CGPointMake(ADRippleSize * 0.5, ADRippleSize * 0.5);
    CGPathRef path = CGPathCreateWithEllipseInRect(
        CGRectMake(ADRippleSize * 0.5 - radius,
                   ADRippleSize * 0.5 - radius,
                   radius * 2.0,
                   radius * 2.0),
        NULL);
    layer.path = path;
    CGPathRelease(path);
    layer.fillColor = NSColor.clearColor.CGColor;
    layer.strokeColor = NSColor.clearColor.CGColor;
    layer.opacity = 0.0;
    layer.shouldRasterize = NO;
    if (filled) {
        layer.shadowOffset = CGSizeZero;
        layer.shadowRadius = 14.0;
    }
    ADFreezeLayer(layer);
    return layer;
}

NSWindow *ADRippleWindow(void) {
    NSWindow *window = ADWindow(NSMakeRect(0.0, 0.0, ADRippleSize, ADRippleSize));
    window.level = ADEffectLevel;
    [window.contentView.layer addSublayer:ADRing(19.0, YES)];
    for (NSUInteger index = 0; index < ADRippleRings; index += 1) {
        [window.contentView.layer addSublayer:ADRing(ADRippleSize * 0.5 - 4.0, NO)];
    }
    return window;
}

void ADRipplePlay(NSWindow *window) {
    NSArray<CALayer *> *layers = window.contentView.layer.sublayers;
    ADPlace(window, ADEffectLevel, false);
    for (NSUInteger index = 0; index < layers.count; index += 1) {
        CAShapeLayer *layer = (CAShapeLayer *)layers[index];
        [layer removeAllAnimations];
        layer.fillColor = index == 0 ? ADColor(ADCurrentStyle.accent, 1.0)
                                     : NSColor.clearColor.CGColor;
        layer.strokeColor = ADColor(ADCurrentStyle.accent, 1.0);
        CAKeyframeAnimation *opacity =
            [CAKeyframeAnimation animationWithKeyPath:@"opacity"];
        opacity.values = index == 0 ? @[ @0.0, @0.42, @0.0 ] : @[ @0.0, @0.9, @0.0 ];
        opacity.keyTimes = @[ @0.0, @0.18, @1.0 ];
        CABasicAnimation *spread =
            [CABasicAnimation animationWithKeyPath:@"transform.scale"];
        spread.fromValue = index == 0 ? @0.22 : @0.04;
        spread.toValue = index == 0 ? @1.12 : @1.0;
        CAAnimationGroup *effect = [CAAnimationGroup animation];
        effect.animations = @[ opacity, spread ];
        effect.duration = 0.3;
        effect.timingFunction =
            [CAMediaTimingFunction functionWithName:kCAMediaTimingFunctionEaseOut];
        [layer addAnimation:effect forKey:@"agent-ripple"];
    }
}

static CAKeyframeAnimation *ADHold(NSString *path,
                                   NSArray *values,
                                   NSArray *times,
                                   double seconds) {
    CAKeyframeAnimation *animation = [CAKeyframeAnimation animationWithKeyPath:path];
    animation.values = values;
    animation.keyTimes = times;
    animation.duration = seconds;
    animation.removedOnCompletion = NO;
    animation.fillMode = kCAFillModeForwards;
    animation.timingFunction =
        [CAMediaTimingFunction functionWithName:kCAMediaTimingFunctionEaseInEaseOut];
    return animation;
}

void ADHighlightShow(NSRect frame, double seconds) {
    if (ADHighlightWindow == nil) {
        ADHighlightWindow = ADWindow(frame);
        ADHighlightWindow.level = ADEffectLevel;
        ADHighlightBorder = [CALayer layer];
        ADHighlightBorder.borderWidth = 2.5;
        ADHighlightBorder.cornerRadius = 8.0;
        ADHighlightBorder.opacity = 0.0;
        ADFreezeLayer(ADHighlightBorder);
        [ADHighlightWindow.contentView.layer addSublayer:ADHighlightBorder];
    }
    ADHighlightBorder.borderColor = ADColor(ADCurrentStyle.accent, 1.0);
    ADHighlightBorder.backgroundColor = ADColor(ADCurrentStyle.accent, 0.10);
    ADHighlightBorder.shadowColor = ADColor(ADCurrentStyle.accent, 1.0);
    ADHighlightBorder.shadowOpacity = 0.5;
    ADHighlightBorder.shadowRadius = 10.0;
    ADHighlightBorder.shadowOffset = CGSizeZero;
    [ADHighlightWindow setFrame:NSInsetRect(frame, -ADHighlightBleed, -ADHighlightBleed)
                        display:NO];
    ADHighlightBorder.frame =
        CGRectMake(ADHighlightBleed, ADHighlightBleed, frame.size.width, frame.size.height);
    [ADHighlightBorder removeAllAnimations];
    [ADHighlightBorder addAnimation:ADHold(@"opacity",
                                           @[ @0.0, @1.0, @1.0, @0.0 ],
                                           @[ @0.0, @0.04, @0.55, @1.0 ],
                                           seconds)
                             forKey:@"agent-highlight-fade"];
    [ADHighlightBorder addAnimation:ADHold(@"transform.scale",
                                           @[ @1.08, @0.99, @1.0, @1.0 ],
                                           @[ @0.0, @0.12, @0.22, @1.0 ],
                                           seconds)
                             forKey:@"agent-highlight-pop"];
    ADPlace(ADHighlightWindow, ADEffectLevel, false);
}

static __strong NSWindow *ADCaretWindow = nil;
static __strong CALayer *ADCaretBar = nil;

void ADCaretShow(NSRect frame) {
    if (ADCaretWindow == nil) {
        ADCaretWindow = ADWindow(frame);
        ADCaretWindow.level = ADEffectLevel;
        ADCaretBar = [CALayer layer];
        ADCaretBar.cornerRadius = 1.0;
        ADFreezeLayer(ADCaretBar);
        [ADCaretWindow.contentView.layer addSublayer:ADCaretBar];
    }
    ADCaretBar.backgroundColor = ADColor(ADCurrentStyle.accent, 1.0);
    [ADCaretWindow setFrame:frame display:NO];
    ADCaretBar.frame = CGRectMake(0.0, 0.0, frame.size.width, frame.size.height);
    ADPlace(ADCaretWindow, ADEffectLevel, false);
    [CATransaction flush];
}

bool ADCaretShowing(void) {
    return ADShown(ADCaretWindow);
}

void ADCaretStop(void) {
    ADHide(ADCaretWindow);
    ADCaretWindow = nil;
    ADCaretBar = nil;
}

NSArray<NSWindow *> *ADEffectWindowsShown(void) {
    NSMutableArray<NSWindow *> *shown = [NSMutableArray array];
    for (NSWindow *window in @[ ADHighlightWindow ?: NSNull.null, ADTrailWindow ?: NSNull.null,
                                ADCaretWindow ?: NSNull.null ]) {
        if ([window isKindOfClass:NSWindow.class] && ADShown(window)) {
            [shown addObject:window];
        }
    }
    return shown;
}

void ADHighlightStop(void) {
    [ADHighlightBorder removeAllAnimations];
    ADHide(ADHighlightWindow);
    ADHighlightWindow = nil;
    ADHighlightBorder = nil;
}

static void ADTrailBeginInFrame(NSPoint point, NSRect desktop) {
    ADTrailStop();
    ADTrailDesktop = desktop;
    if (NSEqualRects(ADTrailDesktop, NSZeroRect)) {
        return;
    }
    ADTrailPath = CGPathCreateMutable();
    ADTrailLast = point;
    ADTrailPointCount = 1;
    CGPathAddEllipseInRect(ADTrailPath, NULL, CGRectMake(point.x - 4.0, point.y - 4.0, 8.0, 8.0));
    ADTrailRender();
}

void ADTrailBegin(NSPoint point) {
    NSRect desktop = NSZeroRect;
    for (NSScreen *screen in NSScreen.screens) {
        desktop = NSEqualRects(desktop, NSZeroRect) ? screen.frame
                                                     : NSUnionRect(desktop, screen.frame);
    }
    ADTrailBeginInFrame(point, desktop);
}

void ADTrailAppend(NSPoint point) {
    if (ADTrailPath == NULL || hypot(point.x - ADTrailLast.x, point.y - ADTrailLast.y) < 2.0) {
        return;
    }
    if (ADTrailPointCount >= 4096) {
        ADTrailLast = point;
        return;
    }
    CGPathMoveToPoint(ADTrailPath, NULL, ADTrailLast.x, ADTrailLast.y);
    CGPathAddLineToPoint(ADTrailPath, NULL, point.x, point.y);
    ADTrailLast = point;
    ADTrailPointCount += 1;
    ADTrailRender();
}

void ADTrailFinish(double seconds) {
    if (ADTrailLayer == nil) {
        return;
    }
    CGPathAddEllipseInRect(ADTrailPath,
                           NULL,
                           CGRectMake(ADTrailLast.x - 4.0, ADTrailLast.y - 4.0, 8.0, 8.0));
    ADTrailRender();
    [ADTrailLayer removeAllAnimations];
    [ADTrailLayer addAnimation:ADHold(@"opacity",
                                      @[ @1.0, @1.0, @0.0 ],
                                      @[ @0.0, @0.55, @1.0 ],
                                      seconds)
                            forKey:@"agent-drag-trail-fade"];
}

void ADTrailStop(void) {
    [ADTrailLayer removeAllAnimations];
    ADHide(ADTrailWindow);
    ADTrailLayer = nil;
    ADTrailWindow = nil;
    if (ADTrailPath != NULL) {
        CGPathRelease(ADTrailPath);
        ADTrailPath = NULL;
    }
    ADTrailDesktop = NSZeroRect;
    ADTrailPointCount = 0;
}

void ADShowBubble(NSTextField *text, NSRect frame, bool changed) {
    NSWindow *bubble = text.window;
    CALayer *surface = bubble.contentView.layer;
    bubble.alphaValue = 1.0;
    text.alphaValue = 1.0;
    [bubble setFrame:frame display:NO];
    if (changed) {
        [surface removeAllAnimations];
        CABasicAnimation *fade = [CABasicAnimation animationWithKeyPath:@"opacity"];
        fade.fromValue = @0.0;
        fade.toValue = @1.0;
        fade.duration = 0.18;
        CABasicAnimation *pop = [CABasicAnimation animationWithKeyPath:@"transform.scale"];
        pop.fromValue = @0.94;
        pop.toValue = @1.0;
        pop.duration = 0.18;
        pop.timingFunction =
            [CAMediaTimingFunction functionWithName:kCAMediaTimingFunctionEaseOut];
        [surface addAnimation:fade forKey:@"agent-bubble-fade"];
        [surface addAnimation:pop forKey:@"agent-bubble-pop"];
    }
    ADPlace(bubble, ADCursorLevel, true);
}
