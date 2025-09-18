// Weapon Simulation Module
// Simulates the impact of military weapons on a map or 3D environment

// Simple helper: convert lat/lon to local meters using equirectangular approx
function latLonToMeters(lat, lon, origin) {
    const R = 6378137; // Earth radius
    const dLat = (lat - origin.lat) * Math.PI / 180;
    const dLon = (lon - origin.lon) * Math.PI / 180;
    const x = R * dLon * Math.cos(origin.lat * Math.PI / 180);
    const y = R * dLat;
    return { x, y };
}

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.154.0/build/three.module.js';

export class Weapon {
    constructor(type, power, radius) {
        this.type = type; // e.g., 'bomb', 'missile', 'artillery'
        this.power = power; // arbitrary power unit
        this.radius = radius; // blast radius in meters
    }

    // Calculate damage at a given distance from impact point
    calculateDamage(distance) {
        if (distance > this.radius) return 0;
        // Simple inverse square law approximation
        return this.power / (1 + distance * distance);
    }

    // Get impact zone as a circle
    getImpactZone(centerLat, centerLon, map) {
        // Create a Leaflet circle for visualization
        return L.circle([centerLat, centerLon], {
            color: 'red',
            fillColor: '#f03',
            fillOpacity: 0.5,
            radius: this.radius
        });
    }
}

export class WeaponSimulation {
    constructor(map, buildings = [], scene = null, origin = null) {
        this.map = map;
        this.buildings = buildings;
        this.scene = scene;
        this.origin = origin || { lat: 21.028511, lon: 105.804817 }; // Default fallback
        this.weapons = [];
        this.impacts = [];
    }

    addWeapon(weapon) {
        this.weapons.push(weapon);
    }

    simulateImpact(weapon, lat, lon) {
        const impact = {
            weapon: weapon,
            position: { lat, lon },
            zone: weapon.getImpactZone(lat, lon, this.map)
        };
        this.impacts.push(impact);
        impact.zone.addTo(this.map);

        // Apply 3D effects to affected buildings
        this.apply3DEffects(weapon, lat, lon);

        // Create visual explosion effects (2D ripple + initial 3D burst)
        this.createExplosionVisuals(weapon, lat, lon);

        return impact;
    }

    // Create visuals for explosion: Leaflet ripple + Three.js glow/light/particles
    createExplosionVisuals(weapon, lat, lon) {
        // 2D Leaflet ripple: expanding circle that fades
        try {
            if (this.map) {
                const center = [lat, lon];
                const maxR = weapon.radius;
                const ripple = L.circle(center, { radius: 0, color: '#ff5500', weight: 2, fill: false, opacity: 0.9 }).addTo(this.map);
                const start = performance.now();
                const life = 900; // ms
                this.impacts[this.impacts.length - 1].ripple = { ripple, start, life, maxR };
            }
        } catch (e) { /* Leaflet may not be present in some contexts */ }

        // 3D visuals: expanding emissive sphere + short-lived point light + quick particles
        if (!this.scene) return;
        try {
            if (!this.scene.userData.explosions) this.scene.userData.explosions = [];
            // compute impact position in world meters
            const pos = latLonToMeters(lat, lon, this.origin);
            // glow sphere
            const geom = new THREE.SphereGeometry(1, 16, 12);
            const mat = new THREE.MeshBasicMaterial({ color: 0xffaa33, transparent: true, opacity: 0.9, depthWrite: false });
            const glow = new THREE.Mesh(geom, mat);
            glow.position.set(pos.x, pos.y, (getTerrainHeightAt ? getTerrainHeightAt(pos.x, pos.y) : 0) + 2);
            glow.scale.set(0.01, 0.01, 0.01);
            this.scene.add(glow);

            // light flash
            const light = new THREE.PointLight(0xffcc88, 2.5, weapon.radius * 1.5);
            light.position.copy(glow.position);
            this.scene.add(light);

            // simple particle sprites (small triangles using Points)
            const particlesGeo = new THREE.BufferGeometry();
            const count = Math.min(64, Math.round(weapon.radius / 2));
            const positions = new Float32Array(count * 3);
            const velocities = [];
            for (let i = 0; i < count; i++) {
                const theta = Math.random() * Math.PI * 2;
                const r = 0.1 + Math.random() * 0.5;
                positions[i * 3 + 0] = pos.x + Math.cos(theta) * r;
                positions[i * 3 + 1] = pos.y + Math.sin(theta) * r;
                positions[i * 3 + 2] = glow.position.z + (Math.random() - 0.5) * 0.5;
                velocities.push({ x: Math.cos(theta) * (0.5 + Math.random() * 2), y: Math.sin(theta) * (0.5 + Math.random() * 2), z: -0.2 + Math.random() * 0.4 });
            }
            particlesGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            const partMat = new THREE.PointsMaterial({ color: 0xffcc66, size: 0.3, transparent: true, opacity: 0.95 });
            const particles = new THREE.Points(particlesGeo, partMat);
            this.scene.add(particles);

            this.scene.userData.explosions.push({ glow, light, particles, velocities, age: 0, life: 1.2, maxScale: Math.max(weapon.radius * 0.02, 0.2) });
        } catch (e) {
            console.warn('Failed creating 3D explosion visuals', e);
        }
    }

    apply3DEffects(weapon, lat, lon) {
        if (!this.scene || !this.buildings.length) {
            console.log('No scene or buildings:', this.scene, this.buildings.length);
            return;
        }

        // Convert impact position to 3D coordinates
        const impactPos = latLonToMeters(lat, lon, this.origin);

        let affectedCount = 0;
        this.buildings.forEach((building, index) => {
            if (!building || !building.geometry) return;

            // Get building's actual position from geometry bounding box
            const bbox = building.geometry.boundingBox;
            if (!bbox) {
                console.log('Building', index, 'has no bounding box');
                return;
            }

            // Try a more robust test than centroid-only: check polygon footprint vs impact circle.
            // Build a list of base vertices (those near the geometry min Z) and compute convex hull.
            try {
                const posAttr = building.geometry.attributes && building.geometry.attributes.position;
                const verts = [];
                if (posAttr) {
                    const minZ = bbox.min.z;
                    const eps = 1e-3;
                    for (let vi = 0; vi < posAttr.count; vi++) {
                        const vx = posAttr.getX(vi), vy = posAttr.getY(vi), vz = posAttr.getZ(vi);
                        // pick vertices that lie on the base (near minZ)
                        if (Math.abs(vz - minZ) < Math.max(eps, Math.abs(minZ) * 1e-6)) {
                            // account for mesh position offset (we assume simple translation/position)
                            const wx = vx + (building.position && building.position.x ? building.position.x : 0);
                            const wy = vy + (building.position && building.position.y ? building.position.y : 0);
                            verts.push({ x: wx, y: wy });
                        }
                    }
                }

                // Deduplicate vertices
                const uniq = [];
                const seen = new Set();
                for (const v of verts) {
                    const key = `${v.x.toFixed(3)},${v.y.toFixed(3)}`;
                    if (!seen.has(key)) { seen.add(key); uniq.push(v); }
                }

                // Helpers: cross, convex hull (Monotone Chain), point-in-polygon, point-to-segment distance
                function cross(o, a, b) { return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x); }
                function convexHull(points) {
                    if (!points || points.length < 3) return points.slice();
                    const pts = points.slice().sort((a, b) => a.x === b.x ? a.y - b.y : a.x - b.x);
                    const lower = [];
                    for (const p of pts) {
                        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
                        lower.push(p);
                    }
                    const upper = [];
                    for (let i = pts.length - 1; i >= 0; i--) {
                        const p = pts[i];
                        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
                        upper.push(p);
                    }
                    upper.pop(); lower.pop();
                    return lower.concat(upper);
                }
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
                function pointToSegmentDist(x, y, a, b) {
                    const A = x - a.x, B = y - a.y, C = b.x - a.x, D = b.y - a.y;
                    const dot = A * C + B * D;
                    const len2 = C * C + D * D;
                    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, dot / len2));
                    const px = a.x + t * C, py = a.y + t * D;
                    const dx = x - px, dy = y - py; return Math.sqrt(dx * dx + dy * dy);
                }

                let impacted = false;
                if (uniq.length >= 3) {
                    const hull = convexHull(uniq);
                    // if impact point inside polygon -> hit
                    if (pointInPoly(impactPos.x, impactPos.y, hull)) impacted = true;
                    else {
                        // otherwise compute distance to edges
                        let minD = Infinity;
                        for (let k = 0; k < hull.length; k++) {
                            const a = hull[k], b = hull[(k + 1) % hull.length];
                            const d = pointToSegmentDist(impactPos.x, impactPos.y, a, b);
                            if (d < minD) minD = d;
                        }
                        if (minD <= weapon.radius) impacted = true;
                    }
                } else {
                    // fallback: use bbox-center distance (legacy behavior)
                    const buildingCenterX = (bbox.min.x + bbox.max.x) / 2;
                    const buildingCenterY = (bbox.min.y + bbox.max.y) / 2;
                    const dist = Math.sqrt(
                        Math.pow(buildingCenterX - impactPos.x, 2) + Math.pow(buildingCenterY - impactPos.y, 2)
                    );
                    if (dist <= weapon.radius) impacted = true;
                }

                if (impacted) {
                    affectedCount++;
                    // compute a representative distance for damage (approx nearest distance)
                    let usedDist = 0;
                    try {
                        // choose min distance to hull vertices or bbox center
                        let minD = Infinity;
                        for (const v of uniq) {
                            const d = Math.hypot(v.x - impactPos.x, v.y - impactPos.y);
                            if (d < minD) minD = d;
                        }
                        if (!isFinite(minD)) minD = Math.hypot(((bbox.min.x + bbox.max.x) / 2) - impactPos.x, ((bbox.min.y + bbox.max.y) / 2) - impactPos.y);
                        usedDist = minD;
                    } catch (e) { usedDist = 0; }
                    this.damageBuilding(building, weapon.calculateDamage(usedDist));
                }
            } catch (e) {
                console.warn('Error while testing building', index, e);
            }
        });
    }

    damageBuilding(building, damage) {
        // Change color to red based on damage
        if (building.material) {
            const originalColor = building.material.color ? building.material.color.getHex() : 0xcccccc;
            building.userData.originalColor = originalColor;
            building.material.color.setHex(0xff0000); // Red for damage
            building.material.needsUpdate = true;
        }

        // Add slight shake effect
        building.userData.shake = true;
        building.userData.shakeIntensity = damage * 0.1;
        building.userData.shakeTime = 0;
    }

    updateShakeEffects(deltaTime) {
        this.buildings.forEach(building => {
            if (building.userData.shake) {
                building.userData.shakeTime += deltaTime;
                if (building.userData.shakeTime < 1.0) { // Shake for 1 second
                    const intensity = building.userData.shakeIntensity * (1 - building.userData.shakeTime);
                    building.position.x += (Math.random() - 0.5) * intensity;
                    building.position.y += (Math.random() - 0.5) * intensity;
                } else {
                    building.userData.shake = false;
                    // Reset position if needed, but for simplicity, leave it
                }
            }
        });
    }

    // Update all visuals (ripples, 3D explosions)
    update(deltaTime) {
        // update ripple animations stored in impacts
        const now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
        for (let i = this.impacts.length - 1; i >= 0; i--) {
            const item = this.impacts[i];
            if (item.ripple) {
                const t = (now - item.ripple.start) / item.ripple.life;
                if (t >= 1) {
                    try { this.map.removeLayer(item.ripple.ripple); } catch (e) { }
                    delete item.ripple;
                } else {
                    const r = item.ripple.maxR * t;
                    try { item.ripple.ripple.setRadius(r); item.ripple.ripple.setStyle({ opacity: Math.max(0.02, 0.9 * (1 - t)), weight: Math.max(1, 3 * (1 - t)) }); } catch (e) { }
                }
            }
        }

        // update 3D explosions
        if (this.scene && this.scene.userData.explosions && this.scene.userData.explosions.length) {
            const list = this.scene.userData.explosions;
            for (let i = list.length - 1; i >= 0; i--) {
                const ex = list[i];
                ex.age += deltaTime;
                const t = ex.age / ex.life;
                // glow expands and fades
                const s = THREE.MathUtils.lerp(0.01, ex.maxScale, Math.min(1, t));
                ex.glow.scale.set(s, s, s);
                ex.glow.material.opacity = Math.max(0, 0.9 * (1 - t));
                // light fades quickly
                ex.light.intensity = Math.max(0, 2.5 * (1 - t));
                // particles move outward and fade
                try {
                    const posAttr = ex.particles.geometry.attributes.position;
                    for (let k = 0; k < ex.velocities.length; k++) {
                        posAttr.array[k * 3 + 0] += ex.velocities[k].x * deltaTime;
                        posAttr.array[k * 3 + 1] += ex.velocities[k].y * deltaTime;
                        posAttr.array[k * 3 + 2] += ex.velocities[k].z * deltaTime;
                        // gravity-ish
                        ex.velocities[k].z -= 0.8 * deltaTime;
                    }
                    posAttr.needsUpdate = true;
                    ex.particles.material.opacity = Math.max(0, 0.95 * (1 - t));
                } catch (e) { /* ignore particle update errors */ }

                if (ex.age >= ex.life) {
                    try {
                        this.scene.remove(ex.glow);
                        this.scene.remove(ex.light);
                        this.scene.remove(ex.particles);
                    } catch (e) { }
                    list.splice(i, 1);
                }
            }
        }
    }

    clearImpacts() {
        this.impacts.forEach(impact => {
            this.map.removeLayer(impact.zone);
        });
        this.impacts = [];

        // Reset building colors
        this.buildings.forEach(building => {
            if (building.material && building.userData.originalColor) {
                building.material.color.setHex(building.userData.originalColor);
                building.material.needsUpdate = true;
            }
        });
    }

    // Example: Simulate multiple impacts
    simulateScenario(scenario) {
        this.clearImpacts();
        scenario.forEach(({ weapon, lat, lon }) => {
            this.simulateImpact(weapon, lat, lon);
        });
    }
}

// Predefined weapons
export const WEAPONS = {
    bomb: new Weapon('bomb', 100, 50),
    missile: new Weapon('missile', 200, 100),
    artillery: new Weapon('artillery', 50, 30)
};