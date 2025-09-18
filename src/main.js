import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.154.0/build/three.module.js';
import { OrbitControls } from 'https://cdn.jsdelivr.net/npm/three@0.154.0/examples/jsm/controls/OrbitControls.js';
import { WeaponSimulation, WEAPONS } from './weaponSimulation.js';

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
let lastParsed = null;
let lastOrigin = null;

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

    // Add weapon simulation on click
    map.on('dblclick', (e) => {
        console.log('Double click at:', e.latlng);
        console.log('WeaponSim buildings:', weaponSim.buildings.length);
        console.log('WeaponSim scene:', weaponSim.scene);
        console.log('WeaponSim origin:', weaponSim.origin);
        const weaponType = document.getElementById('weaponSelect').value;
        const weapon = WEAPONS[weaponType];
        weaponSim.simulateImpact(weapon, e.latlng.lat, e.latlng.lng);
        // persist impacts immediately so reload restores them
        try { saveAppState(); } catch (err) { console.warn('saveAppState failed after impact', err); }
    });
}

// Persist application state to localStorage
function saveAppState() {
    try {
        const key = 'maplook_state_v1';
        const state = { parsed: null, origin: null, impacts: [] };
        if (lastParsed) state.parsed = lastParsed;
        if (lastOrigin) state.origin = lastOrigin;
        // serialize impacts (weapon type, lat, lon)
        if (weaponSim && Array.isArray(weaponSim.impacts)) {
            for (const imp of weaponSim.impacts) {
                if (!imp || !imp.position) continue;
                const wt = imp.weapon && imp.weapon.type ? imp.weapon.type : (imp.weapon || '').toString();
                state.impacts.push({ weapon: wt, lat: imp.position.lat, lon: imp.position.lon });
            }
        }
        localStorage.setItem(key, JSON.stringify(state));
    } catch (e) { console.warn('Failed to save state', e); }
}

// Restore state from localStorage if present. Recreates 3D scene objects and impacts.
function loadAppState() {
    try {
        const key = 'maplook_state_v1';
        const txt = localStorage.getItem(key);
        if (!txt) return;
        const state = JSON.parse(txt);
        if (!state) return;
        // restore parsed scene if available
        if (state.parsed) {
            lastParsed = state.parsed;
            lastOrigin = state.origin || lastOrigin;
            // add buildings, roads, parks etc if present - follow same add* functions
            if (lastParsed.buildings && document.getElementById('cb_building') && document.getElementById('cb_building').checked) addBuildingsToScene(lastParsed.buildings);
            if (lastParsed.roads && document.getElementById('cb_road') && document.getElementById('cb_road').checked) addRoadsToScene(lastParsed.roads);
            if (lastParsed.parks && document.getElementById('cb_park') && document.getElementById('cb_park').checked) addParksToScene(lastParsed.parks);
            if (lastParsed.peaks && document.getElementById('cb_mountain') && document.getElementById('cb_mountain').checked) addPeaksToScene(lastParsed.peaks);
            if (lastParsed.hills && document.getElementById('cb_mountain') && document.getElementById('cb_mountain').checked) addHillsToScene(lastParsed.hills);
            if (lastParsed.forests && document.getElementById('cb_forest') && document.getElementById('cb_forest').checked) addForestsToScene(lastParsed.forests);
            if (lastParsed.trees && document.getElementById('cb_forest') && document.getElementById('cb_forest').checked) addTreesToScene(lastParsed.trees);
            if (lastParsed.ports && document.getElementById('cb_port') && document.getElementById('cb_port').checked) addPortsToScene(lastParsed.ports);
            // infra
            if (lastParsed.infra) addInfraToScene(lastParsed.infra);
            // set weaponSim fields
            weaponSim.buildings = buildings;
            weaponSim.scene = scene;
            if (lastOrigin) weaponSim.origin = lastOrigin;

            // If buildingTexture already loaded earlier, apply it to restored buildings
            if (typeof buildingTexture !== 'undefined' && buildingTexture) {
                for (const b of buildings) {
                    try {
                        const t = buildingTexture.clone();
                        t.needsUpdate = true;
                        if (b && b.material) { b.material.map = t; b.material.needsUpdate = true; }
                    } catch (e) { }
                }
            }

            // Ensure the scene has at least basic lighting (in case restore ran before initThree finished)
            try {
                const hasLight = scene.children.some(ch => ch.isLight || (ch.type && /Light$/.test(ch.type)));
                if (!hasLight) {
                    const hemiDef = new THREE.HemisphereLight(0xffffff, 0x444444, 1.0);
                    hemiDef.position.set(0, 200, 0);
                    scene.add(hemiDef);
                    const dirDef = new THREE.DirectionalLight(0xffffff, 0.8);
                    dirDef.position.set(-100, 100, 100);
                    scene.add(dirDef);
                }
            } catch (e) { /* ignore if THREE not available */ }
        }
        // restore impacts
        if (Array.isArray(state.impacts) && state.impacts.length) {
            for (const imp of state.impacts) {
                try {
                    const w = WEAPONS[imp.weapon] || WEAPONS.bomb;
                    // re-run impacts to recreate visuals and damage
                    weaponSim.simulateImpact(w, imp.lat, imp.lon);
                } catch (e) { console.warn('Failed restoring impact', e); }
            }
        }
    } catch (e) { console.warn('Failed to load saved state', e); }
}

async function fetchOSM(bbox) {
    // bbox = south,west,north,east
    const [s, w, n, e] = bbox;
    // build query based on selected layers
    const wanted = [];
    if (document.getElementById('cb_building') && document.getElementById('cb_building').checked) {
        wanted.push('way["building"]');
        wanted.push('relation["building"]');
    }
    if (document.getElementById('cb_road') && document.getElementById('cb_road').checked) {
        wanted.push('way["highway"]');
    }
    // infrastructure
    if (document.getElementById('cb_hospital') && document.getElementById('cb_hospital').checked) {
        wanted.push('node["amenity"="hospital"]');
        wanted.push('way["amenity"="hospital"]');
        wanted.push('relation["amenity"="hospital"]');
    }
    if (document.getElementById('cb_school') && document.getElementById('cb_school').checked) {
        wanted.push('node["amenity"="school"]');
        wanted.push('way["amenity"="school"]');
        wanted.push('relation["amenity"="school"]');
    }
    if (document.getElementById('cb_rail') && document.getElementById('cb_rail').checked) {
        wanted.push('way["railway"]');
        wanted.push('relation["railway"]');
    }
    if (document.getElementById('cb_bus') && document.getElementById('cb_bus').checked) {
        wanted.push('node["highway"="bus_stop"]');
    }
    if (document.getElementById('cb_power') && document.getElementById('cb_power').checked) {
        wanted.push('way["power"]');
        wanted.push('node["power"]');
    }
    if (document.getElementById('cb_parking') && document.getElementById('cb_parking').checked) {
        wanted.push('way["amenity"="parking"]');
        wanted.push('relation["amenity"="parking"]');
    }
    if (document.getElementById('cb_industrial') && document.getElementById('cb_industrial').checked) {
        wanted.push('way["landuse"="industrial"]');
        wanted.push('relation["landuse"="industrial"]');
    }
    if (document.getElementById('cb_airport') && document.getElementById('cb_airport').checked) {
        wanted.push('way["aeroway"]');
        wanted.push('node["aeroway"="aerodrome"]');
        wanted.push('relation["aeroway"]');
    }
    if (document.getElementById('cb_bridge') && document.getElementById('cb_bridge').checked) {
        wanted.push('way["bridge"]');
        wanted.push('relation["bridge"]');
    }
    if ((document.getElementById('cb_lake') && document.getElementById('cb_lake').checked) || (document.getElementById('cb_river') && document.getElementById('cb_river').checked)) {
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
    // forests / trees
    if (document.getElementById('cb_forest') && document.getElementById('cb_forest').checked) {
        wanted.push('way["landuse"="forest"]');
        wanted.push('relation["landuse"="forest"]');
        wanted.push('way["natural"="wood"]');
        wanted.push('relation["natural"="wood"]');
        // individual trees as nodes
        wanted.push('node["natural"="tree"]');
    }
    // ports, harbors, ferry terminals, piers
    if (document.getElementById('cb_port') && document.getElementById('cb_port').checked) {
        wanted.push('way["man_made"="pier"]');
        wanted.push('way["landuse"="port"]');
        wanted.push('node["man_made"="harbour"]');
        wanted.push('node["amenity"="ferry_terminal"]');
        wanted.push('relation["landuse"="port"]');
    }
    // include hills if mountain checkbox is checked (some mapping uses 'hill')
    if (document.getElementById('cb_mountain') && document.getElementById('cb_mountain').checked) {
        wanted.push('way["natural"="hill"]');
        wanted.push('relation["natural"="hill"]');
    }
    if (document.getElementById('cb_park') && document.getElementById('cb_park').checked) {
        wanted.push('way["leisure"="park"]');
        wanted.push('relation["leisure"="park"]');
    }
    if (document.getElementById('cb_mountain') && document.getElementById('cb_mountain').checked) {
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
    const forests = [];
    const trees = [];
    const parks = [];
    const hills = [];
    const buildings = [];
    const infra = { hospitals: [], schools: [], busStops: [], power: [], parking: [], industrial: [], airports: [], bridges: [], rails: [] };
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
        const coords = (way.nodes || []).map(id => { const n = nodes.get(id); return n ? [n.lat, n.lon] : null; }).filter(Boolean);
        // collect forests
        if (tags.landuse === 'forest' || tags.natural === 'wood') {
            forests.push({ coords, tags });
            continue;
        }
        if (tags.building) {
            const height = tags.height ? parseFloat(tags.height) : (tags['building:levels'] ? parseFloat(tags['building:levels']) * 3 : 10);
            buildings.push({ coords, height, tags });
        } else if (tags.amenity === 'hospital') {
            infra.hospitals.push({ coords, tags });
        } else if (tags.amenity === 'school') {
            infra.schools.push({ coords, tags });
        } else if (tags.highway) {
            roads.push({ coords, tags });
        } else if (tags.railway) {
            infra.rails.push({ coords, tags });
        } else if (tags.natural === 'hill') {
            hills.push({ coords, tags });
        } else if (tags.natural === 'water' || tags.water === 'lake' || tags.waterway === 'river' || tags['waterway']) {
            waters.push({ coords, tags });
        } else if (tags.man_made === 'pier' || tags.landuse === 'port') {
            // port / pier ways
            if (coords && coords.length) {
                // treat as port polygon/shape
                waters.push({ coords, tags }); // reuse water bucket temporarily if overlapping
            }
        } else if (tags.amenity === 'parking') {
            infra.parking.push({ coords, tags });
        } else if (tags.landuse === 'industrial') {
            infra.industrial.push({ coords, tags });
        } else if (tags.aeroway) {
            infra.airports.push({ coords, tags });
        } else if (tags.bridge) {
            infra.bridges.push({ coords, tags });
        } else if (tags.power) {
            infra.power.push({ coords, tags });
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
                    const coords = (w.nodes || []).map(id => { const n = nodes.get(id); return n ? [n.lat, n.lon] : null; }).filter(Boolean);
                    outerWays.push(coords);
                }
            }
            // naive stitch: flatten outerWays assuming they are already ordered
            const stitched = [].concat(...outerWays);
            if (stitched.length >= 3) {
                if (tags.natural === 'water' || tags.landuse === 'reservoir') waters.push({ coords: stitched, tags });
                else if (tags.landuse === 'forest' || tags.natural === 'wood') forests.push({ coords: stitched, tags });
                else if (tags.leisure === 'park') parks.push({ coords: stitched, tags });
                else if (tags.building) buildings.push({ coords: stitched, height: tags.height ? parseFloat(tags.height) : 10, tags });
                else if (tags.natural === 'hill') hills.push({ coords: stitched, tags });
                else if (tags.amenity === 'hospital') infra.hospitals.push({ coords: stitched, tags });
                else if (tags.amenity === 'school') infra.schools.push({ coords: stitched, tags });
                else if (tags.amenity === 'parking') infra.parking.push({ coords: stitched, tags });
                else if (tags.landuse === 'industrial') infra.industrial.push({ coords: stitched, tags });
                else if (tags.aeroway) infra.airports.push({ coords: stitched, tags });
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
            // individual tree nodes
            if (tags && (tags.natural === 'tree' || tags.natural === 'wood' || tags.tree)) {
                trees.push({ lat: el.lat, lon: el.lon, tags });
            }
        }
    }
    // also capture infra nodes (hospital, school, bus_stop, power, aerodrome, parking)
    for (const el of osm.elements) {
        if (el.type !== 'node') continue;
        const tags = el.tags || {};
        if (tags.amenity === 'hospital') infra.hospitals.push({ coord: [el.lat, el.lon], tags });
        else if (tags.amenity === 'school') infra.schools.push({ coord: [el.lat, el.lon], tags });
        else if (tags.highway === 'bus_stop') infra.busStops.push({ coord: [el.lat, el.lon], tags });
        else if (tags.power) infra.power.push({ coord: [el.lat, el.lon], tags });
        else if (tags.aeroway === 'aerodrome' || tags.aeroway) infra.airports.push({ coord: [el.lat, el.lon], tags });
        else if (tags.amenity === 'parking') infra.parking.push({ coord: [el.lat, el.lon], tags });
    }
    // convert to three meshes
    const origin = { lat: bboxCenter[0], lon: bboxCenter[1] };
    const buildingMeshes = buildings.map(w => ({ pts: w.coords.map(c => latLonToMeters(c[0], c[1], origin)), height: w.height, tags: w.tags }));
    const roadMeshes = roads.map(r => ({ pts: r.coords.map(c => latLonToMeters(c[0], c[1], origin)), tags: r.tags }));
    const waterMeshes = waters.map(w => ({ pts: w.coords.map(c => latLonToMeters(c[0], c[1], origin)), tags: w.tags }));
    const parkMeshes = parks.map(p => ({ pts: p.coords.map(c => latLonToMeters(c[0], c[1], origin)), tags: p.tags }));
    const peakPoints = peaks.map(p => ({ pos: latLonToMeters(p.coord[0], p.coord[1], origin), tags: p.tags }));
    const hillMeshes = hills.map(h => ({ pts: h.coords.map(c => latLonToMeters(c[0], c[1], origin)), tags: h.tags }));
    const forestMeshes = forests.map(f => ({ pts: f.coords.map(c => latLonToMeters(c[0], c[1], origin)), tags: f.tags }));
    const treePoints = trees.map(t => ({ pos: latLonToMeters(t.lat, t.lon, origin), tags: t.tags }));
    const portMeshes = []; // ports will be inferred from pier/port ways if present earlier
    // convert infra
    const infraMeshes = {
        hospitals: infra.hospitals.map(i => ({ pts: i.coords ? i.coords.map(c => latLonToMeters(c[0], c[1], origin)) : [], tags: i.tags })),
        schools: infra.schools.map(i => ({ pts: i.coords ? i.coords.map(c => latLonToMeters(c[0], c[1], origin)) : [], tags: i.tags })),
        busStops: infra.busStops.map(i => ({ pos: i.coord ? latLonToMeters(i.coord[0], i.coord[1], origin) : null, tags: i.tags })),
        power: infra.power.map(i => ({ pts: i.coords ? i.coords.map(c => latLonToMeters(c[0], c[1], origin)) : [], tags: i.tags })),
        parking: infra.parking.map(i => ({ pts: i.coords ? i.coords.map(c => latLonToMeters(c[0], c[1], origin)) : [], tags: i.tags })),
        industrial: infra.industrial.map(i => ({ pts: i.coords ? i.coords.map(c => latLonToMeters(c[0], c[1], origin)) : [], tags: i.tags })),
        airports: infra.airports.map(i => ({ pts: i.coords ? i.coords.map(c => latLonToMeters(c[0], c[1], origin)) : [], tags: i.tags })),
        bridges: infra.bridges.map(i => ({ pts: i.coords ? i.coords.map(c => latLonToMeters(c[0], c[1], origin)) : [], tags: i.tags })),
        rails: infra.rails.map(i => ({ pts: i.pts ? i.pts.map(c => latLonToMeters(c[0], c[1], origin)) : i.coords.map(c => latLonToMeters(c[0], c[1], origin)), tags: i.tags })),
    };

    return { buildings: buildingMeshes, roads: roadMeshes, water: waterMeshes, parks: parkMeshes, peaks: peakPoints, hills: hillMeshes, infra: infraMeshes, forests: forestMeshes, trees: treePoints, ports: portMeshes };
}

// --- Terrain / elevation support using OpenTopoData
const VERT_SCALE = 0.5; // vertical exaggeration / scale for terrain and object heights
let terrain = null; // THREE.Mesh
let terrainGrid = null; // { nx, ny, lats[][], lons[][], heights[][], origin, dx, dy }
let selectedDataset = 'srtm90m';

// Fetch available OpenTopoData datasets and populate the UI selector
async function loadOpenTopoDatasets() {
    const fallback = [
        'aster30m', 'bkg200m', 'emod2018', 'etopo1', 'eudem25m', 'gebco2020', 'mapzen', 'ned10m', 'nzdem8m', 'srtm30m', 'srtm90m', 'test-dataset'
    ];
    const sel = document.getElementById('datasetSelect');
    if (sel) {
        sel.innerHTML = '';
        for (const name of fallback) { const opt = document.createElement('option'); opt.value = name; opt.textContent = name; sel.appendChild(opt); }
        sel.value = fallback.includes('srtm90m') ? 'srtm90m' : fallback[0];
        selectedDataset = sel.value;
        sel.addEventListener('change', () => { selectedDataset = sel.value; /* dataset changed */ });
    }
}

function addForestsToScene(forestMeshes) {
    if (!scene.userData.forests) scene.userData.forests = [];
    for (const r of scene.userData.forests) scene.remove(r);
    scene.userData.forests = [];
    for (const f of forestMeshes) {
        if (!f.pts || f.pts.length < 3) continue;
        try {
            const shape = new THREE.Shape(f.pts.map(p => new THREE.Vector2(p.x, p.y)));
            const geom = new THREE.ExtrudeGeometry(shape, { depth: 0.5, bevelEnabled: false });
            const mat = new THREE.MeshLambertMaterial({ color: 0x2e8b57, opacity: 0.8, transparent: true });
            const mesh = new THREE.Mesh(geom, mat);
            // position slightly above terrain to avoid z-fight
            let sumh = 0, c = 0; for (const p of f.pts) { const hh = getTerrainHeightAt(p.x, p.y); if (!isNaN(hh)) { sumh += hh; c++; } }
            mesh.position.z = c ? (sumh / c) : 0;
            scene.add(mesh); scene.userData.forests.push(mesh);
        } catch (e) { /* ignore complex shapes */ }
    }
}

function addTreesToScene(treePoints) {
    if (!scene.userData.trees) scene.userData.trees = [];
    for (const r of scene.userData.trees) scene.remove(r);
    scene.userData.trees = [];
    const geom = new THREE.ConeGeometry(0.6, 2.0, 6);
    const mat = new THREE.MeshLambertMaterial({ color: 0x227722 });
    for (const t of treePoints) {
        const h = getTerrainHeightAt(t.pos.x, t.pos.y) || 0;
        const m = new THREE.Mesh(geom, mat);
        m.position.set(t.pos.x, t.pos.y, h + 1);
        scene.add(m); scene.userData.trees.push(m);
    }
}

function addPortsToScene(portMeshes) {
    if (!scene.userData.ports) scene.userData.ports = [];
    for (const r of scene.userData.ports) scene.remove(r);
    scene.userData.ports = [];
    for (const p of portMeshes) {
        if (!p.pts || !p.pts.length) continue;
        const shape = new THREE.Shape(p.pts.map(pt => new THREE.Vector2(pt.x, pt.y)));
        const geom = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false });
        const mat = new THREE.MeshLambertMaterial({ color: 0x888888, opacity: 0.9, transparent: true });
        const mesh = new THREE.Mesh(geom, mat);
        let sumh = 0, c = 0; for (const pt of p.pts) { const hh = getTerrainHeightAt(pt.x, pt.y); if (!isNaN(hh)) { sumh += hh; c++; } }
        mesh.position.z = c ? (sumh / c) : 0;
        scene.add(mesh); scene.userData.ports.push(mesh);
    }
}
// Fetch elevations for an array of {lat,lon} points. Returns flat array of elevations matching input order.
async function fetchElevationPoints(points) {
    const out = [];
    const batchSize = 100; // keep batches small to avoid long URLs
    for (let i = 0; i < points.length; i += batchSize) {
        const batch = points.slice(i, i + batchSize);
        const locs = batch.map(p => `${p.lat},${p.lon}`).join('|');
        const isLocal = (typeof window !== 'undefined') && (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost');
        const base = isLocal ? `http://localhost:3000/opentopo` : `https://api.opentopodata.org/v1/${encodeURIComponent(selectedDataset)}`;

        // helper sleep for backoff
        const sleep = (ms) => new Promise(res => setTimeout(res, ms));

        let data = null;
        let attempt = 0;
        const maxAttempts = 3;
        for (; attempt < maxAttempts; attempt++) {
            try {
                // Try GET for short queries
                const getUrl = isLocal
                    ? `${base}?locations=${encodeURIComponent(locs)}&interpolation=cubic&format=geojson&dataset=${encodeURIComponent(selectedDataset)}`
                    : `${base}?locations=${encodeURIComponent(locs)}&interpolation=cubic&format=geojson`;
                if (getUrl.length < 2000) {
                    const gres = await fetch(getUrl);
                    if (gres.ok) {
                        const ct = (gres.headers.get('content-type') || '').toLowerCase();
                        if (ct.includes('application/geo+json') || ct.includes('geojson') || ct.includes('application/json')) {
                            data = await gres.json();
                        }
                    }
                }
                if (!data) {
                    const body = new URLSearchParams();
                    body.append('locations', locs);
                    body.append('interpolation', 'cubic');
                    body.append('format', 'geojson');
                    if (isLocal) body.append('dataset', selectedDataset);
                    const pres = await fetch(base, { method: 'POST', body: body.toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
                    if (!pres.ok) {
                        console.warn('Elevation POST failed for batch', i, 'status', pres.status);
                        data = null;
                    } else {
                        data = await pres.json();
                    }
                }
            } catch (e) {
                console.warn('Elevation fetch attempt error for batch', i, 'attempt', attempt, e);
                data = null;
            }
            const keys = Object.keys(data || {});
            // if server returned an error status object, retry after a short backoff
            if (keys.length === 2 && keys.includes('error') && keys.includes('status')) {
                console.warn('OpenTopo returned error for batch', i, 'attempt', attempt, data);
                data = null;
                await sleep(250 * (attempt + 1));
                continue;
            }
            // otherwise break and process whatever we got
            break;
        }

        /* fetchElevationPoints: batch info (removed) */

        // Parse response: support GeoJSON FeatureCollection (features[].properties.elevation) or results array
        if (data && data.type === 'FeatureCollection' && Array.isArray(data.features)) {
            /* FeatureCollection features length logged (removed) */
            // Build a features array with lat,lon,elev
            const feats = [];
            for (const f of data.features) {
                let elev = null;
                if (f.properties && typeof f.properties.elevation === 'number') elev = f.properties.elevation;
                else if (f.geometry && Array.isArray(f.geometry.coordinates)) {
                    const c = f.geometry.coordinates;
                    if (typeof c[2] === 'number') elev = c[2];
                    else if (Array.isArray(c[0]) && typeof c[0][2] === 'number') elev = c[0][2];
                    if (elev === null && typeof c[1] === 'number' && typeof c[0] === 'number' && typeof c[2] === 'number') elev = c[2];
                }
                let lat = null, lon = null;
                if (f.geometry && Array.isArray(f.geometry.coordinates)) {
                    const c = f.geometry.coordinates;
                    if (typeof c[1] === 'number' && typeof c[0] === 'number') { lon = c[0]; lat = c[1]; }
                    else if (Array.isArray(c[0]) && typeof c[0][1] === 'number') { lon = c[0][0]; lat = c[0][1]; }
                }
                if (lat !== null && lon !== null) feats.push({ lat, lon, elev: (elev === null ? 0 : elev) });
            }

            // If returned features count matches requested batch, perform a one-to-one nearest-neighbor assignment
            if (feats.length === batch.length) {
                const used = new Array(feats.length).fill(false);
                for (const p of batch) {
                    let bestIdx = -1, bestD = Infinity;
                    for (let k = 0; k < feats.length; k++) {
                        if (used[k]) continue;
                        const dx = p.lat - feats[k].lat, dy = p.lon - feats[k].lon;
                        const d = dx * dx + dy * dy;
                        if (d < bestD) { bestD = d; bestIdx = k; }
                    }
                    if (bestIdx >= 0) { out.push(feats[bestIdx].elev); used[bestIdx] = true; }
                    else out.push(0);
                }
                /* assigned one-to-one for batch (removed) */
            } else {
                // fallback: try exact lat/lon match at 6-decimal precision first
                const map = new Map();
                for (const f of feats) map.set(`${f.lat.toFixed(6)},${f.lon.toFixed(6)}`, f.elev);
                for (const p of batch) {
                    const key = `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`;
                    if (map.has(key)) { out.push(map.get(key)); continue; }
                    // otherwise find nearest feature (no-one-shot reservation here)
                    let bestIdx = -1, bestD = Infinity;
                    for (let k = 0; k < feats.length; k++) {
                        const dx = p.lat - feats[k].lat, dy = p.lon - feats[k].lon;
                        const d = dx * dx + dy * dy;
                        if (d < bestD) { bestD = d; bestIdx = k; }
                    }
                    if (bestIdx >= 0) out.push(feats[bestIdx].elev); else out.push(0);
                }
                /* fallback assignment for batch (removed) */
            }
        } else if (data && Array.isArray(data.results)) {
            // results[] may be same length or shorter; map robustly to requested points
            if (data.results.length === batch.length) {
                for (const r of data.results) out.push(r.elevation === null ? 0 : r.elevation);
                /* results[] matched batch length (removed) */
            } else {
                // build feats from results and nearest-match to batch points
                const feats = [];
                for (const r of data.results) {
                    if (!r || !r.location) continue;
                    feats.push({ lat: r.location.latitude || r.location.lat || null, lon: r.location.longitude || r.location.lon || null, elev: (r.elevation === null ? 0 : r.elevation) });
                }
                if (feats.length === batch.length) {
                    const used = new Array(feats.length).fill(false);
                    for (const p of batch) {
                        let bestIdx = -1, bestD = Infinity;
                        for (let k = 0; k < feats.length; k++) {
                            if (used[k]) continue;
                            const dx = p.lat - feats[k].lat, dy = p.lon - feats[k].lon;
                            const d = dx * dx + dy * dy;
                            if (d < bestD) { bestD = d; bestIdx = k; }
                        }
                        if (bestIdx >= 0) { out.push(feats[bestIdx].elev); used[bestIdx] = true; }
                        else out.push(0);
                    }
                } else if (feats.length > 0) {
                    // nearest neighbor mapping without reservation
                    for (const p of batch) {
                        let bestIdx = -1, bestD = Infinity;
                        for (let k = 0; k < feats.length; k++) {
                            const dx = p.lat - feats[k].lat, dy = p.lon - feats[k].lon;
                            const d = dx * dx + dy * dy;
                            if (d < bestD) { bestD = d; bestIdx = k; }
                        }
                        out.push(bestIdx >= 0 ? feats[bestIdx].elev : 0);
                    }
                } else {
                    // no usable results, push zeros for this batch
                    for (let k = 0; k < batch.length; k++) out.push(0);
                    console.warn('fetchElevationPoints: results[] present but no usable locations for batch', i);
                }
            }
        } else {
            // fallback: try to salvage numbers
            if (data && typeof data === 'object') {
                const vals = JSON.stringify(data).match(/-?\d+\.?\d*/g) || [];
                for (const v of vals) out.push(parseFloat(v));
            }
        }
        // Ensure we've appended exactly batch.length elevation values for this batch
        const appended = out.length - Math.max(0, out.length - batch.length - (points.length - (i + batch.length)));
        // simpler: compute how many we appended in this iteration by comparing with expected index
        // compute expected total after this batch
        const expectedTotal = Math.min(points.length, i + batch.length);
        if (out.length < expectedTotal) {
            const need = expectedTotal - out.length;
            for (let k = 0; k < need; k++) out.push(0);
            console.warn('fetchElevationPoints: padded', need, 'zeros for batch', i, 'after', attempt + 1, 'attempts');
        }

        // diagnostic: check for abrupt large jumps in this batch
        if (out.length >= expectedTotal) {
            let jumps = 0; let last = out[expectedTotal - batch.length];
            for (let k = expectedTotal - batch.length + 1; k < expectedTotal; k++) {
                const v = out[k]; if (Math.abs(v - last) > 1000) jumps++; last = v;
            }
            if (jumps > Math.max(1, Math.floor(batch.length / 10))) console.warn('Large elevation jumps detected in batch — possible ordering mismatch', { batchStart: i, batchSize: batch.length, jumps });
        }
    }
    return out;
}

async function buildTerrainForBBox(bbox, gridSize = 64, waterMeshes = null) {
    // bbox = [south, west, north, east]
    const [s, w, n, e] = bbox;
    const nx = gridSize, ny = gridSize;
    const lats = new Array(ny);
    const lons = new Array(nx);
    for (let j = 0; j < ny; j++) lats[j] = s + (n - s) * (j / (ny - 1));
    for (let i = 0; i < nx; i++) lons[i] = w + (e - w) * (i / (nx - 1));
    // prepare point list for elevation API
    const points = [];
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) points.push({ lat: lats[j], lon: lons[i] });
    const heightsFlat = await fetchElevationPoints(points);

    // build heights 2D array
    const heights = new Array(ny);
    let idx = 0;
    for (let j = 0; j < ny; j++) {
        heights[j] = new Array(nx);
        for (let i = 0; i < nx; i++) { heights[j][i] = heightsFlat[idx++] || 0; }
    }

    // define origin (bbox center) early so water integration and spacing can use it
    const origin = { lat: (s + n) / 2, lon: (w + e) / 2 };
    // precompute XY positions for each grid cell in local meters
    const xyGrid = new Array(ny);
    for (let j = 0; j < ny; j++) {
        xyGrid[j] = new Array(nx);
        for (let i = 0; i < nx; i++) {
            const pxy = latLonToMeters(lats[j], lons[i], origin);
            xyGrid[j][i] = { x: pxy.x, y: pxy.y };
        }
    }

    // prepare water mask if waterMeshes provided (waterMeshes are in local meters coords)
    const waterMask = new Array(ny);
    for (let j = 0; j < ny; j++) { waterMask[j] = new Array(nx).fill(false); }
    // helper: point-in-polygon (ray-casting)
    function pointInPoly(x, y, poly) {
        let inside = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const xi = poly[i].x, yi = poly[i].y;
            const xj = poly[j].x, yj = poly[j].y;
            const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi + 0.0) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }
    // helper: distance from point to polyline (segments)
    function pointToPolylineDist(x, y, pts) {
        let best = Infinity;
        for (let k = 0; k < pts.length - 1; k++) {
            const x1 = pts[k].x, y1 = pts[k].y; const x2 = pts[k + 1].x, y2 = pts[k + 1].y;
            const A = x - x1, B = y - y1, C = x2 - x1, D = y2 - y1;
            const dot = A * C + B * D;
            const len2 = C * C + D * D;
            const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, dot / len2));
            const px = x1 + t * C, py = y1 + t * D;
            const dx = x - px, dy = y - py; const d2 = dx * dx + dy * dy;
            if (d2 < best) best = d2;
        }
        return Math.sqrt(best);
    }

    if (waterMeshes && Array.isArray(waterMeshes) && waterMeshes.length) {
        // approximate grid spacing for river width threshold
        const approxSpacing = Math.max(Math.abs(latLonToMeters(lats[0], lons[1], origin).x - latLonToMeters(lats[0], lons[0], origin).x), Math.abs(latLonToMeters(lats[1], lons[0], origin).y - latLonToMeters(lats[0], lons[0], origin).y)) || 1;
        for (const w of waterMeshes) {
            if (!w || !w.pts || !w.pts.length) continue;
            // polygonal water (lake/reservoir)
            if (w.pts.length >= 3) {
                // polygonal water (lake/reservoir)
                // Step 1: mark grid cells whose centers fall inside the polygon
                for (let j = 0; j < ny; j++) {
                    for (let i = 0; i < nx; i++) {
                        const pxy = latLonToMeters(lats[j], lons[i], origin);
                        if (pointInPoly(pxy.x, pxy.y, w.pts)) {
                            waterMask[j][i] = true;
                        }
                    }
                }

                // Step 2: find shore (adjacent non-water) cell heights
                const shoreHeights = [];
                for (let j = 0; j < ny; j++) {
                    for (let i = 0; i < nx; i++) {
                        if (!waterMask[j][i]) continue;
                        // check 8-neighbors for any non-water neighbor and collect its height
                        for (let dj = -1; dj <= 1; dj++) {
                            for (let di = -1; di <= 1; di++) {
                                if (dj === 0 && di === 0) continue;
                                const nj = j + dj, ni = i + di;
                                if (nj < 0 || nj >= ny || ni < 0 || ni >= nx) continue;
                                if (!waterMask[nj][ni]) {
                                    const hh = (heights[nj] && typeof heights[nj][ni] === 'number') ? heights[nj][ni] : null;
                                    if (hh !== null) shoreHeights.push(hh);
                                }
                            }
                        }
                    }
                }

                // Step 3: decide water level. Prefer min of adjacent shore heights (conservative).
                let waterLevel = null;
                if (shoreHeights.length) {
                    waterLevel = Math.min(...shoreHeights);
                } else {
                    // fallback: sample nearest grid heights to polygon vertices (previous behaviour)
                    const vHeights = [];
                    for (const v of w.pts) {
                        let bestD = Infinity, bi = 0, bj = 0;
                        for (let jj = 0; jj < ny; jj++) for (let ii = 0; ii < nx; ii++) {
                            const dx = xyGrid[jj][ii].x - v.x, dy = xyGrid[jj][ii].y - v.y; const d = dx * dx + dy * dy;
                            if (d < bestD) { bestD = d; bi = ii; bj = jj; }
                        }
                        const h = (heights[bj] && typeof heights[bj][bi] === 'number') ? heights[bj][bi] : null;
                        if (h !== null) vHeights.push(h);
                    }
                    if (vHeights.length) waterLevel = Math.min(...vHeights);
                }

                // Step 4: apply water level to masked cells (do not raise existing lower terrain)
                if (waterLevel !== null) {
                    const eps = 0.02;
                    for (let j = 0; j < ny; j++) {
                        for (let i = 0; i < nx; i++) {
                            if (!waterMask[j][i]) continue;
                            const cur = (heights[j] && typeof heights[j][i] === 'number') ? heights[j][i] : waterLevel - eps;
                            // ensure water does not sit above shore: cap at waterLevel - eps
                            heights[j][i] = Math.min(cur, waterLevel - eps);
                        }
                    }
                }
            } else if (w.pts.length > 1) {
                // polyline -> river; mark grid points within threshold of the polyline
                const threshold = approxSpacing * 1.5;
                for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
                    const xy = latLonToMeters(lats[j], lons[i], origin);
                    const d = pointToPolylineDist(xy.x, xy.y, w.pts);
                    if (d <= threshold) {
                        waterMask[j][i] = true;
                        // assign height to nearest polyline vertex height (use nearest vertex)
                        let bestD = Infinity, bi = 0;
                        for (let k = 0; k < w.pts.length; k++) {
                            const dx = xy.x - w.pts[k].x, dy = xy.y - w.pts[k].y; const dd = dx * dx + dy * dy;
                            if (dd < bestD) { bestD = dd; bi = k; }
                        }
                        // approximate river height by nearest grid to that polyline vertex
                        const pv = w.pts[bi];
                        let bestD2 = Infinity, gi = 0, gj = 0;
                        for (let jj = 0; jj < ny; jj++) for (let ii = 0; ii < nx; ii++) {
                            const p2 = latLonToMeters(lats[jj], lons[ii], origin);
                            const dx = p2.x - pv.x, dy = p2.y - pv.y; const d2 = dx * dx + dy * dy;
                            if (d2 < bestD2) { bestD2 = d2; gi = ii; gj = jj; }
                        }
                        const ph = (heights[gj] && typeof heights[gj][gi] === 'number') ? heights[gj][gi] : heights[j][i];
                        heights[j][i] = ph - 0.02;
                    }
                }
            }
        }
    }

    // compute min/max for diagnostics and visualization scaling
    let minH = Infinity, maxH = -Infinity;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const h = heights[j][i];
        if (h < minH) minH = h;
        if (h > maxH) maxH = h;
    }
    if (minH === Infinity) { minH = 0; maxH = 0; }
    /* Terrain heights logged (removed) */

    // choose a visual vertical scale: if terrain is very flat, exaggerate for visibility
    const delta = maxH - minH;
    const extraScale = delta < 5 ? 10 : (delta < 20 ? 3 : 1);
    const visualScale = VERT_SCALE * extraScale;

    // create geometry in local meters (using previously computed origin)
    // grid spacing in meters approximated by latLonToMeters delta
    const p00 = latLonToMeters(lats[0], lons[0], origin);
    const p10 = latLonToMeters(lats[0], lons[1], origin);
    const p01 = latLonToMeters(lats[1], lons[0], origin);
    const dx = Math.abs(p10.x - p00.x);
    const dy = Math.abs(p01.y - p00.y);


    // build BufferGeometry using real world X,Y positions (local meters relative to origin)
    // positions: nx * ny vertices, each with x,y,z (z = (h - minH) * visualScale)
    const positions = new Float32Array(nx * ny * 3);
    const colors = new Float32Array(nx * ny * 3);
    let pi = 0;
    let cpi = 0;
    // track minX/minY in local meters
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
            const p = xyGrid[j][i];
            if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
            const h = heights[j][i];
            positions[pi++] = p.x; // X
            positions[pi++] = p.y; // Y
            positions[pi++] = (h - minH) * visualScale; // Z

            // color: tint water vertices blue, else terrain gradient
            if (waterMask[j][i]) {
                colors[cpi++] = 0.1; colors[cpi++] = 0.45; colors[cpi++] = 0.85;
            } else {
                const t = Math.max(0, Math.min(1, (h + 50) / 1000));
                const r = 0.2 + 0.6 * t; const g = 0.6 * (1 - t) + 0.3 * t; const b = 0.2;
                colors[cpi++] = r; colors[cpi++] = g; colors[cpi++] = b;
            }
        }
    }

    // compute grid spacings
    const gridDx = (nx > 1) ? ((maxX - minX) / (nx - 1)) : dx;
    const gridDy = (ny > 1) ? ((maxY - minY) / (ny - 1)) : dy;

    // build index buffer (two triangles per cell)
    const indices = [];
    for (let j = 0; j < ny - 1; j++) {
        for (let i = 0; i < nx - 1; i++) {
            const a = j * nx + i;
            const b = j * nx + (i + 1);
            const c = (j + 1) * nx + i;
            const d = (j + 1) * nx + (i + 1);
            // two triangles: a, c, b and b, c, d
            indices.push(a, c, b);
            indices.push(b, c, d);
        }
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geom.setIndex(indices);
    geom.computeVertexNormals();

    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    const wire = new THREE.MeshBasicMaterial({ color: 0x000000, wireframe: true, opacity: 0.08, transparent: true, depthWrite: false });
    if (terrain) scene.remove(terrain);
    terrain = new THREE.Mesh(geom, mat);
    const wireMesh = new THREE.Mesh(geom.clone(), wire);
    terrain.add(wireMesh);
    scene.add(terrain);

    terrainGrid = { nx, ny, lats, lons, heights, origin, dx: gridDx, dy: gridDy, minX, minY, minH, visualScale, xyGrid };
}

function getTerrainHeightAt(x, y) {
    // x,y are in local meters relative to origin used when building terrain
    if (!terrainGrid) return 0;
    const { nx, ny, heights, origin, minH = 0, visualScale = VERT_SCALE, minX, minY, dx: gridDx, dy: gridDy } = terrainGrid;
    // prefer world-grid mapping (minX/minY present)
    let ix = 0, jy = 0;
    if (typeof minX === 'number' && typeof minY === 'number' && gridDx && gridDy) {
        ix = (x - minX) / gridDx;
        jy = (y - minY) / gridDy;
    } else {
        // fallback: approximate using origin and lat/lon arrays
        // map x,y relative to origin into fractional indices
        const rel = latLonToMeters(origin.lat, origin.lon, origin); // zero
        ix = 0; jy = 0;
    }
    let i0 = Math.floor(ix), j0 = Math.floor(jy);
    let i1 = i0 + 1, j1 = j0 + 1;
    // clamp indices
    if (i0 < 0) i0 = 0; if (j0 < 0) j0 = 0;
    if (i1 < 0) i1 = 0; if (j1 < 0) j1 = 0;
    if (i0 >= nx) i0 = nx - 1; if (i1 >= nx) i1 = nx - 1;
    if (j0 >= ny) j0 = ny - 1; if (j1 >= ny) j1 = ny - 1;
    const sx = ix - i0, sy = jy - j0;
    const row0 = heights[j0] || [];
    const row1 = heights[j1] || [];
    const h00 = (typeof row0[i0] === 'number') ? row0[i0] : 0;
    const h10 = (typeof row0[i1] === 'number') ? row0[i1] : h00;
    const h01 = (typeof row1[i0] === 'number') ? row1[i0] : h00;
    const h11 = (typeof row1[i1] === 'number') ? row1[i1] : h00;
    const h0 = h00 * (1 - sx) + h10 * sx;
    const h1 = h01 * (1 - sx) + h11 * sx;
    const h = h0 * (1 - sy) + h1 * sy;
    // convert to same vertical space as terrain mesh: (h - minH) * visualScale
    return (h - minH) * visualScale;
}

// Robust sampler: raycast down onto the terrain mesh to get exact surface Z (world units)
const _terrainRaycaster = new THREE.Raycaster();
function sampleTerrainHeightFromMesh(x, y) {
    if (!terrain || !terrain.geometry) return getTerrainHeightAt(x, y);
    // choose a high origin above expected max terrain height
    const top = 10000;
    const origin = new THREE.Vector3(x, y, top);
    const dir = new THREE.Vector3(0, 0, -1);
    _terrainRaycaster.set(origin, dir);
    const intersects = _terrainRaycaster.intersectObject(terrain, true);
    if (intersects && intersects.length) return intersects[0].point.z;
    return getTerrainHeightAt(x, y);
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
    // (ground plane removed per user request)

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
        // modify geometry so base follows terrain: for each vertex, add terrain height at its X,Y to its Z
        try {
            const posAttr = extrude.attributes.position;
            for (let vi = 0; vi < posAttr.count; vi++) {
                const vx = posAttr.getX(vi), vy = posAttr.getY(vi), vz = posAttr.getZ(vi);
                const h = (typeof sampleTerrainHeightFromMesh === 'function') ? sampleTerrainHeightFromMesh(vx, vy) : getTerrainHeightAt(vx, vy);
                if (!isNaN(h)) posAttr.setZ(vi, vz + h);
            }
            extrude.attributes.position.needsUpdate = true;
            extrude.computeVertexNormals();
        } catch (e) { /* if geometry not as expected, fallback to centroid placement below */ }
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
        // If extrude geometry modification failed, fall back to centroid-based placement
        if (!extrude.attributes || !extrude.attributes.position) {
            const centroidX = m.pts.reduce((s, p) => s + p.x, 0) / Math.max(1, m.pts.length);
            const centroidY = m.pts.reduce((s, p) => s + p.y, 0) / Math.max(1, m.pts.length);
            const baseHeight = (typeof getTerrainHeightAt === 'function') ? getTerrainHeightAt(centroidX, centroidY) : 0;
            mesh.position.z = baseHeight;
        }
        scene.add(mesh);
        buildings.push(mesh);
        // Compute bounding box and normals for later use in weapon simulation
        mesh.geometry.computeBoundingBox();
        mesh.geometry.computeVertexNormals();
        // labels removed by user request
    }
}

// Helper: create a sprite label from text
// Labels removed by user request: makeLabel and _recordLabel functions deleted.

// New renderers for other types
function addRoadsToScene(roadMeshes) {
    // remove previous roads
    if (!scene.userData.roads) scene.userData.roads = [];
    for (const r of scene.userData.roads) scene.remove(r);
    scene.userData.roads = [];
    // helper: compute normals per segment
    function segNormals(pts) {
        const normals = [];
        for (let i = 0; i < pts.length - 1; i++) {
            const a = pts[i], b = pts[i + 1];
            const dx = b.x - a.x, dy = b.y - a.y;
            const len = Math.sqrt(dx * dx + dy * dy) || 1;
            const nx = -dy / len, ny = dx / len;
            normals.push({ x: nx, y: ny });
        }
        return normals;
    }

    // helper: pick default lane count & lane width based on highway type
    function guessLaneInfo(tags) {
        let lanes = tags && tags.lanes ? parseInt(tags.lanes) : null;
        const highway = tags && tags.highway ? tags.highway : '';
        if (!lanes) {
            if (highway === 'motorway') lanes = 4;
            else if (highway === 'trunk') lanes = 4;
            else if (highway === 'primary') lanes = 2;
            else if (highway === 'secondary') lanes = 2;
            else if (highway === 'tertiary') lanes = 2;
            else if (highway === 'residential' || highway === 'unclassified' || highway === 'service') lanes = 2;
            else lanes = 1;
        }
        // lane width defaults
        let laneWidth = 3.0;
        if (highway === 'motorway') laneWidth = 3.5;
        if (highway === 'cycleway' || highway === 'footway' || highway === 'path') laneWidth = 1.5;
        return { lanes, laneWidth };
    }

    for (const r of roadMeshes) {
        if (!r.pts || r.pts.length < 2) continue;
        const tags = r.tags || {};
        const pts = r.pts.map(p => ({ x: p.x, y: p.y }));
        const normals = segNormals(pts);
        const info = guessLaneInfo(tags);
        const totalWidth = info.lanes * info.laneWidth;
        const half = totalWidth / 2;

        // choose material color by surface
        const surface = (tags.surface || '').toLowerCase();
        const isConcrete = /concrete|paving/.test(surface);
        const isAsphalt = /asphalt|bitumen|tarmac/.test(surface) || surface === '';
        const roadColor = isConcrete ? 0xcccccc : 0x2f2f2f; // light gray for concrete, dark for asphalt
        const roadMat = new THREE.MeshLambertMaterial({ color: roadColor });

        // build left and right offset polylines (per segment)
        const leftPts = [], rightPts = [];
        for (let i = 0; i < pts.length; i++) {
            let nx = 0, ny = 0;
            if (i === 0) { nx = normals[0].x; ny = normals[0].y; }
            else if (i === pts.length - 1) { nx = normals[normals.length - 1].x; ny = normals[normals.length - 1].y; }
            else {
                // average normals of segments before and after
                const n1 = normals[i - 1], n2 = normals[i];
                nx = (n1.x + n2.x) / 2; ny = (n1.y + n2.y) / 2;
                const l = Math.sqrt(nx * nx + ny * ny) || 1; nx /= l; ny /= l;
            }
            leftPts.push(new THREE.Vector2(pts[i].x + nx * half, pts[i].y + ny * half));
            rightPts.push(new THREE.Vector2(pts[i].x - nx * half, pts[i].y - ny * half));
        }

        // build shape by leftPts then reversed rightPts
        const shape = new THREE.Shape();
        leftPts.forEach((p, idx) => { if (idx === 0) shape.moveTo(p.x, p.y); else shape.lineTo(p.x, p.y); });
        for (let i = rightPts.length - 1; i >= 0; i--) shape.lineTo(rightPts[i].x, rightPts[i].y);

        const geom = new THREE.ExtrudeGeometry(shape, { depth: 0.1, bevelEnabled: false });
        // raise road geometry so base follows terrain per-vertex
        try {
            const posAttr = geom.attributes.position;
            for (let vi = 0; vi < posAttr.count; vi++) {
                const vx = posAttr.getX(vi), vy = posAttr.getY(vi), vz = posAttr.getZ(vi);
                const h = (typeof sampleTerrainHeightFromMesh === 'function') ? sampleTerrainHeightFromMesh(vx, vy) : getTerrainHeightAt(vx, vy);
                if (!isNaN(h)) posAttr.setZ(vi, vz + h + 0.02);
            }
            geom.attributes.position.needsUpdate = true;
            geom.computeVertexNormals();
        } catch (e) {
            // fallback to average centerline height
            let avgH = 0; let hhCount = 0;
            for (const p of pts) { const h = getTerrainHeightAt(p.x, p.y); if (!isNaN(h)) { avgH += h; hhCount++; } }
            if (hhCount) avgH /= hhCount; else avgH = 0;
            // will set mesh.position below
            geom.userData = { fallbackZ: avgH + 0.02 };
        }
        const mesh = new THREE.Mesh(geom, roadMat);
        if (geom.userData && typeof geom.userData.fallbackZ === 'number') mesh.position.z = geom.userData.fallbackZ;
        scene.add(mesh);
        scene.userData.roads.push(mesh);

        // centerline / lane separator: if lanes > 1, draw center dashed/yellow line for two-way, white for one-way
        try {
            const lanes = info.lanes || 1;
            if (lanes > 1) {
                const linePts = pts.map(p => new THREE.Vector3(p.x, p.y, (getTerrainHeightAt(p.x, p.y) || 0) + 0.12));
                const lineGeom = new THREE.BufferGeometry().setFromPoints(linePts);
                // compute dashed material color
                const isOneWay = tags.oneway === 'yes' || tags.oneway === '1' || tags.oneway === 'true';
                const dashColor = isOneWay ? 0xffffff : 0xffcc00;
                const lineMat = new THREE.LineDashedMaterial({ color: dashColor, dashSize: 4, gapSize: 4, linewidth: 1 });
                const line = new THREE.Line(lineGeom, lineMat);
                line.computeLineDistances();
                scene.add(line);
                scene.userData.roads.push(line);
            }
        } catch (e) {
            // ignore
        }
        // draw dark border along edges for contrast
        try {
            const leftBorderPts = leftPts.map(p => new THREE.Vector3(p.x, p.y, (getTerrainHeightAt(p.x, p.y) || 0) + 0.025));
            const rightBorderPts = rightPts.map(p => new THREE.Vector3(p.x, p.y, (getTerrainHeightAt(p.x, p.y) || 0) + 0.025));
            const borderMat = new THREE.LineBasicMaterial({ color: 0x111111 });
            // set border z to average height as well
            const leftGeom = new THREE.BufferGeometry().setFromPoints(leftBorderPts);
            const rightGeom = new THREE.BufferGeometry().setFromPoints(rightBorderPts);
            const leftLine = new THREE.Line(leftGeom, borderMat);
            const rightLine = new THREE.Line(rightGeom, borderMat);
            scene.add(leftLine); scene.userData.roads.push(leftLine);
            scene.add(rightLine); scene.userData.roads.push(rightLine);
        } catch (e) { }
    }
}

function addWaterToScene(waterMeshes) {
    if (!scene.userData.water) scene.userData.water = [];
    for (const r of scene.userData.water) scene.remove(r);
    scene.userData.water = [];
    for (const w of waterMeshes) {
        // If polygon (lake/reservoir) - create a thin mesh that conforms to terrain by sampling height per vertex
        if (w.pts.length >= 3) {
            // Build a geometry from the polygon vertices with Z sampled from terrain
            const vertices = [];
            for (const p of w.pts) {
                const h = getTerrainHeightAt(p.x, p.y);
                const z = isNaN(h) ? 0 : (h);
                vertices.push(new THREE.Vector3(p.x, p.y, z));
            }
            // Triangulate the polygon in 2D (x,y) then apply Z from vertices
            try {
                // use Earcut via Shape for triangulation: create a flat shape and extract its triangulation
                const shape = new THREE.Shape();
                w.pts.forEach((p, i) => { if (i === 0) shape.moveTo(p.x, p.y); else shape.lineTo(p.x, p.y); });
                const geom2 = new THREE.ShapeGeometry(shape);
                // replace the positions with our elevation-aware vertices
                const posAttr = geom2.attributes.position;
                for (let i = 0; i < posAttr.count; i++) {
                    const vx = posAttr.getX(i), vy = posAttr.getY(i);
                    // find matching vertex in original pts (use nearest)
                    let nearestIdx = 0; let bestDist = Infinity;
                    for (let j = 0; j < vertices.length; j++) {
                        const dx = vx - vertices[j].x, dy = vy - vertices[j].y;
                        const d = dx * dx + dy * dy;
                        if (d < bestDist) { bestDist = d; nearestIdx = j; }
                    }
                    posAttr.setZ(i, vertices[nearestIdx].z - 0.02); // slightly below terrain to appear like water
                }
                geom2.attributes.position.needsUpdate = true;
                // ensure correct normals
                geom2.computeVertexNormals();
                const mat = new THREE.MeshLambertMaterial({ color: 0x3b99d6, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
                const mesh = new THREE.Mesh(geom2, mat);
                mesh.renderOrder = 1;
                scene.add(mesh);
                scene.userData.water.push(mesh);
            } catch (e) {
                // fallback: render a flat extrude at average height
                let sum = 0, cnt = 0;
                for (const p of w.pts) { const h = getTerrainHeightAt(p.x, p.y); if (!isNaN(h)) { sum += h; cnt++; } }
                const avg = cnt ? (sum / cnt) : 0;
                const shape = new THREE.Shape();
                w.pts.forEach((p, i) => { if (i === 0) shape.moveTo(p.x, p.y); else shape.lineTo(p.x, p.y); });
                const geom = new THREE.ExtrudeGeometry(shape, { depth: 0.01, bevelEnabled: false });
                const mat = new THREE.MeshLambertMaterial({ color: 0x3b99d6, transparent: true, opacity: 0.85 });
                const mesh = new THREE.Mesh(geom, mat);
                mesh.position.z = avg - 0.02;
                scene.add(mesh);
                scene.userData.water.push(mesh);
            }

        } else if (w.pts.length > 1) {
            // polyline -> render as river that follows terrain by sampling centerline heights
            const points = w.pts.map(p => {
                const h = getTerrainHeightAt(p.x, p.y);
                return new THREE.Vector3(p.x, p.y, isNaN(h) ? 0 : (h - 0.02));
            });
            // create a smooth curve and sample points along it
            const curve = new THREE.CatmullRomCurve3(points);
            const divisions = Math.max(Math.floor(points.length * 4), 8);
            const sampled = curve.getPoints(divisions);
            // create a ribbon-like geometry by offsetting left/right along the curve using Frenet frames
            const leftPts = [], rightPts = [];
            for (let i = 0; i < sampled.length; i++) {
                const p = sampled[i];
                // approximate tangent
                const t = curve.getTangent(i / sampled.length).normalize();
                // compute normal in XY plane
                const nx = -t.y, ny = t.x;
                const halfWidth = 1.0; // river half-width in meters (could be derived from tags)
                leftPts.push(new THREE.Vector3(p.x + nx * halfWidth, p.y + ny * halfWidth, p.z));
                rightPts.push(new THREE.Vector3(p.x - nx * halfWidth, p.y - ny * halfWidth, p.z));
            }
            // build geometry from leftPts + reversed rightPts
            const riverGeom = new THREE.BufferGeometry();
            const verts = [];
            for (let i = 0; i < leftPts.length; i++) { verts.push(leftPts[i].x, leftPts[i].y, leftPts[i].z); }
            for (let i = rightPts.length - 1; i >= 0; i--) { verts.push(rightPts[i].x, rightPts[i].y, rightPts[i].z); }
            riverGeom.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
            // simple triangulation by creating a single face strip
            const idx = [];
            const L = leftPts.length;
            for (let i = 0; i < L - 1; i++) {
                idx.push(i, i + 1, 2 * L - 1 - i);
                idx.push(i + 1, 2 * L - 2 - i, 2 * L - 1 - i);
            }
            riverGeom.setIndex(idx);
            riverGeom.computeVertexNormals();
            const mat = new THREE.MeshLambertMaterial({ color: 0x3b99d6, transparent: true, opacity: 0.95, side: THREE.DoubleSide });
            const mesh = new THREE.Mesh(riverGeom, mat);
            mesh.renderOrder = 1;
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
        const xs = h.pts.map(p => p.x), ys = h.pts.map(p => p.y);
        const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
        const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
        const geom = new THREE.ConeGeometry(20, 40, 12);
        const mat = new THREE.MeshLambertMaterial({ color: 0x886644, transparent: true, opacity: 0.9 });
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
        // labels removed by user request
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
        // labels removed by user request
    }
}

function addInfraToScene(infra) {
    // manage infra group on scene.userData so we can remove them easily
    if (!scene.userData.infra) scene.userData.infra = [];
    else {
        for (const o of scene.userData.infra) scene.remove(o);
        scene.userData.infra = [];
    }

    // helper to add and record
    const addRecorded = (obj) => { scene.add(obj); scene.userData.infra.push(obj); };

    // simple sphere markers for hospitals and schools (points)
    const sphereGeom = new THREE.SphereGeometry(1.2, 8, 6);
    const hospitalMat = new THREE.MeshStandardMaterial({ color: 0xff4444, metalness: 0.1, roughness: 0.8 });
    const schoolMat = new THREE.MeshStandardMaterial({ color: 0x4444ff, metalness: 0.1, roughness: 0.8 });

    if (infra.hospitals) {
        for (const h of infra.hospitals) {
            if (h.pos) {
                const m = new THREE.Mesh(sphereGeom, hospitalMat);
                const hh = getTerrainHeightAt(h.pos.x, h.pos.y) || 0;
                m.position.set(h.pos.x, h.pos.y, hh + 2);
                m.userData = { type: 'hospital', tags: h.tags };
                addRecorded(m);
                // labels removed by user request
            } else if (h.pts && h.pts.length) {
                // extrude area
                const shape = new THREE.Shape(h.pts.map(p => new THREE.Vector2(p.x, p.y)));
                const geom = new THREE.ExtrudeGeometry(shape, { depth: 4, bevelEnabled: false });
                const mat = new THREE.MeshStandardMaterial({ color: 0xff6666, opacity: 0.9, transparent: true });
                const mesh = new THREE.Mesh(geom, mat);
                // position polys to terrain average
                let sumh = 0, c = 0; for (const p of h.pts) { const hh = getTerrainHeightAt(p.x, p.y); if (!isNaN(hh)) { sumh += hh; c++; } }
                const base = c ? (sumh / c) : 0;
                mesh.position.z = base;
                addRecorded(mesh);
                const xs = h.pts.map(p => p.x), ys = h.pts.map(p => p.y);
                const cx = xs.reduce((s, v) => s + v, 0) / xs.length; const cy = ys.reduce((s, v) => s + v, 0) / ys.length;
                // labels removed by user request
            }
        }
    }

    if (infra.schools) {
        for (const s of infra.schools) {
            if (s.pos) {
                const sh = getTerrainHeightAt(s.pos.x, s.pos.y) || 0;
                const m = new THREE.Mesh(sphereGeom, schoolMat);
                m.position.set(s.pos.x, s.pos.y, sh + 2);
                m.userData = { type: 'school', tags: s.tags };
                addRecorded(m);
                // labels removed by user request
            } else if (s.pts && s.pts.length) {
                const shape = new THREE.Shape(s.pts.map(p => new THREE.Vector2(p.x, p.y)));
                const geom = new THREE.ExtrudeGeometry(shape, { depth: 3, bevelEnabled: false });
                const mat = new THREE.MeshStandardMaterial({ color: 0x6666ff, opacity: 0.85, transparent: true });
                const mesh = new THREE.Mesh(geom, mat);
                let sumh2 = 0, c2 = 0; for (const p of s.pts) { const hh = getTerrainHeightAt(p.x, p.y); if (!isNaN(hh)) { sumh2 += hh; c2++; } }
                const base2 = c2 ? (sumh2 / c2) : 0;
                mesh.position.z = base2;
                addRecorded(mesh);
                const xs = s.pts.map(p => p.x), ys = s.pts.map(p => p.y);
                const cx = xs.reduce((t, v) => t + v, 0) / xs.length; const cy = ys.reduce((t, v) => t + v, 0) / ys.length;
                // labels removed by user request
            }
        }
    }

    // bus stops as small spheres
    if (infra.busStops) {
        const busMat = new THREE.MeshStandardMaterial({ color: 0xffff44 });
        const busGeom = new THREE.SphereGeometry(0.8, 6, 6);
        for (const b of infra.busStops) {
            if (!b.pos) continue;
            const bh = getTerrainHeightAt(b.pos.x, b.pos.y) || 0;
            const m = new THREE.Mesh(busGeom, busMat);
            m.position.set(b.pos.x, b.pos.y, bh + 1.5);
            m.userData = { type: 'bus', tags: b.tags };
            addRecorded(m);
            // labels removed by user request
        }
    }

    // parking, industrial, airports -> extruded areas
    const areaMat = new THREE.MeshStandardMaterial({ color: 0x999999, opacity: 0.7, transparent: true });
    const parkingMat = new THREE.MeshStandardMaterial({ color: 0x555555, opacity: 0.7, transparent: true });
    if (infra.parking) {
        for (const p of infra.parking) {
            if (!p.pts || !p.pts.length) continue;
            const shape = new THREE.Shape(p.pts.map(pt => new THREE.Vector2(pt.x, pt.y)));
            const geom = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false });
            const mesh = new THREE.Mesh(geom, parkingMat);
            mesh.position.z = 0.05;
            addRecorded(mesh);
            const xs = p.pts.map(pt => pt.x), ys = p.pts.map(pt => pt.y);
            const cx = xs.reduce((s, v) => s + v, 0) / xs.length; const cy = ys.reduce((s, v) => s + v, 0) / ys.length;
            // labels removed by user request
        }
    }
    if (infra.industrial) {
        for (const p of infra.industrial) {
            if (!p.pts || !p.pts.length) continue;
            const shape = new THREE.Shape(p.pts.map(pt => new THREE.Vector2(pt.x, pt.y)));
            const geom = new THREE.ExtrudeGeometry(shape, { depth: 6, bevelEnabled: false });
            const mesh = new THREE.Mesh(geom, areaMat);
            mesh.position.z = 0.1;
            addRecorded(mesh);
            const xs = p.pts.map(pt => pt.x), ys = p.pts.map(pt => pt.y);
            const cx = xs.reduce((s, v) => s + v, 0) / xs.length; const cy = ys.reduce((s, v) => s + v, 0) / ys.length;
            // labels removed by user request
        }
    }
    if (infra.airports) {
        for (const p of infra.airports) {
            if (!p.pts || !p.pts.length) continue;
            const shape = new THREE.Shape(p.pts.map(pt => new THREE.Vector2(pt.x, pt.y)));
            const geom = new THREE.ExtrudeGeometry(shape, { depth: 0.5, bevelEnabled: false });
            const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({ color: 0x222222, opacity: 0.6, transparent: true }));
            mesh.position.z = 0.05;
            addRecorded(mesh);
            const xs = p.pts.map(pt => pt.x), ys = p.pts.map(pt => pt.y);
            const cx = xs.reduce((s, v) => s + v, 0) / xs.length; const cy = ys.reduce((s, v) => s + v, 0) / ys.length;
            // labels removed by user request
        }
    }

    // bridges, rails, power -> lines
    const lineMat = new THREE.LineBasicMaterial({ color: 0x663300 });
    if (infra.bridges) {
        for (const b of infra.bridges) {
            if (!b.pts || b.pts.length < 2) continue;
            const pts = b.pts.map(p => new THREE.Vector3(p.x, p.y, 0.5));
            const geom = new THREE.BufferGeometry().setFromPoints(pts);
            const line = new THREE.Line(geom, lineMat);
            addRecorded(line);
        }
    }
    if (infra.rails) {
        const railMat = new THREE.LineBasicMaterial({ color: 0x111111, linewidth: 2 });
        for (const r of infra.rails) {
            if (!r.pts || r.pts.length < 2) continue;
            const pts = r.pts.map(p => new THREE.Vector3(p.x, p.y, 0.5));
            const geom = new THREE.BufferGeometry().setFromPoints(pts);
            const line = new THREE.Line(geom, railMat);
            addRecorded(line);
        }
    }
    if (infra.power) {
        const powerMat = new THREE.LineBasicMaterial({ color: 0xffaa00 });
        for (const p of infra.power) {
            if (!p.pts || p.pts.length < 2) continue;
            const pts = p.pts.map(pt => new THREE.Vector3(pt.x, pt.y, 1.0));
            const geom = new THREE.BufferGeometry().setFromPoints(pts);
            const line = new THREE.Line(geom, powerMat);
            addRecorded(line);
        }
    }
}

let lastTime = 0;

function animate(currentTime) {
    requestAnimationFrame(animate);
    const deltaTime = (currentTime - lastTime) / 1000; // Convert to seconds
    lastTime = currentTime;

    // Update shake effects
    if (weaponSim) {
        weaponSim.updateShakeEffects(deltaTime);
        if (typeof weaponSim.update === 'function') weaponSim.update(deltaTime);
    }

    controls.update();
    renderer.render(scene, camera);
}

let buildingTexture = null;

// Wire UI
initMap();
let weaponSim = new WeaponSimulation(map);
initThree();
// populate dataset selector once DOM/UI is ready
loadOpenTopoDatasets();

document.getElementById('scanBtn').addEventListener('click', async () => {
    if (!rect) { alert('Vui lòng chọn vùng trên bản đồ bằng cách nhấp-drag.'); return; }
    const b = rect.getBounds();
    const bbox = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()];
    const center = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
    try {
        showLoader(true);
        const osm = await fetchOSM(bbox);
        const parsed = parseOSM(osm, center);
            // persist parsed data for session restore
            lastParsed = parsed;
            lastOrigin = { lat: center[0], lon: center[1] };
        // build terrain after parsing so we can merge water into terrain
        try {
            await buildTerrainForBBox(bbox, 48, parsed.water);
        } catch (terrErr) {
            console.warn('Terrain fetch failed, continuing without terrain', terrErr);
        }
        // render based on selections
        if (parsed.buildings && document.getElementById('cb_building').checked) addBuildingsToScene(parsed.buildings);
        // Update weapon simulation with current buildings, scene and origin
        weaponSim.buildings = buildings;
        weaponSim.scene = scene;
        weaponSim.origin = { lat: center[0], lon: center[1] };
        if (parsed.roads && document.getElementById('cb_road').checked) addRoadsToScene(parsed.roads);
        // water is now merged into the terrain; do not create a separate water layer
        if (parsed.parks && document.getElementById('cb_park').checked) addParksToScene(parsed.parks);
        if (parsed.peaks && document.getElementById('cb_mountain').checked) addPeaksToScene(parsed.peaks);
        if (parsed.hills && document.getElementById('cb_mountain').checked) addHillsToScene(parsed.hills);

        // forest, trees, ports (if parsed)
        if (parsed.forests && document.getElementById('cb_forest') && document.getElementById('cb_forest').checked) addForestsToScene(parsed.forests);
        if (parsed.trees && document.getElementById('cb_forest') && document.getElementById('cb_forest').checked) addTreesToScene(parsed.trees);
        if (parsed.ports && document.getElementById('cb_port') && document.getElementById('cb_port').checked) addPortsToScene(parsed.ports);

        // infra toggles
        if (parsed.infra) {
            const infraToAdd = { hospitals: [], schools: [], busStops: [], power: [], parking: [], industrial: [], airports: [], bridges: [], rails: [] };
            if (document.getElementById('cb_hospital') && document.getElementById('cb_hospital').checked) infraToAdd.hospitals = parsed.infra.hospitals || [];
            if (document.getElementById('cb_school') && document.getElementById('cb_school').checked) infraToAdd.schools = parsed.infra.schools || [];
            if (document.getElementById('cb_bus') && document.getElementById('cb_bus').checked) infraToAdd.busStops = parsed.infra.busStops || [];
            if (document.getElementById('cb_rail') && document.getElementById('cb_rail').checked) infraToAdd.rails = parsed.infra.rails || [];
            if (document.getElementById('cb_power') && document.getElementById('cb_power').checked) infraToAdd.power = parsed.infra.power || [];
            if (document.getElementById('cb_parking') && document.getElementById('cb_parking').checked) infraToAdd.parking = parsed.infra.parking || [];
            if (document.getElementById('cb_industrial') && document.getElementById('cb_industrial').checked) infraToAdd.industrial = parsed.infra.industrial || [];
            if (document.getElementById('cb_airport') && document.getElementById('cb_airport').checked) infraToAdd.airports = parsed.infra.airports || [];
            if (document.getElementById('cb_bridge') && document.getElementById('cb_bridge').checked) infraToAdd.bridges = parsed.infra.bridges || [];
            addInfraToScene(infraToAdd);
        }

        // if texture just loaded after buildings were created, ensure materials updated
        if (buildingTexture) {
            // clone texture per building so repeat changes don't affect others
            for (const b of buildings) {
                const t = buildingTexture.clone();
                b.material.map = t;
                b.material.needsUpdate = true;
            }
        }
    } catch (err) {
        console.error(err);
        alert('Lỗi khi lấy dữ liệu OSM');
    } finally {
        showLoader(false);
            try { saveAppState(); } catch (err) { console.warn('saveAppState failed after scan', err); }
    }
});

// restore any saved state after initializing map and three
loadAppState();

// enter 3D: center camera on selection
// (enter3D removed - flight/ptr-lock controls disabled per user request)

// Check all / Uncheck all behaviors for controlsPanel
const checkAllBtn = document.getElementById('checkAll');
const uncheckAllBtn = document.getElementById('uncheckAll');
function setAllControls(yes) {
    const panel = document.getElementById('controlsPanel');
    if (!panel) return;
    const inputs = panel.querySelectorAll('input[type=checkbox]');
    inputs.forEach(inp => { inp.checked = yes; });
}
if (checkAllBtn) checkAllBtn.addEventListener('click', () => setAllControls(true));
if (uncheckAllBtn) uncheckAllBtn.addEventListener('click', () => setAllControls(false));

// Weapon simulation controls
document.getElementById('clearImpactsBtn').addEventListener('click', () => {
    weaponSim.clearImpacts();
});

export { };
