# Feel: measured against the spec

`spec/feel.md` gives each motion a number and an observable. This page holds what Orbit measures against those numbers, before and after the feel lane's fixes, and the FL-30 review checklist.

## How the numbers are taken

- The feel specs (`tests/e2e/feel-*.spec.ts`) drive Orbit with real input (keys and pointer events sent through main, so shortcuts take the same path as a user's) and record the DOM once per rendered frame with the shared sampler, `tests/e2e/frames.ts`. Each frame holds the rAF time, the wall time and the boxes, opacity and chosen styles of the elements under test. Inputs are stamped with the frame they arrived in, so "1 frame" means the response is drawn in the first frame after the input.
- Each test writes its numbers as JSON lines when `FEEL_LOG` is set: `FEEL_LOG=/path/feel.jsonl xvfb-run -a -s "-screen 0 1440x900x24" ./node_modules/.bin/playwright test --workers 1 tests/e2e/feel-*.spec.ts`.
- The asserts are loose under load (`FRAME_SLACK`, D17) and take the best of three tries where one try can be unlucky (D46). The numbers below are medians of three full runs, with the range in brackets.
- Machine: a 16-core Xeon VM (Skylake), Xvfb at 1440×900 and 60 Hz (one frame = 16.7 ms), with other lanes' tests running beside it (load average in the last column). Treat frame-time numbers (p99, max) as upper bounds: the same runs on a quiet machine are better.
- "Visible" follows feel.md: the first frame on screen that shows a response. A fade that starts at opacity 0 is not visible in its first frame.

## Measured vs target

Before: `4a193cd` (main at `70b3f9d` plus the tests), 2026-10-10, three runs at load 11–14. After: filled in as each fix lands.

| ID | Observable | Target | Before | After |
|---|---|---|---|---|
| FL-01 | Space shortcut pressed again mid-slide: step in the frame after | ≤ 2 × the step before + 2 px | 29 px (27–35), before 33 | |
| FL-01 | Escape while the bar appears: opacity / scale step after | ≤ 2 × before + 0.05 / + 0.003 | 0.25 / 0.007 | |
| FL-01 | Hover sidebar: edge re-entered while it slides out | turns back from where it is | **gap**: slides fully out (270 px), then in again | |
| FL-01 | Folder collapsed while it opens: step after the click | ≤ 2 × before + 2 px | 25 px (21–30), before 19 | |
| FL-01 | ⌘S pressed again at 90 ms: jump ratio of the edge | ≤ 6 × average speed | 3.1 (3.0–3.2) | |
| FL-02 | ⌘S → sidebar starts moving | 1 frame | **gap**: 26 ms, 2 frames (2–3) | |
| FL-02 | ⌘S → sidebar gone | ≤ 300 ms | 226 ms (223–231) | |
| FL-02 | Sidebar edge to card edge | never apart (6–8 px margin) | 0–6 px | |
| FL-02 | Frame p99 / max while hiding | ≤ 16.7 / ≤ 33.3 ms | 33.4 / 33.4 ms | |
| FL-03 | Left edge → overlay starts moving | at once | **gap**: 64 ms (53–74) | |
| FL-03 | Left edge → overlay fully in | ≤ 250 ms | 231 ms (203–257) | |
| FL-03 | Overshoot | ≤ 2 px | 0 px | |
| FL-03 | Pointer leaves → overlay gone | 300–500 ms dwell + quick out | 885 ms (polled) | |
| FL-04 | Sweep over 20 rows: rows lit of those entered | all | 17 of 17 | |
| FL-04 | Frames to highlight a row | ≤ 2 (fade from 0) | 2 | |
| FL-04 | Highlight when the pointer leaves | fades out from where it is | **gap**: jumps up first on 18 rows (a fade restarts from full) | |
| FL-04 | Highlight gone after leaving, worst | ≤ 150 ms (quick) | 112 ms | |
| FL-05 | Press → selected highlight | 1 frame | **gap**: 93 ms (92–94), 6 frames | |
| FL-05 | Press → page shown | ≤ 50 ms | 20 ms (19–21) | |
| FL-05 | Press just after a row grows in (PR #10 review F1) | selects the row | **gap**: lost (the hit lands on the row's slot) | |
| FL-06 | Enter → new row fully grown | ≤ 250 ms | 247 ms (246–263) | |
| FL-06 | Growth time | 180–220 ms (snappy) | 183 ms (167–183) | |
| FL-06 | Rows below: jump ratio | ≤ 6 | 4.5 (2.6–5.1) | |
| FL-09 | ⌘W → next tab selected | 1 frame | **gap**: 26 ms, 2 frames | |
| FL-09 | ⌘W → gap closed | ≤ 250 ms | **gap**: 393 ms (387–394) | |
| FL-10 | 4 px → row lifted | 1 frame | 1 frame | |
| FL-10 | Frames where the row lags the pointer | 0 | 0 | |
| FL-10 | Escape → row back in its slot | ≤ 300 ms | **gap**: 370 ms (368–370) | |
| FL-13 | Swipe: frames off the fingers by > 0.5 px | 0 | 0 of 34 | |
| FL-13 | Swipe release → settled (release seen 90 ms after the last event) | ≤ 350 + 90 ms | 410 ms (409–423) | |
| FL-13 | Flick: travel / release → settled | < 25 % / ≤ 350 + 90 ms | 23 % / 381 ms | |
| FL-13 | Rubber band at the first Space, one width of travel | ≈ 35.5 % (formula) | 35.7 % | |
| FL-13 | Rubber band: release → back at rest | ≤ 350 + 90 ms | **gap**: 496 ms (481–496) | |
| FL-14 | Theme during a swipe: in-between colours / grey frames / contrast | > 2 / 0 / ≥ 4.5:1 | 15 / 0 / 9.8:1 | |
| FL-16 | ⌘T → bar visible (opacity > 0), warm | 1 frame | **gap**: 21 ms (7–45) | |
| FL-16 | ⌘T → bar visible, first open after launch | 1 frame | **gap**: 31 ms (21–34) | |
| FL-16 | ⌘L → bar visible | 1 frame | 10 ms (7–16) | |
| FL-16 | Entrance: first frame to opaque and full size | 120–160 ms | **gap**: 183 ms (183–200) | |
| FL-16 | Entrance: first frame scale / drop / overshoot | 0.97 / −4 px / none | 0.97 / −4 px / none | |
| FL-16 | Page dimming | none or very slight | scrim alpha 0.07 | |
| FL-16 | ⌘T then "abc" at once | "abc" | 3 of 3 keys | |
| FL-16 | Escape → bar gone / smallest scale | 100–120 ms / 0.98 | 103 ms (90–104) / 0.98 | |
| FL-16 | Enter on a result → bar gone | ≈ 80 ms | 86 ms (80–95) | |
| FL-17 | Keystroke → field shows it, worst | 1 frame | 1 frame | |
| FL-17 | Keystroke → local results, worst / median | ≤ 50 ms / 1 frame | 33 ms (19–43) / 10 ms | |
| FL-17 | Late suggestions: highlight moved / list bounces | 0 / 0 | 0 / 0 (3 suggestions shown) | |
| FL-17 | ↑/↓ → highlight moved | 1 frame | 1 frame | |
| FL-21 | 200 tabs, fling: frame p99 / max / frames over one interval | ≤ 16.7 / ≤ 33.3 ms / 0 | 33.3 / 33.4 ms / 4 of 279 | |
| FL-21 | 500 tabs + 50 folders, scroll: frame p99 / max / over | ≤ 16.7 / ≤ 33.3 ms / 0 | **gap**: 50 / 50 ms / 111 of 271 | |
| FL-21 | Switch to a 200-tab Space never shown: its rows drawn | ≤ 100 ms | **gap**: 244 ms (218–274) | |
| FL-21 | … longest task / frame max | < 50 / ≤ 33.3 ms | **gap**: 292 / 333 ms | |
| FL-28 | Reduced motion, ⌘⌥→: horizontal movement | 0 px | 0 px | |
| FL-28 | Reduced motion, ⌘⌥→: cross-fade done | < 150 ms | **gap**: 185 ms (182–197) | |
| FL-29 | Space shortcut → slide starts | 1 frame | 1 frame (10 ms) | |
| FL-29 | Space shortcut → settled | ≤ 350 ms | **gap**: 427 ms (426–427) | |
| FL-29 | Frame p99 during the slide | ≤ 16.7 ms | 16.8 ms (16.8–33.3) | |

Not yet measured: the FL-29 lines for ⌘S finish, drag follow and p99 in the drag, which come with the FL-29 budget tests.
