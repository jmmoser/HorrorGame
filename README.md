# THE DESCENT LEDGER

A web-based, mobile-first psychological horror game. You are a building
inspector documenting a condemned high-rise, floor by floor, descending.
The building has been empty for thirty years. It does not behave empty.

**The elevator only goes down.**

![Floor −03, moonlight-blue open plan](docs/screenshots/floor-3.png)
![Floor −04, tungsten archive stacks](docs/screenshots/floor-4.png)

There is something on every floor with you. It does not move while you are
looking at it. It is closer every time you look away.

> **Warning.** This build ships at its maximum setting by default. It contains
> sudden full-screen images, screaming and impact sounds at full level, rapid
> flashing, and a pursuing entity. If that is not what you want — or if you
> are photosensitive — set **exposure** in Form 7-B (the settings form) before
> you begin. **`survey only`** restores the original inspection exactly: no
> entity, no stingers, no flashes, no camera shake. The intermediate settings
> scale everything between the two.

Still no death, and still no fail state. There is, now, a cost: the thing on
the floor with you takes pages. The slow, compounding wrongness of beautiful
empty spaces is all still here and still does most of the work — the
difference is that the building has stopped waiting for you to notice, and
that what you write down can be taken back.

**And it has started watching back.** The previous build's answer to "make it
worse" was rate: something landed every one to three seconds. That is the one
change that reliably makes a horror game *less* frightening — a shock every two
seconds is a metronome, and you can stand inside a metronome. Players stopped
flinching before the end of the first floor.

So the escalation was moved somewhere it compounds instead of wearing out. The
building now runs a **cycle** rather than a timer, it **holds its breath**
before most of what it does and about a quarter of the time that breath
resolves into nothing at all, and it **keeps a score of what actually works on
you** — measured off your own hands, in the two seconds after each shock — and
reaches for that. There are fewer events per minute than the build before it
and it is substantially harder to sit through, because the quiet is no longer
time off.

## The vertical slice (this build)

- **Five hand-authored floors**, one controlled palette each: fluorescent
  green offices, a sodium-orange residential corridor, moonlight-blue open
  plan, tungsten archive stacks, and a near-dark lower lobby.
- **The full core loop** — the elevator opens onto a floor with its **filed
  schedule** ("ROOMS 101–105 · TWO CORRIDOR DOORS"); find the discrepancies by
  checking the building against the schedule and the blueprint; log them; the
  call button lights; descend.
- **Everything is loggable.** Every prop can be documented, not just the wrong
  ones — the reticle marks what can be aimed at, never what is wrong. Logging
  a correct desk writes a dry "no deviation" entry. Judgment is the game:
  the schedule and blueprint are the only authorities on what shouldn't be
  there, and being thorough has a cost (see attention, below).
- **Documentation is an act, not a tap.** Logging holds the frame for a
  second — a ring fills, the FOV narrows a breath, you cannot move — before
  the pencil writes. The building's favorite moment to make a sound.
- **The wrongness system** — 15 discrepancy types across Tiers 1–2
  (architectural and temporal): a door that is not on the blueprint, a
  corridor longer than the one above it, a window showing daylight at night,
  two rooms that are the same room, a calendar showing today's real date, a
  clock running backward, coffee still steaming after thirty years, fresh
  footprints, a dial tone on a dead line…
- **Per-player seeds.** A stable seed chosen at first launch drives which
  discrepancies spawn on each floor: every floor's pool is larger than the
  number that spawn (seven authored discrepancies on most floors, four or
  five of them chosen per case), so your floor 2 is not your friend's
  floor 2. A few entry variants are rare (<1% of players). Compare notes.
- **Logging changes the floor.** Some discrepancies, once logged, silently
  change something elsewhere — a closed door now ajar, a corridor light now
  dead. Changes are never shown happening. They are only ever discovered.
- **Amendments.** A changed prop can be logged a *second* time — a red-ink
  amendment ("the door I recorded closed is standing open"). Backtracking is
  rewarded; the record becomes a correspondence with the building.
- **Attention.** The building reads the ledger. Every entry past the quota,
  every amendment, every "no deviation" raises its attention on that floor:
  occupancy sounds come sooner and closer, the room tone thickens, and at
  thresholds the building answers with alterations of its own — which become
  new amendments to find. Curiosity vs. nerve is the floor-level decision:
  the call button is lit, and you are still writing.
- **The presence.** A figure, too tall and too thin, built from the same
  primitives as the furniture and wearing a procedurally drawn face that is
  unlit — the same brightness at twenty metres as at one, which is why you
  find it before you find anything else in the dark. It obeys the old rule:
  it holds still while observed, walks when it is not, and takes steps you
  never saw it take. Past the halfway point of a floor's intensity it stops
  obeying, creeps while you watch, and eventually simply runs at you. Reaching
  you is not a death — it is an arrival: the whole frame becomes its face, and
  then there is nothing there and the ledger says there never was.
  Three things changed when the building stopped being polite. It no longer
  walks at where you *are* but at where you are going to be, which is why
  corners stopped working and why it is sometimes already at the far end of
  the corridor you were about to turn into. When it moves unseen it can now
  choose the bearing you are not covering rather than merely a nearer one.
  And when you stop to document something, **it stops too, and raises its
  hands to the same height as yours, and holds them there** — whatever else it
  is doing on this floor, it is also keeping a record. How long it stays gone
  after an arrival collapses with depth: early on, reaching you costs it the
  rest of the corridor; deep in, it is back before your hands have stopped.
- **It can be documented.** It is not on the schedule, which makes it the
  best finding on the floor. Hold the ledger on it from within nine metres —
  it holds still for that, as it holds still for everything — and after a
  long second it is filed: an entry in the inspector's hand, a count toward
  the quota, and the figure gone for most of the floor. It cannot be filed
  once it has started coming. The floor's tension is that arithmetic: find it
  and hold on it before it decides to stop waiting.
- **It takes pages.** When it reaches you, the most recent page written on
  that floor is torn out. The stub stays in the ledger, numbered, struck
  through; the thing it recorded is unrecorded again and has to be documented
  a second time. If that drops the floor under quota, the call button goes
  dark. Filed floors are safe. This is the whole cost, and it is enough:
  every entry past the quota is now something you can lose, and the way to
  keep it is to stop writing and leave.
- **The building writes in your ledger, about you.** Entries appear in the
  inspector's own record, in the inspector's own format, numbered in the
  inspector's own sequence — struck through the page by something with a
  platen instead of a pencil. They are about the person playing: that they
  have stopped in the corridor and are listening, and for how many seconds;
  that they have checked behind themselves four times on this floor and were
  right to once; that they are reading this entry, and have read it twice.
  They carry the time on your actual wall, and some of them are stamped from
  further along the clock than you have got to. When the watcher is confident,
  one of them tells you what it has worked out about you — *"the inspector is
  afraid of the dark. the building has a great deal of it."* It is the
  cheapest system in the build and the only one that cannot be dismissed as
  something that happened to the character, because the character does not
  have a clock and you do.
- **The car is no longer safe.** Four floors of descending have taught you
  that nothing happens in the elevator. Below floor three that stops being
  true: sealed in a metal box, in the dark, frozen, with the doors shut, and
  something breathing in it with you.
- **The director, as a cycle.** A per-floor intensity — depth, attention, how
  long you have been on this floor, how close the thing is — spent on sixteen
  kinds of shock, but spent in a shape rather than at a rate:
  **stalk** (ordinary time) → **tell** → **strike** → **void**. Twelve of the
  sixteen are the loud ones: subliminal face flashes, held faces, signal loss,
  whispers at ear distance, screams sourced behind walls, body-weight impacts,
  breathing that stops mid-breath, blackouts that end on a face, words written
  across the lens, shapes crossing the beam, your head being turned for you,
  and the floor dropping a metre. At high intensity a strike is sometimes a
  **volley** — three or four inside a single second — instead of one thing.
- **The held breath.** Before most strikes the building stops. The room tone,
  the ventilation and the descent drone — the three sounds that have run
  without interruption since you put the headphones on — withdraw together;
  the flashlight's bad connection stops for the first time since you arrived;
  the camera's permanent sway goes flat. What is left is a tone under hearing
  and your own pulse, rising for anything from three to ten seconds. **About a
  quarter of them resolve into nothing at all.** That dry one is the most
  valuable event in the build: after the third, the held breath stops being a
  warning and becomes somewhere you have to live.
- **The four quiet scares.** None of these announce themselves, and between
  them they are why the loud twelve still work on floor four. **Follow** —
  footsteps behind you in your own rhythm, taking one more step than you did.
  **Stare** — it is placed, silently, on the one bearing you are not covering,
  and then nothing happens; you spring this one yourself, on your own
  schedule, by deciding to turn around, and some players never do. **Closer** —
  the room quietly gets smaller, with no sound whatsoever. **Observed** —
  see below.
- **The watcher.** The building measures what you actually do with your hands
  in the two seconds after every shock: how far you spun, how fast the first
  movement was, whether you stopped dead, whether you ran. It keeps a running
  score per kind of scare, and it uses it twice. Selection is weighted toward
  what has demonstrably worked on *you*, and once the model is confident the
  building starts reaching for your worst one on purpose. And pacing runs off
  the same model backwards: when the score says you have settled, it strikes
  sooner; when it says you are already frightened, it **waits**, because a
  frightened player spends the wait frightening themselves and is better at it
  than the director is. Nothing is transmitted anywhere; it lives in memory for
  one session.
- **A frame that never settles.** The composite gained a second half: barrel
  warp breathing on a heartbeat, screen slide, VHS tearing in torn bands,
  channel separation, a blood wash that survives the vignette, a tunnel
  closing on each beat, and a two-frame stab where the image is its own
  negative. The flashlight has a bad connection at the best of times, and goes
  out entirely when the building decides.
- **A second audio bus.** The ambient engine still never spikes; on top of it
  sits `scare`, which does nothing else — formant screams, dissonant string
  clusters, impacts, hard-panned whispers, breath, sub drops, a heartbeat that
  quickens with intensity. It is hard-limited so a stack of simultaneous hits
  lands under the ceiling instead of clipping, it runs through the floor's own
  reverb, and it is gated to silence by the exposure setting. The ambient bed
  gained the opposite move: during a held breath its three permanent voices
  ramp away together and come back by degrees, so you are never handed a moment
  where it is plainly over.
- **Notices.** Pinned paper — a lettings suspension, a tenant's note, a
  retrieval slip for the building's own file — can be read and transcribed
  into the ledger.
- **The Tier 3 climax on floor −05** — an entry you wrote earlier in your own
  ledger has been rewritten while you were descending.
- **The ending is spent in the car.** Below the schedule the doors do not
  open. You are sealed in with the counter, which keeps counting, and every
  floor the car passes one more entry in your ledger stops being yours — the
  ledger can be opened and watched while it happens. Then the light goes.
- **The ledger** — diegetic journal UI with the floor's filed schedule, a
  drafted blueprint per floor (drawn from the *authored* map, which the
  building does not always agree with), red-ink marks where each finding was
  logged, ruled-off "FLOOR −0N FILED" lines when you descend, and a tear-out
  **share card** (Web Share / download + link). The player's seed is worn as
  a **case number** (CASE S7-…) on the title screen, the ledger head, and the
  share card. Two inspectors on the same case walk the same building, and you
  can actually get there: type a case number on the title screen, or follow a
  share link, which carries the case as well as the depth reached.
- **The ending offers reassignment** — a new case number, a rerolled
  building.
- **Mobile + desktop controls** — virtual stick + drag look + tap to log,
  with gyroscope as an additive layer (the building shifts when you
  physically lean); WASD + pointer lock + click on desktop. The title screen
  says which, once, and floor −01's arrival card carries the field procedure
  (aim at anything, tap to document, log what the schedule does not list).
  The HUD shows the floor's quota under the depth counter; one-time hints
  fire the first time the figure is sighted and the first time it takes a
  page.
- **Synthesized audio, 50% of the horror** — near-silence: room tone,
  ventilation, surface-dependent footsteps, one sub-bass drone that thickens
  with depth, and binaural (HRTF) occupancy sounds — a phone ringing in a
  distant room, a chair scrape, three knocks, movement one floor below —
  always sourced somewhere you cannot see, and they stop if you approach.
  Every sound is generated in WebAudio; there are no audio files. Headphones
  screen at start. No music. No stingers.
- **The building answers sounds.** A generated impulse response per floor puts
  every world sound in its own architecture: partitioned offices are dead, the
  residential corridor flutters between two parallel walls, the archive stacks
  are smothered by thirty years of paper, and the lower lobby has a three-second
  tail. Stepping into the elevator crossfades to a small metal box.
- **Haptics** (Android) — a faint heartbeat that very slowly quickens with
  depth and occasionally desynchronizes.
- **PWA** — installable, service-worker cached, fully offline after first
  load. The entire game is code; there are no fetched assets.
- **Settings, filed as Form 7-B** — **exposure** (unrestricted / severe /
  limited / survey only), quality (auto/low/medium/high/ultra), a steady-frame
  governor, film effects, look speed, invert, field of view, volume,
  head-movement and haptics toggles for comfort, and sound captions that name
  what the building just did and how far away it was.
- **Depth persistence** — auto-save on every floor and continuously during
  play (localStorage), instant resume, depth counter always on screen.

![The ledger, altered](docs/screenshots/ledger-5.png)
![Settings, filed as Form 7-B](docs/screenshots/settings.png)

## Running it

```bash
npm install
npm run dev        # dev server
npm run build      # floor validation + typecheck + production build + PWA (dist/)
npm run preview    # serve the production build
```

Verification:

```bash
npm run validate   # authoring checks: enclosure, reachability (including with
                   # prop collision, on both the plain and stretched maps),
                   # wall-mounts, anchors, pools, quotas
npm run smoke      # headless end-to-end: plays all five floors, logs every
                   # discrepancy, rides the elevator, checks prop collision
                   # stops the walk, verifies the floor-5 ledger alteration
                   # and the ending; screenshots each floor
npm run shots      # fixed-seed contact sheet for renderer work: three vantages
                   # per floor (elevator mouth, longest sightline, densest
                   # props). --quality <tier>, --floors 1,2, --views ao,vol
                   # to dump the intermediate buffers instead
```

`npm run build` runs `validate` first, so CI (`.github/workflows/ci.yml`, on
every PR and push to `main`) and the Pages deploy both gate on it. The smoke
test needs a browser and is run by hand.

(The smoke test uses the preinstalled Chromium at `/opt/pw-browsers/chromium`;
software rendering is slow, so it takes a few minutes.)

## Architecture

```
src/
  core/        types, seeded RNG (mulberry32 + per-floor streams), save
    dread.ts   the escalation director: intensity, the stalk/tell/strike/void
               cycle, and the frame it hands to the camera and the composite
    watcher.ts the model of the person playing — what they flinch at, measured
               off their own hands, and how settled they have become
  world/
    presence.ts the figure — geometry, the observation rule, how it breaks,
               and how it is filed
    observations.ts the building's own ledger, whose only subject is you
    faces.ts   procedurally drawn faces, for the head and for the whole screen
    specs.ts   the five floors: ASCII maps + anchors + discrepancy pools
    grid.ts    map parsing, collision queries, authoring validation,
               the long-hallway stretch mutation
    builder.ts merged wall geometry, world-projected wall UVs, elevator rig
               (sliding doors, call button), prop placement, dust motes
    props.ts   every object, each with a normal and a wrong variant
    textures.ts all surfaces + signage as generated canvas textures, with
               normal + roughness maps derived from a blurred height field
    discrepancies.ts  the wrongness pass: seeded selection + rare variants
    mundane.ts "no deviation" entries for correct props + amendment text
    palette.ts one controlled palette per floor
  player/      controls (touch / desktop / gyro), movement + collision
  audio/       synthesized WebAudio engine, per-floor convolution reverb,
               haptics
  render/
    pipeline.ts the frame: scene → AO → volumetrics → bloom → DOF → composite
    shaders.ts  the GLSL for all of the above (GLSL ES 3.00)
    lighting.ts shadow-caster budget + which lights the dust catches
    grades.ts   one colour grade per floor palette
    quality.ts  tiers, device detection, persisted player settings
  ui/          HUD (depth, reticle, ledger tab, captions), ledger + blueprint,
               settings form, share card
    overlay.ts the layer above the building: full-frame faces, signal loss,
               washes, the word — DOM, so it lands on the very next frame
  game.ts      state machine: arrive → document → descend; silent alterations
```

**The frame.** The scene renders to an offscreen linear-HDR target with MSAA
and a depth texture. Everything after that reads only depth, so no pass needs a
second draw of the geometry:

```
scene ──▶ sceneRT (RGBA16F, MSAA, + depth)
           ├─▶ SSAO         hemisphere samples, per-pixel spiral rotation,
           │                depth-aware bilateral blur
           ├─▶ volumetrics  single-scattering march; the flashlight is light 0
           │                and the only one sampled against a shadow map
           ├─▶ bloom        mip pyramid, soft-knee prefilter, tent upsample
           ├─▶ DOF          quarter-res plate, only while a frame is held
           └─▶ composite    ACES → per-floor grade → lens → canvas
```

Two things about that are worth knowing before editing it. The post materials
are **GLSL ES 3.00**: three does not supply a `gl_FragColor` compatibility
define, so each fragment shader declares its own output — and the volumetric
pass needs 3.00 regardless, because three's shadow maps are *comparison*
textures and binding one to a plain `sampler2D` makes the driver silently
discard the whole draw call. And the scattering phase function is fed the angle
between the incident and outgoing directions, which for a head-mounted
flashlight is ~180°: the beam correctly backscatters almost nothing into its own
lens. Shafts come from lights you are looking *toward*.

**Lighting budget.** Ceiling fixtures are spotlights, not point lights: a
downward cone is what a troffer throws, and it costs one shadow map instead of
six. Which fixtures cast is decided once per floor by farthest-point sampling,
and never changes while the player is on it — toggling `castShadow` on a live
light recompiles every material on the floor, and a hitch in a game with no
jump scares reads as a jump scare. For the same reason every fixture carries
its light from the start, dark ones at zero intensity, so the building
switching one on is not a hitch either.

**Quality tiers.** `low` / `medium` / `high` / `ultra`, auto-detected from the
GPU renderer string and device class, overridable in settings. A resolution
governor gives back pixels before it gives back frames: it moves at most once a
second, in five coarse steps, with a wide dead band so it settles instead of
hunting.

**Two failure modes are handled rather than assumed away.** Rendering to a
half-float target is an *extension* in WebGL2, not core — without it every
offscreen buffer is framebuffer-incomplete and the game is a black screen, so
the pipeline checks once and falls back to 8-bit buffers (the cost is
headroom: the bloom threshold drops under the clip point). And a backgrounded
PWA can lose its GL context entirely; the canvas listens for it, and on restore
rebuilds every render target and material and reloads the floor from the save.

**Floors are ASCII maps.** `#` wall, `.` floor, `E` elevator, letters are
prop anchors. A validation pass (also run in dev builds) checks enclosure,
reachability from the elevator, and that wall-mounted props have walls.
The blueprint in the ledger is drawn from the authored map — when a
discrepancy stretches the corridor or adds a door, the *world* changes, not
the blueprint. The disagreement is the gameplay.

**The wrongness pass.** Each floor has a pool of authored discrepancies;
the player's seed shuffles the pool and spawns a subset. Unselected anchors
spawn their normal variants — a dead plant instead of the watered one, a
dusty mug instead of the steaming one — so a floor never looks staged.
Rare entry variants roll on an independent seeded stream.

**Alterations.** A logged discrepancy may queue a change to another prop.
It is applied only after the target has been continuously outside the view
frustum and more than ~5.5m away for 1.6 seconds. Never on screen.

## Slice decisions (and the path past them)

- **WebGL2 only.** The brief calls for WebGPU-where-available; three's WebGPU
  renderer requires node materials and a different post pipeline, which is risk
  this doesn't need. The renderer is isolated behind `game.ts` +
  `render/pipeline.ts` for a later swap.
- **Screen-space occlusion, not baked.** Real-time SSAO from the depth buffer
  costs a pass but keeps floors procedural and seed-stable. Baked lightmaps
  would look better and would mean shipping per-floor assets, which is the one
  thing the offline-first build is built to avoid.
- **Procedural geometry + canvas textures instead of GLTF/KTX2.** Keeps the
  installable PWA tiny (~180 KB gzipped, zero asset requests, trivially
  offline) and every visual seed-stable. Surfaces get their normal and
  roughness maps generated at load from the same height field that draws the
  albedo. The prop factory is the seam where baked-lightmap GLTF floors can
  replace generated rooms later; the KTX2 pipeline belongs to that step.
- **No leaderboard backend, no accounts, no monetization** — per the brief.
  Depth is local. The share card is the growth loop.

## The constraints, and which ones are gone

The original brief was "no jump scares, no volume spikes, no entities, no
game-over, no chase, no explanations." Four of those are now settings rather
than constraints, and the honest summary is:

| | `unrestricted` (default) | `survey only` |
|---|---|---|
| jump scares | a cycle, ~8–15s, sometimes four at once | none |
| volume spikes | a dedicated, limited scare bus | none — every sound slow-attack |
| entity | one per floor, intercepting | none |
| chase | it runs at you above half intensity | none |
| game-over | **still none** — but contact tears a page | still none |
| explanations | **still none** | still none |

The two that survive at every setting are the two the game was actually built
on. There is no death, no failure, and nothing to lose — the thing that
reaches you takes nothing except the assumption that you were alone. And
nothing is ever explained: below floor −05 the schedule ends, the elevator
does not stop, and the counter keeps counting.

`survey only` is not a degraded mode, it is the original build: every dread
uniform is zero and the composite's whole second half is branched over, the
scare bus is gated to silence *and* every voice on it early-returns, the
director's cycle never advances so nothing is ever scheduled, the watcher is
wiped and never sampled, nothing is ever written in your ledger that you did
not write, and the figure never enters the frame. It exists because the slow
version is a real game that some people will prefer, and because rapid
flashing is a medical issue rather than a taste one.
