# Changelog

## 1.8.3
- Update notice: the plugin checks `version.json` on GitHub at start and every 3 hours. When a newer version is out, a card shows what's new and how to update (bookmark: reload; Tampermonkey: *Update now*). A ⬆️ badge also appears in the panel header.

## 1.8.2
- Administrator login with a password (Settings → Administrator login), so the admin works on any computer or browser. The admin sets the password in the Admin tab. Wrong attempts are rate-limited on the server.
- Admin logout on a single computer.

## 1.8.1
- Notifications: the administrator can send a message to all players or to one pilot. It pops up in GeoFS within a minute (kept for 7 days).
- Administrator mode for the project owner (confirmed by the server): hidden from leaderboards and stats, optional unlimited money and top rank.

## 1.8.0
- **Daily challenge:** one tricky airport a day for everyone, with a *Fly it now* button that puts you on final and a daily leaderboard.
- **Day streaks:** bonus XP for the first flight of each day, up to +70 XP.
- **Weekly landing contest:** every pilot's best landing of the week is ranked; the top 3 earn the Podium badge.
- **Special missions:** bush flights to short strips, sightseeing tours over landmarks, skydiver drops, aerial survey and search & rescue, with points on the 3D map and the moving map and an *AP → point* mode.
- **Airport passport:** airports and countries you have visited, with flags in the plugin and a map on the website.
- **Airline:** found your own airline at a hub, buy aircraft, assign routes you have flown and collect income daily (kept for up to 24 h). Reputation follows your mission landings.
- 15 new achievements (30 in total).
- Landings on short strips (under 2,000 ft) are now recognised. The logbook records the aircraft's real name.
- Website: Daily, Contest and Airlines pages, a passport map and streak on pilot profiles, and Countries and Streak leaderboards.

## 1.7.2
- The ATC tower no longer posts "Tower online" in the public chat every minute. Its presence travels through the hidden Copilot signal instead. There is one optional chat announcement when the tower opens ("Announce tower in chat: once / never").

## 1.7.1
- Same pilot on several computers: a pilot code (Career tab) links computers and merges their profiles and flights. Progress (money, rank, type ratings, achievements, lessons) is saved to the cloud and loaded on every linked computer.
- Automatic notice when the same GeoFS account already has another pilot profile.

## 1.7.0
- Career: XP, 7 ranks, aircraft classes unlocked by rank or by a purchased type rating, and a pay bonus per rank.
- Random failures and emergencies (engine, gear, bird strike, fuel leak, medical, autopilot) with a checklist card, divert-to-nearest and MAYDAY. Missions still pay when you divert.
- Flight school: 5 guided lessons and 15 achievements.
- Logbook with flight paths, exported as KML (Google Earth), GPX or CSV. Your own flight path is drawn on the map.
- Online leaderboard backed by Supabase. The server validates flights and computes XP.
- Website (GitHub Pages): leaderboard, pilot profiles, best landings, recent flights, global stats and install page.
- Panel tabs wrap into two rows. New tabs: Career, Training, Logbook.

## 1.6.1
- Live mission and fuel lines in the instruction box: cargo, pay, time left vs. ETA, fuel on board, flow, endurance and estimated fuel at arrival (with warnings).
- Mission offers only appear on the ground at an airport, with no active mission.

## 1.6.0
- Fuel system: capacity and burn estimated from the aircraft's mass and engine power. Refuelling on the ground at airports costs money. The engines stop in flight when the tank is empty. Low-fuel warnings, an endurance display, fuel needed for the route, and a fuel column on the HUD.
- Missions: passengers, cargo, fragile cargo, urgent medical and VIP flights from your current airport, with deadlines, bonuses and penalties. Balance, flight hours, distance and history are saved.
- New Missions tab in the panel.

## 1.5.2
- The 250 kt limit below 10,000 ft is now optional (Settings) and off by default.
- A speed you set on the autopilot during cruise is kept until the approach, instead of being overridden.

## 1.5.1
- Fix: Copilot users are now identified by their GeoFS player ID. Previously one signed-out user ("Foo") marked every signed-out pilot as a Copilot user and inflated the counter.
- The header counter uses the worldwide count when it is available.

## 1.5.0
- Multiplayer traffic is drawn on the moving map, with relative altitude.
- Other GeoFS Copilot users are recognised (a small version field in the position update, or their ATC messages) and marked with a gold ★ on the map and the ATC radar.
- The panel header shows how many Copilot users are online (worldwide when the GeoFS player list provides it, otherwise nearby).
- The signal can be switched off (ATC tab). It turns itself off if the GeoFS server rejects it.

## 1.4.1
- The HUD and the instruction box sit lower by default, so they no longer cover the GeoFS autopilot bar.
- The HUD and the instruction box can be dragged by their ⠿ handle; double-click the handle to restore the default position.

## 1.4.0
- Air traffic control module: controller role with radar, traffic strips and clearances, sent over the GeoFS chat.
- Pilots receive ATC instructions as Accept/Unable cards, and the autopilot carries them out (line up, takeoff, landing, go-around, hold, heading/altitude/speed vectors).
- Automatic takeoff and landing requests; go-around at 500 ft without a landing clearance.
- Virtual tower when no human controller is online: runway and final checks from GeoFS multiplayer traffic, with an automatic go-around if the runway is occupied.

## 1.3.0
- English interface by default, Romanian available in Settings → Language / Limba.
- "About" section in Settings (author, version, GitHub link).
- Bookmark loader (no Tampermonkey needed).

## 1.2.x
- Automatic takeoff (centerline tracking, rotation, hand-off to the autopilot).
- Multi-stop flight plans: landing stopovers or fly-overs, reorder and remove stops.
- The plugin injects itself into the page, so it works when Tampermonkey runs it in a sandbox.
- The map can be dragged and resized, and remembers its position.

## 1.1.0
- Airport search by city, name, country or code (Romanian and English names).
- Destination ideas by flight length.
- Full-flight mode: climb, cruise, top-of-descent, approach, landing.
- Moving map and step-by-step instructions.

## 1.0.0
- ILS-style approach to any runway with a 3D corridor, HUD and landing assistant with score.
- Extended autopilot, aircraft systems panel, per-engine throttle and keyboard shortcuts.
