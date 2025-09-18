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
            const geom = new THREE.SphereGeometry(1, 24, 16);
            const mat = new THREE.MeshBasicMaterial({ color: 0xffaa33, transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending });
            const glow = new THREE.Mesh(geom, mat);
            const baseZ = (typeof getTerrainHeightAt === 'function') ? getTerrainHeightAt(pos.x, pos.y) : 0;
            glow.position.set(pos.x, pos.y, baseZ + 2);
            // start very small; will expand
            glow.scale.set(0.02, 0.02, 0.02);
            this.scene.add(glow);

            // light flash
            const light = new THREE.PointLight(0xffcc88, 3.5, weapon.radius * 2.0);
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
            const partMat = new THREE.PointsMaterial({ color: 0xffcc66, size: 0.3, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending });
            const particles = new THREE.Points(particlesGeo, partMat);
            this.scene.add(particles);

            // smoke sprite: canvas-generated radial gradient texture
            function makeSmokeTexture() {
                const size = 128;
                const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
                const ctx = canvas.getContext('2d');
                const grad = ctx.createRadialGradient(size/2, size/2, size*0.05, size/2, size/2, size/2);
                grad.addColorStop(0, 'rgba(200,200,200,0.9)');
                grad.addColorStop(0.4, 'rgba(160,160,160,0.6)');
                grad.addColorStop(1, 'rgba(100,100,100,0)');
                ctx.fillStyle = grad; ctx.fillRect(0,0,size,size);
                const tex = new THREE.CanvasTexture(canvas);
                tex.needsUpdate = true;
                return tex;
            }
            const smokeTex = makeSmokeTexture();
            const smokeMat = new THREE.SpriteMaterial({ map: smokeTex, color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false });
            const smoke = new THREE.Sprite(smokeMat);
            smoke.position.set(pos.x, pos.y, baseZ + 1.5);
            // scale smoke with blast radius so it's visible for large explosions
            const smokeScale = Math.max(weapon.radius * 0.03, 1.0);
            smoke.scale.set(smokeScale, smokeScale, 1);
            this.scene.add(smoke);

            // debris shards: small boxes with velocity and angular velocity
            const debris = [];
            // shard count and sizes scale with weapon radius
            const shardCount = Math.min(24, Math.max(4, Math.round(weapon.radius / 8)));
            for (let s = 0; s < shardCount; s++) {
                const sx = Math.max(0.08, Math.min(1.2, weapon.radius * (0.02 + Math.random() * 0.02)));
                const geomShard = new THREE.BoxGeometry(sx, sx*0.5, sx*0.2);
                const matShard = new THREE.MeshStandardMaterial({ color: 0x665544 });
                const shard = new THREE.Mesh(geomShard, matShard);
                shard.position.set(pos.x + (Math.random()-0.5)*weapon.radius*0.02, pos.y + (Math.random()-0.5)*weapon.radius*0.02, baseZ + 1 + Math.random()*0.6);
                // velocities scale with radius
                shard.userData = { vel: new THREE.Vector3((Math.random()-0.5)*(1 + weapon.radius*0.08), (Math.random()-0.5)*(1 + weapon.radius*0.08), 2 + Math.random()*Math.max(1, weapon.radius*0.08)), angVel: new THREE.Vector3(Math.random()*4, Math.random()*4, Math.random()*4) };
                this.scene.add(shard);
                debris.push(shard);
            }

            // blast sphere (transparent dome) to visualize affected range
            try {
                const sphereGeom = new THREE.SphereGeometry(Math.max(1, weapon.radius), 32, 16);
                const sphereMat = new THREE.MeshBasicMaterial({ color: 0xff5533, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false });
                const blastSphere = new THREE.Mesh(sphereGeom, sphereMat);
                // place sphere center so upper dome sits above ground (approx hemisphere)
                blastSphere.position.set(pos.x, pos.y, baseZ + weapon.radius * 0.5);
                blastSphere.renderOrder = 0;
                this.scene.add(blastSphere);

                // radius label sprite (e.g., "R: 100 m")
                function makeLabelTexture(text) {
                    const pad = 8;
                    const font = 'Bold 28px Arial';
                    const canvas = document.createElement('canvas');
                    const ctx = canvas.getContext('2d');
                    ctx.font = font;
                    const w = Math.ceil(ctx.measureText(text).width) + pad * 2;
                    const h = 48;
                    canvas.width = w; canvas.height = h;
                    // background transparent
                    ctx.clearRect(0, 0, w, h);
                    ctx.font = font;
                    ctx.fillStyle = 'rgba(255,255,240,0.95)';
                    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
                    ctx.lineWidth = 4;
                    ctx.strokeText(text, pad, 34);
                    ctx.fillStyle = 'rgba(0,0,0,0.9)';
                    ctx.fillText(text, pad, 34);
                    return new THREE.CanvasTexture(canvas);
                }
                const metersText = `R: ${Math.round(weapon.radius)} m`;
                const labelTex = makeLabelTexture(metersText);
                const labelMat = new THREE.SpriteMaterial({ map: labelTex, transparent: true });
                const label = new THREE.Sprite(labelMat);
                label.position.set(pos.x, pos.y, baseZ + weapon.radius * 0.9 + 0.5);
                const labelScale = Math.max(weapon.radius * 0.07, 1.0);
                label.scale.set(labelScale * (labelTex.image.width / labelTex.image.height), labelScale, 1);
                this.scene.add(label);

                this.scene.userData.explosions.push({ glow, light, particles, velocities, smoke, debris, blastSphere, label, age: 0, life: Math.max(2.5, weapon.radius * 0.08), smokeLife: Math.max(2.5, weapon.radius * 0.12), maxScale: Math.max(weapon.radius * 0.12, 1.0) });
            } catch (e) {
                // fallback: no blastSphere if geometry creation fails
                this.scene.userData.explosions.push({ glow, light, particles, velocities, smoke, debris, age: 0, life: Math.max(2.5, weapon.radius * 0.02), smokeLife: Math.max(2.5, weapon.radius * 0.04), maxScale: Math.max(weapon.radius * 0.06, 0.5) });
            }
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
                // glow expands and fades (longer life)
                const s = THREE.MathUtils.lerp(0.02, ex.maxScale, Math.min(1, t));
                ex.glow.scale.set(s, s, s);
                ex.glow.material.opacity = Math.max(0, 0.95 * (1 - t));
                // light fades
                ex.light.intensity = Math.max(0, 3.5 * (1 - t));
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

                // smoke update (rises and fades slower)
                if (ex.smoke) {
                    const st = Math.min(1, ex.age / (ex.smokeLife || (ex.life * 1.2)));
                    ex.smoke.position.z += 0.5 * deltaTime; // rise slowly
                    const sc = THREE.MathUtils.lerp(ex.smoke.scale.x, (ex.maxScale || 1.0) * 2.2, Math.min(1, st));
                    ex.smoke.scale.set(sc, sc, 1);
                    if (ex.smoke.material) ex.smoke.material.opacity = Math.max(0, 0.85 * (1 - st));
                }

                // debris update: apply velocity, gravity and rotation
                if (ex.debris && ex.debris.length) {
                    for (let d = ex.debris.length - 1; d >= 0; d--) {
                        const sh = ex.debris[d];
                        const ud = sh.userData;
                        // update position
                        sh.position.x += ud.vel.x * deltaTime;
                        sh.position.y += ud.vel.y * deltaTime;
                        sh.position.z += ud.vel.z * deltaTime;
                        // gravity
                        ud.vel.z -= 9.8 * deltaTime * 0.5;
                        // rotation
                        sh.rotation.x += ud.angVel.x * deltaTime;
                        sh.rotation.y += ud.angVel.y * deltaTime;
                        sh.rotation.z += ud.angVel.z * deltaTime;
                        // if shard fell below terrain, clamp and slow
                        const ground = (typeof getTerrainHeightAt === 'function') ? getTerrainHeightAt(sh.position.x, sh.position.y) : 0;
                        if (sh.position.z <= ground + 0.05) {
                            sh.position.z = ground + 0.05;
                            ud.vel.x *= 0.3; ud.vel.y *= 0.3; ud.vel.z *= -0.1;
                            // slowly fade out material
                            if (sh.material && sh.material.opacity !== undefined) sh.material.opacity = Math.max(0, (sh.material.opacity || 1) - deltaTime * 0.6);
                        }
                        // lifetime removal: base on explosion life
                        if (ex.age > (ex.life + 1.5)) {
                            try { this.scene.remove(sh); } catch (e) {}
                            ex.debris.splice(d, 1);
                        }
                    }
                }

                // fade and remove blastSphere/label after life
                if (ex.blastSphere) {
                    const bt = Math.min(1, ex.age / ex.life);
                    ex.blastSphere.material.opacity = Math.max(0, 0.12 * (1 - bt));
                    ex.blastSphere.scale.set(1 + bt * 0.02, 1 + bt * 0.02, 1 + bt * 0.02);
                }
                if (ex.label) {
                    const lt = Math.min(1, ex.age / ex.life);
                    if (ex.label.material) ex.label.material.opacity = Math.max(0, 1 - lt);
                }

                if (ex.age >= ex.life + Math.max(0.5, (ex.smokeLife || 0))) {
                    try {
                        this.scene.remove(ex.glow);
                        this.scene.remove(ex.light);
                        this.scene.remove(ex.particles);
                        if (ex.smoke) this.scene.remove(ex.smoke);
                        if (ex.debris) for (const sh of ex.debris) try { this.scene.remove(sh); } catch (e) {}
                        if (ex.blastSphere) this.scene.remove(ex.blastSphere);
                        if (ex.label) this.scene.remove(ex.label);
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