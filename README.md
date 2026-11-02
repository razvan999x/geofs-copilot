# ✈ GeoFS Copilot

**A copilot for [GeoFS](https://www.geo-fs.com), the free browser flight simulator.**
Type a city name and the plugin flies the whole trip: automatic takeoff, climb, cruise, descent, an ILS-style approach and landing. It also handles stopovers.

*Created by **Razvan Cristea**.* · 🇷🇴 [Versiunea în română mai jos](#-în-română)

![Interface](docs/screenshot-interface.png)

## Features

- **Destination by name.** Search for "London", "Paris", "Munich" or an airport code. You can also pick from destination ideas (short, medium or long flights).
- **Full flight on one button.** The plugin takes off automatically, climbs to a cruise altitude chosen for the distance, flies the route and starts the descent at the right time. It then lines up with the runway and lands.
- **Stopovers.** Add as many stops as you like. Each one is either a landing stopover (land, wait, take off again) or a fly-over.
- **Moving map** with a heading-up or north-up view. It shows the route, nearby airports by city name and the wind. You can drag and resize it.
- **Step-by-step instructions**, for example "Turn RIGHT 30° → heading 285°" or "Descend to 3000 ft". These work for manual flying too.
- **3D approach corridor** drawn in the sky, plus an ILS-style localizer and glideslope indicator.
- **The plugin picks the runway for the wind** (headwind first) and shows head- and crosswind components.
- **Landing assistant**: voice callouts (1000, 500, 100… ft), GPWS-style warnings (SINK RATE, GLIDESLOPE, GEAR, TERRAIN…) and a **landing score** from 0 to 100.
- **Extended autopilot**: altitude, heading, speed, vertical speed and max bank, with keyboard shortcuts.
- **Aircraft systems panel**: engines, gear, flaps, spoilers, brakes, trim, reverse thrust and **individual throttle per engine**.
- **English and Romanian**, switchable in Settings.

## Installation

You can load the plugin in three ways. The first one always works.

### 1. Bookmark (recommended, works everywhere)

1. Create a new bookmark in your browser (right-click the bookmarks bar → *Add page…*).
2. Name: `GeoFS Copilot`. URL: paste this line:

   ```
   javascript:(function(){var s=document.createElement('script');s.src='https://cdn.jsdelivr.net/gh/razvan999x/geofs-copilot@main/geofs-copilot.user.js';document.body.appendChild(s);})();
   ```

3. Open GeoFS, wait for the aircraft to load, then click the bookmark. A purple "GeoFS Copilot" label appears at the bottom right.

### 2. Tampermonkey (loads automatically)

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Open [geofs-copilot.user.js](https://github.com/razvan999x/geofs-copilot/raw/main/geofs-copilot.user.js). Tampermonkey offers to install it.
3. In Chrome 138 or newer, go to `chrome://extensions` → Tampermonkey → *Details* and enable **Allow User Scripts**.

### 3. Console (quick test)

Open GeoFS and press **F12** → *Console*. Paste the whole content of `geofs-copilot.user.js` and press Enter.

## How to fly

1. Press **Shift+N** to open the panel and type a city in **Navigation**. Click a result.
2. Optional: search for more cities and press **+ stopover** to build a multi-stop plan.
3. Press **✈ Full flight** (or **Shift+P**). If you are not on a runway, the plugin moves you to the start of the best one, since taxiing is not automated.
4. Sit back. To land yourself, untick *Automatic landing* in Settings. The autopilot then disconnects at 200 ft.

## Keyboard shortcuts

| Key | Action |
|---|---|
| Shift+P | full flight / stop / leave a stopover now |
| Shift+N | show/hide the panel |
| Shift+M | show/hide the map |
| Shift+H | show/hide the HUD |
| Shift+L | approach only (when already airborne) |
| Shift+R | teleport to final |
| Shift+A | engage AP and hold current values |
| Shift+↑ / ↓ | AP altitude ±1000 ft |
| Shift+← / → | AP heading ±5° |
| Shift+PgUp / PgDn | AP speed ±10 kt |
| Shift+G / F / S / E | gear / flaps / spoilers / engines |
| Shift+C | next camera |
| Shift+X | show last landing score |

## Notes

- Airport and runway data come from [OurAirports](https://ourairports.com/data/) (public domain). They download once (~15 MB) and are cached in your browser.
- Some GeoFS aircraft have no autopilot. On those, follow the on-screen instructions and the map manually.
- This is an unofficial fan project. It is not affiliated with GeoFS.

## License

[MIT](LICENSE) © 2026 Razvan Cristea

---

## 🇷🇴 În română

**Un copilot pentru GeoFS, simulatorul de zbor gratuit din browser.** Scrii numele unui oraș, iar pluginul face tot zborul: decolare automată, urcare, croazieră, coborâre, apropiere ca un ILS și aterizare. Știe și escale.

*Creat de **Razvan Cristea**.*

**Instalare.** Cel mai simplu e semnul de carte (*bookmark*) de mai sus:
1. Creezi un semn de carte nou cu linia `javascript:…` ca adresă.
2. Deschizi GeoFS și aștepți să se încarce avionul.
3. Apeși pe semnul de carte.

Merge și cu Tampermonkey sau lipind codul în Console (F12).

**Utilizare:**
1. **Shift+N** deschide panoul. În *Navigation* scrii orașul și alegi rezultatul.
2. Cu **+ stopover** adaugi escale.
3. **✈ Full flight** (Shift+P) pornește zborul.

Limba se schimbă în **Settings → Language / Limba**.
