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

// Helper: convert a lat/lon bbox [south,west,north,east] to local meter bounds using an origin
function getLocalBoundsForBBox(bbox, origin) {
    if (!bbox || bbox.length !== 4 || !origin) return null;
    const [s, w, n, e] = bbox;
    const p1 = latLonToMeters(s, w, origin);
    const p2 = latLonToMeters(n, e, origin);
    const minX = Math.min(p1.x, p2.x), maxX = Math.max(p1.x, p2.x);
    const minY = Math.min(p1.y, p2.y), maxY = Math.max(p1.y, p2.y);
    return { minX, minY, maxX, maxY };
}

function ptsIntersectBounds(pts, bounds) {
    if (!pts || !pts.length || !bounds) return true;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
        if (typeof p.x !== 'number' || typeof p.y !== 'number') continue;
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
    }
    if (minX === Infinity) return true;
    // test AABB intersection
    if (maxX < bounds.minX || minX > bounds.maxX) return false;
    if (maxY < bounds.minY || minY > bounds.maxY) return false;
    return true;
}

let map, selectionLayer, startPoint, rect, isDrawing = false;
let buildings = [];
let scene, camera, renderer, controls;
let lastParsed = null;
let lastOrigin = null;
let lastBBox = null;
let lastGridSize = null;

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
        const weaponType = document.getElementById('weaponSelect').value;
        const weapon = WEAPONS[weaponType];
        weaponSim.simulateImpact(weapon, e.latlng.lat, e.latlng.lng);
        // persist impacts immediately so reload restores them
        try { saveAppState(); } catch (err) { }
    });

    // Right-click (contextmenu) shows detailed local damage/death estimate for clicked point
    map.on('contextmenu', async (e) => {
        try {
            const lat = e.latlng.lat, lon = e.latlng.lng;
            // small bbox around click: ~150m radius
            const meters = 150;
            const deltaLat = meters / 111000.0; // approx degrees
            const deltaLon = meters / (111000.0 * Math.cos(lat * Math.PI / 180));
            const bbox = [lat - deltaLat, lon - deltaLon, lat + deltaLat, lon + deltaLon];
            const popTotal = parseFloat(document.getElementById('popTotal') && document.getElementById('popTotal').value) || null;
            const popDensity = parseFloat(document.getElementById('popDensity') && document.getElementById('popDensity').value) || null;
            const mortalityRate = parseFloat(document.getElementById('mortalityRate') && document.getElementById('mortalityRate').value) || 0.01;
            const gridSize = parseInt(document.getElementById('choroplethGridSize') && document.getElementById('choroplethGridSize').value) || 10;
            const params = { bbox, popTotal, popDensity, mortalityRate, gridSize };
            const vizSel = document.getElementById('vizModeSelect');
            // only compute when user wants choropleth/heatmap
            if (vizSel && (vizSel.value === 'choropleth' || vizSel.value === 'heatmap')) {
                const dummyScenario = weaponSim.impacts && weaponSim.impacts.length ? weaponSim.impacts.map(i => ({ weapon: i.weapon, lat: i.position.lat, lon: i.position.lon })) : [];
                const cas = await weaponSim.estimateCasualtiesForScenario(dummyScenario, params);
                let html = `<div style="min-width:180px"><b>Location details</b><br/>`;
                html += `Total damage (local): ${Math.round(cas.totalDamage || 0)}u<br/>`;
                html += `Estimated deaths: ${Math.round(cas.estimatedDeaths || 0)}<br/>`;
                if (cas.perCell && cas.perCell.length) {
                    const top = cas.perCell.slice().sort((a, b) => (b.deaths || 0) - (a.deaths || 0)).slice(0, 3);
                    html += `<hr/><small>Top cells:</small><br/>`;
                    for (const t of top) html += `r${t.r},c${t.c}: ${Math.round(t.deaths || 0)}<br/>`;
                }
                html += `</div>`;
                L.popup().setLatLng(e.latlng).setContent(html).openOn(map);
            }
        } catch (err) { console.warn('detail popup error', err); }
    });

    // Run scenario button
    try {
        const runBtn = document.getElementById('runScenarioBtn');
        if (runBtn) runBtn.addEventListener('click', async () => {
            // determine bbox from drawn rectangle if present, else use current map bounds
            let bbox = null;
            if (rect && rect.getBounds) {
                const b = rect.getBounds();
                bbox = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()];
            } else {
                const b = map.getBounds();
                bbox = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()];
            }
            const weaponType = document.getElementById('weaponSelect').value;
            const count = Math.max(1, parseInt(document.getElementById('weaponCount').value || '1'));
            const distribution = document.getElementById('distributionSelect').value || 'grid';
            // generate scenario (this method implemented in weaponSimulation)
            try {
                const scenario = weaponSim.generateScenario({ bbox, weaponType, count, distribution });
                // estimate damage before applying visuals (fast)
                let summary = null;
                try { summary = weaponSim.estimateDamageForScenario(scenario); } catch (e) { summary = null; }
                // simulate scenario (visuals + building damage)
                weaponSim.simulateScenario(scenario);
                // apply visualization (heatmap/choropleth) if user selected
                try { applyVisualizationIfRequested(scenario, bbox); } catch (e) { console.warn('apply viz failed', e); }
                // compute casualties (if user provided params)
                const popTotal = parseFloat(document.getElementById('popTotal') && document.getElementById('popTotal').value) || null;
                const popDensity = parseFloat(document.getElementById('popDensity') && document.getElementById('popDensity').value) || null;
                const mortalityRate = parseFloat(document.getElementById('mortalityRate') && document.getElementById('mortalityRate').value) || 0.01;
                let casualties = null;
                try {
                    casualties = weaponSim.estimateCasualtiesForScenario(scenario, { bbox, popTotal, popDensity, mortalityRate });
                } catch (e) { casualties = null; }
                saveAppState();
                // show summary: totalDamage, top buildings and estimated deaths
                const summaryEl = document.getElementById('damageSummary');
                if (summary && typeof summary.totalDamage === 'number') {
                    const topArr = (summary.buildingDamages || []).slice(0, 3);
                    const top = topArr.map((b, i) => `${i + 1}. ${Math.round(b.damage)}u`).join('; ');
                    let txt = `Tổng thiệt hại: ${Math.round(summary.totalDamage)}u` + (top ? ` — Top: ${top}` : '');
                    if (casualties && typeof casualties.estimatedDeaths === 'number') txt += ` — Est deaths: ${Math.round(casualties.estimatedDeaths)}`;
                    showToast(`Triển khai ${scenario.length} vũ khí (${weaponType}) — Tổng thiệt hại ≈ ${Math.round(summary.totalDamage)}u.`);
                    if (summaryEl) summaryEl.textContent = txt;
                } else {
                    let txt = `Đã triển khai ${scenario.length} vũ khí (${weaponType})`;
                    if (casualties && typeof casualties.estimatedDeaths === 'number') txt += ` — Est deaths: ${Math.round(casualties.estimatedDeaths)}`;
                    showToast(txt);
                    if (summaryEl) summaryEl.textContent = (casualties && typeof casualties.estimatedDeaths === 'number') ? `Tổng thiệt hại: — — Est deaths: ${Math.round(casualties.estimatedDeaths)}` : `Tổng thiệt hại: —`;
                }
            } catch (e) {
                console.error('Failed to run scenario', e);
                showToast('Lỗi khi chạy giả lập', 'error');
            }
        });
    } catch (e) { }

    // clear impacts shortcut
    try {
        const clearBtn = document.getElementById('clearImpactsBtn') || document.getElementById('clearImpactsBtn');
        if (clearBtn) clearBtn.addEventListener('click', () => { weaponSim.clearImpacts(); saveAppState(); });
    } catch (e) { }
}

// Persist application state to localStorage
function saveAppState() {
    try {
        const key = 'maplook_state_v1';
        const state = { parsed: null, origin: null, bbox: null, impacts: [], camera: null, terrainInfo: null };
        if (lastParsed) state.parsed = lastParsed;
        if (lastOrigin) state.origin = lastOrigin;
        if (lastBBox) state.bbox = lastBBox;
        // persist terrain metadata so restore can rebuild terrain
        if (lastBBox) {
            state.terrainInfo = { bbox: lastBBox, gridSize: lastGridSize || 48, dataset: selectedDataset };
        }
        // persist full terrain grid if available so restore can avoid re-fetching elevations
        try {
            if (terrainGrid) {
                // deep-copy minimal serializable terrainGrid
                const tg = {
                    nx: terrainGrid.nx,
                    ny: terrainGrid.ny,
                    lats: terrainGrid.lats,
                    lons: terrainGrid.lons,
                    heights: terrainGrid.heights,
                    origin: terrainGrid.origin,
                    dx: terrainGrid.dx,
                    dy: terrainGrid.dy,
                    minX: terrainGrid.minX,
                    minY: terrainGrid.minY,
                    minH: terrainGrid.minH,
                    visualScale: terrainGrid.visualScale,
                    // include bbox and dataset meta so restore knows original params
                    bbox: lastBBox || null,
                    dataset: selectedDataset || null
                };
                state.terrainGrid = tg;
            }
        } catch (e) { }
        // save camera and controls target if available
        try {
            if (camera) {
                state.camera = { pos: camera.position.toArray(), target: controls ? [controls.target.x, controls.target.y, controls.target.z] : [0, 0, 0] };
            }
        } catch (e) { }
        // serialize impacts (weapon type, lat, lon)
        if (weaponSim && Array.isArray(weaponSim.impacts)) {
            for (const imp of weaponSim.impacts) {
                if (!imp || !imp.position) continue;
                const wt = imp.weapon && imp.weapon.type ? imp.weapon.type : (imp.weapon || '').toString();
                state.impacts.push({ weapon: wt, lat: imp.position.lat, lon: imp.position.lon });
            }
        }
        localStorage.setItem(key, JSON.stringify(state));
    } catch (e) { }
}

// Restore state from localStorage if present. Recreates 3D scene objects and impacts.
function loadAppState() {
    try {
        const key = 'maplook_state_v1';
        const txt = localStorage.getItem(key);
        if (!txt) return;
        const state = JSON.parse(txt);
        if (!state) return;

        // perform restore asynchronously so we can await terrain build
        async function restoreFromState(st) {
            try {
                if (!st.parsed) return;
                // NOTE: overlay is shown/hidden by the button event handlers (showOverlay/hideOverlay)
                // Do not manipulate the overlay DOM here so the UI feedback appears immediately
                // when the user clicks the Save/Load buttons.
                lastParsed = st.parsed;
                lastOrigin = st.origin || lastOrigin;
                lastBBox = st.bbox || lastBBox;

                // If a saved terrainGrid is present, restore directly from it (no API calls)
                if (st.terrainGrid) {
                    const ok = restoreTerrainFromGrid(st.terrainGrid);
                } else {
                    // If we have terrainInfo saved, rebuild terrain first (so buildings are placed correctly)
                    const tinfo = st.terrainInfo || (lastBBox ? { bbox: lastBBox, gridSize: 48, dataset: selectedDataset } : null);
                    if (tinfo && tinfo.bbox && typeof buildTerrainForBBox === 'function') {
                        try {
                            const prevDataset = selectedDataset;
                            if (tinfo.dataset) selectedDataset = tinfo.dataset;
                            await buildTerrainForBBox(tinfo.bbox, tinfo.gridSize || 48, (lastParsed && lastParsed.water) ? lastParsed.water : null);
                            selectedDataset = prevDataset;
                        } catch (e) { }
                    }
                }

                // add scene objects after terrain is available
                if (lastParsed.buildings && document.getElementById('cb_building') && document.getElementById('cb_building').checked) addBuildingsToScene(lastParsed.buildings);
                if (lastParsed.roads && document.getElementById('cb_road') && document.getElementById('cb_road').checked) addRoadsToScene(lastParsed.roads);
                if (lastParsed.parks && document.getElementById('cb_park') && document.getElementById('cb_park').checked) addParksToScene(lastParsed.parks);
                if (lastParsed.peaks && document.getElementById('cb_mountain') && document.getElementById('cb_mountain').checked) addPeaksToScene(lastParsed.peaks);
                if (lastParsed.hills && document.getElementById('cb_mountain') && document.getElementById('cb_mountain').checked) addHillsToScene(lastParsed.hills);
                if (lastParsed.forests && document.getElementById('cb_forest') && document.getElementById('cb_forest').checked) addForestsToScene(lastParsed.forests);
                if (lastParsed.trees && document.getElementById('cb_forest') && document.getElementById('cb_forest').checked) addTreesToScene(lastParsed.trees);
                if (lastParsed.ports && document.getElementById('cb_port') && document.getElementById('cb_port').checked) addPortsToScene(lastParsed.ports);
                if (lastParsed.infra) addInfraToScene(lastParsed.infra);

                // set weaponSim fields
                weaponSim.buildings = buildings;
                weaponSim.scene = scene;
                if (lastOrigin) weaponSim.origin = lastOrigin;

                // apply texture if already loaded
                if (typeof buildingTexture !== 'undefined' && buildingTexture) {
                    for (const b of buildings) {
                        try {
                            const t = buildingTexture.clone();
                            t.needsUpdate = true;
                            if (b && b.material) { b.material.map = t; b.material.needsUpdate = true; }
                        } catch (e) { }
                    }
                }

                // ensure lights exist
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
                } catch (e) { }

                // restore impacts after scene ready
                if (Array.isArray(st.impacts) && st.impacts.length) {
                    for (const imp of st.impacts) {
                        try {
                            const w = WEAPONS[imp.weapon] || WEAPONS.bomb;
                            weaponSim.simulateImpact(w, imp.lat, imp.lon);
                        } catch (e) { }
                    }
                }

                // if bbox was saved, draw selection rectangle and zoom to it
                try {
                    if (st.bbox && Array.isArray(st.bbox) && st.bbox.length === 4) {
                        // st.bbox is [south, west, north, east]
                        const [s, w, n, e] = st.bbox;
                        // remove existing rect if any
                        try { if (rect && rect.remove) rect.remove(); } catch (e) { }
                        const bounds = L.latLngBounds([s, w], [n, e]);
                        rect = L.rectangle(bounds, { color: '#f06', weight: 1 }).addTo(selectionLayer);
                        // set lastBBox and fit map
                        lastBBox = st.bbox;
                        try { map.fitBounds(bounds.pad ? bounds.pad(0.05) : bounds, { animate: true }); } catch (e) { map.fitBounds(bounds); }
                    }
                } catch (e) { }

                // restore camera if saved
                try {
                    if (st.camera && camera) {
                        camera.position.fromArray(st.camera.pos);
                        if (controls && st.camera.target) {
                            controls.target.set(st.camera.target[0], st.camera.target[1], st.camera.target[2]);
                            controls.update();
                        }
                    }
                } catch (e) { }

                // overlay hide is the responsibility of the caller (e.g. button handler)
            } catch (e) { }
        }

        // return the restore promise so callers can await completion
        return restoreFromState(state);
    } catch (e) { }
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

// Overlay helpers for save/load/restore messaging
function showOverlay(mainText, detailText) {
    try {
        const ov = document.getElementById('restoreOverlay');
        console.log(ov);

        if (!ov) return;
        const txt = document.getElementById('restoreOverlayText');
        const det = document.getElementById('restoreOverlayDetail');
        if (txt && mainText) txt.textContent = mainText;
        if (det && detailText) det.textContent = detailText || '';
        ov.classList.remove('hidden');
    } catch (e) { }
}

function hideOverlay() { try { const ov = document.getElementById('restoreOverlay'); if (ov) ov.classList.add('hidden'); } catch (e) { } }

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
    const selBounds = (lastBBox && lastOrigin) ? getLocalBoundsForBBox(lastBBox, lastOrigin) : null;
    for (const f of forestMeshes) {
        try { if (selBounds && f.pts && !ptsIntersectBounds(f.pts, selBounds)) continue; } catch (e) { }
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
    const selBounds = (lastBBox && lastOrigin) ? getLocalBoundsForBBox(lastBBox, lastOrigin) : null;
    const geom = new THREE.ConeGeometry(0.6, 2.0, 6);
    const mat = new THREE.MeshLambertMaterial({ color: 0x227722 });
    for (const t of treePoints) {
        try { if (selBounds && t.pos && (t.pos.x < selBounds.minX || t.pos.x > selBounds.maxX || t.pos.y < selBounds.minY || t.pos.y > selBounds.maxY)) continue; } catch (e) { }
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
    const selBounds = (lastBBox && lastOrigin) ? getLocalBoundsForBBox(lastBBox, lastOrigin) : null;
    for (const p of portMeshes) {
        try { if (selBounds && p.pts && !ptsIntersectBounds(p.pts, selBounds)) continue; } catch (e) { }
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
                        data = null;
                    } else {
                        data = await pres.json();
                    }
                }
            } catch (e) {
                data = null;
            }
            const keys = Object.keys(data || {});
            // if server returned an error status object, retry after a short backoff
            if (keys.length === 2 && keys.includes('error') && keys.includes('status')) {
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
        }

        // diagnostic: check for abrupt large jumps in this batch
        if (out.length >= expectedTotal) {
            let jumps = 0; let last = out[expectedTotal - batch.length];
            for (let k = expectedTotal - batch.length + 1; k < expectedTotal; k++) {
                const v = out[k]; if (Math.abs(v - last) > 1000) jumps++; last = v;
            }
        }
    }
    return out;
}

async function buildTerrainForBBox(bbox, gridSize = 64, waterMeshes = null) {
    // bbox = [south, west, north, east]
    const [s, w, n, e] = bbox;
    const nx = gridSize, ny = gridSize;
    try { lastBBox = bbox; lastGridSize = gridSize; } catch (e) { }
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

// Restore a terrain mesh directly from a saved terrainGrid object (no API calls)
function restoreTerrainFromGrid(tg) {
    try {
        if (!tg || !Array.isArray(tg.heights) || !tg.nx || !tg.ny) return false;
        const nx = tg.nx, ny = tg.ny;
        const lats = tg.lats, lons = tg.lons, heights = tg.heights;
        const origin = tg.origin || { lat: (lats[0] + lats[ny - 1]) / 2, lon: (lons[0] + lons[nx - 1]) / 2 };
        const minH = (typeof tg.minH === 'number') ? tg.minH : (function () { let m = Infinity; for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (typeof heights[j][i] === 'number' && heights[j][i] < m) m = heights[j][i]; return (m === Infinity ? 0 : m); })();
        const visualScale = tg.visualScale || VERT_SCALE;

        // compute xy grid
        const xyGrid = new Array(ny);
        for (let j = 0; j < ny; j++) { xyGrid[j] = new Array(nx); for (let i = 0; i < nx; i++) { const pxy = latLonToMeters(lats[j], lons[i], origin); xyGrid[j][i] = { x: pxy.x, y: pxy.y }; } }

        // compute min/max and grid spacing
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const p = xyGrid[j][i]; if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y; if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y; }
        const p00 = xyGrid[0][0]; const p10 = xyGrid[0][Math.min(1, nx - 1)]; const p01 = xyGrid[Math.min(1, ny - 1)][0];
        const gridDx = Math.abs(p10.x - p00.x) || (tg.dx || 1);
        const gridDy = Math.abs(p01.y - p00.y) || (tg.dy || 1);

        // build positions/colors
        const positions = new Float32Array(nx * ny * 3);
        const colors = new Float32Array(nx * ny * 3);
        let pi = 0, cpi = 0;
        for (let j = 0; j < ny; j++) {
            for (let i = 0; i < nx; i++) {
                const p = xyGrid[j][i];
                const h = (heights[j] && typeof heights[j][i] === 'number') ? heights[j][i] : minH;
                positions[pi++] = p.x; positions[pi++] = p.y; positions[pi++] = (h - minH) * visualScale;
                // simple color mapping
                const t = Math.max(0, Math.min(1, (h + 50) / 1000));
                const r = 0.2 + 0.6 * t; const g = 0.6 * (1 - t) + 0.3 * t; const b = 0.2;
                colors[cpi++] = r; colors[cpi++] = g; colors[cpi++] = b;
            }
        }

        // index buffer
        const indices = [];
        for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
            const a = j * nx + i; const b = j * nx + (i + 1); const c = (j + 1) * nx + i; const d = (j + 1) * nx + (i + 1);
            indices.push(a, c, b); indices.push(b, c, d);
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
        return true;
    } catch (e) { }
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

    // building textures intentionally disabled; buildings use solid colors

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

    // compute bounds for selection area (if available)
    const selBounds = (lastBBox && lastOrigin) ? getLocalBoundsForBBox(lastBBox, lastOrigin) : null;

    // palette of pleasant building colors
    const palette = [0xd9e2ec, 0xc9d6e3, 0xf2d7d5, 0xe6e2c8, 0xdbe7d6, 0xe6d6f0, 0xf0e0c8];
    let bidx = 0;
    for (const m of meshes) {
        // if selection bounds exist, skip meshes completely outside selection
        try { if (selBounds && m.pts && !ptsIntersectBounds(m.pts, selBounds)) continue; } catch (e) { }
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
        // compute footprint approximate area to pick a deterministic color
        let approxArea = 0;
        try {
            const ptsForArea = m.pts || [];
            let a = 0;
            for (let i = 0, l = ptsForArea.length; i < l; i++) {
                const A = ptsForArea[i], B = ptsForArea[(i + 1) % l];
                a += (A.x * B.y) - (B.x * A.y);
            }
            approxArea = Math.abs(a) * 0.5;
        } catch (e) { approxArea = bidx; }
        const colorIdx = Math.abs(Math.round(approxArea || bidx)) % palette.length;
        const colorHex = palette[colorIdx];
        const mat = new THREE.MeshLambertMaterial({ color: colorHex });
        const mesh = new THREE.Mesh(extrude, mat);
        // If extrude geometry modification failed, fall back to centroid-based placement
        if (!extrude.attributes || !extrude.attributes.position) {
            const centroidX = m.pts.reduce((s, p) => s + p.x, 0) / Math.max(1, m.pts.length);
            const centroidY = m.pts.reduce((s, p) => s + p.y, 0) / Math.max(1, m.pts.length);
            const baseHeight = (typeof getTerrainHeightAt === 'function') ? getTerrainHeightAt(centroidX, centroidY) : 0;
            mesh.position.z = baseHeight;
        }
        scene.add(mesh);
        // attach footprint points and tags for population allocation
        try {
            mesh.userData.footprint = m.pts.map(p => ({ x: p.x, y: p.y }));
            // compute polygon area (shoelace) in local meters
            let area = 0;
            const pts = mesh.userData.footprint;
            for (let i = 0, l = pts.length; i < l; i++) {
                const a = pts[i], b = pts[(i + 1) % l];
                area += (a.x * b.y) - (b.x * a.y);
            }
            area = Math.abs(area) * 0.5;
            mesh.userData.footprintArea = area; // m^2
            mesh.userData.tags = m.tags || {};
        } catch (e) { mesh.userData.footprintArea = 0; mesh.userData.tags = m.tags || {}; }
    buildings.push(mesh);
    bidx++;
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
    const selBounds = (lastBBox && lastOrigin) ? getLocalBoundsForBBox(lastBBox, lastOrigin) : null;
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
        try { if (selBounds && !ptsIntersectBounds(r.pts, selBounds)) continue; } catch (e) { }
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
    const selBounds = (lastBBox && lastOrigin) ? getLocalBoundsForBBox(lastBBox, lastOrigin) : null;
    for (const w of waterMeshes) {
        try { if (selBounds && w.pts && !ptsIntersectBounds(w.pts, selBounds)) continue; } catch (e) { }
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
    const selBounds = (lastBBox && lastOrigin) ? getLocalBoundsForBBox(lastBBox, lastOrigin) : null;
    for (const h of hillMeshes) {
        try { if (selBounds && h.pts && !ptsIntersectBounds(h.pts, selBounds)) continue; } catch (e) { }
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
    const selBounds = (lastBBox && lastOrigin) ? getLocalBoundsForBBox(lastBBox, lastOrigin) : null;
    for (const p of parkMeshes) {
        try { if (selBounds && p.pts && !ptsIntersectBounds(p.pts, selBounds)) continue; } catch (e) { }
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
    const selBounds = (lastBBox && lastOrigin) ? getLocalBoundsForBBox(lastBBox, lastOrigin) : null;
    for (const p of points) {
        try { if (selBounds && p.pos && (p.pos.x < selBounds.minX || p.pos.x > selBounds.maxX || p.pos.y < selBounds.minY || p.pos.y > selBounds.maxY)) continue; } catch (e) { }
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

    const selBounds = (lastBBox && lastOrigin) ? getLocalBoundsForBBox(lastBBox, lastOrigin) : null;
    if (infra.hospitals) {
        for (const h of infra.hospitals) {
            try { if (selBounds && h.pos && (h.pos.x < selBounds.minX || h.pos.x > selBounds.maxX || h.pos.y < selBounds.minY || h.pos.y > selBounds.maxY)) continue; } catch (e) { }
            if (h.pos) {
                const m = new THREE.Mesh(sphereGeom, hospitalMat);
                const hh = getTerrainHeightAt(h.pos.x, h.pos.y) || 0;
                m.position.set(h.pos.x, h.pos.y, hh + 2);
                m.userData = { type: 'hospital', tags: h.tags };
                addRecorded(m);
                // labels removed by user request
            } else if (h.pts && h.pts.length) {
                try { if (selBounds && !ptsIntersectBounds(h.pts, selBounds)) continue; } catch (e) { }
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

// building textures removed - use per-building colors only

// Wire UI
initMap();
let weaponSim = new WeaponSimulation(map);
initThree();
// populate dataset selector once DOM/UI is ready
loadOpenTopoDatasets();

document.getElementById('scanBtn').addEventListener('click', async () => {
    if (!rect) { showToast('Vui lòng chọn vùng trên bản đồ bằng cách nhấp-drag.', 'error'); return; }
    showOverlay('Đang tải dữ liệu OSM...', 'Gọi Overpass API để lấy tòa nhà và hạ tầng');
    const b = rect.getBounds();
    const bbox = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()];
    const center = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
    try {
        const osm = await fetchOSM(bbox);
        const parsed = parseOSM(osm, center);
        // persist parsed data for session restore
        lastParsed = parsed;
        lastOrigin = { lat: center[0], lon: center[1] };
        // build terrain after parsing so we can merge water into terrain
        try {
            await buildTerrainForBBox(bbox, 48, parsed.water);
        } catch (terrErr) {
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
        showToast('Lỗi khi lấy dữ liệu OSM', 'error');
    } finally {
        hideOverlay();
    }
});

// Heatmap / Choropleth support
let heatLayer = null;
let choroplethLayer = null;
function clearVizLayers() {
    try { if (heatLayer) { map.removeLayer(heatLayer); heatLayer = null; } } catch (e) { }
    try { if (choroplethLayer) { map.removeLayer(choroplethLayer); choroplethLayer = null; } } catch (e) { }
}

function buildHeatmapFromScenario(scenario) {
    // Leaflet.heat expects array of [lat, lon, intensity]
    const points = [];
    for (const s of scenario) {
        // intensity use weapon power (normalized) — here we use power directly
        const lat = s.lat, lon = s.lon;
        const intensity = (s.weapon && s.weapon.power) ? s.weapon.power : 1;
        points.push([lat, lon, Math.max(0.1, intensity / 50)]);
    }
    clearVizLayers();
    try {
        heatLayer = L.heatLayer(points, { radius: 25, blur: 15, maxZoom: 17 }).addTo(map);
    } catch (e) {
        console.warn('Failed to create heatLayer', e);
    }
}

function buildChoroplethFromScenario(scenario, bbox, gridSize = 10, casualtiesGrid = null) {
    // bbox = [south, west, north, east]
    const [s, w, n, e] = bbox;
    // create grid cells (gridSize x gridSize)
    const rows = gridSize, cols = gridSize;
    const cellWidth = (e - w) / cols, cellHeight = (n - s) / rows;
    // aggregate damage per cell by sampling impacts
    const cellValues = new Array(rows);
    for (let r = 0; r < rows; r++) {
        cellValues[r] = new Array(cols).fill(0);
    }
    const origin = weaponSim.origin || { lat: (s + n) / 2, lon: (w + e) / 2 };
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const cellLat = s + (r + 0.5) * cellHeight;
            const cellLon = w + (c + 0.5) * cellWidth;
            // compute damage contribution from each impact to this cell center
            let val = 0;
            for (const imp of scenario) {
                const impPos = latLonToMeters(imp.lat, imp.lon, origin);
                const cellPos = latLonToMeters(cellLat, cellLon, origin);
                const dist = Math.hypot(impPos.x - cellPos.x, impPos.y - cellPos.y);
                val += imp.weapon.calculateDamage(dist);
            }
            cellValues[r][c] = val;
        }
    }
    // determine color scale
    let maxV = 0; for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (cellValues[r][c] > maxV) maxV = cellValues[r][c];
    if (!isFinite(maxV) || maxV <= 0) maxV = 1;
    // build layer group
    clearVizLayers();
    choroplethLayer = L.layerGroup();
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const cellS = s + r * cellHeight;
            const cellW = w + c * cellWidth;
            const cellN = cellS + cellHeight;
            const cellE = cellW + cellWidth;
            const val = cellValues[r][c];
            const t = Math.min(1, val / maxV);
            // color ramp: green -> yellow -> red
            const col = t < 0.5 ? interpolateColor([0, 128, 0], [255, 200, 0], t * 2) : interpolateColor([255, 200, 0], [200, 20, 20], (t - 0.5) * 2);
            const hex = rgbToHex(col[0], col[1], col[2]);
            const deathVal = casualtiesGrid && casualtiesGrid[r] && typeof casualtiesGrid[r][c] === 'number' ? casualtiesGrid[r][c] : null;
            const popupTxt = deathVal !== null ? `Damage: ${val.toFixed(1)}<br/>Est deaths: ${Math.round(deathVal)}` : `Damage: ${val.toFixed(1)}`;
            const rect = L.rectangle([[cellS, cellW], [cellN, cellE]], { color: hex, weight: 0, fillOpacity: 0.45 }).bindPopup(popupTxt);
            rect.addTo(choroplethLayer);
        }
    }
    choroplethLayer.addTo(map);
    // render legend for damage
    try { renderLegend(maxV, 'Damage (u)'); } catch (e) { }
}

function interpolateColor(a, b, t) { return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)]; }
function rgbToHex(r, g, b) { return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`; }

// Render a simple legend into #vizLegend showing color ramp for 0..maxValue
function renderLegend(maxValue, label) {
    try {
        const el = document.getElementById('vizLegend');
        if (!el) return;
        const maxV = (typeof maxValue === 'number' && isFinite(maxValue) && maxValue > 0) ? maxValue : 1;
        const stops = [0, 0.25, 0.5, 0.75, 1.0];
        let html = `<div style="font-size:12px"><strong>${label || 'Legend'}</strong></div><div style="display:flex;align-items:center;margin-top:6px">`;
        for (const s of stops) {
            const col = s < 0.5 ? interpolateColor([0, 128, 0], [255, 200, 0], s * 2) : interpolateColor([255, 200, 0], [200, 20, 20], (s - 0.5) * 2);
            const hex = rgbToHex(col[0], col[1], col[2]);
            html += `<div style="width:28px;height:14px;background:${hex};margin-right:4px;border:1px solid #222"></div>`;
        }
        html += `</div><div style="font-size:11px;margin-top:4px;display:flex;justify-content:space-between;max-width:170px"><span>0</span><span>${Math.round(maxV / 2)}</span><span>${Math.round(maxV)}</span></div>`;
        el.innerHTML = html;
    } catch (e) { console.warn('renderLegend failed', e); }
}

// update viz when user changes mode
try {
    const vizSel = document.getElementById('vizModeSelect');
    if (vizSel) vizSel.addEventListener('change', () => {
        // simply clear existing layers; if there is a last scenario we can re-create viz
        clearVizLayers();
    });
} catch (e) { }

// After running a scenario, build selected visualization
function applyVisualizationIfRequested(scenario, bbox) {
    try {
        const vizSel = document.getElementById('vizModeSelect');
        if (!vizSel) return;
        const mode = vizSel.value;
        if (mode === 'heatmap') buildHeatmapFromScenario(scenario);
        else if (mode === 'choropleth') {
            // compute casualties grid from UI params
            const popTotal = parseFloat(document.getElementById('popTotal') && document.getElementById('popTotal').value) || null;
            const popDensity = parseFloat(document.getElementById('popDensity') && document.getElementById('popDensity').value) || null;
            const mortalityRate = parseFloat(document.getElementById('mortalityRate') && document.getElementById('mortalityRate').value) || 0.01;
            const params = { bbox: bbox || mapBoundsToBBox(), popTotal: popTotal, popDensity: popDensity, mortalityRate: mortalityRate };
            let cas = null;
            try { cas = weaponSim.estimateCasualtiesForScenario(scenario, params); } catch (e) { cas = null; }
            let casualtiesGrid = null;
            if (cas && Array.isArray(cas.perCell) && cas.perCell.length) {
                // convert flat perCell into 2D grid matching grid size used in buildChoropleth
                const gridSize = parseInt(document.getElementById('choroplethGridSize') && document.getElementById('choroplethGridSize').value) || 10;
                casualtiesGrid = new Array(gridSize);
                for (let r = 0; r < gridSize; r++) casualtiesGrid[r] = new Array(gridSize).fill(0);
                for (const p of cas.perCell) {
                    if (p.r >= 0 && p.c >= 0 && p.r < gridSize && p.c < gridSize) casualtiesGrid[p.r][p.c] = p.deaths;
                }
                // update damageSummary with deaths
                const summaryEl = document.getElementById('damageSummary');
                if (summaryEl) summaryEl.textContent = `Tổng thiệt hại: ${Math.round(cas.totalDamage)}u — Est deaths: ${Math.round(cas.estimatedDeaths)}`;
            }
            buildChoroplethFromScenario(scenario, bbox || mapBoundsToBBox(), gridSize, casualtiesGrid);
        }
        else clearVizLayers();
    } catch (e) { console.warn('viz error', e); }
}

function mapBoundsToBBox() {
    const b = map.getBounds(); return [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()];
}

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

// Panel toggle helpers
function togglePanel(buttonId, bodyId) {
    const btn = document.getElementById(buttonId);
    const body = document.getElementById(bodyId);
    if (!btn || !body) return;
    // prefer an explicit panel container: try known IDs then fallback to closest ancestor
    let panel = document.getElementById('leftPanel') || document.getElementById('weaponPanel') || body.closest('[id$="Panel"]') || body.parentElement;
    // if button is inside a header, find its nearest panel ancestor instead
    try {
        const bAncestor = btn.closest('[id$="Panel"]');
        if (bAncestor) panel = bAncestor;
    } catch (e) { }

    btn.addEventListener('click', () => {
        const closed = body.classList.toggle('hidden');
        try { if (panel) panel.classList.toggle('collapsed', closed); } catch (e) { }
        // update button glyph consistently
        btn.textContent = closed ? '▸' : '▾';
        // ensure focus and accessibility
        try { btn.setAttribute('aria-expanded', String(!closed)); } catch (e) { }
    });
}

// initialize panel toggles (left and weapon panels)
togglePanel('leftPanelToggle', 'leftPanelBody');
togglePanel('weaponPanelToggle', 'weaponPanelBody');

// Simple toast helper
function showToast(message, type = 'info', duration = 3000) {
    try {
        const container = document.getElementById('toastContainer');
        if (!container) {
            return;
        }
        const toast = document.createElement('div');
        toast.className = 'max-w-xs w-full pointer-events-auto rounded px-3 py-2 text-sm shadow-lg flex items-center space-x-2';
        let bg = 'bg-gray-800 text-white';
        if (type === 'success') bg = 'bg-green-600 text-white';
        if (type === 'error') bg = 'bg-red-600 text-white';
        if (type === 'info') bg = 'bg-blue-600 text-white';
        toast.className += ' ' + bg;
        toast.style.opacity = '0';
        toast.style.transition = 'transform 200ms ease, opacity 200ms ease';
        toast.style.transform = 'translateY(-6px)';

        const text = document.createElement('div');
        text.textContent = message;
        toast.appendChild(text);

        container.appendChild(toast);

        // animate in
        requestAnimationFrame(() => {
            toast.style.opacity = '1';
            toast.style.transform = 'translateY(0)';
        });

        const timeout = setTimeout(() => {
            // animate out
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(-6px)';
            setTimeout(() => { container.removeChild(toast); }, 220);
        }, duration);

        // allow click to dismiss early
        toast.addEventListener('click', () => {
            clearTimeout(timeout);
            try { toast.remove(); } catch (e) { }
        });
    } catch (e) {
        try { alert(message); } catch (e2) { }
    }
}

// --- Image upload -> heightmap prototype (client-side)
// Generate a plane mesh from an image by converting brightness to heights.
async function generateMeshFromImage(imgElement, options = {}) {
    // options: sizeMeters (width in meters), resolution (pixels across), heightScale
    const sizeMeters = options.sizeMeters || 200; // world size to map image to
    const resolution = options.resolution || 128; // sample resolution
    const heightScale = (typeof options.heightScale === 'number') ? options.heightScale : 20;

    // create an offscreen canvas and draw resized image
    const canvas = document.createElement('canvas');
    canvas.width = resolution; canvas.height = resolution;
    const ctx = canvas.getContext('2d');
    // draw image covering canvas
    ctx.drawImage(imgElement, 0, 0, canvas.width, canvas.height);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

    // compute brightness map (0..1)
    const heights = new Float32Array(resolution * resolution);
    for (let y = 0; y < resolution; y++) {
        for (let x = 0; x < resolution; x++) {
            const idx = (y * resolution + x) * 4;
            const r = data[idx], g = data[idx + 1], b = data[idx + 2];
            // luminance approximation
            const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255.0;
            // invert brightness so bright -> high (assumption) — adjust if needed
            const v = lum;
            heights[y * resolution + x] = v;
        }
    }

    // build plane geometry: resolution x resolution vertices
    const nx = resolution, ny = resolution;
    const positions = new Float32Array(nx * ny * 3);
    const uvs = new Float32Array(nx * ny * 2);
    let pi = 0, ui = 0;
    const half = sizeMeters / 2;
    for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
            const px = (i / (nx - 1)) * sizeMeters - half;
            const py = (j / (ny - 1)) * sizeMeters - half;
            const h = heights[j * nx + i] * heightScale;
            positions[pi++] = px; positions[pi++] = py; positions[pi++] = h;
            uvs[ui++] = i / (nx - 1); uvs[ui++] = j / (ny - 1);
        }
    }
    const indices = [];
    for (let j = 0; j < ny - 1; j++) {
        for (let i = 0; i < nx - 1; i++) {
            const a = j * nx + i;
            const b = j * nx + (i + 1);
            const c = (j + 1) * nx + i;
            const d = (j + 1) * nx + (i + 1);
            indices.push(a, c, b);
            indices.push(b, c, d);
        }
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geom.setIndex(indices);
    geom.computeVertexNormals();

    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    const mat = new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.9 });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = 'imageHeightmapMesh';

    return mesh;
}

// Wire upload UI handlers
try {
    const imageUpload = document.getElementById('imageUpload');
    const uploadPreviewBtn = document.getElementById('uploadPreviewBtn');
    const generate3DBtn = document.getElementById('generate3DBtn');
    const previewContainer = document.getElementById('uploadPreviewContainer');
    const previewImg = document.getElementById('uploadPreviewImg');

    let lastLoadedImage = null;

    if (imageUpload) imageUpload.addEventListener('change', (ev) => {
        const f = ev.target.files && ev.target.files[0];
        if (!f) return;
        const url = URL.createObjectURL(f);
        previewImg.src = url;
        previewContainer.classList.remove('hidden');
        lastLoadedImage = new Image();
        lastLoadedImage.crossOrigin = 'Anonymous';
        lastLoadedImage.onload = () => {
            // ready
        };
        lastLoadedImage.src = url;
    });

    if (uploadPreviewBtn) uploadPreviewBtn.addEventListener('click', () => {
        if (!previewImg.src) { showToast('Vui lòng chọn file ảnh trước', 'error'); return; }
        previewContainer.classList.remove('hidden');
    });

    if (generate3DBtn) generate3DBtn.addEventListener('click', async () => {
        if (!lastLoadedImage) { showToast('Vui lòng chọn file ảnh trước', 'error'); return; }
        showOverlay('Đang dựng 3D từ ảnh...', 'Mô phỏng heightmap từ độ sáng ảnh');
        try {
            const mesh = await generateMeshFromImage(lastLoadedImage, { sizeMeters: 200, resolution: 128, heightScale: 30 });
            // remove existing imageHeightmapMesh if present
            try { const old = scene.getObjectByName('imageHeightmapMesh'); if (old) scene.remove(old); } catch (e) { }
            // place mesh at reasonable height relative to terrain (add on top)
            mesh.position.z = 0; // user can adjust camera
            scene.add(mesh);
            // focus camera on mesh
            try {
                const box = new THREE.Box3().setFromObject(mesh);
                const center = box.getCenter(new THREE.Vector3());
                controls.target.copy(center);
                camera.position.set(center.x, center.y - 200, center.z + 150);
                controls.update();
            } catch (e) { }
            showToast('Mô hình 3D đã được tạo (prototype).', 'success');
        } catch (err) {
            console.error('generate image mesh failed', err);
            showToast('Lỗi khi dựng 3D', 'error');
        } finally {
            hideOverlay();
        }
    });
} catch (e) { console.warn('upload UI wiring failed', e); }

// --- Server-side helpers for Option B
async function uploadImageToServer(file) {
    const form = new FormData();
    form.append('image', file, file.name);
    const res = await fetch('http://127.0.0.1:3000/upload-image', { method: 'POST', body: form });
    if (!res.ok) throw new Error('Upload failed');
    return await res.json();
}

// Request depth/3D generation from server. The server will forward to DEPTH_MODEL_URL if configured
async function requestDepthFromServer(filenameOrFile) {
    const form = new FormData();
    if (typeof filenameOrFile === 'string') form.append('filename', filenameOrFile);
    else form.append('image', filenameOrFile, filenameOrFile.name);
    const res = await fetch('http://127.0.0.1:3000/depth', { method: 'POST', body: form });
    if (!res.ok) {
        const txt = await res.json().catch(() => null);
        throw new Error(txt && txt.error ? txt.error : 'Depth request failed');
    }
    // Try parse JSON
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return await res.json();
    // otherwise return blob (binary mesh or image) as blob
    const buf = await res.arrayBuffer();
    return { binary: buf, contentType: ct };
}

try {
    const runServerDepthBtn = document.getElementById('runServerDepthBtn');
    const useServerDepth = document.getElementById('useServerDepth');
    if (runServerDepthBtn) runServerDepthBtn.addEventListener('click', async () => {
        if (!imageUpload || !imageUpload.files || !imageUpload.files[0]) { showToast('Vui lòng chọn file ảnh trước', 'error'); return; }
        const file = imageUpload.files[0];
        showOverlay('Đang gửi ảnh lên server...', 'Upload');
        try {
            const up = await uploadImageToServer(file);
            showToast('Ảnh đã upload: ' + up.filename, 'success');
            // request depth using filename reference
            showOverlay('Đang yêu cầu model depth...', 'Đợi phản hồi từ server/model');
            const resp = await requestDepthFromServer(up.filename);
            // resp can be { ok:true, modelResponse: {...} } or binary
            if (resp && resp.modelResponse) {
                // if modelResponse contains a URL to depth map or mesh, attempt to fetch and render
                const mr = resp.modelResponse;
                if (mr.depth_map_url) {
                    // fetch image and render as heightmap
                    const dimg = new Image();
                    dimg.crossOrigin = 'Anonymous';
                    dimg.src = mr.depth_map_url;
                    dimg.onload = async () => {
                        try { const mesh = await generateMeshFromImage(dimg, { sizeMeters: 200, resolution: 128, heightScale: 30 });
                            try { const old = scene.getObjectByName('imageHeightmapMesh'); if (old) scene.remove(old); } catch (e) { }
                            scene.add(mesh);
                            showToast('Depth map rendered as mesh', 'success');
                        } catch (e) { showToast('Failed to render depth map', 'error'); }
                    };
                } else if (mr.mesh_url) {
                    showToast('Model generated: ' + mr.mesh_url, 'info');
                    // TODO: fetch mesh and import (needs glTF loader). For now just notify.
                } else {
                    showToast('Model response received (no depth URL)', 'info');
                    console.log('modelResponse', mr);
                }
            } else if (resp && resp.binary) {
                // attempt to treat binary as image (depth map) first
                try {
                    const blob = new Blob([resp.binary], { type: resp.contentType || 'application/octet-stream' });
                    const url = URL.createObjectURL(blob);
                    const dimg = new Image(); dimg.crossOrigin = 'Anonymous'; dimg.src = url;
                    dimg.onload = async () => {
                        try { const mesh = await generateMeshFromImage(dimg, { sizeMeters: 200, resolution: 128, heightScale: 30 });
                            try { const old = scene.getObjectByName('imageHeightmapMesh'); if (old) scene.remove(old); } catch (e) { }
                            scene.add(mesh);
                            showToast('Binary depth rendered as mesh', 'success');
                        } catch (e) { showToast('Failed to render binary depth', 'error'); }
                    };
                } catch (e) { showToast('Received binary response from server (not handled)', 'info'); }
            }
        } catch (err) {
            console.error('server depth failed', err);
            showToast('Yêu cầu server thất bại: ' + String(err), 'error');
        } finally { hideOverlay(); }
    });
} catch (e) { console.warn('server depth wiring failed', e); }

// Session buttons added to UI
const saveSessionBtn = document.getElementById('saveSessionBtn');
const loadSessionBtn = document.getElementById('loadSessionBtn');
const clearSessionBtn = document.getElementById('clearSessionBtn');
if (saveSessionBtn) saveSessionBtn.addEventListener('click', () => {
    showOverlay('Đang lưu phiên...', 'Đang ghi trạng thái vào bộ nhớ cục bộ');
    try {
        saveAppState();
        showToast('Phiên đã được lưu.', 'success');
    } catch (e) {
        showToast('Lỗi khi lưu phiên', 'error');
    } finally {
        hideOverlay();
    }
});
if (loadSessionBtn) loadSessionBtn.addEventListener('click', () => {
    showOverlay('Đang phục hồi phiên...', 'Khôi phục dữ liệu bản đồ và vật thể 3D');
    setTimeout(() => {
        try {
            loadAppState();
        } catch (e) { }
        finally {
            hideOverlay();
        }
    }, 100);
});
if (clearSessionBtn) clearSessionBtn.addEventListener('click', () => {
    localStorage.clear();
    // also clear current scene objects
    try { weaponSim.clearImpacts(); } catch (e) { }
    try { for (const b of buildings) scene.remove(b); buildings = []; } catch (e) { }
    // remove terrain from scene and clear terrainGrid
    try { if (terrain) { scene.remove(terrain); terrain = null; } terrainGrid = null; lastBBox = null; lastGridSize = null; } catch (e) { }
    showToast('Phiên đã bị xóa.', 'success');
});

export { };
