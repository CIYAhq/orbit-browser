# Feel: measured against the spec

`spec/feel.md` gives each motion a number and an observable. This page holds what Orbit measures against those numbers, before and after the feel lane's changes, and the FL-30 review checklist. Orbit is judged against the spec's numbers and observables only.

## How the numbers are taken

- The feel specs (`tests/e2e/feel-*.spec.ts`) drive Orbit with real input. Keys and pointer events are sent through main, so shortcuts take the same path as a user's. The shared sampler, `tests/e2e/frames.ts`, records the DOM once per rendered frame. Each frame holds:
  - the rAF time and the wall time;
  - the boxes, opacity and chosen styles of the elements under test, read after every animation-frame callback of that frame.

  Each input is stamped with the first frame drawn after it. Native views (pages, the overlay) are timed on the wall clock in main.
- Each test writes its numbers as JSON lines when `FEEL_LOG` is set: `FEEL_LOG=/path/feel.jsonl xvfb-run -a -s "-screen 0 1440x900x24" ./node_modules/.bin/playwright test --workers 1 tests/e2e/feel-*.spec.ts`.
- The asserts are loose under load (`FRAME_SLACK`, D17). Where one try can be unlucky, they take the best of three (D46). The numbers below are medians of three full runs, with the range in brackets for times. Counts, sizes and ratios show the median alone.
- The machine is a 16-core Xeon VM (Skylake) running Xvfb at 1440×900 and 60 Hz, so one frame is 16.7 ms. Other lanes' tests run beside it; "load" below is the 1-minute load average during the runs.
  - Frame times come in whole intervals. On the frame clock one interval reads 16.8 ms and two read 33.4 ms, so a frame that misses its slot by a millisecond counts a whole extra interval.
  - Treat p99 and max as upper bounds: the same runs are better on a quiet machine.
  - Durations taken between two frames come in 16.7 ms steps. A reading one step outside a range (183 ms against 150–180) is as close as frames can show.
- A frame's time is when the frame began (its rAF time). A change that arrives while a frame is being made is drawn in that frame, and can read a millisecond under 0 (FL-06).
- "Visible" follows feel.md: the first frame on screen that shows a response. A fade that starts at opacity 0 is not visible in its first frame.
- "In place" means within 0.5 px of where the motion ends. The standard spring (FL-01: 0.32 s, damping 0.88) overshoots by 0.3 % of its travel, about 1.5 px over half a page.
  - It is within 2 px after 270–300 ms, which is what the spec's "about 260–300 ms" describes.
  - It comes back within 0.5 px only about 450 ms after it starts.

  Rows on that spring give both times.

## Measured vs target

- **Before:**
  - P0 rows (FL-01 to 06, 09, 10, 13, 14, 16, 17, 21, 28, 29): `8c5849f`, which is `main` at `70b3f9d` plus the feel specs. Three runs on 2026-10-10 at load 6–9.
  - P1 rows (FL-07, 08, 11, 12, 15, 18, 20, 22, 25) and FL-19: `1920500`, the lane after its P0 fixes and before any P1 change, run with the P1 specs. Three runs on 2026-10-11 at load 3–4 (FL-19 at load 2).
  - FL-22's Before is read from the old toast code (a 220 ms CSS keyframe, toasts 6 px apart, removed after 2.2 s), because the test doesn't run on the old toasts.
- **After:** the lane's app code at `5416e5c`. Three runs on 2026-10-11 at load 3–4.5. FL-19 ran at load 0.7–1. FL-03's leave row ran at load 5, after its poll was made finer. FL-26 ran nine times on the lane merged with `main` at `592096b`, which has the keys lane's switcher, at load 2.5–5.6.
  - FL-26 was measured again once TB-05 built the switcher's list (the finish-tabs lane): three runs at load 16–18, with two other lanes' e2e runs beside them. A row's Before is the keys lane's switcher as measured at `592096b`; a blank Before is a row that came with the list.
  - FL-12's folder icon row came with FD-07's full-colour icon (the finish-tabs lane): three runs at load 5.4–6.3.
  - Fix round 1 (PR #25's review) measured the rows it touched again, on the lane after its fixes: FL-01's interruptions, FL-05's scroll, FL-09, FL-19's close, FL-21's accessibility row and the toasts under reduced motion. Their runs and loads are in the notes. The Before of a row new in this round is the lane just before its fix, in one run: FL-05's scroll at `a4adf9b` (load 4.4), the toasts at `0f9fbfb` (load 6.2–7.9). FL-21's accessibility row is the review's reading of `0f9fbfb`.
- A blank Before cell has one of four causes:
  - the row's test came with its fix;
  - on the old build the test failed an earlier check and stopped before the row (FL-07's ⌘Z and other-Space rows, FL-12's closing);
  - the row is an audit with no change (FL-23, FL-27), so its After is also how it was before;
  - the row came with TB-05's list (FL-26) or FD-07's folder icon (FL-12).
- **gap** marks a value that misses its target. The notes below the table say why each After gap remains. No number was tuned to pass on one run.

| ID | Observable | Target | Before | After |
|---|---|---|---|---|
| FL-01 | Space shortcut pressed again mid-slide: speed after, in px a frame | ≤ 2 × the speed before + 2 | 23 px (23–24) | 24 (19–38); 27 (22–33) before the press |
| FL-01 | Escape while the bar appears: opacity / scale speed after, a frame | ≤ 2 × before + 0.05 / + 0.003 | 0.40 / 0.010 | 0.29 / 0.006 |
| FL-01 | Escape while the bar appears: frames the exit fades over | ≥ 3 (no jump to the end) |  | 5 (3–6) |
| FL-01 | Hover sidebar: edge re-entered as it slides out: furthest out | turns back mid-way (< 270 px) | **gap**: 270 px | 226 px (188–243) |
| FL-01 | Folder collapsed while it opens: speed after the click, in px a frame | ≤ 2 × before + 2 | 40 px (17–58) | 23 (16–29); 26 (22–30) before the click |
| FL-01 | ⌘S pressed again at 90 ms: jump ratio of the edge | ≤ 6 × average speed | 2.8× (2.8–3.1) | 3.1× |
| FL-02 | ⌘S → sidebar starts moving | 1 frame | **gap**: 30 ms (23–38), 2 frames | 5 ms (3–19), 1 frame |
| FL-02 | ⌘S → sidebar gone | ≤ 300 ms | 223 ms (221–230) | 236 ms (222–236) |
| FL-02 | Sidebar edge to card edge, min–max | never apart (6–8 px margin) | 0 px–6 px | 0 px–6 px |
| FL-02 | Frame p99 / max while hiding | ≤ 16.7 / ≤ 33.3 ms | **gap**: 33.3 / 33.3 ms | **gap**: 33.4 / 33.4 ms |
| FL-03 | Left edge → overlay starts moving | at once (1 frame) | **gap**: 53 ms (51–76) | **gap**: 42 ms (29–45) |
| FL-03 | Left edge → overlay fully in | ≤ 250 ms | 220 ms (218–243) | 195 ms (192–196) |
| FL-03 | Overshoot | ≤ 2 px | 0 px | 0 px |
| FL-03 | Pointer leaves → overlay gone | 300–500 ms + a quick slide (≈ 450–700 ms); < 1 s | 893 ms (891–893), polled at 100, 350 and 850 ms | 627 ms (625–632), polled every 16 ms |
| FL-04 | Sweep over 20 rows: rows lit of those entered | all | 17 of 17 | 17 of 17 |
| FL-04 | Frames to highlight a row, worst | ≤ 2 (fade from 0) | 2 | 1 |
| FL-04 | Highlight gone after leaving, worst | ≤ 150 ms (quick) | 112 ms (112–113) | 63 ms |
| FL-05 | Press → selected highlight | 1 frame | **gap**: 92 ms (92–94) | 8 ms (5–9) |
| FL-05 | Press → page shown | ≤ 50 ms | 20 ms | 24 ms (22–24) |
| FL-05 | Press: time with no row highlighted | 0 (one hands over to the other) | **gap**: 83 ms | 0 ms |
| FL-05 | Press in the first frame after a row grows in (PR #10 review F1) | 3 of 3 select the row | **gap**: lost (it lands on the row’s slot) | 3 |
| FL-05 | Selected row out of sight, 100 px below the edge: scroll / share of the way in its first frame | 200–250 ms ease-out | **gap**: 200 ms / 2 % (eases in; fastest in its third frame) | 217 ms / 12 % (fastest in its second frame) |
| FL-05 | … a screen away (846 px): scroll | 200–250 ms | **gap**: 425 ms (417–433) | 233 ms |
| FL-05 | … more than two screens away (2,034 px) / with reduced motion: frames moving | 1 / 1 (at once) | **gap**: 27 / 1 | 1 / 1 |
| FL-05 | … rows on screen drawing nothing while it scrolls (FL-21) | 0 | 0 | 0 |
| FL-06 | Enter → new row fully grown | ≤ 250 ms | 236 ms (224–247) | 216 ms (208–219) |
| FL-06 | Enter → new row first drawn | 1 frame after the state | **gap**: 40 ms (36–47) | 8 ms (−1–19) |
| FL-06 | Rows below: jump ratio | ≤ 6 | 3.2× (3.1–3.3) | 2.4× (2.2–3.4) |
| FL-07 | ⌘D on the third Today tab → in its new slot (within 0.5 px) | ≈ 250 ms (standard spring) | 280 ms (272–286) | 286 ms (276–289) |
| FL-07 | ⌘D: frames with the row gone or drawn twice | 0 | 0 | 0 |
| FL-07 | ⌘D: divider and rows above, largest step share | < 60 % (no jump) | **gap**: 100% | 19% (16–19) |
| FL-07 | ⌘D: rows below, furthest from their place | ≈ 0 px | **gap**: 29.9 px (28.9–32.0) | 1.0 px |
| FL-07 | ⌘Z → back in its slot / rows below | ≈ 250 ms / ≈ 0 px |  | 276 ms (275–292) / 1.0 px |
| FL-07 | Pinned section out of sight, ⌘D: the row above moves / the row slides left | 0 px (no scroll) / ≈ 12 px | **gap**: 300.0 px (299.0–300.0) / 12 px | 0.0 px / 12 px |
| FL-07 | Moved to another Space: the row above moves | 0 px (no scroll) |  | 0.0 px |
| FL-08 | Hover the ×: circle fully in / frames part-way | ≈ 90 ms / ≥ 1 | **gap**: 13 ms / 0 | 95 ms (95–96) / 4 |
| FL-08 | Press: frames to the glyph at 0.9 / smallest scale | 1 / ≈ 0.9 | 1 / 0.90 | 1 / 0.90 |
| FL-08 | Release → row starts leaving | the release's frame; once main has closed the tab (D70) | 2 frames | 2 frames |
| FL-09 | ⌘W → next tab selected (a sleeping tab below), median of five closes | 1 frame |  | 1 frame, 9 ms (8–11) |
| FL-09 | ⌘W → next tab selected, the first close after a launch | 1 frame | **gap**: 33 ms (30–41), 3 frames | **gap**: 22 ms (22–24), 2 frames |
| FL-09 | Next row selected no later than the closed one starts to leave | every close | yes | yes |
| FL-09 | ⌘W → gap closed | ≤ 250 ms | **gap**: 397 ms (383–407) | 222 ms (222–224) |
| FL-10 | 4 px → row lifted | 1 frame | 1 frame | 1 frame |
| FL-10 | Frames where the row lags the pointer | 0 | 0 | 0 |
| FL-10 | Row centre to the pointer while held (pressed at its centre) | 0 px |  | 0 px |
| FL-10 | Escape → row back in its slot (within 0.5 px) | ≤ 300 ms | **gap**: 355 ms (351–368) | 270 ms (269–272) |
| FL-10 | Frame p99 while dragging | ≤ 16.7 ms (FL-29) | 16.8 ms | 16.8 ms |
| FL-11 | ⌘⇧K with 8 Today tabs → Today empty | ≤ 450 ms | 441 ms (440–442) | 439 ms (436–441) |
| FL-11 | First row starts → last row starts | 7 × 20–30 ms | 183 ms (167–200) | 167 ms (167–183) |
| FL-11 | Rows slide left / divider and New Tab moved | ≈ 24 px / 0 px | 22 px / 0 px | 22 px / 0 px |
| FL-11 | ⌘Z: first row back → last row back | 0 (one group) | 0 ms | 0 ms |
| FL-12 | Folder of 6: chevron turn, first to last moving frame | 150–180 ms | 117 ms (117–133) | 133 ms |
| FL-12 | Click → content below in place / largest step share | ≤ 250 ms / < 60 % | 243 ms (237–245) / 17% | 239 ms (238–240) / 17% |
| FL-12 | Children: first shown → last shown | 5 × 10–15 ms | **gap**: 0 ms | 67 ms |
| FL-12 | Closing: content below moves for / click → closed | 150–180 ms / ≤ 250 ms |  | 167 ms (150–167) / 175 ms (167–179) |
| FL-12 | Folder icon (FD-07), closed → open: cross-fade, first to last changing frame | about 150 ms |  | 100 ms (100–100), 130 ms set |
| FL-13 | Swipe: frames off the fingers by > 0.5 px | 0 | 0 | 0 |
| FL-13 | Swipe release → settled (release seen 90 ms after the last event) | ≤ 350 + 90 ms | **gap**: 476 ms (396–479) | 412 ms (394–412) |
| FL-13 | Flick: travel / last event → settled | < 25 % / ≤ 350 + 90 ms | 23% / 361 ms (356–364) | 23% / 276 ms (275–291) |
| FL-13 | Rubber band at the first Space, one width of travel | ≈ 35.5 % (formula) | 35.7% | 35.7% |
| FL-13 | Rubber band: last event → back at rest (within 0.5 px) | on FL-13's spring, ≈ 480 ms (D70: FL-29's 350 ms is for swipes that land on a Space) | 478 ms (477–480) | 478 ms (477–479) |
| FL-13 | Frame p99 while swiping and settling | ≤ 16.7 ms (FL-29) | 16.8 ms (16.8–33.3) | 16.8 ms (16.8–33.3) |
| FL-14 | Theme during a swipe: in-between colours / grey frames / contrast | > 2 / 0 / ≥ 4.5:1 | 16 / 0 / 9.8:1 | 16 / 0 / 9.8:1 |
| FL-15 | Icon button: press → at 0.94 / smallest scale | at once (60 ms) / ≈ 0.94 | 14 ms (1–15) / 0.94 | 25 ms (17–31) / 0.94 |
| FL-15 | Release → settled at full size (within 0.2 %) | the pop spring | **gap**: back in 1 frame (no spring) | 193 ms |
| FL-15 | Disabled button: size change on a press | 0 px | 0 px | 0 px |
| FL-16 | ⌘T → bar visible (opacity > 0), warm | 1 frame | 7 ms (6–14) | 10 ms (1–14) |
| FL-16 | ⌘T → bar visible, first open after launch | 1 frame | **gap**: 35 ms (27–57) | **gap**: 22 ms (14–22) |
| FL-16 | ⌘L → bar visible | 1 frame | 16 ms (8–21) | 10 ms (4–11) |
| FL-16 | Entrance: first frame to opaque and full size | 120–160 ms | 150 ms | 133 ms (117–133) |
| FL-16 | Entrance: first frame scale / drop / overshoot | 0.97 / −4 px / none | 0.97 / −3.8 px / 1.00 | 0.98 / −2.5 px / 1.00 |
| FL-16 | Page dimming (scrim alpha) | none or very slight | 0.07 | 0.07 |
| FL-16 | ⌘T then "abc" at once: keys kept | 3 of 3 | 3 | 3 |
| FL-16 | Escape → bar gone / smallest scale | 100–120 ms / 0.98 | 91 ms (87–98) / 0.98 | 100 ms (91–102) / 0.98 |
| FL-16 | Enter on a result → bar gone | ≈ 80 ms | 91 ms (84–93) | 74 ms (73–82) |
| FL-17 | Keystroke → field shows it, worst | 1 frame | 1 frame | 1 frame |
| FL-17 | Keystroke → local results, worst / median | ≤ 50 ms / 1 frame | 23 ms (22–35) / 14 ms (9–15) | 20 ms (19–26) / 14 ms (14–15) |
| FL-17 | Late suggestions: highlight moved / list bounces | 0 / 0 | 0 / 0 | 0 / 0 |
| FL-17 | ↑/↓ → highlight moved | 1 frame | 1 frame | 1 frame |
| FL-18 | Tab dragged onto the page: zone drawn (the page the drag began on comes back first) | while over the page | 56 ms (52–72) | 86 ms (65–88) |
| FL-18 | The move that finds the zone → zone drawn / its fade in | ≤ 2 frames (a fade from 0) / ≈ 100 ms | **gap**: 3 frames / 83 ms (83–100) | **gap**: 3 frames / 83 ms (83–100) |
| FL-18 | Zone width, share of the page | ≈ 50 % (the half) | 49% | 49% |
| FL-18 | Pointer to another half → zone in its new place | at once (FL-18); ≈ 120 ms ease (SV-26) | **gap**: 341 ms (326–341) | 24 ms (22–24) |
| FL-18 | Release → both panes within 2 px / within 0.5 px | ≤ 350 ms | 25 ms (11–27) / 25 ms (11–27) | 26 ms (11–27) / 26 ms (11–27) |
| FL-18 | Pane added: first frame → both within 2 px / within 0.5 px | 260–300 ms, ≤ 350 ms | **gap**: 283 ms (283–317) / 483 ms (467–500) | **gap**: 300 ms (283–333) / 483 ms (467–483) |
| FL-18 | Pane added: overshoot | none visible | 1.4 px | 1.4 px |
| FL-18 | Divider drag: frames off the pointer by > 1 px | 0 (1:1) | 0 | 0 |
| FL-18 | Flip: first move → panes within 2 px / within 0.5 px | ≈ 300 ms | 267 ms (267–283) / 450 ms (450–467) | 267 ms (233–283) / 450 ms |
| FL-18 | Close a pane: first move → the other within 2 px / within 0.5 px | 260–300 ms | 283 ms (267–283) / 450 ms (433–450) | 267 ms / 433 ms |
| FL-18 | Largest step of a pane edge: add / flip / close | < 60 % (no jump) | 25% / 26% / 25% | 24% / 26% / 24% |
| FL-19 | Click on a link in a pinned tab → card first drawn / its width, share of the card | – / small (grows from the link) | 57 ms (46–63) / 14% | 47 ms (44–51) / 14% |
| FL-19 | Open: first frame → card within 2 px / within 0.5 px | 280–320 ms | 317 ms (317–333) / 350 ms (350–383) | 317 ms / 367 ms (350–383) |
| FL-19 | Open: overshoot / card size, share of the page area / page dimmed by | ≤ 2 % / ≈ 90 % / 10–20 % | 0% / 90% / 18% | 0% / 90% / 18% |
| FL-19 | Open: frame p99 / max | ≤ 16.7 / ≤ 33.3 ms (FL-29) | **gap**: 50.0 / 50.0 ms | **gap**: 33.4 / 33.4 ms |
| FL-19 | Escape → card starts closing | 1 frame (FL-29) | **gap**: 2 frames | **gap**: 2 frames |
| FL-19 | Close: first frame → last frame of the fade / smallest scale | 150–180 ms / ≈ 0.96 | 133 ms (117–133) / 0.96 | 150 ms (133–150) / 0.96 |
| FL-19 | Escape → no layer over the page (it takes clicks) | ≤ 200 ms | 192 ms (187–200) | 183 ms (173–194), best of up to three rounds; 4 of 10 rounds took 201–215 ms |
| FL-19 | ⌘O: first move → edges within 2 px / meet the page card (0.5 px) | 220–260 ms | 183 ms (183–200) / 233 ms (233–250) | 200 ms (167–217) / 250 ms (233–250) |
| FL-20 | New Favorite: first frame scale / largest scale | ≈ 0.85 / ≤ 1.04 | 0.85 / 1.007 | 0.85 / 1.007 |
| FL-20 | Other tiles: largest step share | < 60 % | 17% (17–18) | 17% (16–17) |
| FL-20 | Removed Favorite: smallest scale drawn / frames fading | ≈ 0.85 / ≈ 150 ms of frames | **gap**: 0.99 / 10 | 0.85 / 10 |
| FL-21 | 200 tabs, fling: frame p99 / max | ≤ 16.7 / ≤ 33.3 ms | **gap**: 33.4 / 33.4 ms | **gap**: 33.4 / 33.4 ms |
| FL-21 | 200 tabs, fling: frames over one interval | 0 | **gap**: 8 (4–10) | **gap**: 5 (5–11) |
| FL-21 | 500 tabs + 50 folders, scroll: frame p99 / max | ≤ 16.7 / ≤ 33.3 ms | **gap**: 50.1 / 50.1 ms | **gap**: 33.4 / 33.4 ms |
| FL-21 | 500 tabs + 50 folders: frames over one interval | 0 | **gap**: 102 (84–128) | **gap**: 12 (5–24) |
| FL-21 | Switch to a 200-tab Space never shown: first frame with its rows | ≤ 100 ms (§8) | **gap**: 231 ms (210–247) | 11 ms (11–13) |
| FL-21 | … its own list drawn (interactive) | ≤ 350 ms (before the slide ends) | 231 ms (210–247) | 161 ms (144–163) |
| FL-21 | … longest task / frame max | < 50 / ≤ 33.3 ms | **gap**: 258 / 283 ms | **gap**: 57 / 67 ms |
| FL-21 | 300 tabs: rows on screen drawing nothing (wheel, keys, a tab found, a drag) | 0 in every frame |  | 0 |
| FL-21 | 200 Today tabs, the 151st selected, list at the top: the place and list size a screen reader is told | each row's own place, of 200 | **gap**: of 69 (69 rows in the tree; the 151st comes right after the 68th) | its own place, of 200 (45 rows in the tree, the 151st among them) |
| FL-22 | Toast in: first frame below its place / scale | ≈ 12 px / ≈ 0.96 | **gap**: 6 px / 0.98 (a 220 ms keyframe) | 12.6 px / 0.96 |
| FL-22 | Toast in: first frame → in place / largest scale | 200–250 ms / ≤ 1.03 | 220 ms / 1 | 233 ms (233–250) / 1.002 |
| FL-22 | Three stacked: gaps off 8 px / older pushed up, largest step share | 0 px / < 60 % | **gap**: 2 px (6 apart) / 100 % (jumped) | 0 px / 16% (16–17) |
| FL-22 | Shown → starts leaving, shortest | 3–4 s | **gap**: 2200 ms | 3000 ms (3000–3017) |
| FL-22 | Leaving: fade / drop | 150–180 ms / ≈ 8 px | **gap**: none (removed) / 0 px | 183 ms (167–183) / 8.0 px |
| FL-23 | Slow page: load start → pill drawn | ≈ 150 ms (not before 120) |  | 150 ms (145–152) |
| FL-23 | Sweep: one turn | 1–1.4 s |  | 1200 ms |
| FL-23 | Frame p99 / max in the indicator while sweeping | ≤ 16.7 / ≤ 33.3 ms |  | 16.8 / 33.3 ms |
| FL-23 | Load end → pill gone / frames of its fade | ≤ 200 ms / a fade |  | 182 ms / 9 |
| FL-23 | Cached reload (start → stop, longest of 3): indicator shown | 0 times (a 50 ms load) |  | 54 ms (44–57): 0 |
| FL-25 | Folder search: click → first drawn / first frame scale | 1 frame / ≈ 0.97 | **gap**: 2 frames / 0.98 | 1 frame / 0.99 |
| FL-25 | Click → fully open | ≈ 150 ms (snappy) | 131 ms (130–136) | 120 ms (117–127) |
| FL-25 | Escape → gone / frames closing | ≈ 90–130 ms / ≥ 2 | **gap**: 9 ms (6–15) / 0 | 84 ms (82–92) / 5 |
| FL-26 | Holding ⌃: one Tab held → the list drawn | after a hold of about 150 ms |  | 165 ms (160–170) |
| FL-26 | … a second Tab → the list drawn | 1 frame |  | **gap**: 2 frames, 40 ms (26–41), at load 16–18; 1 frame at load 6.6 |
| FL-26 | … each further Tab → the highlight moved | 1 frame (at once) | 1 frame, 10 ms (3–26) (the sidebar row; there was no list) | 1 frame (1–2) |
| FL-26 | The list: fade in, first frame to full / movement while it shows | ≤ 100 ms / no slide |  | 100 ms (83–117), 90 ms set / 0 px |
| FL-26 | Holding ⌃ → pages shown before ⌃ is let go | none (TB-05) | **gap**: each Tab's, 8 ms (6–12) after the first Tab, 1 ms (1–2) after the second | none |
| FL-26 | Letting go of ⌃ → list hidden after the page shown | 0 (the same frame) | 0 frames that changed the highlight (no list) | 1.3 ms (1.2–1.6), in the same task in main |
| FL-27 | Window loses focus (main’s blur) → sidebar starts dimming | at once |  | 20 ms (16–43) |
| FL-27 | Blur: sidebar dimming takes / frames in between | ≈ 150 ms / a fade |  | 133 ms / 8 |
| FL-27 | Focus → sidebar bright again / frames in between | at once / 0 |  | 10 ms (9–11) / 0 |
| FL-27 | Window resized a step a frame: frames with the card off its margin | 0 |  | 0 |
| FL-27 | … card draws a width → main gives the page view that width, median / worst | ≤ 1 frame |  | **gap**: 9.3 ms / 18.2 ms |
| FL-27 | … frames where the card under the page is not the page’s colour | 0 (no white) |  | 0 |
| FL-28 | Reduced motion (system), ⌘⌥→: horizontal movement | 0 px | 0 px | 0 px |
| FL-28 | Reduced motion (system), ⌘⌥→: new Space shown / cross-fade done | first frame / < 150 ms | **gap**: 15 ms (7–17) / 182 ms (174–184) | 12 ms (9–19) / 129 ms (126–136) |
| FL-28 | Reduced motion (Orbit setting), ⌘⌥→: movement / cross-fade done | 0 px / < 150 ms |  | 0 px / 125 ms (122–136) |
| FL-28 | Reduced motion (Orbit setting / system), a toast: first frame below its place / its scale | 0 px / 1 | **gap**: 12.4 / 12.5 px, 0.961 | 0 px / 1 |
| FL-28 | … the older toast pushed up: frames moving / a toast leaving: its drop | 1 (at once) / 0 px | **gap**: 12 / 11 frames, 8 px | 1 / 0 px |
| FL-28 | … a toast's fade in / frames of its fade out | short fades |  | 117 ms (100–117) / 7–8 |
| FL-28 | Turned on (Orbit setting / system) after the Favorites showed: a new Favorite, the other tiles moving / a removed one, its smallest scale | 1 frame / 1 | **gap**: 11–12 frames / 0.85 | 1 frame / 1 |
| FL-28 | … the grid closing up / the removed tile shown faded | 1 frame / ≤ 150 ms | **gap**: 12–13 frames / 133 ms | 1 frame / 83–100 ms |
| FL-28 | Turned on after a folder was opened: closing it, the content below / the chevron | 1 frame / 1 frame | **gap**: 11 / 9 frames | 1 / 1 |
| FL-28 | … collapsing the pinned section: the content below / the caret | 1 frame / 1 frame | **gap**: 8 / 8–9 frames | 1 / 1 |
| FL-28 | Turned on after they showed: a Favorite / the "+" pressed, its scale | 1 (no nudge) | **gap**: 0.94 / 0.92 | 1 / 1 |
| FL-29 | Space shortcut → slide starts | 1 frame | 1 frame | 1 frame |
| FL-29 | Space shortcut → settled | ≤ 350 ms | **gap**: 409 ms (409–410) | 292 ms (285–299) |
| FL-29 | Frame p99 / max during the slide | ≤ 16.7 / ≤ 33.3 ms | 16.8 / 16.8 ms | 16.8 / 16.8 ms |

### Notes

- **FL-01:** interrupted motions turn round from where they are. Before, the hover sidebar slid fully out (270 px) before it came back.
  - Each check compares speeds (a step over its frame's time), from the first frame that shows the input handled: the bar that is closing, or the value turning. A frame that comes late can't pass for a jump. Until review M4 the checks compared steps from the frame after main had the input, and the Before column is in that measure.
  - The bar fades in fast, so a jump to the end would be no faster than its entrance. Its exit must also fade over 3 frames or more, in up to three rounds (D46). With the exit made a jump, 4 runs of 4 failed.
  - After: 20 runs of the four tests at load 3.9–8.4. All passed, the bar in its first round.
- **FL-02:** ⌘S now moves the sidebar in the frame that draws the change: the transition starts a frame along (`--motion-lead`).
  - Every hide, before and after, has one frame that takes two intervals. With about 15 frames in a hide, that frame sets both the p99 and the max.
  - Not fixed.
- **FL-03:** the hover sidebar is a view of its own. Main sees the pointer at the edge and places the view, then the view draws.
  - So its first moving frame comes 29–45 ms after the pointer. One frame would need the card drawn in the shell itself. Not changed.
  - It leaves 400 ms after the pointer does (`HIDE_GRACE_MS`), and main removes the view 200 ms later.
  - The leave row's Before polled at Playwright's default steps (100, 350 and 850 ms), so 893 ms meant "gone between the polls at 350 and 850 ms". The test now polls every 16 ms.
- **FL-05:**
  - A press now selects its row in the frame it lands in, and the old highlight hands over in that same frame. Before, there were 83 ms with no row lit.
  - A press in the first frame after a row grows in now selects that row. Before, the press landed on the row's slot (PR #10 review F1).
  - A selected row out of sight scrolls in on Orbit's own ease-out (`EASE.instant`, 225 ms), drawn a frame along so its first frame already moves. From more than two screens away, or with reduced motion, it is there at once. Before, Chromium's smooth scroll eased in and took 417–467 ms from further away (review M5). Three runs at load 2.6–4.1, the same each time.
- **FL-07:** the row travels with the standard spring, as FL-07 asks.
  - FL-01 times that spring at about 260–300 ms, so FL-07's "about 250 ms" reads 276–286 ms within 0.5 px.
  - Known gap: at the very end of a scrolled list, a row that leaves makes the list shorter, and the browser clamps the scroll position. The rows in sight then move up. The test scrolls to a place with room below.
- **FL-08:** the row starts leaving 2 frames after the release, once main has closed the tab (D70). FL-08 asks for the release's own frame, but main decides first: a pinned tab's × resets it (PN-04), and a page may ask to stay (NV-24).
  - The pinned tab's reset (PN-04) still acts on press; its circle now fades in like the ×'s.
- **FL-09:** main wakes a sleeping tab's page only once the change has gone out to the shell (`windows.ts`, `fastSwitch`), so the next row is selected in the first frame drawn after ⌘W. Waking the page first takes main about 13 ms, which holds the change back a frame.
  - The test closes five tabs a round, each with a sleeping tab below it, and judges the round on their median, in up to three rounds (D46). A key that comes as the shell starts a frame can't show in that frame. No close of the round may take more than 2 frames, the first after a launch included (fix check N3), so a change that slows two closes in five fails.
  - With the deferral, 5 runs of 5 passed in their first round at load 4.5–6.2, and 22 of their 25 closes took 1 frame. With 28 busy threads beside it (load 16–32), 10 runs of 10 passed: 7 in the first round, 2 in the second and 1 in the third.
  - With the deferral taken out, 5 runs of 5 failed. Every round had a median of 2 frames, 24–27 ms after the key (71 of 75 closes in 2 frames).
  - Gap: the first close after a launch took 2 frames in 10 runs of 15. Main sends that first change out 7–12 ms after the key, against 2–3.5 ms for later closes: the key's route, the close and the state update all run as cold code the first time. At `5416e5c`, before the lane took in the keys lane's key router from `main`, that close took 1 frame (11 ms, 7–17).
- **FL-11:** audited. It was already within its targets; the test is new.
- **FL-12:**
  - The chevron's tween is 160 ms (`CHEVRON` in `ItemList.tsx`) on the snappy ease. Its last frames turn less than 0.5°, so first-to-last moving frame reads 133 ms.
  - The children fade in 12 ms apart, so six of them span four frames.
- **FL-13:** the swipe's settle and the flick are within budget. Both are timed from the last wheel event, including the 90 ms wait that detects the release, and the settle spring starts with the release velocity.
  - The rubber band returns with the spring FL-13 gives it (response 0.3 s, ratio 1.0). From a third of the width that spring needs about 390 ms to come within 0.5 px, or 478 ms with the release wait. FL-29's 350 ms is for swipes that land on a Space, so the rubber band keeps FL-13's spring (D70).
- **FL-15:** the release uses the pop spring (0.30 s, damping 0.70), as FL-15 asks; the spec gives it no time. From 0.94 the button is within 0.2 % of full size 193 ms after the release.
- **FL-16:** the first ⌘T after a launch showed the bar in the second frame in two runs of three (14, 22 and 22 ms). Warm opens show it in the first frame.
- **FL-18:**
  - The zone shows 3 frames after the move that finds it, for two reasons. A fade from 0 shows only from its second frame, and React renders a pointer move's state in a task of its own, which can miss the next frame. Over seven runs it took 2–4 frames.
  - The zone now moves to a new half at once, as FL-18 asks. SV-26's 120 ms ease defers to feel.md.
  - The page makes room while the zone shows, so on release the new pane only takes the zone's place.
  - Adding a pane, a flip and closing a pane use the standard spring. The panes are within 2 px in 267–300 ms, as the spec asks, but within 0.5 px only at 433–483 ms, after a 1.4 px (0.2 %) overshoot.
  - Not built: the "bubble" while a tab hovers another tab's row, and the wobble on drop.
- **FL-19:** the close's tween and the expand's spring now start their clocks when they are called, so their first frame already moves. This is a timing change in the peek lane's `PeekLayer.tsx`, shown by `feel-peek.spec.ts`.
  - The open uses a spring tuned to FL-19's 280–320 ms (response 0.275 s, ratio 0.92). The standard spring FL-19 names takes longer than 320 ms over a card's travel (D70).
  - The layer goes when the close's curve ends, as it did before the lane. The lane had made it go once the card and the dim were under 0.1 %; no test showed that was needed, so it came out in fix round 1 (review follow-up 3).
  - Six runs at load 15–19, each in up to three rounds (D46), took 173–194 ms at their best; 4 of their 10 rounds took 201–215 ms. That is at the edge of the target: the close starts in the second frame and runs 160 ms.
  - Two gaps remain:
    - During the open, the overlay draws at 30 fps on this machine while main moves the page view every frame, so p99 is two intervals. A fix belongs in `src/main/peek/`, which is the peek lane's.
    - Escape goes through main to the overlay view, so the close starts in the second frame (as with FL-03).
- **FL-20:** a removed Favorite used to fade at full size. It now shrinks to 0.85 where it was.
- **FL-21:** only the rows near the visible band are drawn. A Space shown for the first time draws a stand-in at once (11 ms) and its own list by 161 ms.
  - Under load 3–4 the long lists still have frames of two intervals, so p99 is two intervals: 5 such frames per 200-tab fling, and 12 per 500-tab scroll (was 102).
  - The longest task during a first showing is 57 ms (was 258 ms).
  - Rows that aren't drawn leave no hole for a screen reader: every row says its place in its list and the list's size (`aria-posinset`, `aria-setsize`), and its depth. Arrow keys, Home and End walk every row, drawn or not (review M3). Three runs at load 2.2–3.
- **FL-22:** built as FL-22 says, with one exception: plain toasts let clicks through, and only a toast with a button holds on hover.
- **FL-23:** audited, not changed. The pill shows at 150 ms, and never for a fast load.
- **FL-25:** the folder search popover now shows in its first frame and closes with the quick fade. Before, it took 2 frames to show and was gone at once.
- **FL-26:** built with TB-05's list (the finish-tabs lane). The first Tab opens the switcher in the overlay without drawing it. The list is drawn at the second Tab or after a 150 ms hold, and fades in over 90 ms (`--motion-instant`) with no slide. The highlight has no transition.
  - The page stays as it is until ⌃ is let go. Then main shows the highlighted tab's page and hides the overlay's layer in the same task, with no fade out.
  - The fade reads up to a frame longer than set: the list's first frame is drawn before its animation's clock starts (as `feel-reduced` allows).
  - At load 16–18 the list was drawn in the second frame after the second Tab, in each of three runs. In one run at load 6.6 it was drawn in the first.
  - Under reduced motion the list shows at full opacity in its first frame (`feel-reduced`).
- **FL-27:** audited, not changed.
  - Main's blur reaches the shell over IPC, so the dimming starts 1–3 frames later.
  - On a window resized a step every frame, X merges steps: 8–10 of 16 widths are drawn. The page view gets the card's width within a frame at the median and in 18 ms at worst (25 ms in one run). Any gap shows the page's own colour.
- **FL-28:** the cross-fade is 120 ms (`--motion-fade`). It is done 122–136 ms after the shortcut, where it took 182 ms before.
  - Toasts follow reduced motion, Orbit's switch or the system's (review M1). A toast fades in where it rests and fades out there, and the older one moves up at once. 20 runs (10 per setting) at load 2.9–4.2. Before, a toast rose 12 px from 0.96 and the push glided, and once under the config, motion still jumped the moves in a frame of their own: 12.6 px low in the first frame in 2 runs of 10, and an 8 px drop on leaving in all 10.
  - Turned on while Orbit runs, reduced motion now reaches what is already on screen (fix check N1). motion reads `OrbitMotionConfig` once, as an element mounts. So the Favorites tiles, a folder's or the pinned section's box, the chevrons, the "+", the drag ghost and the popovers each ask `useReducedMotion()` and choose their reduced motion from it: no layout animation, no scale on the way in or out, moves and turns at once, and 120 ms fades. A press no longer nudges a tile or the "+" (FL-28: decorative motion is off).
  - `feel-reduced` turns the setting on after these show: the Favorites under both settings, a folder and the pinned section under Orbit's, and the presses. 10 runs of the Favorites test (5 per setting) and 5 of each of the others, at load 1.5–2.9. Before, the tiles glided over 11–12 frames, a removed tile shrank to 0.85, a folder closed over 11 frames with its chevron turning over 9, and a press still scaled to 0.94 and 0.92.
  - `tests/unit/reduced-motion-guard.test.ts` reads the renderer's code:
    - every component that renders motion's components sits under `OrbitMotionConfig` or reads reduced motion;
    - every motion element that animates its layout, an entrance, an exit or a gesture, or whose `animate` moves, turns or resizes it, sits in a component that calls `useReducedMotion()`, since the config reaches an element only as it mounts. Rows whose variants ask `reducedMotion()` as they run are the one exception;
    - the hook is Orbit's (`motion/reduced.ts`), never motion's own, which follows the OS alone;
    - every file that calls motion's `animate()` reads it;
    - no stylesheet keys a rule off the media query alone.

    Run on the code before N1's fix, the second check named 11 components in 8 files: the Favorites grid and its tiles, the split tile, the folder's box and row, the space header, the Today block, the drag ghost, both popovers and the downloads flyout.
- **FL-29:** the Space shortcut now settles in 292 ms (was 409 ms). The other budgets are in the rows for FL-02, 03, 05, 09, 10, 13, 16 and 17.
  - FL-13's rubber band comes back in 478 ms on FL-13's own spring. FL-29's 350 ms is for swipes that land on a Space (D70).
  - ⌘W selects the next tab in 1 frame at the median of five closes. The first close after a launch took 2 frames in 10 runs of 15 (FL-09).

### Not measured or not built

- **FL-24** (P2, the Library's first open): not measured in this lane.
- **FL-31** (P2, haptics): not built. There are no trackpad haptics on Linux.
- **FL-18's** bubble and wobble (see the notes above).

## FL-30 checklist

FL-30's nine points, judged against the spec's numbers and observables. The evidence is in the table above and in the named specs.

| # | Point | Verdict | Evidence |
|---|---|---|---|
| 1 | Your hand is never ahead of the screen | pass | No frame where the input leads the screen: 0 for a dragged row (FL-10), the swiped pages (FL-13) and the split divider (FL-18). The card keeps its margin in every frame of a resize (FL-27). Specs: `feel-rows`, `feel-spaces`, `feel-split`, `feel-window`. Not checked: the OS scroll direction, since Xvfb sends wheel events only. |
| 2 | Momentum is respected | pass | A flick (23 % of the width) settles 276 ms after its last event, and a slow swipe 412 ms. The settle spring starts with the release velocity. A second shortcut carries the running slide on, with no jump (FL-01). Specs: `feel-spaces`, `feel-motion`. The rubber band comes back in 478 ms on FL-13's own spring; FL-29's 350 ms is for swipes that land on a Space (D70). |
| 3 | Clicks feel instant | fixed, gaps listed | Press → highlight in 8 ms (was 92); ⌘W selects the next tab in 1 frame at the median of five closes (was 3); ⌘S moves in 1 frame (was 2). The command bar shows in 1 frame, and the × and the icon buttons press at once. Specs: `feel-rows`, `feel-sidebar`, `feel-commandbar`, `feel-chrome`. Gaps: the hover sidebar and the Peek's close start in the second frame (separate views), the first ⌘T after a launch showed in the second frame in two runs of three, and the first ⌘W after a launch took 2 frames in 10 runs of 15. |
| 4 | Nothing flashes | partial | No grey frame between two themes (FL-14). Late suggestions move nothing (FL-17). No row on screen is drawn empty (FL-21). Resize gaps show the page's colour (FL-27). There is never a frame with no row selected (FL-05; was 83 ms). Hover fades out from where it is (FL-04). Not measured: hover flicker during a drag, favicons arriving, and the screen's own pixels (the specs read the DOM). |
| 5 | One motion vocabulary | fixed | The tokens live in `src/shared/motion.ts` and `src/renderer/src/motion/motion.css`, and `tests/unit/motion-tokens.test.ts` checks them against each other. The lane moved the components it touched onto them. Timings the spec sets apart keep their own: the FL-23 sweep (1.2 s), the FL-12 chevron (160 ms) and FL-28's cross-fade (120 ms). |
| 6 | Colour moves with space | pass | A swipe from a blue to an orange Space draws 16 colours in between, with no grey frame and titles at 9.8:1 (FL-14, `feel-spaces`). |
| 7 | Native window behaviour | not measured | Linux on Xvfb has no system material, trackpad or haptics. Built, but not measured here: OS window controls, draggable areas, native menus, OS full screen and new windows a step down and right (NV-10). Haptics (FL-31, P2) are not built. |
| 8 | Small, playful touches that never get in the way | fixed | FL-08, FL-15, FL-20 and FL-22 were added or reworked, and FL-23 was audited. Under reduced motion they become fades or nothing. `tests/unit/reduced-motion-guard.test.ts` checks that every motion component sits under the config or reads the setting. It also checks that every element with a layout animation, an entrance, an exit, a press or a moving `animate` asks `useReducedMotion()`, so the setting reaches it when it changes, not only when it mounts. `feel-reduced` checks the toasts frame by frame under both settings, and the Favorites, a folder, the pinned section and the presses with the setting turned on after they show. The action never waits for them: buttons fire on release, the reset on press, shortcuts on the key (`feel-chrome`, `feel-rows`). |
| 9 | Scale doesn't change the feel | partial | 500 tabs and 50 folders scroll with 12 frames over one interval (was 102). A 200-tab Space shown for the first time draws a stand-in in 11 ms and its list in 161 ms (was 231 ms, behind a 258 ms task). With 300 tabs, no row is drawn empty. Spec: `feel-sidebar`. Gap: p99 is still two intervals under load, and a first showing still has a 57 ms task. |
