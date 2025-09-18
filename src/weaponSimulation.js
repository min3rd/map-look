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

        return impact;
    }

    apply3DEffects(weapon, lat, lon) {
        if (!this.scene || !this.buildings.length) {
            console.log('No scene or buildings:', this.scene, this.buildings.length);
            return;
        }

        console.log('Applying 3D effects to', this.buildings.length, 'buildings');

        // Convert impact position to 3D coordinates
        const impactPos = latLonToMeters(lat, lon, this.origin);
        console.log('Impact lat/lon:', lat, lon);
        console.log('Impact position in 3D:', impactPos);
        console.log('Origin used:', this.origin);

        let affectedCount = 0;
        this.buildings.forEach((building, index) => {
            if (!building || !building.geometry) return;

            // Get building's actual position from geometry bounding box
            const bbox = building.geometry.boundingBox;
            if (!bbox) {
                console.log('Building', index, 'has no bounding box');
                return;
            }

            console.log('Building', index, 'bbox min:', bbox.min.x, bbox.min.y, 'max:', bbox.max.x, bbox.max.y);
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

        console.log('Affected buildings:', affectedCount);
    }

    damageBuilding(building, damage) {
        console.log('Damaging building with damage:', damage);
        // Change color to red based on damage
        if (building.material) {
            const originalColor = building.material.color ? building.material.color.getHex() : 0xcccccc;
            building.userData.originalColor = originalColor;
            building.material.color.setHex(0xff0000); // Red for damage
            building.material.needsUpdate = true;
            console.log('Building color changed to red');
        } else {
            console.log('Building has no material');
        }

        // Add slight shake effect
        building.userData.shake = true;
        building.userData.shakeIntensity = damage * 0.1;
        building.userData.shakeTime = 0;
        console.log('Shake effect applied');
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