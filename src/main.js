import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

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
        s.src = 'https://cdn.jsdelivr.net/npm/osmtogeojson@3.0.0-beta.5/osmtogeojson.min.js';
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
    // First pass: collect nodes and ways
    const ways = new Map();
    for (const el of osm.elements) {
        if (el.type === 'node') nodes.set(el.id, el);
        else if (el.type === 'way') ways.set(el.id, el);
    }

    // Emit node features
    for (const [id, n] of nodes.entries()) {
        features.push({ type: 'Feature', properties: n.tags || {}, geometry: { type: 'Point', coordinates: [n.lon, n.lat] } });
    }

    // Emit way features (lines or polygons)
    for (const [id, w] of ways.entries()) {
        const coords = (w.nodes || []).map(id => nodes.get(id)).filter(Boolean).map(n => [n.lon, n.lat]);
        if (coords.length === 0) continue;
        const props = w.tags || {};
        const first = coords[0], last = coords[coords.length - 1];
        const isClosed = first && last && first[0] === last[0] && first[1] === last[1];
        if (props.building || isClosed) {
            if (!isClosed) coords.push(coords[0]);
            features.push({ type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: [coords] } });
        } else {
            features.push({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: coords } });
        }
    }

    // Handle relations (basic multipolygon assembly)
    const relations = osm.elements.filter(e => e.type === 'relation');
    for (const rel of relations) {
        const tags = rel.tags || {};
        if (tags.type === 'multipolygon' || tags.type === 'boundary' || tags.type === 'building') {
            // build rings from member ways with role=outer/inner
            const outerRings = [];
            const innerRings = [];
            if (Array.isArray(rel.members)) {
                // group member ways
                const memberWays = rel.members.filter(m => m.type === 'way');
                // try to assemble consecutive way segments into rings (best-effort)
                const rings = [];
                for (const mw of memberWays) {
                    const way = ways.get(mw.ref);
                    if (!way || !way.nodes) continue;
                    const coords = way.nodes.map(nid => nodes.get(nid)).filter(Boolean).map(n => [n.lon, n.lat]);
                    if (coords.length === 0) continue;
                    // ensure closed
                    const f = coords[0], l = coords[coords.length - 1];
                    if (!(f[0] === l[0] && f[1] === l[1])) coords.push(coords[0]);
                    if (mw.role === 'outer') outerRings.push(coords);
                    else innerRings.push(coords);
                }
                if (outerRings.length > 0) {
                    // combine outer rings into a MultiPolygon (each outer with its inners)
                    const polygons = outerRings.map(or => [or]);
                    // naive: attach all inner rings to first polygon
                    if (innerRings.length > 0) polygons[0] = polygons[0].concat(innerRings);
                    features.push({ type: 'Feature', properties: tags, geometry: { type: 'MultiPolygon', coordinates: polygons } });
                }
            }
        }
    }
    return { type: 'FeatureCollection', features };
}

// Overpass fetch helper (handles JSON or XML responses)
async function fetchOverpass(bbox) {
    // bbox: [south, west, north, east]
    // Expanded query: include relations and additional tags for water, peaks, orchards, gardens, forests
    const query = `[out:json][timeout:25];(
            way["building"](${bbox.join(',')});
            relation["building"](${bbox.join(',')});
            way["highway"](${bbox.join(',')});
            relation["highway"](${bbox.join(',')});
            way["waterway"](${bbox.join(',')});
            relation["waterway"](${bbox.join(',')});
            way["natural"="water"](${bbox.join(',')});
            relation["natural"="water"](${bbox.join(',')});
            way["water"](${bbox.join(',')});
            way["natural"="peak"](${bbox.join(',')});
            node["natural"="peak"](${bbox.join(',')});
            node["natural"="tree"](${bbox.join(',')});
            way["landuse"="forest"](${bbox.join(',')});
            way["landuse"="orchard"](${bbox.join(',')});
            way["landuse"="garden"](${bbox.join(',')});
            relation["landuse"="forest"](${bbox.join(',')});
        );out body;>;out skel qt;`;

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
// Gắn sự kiện cho nút "Dựng 3D từ màu bản đồ" trong cụm điều khiển
document.getElementById('btn-image-mode').addEventListener('click', async () => {
    window.useImageMode = true;
    setStatus('Chế độ dựng 3D từ màu bản đồ đang bật...');
    if (drawnItems.getLayers().length === 0) { setStatus('Vui lòng vẽ vùng chọn trước'); return; }
    await buildSceneFromMapImage();
    window.useImageMode = false;
});
const viewerEl = document.getElementById('viewer');
const width = viewerEl.clientWidth || 800;
const height = viewerEl.clientHeight || 600;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9dbfe6);

const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 10000);
camera.position.set(0, -200, 200);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(width, height);
viewerEl.appendChild(renderer.domElement);

const light = new THREE.DirectionalLight(0xffffff, 0.8);
light.position.set(100, -100, 200);
scene.add(light);
scene.add(new THREE.AmbientLight(0xffffff, 0.6));

// OrbitControls for camera interaction
// First-person camera control (WSAD + giữ chuột trái để xoay)
let fpEnabled = false;
let fpYaw = 0;
let fpPitch = 0;
let fpMouseActive = false;
let fpMouseLast = {x:0, y:0};
let fpSpeed = 8.0; // tăng tốc di chuyển
let fpKeys = {w:false, a:false, s:false, d:false};

function enableFirstPerson(on) {
    fpEnabled = !!on;
    controls.enabled = !fpEnabled;
    setStatus(fpEnabled ? 'First-person mode (WSAD + giữ chuột trái để xoay)' : 'Orbit mode');
}

document.addEventListener('keydown', (e) => {
    if (e.key === 'f' || e.key === 'F') enableFirstPerson(!fpEnabled);
    if (!fpEnabled) return;
    if (e.key === 'w') fpKeys.w = true;
    if (e.key === 'a') fpKeys.a = true;
    if (e.key === 's') fpKeys.s = true;
    if (e.key === 'd') fpKeys.d = true;
});
document.addEventListener('keyup', (e) => {
    if (!fpEnabled) return;
    if (e.key === 'w') fpKeys.w = false;
    if (e.key === 'a') fpKeys.a = false;
    if (e.key === 's') fpKeys.s = false;
    if (e.key === 'd') fpKeys.d = false;
});

renderer.domElement.addEventListener('pointerdown', (e) => {
    if (!fpEnabled || e.button !== 0) return;
    fpMouseActive = true;
    fpMouseLast.x = e.clientX;
    fpMouseLast.y = e.clientY;
    renderer.domElement.setPointerCapture(e.pointerId);
});
renderer.domElement.addEventListener('pointermove', (e) => {
    if (!fpEnabled || !fpMouseActive) return;
    const dx = e.clientX - fpMouseLast.x;
    const dy = e.clientY - fpMouseLast.y;
    fpYaw -= dx * 0.005;
    fpPitch -= dy * 0.005;
    fpPitch = Math.max(-Math.PI/2+0.1, Math.min(Math.PI/2-0.1, fpPitch));
    fpMouseLast.x = e.clientX;
    fpMouseLast.y = e.clientY;
});
renderer.domElement.addEventListener('pointerup', (e) => {
    if (!fpEnabled || !fpMouseActive) return;
    fpMouseActive = false;
    try { renderer.domElement.releasePointerCapture(e.pointerId); } catch (err) {}
});
// OrbitControls cho giám sát và lên kế hoạch
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.screenSpacePanning = false;
controls.minDistance = 20;
controls.maxDistance = 3000;
controls.maxPolarAngle = Math.PI * 0.95; // cho phép nhìn gần sát mặt đất nhưng không lật ngược
controls.minPolarAngle = 0.15; // tránh nhìn ngang mặt đất
controls.rotateSpeed = 0.7;
controls.zoomSpeed = 1.3;
controls.panSpeed = 0.9;
controls.mouseButtons = {
    LEFT: THREE.MOUSE.ROTATE,
    MIDDLE: THREE.MOUSE.DOLLY,
    RIGHT: THREE.MOUSE.PAN
};
controls.update();


// Helper: fit camera to scene bounding box (centers, positions camera, updates controls.target)
function fitCameraToScene(marginFactor = 1.2) {
    // compute bounding box of all meshes in the scene
    const box = new THREE.Box3();
    const tmp = new THREE.Box3();
    let has = false;
    scene.traverse((o) => {
        if (o.isMesh) {
            if (o.geometry) {
                if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
                tmp.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld);
                if (!has) { box.copy(tmp); has = true; } else box.union(tmp);
            }
        }
    });
    if (!has) return;

    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());

    // choose camera distance using the larger dimension
    const maxDim = Math.max(size.x, size.y, size.z);
    const fov = camera.fov * (Math.PI / 180);
    // distance based on fov so the bounding sphere fits
    let distance = Math.abs(maxDim / 2 / Math.tan(fov / 2)) * marginFactor;
    if (distance < 20) distance = 20;

    // position camera along a diagonal so user sees depth
    const offset = new THREE.Vector3(distance * 0.6, -distance * 0.6, distance * 0.8);
    camera.position.copy(center).add(offset);
    camera.near = Math.max(0.1, distance / 1000);
    camera.far = Math.max(1000, distance * 10);
    camera.updateProjectionMatrix();

    controls.target.copy(center);
    controls.update();
}

function animate() {
    requestAnimationFrame(animate);
    const t = performance.now() * 0.001;
    // animate water meshes
    const waterList = (scene.userData && scene.userData.waterMeshes) || [];
    for (const w of waterList) {
        const attr = w.mesh.geometry.attributes.position;
        const base = w.basePositions;
        for (let i = 0; i < attr.array.length; i += 3) {
            const bx = base[i], by = base[i + 1], bz = base[i + 2];
            // simple wave: combine sines on x/y and time
            const wave = Math.sin((bx + t * 10) * 0.002) * 0.5 + Math.cos((by - t * 8) * 0.003) * 0.3;
            attr.array[i + 2] = bz + wave * 0.4; // perturb Z
        }
        attr.needsUpdate = true;
        w.mesh.geometry.computeVertexNormals();
    }

    if (fpEnabled) {
        // First-person movement: tiến/lùi/lùi/trái/phải theo hướng nhìn camera
        // Tính hướng nhìn dựa trên fpYaw/fpPitch
        const forward = new THREE.Vector3(Math.sin(fpYaw) * Math.cos(fpPitch), -Math.sin(fpPitch), Math.cos(fpYaw) * Math.cos(fpPitch));
        forward.y = 0; // chỉ di chuyển trên mặt phẳng ngang
        forward.normalize();
        const right = new THREE.Vector3(Math.cos(fpYaw), 0, -Math.sin(fpYaw)).normalize();
        let move = new THREE.Vector3();
        if (fpKeys.w) move.add(forward);
        if (fpKeys.s) move.add(forward.clone().negate());
        if (fpKeys.a) move.add(right.clone().negate());
        if (fpKeys.d) move.add(right);
        if (move.lengthSq() > 0) move.normalize().multiplyScalar(fpSpeed * 0.1);
        camera.position.add(move);
        // Set camera orientation
        camera.rotation.order = 'YXZ';
        camera.rotation.y = fpYaw;
        camera.rotation.x = fpPitch;
        camera.rotation.z = 0;
    }
    // ...existing code...
    renderer.render(scene, camera);
}
animate();

// Convert lat/lng to local X/Y planar coordinates (simple equirectangular approx)
function latLngToXY(lat, lng, origin) {
    // Convert lat/lng to planar X/Y in meters relative to origin.
    // We'll use X = east (lng), Y = north (lat), Z = up.
    const R = 6378137; // Earth radius
    const dLat = (lat - origin.lat) * Math.PI / 180;
    const dLng = (lng - origin.lng) * Math.PI / 180;
    const x = R * dLng * Math.cos(origin.lat * Math.PI / 180); // east-west
    const y = R * dLat; // north-south
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
            for (let i = 0; i < flat.length; i += 2) sampleCoords.push([flat[i], flat[i + 1]]);
        }
    }
    const lats = sampleCoords.map(c => c[1]);
    const lngs = sampleCoords.map(c => c[0]);
    const origin = {
        lat: lats.reduce((a, b) => a + b, 0) / lats.length,
        lng: lngs.reduce((a, b) => a + b, 0) / lngs.length
    };

    // compute approximate extent to size ground plane
    const xs = [], ys = [];
    for (const c of sampleCoords) { const [x, y] = latLngToXY(c[1], c[0], origin); xs.push(x); ys.push(y); }
    const xmin = Math.min(...xs), xmax = Math.max(...xs), ymin = Math.min(...ys), ymax = Math.max(...ys);
    const margin = 200;
    const planeW = (xmax - xmin) + margin * 2 || 1000;
    const planeH = (ymax - ymin) + margin * 2 || 1000;

    // simple 2D noise for terrain
    function noise2(x, y) {
        // deterministic pseudo-noise using sin
        return (Math.sin(x * 0.0005) + Math.cos(y * 0.0007) + Math.sin((x + y) * 0.0003)) * 0.5;
    }

    // create ground terrain mesh
    const seg = 64;
    const geom = new THREE.PlaneGeometry(planeW, planeH, seg, seg);
    const pos = geom.attributes.position;
    // compute heights then normalize so max ground height is at or slightly below z=0
    const heights = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
        const vx = pos.getX(i) + (xmin + xmax) / 2; // center to global
        const vy = pos.getY(i) + (ymin + ymax) / 2;
        heights[i] = noise2(vx, vy) * 30; // scale
    }
    const hmax = Math.max(...heights);
    const hmin = Math.min(...heights);
    const groundOffset = hmax + 1; // shift down so highest ground is at z = -1 (a bit under 0)
    for (let i = 0; i < pos.count; i++) {
        pos.setZ(i, heights[i] - groundOffset);
    }
    geom.computeVertexNormals();
    const ground = new THREE.Mesh(geom, new THREE.MeshLambertMaterial({ color: 0x88aa66 }));
    // Keep ground in the XY plane (Z is up) so Z is the vertical axis throughout the scene
    // (do not rotate the ground)
    scene.add(ground);

    // helper to create shape from polygon coords
    const createExtruded = (poly, height, color, zOffset = 0) => {
        const shape = new THREE.Shape();
        poly.forEach((pt, idx) => {
            const [x, y] = latLngToXY(pt[1], pt[0], origin);
            if (idx === 0) shape.moveTo(x, y);
            else shape.lineTo(x, y);
        });
        const geo = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
        const mat = new THREE.MeshLambertMaterial({ color });
        const mesh = new THREE.Mesh(geo, mat);
        // Keep extruded geometry as-is: extrude depth maps to Z (vertical). Use mesh.position.z for vertical offset.
        // Lift extruded meshes slightly so they sit above the terrain.
        mesh.position.z = zOffset + 0.5;
        scene.add(mesh);
        return mesh;
    };
    
    // helper to create a flat area (e.g., water bodies) without lifting above terrain
    const createFlatArea = (poly, color, zOffset = 0) => {
        const shape = new THREE.Shape();
        poly.forEach((pt, idx) => {
            const [x,y] = latLngToXY(pt[1], pt[0], origin);
            if (idx === 0) shape.moveTo(x, y);
            else shape.lineTo(x, y);
        });
            const geomFlat = new THREE.ShapeGeometry(shape, 8, 8);
            // ensure it's a BufferGeometry and non-indexed so positions can be directly modified
            let buf = geomFlat;
            if (buf.index) buf = buf.toNonIndexed();
            const mat = new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide });
            const mesh = new THREE.Mesh(buf, mat);
            // Keep mesh unrotated so its vertex axes match other scene objects (Z = up)
            mesh.rotation.x = 0;
            mesh.position.z = zOffset;
            scene.add(mesh);
            // recompute normals for correct lighting
            if (mesh.geometry && mesh.geometry.computeVertexNormals) mesh.geometry.computeVertexNormals();
            // register water mesh for animation (copy base positions into a Float32Array)
            if (!scene.userData.waterMeshes) scene.userData.waterMeshes = [];
            const baseCopy = Float32Array.from(buf.attributes.position.array);
            scene.userData.waterMeshes.push({ mesh, basePositions: baseCopy });
            return mesh;
    };

    // scatter helper for orchards
    const scatterTreesInPoly = (poly, count = 20) => {
        // bounding box of polygon in latlng
        const lats = poly.map(p => p[1]);
        const lngs = poly.map(p => p[0]);
        for (let i = 0; i < count; i++) {
            const lat = lats[0] + Math.random() * (Math.max(...lats) - Math.min(...lats) || 0.0001);
            const lng = lngs[0] + Math.random() * (Math.max(...lngs) - Math.min(...lngs) || 0.0001);
            const [x, y] = latLngToXY(lat, lng, origin);
            const g = new THREE.ConeGeometry(1.5, 6, 6);
            const m = new THREE.MeshLambertMaterial({ color: 0x2f8b2f });
            const mesh = new THREE.Mesh(g, m);
            mesh.position.set(x, y, 3);
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
                                            const height = (props['height'] && !isNaN(+props['height'])) ? +props['height'] : 8 + Math.random() * 12;
                                            const bmesh = createExtruded(outer, height, 0xcccccc);
                                            // mark this mesh as selectable so user can click to orbit around it
                                            if (bmesh) {
                                                bmesh.userData.selectable = true;
                                                bmesh.userData.type = 'building';
                                                // store the original polygon coordinates (lon,lat pairs) so we can mark it on the Leaflet map
                                                bmesh.userData.geo = outer;
                                            }
                      } else if (props.natural === 'water' || props.water || props.water === 'lake' || props.water === 'riverbank') {
                            // render water areas as flat blue polygons
                            createFlatArea(outer, 0x3f83ff, 0.1);
                    } else if (props.landuse === 'residential') {
                        createExtruded(outer, 1 + Math.random() * 2, 0xeeddbb);
                    } else if (props.landuse === 'orchard' || props.landuse === 'garden') {
                        createExtruded(outer, 0.5, 0x77bb66);
                        scatterTreesInPoly(outer, 30);
                    } else if (props.landuse === 'forest' || props.natural === 'wood') {
                        // draw low extrusion for forest area and scatter trees
                        createExtruded(outer, 1, 0x2f8b2f);
                        scatterTreesInPoly(outer, 40);
                    } else if (props.natural === 'mountain' || props.natural === 'peak' || props['ele']) {
                        // create a more realistic mound using extrusion and a central peak based on elevation
                        // prefer explicit elevation (ele) when available
                        const ele = props['ele'] ? parseFloat(props['ele']) : (40 + Math.random() * 60);
                        const moundHeight = Math.max(8, Math.min(200, ele / 1.5));
                        // use an extruded base for the hill footprint
                        createExtruded(outer, moundHeight * 0.6, 0x7f7f7f, 0);
                        // place a smoother cone at centroid scaled by elevation
                        const cx = outer.reduce((s, p) => s + p[0], 0) / outer.length;
                        const cy = outer.reduce((s, p) => s + p[1], 0) / outer.length;
                        const [px, py] = latLngToXY(cy, cx, origin);
                        const peakRadius = Math.max(8, Math.min(80, moundHeight * 0.2));
                        const peakHeight = Math.max(12, Math.min(180, moundHeight));
                        const g = new THREE.ConeGeometry(peakRadius, peakHeight, 12);
                        const m = new THREE.MeshLambertMaterial({ color: 0x7f7f7f });
                        const mesh = new THREE.Mesh(g, m);
                        mesh.position.set(px, py, moundHeight * 0.4 + 2);
                        scene.add(mesh);
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
                        const a = line[i], b = line[i + 1];
                        const [ax, ay] = latLngToXY(a[1], a[0], origin);
                        const [bx, by] = latLngToXY(b[1], b[0], origin);
                        const dx = bx - ax, dy = by - ay;
                        const len = Math.sqrt(dx * dx + dy * dy) || 1;
                        const angle = Math.atan2(dy, dx);
                        // determine width based on tags
                        const highway = props.highway || props['highway:classification'] || null;
                        let width = props.width ? parseFloat(props.width) : null;
                        if (!width) {
                            // map common highway classes to approximate meters
                            const mapping = { motorway: 12, trunk: 10, primary: 8, secondary: 6, tertiary: 5, residential: 4, service: 3 };
                            width = (highway && mapping[highway]) ? mapping[highway] : (props.waterway ? 6 : (props.highway ? 4 : 2));
                        }
                        // determine vertical offset: bridges and layers
                        let zBase = props.bridge === 'yes' || props.bridge === true ? 6 : 1;
                        if (props.layer) {
                            const layerVal = parseInt(props.layer);
                            if (!isNaN(layerVal)) zBase += layerVal * 6;
                        }

                        const box = new THREE.BoxGeometry(len, width, 0.6);
                        const mat = new THREE.MeshLambertMaterial({ color: props.waterway ? 0x3f83ff : 0x444444 });
                        const mesh = new THREE.Mesh(box, mat);
                        mesh.position.set((ax + bx) / 2, (ay + by) / 2, zBase);
                        mesh.rotation.z = angle;
                        scene.add(mesh);
                    }
                }
            } else if (geomF.type === 'Point') {
                // trees, peaks, or bridge/elevated nodes
                const [x, y] = latLngToXY(geomF.coordinates[1], geomF.coordinates[0], origin);
                const ele = props['ele'] ? parseFloat(props['ele']) : null;
                const z = ele ? (ele / 10) : (props.bridge === 'yes' ? 6 : 3);
                if (props.natural === 'peak' || props.natural === 'mountain') {
                    const g = new THREE.ConeGeometry(20, 80, 8);
                    const m = new THREE.MeshLambertMaterial({ color: 0x7f7f7f });
                    const mesh = new THREE.Mesh(g, m);
                    mesh.position.set(x, y, ele ? Math.max(12, ele / 2) : 40);
                    scene.add(mesh);
                } else if (props.natural === 'tree' || props['leaf_type'] || props['tree']) {
                    const g = new THREE.ConeGeometry(1.5, 6, 6);
                    const m = new THREE.MeshLambertMaterial({ color: 0x2f8b2f });
                    const mesh = new THREE.Mesh(g, m);
                    mesh.position.set(x, y, z);
                    scene.add(mesh);
                } else if (props.bridge === 'yes') {
                    // tiny marker for bridge node
                    const g = new THREE.BoxGeometry(2, 2, 1);
                    const m = new THREE.MeshLambertMaterial({ color: 0x996633 });
                    const mesh = new THREE.Mesh(g, m);
                    mesh.position.set(x, y, z);
                    scene.add(mesh);
                }
            }
        }

    setStatus('3D model built (approximate)');
    // fit camera to the generated scene for a friendly initial view
    try { fitCameraToScene(1.25); } catch (err) { console.warn('fitCameraToScene failed', err); }
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
        // If image mode enabled, build from the rendered map imagery instead of OSM API
        if (window.useImageMode) {
            setStatus('Using image-mode: capturing map and building approximate 3D...');
            await buildSceneFromMapImage();
        } else {
            const geojson = await fetchOverpass(bbox);
            setStatus('Parsing & building 3D...');
            buildSceneFromGeoJSON(geojson);
        }
    } catch (err) {
        console.error(err);
        setStatus('Error: ' + err.message);
    }
});

// double-click to re-center / fit view
renderer.domElement.addEventListener('dblclick', (e) => {
    e.preventDefault();
    try { fitCameraToScene(1.1); } catch (err) { console.warn('fitCameraToScene failed', err); }
});

// Prevent context menu on right-click in renderer
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

// Custom right-button drag: X -> lateral pan, Y -> forward/back (move along camera forward vector)
let rightDrag = null;
renderer.domElement.addEventListener('pointerdown', (e) => {
    if (e.button === 2) {
        rightDrag = { startX: e.clientX, startY: e.clientY };
        renderer.domElement.setPointerCapture(e.pointerId);
        // disable orbit controls while performing custom movement
        controls.enabled = false;
    }
});
renderer.domElement.addEventListener('pointermove', (e) => {
    if (!rightDrag) return;
    const dx = e.clientX - rightDrag.startX;
    const dy = e.clientY - rightDrag.startY;
    // lateral pan: move camera and target along camera's right vector
    const panSpeed = 0.005 * (camera.position.distanceTo(controls.target) || 100);
    const right = new THREE.Vector3();
    camera.getWorldDirection(right);
    // right vector is camera direction rotated 90deg in XY plane
    right.set(-right.y, right.x, 0).normalize();
    const lateral = right.clone().multiplyScalar(-dx * panSpeed);
    camera.position.add(lateral);
    controls.target.add(lateral);
    // forward/back: move along camera forward vector (XY only)
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    forward.z = 0; forward.normalize();
    const fb = forward.clone().multiplyScalar(dy * panSpeed);
    camera.position.add(fb);
    controls.target.add(fb);
    rightDrag.startX = e.clientX; rightDrag.startY = e.clientY;
});
renderer.domElement.addEventListener('pointerup', (e) => {
    if (e.button === 2 && rightDrag) {
        try { renderer.domElement.releasePointerCapture(e.pointerId); } catch (err) { }
        rightDrag = null;
        controls.enabled = true;
    }
});

// Raycasting selection for left-click: click a building to orbit around it
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let selected = null;
function clearSelection() {
    if (!selected) return;
    if (selected.material && selected.userData._origMaterial) selected.material = selected.userData._origMaterial;
    selected = null;
    // remove leaflet highlight if present
    if (window._leafletSelection && window._leafletSelectionLayer) {
        map.removeLayer(window._leafletSelectionLayer);
        window._leafletSelectionLayer = null;
    }
}

renderer.domElement.addEventListener('pointerdown', (e) => {
    // left click selection
    if (e.button !== 0) return;
    // compute normalized device coords
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    // gather selectable meshes
    const selectable = [];
    scene.traverse(o => { if (o.isMesh && o.userData && o.userData.selectable) selectable.push(o); });
    const hits = raycaster.intersectObjects(selectable, true);
    if (hits.length > 0) {
        const hit = hits[0].object;
        clearSelection();
        selected = hit;
        // store original material and set highlight
        selected.userData._origMaterial = selected.material;
        selected.material = new THREE.MeshLambertMaterial({ color: 0xffcc66 });
    // Chỉ cập nhật controls.target, không thay đổi vị trí/góc nhìn camera
    const box = new THREE.Box3().setFromObject(selected);
    const center = box.getCenter(new THREE.Vector3());
    controls.target.copy(center);
    // Không gọi controls.update() để tránh thay đổi camera
        // show footprint highlight on the Leaflet map for the selected building
        if (selected.userData && selected.userData.geo) {
            try {
                const coords = selected.userData.geo.map(p => [p[1], p[0]]); // lat,lng order for Leaflet
                if (window._leafletSelectionLayer) map.removeLayer(window._leafletSelectionLayer);
                window._leafletSelectionLayer = L.polygon(coords, { color: '#ffcc66', weight: 2, fillOpacity: 0.2 }).addTo(map);
            } catch (err) { console.warn('Failed to create leaflet selection polygon', err); }
        }
    } else {
        // click on empty space clears selection
        clearSelection();
    }
});

// Image-mode: attempt to infer features from map tiles (very approximate)
window.useImageMode = false;
document.addEventListener('keydown', (e) => {
    if (e.key === 'i' || e.key === 'I') {
        window.useImageMode = !window.useImageMode;
        setStatus('Image-mode ' + (window.useImageMode ? 'ON (press i to toggle)' : 'OFF (press i to toggle)'));
    }
});

async function ensureHtml2Canvas() {
    if (window.html2canvas) return Promise.resolve(window.html2canvas);
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';
        s.onload = () => { if (window.html2canvas) resolve(window.html2canvas); else reject(new Error('html2canvas not loaded')); };
        s.onerror = reject;
        document.head.appendChild(s);
    });
}

// very naive classifier by RGB color ranges
function classifyColor(r, g, b) {
    // water: blueish
    if (b > 150 && g < 140 && r < 140) return 'water';
    // vegetation: greenish
    if (g > 120 && r < 140 && b < 120) return 'vegetation';
    // roads: grayish
    if (r > 120 && g > 120 && b > 120 && Math.abs(r - g) < 20 && Math.abs(r - b) < 20) return 'road';
    // buildings: darker gray / brown
    if (r > 90 && g > 70 && b > 60 && (r - g) < 50) return 'building';
    return 'unknown';
}

// Sample the Leaflet map display and build an approximate GeoJSON-like structure and then 3D
async function buildSceneFromMapImage() {
    if (drawnItems.getLayers().length === 0) { setStatus('Please draw a rectangle first'); return; }
    const layer = drawnItems.getLayers()[0];
    const bounds = layer.getBounds();

    await ensureHtml2Canvas();
    setStatus('Capturing map image...');
    const el = document.getElementById('map');
    const canvas = await window.html2canvas(el, { useCORS: true });
    // downsample grid across selection bounds
    const steps = 30; // grid size (adjust for perf/quality)
    const samples = [];
    const rect = el.getBoundingClientRect();
    for (let y = 0; y < steps; y++) {
        for (let x = 0; x < steps; x++) {
            const px = Math.floor(rect.left + (x + 0.5) * rect.width / steps);
            const py = Math.floor(rect.top + (y + 0.5) * rect.height / steps);
            const cx = Math.min(Math.max(px - rect.left, 0), rect.width - 1);
            const cy = Math.min(Math.max(py - rect.top, 0), rect.height - 1);
            const ctx = canvas.getContext('2d');
            const p = ctx.getImageData(cx, cy, 1, 1).data;
            const cls = classifyColor(p[0], p[1], p[2]);
            // map screen pixel back to latlng
            const point = L.point(px - rect.left, py - rect.top);
            const latlng = map.containerPointToLatLng(point);
            samples.push({ x: cx, y: cy, cls, latlng });
        }
    }

    // convert samples into simple primitives
    const geoLike = { type: 'FeatureCollection', features: [] };
    // cluster contiguous classes into simple features (very naive: average positions)
    const clusters = {};
    for (const s of samples) {
        if (!clusters[s.cls]) clusters[s.cls] = { count: 0, lat: 0, lng: 0 };
        clusters[s.cls].count += 1;
        clusters[s.cls].lat += s.latlng.lat;
        clusters[s.cls].lng += s.latlng.lng;
    }
    for (const k of Object.keys(clusters)) {
        const c = clusters[k];
        if (c.count === 0) continue;
        const lat = c.lat / c.count, lng = c.lng / c.count;
        if (k === 'water') {
            geoLike.features.push({ type: 'Feature', properties: { natural: 'water' }, geometry: { type: 'Polygon', coordinates: [[[lng - 0.001, lat - 0.001], [lng + 0.001, lat - 0.001], [lng + 0.001, lat + 0.001], [lng - 0.001, lat + 0.001], [lng - 0.001, lat - 0.001]]] } });
        } else if (k === 'vegetation') {
            geoLike.features.push({ type: 'Feature', properties: { landuse: 'forest' }, geometry: { type: 'Polygon', coordinates: [[[lng - 0.0008, lat - 0.0008], [lng + 0.0008, lat - 0.0008], [lng + 0.0008, lat + 0.0008], [lng - 0.0008, lat + 0.0008], [lng - 0.0008, lat - 0.0008]]] } });
        } else if (k === 'building') {
            geoLike.features.push({ type: 'Feature', properties: { building: 'yes' }, geometry: { type: 'Polygon', coordinates: [[[lng - 0.0004, lat - 0.0004], [lng + 0.0004, lat - 0.0004], [lng + 0.0004, lat + 0.0004], [lng - 0.0004, lat + 0.0004], [lng - 0.0004, lat - 0.0004]]] } });
        } else if (k === 'road') {
            geoLike.features.push({ type: 'Feature', properties: { highway: 'residential' }, geometry: { type: 'LineString', coordinates: [[lng - 0.001, lat], [lng + 0.001, lat]] } });
        }
    }

    setStatus('Building approximate 3D from image...');
    buildSceneFromGeoJSON(geoLike);
}
