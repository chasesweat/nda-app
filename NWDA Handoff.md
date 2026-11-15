# NWDA App — Handoff Document

**Build:** 202608191392 · `nwda-cache-v983`

## OPEN ITEMS / ON HOLD (as of Nov 14, 2026 — current list; update each release)

**On hold, waiting on Chase:**
1. **Blast / promo text to the client list (added Nov 14).** Chase wants to send promotions (first use: a Christmas-lights display flyer) to the whole client list instead of texting one at a time. Chase is holding off to think through the legal side (marketing-text consent, carrier registration, STOP handling) before we build. Discussed design, not built:
   - *Option 1 (no new service):* "Text my clients" screen on the Clients page: filters (all / rode in last X months / airport / per-driver), template with `{first name}`, flyer sent as a hosted LINK (sms: links cannot attach images), steps through clients one at a time opening the phone's text app (sends from the user's own number, no group thread), "Don't text" flag per client, "sent already" tracking. One update to build.
   - *Option 2 (later):* real bulk MMS through a texting service (e.g. Twilio): one tap, image attached; needs monthly cost, carrier registration, working STOP replies. Same as the on-hold texting service below; Option 1's filters/templates would carry over.
   - Legal note given to Chase: promo texts to people who haven't opted in can create liability; suggested a "yes, text me promos" checkbox on the booking form plus the Don't-text flag, and a lawyer check before a large blast. Need from Chase when resuming: the flyer file (image/PDF) to host, and a go-ahead on Option 1 vs 2.
2. **Automatic flight-delay / traffic alerts to drivers' phones (added Nov 14).** Chase asked whether a Grok GitHub bot could do this. Answer given: a repo bot works on code, not rides; GitHub Pages only serves static files. What's actually needed is a scheduled server-side job (every few minutes) that reads upcoming rides from Firebase, checks live flight status (airport pickups) and traffic-aware drive time, and sends a push to the assigned driver via the app's existing push setup (firebase-messaging-sw.js). Chase is undecided; not started. Design notes:
   - *Where it runs:* GitHub Actions cron (free/cheap, but runs often start late; fine for "flight 40 min late", weak for tight timing) or Firebase scheduled functions (more reliable, next to DB/push; needs Blaze pay-as-you-go plan, usually pennies at this volume).
   - *Data costs:* live flight status needs a flight-data API (free tiers small; reliable ones roughly tens of $/month); Google traffic-aware drive times are per-lookup (likely a few $/month at this volume). Needs API keys stored as secrets (GitHub Secrets / Firebase config) and a Firebase service-account for server-side DB reads.
   - *No AI model needed* — plain rules (late by more than X min → alert). AI only if friendlier alert wording is wanted.
   - *Suggested first version:* flight-delay alerts only, for airport pickups in the next 24 h, to the assigned driver; traffic alerts later. Chase to decide on a flight-data service first (I offered to research which fits his ride volume).
3. **Bots** (texting service / in-app inbox / model) — on hold.
4. **Sprinter minimum fare** value — on hold.

**Chase to do:** upload latest index.html + sw.js together (v1392); real-phone checks for builds v1343–v1392 (incl. two-phone airplane-mode test of the offline outbox); confirm the "Update now" banner is gone (v1388/v1389; if not, send the build number from the hamburger menu); check Firebase `clientRequests` rules (booking-link failure, v1371); confirm FamilyWall export now shows flight numbers (v1387; send a ride if a plain one-way still drops it).

**Housekeeping:** Project `START-HERE.md` and `verify_fixes.py` still say v1381 (add checks for v1382–v1390, incl. "sw.js `app build` equals index meta version").

---

## v1392: Changing a ride's date clears its confirmation (check mark off, back on To Confirm)

**Reported:** when a ride is rescheduled to a different date, the calendar's confirmed check mark must reset, and the ride must show on the To Confirm list.

**Change (`saveRideEdits`, Edit Ride form):** if the date changed on a ride that was confirmed (`confirmSent` true, or status Confirmed): `confirmSent` is set false, `confirmSentBy/At` removed, status Confirmed → Scheduled (Paid/Completed keep their status), and a history-trail entry "confirmation reset (date changed)" is written via `touchRide`. The save toast adds "confirmation cleared, it needs a new confirmation text". Applies on ANY date change (earlier or later), because the client was told the old day.

**To Confirm:** no list change needed. To Confirm / the dashboard "confirmations" box show tomorrow's rides that are not `confirmSent`, so a rescheduled ride appears there automatically once its new date is tomorrow (it will not show earlier, same as every ride).

**Not changed:** a TIME-only change still keeps the confirmation (not requested; tell me if it should clear too). The Edit Ride form is the only code path that changes a ride's date (checked); Quick Add / new rides unaffected. Only the edited ride is reset (not its round-trip partner leg).

**Tests:** new confreset.js (wired before save; later date clears; same date untouched; unconfirmed untouched; Paid keeps status) + bootcheck 0 errors. Not verified on a phone.

---

## v1391: "Fees awaiting approval" moved back to the bottom of the dashboard

**Reported (screenshot):** Chase thought this box had been moved to the bottom; it was showing near the top, above "Team rides to wrap up" and "Rides you're driving".

**What the history shows:** it WAS at the bottom (confirmed in v1111). In v1316 (dashboard re-order: Money / Do now / Info / Warnings) I moved it up into the Money group as "the other person's side". There is no record of it being moved back down, so that was the cause. Chase's preference (confirmed v1111, restated now): bottom of the dashboard.

**Change:** the `dash-fees-awaiting-approval` box now sits after "Your upcoming rides" and "Confirmations sent", just above the Warnings group. Position only; nothing else on the dashboard moved. "Fees awaiting YOUR approval" (Do-now group) is unchanged.

**Tests:** bootcheck 0 errors; element order checked in the HTML. Not verified on a phone.

---

## v1390: My Fares — wider money boxes, and Start/End odometer fields

**Reported (screenshot):** (1) Fare/Tip/Client-fee boxes in the My Fares dropdown cut off the numbers ("113.0C", "16.9"). (2) Wanted to edit start and end odometer readings in the dropdown, not just total miles.

**Changes (My Fares card, `index.html`):**
- Fare box 72→104 px, Tip 64→104 px, Client fee 60→96 px (box-sizing border-box) so full amounts show.
- New rows "Start miles (odometer)" and "End miles (odometer)" above "Miles driven". Editing either (saves on leaving the field) calls new `persistRideOdo(rideId)`: validates with `_validateOdoSet`, sets `odoStart`/`odoEnd`, recomputes `drivenMiles` (two-segment rule if the ride was paused/resumed), stamps cost basis, records `odoEditedAt/By`, saves via `_persistRideEdit` (so the ride is protected and Income/dashboard refresh), then reopens the card. Live miles preview as you type (`_fareOdoPreview`).
- A blank reading never wipes a manually logged total; invalid pairs (end lower than start) show a toast and save nothing. The old button is now "Edit total" (type a total directly, for rides with no odometer).

**Tests:** new fareodo.js (valid edit recalculates miles 127→200; end below start refused) + bootcheck 0 errors. The real My Fares card render was not exercised in jsdom; not verified on a phone. Outside-ride rows were not changed.

---

## v1389: "Update now" banner still came back — browser HTTP cache served the old page

**Reported (with screenshot):** after v1388 the "A new version is ready" bar was still showing. (Not confirmed whether v1388 had been uploaded on that phone.)

**Likely cause (second layer):** "Update now" cleared the app cache and reloaded, but the reload could still be answered from the browser's own HTTP cache (a separate cache), returning the old index.html, which then still mismatches sw.js, so the bar returned.

**Fix:** `_hardUpdate` now (1) force-fetches index.html and sw.js with `cache:'reload'`, (2) updates then unregisters the service worker (it re-registers on load), (3) clears app caches, (4) reloads. The worker's page fetch now uses `cache:'no-cache'` so it always revalidates with the server. Build line in sw.js = index meta = 202608191389, cache v980.

**Tests:** bootcheck 0 errors; sw.js parses. Not verified on a real phone. If the bar still shows after uploading BOTH files and tapping Update now once, tell me the build number shown in the hamburger menu.

---

## v1388: "Update now" banner kept reappearing — sw.js build line was stale

**Reported:** the "A new version is ready — Update now" bar appeared on every tab change, even after tapping Update now.

**Cause:** my mistake. The banner compares the `app build NNNNNNNNNNNN` line inside `sw.js` against `<meta name="version">` in `index.html`. In v1386 and v1387 I bumped the meta and the cache name but left that sw.js line at 202608191385, so the two never matched and the bar was permanent.

**Fix:** sw.js build line and index.html meta both 202608191388, cache `nwda-cache-v979`.

**CHECKLIST ADDITION (every release):** sw.js line 12 `app build` number MUST equal the index.html meta version, in addition to the cache name bump. Verify with: `grep -o 'app build [0-9]*' sw.js` vs `grep -o 'name="version" content="[0-9]*"' index.html`.

---

## v1387: FamilyWall export now includes the flight number when it's on the return leg

**Reported:** AP pickups exported to FamilyWall had no flight number.

**Cause found (best fit, not reproduced on Chase's data):** the export description only used `r.flight`. On a round trip whose airport pickup is leg 2, the flight is stored as `rtFlight`, so it was dropped. The terminal line already fell back to `rtTerminal`; the flight did not.

**Change:** `_icsEventDesc` uses `r.flight`, else `r.rtFlight`. Leg-1 flight wins if both exist. Applies to every .ics export (single ride, bulk FamilyWall, personal export) since they share this builder.

**Tests:** new fwflight.js (leg-1 flight, return-leg flight, both) passes; bootcheck 0 errors. If a plain one-way AP pickup with a flight still exports without it, the cause is something else: send me that ride's details.

---

## v1386: No more "continue previous quote?" prompts on the Quote page

**Reported:** every return to the Quote page asked "Restore unsaved info?" / "Unfinished quotes". Chase: auto-save already keeps the quote; to resume, pick it from the Saved Quotes list.

**Change:** removed both prompts from the Quote-page open handler (`_draftMaybeOffer('page-quote',…)` and `_qdMaybeOffer()` calls). The functions remain (Quick Add still uses `_draftMaybeOffer`), only the Quote page no longer calls them. Drafts are still written in the background; nothing is deleted.

**Tests:** bootcheck 0 errors, dupquote ALL OK, outbox ALL OK. Not verified on a real phone.

---

## v1385: One booking request = one saved quote (no more $20–30 duplicates)

**Report (Chase, Nov 10, 9:24 AM):** a booking request was saving multiple quotes, one at the real price and one for about $20–30.
**Cause (reproduced on v1384):** opening a booking request fills the Quote page step by step. The 1.5 s auto-save can fire before the trip distance is known; a ONE WAY / ROUND TRIP with no miles is priced with only the surcharges (the test showed $27.00), so a half-built quote was saved. When the marker that ties the screen to its saved quote was lost (the Quote page clears it on every visit, and Clear/Schedule clear it too) the next save found no match and added a second quote.
**Fix:** (1) `_quoteAutoSave` no longer saves a ONE WAY / ROUND TRIP while the distance (or Sprinter hours) is empty; the status line says "waiting for the distance". (2) Every quote created from a booking request now carries `fromRequestId`; both auto-save and send-the-quote look it up (after the editing marker, before client+date), so the same request always updates the same quote; refreshing keeps its original saved/sent times. (3) `_dedupePartialQuotes` (runs when Saved Quotes loads) removes already-saved half-built duplicates ONLY when: price under $50, never sent, another quote for the same client at least $60 and at least twice the price, saved within 2 hours, dates agree (or one has none). Removed quotes are kept in that phone's `nda-removed-partial-quotes` (last 20) and a toast says how many went.
**Not changed:** pricing. **Limit:** quotes whose partial price is $50 or more, or that were sent, are never auto-removed (delete by hand in Saved Quotes).
**Tests:** dupquote.js (partial price not saved; complete quote saves; lost marker + same request updates the one quote; cleanup keeps sent / cheap-but-legit / other-day quotes); bootcheck, stops, tracker, outbox, outbox2, outbox4, authwait pass. Reduced regression (the v1370–v1381 suite was lost). Not tried on a real booking request.
