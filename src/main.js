import * as THREE from 'https://unpkg.com/three@0.158.0/build/three.module.js';

// Simple helper to update status
const setStatus = (s) => { document.getElementById('status').textContent = s; };

// Initialize Leaflet map
const map = L.map('map').setView([21.0278, 105.8342], 13); // Hà Nội as default
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

// FeatureGroup to store editable layers
const drawnItems = new L.FeatureGroup().addTo(map);

// Draw control (rectangle only)
const drawControl = new L.Control.Draw({
  draw: {
    polygon: false,
    polyline: false,
    circle: false,
    marker: false,
    circlemarker: false,
    rectangle: {
      shapeOptions: { color: '#f06' }
    }
  },
  edit: { featureGroup: drawnItems }
});
map.addControl(drawControl);

map.on(L.Draw.Event.CREATED, function (e) {
  const layer = e.layer;
  drawnItems.clearLayers();
  drawnItems.addLayer(layer);
});

document.getElementById('btn-clear').addEventListener('click', () => {
  drawnItems.clearLayers();
  setStatus('Cleared');
});

// Ensure osmtogeojson library is available (dynamically inject if needed)
function ensureOsmtogeojson() {
  if (window.osmtogeojson) return Promise.resolve(window.osmtogeojson);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/osmtogeojson@3.0.0/osmtogeojson.js';
    s.onload = () => { if (window.osmtogeojson) resolve(window.osmtogeojson); else reject(new Error('osmtogeojson not available after load')); };
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

// Fallback converter: Overpass JSON -> GeoJSON (simple, covers nodes and ways used here)
function convertOverpassJsonToGeoJSON(osm) {
  const nodes = new Map();
  const features = [];
  if (!osm || !Array.isArray(osm.elements)) return { type: 'FeatureCollection', features };
  for (const el of osm.elements) {
    if (el.type === 'node') nodes.set(el.id, el);
  }
  for (const el of osm.elements) {
    if (el.type === 'node') {
      features.push({ type: 'Feature', properties: el.tags || {}, geometry: { type: 'Point', coordinates: [el.lon, el.lat] } });
    } else if (el.type === 'way') {
      const coords = (el.nodes || []).map(id => nodes.get(id)).filter(Boolean).map(n => [n.lon, n.lat]);
      if (coords.length === 0) continue;
      const props = el.tags || {};
      // determine polygon vs linestring: building or closed
      let geom = null;
      const first = coords[0], last = coords[coords.length-1];
      const isClosed = first && last && first[0] === last[0] && first[1] === last[1];
      if (props.building || isClosed) {
        // ensure closed
        if (!isClosed) coords.push(coords[0]);
        geom = { type: 'Polygon', coordinates: [coords] };
      } else {
        geom = { type: 'LineString', coordinates: coords };
      }
      features.push({ type: 'Feature', properties: props, geometry: geom });
    }
    // relations not handled in this simple converter
  }
  return { type: 'FeatureCollection', features };
}

// Overpass fetch helper (handles JSON or XML responses)
async function fetchOverpass(bbox) {
  // bbox: [south, west, north, east]
  const query = `[out:json][timeout:25];(way["building"](${bbox.join(',')});way["highway"](${bbox.join(',')});way["waterway"](${bbox.join(',')});node["natural"="tree"](${bbox.join(',')});way["landuse"="forest"](${bbox.join(',')}););out body;>;out skel qt;`;

  const url = 'https://overpass-api.de/api/interpreter';
  const res = await fetch(url, {
    method: 'POST',
    body: query,
    headers: { 'Content-Type': 'text/plain' }
  });
  if (!res.ok) throw new Error('Overpass fetch failed: ' + res.status);

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json') || contentType.includes('json')) {
    const data = await res.json();
    // Try to use osmtogeojson if present (it can accept Overpass JSON), otherwise use fallback converter
    if (window.osmtogeojson) return window.osmtogeojson(data);
    try {
      // attempt dynamic load and convert
      const osmtogeojson = await ensureOsmtogeojson();
      return osmtogeojson(data);
    } catch (err) {
      // fallback to simple converter
      return convertOverpassJsonToGeoJSON(data);
    }
  }

  // if not JSON, try text -> XML
  const text = await res.text();
  const parser = new DOMParser();
  const xml = parser.parseFromString(text, 'application/xml');
  // try to use osmtogeojson (dynamically load if necessary)
  try {
    const osmtogeojson = window.osmtogeojson ? window.osmtogeojson : await ensureOsmtogeojson();
    return osmtogeojson(xml);
  } catch (err) {
    throw new Error('Failed to convert Overpass response to GeoJSON: ' + err.message);
  }
}

// Three.js viewer setup
const viewerEl = document.getElementById('viewer');
const width = viewerEl.clientWidth || 800;
const height = viewerEl.clientHeight || 600;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9dbfe6);

const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 10000);
camera.position.set(0, -200, 200);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(width, height);
viewerEl.appendChild(renderer.domElement);

const light = new THREE.DirectionalLight(0xffffff, 0.8);
light.position.set(100, -100, 200);
scene.add(light);
scene.add(new THREE.AmbientLight(0xffffff, 0.6));

// Controls (basic orbit-like)
let isDragging = false;
let previousMousePosition = { x: 0, y: 0 };
viewerEl.addEventListener('mousedown', (e) => { isDragging = true; previousMousePosition = { x: e.clientX, y: e.clientY }; });
viewerEl.addEventListener('mouseup', () => { isDragging = false; });
viewerEl.addEventListener('mousemove', (e) => {
  if (!isDragging) return;
  const deltaMove = { x: e.clientX - previousMousePosition.x, y: e.clientY - previousMousePosition.y };
  const rotSpeed = 0.005;
  scene.rotation.y += deltaMove.x * rotSpeed;
  scene.rotation.x += deltaMove.y * rotSpeed;
  previousMousePosition = { x: e.clientX, y: e.clientY };
});
viewerEl.addEventListener('wheel', (e) => {
  e.preventDefault();
  camera.position.z += e.deltaY * 0.2;
});

function animate() { requestAnimationFrame(animate); renderer.render(scene, camera); }
animate();

// Convert lat/lng to local X/Y planar coordinates (simple equirectangular approx)
function latLngToXY(lat, lng, origin) {
  const R = 6378137; // Earth radius
  const dLat = (lat - origin.lat) * Math.PI / 180;
  const dLng = (lng - origin.lng) * Math.PI / 180;
  const x = R * dLng * Math.cos(origin.lat * Math.PI / 180);
  const y = R * dLat;
  // scale down to meters -> units
  return [x, y];
}

// Build simple 3D meshes from GeoJSON
function buildSceneFromGeoJSON(geojson) {
  // clear old
  while (scene.children.length > 0) {
    scene.remove(scene.children[0]);
  }
  scene.add(light);
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));

  if (!geojson.features || geojson.features.length === 0) {
    setStatus('No features returned');
    return;
  }

  // choose origin as centroid of bbox (fallback to first feature)
  const sampleCoords = [];
  for (const f of geojson.features) {
    if (f.geometry && f.geometry.type === 'Point') sampleCoords.push(f.geometry.coordinates);
    else if (f.geometry && f.geometry.coordinates) {
      const flat = f.geometry.coordinates.flat(3);
      for (let i = 0; i < flat.length; i += 2) sampleCoords.push([flat[i], flat[i+1]]);
    }
  }
  const lats = sampleCoords.map(c => c[1]);
  const lngs = sampleCoords.map(c => c[0]);
  const origin = {
    lat: lats.reduce((a,b)=>a+b,0)/lats.length,
    lng: lngs.reduce((a,b)=>a+b,0)/lngs.length
  };

  // compute approximate extent to size ground plane
  const xs = [], ys = [];
  for (const c of sampleCoords) { const [x,y] = latLngToXY(c[1], c[0], origin); xs.push(x); ys.push(y); }
  const xmin = Math.min(...xs), xmax = Math.max(...xs), ymin = Math.min(...ys), ymax = Math.max(...ys);
  const margin = 200;
  const planeW = (xmax - xmin) + margin*2 || 1000;
  const planeH = (ymax - ymin) + margin*2 || 1000;

  // simple 2D noise for terrain
  function noise2(x, y) {
    // deterministic pseudo-noise using sin
    return (Math.sin(x*0.0005) + Math.cos(y*0.0007) + Math.sin((x+y)*0.0003))*0.5;
  }

  // create ground terrain mesh
  const seg = 64;
  const geom = new THREE.PlaneGeometry(planeW, planeH, seg, seg);
  const pos = geom.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const vx = pos.getX(i) + (xmin + xmax)/2; // center to global
    const vy = pos.getY(i) + (ymin + ymax)/2;
    const h = noise2(vx, vy) * 30; // scale
    pos.setZ(i, h);
  }
  geom.computeVertexNormals();
  const ground = new THREE.Mesh(geom, new THREE.MeshLambertMaterial({ color: 0x88aa66 }));
  ground.rotation.x = -Math.PI/2;
  scene.add(ground);

  // helper to create shape from polygon coords
  const createExtruded = (poly, height, color, zOffset=0) => {
    const shape = new THREE.Shape();
    poly.forEach((pt, idx) => {
      const [x,y] = latLngToXY(pt[1], pt[0], origin);
      if (idx === 0) shape.moveTo(x, y);
      else shape.lineTo(x, y);
    });
    const geo = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
    const mat = new THREE.MeshLambertMaterial({ color });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI/2;
    mesh.position.z = zOffset;
    scene.add(mesh);
    return mesh;
  };

  // scatter helper for orchards
  const scatterTreesInPoly = (poly, count=20) => {
    // bounding box of polygon in latlng
    const lats = poly.map(p => p[1]);
    const lngs = poly.map(p => p[0]);
    for (let i=0;i<count;i++){
      const lat = lats[0] + Math.random()*(Math.max(...lats)-Math.min(...lats)||0.0001);
      const lng = lngs[0] + Math.random()*(Math.max(...lngs)-Math.min(...lngs)||0.0001);
      const [x,y] = latLngToXY(lat, lng, origin);
      const g = new THREE.ConeGeometry(1.5, 6, 6);
      const m = new THREE.MeshLambertMaterial({ color: 0x2f8b2f });
      const mesh = new THREE.Mesh(g,m);
      mesh.position.set(x,y,3);
      scene.add(mesh);
    }
  };

  // iterate features and render
  for (const feat of geojson.features) {
    const props = feat.properties || {};
    const geomF = feat.geometry;
    if (!geomF) continue;

    if (geomF.type === 'Polygon' || geomF.type === 'MultiPolygon') {
      const polys = (geomF.type === 'Polygon') ? [geomF.coordinates] : geomF.coordinates;
      for (const poly of polys) {
        const outer = poly[0];
        if (props.building) {
          const height = (props['height'] && !isNaN(+props['height'])) ? +props['height'] : 8 + Math.random()*12;
          createExtruded(outer, height, 0xcccccc);
        } else if (props.landuse === 'residential') {
          createExtruded(outer, 1 + Math.random()*2, 0xeeddbb);
        } else if (props.landuse === 'orchard' || props.landuse === 'garden') {
          createExtruded(outer, 0.5, 0x77bb66);
          scatterTreesInPoly(outer, 30);
        } else if (props.landuse === 'forest' || props.natural === 'wood') {
          createExtruded(outer, 1, 0x2f8b2f);
        } else if (props.natural === 'mountain' || props.natural === 'peak') {
          // create a mound using extrusion of the polygon
          createExtruded(outer, 40 + Math.random()*60, 0x7f7f7f);
        } else {
          // generic low extrusion for fields
          // createExtruded(outer, 0.2, 0x88aa66);
        }
      }
    } else if (geomF.type === 'LineString' || geomF.type === 'MultiLineString') {
      const lines = (geomF.type === 'LineString') ? [geomF.coordinates] : geomF.coordinates;
      for (const line of lines) {
        // create thin mesh segments to represent road/river
        for (let i = 0; i < line.length - 1; i++) {
          const a = line[i], b = line[i+1];
          const [ax, ay] = latLngToXY(a[1], a[0], origin);
          const [bx, by] = latLngToXY(b[1], b[0], origin);
          const dx = bx - ax, dy = by - ay;
          const len = Math.sqrt(dx*dx + dy*dy) || 1;
          const angle = Math.atan2(dy, dx);
          const box = new THREE.BoxGeometry(len, (props.waterway?6: (props.highway?4:2)), 0.5);
          const mat = new THREE.MeshLambertMaterial({ color: props.waterway ? 0x3f83ff : 0x444444 });
          const mesh = new THREE.Mesh(box, mat);
          mesh.position.set((ax+bx)/2, (ay+by)/2, 1);
          mesh.rotation.z = angle;
          scene.add(mesh);
        }
      }
    } else if (geomF.type === 'Point') {
      // trees or peaks
      const [x,y] = latLngToXY(geomF.coordinates[1], geomF.coordinates[0], origin);
      if (props.natural === 'peak' || props.natural === 'mountain') {
        const g = new THREE.ConeGeometry(20, 80, 8);
        const m = new THREE.MeshLambertMaterial({ color: 0x7f7f7f });
        const mesh = new THREE.Mesh(g,m);
        mesh.position.set(x,y,40);
        scene.add(mesh);
      } else if (props.natural === 'tree' || props['leaf_type'] || props['tree']) {
        const g = new THREE.ConeGeometry(1.5, 6, 6);
        const m = new THREE.MeshLambertMaterial({ color: 0x2f8b2f });
        const mesh = new THREE.Mesh(g, m);
        mesh.position.set(x, y, 3);
        scene.add(mesh);
      }
    }
  }

  setStatus('3D model built (approximate)');
}

// Button fetch handler
document.getElementById('btn-fetch').addEventListener('click', async () => {
  try {
    setStatus('Preparing request...');
    if (drawnItems.getLayers().length === 0) { setStatus('Please draw a rectangle first'); return; }
    const layer = drawnItems.getLayers()[0];
    const bounds = layer.getBounds();
    const bbox = [bounds.getSouth(), bounds.getWest(), bounds.getNorth(), bounds.getEast()];
    setStatus('Fetching OSM data...');
    const geojson = await fetchOverpass(bbox);
    setStatus('Parsing & building 3D...');
    buildSceneFromGeoJSON(geojson);
  } catch (err) {
    console.error(err);
    setStatus('Error: ' + err.message);
  }
});
