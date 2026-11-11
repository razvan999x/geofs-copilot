# Changelog

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
