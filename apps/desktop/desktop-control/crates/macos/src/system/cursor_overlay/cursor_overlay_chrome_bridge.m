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
// With no window named (a bare coordinate, the greeting), the windows sit above
// every window of the current Space, as before, but stay on the Space they were
// shown on and never join a full-screen app's Space. With one named, they sit
// at that window's height; `placement.rs` decides where from the on-screen
// window list read here (see `resolve`): directly above the named window, at
// its level and never higher, below every window in front of it. So the cursor
// is hidden where the user's window covers the worked-in window, and seen where
// it is seen. The named window's own sheets and popovers are separate windows
// in front of it, so the cursor is hidden under them too: keeping it off the
// user's windows, another window of the same app included, comes first. A named
// window that is not on the screen now (closed, minimized, its app hidden, on
// another Space), or that cannot be confirmed to be (the list cannot be read,
// the id is not a window number), hides them: they are held out of the screen
// and shown again above it once it is back. A named window never puts them at
// the front or the back of the current Space. Nothing here activates an app,
// raises or reorders another process's window, or makes an overlay window key:
// only the overlay's own windows are ordered, and only relative to the others.
// They are always stacked in the order of their rank, the effects lowest and
// the cursor and its label on top.
typedef enum {
    ADPlacementFree = 0,
    ADPlacementAbove = 1,
    ADPlacementGone = 2,
} ADPlacementKind;

// The records `placement.rs` reads (`ListedWindow`, `Placement`).
typedef struct {
    uint32_t number;
    int32_t pid;
    int64_t layer;
    double bounds[4];
    double alpha;
    uint8_t flags;
} ADListedWindow;

typedef struct {
    uint8_t kind;
    uint32_t target;
    int64_t level;
} ADPlacementAnswer;

_Static_assert(sizeof(ADListedWindow) == 64,
               "ADListedWindow must match ListedWindow in placement.rs");
_Static_assert(sizeof(ADPlacementAnswer) == 16,
               "ADPlacementAnswer must match Placement in placement.rs");

static const uint8_t ADListedHasPid = 1 << 0;
static const uint8_t ADListedHasLayer = 1 << 1;
static const uint8_t ADListedHasBounds = 1 << 2;
static const uint8_t ADListedOverlay = 1 << 3;
static const uint8_t ADListedOwn = 1 << 4;

extern void sc_cursor_overlay_resolve(const ADListedWindow *windows,
                                      size_t count,
                                      bool named,
                                      uint32_t number,
                                      ADPlacementAnswer *output);
extern bool sc_cursor_overlay_settled(const ADListedWindow *windows,
                                      size_t count,
                                      uint32_t target,
                                      const uint32_t *mine,
                                      size_t mineCount);

static bool ADAnchorNamed = false;
static CGWindowID ADAnchorNumber = 0;
// The overlay windows that are meant to be shown but are held off the screen
// while the named window is not on it, with their rank.
static __strong NSMapTable<NSWindow *, NSNumber *> *ADHeld = nil;
// The overlay windows shown at the named window's height, with their rank.
static __strong NSMapTable<NSWindow *, NSNumber *> *ADStacked = nil;
static ADPlacementKind ADPlacementState = ADPlacementFree;
static CGWindowID ADPlacementTarget = 0;
static NSWindowLevel ADPlacementLevel = NSNormalWindowLevel;
// The window list the placement was read from, for `ADPlacementSettled`.
static __strong NSData *ADListed = nil;

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

static bool ADIsOverlayProcess(NSDictionary *entry, bool hasPid, pid_t pid) {
    if (hasPid && pid == getpid()) {
        return true;
    }
    // Another agent's renderer is the same executable in another process.
    id name = entry[(__bridge NSString *)kCGWindowOwnerName];
    return [name isKindOfClass:NSString.class] &&
           [name isEqualToString:NSProcessInfo.processInfo.processName];
}

/// The on-screen window list, front to back, as `placement.rs` reads it; nil
/// when it cannot be read.
static NSData *ADReadWindows(void) {
    CFArrayRef raw = CGWindowListCopyWindowInfo(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
    if (raw == NULL) {
        return nil;
    }
    NSArray *windows = CFBridgingRelease(raw);
    NSMutableData *listed = [NSMutableData dataWithLength:windows.count * sizeof(ADListedWindow)];
    ADListedWindow *records = listed.mutableBytes;
    NSString *numberKey = (__bridge NSString *)kCGWindowNumber;
    NSString *ownerKey = (__bridge NSString *)kCGWindowOwnerPID;
    NSString *layerKey = (__bridge NSString *)kCGWindowLayer;
    NSString *alphaKey = (__bridge NSString *)kCGWindowAlpha;
    for (NSUInteger index = 0; index < windows.count; index += 1) {
        ADListedWindow *record = &records[index];
        record->alpha = 1.0;
        NSDictionary *entry = windows[index];
        if (![entry isKindOfClass:NSDictionary.class]) {
            continue;
        }
        long long value = 0;
        if (ADNumberOf(entry, numberKey, &value) && value > 0 && value <= UINT32_MAX) {
            record->number = (uint32_t)value;
        }
        bool hasPid = ADNumberOf(entry, ownerKey, &value) && value > 0 && value <= INT32_MAX;
        if (hasPid) {
            record->pid = (int32_t)value;
            record->flags |= ADListedHasPid;
        }
        if (ADNumberOf(entry, layerKey, &value)) {
            record->layer = (int64_t)value;
            record->flags |= ADListedHasLayer;
        }
        CGRect bounds = CGRectNull;
        if (ADBoundsOf(entry, &bounds)) {
            record->bounds[0] = bounds.origin.x;
            record->bounds[1] = bounds.origin.y;
            record->bounds[2] = bounds.size.width;
            record->bounds[3] = bounds.size.height;
            record->flags |= ADListedHasBounds;
        }
        if ([entry[alphaKey] isKindOfClass:NSNumber.class]) {
            record->alpha = [entry[alphaKey] doubleValue];
        }
        if (ADIsOverlayProcess(entry, hasPid, (pid_t)record->pid)) {
            record->flags |= ADListedOverlay;
        }
        if (hasPid && (pid_t)record->pid == getpid()) {
            record->flags |= ADListedOwn;
        }
    }
    return listed;
}

void ADResolvePlacement(void) {
    ADListed = nil;
    ADPlacementAnswer answer = {.kind = ADPlacementGone, .target = 0, .level = 0};
    NSData *listed = nil;
    if (ADAnchorNamed && ADAnchorNumber != 0) {
        listed = ADReadWindows();
    }
    // An unread list reaches `resolve` as an empty one, which hides a named
    // window's overlay.
    sc_cursor_overlay_resolve(listed.bytes,
                              listed.length / sizeof(ADListedWindow),
                              ADAnchorNamed,
                              ADAnchorNumber,
                              &answer);
    switch (answer.kind) {
    case ADPlacementFree:
        ADPlacementState = ADPlacementFree;
        return;
    case ADPlacementAbove:
        ADPlacementState = ADPlacementAbove;
        ADPlacementTarget = (CGWindowID)answer.target;
        ADPlacementLevel = (NSWindowLevel)answer.level;
        ADListed = listed;
        return;
    default:
        ADPlacementState = ADPlacementGone;
        return;
    }
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

bool ADPlacedAbove(void) {
    return ADPlacementState == ADPlacementAbove;
}

bool ADShown(NSWindow *window) {
    return window != nil && (window.isVisible || [ADHeld objectForKey:window] != nil);
}

void ADHide(NSWindow *window) {
    if (window == nil) {
        return;
    }
    [ADHeld removeObjectForKey:window];
    [ADStacked removeObjectForKey:window];
    [window orderOut:nil];
}

void ADForgetHeld(void) {
    [ADHeld removeAllObjects];
    [ADStacked removeAllObjects];
}

bool ADPlacementSettled(NSArray<NSWindow *> *visible) {
    if (ADPlacementState != ADPlacementAbove || ADListed == nil || ADHeld.count > 0) {
        return false;
    }
    NSMutableData *numbers = [NSMutableData dataWithLength:visible.count * sizeof(uint32_t)];
    uint32_t *mine = numbers.mutableBytes;
    for (NSUInteger index = 0; index < visible.count; index += 1) {
        NSWindow *window = visible[index];
        if (window.level != ADPlacementLevel || window.windowNumber <= 0) {
            return false;
        }
        mine[index] = (uint32_t)window.windowNumber;
    }
    return sc_cursor_overlay_settled(ADListed.bytes,
                                     ADListed.length / sizeof(ADListedWindow),
                                     (uint32_t)ADPlacementTarget,
                                     mine,
                                     visible.count);
}

/// Every overlay window shown at the named window's height, from the lowest
/// rank to the highest, each directly above the one before and the first
/// directly above the target. Whichever window is placed, and whatever placed
/// it (an action, a new named window, the periodic restack), the effects end
/// under the cursor and its label.
static void ADStack(void) {
    NSMutableArray<NSWindow *> *windows = [NSMutableArray array];
    for (int rank = ADRankHighlight; rank <= ADRankBubble; rank += 1) {
        for (NSWindow *window in ADStacked) {
            if ([[ADStacked objectForKey:window] intValue] == rank) {
                [windows addObject:window];
            }
        }
    }
    NSInteger below = (NSInteger)ADPlacementTarget;
    for (NSWindow *window in windows) {
        // Belongs to the Space it is shown on (the named window's, which is on
        // the screen now), never every Space, and is not an auxiliary of a
        // full-screen app's Space: on a Space switch it stays behind, and a
        // full-screen app the user works in never has it above. A named window
        // that is itself in full screen therefore gets no cursor (hidden).
        window.collectionBehavior = NSWindowCollectionBehaviorDefault;
        window.level = ADPlacementLevel;
        [window orderWindow:NSWindowAbove relativeTo:below];
        below = window.windowNumber;
    }
}

void ADPlace(NSWindow *window, NSWindowLevel freeLevel, ADRank rank) {
    if (window == nil) {
        return;
    }
    switch (ADPlacementState) {
    case ADPlacementFree:
        [ADHeld removeObjectForKey:window];
        [ADStacked removeObjectForKey:window];
        // The Space it is shown on only, and never a full-screen app's Space.
        window.collectionBehavior = NSWindowCollectionBehaviorDefault;
        window.level = freeLevel;
        [window orderFrontRegardless];
        return;
    case ADPlacementAbove:
        [ADHeld removeObjectForKey:window];
        if (ADStacked == nil) {
            ADStacked = [NSMapTable weakToStrongObjectsMapTable];
        }
        [ADStacked setObject:@(rank) forKey:window];
        ADStack();
        return;
    case ADPlacementGone:
        [ADStacked removeObjectForKey:window];
        if (ADHeld == nil) {
            ADHeld = [NSMapTable weakToStrongObjectsMapTable];
        }
        [ADHeld setObject:@(rank) forKey:window];
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
        ADPlace(ADTrailWindow, ADEffectLevel, ADRankTrail);
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
    // The Space it is shown on only, never every Space or a full-screen app's.
    window.collectionBehavior = NSWindowCollectionBehaviorDefault;
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
    ADPlace(window, ADEffectLevel, ADRankRipple);
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
    ADPlace(ADHighlightWindow, ADEffectLevel, ADRankHighlight);
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
    ADPlace(ADCaretWindow, ADEffectLevel, ADRankCaret);
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

void ADPlaceEffectsShown(void) {
    if (ADShown(ADHighlightWindow)) {
        ADPlace(ADHighlightWindow, ADEffectLevel, ADRankHighlight);
    }
    if (ADShown(ADTrailWindow)) {
        ADPlace(ADTrailWindow, ADEffectLevel, ADRankTrail);
    }
    if (ADShown(ADCaretWindow)) {
        ADPlace(ADCaretWindow, ADEffectLevel, ADRankCaret);
    }
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
    ADPlace(bubble, ADCursorLevel, ADRankBubble);
}
