# Map Look - Scan & 3D Explore

Prototype app using Leaflet (selection), Overpass (OSM data), Three.js (3D) and Tailwind for styles.

How it works
- On the left: Leaflet map. Click-drag to draw a rectangle to select an area.
- Press "Quét khu vực" to query Overpass for buildings inside the bbox.
- The right pane shows a Three.js view where building footprints are extruded into simple 3D blocks.
- Press "Vào 3D" to position the camera and enable pointer-lock flight controls (WASD + mouse) similar to a 'god mode' explorer.

Notes & caveats
- This is a prototype. Building heights are taken from OSM `height` or `building:levels` when available; otherwise a default height is used.
- Overpass has rate limits. For larger bboxes the query may time out or be refused.
- Coordinate conversion uses a simple equirectangular approximation; accurate projects should use a proper projection (e.g., proj4).

Run
- Open `index.html` in a browser that supports ES modules (Chrome/Edge/Firefox). For local file access you may need to serve with a simple static server (e.g., `python -m http.server`).

Future improvements
- Add better parsing for relations, roof shapes, and textures.
- Use a spatial index and level-of-detail for large areas.
- Improve projection accuracy and unit tests.
