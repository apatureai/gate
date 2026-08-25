Part of [gate](../README.md). Moved from the README on 2026-08-24; anchors preserved.

### The measured half

The engine produces two independent things, and only one of them is a judgment. Text contrast against
WCAG AA, horizontal overflow and touch-target sizes are **computed from the captured DOM with no
model involved**. Gate renders them inside the same "Apature Gate" check it already publishes, under
their own heading, on **every** path: graded, unjudged, nothing-reviewed and no-grade alike. That is
deliberate. The grade, the narrative and the findings are withheld on those paths because nothing
established them; a measurement needs nothing to establish it, and on an unjudged run it is the only
thing on the check a reader can act on.

`rules.measurements` is what a repository lets them do:

| Value | Effect |
|---|---|
| `off` | The measured block is not rendered. Gate still prints one line saying measurements arrived and are not being shown, because a setting that makes a surface quietly drop evidence is worse than a noisy surface. |
| `advisory` (default) | Rendered, never changes the Check Run conclusion. |
| `block` | An engine-marked block-eligible violation **that this pull request introduced, or that it moved into a worse severity band**, makes the check fail, titled *Measured violations*. With no stored baseline for the pull request's base commit, nothing can be shown to be either and nothing fails. |

`block` is opt-in and will stay opt-in, exactly like `rules.gate: blockers` and for the same reason:
the engine does not block on its own authority, and neither does the vendor default. It acts only on
violations the **engine** marked `blockEligible`, which it does not do lightly: a `<pre>` with
`overflow-x: auto` is content wider than its box on purpose, 44px is WCAG 2.5.5 at level AAA rather
than the 24px AA line, and a flattened background colour cannot see a background image. Those
measurements are still reported; what they do not carry is permission to fail somebody's build. Gate
never computes that flag and never overrides it.

#### Scoped to what the pull request introduced

`block` acts on **new** violations only. Gate stores the measurement set it observed for a repository
at each commit it reviews, and on a pull request it compares this run against the set stored for the
pull request's **base** commit:

| Placement | Rendered | Gates |
|---|---|---|
| Already on the base | Yes, marked *Already on the base* | Never, under any mode |
| Already on the base, in a worse severity band | Yes, listed under *Made worse by this pull request*, with the band before and after | Yes, if the mode is `block`, the engine marked it `blockEligible`, and the band is known on both sides |
| Introduced by this pull request | Yes, listed under *New in this pull request* | Yes, if the mode is `block` and the engine marked it `blockEligible` |
| Not classifiable | Yes, marked *Not classified* with the reason | Never |

Without this, the first pull request opened after installation inherits every pre-existing contrast
failure in the repository. As advisory output that is noise; as a merge gate it is unusable, and the
predictable response is to switch the tool off, after which it reviews nothing forever.

**No baseline never gates, and never reads as a clean result.** A repository Gate has never run on its
base branch has no stored set for that base commit. Gate says so, in as many words, on both the Check
Run and the sticky comment: *no baseline. Gate has never recorded a measurement set for base commit
`abc1234`, so none of the violations above can be shown to be new and none of them are gating.* That
is deliberately not the same sentence as "this pull request introduced no violations". Treating "I
have never looked" as "there was nothing there" is exactly how a team gets handed the back catalogue
this exists to prevent. Three other answers behave identically and each names itself: no baseline
store bound on this path, a store that could not be read, and a set recorded under an older
measurement-identity version.

**A page the base run never captured cannot be classified**, and neither can a check the base run
never executed. Both are reported as *Not classified* with the reason, and neither gates. Gate does
not guess which side of a pull request an unplaceable violation came from. **A renamed route lands
here on purpose.** `/` becoming `/home` is, to Gate, a page it has never measured, because nothing
matches a violation across two routes; the old page's violations are not counted as fixed either,
since a page this run never captured was not fixed. A route matched loosely would let a genuinely new
page inherit an old page's clean bill of health without a word, and that is the one error nobody ever
sees.

**Where the baselines come from, and what still does not have one.** A completed review records the
set for its own head commit, and a pull request is scoped only when its BASE commit is one Gate has a
set for.

On the hosted **App path** that recording used to happen only for a pull request's head. Every merge
strategy GitHub offers puts a commit on the base branch that was never any pull request's head, so for
a long time the next pull request's base was a commit Gate had never seen, the lookup came back
`no baseline`, and `rules.measurements: block` failed nothing outside a stack of pull requests.

**A merge now carries the set forward.** When a pull request merges, Gate already holds the
measurement set for the head it just reviewed, and the merge commit usually contains the identical
tree. On `pull_request` `closed` with `merged: true`, Gate reads the tree sha of the reviewed head and
the tree sha of the merge commit from GitHub's commit API and copies the stored set onto the merge
commit **only when the two are equal.** Equal trees are byte-identical content, so the stored
measurements describe that commit exactly and the copy is a statement of fact rather than an estimate.
The copy is marked as carried, names the commit that was actually rendered, and keeps the engine
version and measurement-identity version it was computed under; nothing is re-derived, so a set
recorded under an older identity version stays refusable for skew instead of being laundered into a
comparable one. The whole thing runs after the review is delivered, is best-effort, and cannot fail a
check: a store or an API that is down costs the *next* pull request its scoping and costs this one
nothing. It needs no permission beyond the `contents: read` Gate already has, and writes nothing to
your repository.

**When the trees differ, Gate records nothing and says so in the log.** A squash onto a base that
moved while the pull request was open, and a merge commit that combines two branches, both produce
content that was never rendered, never captured and never measured. Copying a set onto one of those
would publish a measurement result nothing produced and then gate the next pull request against it,
which is the one defect this whole subsystem exists to avoid. So those merges leave the base
unmeasured, the next pull request reads `no baseline` on both surfaces, and `block` fails nothing on
it. The same holds when the pull request's head was never successfully reviewed, when GitHub's commit
API cannot be read, and when the pull request is closed without merging.

**The carried set is also the better baseline where both mechanisms apply,** and the two are not
interchangeable. A carried set was measured at the merged pull request's own preview; a pushed one is
measured at `preview.default_branch_url`, which for most teams is production. The next pull request is
measured at a preview too, so the carried set compares like with like. A merge whose trees matched
therefore ends with the carried set stored, whichever of the two webhooks finishes first, and the push
skips its capture rather than spending one on a measurement it would not keep.

**The carry-forward covers a quiet repository and abandons a busy one.** Tree equality holds exactly
when the base has not moved since the branch point, so any merge that raced another landing carries
nothing, the next pull request against that branch reads `no baseline`, and the gate goes silent on
precisely the merges that followed a race. Watching the default branch itself is the only mechanism
that covers every merge strategy and every race, because whatever produced the commit, it arrives
there.

**So Gate now watches it. A push to the default branch records a baseline for the new commit.** The
App subscribes to `push`, and on a push whose ref is `refs/heads/<the repository's own default
branch>` Gate captures that commit's deployment, measures it, and stores the result as that commit's
measurement set. That is the whole of it, and what it does *not* do is the reason it is affordable:

- **No model call.** A baseline needs measurements only. The stored set is deterministic capture
  output (contrast, overflow, touch target) plus the routes and viewports that were measured, and
  none of it is a judgment. The push path calls a separate measure-only endpoint
  (`POST /measurements`) through a separate client, and the review client is not among its
  dependencies, so there is nothing on that path to spend a model call with. A payload that comes
  back carrying a `grade`, `findings`, `overall` or `provenance` is **refused** rather than stripped:
  those fields exist only on a judged result, so their presence means a model ran on a request that
  asked it not to, and a baseline Gate paid for while logging that it had not is worse than no
  baseline.
- **Nothing is published.** No Check Run, no comment, no run row, no grade, nowhere. Nothing about a
  push is a review and nothing it produces may render as one, so the push path is handed no Check Run
  publisher, no comments client and no run store at all: the delivery side is not merely unused there,
  it is unreachable from there.
- **A push that fails costs the next scoping and nothing else.** The measure is submitted once and
  never retried, because a retry on a busy default branch turns one bad minute into a stampede against
  an engine that is already failing, and nobody is waiting on the answer. Failures are logged and
  never surfaced to a user. The webhook is answered before the capture finishes, since GitHub allows a
  receiver ten seconds and retries what it thinks failed.
- **No new permission.** `push` is an event subscription, not a permission. The repository, its
  default branch, the pushed commit and the installation all arrive in the payload, and reading the
  repository's `.gate.yml` at that commit is the `contents: read` a review already does. Gate still
  requests exactly four scopes and still never `contents: write`.

**What records nothing, deliberately.** A push to any other branch. A tag push, which arrives on the
same event and usually names a commit that *is* on the default branch, so a handler that looked only
at the commit would re-measure it on every release. A branch deletion, which carries a real ref and a
commit sha of forty zeros. A merge queue's `refs/heads/gh-readonly-queue/...` staging refs, which are
not the default branch: when the queue lands the batch, that landing is itself a push to the default
branch and is measured there, so the discarded attempts cost nothing. The default branch is read from
the payload rather than assumed to be `main`, because a repository on `master` or `trunk` would
otherwise get the silent gate this whole thing exists to close, while looking from the outside exactly
like one that worked.

**A force push is treated as an ordinary push, and nothing already stored is invalidated.** A stored
set is a statement about a COMMIT, not about a branch: "this tree, measured, produced these
violations". Rewriting the branch does not make that statement false about the commit it names, so the
sets for orphaned commits stay exactly where they are, stay correct for any pull request still based
on one of them, and cost a row each. The commit the force push landed is measured on its own terms
like any other.

**What it costs.** One capture per commit landing on the default branch: a browser, a sandbox and a
minute of the critique service's time, bounded by a five-minute deadline, with no model inference at
any point. Gate's own cost is one webhook, one config read, and one row in `measurement_baselines`.
A ref that records nothing is never captured at all.

**What is still not covered, and this list is the honest one:**

- **The critique service has to implement the measure endpoint, and no published one does yet.** Gate
  ships the client, not the capture, exactly as it does for reviews. `verdict` implements `POST /jobs`
  and does not implement `POST /measurements`. Against such a service every push gets a 404, records
  nothing and spends nothing, and the log says so. Roadmap item 3c. The separate path is why: a flag on the review
  request would have been silently stripped by that same service, which would then have run a full
  review and billed a model call for every push.
- **A repository that has not set `preview.default_branch_url`.** Gate will not guess an address to
  point a browser at, so a repository that has not said where its default branch is deployed records
  nothing and the log says which repository and why.
- **Whatever the deployment cannot reach.** If the URL is not up, is behind an auth wall Gate has no
  sealed state for, or serves something other than that commit, the measure fails or measures the
  wrong thing. A *stable* production URL is measured **as it is at the moment the push arrives**,
  which on a repository that deploys after CI is still the previous commit's build, and the set is
  then filed under the new commit. If you want the set to be certainly about the commit it names, make
  `default_branch_url` a per-commit address using `{sha}` or `{short_sha}`.
- **A baseline measured at your default branch's deployment is compared, reported, and never gated.**
  This is the one way the feature could have been worse than the problem: a baseline recorded from a
  push is measured at `preview.default_branch_url`, which is usually production, while the pull
  request it is compared against is measured at that pull request's preview. Anything that differs
  between those two and is not the pull request's doing (seed data, feature flags, a signed-out state,
  a consent banner, a different CDN) produces a violation on one side and not the other, and under
  `block` that read as **introduced** and failed a build the pull request did not break.

  Every stored set now records *where* it was rendered, and a comparison whose two sides came from
  different **surfaces** (one a pull request preview, one the default branch's own deployment)
  stops attributing: a violation that matches nothing on the base is reported as `not classified`
  rather than new, a severity band that rose is not called worse, and no recorded violation is counted
  as resolved. Violations that *did* match are still reported as already on the base. Both surfaces
  say which run this was and why. Nothing about it is silent, and nothing about it gates.

  **It is not an origin check, because that would be a kill switch.** Preview URLs differ from each
  other on every pull request, so a rule of the form "the two addresses must match" would refuse every
  comparison Gate has ever made. What is compared is the *kind* of deployment, so two previews stay
  comparable however different their hostnames. That is the ordinary case, and the case that still
  fails a build when a pull request really does introduce a violation. Two sides that happen to share
  one address are comparable too.

  **If your default branch deploys to something that renders like your previews, say so** with
  `preview.default_branch_renders_like_preview: true`, and those comparisons gate normally again. It
  is a declaration rather than something Gate infers, because the URL is opaque: a staging deployment
  built exactly like a preview and a production deployment are the same string from here.

  **On a tree-identical merge, the preview-measured set wins.** Such a merge fires both mechanisms on
  one commit: the carry-forward copies the reviewed head's set onto the merge commit, and the push
  measures the default branch's deployment of it. Both are real measurements of the same tree, so what
  ranks them is comparability, not directness: the carried set was rendered at a preview, and so is
  the next pull request. The push yields to it (before spending a capture where it can, and again
  after, since the carry can land mid-capture), and the carry replaces a pushed set that landed first,
  so the stored row is the same whichever webhook finishes first.

  **What remains.** A baseline stored before this shipped carries no environment, and `unknown` is
  compared normally rather than refused, so those sets keep the old behaviour until the next push or
  merge re-records them. A team that sets `default_branch_renders_like_preview: true` and is wrong
  gets the old failure back, by their own choice. And nothing here detects drift *within* one surface:
  two previews built from different branches can still differ by seed data, and Gate compares them as
  though they could not.
- **Every commit that landed before you installed Gate.** Nothing backfills history. The default
  branch's current tip is measured at install time (below), and every later commit on it is measured
  as it lands, but a pull request whose base is some older commit has a base Gate never measured and
  reads `no baseline` on both surfaces.
- **A push whose measure failed.** Nothing retries it. That commit has no set, and a pull request based
  on it is unscoped until a later commit on the branch is measured.

**And the branch is measured once when the App arrives, so the FIRST pull request is scoped too.**
Watching pushes still leaves one hole, and it is the worst-placed one: a default branch acquires
baselines from the first push *after* the App is installed. A team that installed Gate, turned on
`rules.measurements: block` and opened a pull request that afternoon got a check that classified
nothing, and it looked exactly like a check that passed. (Classifying is not the same as failing: see
what this cannot give you, below.) So on `installation`
(action `created`) and `installation_repositories` (action `added`), Gate reads each named
repository's default branch and its tip commit, and measures that commit through the same path a push
takes.

- **Same path, so the same guarantees.** It calls the measure-only seam a push calls, so there is no
  second implementation to keep honest: no model call, no grade, no Check Run, no comment, no run row.
  An installation is not a review and nothing it produces may render as one. A repository with no
  `preview.default_branch_url` records nothing and the log says which repository and why, exactly as a
  push does. A failure costs that repository its scoping and nothing else, is logged, and never
  reaches a user.
- **No new permission.** Both are event subscriptions. The installation payload names the
  repositories; the default branch and its tip are read back with `GET /repos/{owner}/{repo}` (the
  Metadata scope every GitHub App holds) and `GET /repos/{owner}/{repo}/git/ref/heads/{branch}` (the
  `contents: read` a review already spends on `.gate.yml`). Gate still requests exactly four scopes
  and still never `contents: write`.
- **A removal records nothing.** `installation_repositories` with action `removed` carries a full
  repository list, and so does `installation` with action `deleted`. Only `created` and `added` scope
  anything, and each event's list is read from its own field, so a delivery that says the App was
  taken away can never be read as one that gave it something.
- **A large installation is bounded, not dropped.** Installing on an organisation with "All
  repositories" selected delivers one event naming every repository, and each one costs a full browser
  capture. Gate walks the list **two repositories at a time** and finishes behind the webhook
  response. Nothing is dropped: a 300-repository installation is still 300 captures, two at a time,
  completing over the following hours, and repositories measured later are scoped later. The bound is
  the point: firing them together would be a self-inflicted denial of service against the same capture
  pool that is answering pull requests somebody is waiting on.
- **What it still cannot give you, and read this one before you rely on it.** It cannot give you a
  **failing check**. The set it records is measured at `preview.default_branch_url` and is therefore
  `default_branch`-surfaced, and a pull request is measured at its own preview, so unless the
  repository declares `preview.default_branch_renders_like_preview: true` the two are not comparable
  and every violation comes back as `cross_environment`: reported, never gated. What install-time
  measuring buys on its own is an honest scoped section on the first pull request instead of a blank
  one. It buys a failing check only for a repository that has declared the two deployments equivalent.
  Beyond that: a repository whose deployment is not up at install time, or that has not said where its
  default branch is deployed, records nothing and is back to waiting for its first push; the tip is
  measured *at install time*, so a pull request opened before the install is still based on a commit
  nobody measured; and Gate scopes exactly the repositories the delivery names rather than enumerating
  an account, so a delivery that names none scopes none.
- **And it needs the same measure-only endpoint a push needs.** The install sweep calls the same
  `POST /measurements` probe, so until a critique service implements it, an installation records
  nothing for the same reason a push does. See the status table and roadmap item 3c.

In all of those the failure direction is the same one every other missing baseline takes: `no baseline`
classifies nothing, gates nothing, and says so on both surfaces. A team that reads a permanently green
check as "no regressions" is still reading it wrong.

The **Action path** runs inside a GitHub-hosted runner with no database, so it binds no store:
`rules.measurements: block` on the stock Action reports its measurements and fails nothing, and says
which of those two things happened on every run. The carry-forward changes nothing there, since there
is no store to carry anything into. A self-hosted operator with a database can pass a store into
`runAction` and get the App path's recording and comparison; the merge carry-forward and the
default-branch push are both webhook-driven and belong to the App path alone.

**Identity is deliberately hard to move.** A violation is the same violation across two runs when its
check, its route, its element and the substance of the engine's sentence match. Structural-position
pseudo-classes are stripped from the selector (`li:nth-child(3)` and `li:nth-child(4)` are one place,
as are `:first-child` and its `nth-child` spelling), and every number in the engine's sentence is
replaced before hashing, so a contrast ratio that drifts from 3.23 to 3.19 is one defect measured
twice rather than one fixed and one introduced. Viewports and the engine's `blockEligible` flag are
not part of the identity: both move for reasons that are not the defect. Stripping position merges
genuine siblings, which can hide a newly added third copy of an existing violation; that is the safe
direction of the trade, and the only one available, since the other direction reports an untouched
back catalogue as this pull request's fault. The normalization is versioned, and a set recorded under
a different version is refused rather than compared.

**A markup refactor is not a new violation either.** Normalizing the selector is not enough on its
own, because a pull request can move the whole selector path without touching the defect underneath
it: wrapping the element in a div (`#hero .tagline` becomes `#hero .inner .tagline`), tightening a
descendant combinator into a child one (`#hero > .tagline`), or renaming the class
(`#hero .subtitle`). Each of those used to read as one violation resolved plus one introduced, which
under `block` failed a pull request that changed no colour at all, on exactly the mature repositories
a baseline is for. So a violation that matches neither selector key gets one last comparison against a
third and much weaker key: **same check, same page, same stated defect, no selector at all.**

That key is too weak to be an identity, so it is **spent rather than matched**. A match may claim one
stored violation, and only one that nothing else accounts for: a stored violation whose element is
still present in this run is already spoken for, and a claimed one is gone. **The number of
same-defect violations on a page therefore cannot grow without something being called introduced**,
which is what keeps this from turning `block` off in the other direction. A new low-contrast element
added beside an existing one is introduced even when the engine's sentence about it is identical,
word for word.

The cost is on the record: a pull request that fixes one violation and adds a like one on the same
page reads as one fixed and one carried over, rather than one fixed and one introduced. That is the
cheaper of the two errors and it is chosen knowingly. A false *already on the base* is a violation
Gate still renders, still counts and still shows the reader; a false *introduced* is a red check on
unrelated work whose only escape hatch, `measurement_suppress`, would hide the real defect too. Rows
carried over this way are marked as such on the pull request rather than folded silently into the
count.

**One stored violation answers for one violation here**, whichever of the three keys reached it. All
of them draw on the same budget, and they are applied in tiers, every key finished across all
violations before the next one begins. A key that merely *matched* would let one stored violation
absolve every violation on its element, so an element that already had a defect could take on a
second one and still report as unchanged. Placing violations one at a time instead would let one
reach a weak key and spend the entry that a later violation matches exactly, making the strength of a
match depend on the order the engine happened to report things in.

**Every key is blind to magnitudes and thresholds**, because every number in the engine's sentence is
replaced before hashing. So "contrast 2.91:1" and "contrast 1.02:1" on one element are one violation
whose measurement moved rather than two, and a normal-text contrast failure can claim the entry of a
deleted large-text one on the same page. Keeping the numbers would put every re-measured ratio on the
gate, which is the failure the baseline exists to prevent, so the blindness is chosen.

#### A violation that was already there can still be made worse

The blindness above is the right call and it used to have a silent cost: a pull request could take an
element from **2.91:1 to 1.02:1**, the fingerprint matched exactly, and Gate reported it as
pre-existing and unchanged. A real regression, on markup that already had a defect, went through a
`block` gate without a word.

Gate cannot close that on its own, and the shape of the fix follows from why. Gate stores hashes:
selectors and engine sentences derive from the customer's page and are never kept, so there are no
numbers here to compare. And Gate cannot tell from prose which **direction** is worse, since lower is
worse for contrast, larger for overflow and smaller for a touch target; deriving that from the
engine's wording would be Gate computing a judgment the engine owns. So the **engine** states an
ordinal severity band per violation, Gate stores it beside the keys, and Gate compares bands and
nothing else. Raw magnitudes still never cross the boundary.

The bands are the engine's, and they are coarse on purpose, so ordinary re-measurement noise cannot
move one:

| Check | Band 1 | Band 2 | Band 3 |
|---|---|---|---|
| `contrast` | ratio >= 3.0 (WCAG AA for large text) | >= 1.5 | < 1.5, which is near-invisible |
| `touch_target` | smallest dimension >= 24px (SC 2.5.8, level AA; 44px is SC 2.5.5, level AAA) | >= 10px | < 10px |
| `overflow` | excess <= 10% of the viewport width | <= 50% | more |

A band is **ordinal**: higher is worse, it is comparable only within one check, and it is never a
magnitude and never arithmetic. It answers "which band of badness", not "how bad".

A pre-existing violation whose band is **higher** than the band stored for the base is **worsened**.
It is not called introduced, because it was already here, and a reader who is told it is new goes
looking for markup they never wrote. It gets its own count and its own section, *Made worse by this
pull request*, with the band before and after on the row. Under `block` it fails the check on the
same terms an introduced violation does: the engine must have marked it `blockEligible`, and the
comparison must be strictly greater, so a band that did not move is never a regression.

**A band that moved is not automatically a merge blocker, and one check is excluded by name.** The
`contrast` and `touch_target` landmarks are WCAG's own, so crossing one is material by a definition
nobody here invented. The `overflow` cuts at 10% and 50% of the viewport are proportions Gate chose,
and they sit close enough to ordinary layout that an unrelated edit crosses one: a single pixel of
body padding was enough to move a measured overflow past the 10% mark. So **an overflow that deepened
is reported and never fails a check**, while an overflow this pull request introduced gates exactly
as before. The exclusion is about a band moving, not about the check.

**The viewport rule is per row, not per run.** A band is the worst measurement across the viewports
its row covers, so a row is compared only against stored rows measured somewhere it was, and only
when every viewport it covers was measured before. A row covering desktop and a newly added tablet
is not comparable to a stored row that only ever saw desktop, because the band may have risen on the
breakpoint nobody had measured. An earlier version of this rule was a single run-wide switch, and it
was worse than the problem: one new viewport anywhere discarded every band comparison on every route
and every check, so widening `viewports:` (or a base run that simply lost a capture) silently turned
regression detection off for a whole run and still printed a check promising it was on.

**A band is compared against the viewport it was measured at.** Each stored row records the
viewports its violation was found at, and a band is only compared against stored rows measured
somewhere this one was too. Comparing against the whole identity instead let a mobile row that was
already in the worst band hide a desktop regression from `3.40:1` to `1.02:1`, which crosses WCAG's
own landmark on the only rendering that changed. When no stored row was measured where this one was,
there is nothing to compare and nothing gates: that is "nobody looked there", not "it was fine".

**A claim never reaches across viewports.** Stored rows of one identity are interchangeable
claimants only while nothing tells them apart, and the viewport does. When a base that measured
mobile alone meets a pull request that widened `viewports:`, the untouched markup produces two rows
of that identity, and letting the desktop row take the mobile row's stored entry left the mobile row
with nothing to claim: byte for byte what the base recorded, reported as introduced, failing the
check. Whether it went green or red depended on the order the engine listed two rows in. A claim now
skips a stored row measured nowhere this violation was, and when either side records no viewports
the claim goes ahead on identity alone.

**A violation is not "gone" from a viewport nobody measured.** The resolved counter is scoped by
route, by check and by viewport, all for one reason: it is the only line here that speaks in the
flattering direction, so every coordinate nobody looked at has to silence it.

**A violation found only where the base never looked is not new.** Widening `viewports:` renders the
same markup at a size nobody measured before, and the engine reports a row for it that matches no
stored row, because there was never one to match. That row is reported as not classified rather than
introduced, alongside `route_not_measured` and `check_not_run`, which say the same thing about a
different coordinate. A row seen at a measured viewport as well is still answerable there, so this
never excuses a genuinely new violation.

**The comparison asks the whole group when a stored row predates viewports.** Several stored violations can share one
identity, because identity excludes the viewport: one element measured at mobile and at desktop is
one identity and two stored rows, and a colour token behind a media query gives them different
bands. Asking one arbitrary row made the answer depend on which row a violation happened to be
paired with, and a page compared against itself reported one violation improved and one made worse.
A baseline recorded before rows carried viewports cannot be placed at one, so its whole identity is
taken as a single group and the worst band in it answers. That is order-independent, and it errs
away from calling something worse.

**An unknown band never gates, on either side.** An engine that does not state one, a baseline
recorded before the field existed, and a check that computes no band all leave one side unknown, and
an unknown is not a comparison. This is the rule `blockEligible` already follows, and it is what lets
the field ship without a stored baseline anywhere in the field becoming untrustworthy. Absence is
stored as absence rather than as `0`: zero is the bottom of the scale, so reading it as a band would
turn every banded violation on an old baseline into a regression the next pull request caused.

**Identity does not move.** A band is a fact about a violation, not what makes two violations the same
one, so it is in no key and `MEASUREMENT_IDENTITY_VERSION` is unchanged. Entries are stored as
`jsonb`, so there is no migration either: every baseline already recorded keeps comparing, without a
band, exactly as it did.

**An engine upgrade is the one time the engine's sentence lies.** The detail is the engine's own
wording, and a new engine version can reword it while the page holds still. A reword on its own is
absorbed, since the element key does not include the detail. A reword on a violation whose markup
*also* moved misses all three keys at once, and an untouched defect would read as introduced. So the
engine version that recorded a baseline is compared, not merely stored. When it differs from the
engine running now, a violation that matched nothing may spend an unaccounted-for entry recorded for
the same page and check, and is then reported as **not classified**: never gated, and never called
pre-existing either, because nothing has shown it is the same violation. The entry is spent, so two
new violations cannot both shelter behind one that went missing, and a violation on a page where
nothing went missing gates as usual. Under skew the second key is also matched rather than spent,
because a new engine may report as two rows what the old one reported as one, and budgeting that
would call the second row new on a page nobody edited. The pull request says which two engine
versions were involved. An unknown version on either side is **not** treated as skew: Gate cannot
show two engines differ from a missing field. The next run on the base branch re-records the baseline
and restores the normal rule.

Gate stores only what it needs to answer "is this the same violation": the check and the route in the
clear, and the element, the detail and the defect as SHA-256 digests. Selectors and engine sentences
derive from the customer's page and are never kept.

**Every row says which one it is**, under `advisory` as well as under `block`. A measured row ends in
`_[block-eligible]_` or `_[advisory only]_`, and the line above the list counts the split, so a reader
who did not build this engine can tell a contrast failure it will stand behind from a `<pre>` that is
wide on purpose without reading this file first. Block-eligible rows sort first: the list is capped at
twelve, and an unsorted block could push the one violation the engine stands behind past the cut in
favour of twelve it does not. The tag is a disclosure, not a policy: under `advisory` it changes
nothing about the conclusion.

**The summary names the mode that produced the outcome.** A failing check leads with *Failed by
measurement*, how many block-eligible measurements were enough to do it, whether they were introduced
here or moved into a worse severity band here, the `rules.measurements: block` line that chose it, and
the setting to write instead to keep seeing them without failing on
them. Under `off` the one line that replaces the block names `off`; under `advisory` the sentence
above the rows says in as many words that `advisory` is what stops the engine acting on them. The
Check Run and the sticky comment derive that from the same predicate, so the two surfaces published
on one pull request cannot name different modes.

A measurement is never a finding. Its severity band is an ordinal band the engine computes from a
threshold, not a judged `Severity`, so `min_severity_to_comment` does not filter one and
`rules.suppress` does not reach one: muting a judgment and muting a ruler are different acts, and
one key doing both would hide the second by accident. `measurement_suppress` is the second key. It
matches exactly, never as a glob, against any one of three forms:

| Entry | Mutes |
|---|---|
| `contrast` | every contrast measurement on this repository |
| `#hero-subtitle` | that element, whatever was measured on it |
| `contrast:#hero-subtitle` | that kind on that element |

The kind form is the one a reader reaches for first, because every rendered row leads with
`[contrast]`, and a repository that has decided its palette is a deliberate choice should be able to
say that once rather than once per selector. Kinds are matched against the violation's own `kind`
string rather than a list Gate keeps, so a kind the engine adds later is mutable the day it ships.
Suppression removes a violation from rendering and from block eligibility together: mute the last
block-eligible violation and a `block` repository's check goes back to whatever the grade said. It
cannot reach the engine's own grade retraction, which is computed engine-side and reads no
repository configuration.

**Upgrading is one-directional.** `.gate.yml` is a closed schema, on purpose: a typo like `viewport:`
is a validation error rather than a silently ignored key. The cost of that is that a Gate build
predating `rules.measurements` rejects the whole file when it sees the key, rather than ignoring the
line. Adding `rules.measurements` (or `rules.measurement_suppress`) to a repository raises that
repository's minimum Gate version; pin the Action to a tag that has them before you write them, and
if you run the App path and the Action path against the same repository, upgrade both.

**What this still does not close.** The grade remains a pure function of the model's surviving
findings. A judge that returns one unrelated nit while saying nothing about a measured 3.23:1
contrast failure grades `ship_with_nits`, and Gate publishes a green tick with the violation printed
underneath it. Under `advisory`, which is the default, that is what you get. A repository whose
honest goal is "never merge a WCAG AA contrast failure" wants `measurements: block`, and should read
the baseline section above before turning it on: `block` acts only on violations Gate can show this
pull request introduced, so on the App path it needs a review of the base branch on record, and on the
stock Action it has no store to record one in.

**How often that actually happens, and how you read it.** Leaving the hole open is only defensible if
the size of it is measured, so Gate counts it. Every published review writes one line to the log the
Action or the service already produces, with a stable prefix and stable `key=value` fields:

```
[gate.metric] gate.review.published conclusion=success graded=true green_over_measured=true measured=contrast:1,overflow:1,touch_target:1 measured_suppressed= repo=acme/web pr=42 sha=0123456789abcdef0123456789abcdef01234567
```

`green_over_measured=true` is a green check published over an unsuppressed violation the engine marked
block-eligible. It is deliberately narrow: a model really judged the page, really produced findings,
and the engine really stood behind at least one measurement the repo did not mute. `graded=true` is the
denominator, meaning the grade reached the conclusion at all, so unjudged, nothing-reviewed and
grade-retracted runs stay out of it. Two commands, no observability vendor:

```bash
grep -c 'green_over_measured=true' gate.log   # numerator
grep -c 'graded=true' gate.log                # denominator
```

Above roughly **5% of graded runs**, the retraction predicate is too narrow to be the whole answer and
flooring the grade on measurements is the right reversal. `measured_suppressed` is what stops a healthy
zero from being read the wrong way: a repository that muted every contrast violation reports no green
checks over a measured one because there is nothing left to be green over, and above roughly 15% of what
is published for a kind, the fix is to stop emitting that kind rather than to add more configuration.

The same three counters are recorded on OpenTelemetry as `gate.review.green_over_measured`,
`gate.review.measurements_published` and `gate.review.measurement_suppressed`. `packages/observability`
registers the global `MeterProvider` and takes its metric readers by injection
(`initTelemetry({ metricReaders })`), so *whether* they leave the process is the embedding runtime's
choice: wire an OTLP `PeriodicExportingMetricReader` (or any other reader) where you run the App. Gate
itself reads no `OTEL_*` variable. With no reader registered the counters bind to the API's no-op meter,
which is why the Action path can record inside a customer's runner without any telemetry configured.
Attributes stay low-cardinality; repository and PR number appear on the log line only, never as a metric
label.

Two things Gate sends the engine come from the repository rather than from this file. `verify_stability` above rides along inside the config; alongside it, Gate reads the repository's `package.json` at the PR's head and names the component libraries it finds (`shadcn/ui`, `radix`, `mui`, `chakra`, `mantine`) so the engine can append that library's rubric note to its own prompt. Ids only, never prose: the note is the engine's text, so nothing in a pull request's own manifest is written into a model prompt. Both fields are additive and optional in both directions. A repository that opted into nothing and uses none of those libraries produces exactly the request Gate sent before either existed, an engine that has never heard of them ignores them, and a manifest that is missing, private or malformed costs a review its rubric addenda and nothing else.

