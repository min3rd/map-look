import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.154.0/build/three.module.js';
import { OrbitControls } from 'https://cdn.jsdelivr.net/npm/three@0.154.0/examples/jsm/controls/OrbitControls.js';

// Simple helper: convert lat/lon to local meters using equirectangular approx
function latLonToMeters(lat, lon, origin) {
    const R = 6378137; // Earth radius
    const dLat = (lat - origin.lat) * Math.PI / 180;
    const dLon = (lon - origin.lon) * Math.PI / 180;
    const x = R * dLon * Math.cos(origin.lat * Math.PI / 180);
    const y = R * dLat;
    return { x, y };
}

let map, selectionLayer, startPoint, rect, isDrawing = false;
let buildings = [];
let scene, camera, renderer, controls;
let pointerLocked = false;

function initMap() {
    map = L.map('map').setView([21.028511, 105.804817], 16); // Hanoi default
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
    }).addTo(map);

    selectionLayer = L.layerGroup().addTo(map);

    map.on('mousedown', (e) => {
        // Start drawing only when Shift is pressed. Otherwise allow normal map dragging.
        if (!e.originalEvent || !e.originalEvent.shiftKey) {
            // make sure dragging is enabled (defensive - in case it was left disabled)
            if (map && map.dragging && map.dragging.enable) map.dragging.enable();
            startPoint = null;
            return;
        }
        startPoint = e.latlng;
        isDrawing = true;
        if (rect) { map.removeLayer(rect); rect = null; }
        map.dragging.disable();
    });
    map.on('mousemove', (e) => {
        if (!startPoint) return;
        const bounds = L.latLngBounds(startPoint, e.latlng);
        if (rect) { rect.setBounds(bounds); } else { rect = L.rectangle(bounds, { color: '#f06', weight: 1 }).addTo(selectionLayer); }
    });
    map.on('mouseup', (e) => {
        if (!isDrawing) return; // if we weren't drawing, ignore
        map.dragging.enable();
        if (!startPoint) { isDrawing = false; return; }
        const bounds = L.latLngBounds(startPoint, e.latlng);
        if (rect) rect.setBounds(bounds);
        startPoint = null;
        isDrawing = false;
    });
    // If mouse leaves the map while drawing, cancel drawing and re-enable dragging
    map.on('mouseout', (e) => {
        if (!isDrawing) return;
        isDrawing = false;
        startPoint = null;
        map.dragging.enable();
        if (rect) { map.removeLayer(rect); rect = null; }
    });
}

async function fetchOSM(bbox) {
    // bbox = south,west,north,east
    const [s, w, n, e] = bbox;
    // build query based on selected layers
    const wanted = [];
    if (document.getElementById('cb_building').checked) {
        wanted.push('way["building"]');
        wanted.push('relation["building"]');
    }
    if (document.getElementById('cb_road').checked) {
        // highway ways
        wanted.push('way["highway"]');
    }
    if (document.getElementById('cb_lake').checked || document.getElementById('cb_river').checked) {
        // water features
        wanted.push('way["natural"="water"]');
        wanted.push('relation["natural"="water"]');
        wanted.push('way["waterway"="river"]');
        wanted.push('way["waterway"="riverbank"]');
        wanted.push('way["waterway"="stream"]');
        wanted.push('way["landuse"="reservoir"]');
        // relations multipolygon for lakes/reservoirs
        wanted.push('relation["type"="multipolygon"]["natural"="water"]');
        wanted.push('relation["type"="multipolygon"]["landuse"="reservoir"]');
    }
    // include hills if mountain checkbox is checked (some mapping uses 'hill')
    if (document.getElementById('cb_mountain').checked) {
        // (these will be added again below for nodes) but include ways/relations too
        wanted.push('way["natural"="hill"]');
        wanted.push('relation["natural"="hill"]');
    }
    if (document.getElementById('cb_park').checked) {
        wanted.push('way["leisure"="park"]');
        wanted.push('relation["leisure"="park"]');
    }
    if (document.getElementById('cb_mountain').checked) {
        // mountains/peaks as nodes
        wanted.push('node["natural"="peak"]');
        wanted.push('node["peak"="*"]');
        wanted.push('node["place"="mountain"]');
        wanted.push('node["natural"="mountain"]');
    }
    if (wanted.length === 0) throw new Error('No layer selected');
    const group = wanted.map(item => `${item}(${s},${w},${n},${e})`).join(';');
    const query = `[out:json][timeout:25];(${group};);out body;>;out skel qt;`;
    const url = 'https://overpass-api.de/api/interpreter';
    const res = await fetch(url, { method: 'POST', body: query });
    if (!res.ok) throw new Error('Overpass error');
    const data = await res.json();
    return data;
}

function showLoader(yes) {
    const el = document.getElementById('loader');
    if (!el) return;
    if (yes) el.classList.remove('hidden'); else el.classList.add('hidden');
}

function parseOSM(osm, bboxCenter) {
    const nodes = new Map();
    const waysIndex = new Map();
    const relations = [];
    const roads = [];
    const waters = [];
    const parks = [];
    const hills = [];
    const buildings = [];
    const peaks = [];

    // first pass: index nodes and ways
    for (const el of osm.elements) {
        if (el.type === 'node') nodes.set(el.id, el);
        else if (el.type === 'way') waysIndex.set(el.id, el);
        else if (el.type === 'relation') relations.push(el);
    }

    // process ways
    for (const [id, way] of waysIndex) {
        const tags = way.tags || {};
        const coords = (way.nodes||[]).map(id => { const n = nodes.get(id); return n ? [n.lat, n.lon] : null; }).filter(Boolean);
        if (tags.building) {
            const height = tags.height ? parseFloat(tags.height) : (tags['building:levels'] ? parseFloat(tags['building:levels']) * 3 : 10);
            buildings.push({ coords, height, tags });
        } else if (tags.highway) {
            roads.push({ coords, tags });
        } else if (tags.natural === 'hill') {
            hills.push({ coords, tags });
        } else if (tags.natural === 'water' || tags.water === 'lake' || tags.waterway === 'river' || tags['waterway']) {
            waters.push({ coords, tags });
        } else if (tags.leisure === 'park' || tags.landuse === 'park') {
            parks.push({ coords, tags });
        }
    }

    // process relations (try to stitch multipolygon members into polygons)
    for (const rel of relations) {
        const tags = rel.tags || {};
        if (tags.type === 'multipolygon') {
            // collect member ways that are outer
            const outerWays = [];
            for (const m of rel.members || []) {
                if (m.type === 'way' && (m.role === 'outer' || !m.role)) {
                    const w = waysIndex.get(m.ref);
                    if (!w) continue;
                    const coords = (w.nodes||[]).map(id => { const n = nodes.get(id); return n ? [n.lat, n.lon] : null; }).filter(Boolean);
                    outerWays.push(coords);
                }
            }
            // naive stitch: flatten outerWays assuming they are already ordered
            const stitched = [].concat(...outerWays);
            if (stitched.length >= 3) {
                if (tags.natural === 'water' || tags.landuse === 'reservoir') waters.push({ coords: stitched, tags });
                else if (tags.leisure === 'park') parks.push({ coords: stitched, tags });
                else if (tags.building) buildings.push({ coords: stitched, height: tags.height ? parseFloat(tags.height) : 10, tags });
                else if (tags.natural === 'hill') hills.push({ coords: stitched, tags });
            }
        }
    }

    // process peaks (nodes)
    for (const el of osm.elements) {
        if (el.type === 'node') {
            const tags = el.tags || {};
            if (tags.natural === 'peak' || tags.peak || tags.place === 'mountain' || tags.natural === 'mountain') {
                peaks.push({ coord: [el.lat, el.lon], tags });
            }
        }
    }
    // convert to three meshes
    const origin = { lat: bboxCenter[0], lon: bboxCenter[1] };
    const buildingMeshes = buildings.map(w => ({ pts: w.coords.map(c => latLonToMeters(c[0], c[1], origin)), height: w.height, tags: w.tags }));
    const roadMeshes = roads.map(r => ({ pts: r.coords.map(c => latLonToMeters(c[0], c[1], origin)), tags: r.tags }));
    const waterMeshes = waters.map(w => ({ pts: w.coords.map(c => latLonToMeters(c[0], c[1], origin)), tags: w.tags }));
    const parkMeshes = parks.map(p => ({ pts: p.coords.map(c => latLonToMeters(c[0], c[1], origin)), tags: p.tags }));
    const peakPoints = peaks.map(p => ({ pos: latLonToMeters(p.coord[0], p.coord[1], origin), tags: p.tags }));
    const hillMeshes = hills.map(h => ({ pts: h.coords.map(c => latLonToMeters(c[0], c[1], origin)), tags: h.tags }));
    return { buildings: buildingMeshes, roads: roadMeshes, water: waterMeshes, parks: parkMeshes, peaks: peakPoints, hills: hillMeshes };
}

function initThree() {
    const container = document.getElementById('three-root');
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(renderer.domElement);

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x87ceeb);

    camera = new THREE.PerspectiveCamera(75, container.clientWidth / container.clientHeight, 0.1, 10000);
    camera.position.set(0, -50, 100);
    // Use Z as the up axis so our lat/lon -> x,y and z = height are consistent
    camera.up.set(0, 0, 1);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(0, 0, 0);

    const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1.0);
    hemi.position.set(0, 200, 0);
    scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(-100, 100, 100);
    scene.add(dir);

    // ground (plane in XY so Z is height)
    const ggeo = new THREE.PlaneGeometry(10000, 10000);
    const gmat = new THREE.MeshLambertMaterial({ color: 0x999999 });
    const ground = new THREE.Mesh(ggeo, gmat);
    // leave unrotated so PlaneGeometry sits in X-Y plane (normal +Z)
    ground.position.z = 0;
    scene.add(ground);

    // load building texture (if available in assets folder)
    const loader = new THREE.TextureLoader();
    loader.load(
        'assets/138573_header3_small.jpg',
        (tex) => {
            buildingTexture = tex;
            buildingTexture.wrapS = buildingTexture.wrapT = THREE.RepeatWrapping;
            // if buildings already exist, apply cloned texture to each
            if (buildings && buildings.length) {
                for (const b of buildings) {
                    const t = buildingTexture.clone();
                    t.needsUpdate = true;
                    b.material.map = t;
                    b.material.needsUpdate = true;
                }
            }
        },
        undefined,
        (err) => { console.warn('Building texture failed to load:', err); }
    );

    window.addEventListener('resize', () => {
        const w = container.clientWidth, h = container.clientHeight;
        camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setSize(w, h);
    });

    animate();
}

function addBuildingsToScene(meshes) {
    // clear previous
    for (const b of buildings) scene.remove(b);
    buildings = [];

    for (const m of meshes) {
        const shape = new THREE.Shape();
        m.pts.forEach((p, i) => {
            if (i === 0) shape.moveTo(p.x, p.y);
            else shape.lineTo(p.x, p.y);
        });
        const extrude = new THREE.ExtrudeGeometry(shape, { depth: m.height, bevelEnabled: false, steps: 1 });
        extrude.translate(0, 0, 0);
        let mat;
        if (buildingTexture) {
            // clone texture per-building so repeat/wrap changes don't affect others
            const t = buildingTexture.clone();
            t.wrapS = t.wrapT = THREE.RepeatWrapping;
            // set reasonable repeat based on footprint bounding box
            const xs = m.pts.map(p => p.x);
            const ys = m.pts.map(p => p.y);
            const sizeX = Math.max(...xs) - Math.min(...xs) || 1;
            const sizeY = Math.max(...ys) - Math.min(...ys) || 1;
            const repeatX = Math.max(1, Math.round(sizeX / 10));
            const repeatY = Math.max(1, Math.round(sizeY / 10));
            t.repeat.set(repeatX, repeatY);
            t.needsUpdate = true;
            mat = new THREE.MeshLambertMaterial({ map: t });
        } else {
            mat = new THREE.MeshLambertMaterial({ color: 0xcccccc });
        }
        const mesh = new THREE.Mesh(extrude, mat);
        mesh.position.z = 0;
        scene.add(mesh);
        buildings.push(mesh);
    }
}

// New renderers for other types
function addRoadsToScene(roadMeshes) {
    // remove previous roads
    if (!scene.userData.roads) scene.userData.roads = [];
    for (const r of scene.userData.roads) scene.remove(r);
    scene.userData.roads = [];
    for (const r of roadMeshes) {
        const pts = r.pts.map(p => new THREE.Vector3(p.x, p.y, 1));
        const geom = new THREE.BufferGeometry().setFromPoints(pts);
        const mat = new THREE.LineBasicMaterial({ color: 0x333333 });
        const line = new THREE.Line(geom, mat);
        scene.add(line);
        scene.userData.roads.push(line);
    }
}

function addWaterToScene(waterMeshes) {
    if (!scene.userData.water) scene.userData.water = [];
    for (const r of scene.userData.water) scene.remove(r);
    scene.userData.water = [];
    for (const w of waterMeshes) {
        // If polygon (lake/reservoir)
        if (w.pts.length >= 3) {
            const shape = new THREE.Shape();
            w.pts.forEach((p, i) => { if (i === 0) shape.moveTo(p.x, p.y); else shape.lineTo(p.x, p.y); });
            const geom = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false });
            const mat = new THREE.MeshLambertMaterial({ color: 0x4aa3df, transparent: true, opacity: 0.8 });
            const mesh = new THREE.Mesh(geom, mat);
            mesh.position.z = 0;
            scene.add(mesh);
            scene.userData.water.push(mesh);
        } else if (w.pts.length > 1) {
            // polyline -> render as tube (river)
            const path = new THREE.CurvePath();
            const points = w.pts.map(p => new THREE.Vector3(p.x, p.y, 0));
            // simple TubeGeometry using a CatmullRomCurve3
            const curve = new THREE.CatmullRomCurve3(points);
            const tubeGeom = new THREE.TubeGeometry(curve, Math.max(2, points.length*3), 2, 8, false);
            const mat = new THREE.MeshLambertMaterial({ color: 0x4aa3df });
            const mesh = new THREE.Mesh(tubeGeom, mat);
            scene.add(mesh);
            scene.userData.water.push(mesh);
        }
    }
}

function addHillsToScene(hillMeshes) {
    if (!scene.userData.hills) scene.userData.hills = [];
    for (const r of scene.userData.hills) scene.remove(r);
    scene.userData.hills = [];
    for (const h of hillMeshes) {
        // approximate hill by placing a cone at centroid
        const xs = h.pts.map(p=>p.x), ys = h.pts.map(p=>p.y);
        const cx = (Math.min(...xs) + Math.max(...xs))/2;
        const cy = (Math.min(...ys) + Math.max(...ys))/2;
        const geom = new THREE.ConeGeometry(20, 40, 12);
        const mat = new THREE.MeshLambertMaterial({ color: 0x886644, transparent:true, opacity:0.9 });
        const mesh = new THREE.Mesh(geom, mat);
        mesh.position.set(cx, cy, 10);
        scene.add(mesh);
        scene.userData.hills.push(mesh);
    }
}

function addParksToScene(parkMeshes) {
    if (!scene.userData.parks) scene.userData.parks = [];
    for (const r of scene.userData.parks) scene.remove(r);
    scene.userData.parks = [];
    for (const p of parkMeshes) {
        if (p.pts.length < 3) continue;
        const shape = new THREE.Shape();
        p.pts.forEach((pt, i) => { if (i === 0) shape.moveTo(pt.x, pt.y); else shape.lineTo(pt.x, pt.y); });
        const geom = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false });
        const mat = new THREE.MeshLambertMaterial({ color: 0x66bb66, transparent: true, opacity: 0.9 });
        const mesh = new THREE.Mesh(geom, mat);
        mesh.position.z = 0;
        scene.add(mesh);
        scene.userData.parks.push(mesh);
    }
}

function addPeaksToScene(points) {
    if (!scene.userData.peaks) scene.userData.peaks = [];
    for (const r of scene.userData.peaks) scene.remove(r);
    scene.userData.peaks = [];
    for (const p of points) {
        const geom = new THREE.ConeGeometry(5, 20, 8);
        const mat = new THREE.MeshLambertMaterial({ color: 0x885544 });
        const mesh = new THREE.Mesh(geom, mat);
        mesh.position.set(p.pos.x, p.pos.y, 10);
        scene.add(mesh);
        scene.userData.peaks.push(mesh);
    }
}

function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
}

// pointer-lock flight controls (simple)
class FlightControls {
    constructor(camera, dom) {
        this.camera = camera; this.dom = dom; this.velocity = new THREE.Vector3(); this.enabled = false;
        this.move = { f: 0, b: 0, l: 0, r: 0, u: 0, d: 0 };
        this.speed = 200;
        this.pitch = 0; this.yaw = 0;
        dom.addEventListener('click', () => { dom.requestPointerLock(); });
        document.addEventListener('pointerlockchange', () => { this.enabled = document.pointerLockElement === dom; });
        document.addEventListener('mousemove', (e) => { if (!this.enabled) return; this.yaw -= e.movementX * 0.002; this.pitch -= e.movementY * 0.002; this.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.pitch)); this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ')); });
        window.addEventListener('keydown', (e) => { if (e.key === 'w') this.move.f = 1; if (e.key === 's') this.move.b = 1; if (e.key === 'a') this.move.l = 1; if (e.key === 'd') this.move.r = 1; if (e.key === ' ') this.move.u = 1; if (e.key === 'Shift') this.move.d = 1; });
        window.addEventListener('keyup', (e) => { if (e.key === 'w') this.move.f = 0; if (e.key === 's') this.move.b = 0; if (e.key === 'a') this.move.l = 0; if (e.key === 'd') this.move.r = 0; if (e.key === ' ') this.move.u = 0; if (e.key === 'Shift') this.move.d = 0; });
    }
    update(dt) {
        if (!this.enabled) return;
        const dir = new THREE.Vector3();
        this.camera.getWorldDirection(dir);
        const right = new THREE.Vector3(); this.camera.getWorldDirection(right); right.cross(this.camera.up);
        const up = new THREE.Vector3(0, 0, 1);
        const v = new THREE.Vector3();
        if (this.move.f) v.add(dir);
        if (this.move.b) v.sub(dir);
        if (this.move.r) v.add(right);
        if (this.move.l) v.sub(right);
        if (this.move.u) v.add(up);
        if (this.move.d) v.sub(up);
        v.normalize();
        v.multiplyScalar(this.speed * dt);
        this.camera.position.add(v);
    }
}

let flightControls;
let buildingTexture = null;

// Wire UI
initMap();
initThree();

document.getElementById('scanBtn').addEventListener('click', async () => {
    if (!rect) { alert('Vui lòng chọn vùng trên bản đồ bằng cách nhấp-drag.'); return; }
    const b = rect.getBounds();
    const bbox = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()];
    const center = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
    try {
        showLoader(true);
        const osm = await fetchOSM(bbox);
        const parsed = parseOSM(osm, center);
        // render based on selections
        if (parsed.buildings && document.getElementById('cb_building').checked) addBuildingsToScene(parsed.buildings);
        if (parsed.roads && document.getElementById('cb_road').checked) addRoadsToScene(parsed.roads);
        if (parsed.water && (document.getElementById('cb_lake').checked || document.getElementById('cb_river').checked)) addWaterToScene(parsed.water);
        if (parsed.parks && document.getElementById('cb_park').checked) addParksToScene(parsed.parks);
        if (parsed.peaks && document.getElementById('cb_mountain').checked) addPeaksToScene(parsed.peaks);
    if (parsed.hills && document.getElementById('cb_mountain').checked) addHillsToScene(parsed.hills);
        // if texture just loaded after buildings were created, ensure materials updated
        if (buildingTexture) {
            // clone texture per building so repeat changes don't affect others
            for (const b of buildings) {
                const t = buildingTexture.clone();
                b.material.map = t;
                b.material.needsUpdate = true;
            }
        }
        showLoader(false);
    } catch (err) {
        showLoader(false);
    }
});

// enter 3D: center camera on selection
document.getElementById('enter3D').addEventListener('click', () => {
    if (!rect) { alert('Chọn vùng trước khi vào 3D'); return; }
    const b = rect.getBounds();
    const center = b.getCenter();
    const origin = { lat: center.lat, lon: center.lng };
    // move camera near center
    const m = latLonToMeters(center.lat, center.lng, origin);
    camera.position.set(m.x, m.y - 200, 200);
    controls.target.set(m.x, m.y, 0);
    controls.update();
    // attach flight controls
    if (!flightControls) flightControls = new FlightControls(camera, renderer.domElement);
    // start update loop for flight
    let last = performance.now();
    function floop() {
        const now = performance.now();
        const dt = (now - last) / 1000; last = now;
        flightControls.update(dt);
        requestAnimationFrame(floop);
    }
    floop();
});

export { };
