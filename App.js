import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Platform, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Location from 'expo-location';
import * as Haptics from 'expo-haptics';

const MAX_HP = 1000;
const SECONDARY_STAT_MAX = 10;
const METERS_PER_DEG_LAT = 111320;
const HEALING_ZONE_REGEN_PER_SECOND = 3;
const PASSIVE_REGEN_PER_SECOND = 1;
const HEALING_ZONE_ZERO_HP_DELAY_SECONDS = 60;

const toRadians = (degrees) => (degrees * Math.PI) / 180;

const metersPerDegreeLon = (latitude) => Math.cos(toRadians(latitude)) * METERS_PER_DEG_LAT;

const offsetsToCoords = (center, offsetX, offsetY) => {
  const deltaLat = offsetY / METERS_PER_DEG_LAT;
  const deltaLon = offsetX / metersPerDegreeLon(center.latitude);
  return {
    latitude: center.latitude + deltaLat,
    longitude: center.longitude + deltaLon
  };
};

const clampOffsetToRadius = (offset, radius) => {
  const length = Math.hypot(offset.x, offset.y);
  if (length === 0) {
    return { x: 0, y: 0 };
  }
  if (length <= radius) {
    return { x: offset.x, y: offset.y };
  }
  const scale = (radius * 0.98) / length;
  return { x: offset.x * scale, y: offset.y * scale };
};

const normalizeVector = (vector) => {
  const length = Math.hypot(vector.x, vector.y) || 1;
  return { x: vector.x / length, y: vector.y / length };
};

const calculateDistanceMeters = (origin, target) => {
  const earthRadius = 6371e3;
  const dLat = toRadians(target.latitude - origin.latitude);
  const dLon = toRadians(target.longitude - origin.longitude);
  const lat1 = toRadians(origin.latitude);
  const lat2 = toRadians(target.latitude);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadius * c;
};

const evaluateZoneDamage = (distanceMeters, zone) => {
  if (distanceMeters == null || !Number.isFinite(distanceMeters)) {
    return 0;
  }
  const sourceRadius = zone.sourceRadius ?? 0;
  const effectiveDistance = Math.max(0, distanceMeters - sourceRadius);

  if (effectiveDistance >= zone.safeRadius) {
    return 0;
  }

  const baseDamage = zone.baseDamage ?? 0;
  const scale = zone.scale ?? 0;
  const offset = zone.offset ?? 0;
  const denominator = effectiveDistance + offset;
  const effectiveDenominator = denominator > 0 ? denominator : 0.1;
  const uncappedDamage = baseDamage + scale / effectiveDenominator;
  return zone.maxDamage == null ? uncappedDamage : Math.min(zone.maxDamage, uncappedDamage);
};

const formatDistance = (distanceMeters) => {
  if (!Number.isFinite(distanceMeters)) {
    return '---';
  }
  if (distanceMeters >= 1000) {
    return `${(distanceMeters / 1000).toFixed(2)} km`;
  }
  return `${distanceMeters.toFixed(1)} m`;
};

const getHapticsConfig = (damage) => {
  if (!Number.isFinite(damage) || damage < 1) {
    return { stage: 0, intervalMs: 0, style: Haptics.ImpactFeedbackStyle.Light };
  }
  if (damage >= 6) {
    return { stage: 3, intervalMs: 1000, style: Haptics.ImpactFeedbackStyle.Heavy };
  }
  if (damage >= 3) {
    return { stage: 2, intervalMs: 2000, style: Haptics.ImpactFeedbackStyle.Medium };
  }
  return { stage: 1, intervalMs: 3000, style: Haptics.ImpactFeedbackStyle.Light };
};

const advanceWithinCircle = (offset, direction, distance, radius) => {
  let remaining = distance;
  let position = { ...offset };
  let currentDirection = { ...direction };
  let guard = 0;

  while (remaining > 0 && guard < 4) {
    const targetX = position.x + currentDirection.x * remaining;
    const targetY = position.y + currentDirection.y * remaining;
    const targetDistance = Math.hypot(targetX, targetY);

    if (targetDistance <= radius) {
      position = { x: targetX, y: targetY };
      remaining = 0;
      break;
    }

    const pd = position.x * currentDirection.x + position.y * currentDirection.y;
    const pp = position.x * position.x + position.y * position.y;
    const radiusSquared = radius * radius;
    const discriminant = pd * pd - (pp - radiusSquared);

    if (discriminant < 0) {
      // Numerically unstable; clamp to boundary and stop.
      const safeScale = radius / Math.max(Math.hypot(position.x, position.y), 1);
      position = { x: position.x * safeScale, y: position.y * safeScale };
      remaining = 0;
      break;
    }

    const travelToBoundary = -pd + Math.sqrt(discriminant);
    position = {
      x: position.x + currentDirection.x * travelToBoundary,
      y: position.y + currentDirection.y * travelToBoundary
    };
    remaining = Math.max(remaining - travelToBoundary, 0);

    const normalX = position.x / radius;
    const normalY = position.y / radius;
    const dot = currentDirection.x * normalX + currentDirection.y * normalY;
    currentDirection = normalizeVector({
      x: currentDirection.x - 2 * dot * normalX,
      y: currentDirection.y - 2 * dot * normalY
    });

    guard += 1;
  }

  return { position, direction: currentDirection };
};

const createInitialMovingHazardState = (config) => {
  const offset = clampOffsetToRadius(
    config.initialOffsetMeters ?? { x: config.radiusMeters * 0.5, y: 0 },
    config.radiusMeters
  );
  return {
    offset,
    coords: offsetsToCoords(config.center, offset.x, offset.y)
  };
};

const DANGER_ZONES = [
  {
    id: 'garakuta',
    name: 'がらくた',
    coords: { latitude: 37.5637209353559, longitude: 140.99321916494142 },
    safeRadius: 60,
    baseDamage: 6,
    scale: 30,
    offset: 0.1,
    maxDamage: 18
  },
  {
    id: 'station-rift',
    name: 'テック工房',
    coords: { latitude: 37.56385812102285, longitude: 140.99152814703658 },
    safeRadius: 60,
    baseDamage: 6,
    scale: 30,
    offset: 0.1,
    maxDamage: 18
  },
  {
    id: 'area-center',
    name: '交流センター広場',
    coords: { latitude: 37.56434331449345, longitude: 140.99237426307516 },
    safeRadius: 60,
    baseDamage: 6,
    scale: 30,
    offset: 0.1,
    maxDamage: 18
  },
  {
    id: 'puku',
    name: 'puku',
    coords: { latitude: 37.56334549068359, longitude: 140.98913906488454 },
    safeRadius: 60,
    baseDamage: 6,
    scale: 30,
    offset: 0.1,
    maxDamage: 18
  },
  {
    id: 'haccoba',
    name: 'sake',
    coords: { latitude: 37.561486942859, longitude: 140.9914438352546 },
    safeRadius: 60,
    baseDamage: 6,
    scale: 30,
    offset: 0.1,
    maxDamage: 18
  }
];

const MOVING_HAZARD = {
  id: 'phantom-scout',
  name: 'center',
  center: { latitude: 37.563886, longitude: 140.991698 },
  radiusMeters: 300,
  sourceRadius: 5,
  safeRadius: 60,
  baseDamage: 6,
  scale: 135,
  offset: 0.1,
  speedMetersPerSecond: 4,
  initialHeadingDegrees: 45,
  initialOffsetMeters: { x: 120, y: -60 }
};

const HEALING_ZONE = {
  id: 'sanctuary-courtyard',
  name: '神の住まう場所',
  center: { latitude: 37.568509, longitude: 140.990278 },
  radiusMeters: 58
};

const INITIAL_STATS = {
  hp: 1000,
  guard: 5,
  resonance: 5
};

export default function App() {
  const [permissionStatus, setPermissionStatus] = useState(null);
  const [location, setLocation] = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);
  const [stats, setStats] = useState(INITIAL_STATS);
  const [lastDamage, setLastDamage] = useState(0);
  const [zoneSummaries, setZoneSummaries] = useState([]);
  const [isInHealingZone, setIsInHealingZone] = useState(false);
  const [movingHazardState, setMovingHazardState] = useState(() =>
    createInitialMovingHazardState(MOVING_HAZARD)
  );
  const watcherRef = useRef(null);
  const movingHazardRef = useRef(movingHazardState);
  const movingDirectionRef = useRef(
    normalizeVector({
      x: Math.cos(toRadians(MOVING_HAZARD.initialHeadingDegrees)),
      y: Math.sin(toRadians(MOVING_HAZARD.initialHeadingDegrees))
    })
  );
  const movementTimestampRef = useRef(Date.now());
  const locationRef = useRef(null);
  const hpRef = useRef(INITIAL_STATS.hp);
  const isInHealingZoneRef = useRef(false);
  const healingZoneTimerRef = useRef(0);
  const hapticStageRef = useRef(0);
  const hapticIntervalRef = useRef(0);
  const hapticStyleRef = useRef(Haptics.ImpactFeedbackStyle.Light);
  const lastHapticTimeRef = useRef(0);

  useEffect(() => {
    requestPermissions();

    return () => {
      watcherRef.current?.remove();
    };
  }, []);

  useEffect(() => {
    movingHazardRef.current = movingHazardState;
  }, [movingHazardState]);

  useEffect(() => {
    hpRef.current = stats.hp;
  }, [stats.hp]);

  const updateDamageHaptics = useCallback((damage) => {
    const { stage, intervalMs, style } = getHapticsConfig(damage);
    const previousStage = hapticStageRef.current;

    hapticStageRef.current = stage;
    hapticIntervalRef.current = intervalMs;
    hapticStyleRef.current = style;

    if (stage === 0) {
      lastHapticTimeRef.current = 0;
      return;
    }

    if (previousStage < stage || lastHapticTimeRef.current === 0) {
      Haptics.impactAsync(style).catch(() => {});
      lastHapticTimeRef.current = Date.now();
    }
  }, []);

  const applyProximityEffects = useCallback(
    (coords) => {
      if (!coords) {
        setZoneSummaries([]);
        setLastDamage(0);
        setIsInHealingZone(false);
        isInHealingZoneRef.current = false;
        healingZoneTimerRef.current = 0;
        return;
      }

      const guardValue = stats.guard;
      const insideHealingZone =
        calculateDistanceMeters(coords, HEALING_ZONE.center) <= HEALING_ZONE.radiusMeters;

      setIsInHealingZone(insideHealingZone);
      isInHealingZoneRef.current = insideHealingZone;
      if (!insideHealingZone) {
        healingZoneTimerRef.current = 0;
      }

      const summaries = DANGER_ZONES.map((zone) => {
        const distance = calculateDistanceMeters(coords, zone.coords);
        const rawDamage = insideHealingZone ? 0 : evaluateZoneDamage(distance, zone);
        const mitigatedDamage = Math.max(rawDamage - guardValue, 0);

        return {
          id: zone.id,
          name: zone.name,
          distance,
          rawDamage,
          mitigatedDamage,
          maxDamage: zone.maxDamage ?? null,
          isDynamic: false
        };
      });

      const dynamicState = movingHazardRef.current;
      if (dynamicState) {
        const dynamicZone = {
          id: MOVING_HAZARD.id,
          name: MOVING_HAZARD.name,
          coords: dynamicState.coords,
          safeRadius: MOVING_HAZARD.safeRadius,
          baseDamage: MOVING_HAZARD.baseDamage,
          scale: MOVING_HAZARD.scale,
          offset: MOVING_HAZARD.offset,
          maxDamage: MOVING_HAZARD.maxDamage ?? null
        };

        const distance = calculateDistanceMeters(coords, dynamicZone.coords);
        const rawDamage = insideHealingZone ? 0 : evaluateZoneDamage(distance, dynamicZone);
        const mitigatedDamage = Math.max(rawDamage - guardValue, 0);

        summaries.push({
          id: dynamicZone.id,
          name: dynamicZone.name,
          distance,
          rawDamage,
          mitigatedDamage,
          maxDamage: dynamicZone.maxDamage,
          isDynamic: true
        });
      }

      setZoneSummaries(summaries);

      const totalMitigatedDamage = summaries.reduce((sum, entry) => sum + entry.mitigatedDamage, 0);
      const damageApplied = Number(totalMitigatedDamage.toFixed(2));

      updateDamageHaptics(damageApplied);

      if (damageApplied > 0) {
        setStats((prev) => {
          const nextHp = Math.max(prev.hp - damageApplied, 0);
          if (nextHp === prev.hp) {
            return prev;
          }
          hpRef.current = nextHp;
          return { ...prev, hp: nextHp };
        });
      }

      setLastDamage(damageApplied);
    },
    [stats.guard, updateDamageHaptics]
  );

  const requestPermissions = async () => {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      setPermissionStatus(status);

      if (status !== Location.PermissionStatus.GRANTED) {
        watcherRef.current?.remove();
        watcherRef.current = null;
        setLocation(null);
        locationRef.current = null;
        setErrorMsg('位置情報へのアクセスが許可されていません');
        setZoneSummaries([]);
        setLastDamage(0);
        return;
      }

      setErrorMsg(null);
      const currentLocation = await Location.getCurrentPositionAsync({});
      setLocation(currentLocation);
      locationRef.current = currentLocation;
      applyProximityEffects(currentLocation.coords);

      watcherRef.current?.remove();

      const subscription = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.High,
          distanceInterval: 5
        },
        (position) => {
          setLocation(position);
          locationRef.current = position;
          applyProximityEffects(position.coords);
        }
      );

      watcherRef.current = subscription;
    } catch (error) {
      setErrorMsg(error.message ?? '現在地の取得中に問題が発生しました');
    }
  };

  useEffect(() => {
    movementTimestampRef.current = Date.now();
    const interval = setInterval(() => {
      const now = Date.now();
      let deltaSeconds = (now - movementTimestampRef.current) / 1000;
      movementTimestampRef.current = now;

      if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) {
        deltaSeconds = 1;
      }
      deltaSeconds = Math.min(deltaSeconds, 2);

      setMovingHazardState((prev) => {
        const travelDistance = MOVING_HAZARD.speedMetersPerSecond * deltaSeconds;
        const { position, direction } = advanceWithinCircle(
          prev.offset,
          movingDirectionRef.current,
          travelDistance,
          MOVING_HAZARD.radiusMeters
        );

        movingDirectionRef.current = direction;
        const coords = offsetsToCoords(MOVING_HAZARD.center, position.x, position.y);
        const updated = { offset: position, coords };
        movingHazardRef.current = updated;
        return updated;
      });

      if (deltaSeconds > 0) {
        const passiveRegenAmount = PASSIVE_REGEN_PER_SECOND * deltaSeconds;
        if (passiveRegenAmount > 0) {
          setStats((prev) => {
            if (prev.hp <= 0 || prev.hp >= MAX_HP) {
              return prev;
            }
            const nextHp = Math.min(prev.hp + passiveRegenAmount, MAX_HP);
            if (nextHp === prev.hp) {
              return prev;
            }
            const rounded = Number(nextHp.toFixed(2));
            hpRef.current = rounded;
            return { ...prev, hp: rounded };
          });
        }
      }

      const insideHealingZone = isInHealingZoneRef.current;
      if (insideHealingZone) {
        if (deltaSeconds > 0) {
          if (hpRef.current <= 0) {
            healingZoneTimerRef.current = Math.min(
              healingZoneTimerRef.current + deltaSeconds,
              HEALING_ZONE_ZERO_HP_DELAY_SECONDS
            );
          } else {
            healingZoneTimerRef.current = 0;
          }
        }

        const canRegen =
          hpRef.current > 0 || healingZoneTimerRef.current >= HEALING_ZONE_ZERO_HP_DELAY_SECONDS;
        if (canRegen && deltaSeconds > 0) {
          const regenAmount = HEALING_ZONE_REGEN_PER_SECOND * deltaSeconds;
          setStats((prev) => {
            const currentHp = prev.hp;
            const readyForZeroHpRegen =
              currentHp > 0 ||
              (currentHp <= 0 && healingZoneTimerRef.current >= HEALING_ZONE_ZERO_HP_DELAY_SECONDS);
            if (!readyForZeroHpRegen || currentHp >= MAX_HP) {
              return prev;
            }
            const nextHp = Math.min(currentHp + regenAmount, MAX_HP);
            if (nextHp === currentHp) {
              return prev;
            }
            const rounded = Number(nextHp.toFixed(2));
            hpRef.current = rounded;
            if (rounded > 0) {
              healingZoneTimerRef.current = 0;
            }
            return { ...prev, hp: rounded };
          });
        }
      } else {
        healingZoneTimerRef.current = 0;
      }

      const stage = hapticStageRef.current;
      const intervalMs = hapticIntervalRef.current;
      if (stage > 0 && intervalMs > 0) {
        const lastTriggered = lastHapticTimeRef.current || 0;
        if (now - lastTriggered >= intervalMs) {
          Haptics.impactAsync(hapticStyleRef.current).catch(() => {});
          lastHapticTimeRef.current = now;
        }
      }

      const currentCoords = locationRef.current?.coords;
      if (currentCoords) {
        applyProximityEffects(currentCoords);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [applyProximityEffects]);

  const renderContent = () => {
    if (errorMsg) {
      return <Text style={styles.errorText}>{errorMsg}</Text>;
    }

    if (!permissionStatus) {
      return <Text style={styles.infoText}>位置情報の権限を確認しています...</Text>;
    }

    if (permissionStatus !== Location.PermissionStatus.GRANTED) {
      return (
        <View style={styles.centered}>
          <Text style={styles.infoText}>位置情報へのアクセスを許可してください。</Text>
          <Button title="再試行" onPress={requestPermissions} />
        </View>
      );
    }

    if (!location) {
      return <Text style={styles.infoText}>現在地を取得しています...</Text>;
    }

    const { latitude, longitude, altitude, accuracy } = location.coords;
    const nearestZone = zoneSummaries.reduce((closest, zone) => {
      if (!Number.isFinite(zone.distance)) {
        return closest;
      }
      if (!closest || zone.distance < closest.distance) {
        return zone;
      }
      return closest;
    }, null);

    return (
      <View style={styles.locationContainer}>
        <Text style={styles.coordinate}>緯度: {latitude.toFixed(6)}</Text>
        <Text style={styles.coordinate}>経度: {longitude.toFixed(6)}</Text>
        {typeof altitude === 'number' && (
          <Text style={styles.coordinate}>高度: {altitude.toFixed(1)} m</Text>
        )}
        {typeof accuracy === 'number' && (
          <Text style={styles.meta}>精度: ±{accuracy.toFixed(1)} m</Text>
        )}
        <Text style={styles.meta}>更新: {new Date(location.timestamp).toLocaleString()}</Text>
        {nearestZone && (
          <Text style={styles.meta}>
            最寄り危険源: {nearestZone.name}（{formatDistance(nearestZone.distance)}）
          </Text>
        )}
        {Platform.OS === 'android' && (
          <Text style={styles.meta}>Androidで精度が低い場合は位置設定を高精度にしてください。</Text>
        )}
      </View>
    );
  };

  const activeHazardCount = zoneSummaries.filter((zone) => zone.mitigatedDamage > 0).length;
  const totalHazardCount = zoneSummaries.length;
  const lastDamageDisplay = lastDamage > 0 ? lastDamage.toFixed(1) : '0';

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="auto" />
      <Text style={styles.title}>現在地ビューアー</Text>
      {renderContent()}
      <View style={styles.statusSection}>
        <Text style={styles.sectionTitle}>ステータス</Text>
        <View style={styles.statCard}>
          <View style={styles.statHeader}>
            <Text style={styles.statName}>HP</Text>
            <Text style={styles.statValue}>{stats.hp}/{MAX_HP}</Text>
          </View>
          <View style={styles.progressTrack}>
            <View
              style={[
                styles.progressFill,
                styles.hpFill,
                { width: `${Math.min(stats.hp, MAX_HP) / MAX_HP * 100}%` }
              ]}
            />
          </View>
        </View>
        <View style={styles.statRow}>
          <View style={styles.statCardHalf}>
            <Text style={styles.statName}>護力</Text>
            <Text style={styles.statValue}>{stats.guard}</Text>
            <View style={styles.progressTrackSmall}>
              <View
                style={[
                  styles.progressFill,
                  styles.guardFill,
                  { width: `${Math.min(stats.guard, SECONDARY_STAT_MAX) / SECONDARY_STAT_MAX * 100}%` }
                ]}
              />
            </View>
          </View>
          <View style={styles.statCardHalf}>
            <Text style={styles.statName}>響力</Text>
            <Text style={styles.statValue}>{stats.resonance}</Text>
            <View style={styles.progressTrackSmall}>
              <View
                style={[
                  styles.progressFill,
                  styles.resonanceFill,
                  { width: `${Math.min(stats.resonance, SECONDARY_STAT_MAX) / SECONDARY_STAT_MAX * 100}%` }
                ]}
              />
            </View>
          </View>
        </View>
        <View style={styles.statusMetaBlock}>
          <Text style={styles.statusMeta}>直近ダメージ合計: -{lastDamageDisplay} HP</Text>
          <Text style={styles.statusMeta}>
            影響中の危険源: {activeHazardCount}/{totalHazardCount}
          </Text>
          <Text style={styles.statusMeta}>
            ヒーリングゾーン: {isInHealingZone ? '内' : '外'}
          </Text>
        </View>
      </View>
      {zoneSummaries.length > 0 && (
        <View style={styles.dangerSection}>
          <Text style={styles.sectionTitle}>ダメージ源</Text>
          {zoneSummaries.map((zone) => (
            <View key={zone.id} style={styles.dangerCard}>
              <Text style={styles.dangerName}>
                {zone.name}
                {zone.isDynamic ? '（移動中）' : ''}
              </Text>
              <Text style={styles.dangerMeta}>距離: {formatDistance(zone.distance)}</Text>
              <Text style={styles.dangerMeta}>
                想定ダメージ: -{zone.rawDamage.toFixed(1)} HP
              </Text>
              <Text style={styles.dangerMeta}>
                ガード後: -{zone.mitigatedDamage.toFixed(1)} HP
              </Text>
              <Text style={styles.dangerMeta}>
                上限: {zone.maxDamage != null ? `-${zone.maxDamage.toFixed(1)} HP` : 'なし'}
              </Text>
            </View>
          ))}
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
    paddingHorizontal: 24,
    paddingTop: 48
  },
  title: {
    fontSize: 24,
    fontWeight: '600',
    color: '#f8fafc',
    marginBottom: 24
  },
  sectionTitle: {
    color: '#cbd5f5',
    fontSize: 18,
    marginBottom: 12,
    fontWeight: '600'
  },
  centered: {
    alignItems: 'center'
  },
  infoText: {
    color: '#e2e8f0',
    fontSize: 16,
    lineHeight: 24
  },
  errorText: {
    color: '#f87171',
    fontSize: 16,
    lineHeight: 24
  },
  locationContainer: {
    backgroundColor: '#1e293b',
    padding: 24,
    borderRadius: 16,
    gap: 12,
    marginBottom: 32
  },
  coordinate: {
    color: '#f8fafc',
    fontSize: 18,
    fontVariant: ['tabular-nums']
  },
  meta: {
    color: '#cbd5f5',
    fontSize: 14
  },
  statusSection: {
    width: '100%'
  },
  statCard: {
    backgroundColor: '#1e1b4b',
    padding: 20,
    borderRadius: 16,
    marginBottom: 16
  },
  statHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12
  },
  statRow: {
    flexDirection: 'row',
    gap: 16
  },
  statCardHalf: {
    flex: 1,
    backgroundColor: '#1e1b4b',
    padding: 16,
    borderRadius: 16
  },
  statName: {
    color: '#f8fafc',
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 8
  },
  statValue: {
    color: '#f8fafc',
    fontSize: 20,
    fontVariant: ['tabular-nums'],
    marginBottom: 12
  },
  progressTrack: {
    height: 10,
    backgroundColor: '#312e81',
    borderRadius: 999,
    overflow: 'hidden'
  },
  progressTrackSmall: {
    height: 6,
    backgroundColor: '#312e81',
    borderRadius: 999,
    overflow: 'hidden'
  },
  progressFill: {
    height: '100%'
  },
  hpFill: {
    backgroundColor: '#f87171'
  },
  guardFill: {
    backgroundColor: '#38bdf8'
  },
  resonanceFill: {
    backgroundColor: '#a855f7'
  },
  statusMetaBlock: {
    marginTop: 12,
    gap: 4
  },
  statusMeta: {
    color: '#cbd5f5',
    fontSize: 14
  },
  dangerSection: {
    width: '100%',
    marginTop: 24,
    gap: 12
  },
  dangerCard: {
    backgroundColor: '#111827',
    padding: 16,
    borderRadius: 16,
    gap: 4
  },
  dangerName: {
    color: '#f8fafc',
    fontSize: 16,
    fontWeight: '600'
  },
  dangerMeta: {
    color: '#cbd5f5',
    fontSize: 14
  }
});
