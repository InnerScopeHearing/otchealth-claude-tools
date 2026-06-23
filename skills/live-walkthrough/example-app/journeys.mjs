// example-app/journeys.mjs — a MINIMAL reference of the app-specific journeys
// module, showing the exact shape the runner expects. Copy this into your app at
// qa/live-walkthrough/journeys.mjs and write one journey per focus-group persona.
//
// CONTRACT (what the runner imports from this file):
//   export const JOURNEYS = [ <journey>, ... ]
//
// A JOURNEY object:
//   id        string   unique slug (used in artifact filenames + --journeys filter)
//   group     string   "customer" | "professional" | "investor" (free-form label)
//   persona   string   the persona one-liner (who is walking)
//   goal      string   what they are trying to do
//   start     string   the path to open first (e.g. "/" or "/signin")
//   auth      boolean  (optional) false = walk LOGGED OUT (installStubs gets
//                      authenticated:false), for a cold-open / sign-in persona.
//                      Default/omitted = a faked signed-in session.
//   steps     array    ordered real interactions (step kinds below)
//
// STEP KINDS (each maps to a real Playwright action in the runner):
//   { goto: "/path" }                      hard-navigate (deep link / fresh entry)
//   { tapTestId: "tab-home" }              touchscreen tap by data-testid
//   { tapText: "Sign in" }                 tap by visible text (substring match)
//   { tapRole: ["button","Save"] }         tap by [role, accessible-name]
//   { scroll: "down" | "up" | <number> }   wheel + programmatic scroll of the scroller
//   { swipe: "left"|"right"|"up"|"down" }  a real touch drag across the viewport
//   { drag: { testId, dx, dy } }           press-move-release drag of one element
//   { type: { testId|role, value } }       type into a field
//   { expectPath: /regex/ }                assert the route changed (funnel progressed);
//                                          a miss is reported as a DEAD prior control
//   { settle: <ms> }                       wait for animation/load to settle (max 3000)
//   { note: "..." }                        narration only (e.g. "here I'd use the camera")
//
// The `note` narration is gold for the device-QA pass: leave a breadcrumb at every
// native boundary the browser cannot cross (camera, purchase sheet, SiwA, push).

export const JOURNEYS = [
  {
    id: "first-open-sam",
    group: "customer",
    persona: "Sam, 60, opens the app for the first time and pokes around",
    goal: "Land on the home screen, scroll it, and reach the About page.",
    start: "/",
    steps: [
      { settle: 300, note: "First impression of the home screen." },
      { scroll: "down" },
      { scroll: "up" },
      { tapTestId: "link-about" },
      { expectPath: /\/about$/ },
      { settle: 200, note: "The About page; can I read everything at this size?" },
    ],
  },
];
