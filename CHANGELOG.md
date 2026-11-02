# Changelog

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
