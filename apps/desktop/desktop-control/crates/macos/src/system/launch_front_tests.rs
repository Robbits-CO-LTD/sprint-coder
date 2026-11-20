// Changed by Sprint Coder (new file); see VENDORED.md in apps/desktop/desktop-control.
use super::*;
use agent_desktop_core::{DeliverySemantics, ErrorCode, ProcessId};
use std::cell::RefCell;

const CHROME: i32 = 10;
const CHROME_INSTANCE: &str = "macos-proc-v1:10:1";

fn candidate() -> HandoffCandidate {
    HandoffCandidate {
        pid: CHROME,
        process_instance: CHROME_INSTANCE.into(),
        windows_before: vec![100, 101],
    }
}

fn app(pid: i32) -> FrontApp {
    FrontApp {
        pid,
        instance: Some(format!("macos-proc-v1:{pid}:1")),
    }
}

fn chrome() -> FrontApp {
    app(CHROME)
}

/// Sprint Coder, whose approval card was just pressed; Discord and Claude, other apps.
const SPRINT_CODER: i32 = 1;
const DISCORD: i32 = 2;
const CLAUDE: i32 = 3;

fn window(number: i64) -> WindowInfo {
    WindowInfo {
        id: format!("w-{number}"),
        title: String::new(),
        app: "Google Chrome".into(),
        pid: ProcessId::new(CHROME as u32),
        process_instance: Some(CHROME_INSTANCE.into()),
        bounds: None,
        state: Default::default(),
    }
}

fn front(pid: i32) -> FrontSeen {
    FrontSeen {
        app: Some(app(pid)),
        ..Default::default()
    }
}

fn chrome_on(number: i64, new_window: bool) -> FrontSeen {
    FrontSeen {
        app: Some(chrome()),
        focus: Some(window(number)),
        new_window,
    }
}

fn ms(base: Instant, millis: u64) -> Instant {
    base + Duration::from_millis(millis)
}

/// A watch started at `t0` with `before` in front, and a record of every giving back asked.
struct Run {
    t0: Instant,
    watch: FrontWatch,
    restores: RefCell<Vec<String>>,
    answer: Restored,
    /// What the window order says (`behind`), and how often it was asked.
    behind: Option<bool>,
    behind_asked: RefCell<usize>,
}

impl Run {
    fn new(before: FrontSeen) -> Self {
        let t0 = Instant::now();
        Self {
            t0,
            watch: FrontWatch::begin(vec![candidate()], before),
            restores: RefCell::new(Vec::new()),
            answer: Restored::Back,
            behind: Some(true),
            behind_asked: RefCell::new(0),
        }
    }

    fn look(&mut self, at: u64, seen: FrontSeen, input: Input) {
        let now = ms(self.t0, at);
        let restores = &self.restores;
        let answer = self.answer;
        let (behind, asked) = (self.behind, &self.behind_asked);
        self.watch.look(
            seen,
            now,
            || input,
            |_| {
                *asked.borrow_mut() += 1;
                behind
            },
            |target| {
                restores.borrow_mut().push(describe(target));
                answer
            },
        );
    }

    fn finish(&mut self, at: u64, input: Input) -> Option<FrontOutcome> {
        let now = ms(self.t0, at);
        let restores = &self.restores;
        let answer = self.answer;
        let (behind, asked) = (self.behind, &self.behind_asked);
        self.watch.finish(
            now,
            || input,
            |_| {
                *asked.borrow_mut() += 1;
                behind
            },
            |target| {
                restores.borrow_mut().push(describe(target));
                answer
            },
        )
    }

    fn restores(&self) -> Vec<String> {
        self.restores.borrow().clone()
    }
}

fn describe(target: &Target) -> String {
    match target {
        Target::App(app) => format!("app {}", app.pid),
        Target::Window(window) => format!("window {}", window.id),
    }
}

#[test]
fn an_app_take_is_given_back_to_the_app_in_front_just_before_it() {
    // Sprint Coder in front when the launch began; the user switched to Discord before Chrome
    // took the front (the measured case): Discord gets it back, not Sprint Coder.
    let mut run = Run::new(front(SPRINT_CODER));
    run.look(20, front(CLAUDE), Input::None);
    run.look(40, front(DISCORD), Input::None);
    run.look(60, chrome_on(102, true), Input::None);
    assert_eq!(run.restores(), ["app 2"]);
    assert_eq!(
        run.finish(400, Input::None),
        Some(FrontOutcome::Restored(TakeKind::App))
    );

    // The ordinary case: Sprint Coder gets the front back.
    let mut run = Run::new(front(SPRINT_CODER));
    run.look(60, chrome_on(102, true), Input::None);
    assert_eq!(run.restores(), ["app 1"]);
}

#[test]
fn a_window_take_is_given_back_to_the_window_focused_just_before_it() {
    let mut run = Run::new(chrome_on(100, false));
    run.look(20, chrome_on(100, false), Input::None);
    run.look(300, chrome_on(102, true), Input::None);
    assert_eq!(run.restores(), ["window w-100"]);
    assert_eq!(
        run.finish(700, Input::None),
        Some(FrontOutcome::Restored(TakeKind::Window))
    );

    // The user moved to another window Chrome already had: that is the one given back.
    let mut run = Run::new(chrome_on(100, false));
    run.look(20, chrome_on(101, false), Input::None);
    assert!(run.restores().is_empty());
    run.look(300, chrome_on(102, true), Input::None);
    assert_eq!(run.restores(), ["window w-101"]);
}

#[test]
fn without_input_a_take_is_given_back_whenever_it_is_seen() {
    let mut run = Run::new(front(SPRINT_CODER));
    run.look(
        20,
        FrontSeen {
            new_window: true,
            ..front(SPRINT_CODER)
        },
        Input::None,
    );
    // Long after the window was first seen.
    run.look(2_500, chrome_on(102, true), Input::None);
    assert_eq!(run.restores(), ["app 1"]);

    // And when no new window was ever seen.
    let mut run = Run::new(front(SPRINT_CODER));
    run.look(60, front(CHROME), Input::None);
    assert_eq!(run.restores(), ["app 1"]);
    // Without input the window order is not read at all.
    assert_eq!(*run.behind_asked.borrow(), 0);
}

#[test]
fn with_input_only_a_take_with_the_window_is_given_back() {
    // Input before the front to give back was read, the take with the window: given back.
    let mut run = Run::new(front(SPRINT_CODER));
    run.look(20, front(SPRINT_CODER), Input::None);
    let early = Input::At(ms(run.t0, 10));
    run.look(60, chrome_on(102, true), early);
    assert_eq!(run.restores(), ["app 1"]);

    // The window first seen 400 ms before the take: left as the user's.
    let mut run = Run::new(front(SPRINT_CODER));
    run.look(
        20,
        FrontSeen {
            new_window: true,
            ..front(SPRINT_CODER)
        },
        Input::None,
    );
    run.look(400, front(SPRINT_CODER), Input::None);
    let early = Input::At(ms(run.t0, 10));
    run.look(420, front(CHROME), early);
    assert!(run.restores().is_empty());
    assert_eq!(
        run.finish(800, early),
        Some(FrontOutcome::Left(TakeKind::App, LeftWhy::Input))
    );

    // Exactly the grace apart still counts as with the window.
    let mut run = Run::new(front(SPRINT_CODER));
    run.look(
        20,
        FrontSeen {
            new_window: true,
            ..front(SPRINT_CODER)
        },
        Input::None,
    );
    run.look(300, front(SPRINT_CODER), Input::None);
    run.look(320, front(CHROME), Input::At(ms(run.t0, 10)));
    assert_eq!(run.restores(), ["app 1"]);
}

#[test]
fn with_input_only_what_is_still_right_behind_the_taker_is_given_the_front_back() {
    // The measured case with input: the last look (40 ms) read Claude, the user switched to
    // Discord (50 ms) and Chrome took the front (57 ms). The window order shows Discord behind
    // Chrome, not Claude: Claude is not given the front, and the take is left.
    let mut run = Run::new(front(SPRINT_CODER));
    run.behind = Some(false);
    run.look(40, front(CLAUDE), Input::None);
    run.look(60, chrome_on(102, true), Input::At(ms(run.t0, 50)));
    assert!(run.restores().is_empty());
    assert_eq!(*run.behind_asked.borrow(), 1);
    assert_eq!(
        run.finish(400, Input::At(ms(run.t0, 50))),
        Some(FrontOutcome::Left(TakeKind::App, LeftWhy::Input))
    );

    // An order that cannot be read leaves the take too.
    let mut run = Run::new(front(SPRINT_CODER));
    run.behind = None;
    run.look(60, chrome_on(102, true), Input::At(ms(run.t0, 50)));
    assert!(run.restores().is_empty());

    // Input going on until the take (the mouse moving), the app read last still right behind:
    // given back.
    let mut run = Run::new(front(SPRINT_CODER));
    run.look(40, front(CLAUDE), Input::None);
    run.look(60, chrome_on(102, true), Input::At(ms(run.t0, 59)));
    assert_eq!(run.restores(), ["app 3"]);
}

#[test]
fn unreadable_input_counts_as_input() {
    // With the window: given back (the order agreeing).
    let mut run = Run::new(front(SPRINT_CODER));
    run.look(60, chrome_on(102, true), Input::Unknown);
    assert_eq!(run.restores(), ["app 1"]);
    assert_eq!(*run.behind_asked.borrow(), 1);

    // Away from the window: left, as with input.
    let mut run = Run::new(front(SPRINT_CODER));
    run.look(
        20,
        FrontSeen {
            new_window: true,
            ..front(SPRINT_CODER)
        },
        Input::None,
    );
    run.look(400, front(SPRINT_CODER), Input::None);
    run.look(420, front(CHROME), Input::Unknown);
    assert!(run.restores().is_empty());
    assert_eq!(
        run.finish(800, Input::Unknown),
        Some(FrontOutcome::Left(TakeKind::App, LeftWhy::Input))
    );
}

#[test]
fn with_input_a_take_before_its_window_waits_for_the_window_within_the_grace() {
    let early = |run: &Run| Input::At(ms(run.t0, 5));
    // The window seen 100 ms after the take: given back then.
    let mut run = Run::new(front(SPRINT_CODER));
    run.look(20, front(SPRINT_CODER), Input::None);
    let input = early(&run);
    run.look(60, front(CHROME), input);
    assert!(run.restores().is_empty());
    assert_eq!(run.watch.settle_end(), Some(ms(run.t0, 360)));
    run.look(160, chrome_on(102, true), input);
    assert_eq!(run.restores(), ["app 1"]);

    // Seen 400 ms after the take: too late, left.
    let mut run = Run::new(front(SPRINT_CODER));
    run.look(20, front(SPRINT_CODER), Input::None);
    let input = early(&run);
    run.look(60, front(CHROME), input);
    run.look(460, chrome_on(102, true), input);
    assert!(run.restores().is_empty());

    // Never seen: left, with input, when the watch ends.
    let mut run = Run::new(front(SPRINT_CODER));
    run.look(20, front(SPRINT_CODER), Input::None);
    let input = early(&run);
    run.look(60, front(CHROME), input);
    assert_eq!(
        run.finish(3_000, input),
        Some(FrontOutcome::Left(TakeKind::App, LeftWhy::Input))
    );
    assert!(run.restores().is_empty());

    // The watch ending inside the grace, the window not seen: left too.
    let mut run = Run::new(front(SPRINT_CODER));
    run.look(20, front(SPRINT_CODER), Input::None);
    let input = early(&run);
    run.look(60, front(CHROME), input);
    assert_eq!(
        run.finish(100, input),
        Some(FrontOutcome::Left(TakeKind::App, LeftWhy::Input))
    );
    assert!(run.restores().is_empty());
}

#[test]
fn a_take_waiting_for_its_window_is_dropped_when_the_front_moves_on() {
    let early = |run: &Run| Input::At(ms(run.t0, 5));
    // The app way: the user went on to Discord before the window was seen.
    let mut run = Run::new(front(SPRINT_CODER));
    run.look(20, front(SPRINT_CODER), Input::None);
    let input = early(&run);
    run.look(60, front(CHROME), input);
    run.look(80, front(DISCORD), input);
    run.look(
        120,
        FrontSeen {
            new_window: true,
            ..front(DISCORD)
        },
        input,
    );
    assert!(run.restores().is_empty());
    assert_eq!(run.finish(500, input), None);

    // The window way: the focus went back to a window Chrome had.
    let mut run = Run::new(chrome_on(100, false));
    run.look(20, chrome_on(100, false), Input::None);
    let input = early(&run);
    run.look(60, chrome_on(102, false), input);
    run.look(80, chrome_on(101, false), input);
    run.look(120, chrome_on(101, true), input);
    assert!(run.restores().is_empty());
    assert_eq!(run.finish(500, input), None);
}

#[test]
fn a_move_of_the_front_that_is_not_a_candidates_take_is_left_alone() {
    // To another app, and back to an app.
    let mut run = Run::new(front(SPRINT_CODER));
    run.look(20, front(DISCORD), Input::None);
    run.look(40, front(SPRINT_CODER), Input::None);
    // To a window Chrome already had, while Chrome was in front.
    let mut chrome_run = Run::new(chrome_on(100, false));
    chrome_run.look(20, chrome_on(101, false), Input::None);
    // Chrome in front, its focus unread before, now on a window it had: not a take.
    let mut unknown = Run::new(FrontSeen {
        app: Some(chrome()),
        ..Default::default()
    });
    unknown.look(20, chrome_on(101, false), Input::None);
    // A front that cannot be read, then Chrome: nothing known before, nothing to give back.
    let mut unread = Run::new(FrontSeen::default());
    unread.look(20, chrome_on(102, true), Input::None);
    // Another instance of the same pid (a token that is not the candidate's).
    let mut other = Run::new(front(SPRINT_CODER));
    other.look(
        20,
        FrontSeen {
            app: Some(FrontApp {
                pid: CHROME,
                instance: Some("macos-proc-v1:10:2".into()),
            }),
            ..Default::default()
        },
        Input::None,
    );
    for run in [
        &mut run,
        &mut chrome_run,
        &mut unknown,
        &mut unread,
        &mut other,
    ] {
        assert!(run.restores().is_empty());
        assert_eq!(run.finish(500, Input::None), None);
    }
}

#[test]
fn an_asked_app_in_front_is_watched_and_its_own_window_is_not_a_take() {
    // The asked app (Chrome here) was itself in front, without a window, when it was asked.
    let asked_in_front = || {
        let mut run = Run::new(FrontSeen {
            app: Some(chrome()),
            ..Default::default()
        });
        run.watch.asked();
        run
    };

    // The user stayed: the app showed its window while in front, with no window of its own to
    // give the focus back to. Nothing was taken from anyone, and nothing is said.
    let mut run = asked_in_front();
    run.look(300, chrome_on(102, true), Input::None);
    assert!(run.restores().is_empty());
    assert_eq!(run.finish(700, Input::None), None);

    // The user moved to Discord during the wait (input); Chrome then showed its window and took
    // the front with it: Discord, still right behind, gets the front back.
    let mut run = asked_in_front();
    run.look(200, front(DISCORD), Input::At(ms(run.t0, 190)));
    assert!(run.restores().is_empty());
    run.look(400, chrome_on(102, true), Input::At(ms(run.t0, 190)));
    assert_eq!(run.restores(), ["app 2"]);
    assert_eq!(
        run.finish(800, Input::At(ms(run.t0, 190))),
        Some(FrontOutcome::Restored(TakeKind::App))
    );

    // The window came first, in front; the watch went on. The user then moved to Discord, and
    // Chrome took the front again within the grace of its window: given back the same way.
    let mut run = asked_in_front();
    run.look(300, chrome_on(102, true), Input::None);
    run.look(380, front(DISCORD), Input::At(ms(run.t0, 370)));
    run.look(460, chrome_on(102, false), Input::At(ms(run.t0, 370)));
    assert_eq!(run.restores(), ["app 2"]);
    assert_eq!(
        run.finish(800, Input::At(ms(run.t0, 370))),
        Some(FrontOutcome::Restored(TakeKind::App))
    );

    // A look that could not read the front drops the mark: the user may have moved to another
    // app that this watch never saw, so the window the app then shows in front is said.
    let mut run = asked_in_front();
    run.look(200, FrontSeen::default(), Input::None);
    run.look(400, chrome_on(102, true), Input::None);
    assert_eq!(
        run.finish(800, Input::None),
        Some(FrontOutcome::Left(TakeKind::Window, LeftWhy::NoTarget))
    );

    // So does input from the user: they could have moved to another app and the asked app
    // taken the front back between two looks.
    let mut run = asked_in_front();
    run.look(300, chrome_on(102, true), Input::At(ms(run.t0, 290)));
    assert_eq!(
        run.finish(700, Input::At(ms(run.t0, 290))),
        Some(FrontOutcome::Left(TakeKind::Window, LeftWhy::NoTarget))
    );
    let mut run = asked_in_front();
    run.look(300, chrome_on(102, true), Input::Unknown);
    assert_eq!(
        run.finish(700, Input::Unknown),
        Some(FrontOutcome::Left(TakeKind::Window, LeftWhy::NoTarget))
    );

    // An asked app that was not in front when the watch began gets no mark: taking the front
    // from the app that was there is a take, given back as any other.
    let mut run = Run::new(front(DISCORD));
    run.watch.asked();
    run.look(300, chrome_on(102, true), Input::None);
    assert_eq!(run.restores(), ["app 2"]);

    // Without that mark (a launch passed on to an instance in front), the same first look is
    // a take with nothing to give back, and the watch stops there, as before.
    let mut run = Run::new(FrontSeen {
        app: Some(chrome()),
        ..Default::default()
    });
    run.look(300, chrome_on(102, true), Input::None);
    run.look(380, front(DISCORD), Input::At(ms(run.t0, 370)));
    run.look(460, chrome_on(102, false), Input::At(ms(run.t0, 370)));
    assert!(run.restores().is_empty());
    assert_eq!(
        run.finish(800, Input::At(ms(run.t0, 370))),
        Some(FrontOutcome::Left(TakeKind::Window, LeftWhy::NoTarget))
    );
}

#[test]
fn a_take_with_nothing_to_give_back_says_so() {
    // The app before could not be proven (no instance token).
    let mut run = Run::new(FrontSeen {
        app: Some(FrontApp {
            pid: SPRINT_CODER,
            instance: None,
        }),
        ..Default::default()
    });
    run.look(60, chrome_on(102, true), Input::None);
    assert!(run.restores().is_empty());
    assert_eq!(
        run.finish(400, Input::None),
        Some(FrontOutcome::Left(TakeKind::App, LeftWhy::NoTarget))
    );

    // Chrome in front, its focused window could not be read before the take.
    let mut run = Run::new(FrontSeen {
        app: Some(chrome()),
        focus: Some(window(102)),
        new_window: false,
    });
    run.look(20, chrome_on(103, true), Input::None);
    assert!(run.restores().is_empty());
    assert_eq!(
        run.finish(400, Input::None),
        Some(FrontOutcome::Left(TakeKind::Window, LeftWhy::NoTarget))
    );

    // Chrome in front, its focus not read at all before, now on a window it did not have.
    let mut run = Run::new(FrontSeen {
        app: Some(chrome()),
        ..Default::default()
    });
    run.look(20, chrome_on(102, true), Input::None);
    assert!(run.restores().is_empty());
    assert_eq!(
        run.finish(400, Input::None),
        Some(FrontOutcome::Left(TakeKind::Window, LeftWhy::NoTarget))
    );
}

#[test]
fn a_giving_back_that_cannot_be_done_says_why_and_stops() {
    for (answer, why) in [
        (Restored::Gone, LeftWhy::TargetGone),
        (Restored::Failed, LeftWhy::RestoreFailed),
        (Restored::NotBack, LeftWhy::RestoreFailed),
        (Restored::NoTime, LeftWhy::NoTime),
    ] {
        let mut run = Run::new(front(SPRINT_CODER));
        run.answer = answer;
        run.look(60, chrome_on(102, true), Input::None);
        run.look(80, front(SPRINT_CODER), Input::None);
        run.look(100, chrome_on(102, true), Input::None);
        // Tried once only.
        assert_eq!(run.restores(), ["app 1"]);
        assert_eq!(
            run.finish(400, Input::None),
            Some(FrontOutcome::Left(TakeKind::App, why))
        );
    }
}

#[test]
fn a_second_take_after_a_giving_back_is_judged_by_the_same_rules() {
    let mut run = Run::new(front(SPRINT_CODER));
    run.look(60, chrome_on(102, true), Input::None);
    run.look(80, front(SPRINT_CODER), Input::None);
    run.look(120, chrome_on(102, true), Input::None);
    assert_eq!(run.restores(), ["app 1", "app 1"]);
    // A third, with input, well after the window was first seen (60 ms): left.
    run.look(140, front(SPRINT_CODER), Input::None);
    run.look(600, chrome_on(102, true), Input::At(ms(run.t0, 590)));
    assert_eq!(run.restores().len(), 2);
    assert_eq!(
        run.finish(500, Input::None),
        Some(FrontOutcome::Left(TakeKind::App, LeftWhy::Input))
    );
}

#[test]
fn only_a_fresh_launch_without_activate_and_with_candidates_watches_the_front() {
    let watched = Handoff {
        candidates: vec![candidate()],
        same_app_ran: true,
        ..Default::default()
    };
    let no_candidate = Handoff {
        candidates: vec![],
        same_app_ran: true,
        ..Default::default()
    };
    assert_eq!(
        watches_front(Some(&watched), false).map(<[_]>::len),
        Some(1)
    );
    // `--activate`.
    assert!(watches_front(Some(&watched), true).is_none());
    // An attach or an ordinary launch reads no hand-off.
    assert!(watches_front(None, false).is_none());
    // No instance to watch.
    assert!(watches_front(Some(&no_candidate), false).is_none());
}

#[test]
fn input_is_read_against_when_the_launch_began_with_doubt_on_input() {
    let started = Instant::now();
    let now = ms(started, 1_000);
    assert_eq!(input_since(started, now, 2.0), Input::None);
    assert_eq!(input_since(started, now, 0.5), Input::At(ms(started, 500)));
    // Right at the start (and a hair before it) counts as input.
    assert!(matches!(input_since(started, now, 1.0), Input::At(_)));
    assert!(matches!(input_since(started, now, 1.002), Input::At(_)));
    for unreadable in [f64::NAN, f64::INFINITY, -1.0] {
        assert_eq!(input_since(started, now, unreadable), Input::Unknown);
    }
    // Further back than the clock reaches: long before the launch.
    assert_eq!(input_since(started, now, 1e18), Input::None);
}

#[test]
fn a_giving_back_needs_the_time_its_checks_take() {
    assert!(!restore_has_time(Duration::from_millis(500)));
    assert!(restore_has_time(RESTORE_MIN_REMAINING));
    // A window way's giving back took about 0.45 s, waits included.
    assert!(RESTORE_MIN_REMAINING >= Duration::from_millis(1_000));
}

#[test]
fn the_front_is_read_a_little_after_the_new_window_only() {
    let run = Run::new(front(SPRINT_CODER));
    assert_eq!(run.watch.settle_end(), None);
    let mut run = Run::new(front(SPRINT_CODER));
    run.look(
        200,
        FrontSeen {
            new_window: true,
            ..front(SPRINT_CODER)
        },
        Input::None,
    );
    assert_eq!(run.watch.settle_end(), Some(ms(run.t0, 200) + FRONT_SETTLE));
    assert!(!run.watch.wants_new_window());
    // Short, and the Windows launch's grace.
    assert_eq!(FRONT_APP_GRACE, Duration::from_millis(300));
    assert!(FRONT_SETTLE <= Duration::from_millis(500));
}

fn handed_off() -> LaunchResult {
    super::super::launch::handed_off_result(
        "Google Chrome",
        ProcessId::new(CHROME as u32),
        Some(CHROME_INSTANCE.into()),
        false,
    )
}

fn unconfirmed() -> AdapterError {
    super::super::launch::handoff_outcome(
        super::super::launch::HandoffWatch::NoNewWindow,
        "Google Chrome",
        42,
        false,
    )
    .unwrap()
    .unwrap_err()
}

#[test]
fn the_result_says_what_happened_to_the_front_and_nothing_else_changes() {
    use super::super::launch::{HANDED_OFF, HANDOFF_UNCONFIRMED};
    // No take: exactly as before.
    let result = annotate(Ok(handed_off()), None).unwrap();
    assert_eq!(result.suggestion.as_deref(), Some(HANDED_OFF));
    let error = annotate(Err(unconfirmed()), None).unwrap_err();
    assert_eq!(error.suggestion.as_deref(), Some(HANDOFF_UNCONFIRMED));
    assert!(error.details.as_ref().unwrap().get("front").is_none());

    for outcome in [
        FrontOutcome::Restored(TakeKind::App),
        FrontOutcome::Restored(TakeKind::Window),
        FrontOutcome::Left(TakeKind::App, LeftWhy::Input),
        FrontOutcome::Left(TakeKind::App, LeftWhy::NoTarget),
        FrontOutcome::Left(TakeKind::Window, LeftWhy::TargetGone),
        FrontOutcome::Left(TakeKind::App, LeftWhy::RestoreFailed),
        FrontOutcome::Left(TakeKind::App, LeftWhy::NoTime),
    ] {
        let result = annotate(Ok(handed_off()), Some(outcome)).unwrap();
        assert!(result.handed_off && result.attached && !result.new_instance);
        assert_eq!(result.pid, ProcessId::new(CHROME as u32));
        assert_eq!(result.process_instance.as_deref(), Some(CHROME_INSTANCE));
        assert!(result.window.is_none() && result.activated.is_none());
        let suggestion = result.suggestion.unwrap();
        assert!(suggestion.starts_with(HANDED_OFF));
        assert!(suggestion.ends_with(front_note(outcome)));

        let error = annotate(Err(unconfirmed()), Some(outcome)).unwrap_err();
        assert_eq!(error.code, ErrorCode::AppUnresponsive);
        assert_eq!(
            serde_json::to_value(error.disposition).unwrap(),
            serde_json::to_value(DeliverySemantics::uncertain()).unwrap()
        );
        let details = error.details.as_ref().unwrap();
        assert_eq!(details["kind"], "launch_handoff_unconfirmed");
        assert_eq!(details["pid"], 42);
        assert_eq!(details["front"], front_details(outcome));
        let suggestion = error.suggestion.unwrap();
        assert!(suggestion.starts_with(HANDOFF_UNCONFIRMED));
        assert!(suggestion.ends_with(front_note(outcome)));
    }
    let restored = front_details(FrontOutcome::Restored(TakeKind::Window));
    assert_eq!(restored["taken"], "window");
    assert_eq!(restored["restored"], true);
    assert!(restored["left_because"].is_null());
    let left = front_details(FrontOutcome::Left(TakeKind::App, LeftWhy::Input));
    assert_eq!(left["taken"], "app");
    assert_eq!(left["restored"], false);
    assert_eq!(left["left_because"], "user_input");

    // Notes that bring the front back say it showed for a moment; notes that leave it say so.
    assert!(front_note(FrontOutcome::Restored(TakeKind::App)).contains("for a moment"));
    assert!(
        front_note(FrontOutcome::Left(TakeKind::App, LeftWhy::Input)).contains("Tell the user")
    );
    // Any other error stays exactly as it was.
    let other = AdapterError::new(ErrorCode::Timeout, "slow");
    let other = annotate(Err(other), Some(FrontOutcome::Restored(TakeKind::App))).unwrap_err();
    assert!(other.suggestion.is_none() && other.details.is_none());
    // A launch that was not passed on (a new instance of its own) says nothing of the front:
    // the sentences speak of the instance a launch was passed to.
    let own = LaunchResult {
        handed_off: false,
        suggestion: Some("as it was".into()),
        ..handed_off()
    };
    let own = annotate(Ok(own), Some(FrontOutcome::Restored(TakeKind::App))).unwrap();
    assert_eq!(own.suggestion.as_deref(), Some("as it was"));
}

#[test]
fn only_a_launch_judged_as_passed_on_reads_the_front_a_little_longer() {
    assert!(is_handoff(&Ok(handed_off())));
    assert!(is_handoff(&Err(unconfirmed())));
    let mut fresh = handed_off();
    fresh.handed_off = false;
    assert!(!is_handoff(&Ok(fresh)));
    assert!(!is_handoff(&Err(AdapterError::timeout("slow"))));
}

#[test]
fn the_pass_for_giving_the_front_back_lets_only_that_through() {
    let refused = crate::RefusedWindowOwner::Process {
        pid: 42,
        instance: None,
    };
    let _scope = crate::system::own_window::enter(&refused, "launch_app");
    assert!(crate::system::own_window::check_pid(Some(42)).is_err());
    {
        let _pass = crate::system::own_window::front_return_pass().expect("pass");
        assert!(crate::system::own_window::check_pid(Some(42)).is_ok());
    }
    // Once the front is given back, Sprint Coder is refused again, as every operation.
    let error = crate::system::own_window::check_pid(Some(42)).unwrap_err();
    assert_eq!(error.code, ErrorCode::PolicyDenied);
    assert_eq!(error.details.unwrap()["kind"], "own_window_refused");

    // A variable that cannot be read refuses even this.
    let _unreadable =
        crate::system::own_window::enter(&crate::RefusedWindowOwner::Unreadable, "launch_app");
    let Err(error) = crate::system::own_window::front_return_pass() else {
        panic!("an unreadable variable must refuse the pass");
    };
    assert_eq!(
        error.details.unwrap()["kind"],
        "own_window_variable_unreadable"
    );
}

#[test]
fn the_pass_is_used_in_one_place_around_bringing_an_app_to_the_front_only() {
    fn sources(dir: &std::path::Path, out: &mut Vec<(std::path::PathBuf, String)>) {
        for entry in std::fs::read_dir(dir).expect("source dir") {
            let path = entry.expect("entry").path();
            if path.is_dir() {
                sources(&path, out);
            } else if path.extension().is_some_and(|ext| ext == "rs")
                && !path.to_string_lossy().ends_with("_tests.rs")
            {
                let text = std::fs::read_to_string(&path).expect("source");
                out.push((path, text));
            }
        }
    }
    let mut all = Vec::new();
    sources(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
        &mut all,
    );
    let uses: Vec<_> = all
        .iter()
        .filter(|(path, _)| !path.ends_with("own_window.rs"))
        .flat_map(|(path, text)| {
            text.matches("own_window::front_return_pass()")
                .map(move |_| path.clone())
        })
        .collect();
    assert_eq!(uses.len(), 1, "{uses:?}");
    assert!(uses[0].ends_with("launch_front.rs"));
    let text = &all.iter().find(|(path, _)| path == &uses[0]).unwrap().1;
    let body = text
        .split("fn bring_app_back(")
        .nth(1)
        .and_then(|rest| rest.split("\n}\n").next())
        .expect("bring_app_back");
    assert!(body.contains("own_window::front_return_pass()?;"));
    assert!(body.contains("focus::ensure_app_focused(pid, deadline)"));
    // Nothing else runs under the pass.
    assert_eq!(body.matches("crate::").count(), 2, "{body}");
}

#[test]
fn right_behind_the_taker_is_read_from_the_window_order() {
    let at = |pid: i32, number: i64| OrderedWindow { pid, number };
    let candidates = [candidate()];
    let sprint_coder = Target::App(app(SPRINT_CODER));
    // The taker's new windows are passed over; the first window after them decides.
    let order = [
        at(CHROME, 102),
        at(CHROME, 103),
        at(SPRINT_CODER, 5),
        at(CHROME, 100),
        at(DISCORD, 6),
    ];
    assert!(just_behind(&sprint_coder, &order, &candidates));
    assert!(!just_behind(
        &Target::App(app(DISCORD)),
        &order,
        &candidates
    ));
    // The user went on to Discord before the take: Discord's window is behind Chrome's.
    let switched = [at(CHROME, 102), at(DISCORD, 6), at(SPRINT_CODER, 5)];
    assert!(!just_behind(&sprint_coder, &switched, &candidates));
    // A window Chrome already had is right behind its new one: the user may have gone to it
    // just before, so the app read at the last look is not proven to be what was in front.
    let to_chrome = [at(CHROME, 102), at(CHROME, 100), at(SPRINT_CODER, 5)];
    assert!(!just_behind(&sprint_coder, &to_chrome, &candidates));
    // No other window at all: not confirmed.
    assert!(!just_behind(&sprint_coder, &[at(CHROME, 102)], &candidates));

    // The window way: the window right behind the new ones must be the one to give back.
    let order = [
        at(CHROME, 102),
        at(CHROME, 101),
        at(DISCORD, 6),
        at(CHROME, 100),
    ];
    assert!(just_behind(
        &Target::Window(window(101)),
        &order,
        &candidates
    ));
    assert!(!just_behind(
        &Target::Window(window(100)),
        &order,
        &candidates
    ));
    // The user left Chrome's window for Discord just before the new window came: Discord is
    // between, and Chrome's window is not given the focus back over it.
    let left_for_discord = [
        at(CHROME, 102),
        at(DISCORD, 6),
        at(CHROME, 101),
        at(CHROME, 100),
    ];
    assert!(!just_behind(
        &Target::Window(window(101)),
        &left_for_discord,
        &candidates
    ));
    assert!(!just_behind(
        &Target::Window(window(100)),
        &[at(CHROME, 102)],
        &candidates
    ));
}

#[test]
fn only_a_text_input_in_browser_chrome_defers_the_background_url() {
    let is_input = |roles: &[&str]| {
        toolbar_text_field(
            0usize,
            |i| roles.get(*i).map(|s| s.to_string()),
            |i| Some(*i + 1),
        )
    };
    assert!(is_input(&["AXTextField", "AXGroup", "AXToolbar"]));
    assert!(is_input(&["AXComboBox", "AXToolbar"]));
    assert!(!is_input(&["AXButton", "AXToolbar"]));
    assert!(!is_input(&["AXTextField", "AXWebArea", "AXToolbar"]));
    assert!(!is_input(&["AXTextField", "AXWindow"]));
    assert!(!is_input(&["AXTextField"]));
}

#[test]
fn a_second_copy_can_block_a_url_but_another_browser_of_the_same_family_cannot() {
    let allowed = vec![
        "com.google.Chrome".to_string(),
        "org.chromium.Chromium".to_string(),
    ];
    let target = Some("com.google.Chrome");
    assert!(same_url_browser_bundle(
        target,
        Some("com.GOOGLE.chrome"),
        &allowed
    ));
    assert!(!same_url_browser_bundle(
        target,
        Some("org.chromium.Chromium"),
        &allowed
    ));
    assert!(!same_url_browser_bundle(None, None, &allowed));
    assert!(!same_url_browser_bundle(target, None, &allowed));
    assert!(!same_url_browser_bundle(
        Some("other.app"),
        Some("other.app"),
        &allowed
    ));
}
