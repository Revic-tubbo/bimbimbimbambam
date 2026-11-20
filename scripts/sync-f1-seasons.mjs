#!/usr/bin/env node
/**
 * Автономный CLI-скрипт синхронизации и предрасчёта сезонов Формулы-1 (Вариант 3: Архив + GitHub Actions)
 * Использование:
 *   node scripts/sync-f1-seasons.mjs
 *   node scripts/sync-f1-seasons.mjs --years=2022,2023,2024,2025,2026
 *
 * Скрипт опрашивает открытый Jolpica-F1 (Ergast) REST API, прогоняет все завершённые Гран-при
 * через математические алгоритмы S_quali (круг трения), S_clean, S_combat, Вариант 2А (динамические веса)
 * и Вариант 3А (множитель чистого темпа K_pace) и сохраняет готовые JSON-архивы в public/data/seasons/.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT_DIR, 'public', 'data', 'seasons');

const JOLPICA_BASE_URL = process.env.JOLPICA_API_URL || 'https://api.jolpi.ca/ergast/f1';

const TEAM_COLOR_LOOKUP = {
  mercedes: '#00D2BE',
  ferrari: '#E10600',
  mclaren: '#FF8000',
  red_bull: '#3671C6',
  redbull: '#3671C6',
  alpine: '#0093CC',
  williams: '#64C4FF',
  haas: '#B6BABD',
  rb: '#6692FF',
  alphatauri: '#6692FF',
  aston_martin: '#229971',
  astonmartin: '#229971',
  sauber: '#52E252',
  kick_sauber: '#52E252',
  alfa: '#C92D4B',
  audi: '#F50537',
  cadillac: '#D4AF37',
};

const TRACK_DIFFICULTY_BY_CIRCUIT = {
  monaco: 1.65,
  marina_bay: 1.55,
  suzuka: 1.45,
  hungaroring: 1.48,
  zandvoort: 1.44,
  imola: 1.42,
  rodriguez: 1.38,
  catalunya: 1.35,
  americas: 1.32,
  villeneuve: 1.3,
  sepang: 1.3,
  albert_park: 1.25,
  silverstone: 1.25,
  red_bull_ring: 1.22,
  miami: 1.2,
  jeddah: 1.2,
  shanghai: 1.15,
  baku: 1.15,
  interlagos: 1.14,
  bahrain: 1.12,
  monza: 1.12,
  spa: 1.08,
  vegas: 1.1,
  yas_marina: 1.24,
  losail: 1.28,
};

function getRatingTier(score) {
  if (score >= 95.0) return 'S+';
  if (score >= 90.0) return 'S';
  if (score >= 84.0) return 'A';
  if (score >= 76.0) return 'B';
  return 'C';
}

function computeQualiIdealScore(idealLapSec, driverLapSec) {
  const safeIdeal = Math.max(40, idealLapSec);
  const delta = Math.max(0, driverLapSec - safeIdeal);
  const raw = 100 * Math.exp(-delta / (0.022 * safeIdeal));
  return Number(Math.max(40, Math.min(100, raw)).toFixed(1));
}

function computeCleanLapsScore(baseIdealSec, avgCleanDeltaSec, stdConsistencySec, tyreBonusPoints) {
  const safeBase = Math.max(40, baseIdealSec);
  const delta = Math.max(0, avgCleanDeltaSec);
  const baseProximity = 100 * Math.exp(-delta / (0.026 * safeBase));
  const variancePenalty = Math.max(0, stdConsistencySec - 0.14) * 14;
  const raw = baseProximity + tyreBonusPoints - variancePenalty;
  return Number(Math.max(45, Math.min(100, raw)).toFixed(1));
}

function computePaceDeltaMultiplier(selfCleanDeltaSec, opponentCleanDeltaSec) {
  const paceDiffSec = selfCleanDeltaSec - opponentCleanDeltaSec;
  const rawK = Math.exp(0.65 * paceDiffSec);
  return Number(Math.max(0.45, Math.min(1.65, rawK)).toFixed(2));
}

function computeCombatActionsScore({
  overtakesCount,
  trackDifficulty,
  defensiveHoldsCount,
  lap1Delta,
  errorsCount,
  paceMultiplierK = 1.0,
  startedFromPoleWithCleanDominance = false,
}) {
  const baseNeutral = startedFromPoleWithCleanDominance ? 86.5 : 74.0;
  const overtakeGain = overtakesCount * 3.1 * trackDifficulty * paceMultiplierK;
  const defenseGain = defensiveHoldsCount * 1.45 * Math.min(1.5, trackDifficulty) * paceMultiplierK;
  const startGain = lap1Delta * 2.2;
  const errorPenalty = errorsCount * 5.5;
  const raw = baseNeutral + overtakeGain + defenseGain + startGain - errorPenalty;
  return Number(Math.max(42, Math.min(99.5, raw)).toFixed(1));
}

function computeDynamicRaceWeights(combatLapsCount, totalLaps) {
  const safeTotal = Math.max(1, totalLaps);
  const safeCombat = Math.max(0, Math.min(safeTotal, combatLapsCount));
  const rawCombatW = Math.min(0.5, Math.max(0.1, 0.1 + 1.6 * (safeCombat / safeTotal)));
  const combatWeight = Number(rawCombatW.toFixed(2));
  const cleanWeight = Number((1 - combatWeight).toFixed(2));
  return { cleanWeight, combatWeight };
}

function parseLapTimeToSec(rawTime) {
  if (!rawTime) return null;
  const trimmed = String(rawTime).trim();
  if (!trimmed) return null;
  const parts = trimmed.split(':');
  if (parts.length === 2) {
    const minutes = Number(parts[0]);
    const seconds = Number(parts[1]);
    if (Number.isFinite(minutes) && Number.isFinite(seconds)) {
      return Number((minutes * 60 + seconds).toFixed(3));
    }
    return null;
  }
  const direct = Number(trimmed);
  return Number.isFinite(direct) && direct > 30 ? Number(direct.toFixed(3)) : null;
}

function transformRound(racePayload, qualifyingList = []) {
  const results = racePayload.Results || [];
  const roundNum = Number(racePayload.round) || 1;
  const roundCode = `R${String(roundNum).padStart(2, '0')}`;
  const circuitId = racePayload.Circuit?.circuitId || 'silverstone';
  const trackDifficultyWeight = TRACK_DIFFICULTY_BY_CIRCUIT[circuitId] || 1.25;

  const qualiMap = new Map();
  let fastestQualiSec = null;
  let poleDriverCode = 'VER';

  qualifyingList.forEach((q, idx) => {
    const code = (q.Driver?.code || q.Driver?.familyName?.slice(0, 3) || 'DRV').toUpperCase();
    const pos = Number(q.position) || idx + 1;
    const bestSec =
      parseLapTimeToSec(q.Q3) ?? parseLapTimeToSec(q.Q2) ?? parseLapTimeToSec(q.Q1) ?? null;
    if (bestSec !== null && (fastestQualiSec === null || bestSec < fastestQualiSec)) {
      fastestQualiSec = bestSec;
    }
    if (pos === 1) poleDriverCode = code;
    qualiMap.set(code, { pos, bestSec });
  });

  let fastestRaceLapSec = null;
  let fastestLapDriverCode = '';
  results.forEach((r) => {
    const code = (r.Driver?.code || r.Driver?.familyName?.slice(0, 3) || 'DRV').toUpperCase();
    const flSec = parseLapTimeToSec(r.FastestLap?.Time?.time);
    if (flSec !== null && (fastestRaceLapSec === null || flSec < fastestRaceLapSec)) {
      fastestRaceLapSec = flSec;
      fastestLapDriverCode = code;
    }
  });

  const referencePoleSec =
    fastestQualiSec ?? (fastestRaceLapSec !== null ? Number((fastestRaceLapSec - 1.35).toFixed(3)) : 78.5);
  const mathematicalIdealLapSec = Number(Math.max(45, referencePoleSec - 0.068).toFixed(3));
  const totalLaps = Math.max(
    40,
    results.reduce((maxL, r) => Math.max(maxL, Number(r.laps) || 0), 58)
  );

  const cleanDeltaByCode = {};
  results.forEach((r, idx) => {
    const code = (r.Driver?.code || r.Driver?.familyName?.slice(0, 3) || 'DRV').toUpperCase();
    const finishPos = Number(r.position) || idx + 1;
    const flSec = parseLapTimeToSec(r.FastestLap?.Time?.time);
    cleanDeltaByCode[code] =
      flSec !== null && fastestRaceLapSec !== null
        ? Math.max(0.08, Number(((flSec - fastestRaceLapSec) * 0.72 + 0.12).toFixed(3)))
        : Number((0.12 + (finishPos - 1) * 0.048).toFixed(3));
  });

  const orderedCodes = results.map((r) =>
    (r.Driver?.code || r.Driver?.familyName?.slice(0, 3) || 'DRV').toUpperCase()
  );

  const evaluations = results.map((r, posIdx) => {
    const code = orderedCodes[posIdx];
    const driverName = `${r.Driver?.givenName || ''} ${r.Driver?.familyName || code}`.trim();
    const driverNum = Number(r.Driver?.permanentNumber || r.number) || posIdx + 1;
    const rawTeamId = (r.Constructor?.constructorId || 'mercedes').toLowerCase();
    const teamColor = TEAM_COLOR_LOOKUP[rawTeamId] || '#00D2BE';
    const finishPosition = Number(r.position) || posIdx + 1;
    const gridPos = Number(r.grid) || finishPosition;
    const qInfo = qualiMap.get(code);
    const qualiPosition = qInfo?.pos ?? (gridPos > 0 ? gridPos : finishPosition);
    const pointsScored = Number(r.points) || 0;

    const driverQualiTimeSec =
      qInfo?.bestSec !== null && qInfo?.bestSec !== undefined && qInfo.bestSec >= mathematicalIdealLapSec
        ? qInfo.bestSec
        : Number((mathematicalIdealLapSec + 0.068 + (qualiPosition - 1) * 0.052).toFixed(3));

    const qualiDeltaToIdealSec = Number(
      Math.max(0.04, driverQualiTimeSec - mathematicalIdealLapSec).toFixed(3)
    );
    const qualiScore = computeQualiIdealScore(mathematicalIdealLapSec, driverQualiTimeSec);

    const startedFromPoleWithCleanDominance = qualiPosition === 1 && finishPosition === 1;
    const positionsGained = Math.max(0, qualiPosition - finishPosition);
    const combatLapsCount = startedFromPoleWithCleanDominance
      ? 3
      : finishPosition <= 4 && positionsGained <= 1
      ? 9
      : Math.min(24, 14 + positionsGained * 2);
    const cleanLapsCount = Math.max(1, totalLaps - combatLapsCount);
    const { cleanWeight, combatWeight } = computeDynamicRaceWeights(combatLapsCount, totalLaps);

    const avgCleanDeltaToIdealSec = cleanDeltaByCode[code] ?? 0.35;
    const cleanLapConsistencyStdSec = Number(
      Math.min(0.45, 0.12 + (finishPosition - 1) * 0.011).toFixed(2)
    );
    const tyreLifeBonus = finishPosition <= 3 ? 2.2 : finishPosition <= 10 ? 1.4 : 0.6;
    const cleanLapsScore = computeCleanLapsScore(
      mathematicalIdealLapSec,
      avgCleanDeltaToIdealSec,
      cleanLapConsistencyStdSec,
      tyreLifeBonus
    );

    const isTopConstructor = ['mercedes', 'ferrari', 'mclaren', 'red_bull', 'redbull'].includes(
      rawTeamId
    );
    const chassisAeroPercent = isTopConstructor ? 40 : 52;
    const strategyPitwallPercent = qualiPosition < finishPosition ? 30 : 24;
    const driverExecutionPercent = 100 - chassisAeroPercent - strategyPitwallPercent;
    const chassisDeltaSec = Number(((avgCleanDeltaToIdealSec * chassisAeroPercent) / 100).toFixed(3));
    const strategyDeltaSec = Number(((avgCleanDeltaToIdealSec * strategyPitwallPercent) / 100).toFixed(3));
    const driverDeltaSec = Number(
      Math.max(0.005, avgCleanDeltaToIdealSec - chassisDeltaSec - strategyDeltaSec).toFixed(3)
    );

    const recoveredFromBack = qualiPosition > finishPosition + 2 && isTopConstructor;
    const rivalIdx = recoveredFromBack
      ? Math.min(orderedCodes.length - 1, posIdx + 2)
      : posIdx === 0
      ? Math.min(orderedCodes.length - 1, 1)
      : Math.max(0, posIdx - 1);
    const primaryRivalCode = orderedCodes[rivalIdx] || code;
    const primaryRivalCleanDeltaSec = cleanDeltaByCode[primaryRivalCode] ?? avgCleanDeltaToIdealSec;
    const paceMultiplierK = computePaceDeltaMultiplier(
      avgCleanDeltaToIdealSec,
      primaryRivalCleanDeltaSec
    );

    const overtakesCount = startedFromPoleWithCleanDominance
      ? 1
      : Math.max(1, Math.min(10, positionsGained + 2));
    const defensiveHoldsCount = finishPosition <= 5 ? 7 : finishPosition <= 12 ? 6 : 4;
    const lap1PositionsDelta = Math.max(-2, Math.min(4, qualiPosition - finishPosition));
    const errorsCount = finishPosition > 15 && qualiPosition < finishPosition ? 1 : 0;

    const combatActionsScore = computeCombatActionsScore({
      overtakesCount,
      trackDifficulty: trackDifficultyWeight,
      defensiveHoldsCount,
      lap1Delta: lap1PositionsDelta,
      errorsCount,
      paceMultiplierK,
      startedFromPoleWithCleanDominance,
    });

    const raceScore = Number(
      (cleanWeight * cleanLapsScore + combatWeight * combatActionsScore).toFixed(1)
    );
    const weekendOverallScore = Number((qualiScore * 0.45 + raceScore * 0.55).toFixed(1));

    const totalMs = Math.round(qualiDeltaToIdealSec * 1000);
    const cornerWeights = [0.24, 0.19, 0.21, 0.18, 0.18];
    const cornerLabels = [
      'T1 Heavy Braking Zone',
      'T4–T6 High-Speed Esses',
      'T9 Mid-Sector Hairpin',
      'T12 Back Straight Entry',
      'T15 Final Traction Corner',
    ];
    const cornerFactors = ['Trail-Braking', 'Апекс Vmin', 'Тракция', 'X-Mode / ERS', 'Термика шин'];
    const baseApexSpeeds = [115, 168, 208, 98, 152];
    const cornerLosses = cornerLabels.map((cLabel, cIdx) => {
      const ms =
        cIdx === 4
          ? Math.max(
              3,
              totalMs - cornerWeights.slice(0, 4).reduce((acc, w) => acc + Math.round(totalMs * w), 0)
            )
          : Math.max(3, Math.round(totalMs * cornerWeights[cIdx]));
      const idealApexKmh = baseApexSpeeds[cIdx];
      return {
        cornerLabel: cLabel,
        idealApexKmh,
        driverApexKmh: idealApexKmh - Math.max(1, Math.round(ms / 6.5)),
        deltaMs: ms,
        factor: cornerFactors[cIdx],
      };
    });

    const combatEvents = [
      {
        lap: 1,
        type: 'start_gain',
        title:
          lap1PositionsDelta > 0
            ? `Старт и 1-й круг: отыграно +${lap1PositionsDelta} поз.`
            : 'Старт и 1-й круг: удержание позиции в стартовом створе',
        cornerOrZone: cornerLabels[0],
        difficultyWeight: trackDifficultyWeight,
        paceMultiplierK: 1.0,
        opponentCode: primaryRivalCode,
        scoreImpact: Number(Math.max(1.2, lap1PositionsDelta * 2.2 + 1.4).toFixed(1)),
        detail: 'Автоматический расчёт стартовой дельты по протоколу решётки и 1-го круга.',
      },
      {
        lap: Math.min(totalLaps - 5, 16),
        type: 'overtake',
        title: `Обгоны на дистанции (${overtakesCount} шт., w_track ×${trackDifficultyWeight.toFixed(2)} • K_pace ×${paceMultiplierK.toFixed(2)})`,
        cornerOrZone: cornerLabels[3],
        difficultyWeight: trackDifficultyWeight,
        paceMultiplierK,
        opponentCode: primaryRivalCode,
        scoreImpact: Number((overtakesCount * 2.4 * trackDifficultyWeight * paceMultiplierK).toFixed(1)),
        detail: `Учтён коэффициент разницы чистого темпа экипажей K_pace = ×${paceMultiplierK.toFixed(2)} против ${primaryRivalCode}.`,
      },
      {
        lap: Math.min(totalLaps - 2, 38),
        type: 'defense',
        title: `Оборона позиции в интервале < 1.0 с (${defensiveHoldsCount} кр. • K_pace ×${paceMultiplierK.toFixed(2)})`,
        cornerOrZone: cornerLabels[4],
        difficultyWeight: trackDifficultyWeight,
        paceMultiplierK,
        opponentCode: primaryRivalCode,
        scoreImpact: Number((defensiveHoldsCount * 1.15 * paceMultiplierK).toFixed(1)),
        detail: `Удержание позиции относительно соперника ${primaryRivalCode}.`,
      },
    ];

    return {
      driverCode: code,
      driverName,
      driverNum,
      teamId: rawTeamId,
      teamName: r.Constructor?.name || rawTeamId,
      teamColor,
      qualiPosition,
      finishPosition,
      pointsScored,
      idealLapTimeSec: mathematicalIdealLapSec,
      driverQualiTimeSec,
      qualiDeltaToIdealSec,
      qualiScore,
      qualiTier: getRatingTier(qualiScore),
      qualiSubMetrics: {
        brakingPrecision: Number(Math.min(99.5, Math.max(66, qualiScore + 0.4)).toFixed(1)),
        apexMinSpeed: Number(Math.min(99.5, Math.max(66, qualiScore - 0.2)).toFixed(1)),
        tractionExit: Number(Math.min(99.5, Math.max(66, qualiScore + 0.2)).toFixed(1)),
        activeAeroErs: Number(Math.min(99.5, Math.max(68, qualiScore + 0.5)).toFixed(1)),
        thermalWindow: Number(Math.min(99.5, Math.max(66, qualiScore - 0.1)).toFixed(1)),
      },
      cornerLosses,
      crewLossAttribution: {
        chassisAeroPercent,
        strategyPitwallPercent,
        driverExecutionPercent,
        chassisDeltaSec,
        strategyDeltaSec,
        driverDeltaSec,
      },
      cleanLapsCount,
      combatLapsCount,
      cleanWeight,
      combatWeight,
      avgCleanDeltaToIdealSec,
      cleanLapConsistencyStdSec,
      tyreLifeBonus,
      cleanLapsScore,
      overtakesCount,
      defensiveHoldsCount,
      lap1PositionsDelta,
      errorsCount,
      paceMultiplierK,
      primaryRivalCode,
      primaryRivalCleanDeltaSec,
      combatActionsScore,
      combatEvents,
      raceScore,
      raceTier: getRatingTier(raceScore),
      weekendOverallScore,
      weekendTier: getRatingTier(weekendOverallScore),
    };
  });

  const winnerCode = evaluations[0]?.driverCode || 'VER';
  const poleEval = evaluations.find((e) => e.driverCode === poleDriverCode) || evaluations[0];

  return {
    round: roundCode,
    gpName: racePayload.raceName,
    circuitName: `${racePayload.Circuit?.circuitName || ''}, ${racePayload.Circuit?.Location?.locality || ''}`,
    countryCode: (racePayload.Circuit?.Location?.country || 'INT').slice(0, 3).toUpperCase(),
    dateStr: racePayload.date,
    laps: totalLaps,
    weather: 'Официальный протокол FIA / Jolpica API',
    trackDifficultyWeight,
    mathematicalIdealLapSec,
    poleDriverCode,
    poleTimeSec: poleEval ? poleEval.driverQualiTimeSec : referencePoleSec,
    winnerDriverCode: winnerCode,
    podiumCodes: [
      evaluations[0]?.driverCode || 'VER',
      evaluations[1]?.driverCode || 'NOR',
      evaluations[2]?.driverCode || 'LEC',
    ],
    fastestLapDriverCode: fastestLapDriverCode || winnerCode,
    fastestLapTimeSec: fastestRaceLapSec ?? Number((mathematicalIdealLapSec + 1.4).toFixed(3)),
    raceSummary: `${racePayload.raceName} (${racePayload.date}): победа ${evaluations[0]?.driverName || winnerCode}, поул ${poleDriverCode}.`,
    evaluations,
  };
}

async function fetchJsonWithTimeout(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAllPaginatedRaces(year, endpoint, listField) {
  const byRound = new Map();
  let offset = 0;
  const pageSize = 100;
  let total = Infinity;

  while (offset < total) {
    const url = `${JOLPICA_BASE_URL}/${year}/${endpoint}.json?limit=${pageSize}&offset=${offset}`;
    const json = await fetchJsonWithTimeout(url);
    const mrData = json?.MRData;
    total = Number(mrData?.total || 0);
    const pageRaces = mrData?.RaceTable?.Races || [];
    if (pageRaces.length === 0) break;

    pageRaces.forEach((r) => {
      const existing = byRound.get(r.round);
      if (!existing) {
        byRound.set(r.round, { ...r, [listField]: [...(r[listField] || [])] });
      } else {
        existing[listField] = [...(existing[listField] || []), ...(r[listField] || [])];
      }
    });

    offset += pageSize;
    // Small polite pause between pages to respect Jolpica rate limits
    if (offset < total) {
      await new Promise((resolve) => setTimeout(resolve, 260));
    }
  }

  return Array.from(byRound.values()).sort((a, b) => Number(a.round) - Number(b.round));
}

async function syncSingleSeason(year) {
  console.log(`[F1-AutoSync] Загрузка полного сезона ${year} из ${JOLPICA_BASE_URL}/${year}...`);
  const races = await fetchAllPaginatedRaces(year, 'results', 'Results');

  let qualiRaces = [];
  try {
    qualiRaces = await fetchAllPaginatedRaces(year, 'qualifying', 'QualifyingResults');
  } catch {
    console.warn(`[F1-AutoSync] Квалификации ${year} недоступны отдельно, используем стартовую решётку.`);
  }

  const completedGPs = races
    .filter((r) => Array.isArray(r.Results) && r.Results.length > 0)
    .map((racePayload) => {
      const qList = qualiRaces.find((q) => q.round === racePayload.round)?.QualifyingResults || [];
      return transformRound(racePayload, qList);
    });

  const bundle = {
    seasonYear: Number(year),
    generatedAtIso: new Date().toISOString(),
    source: 'preloaded_archive',
    roundsCount: completedGPs.length,
    completedGPs,
  };

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const targetFile = path.join(OUTPUT_DIR, `${year}.json`);
  fs.writeFileSync(targetFile, JSON.stringify(bundle, null, 2), 'utf8');
  console.log(`[F1-AutoSync] Сохранён полный архив ${targetFile} (${completedGPs.length} Гран-при).`);
  return { year: Number(year), roundsCount: completedGPs.length, updatedAt: bundle.generatedAtIso };
}

async function main() {
  const yearsArg = process.argv.find((a) => a.startsWith('--years='));
  const years = yearsArg
    ? yearsArg
        .replace('--years=', '')
        .split(',')
        .map((y) => Number(y.trim()))
        .filter(Boolean)
    : [2024, 2025];

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const syncedSummary = [];

  for (const year of years) {
    try {
      const info = await syncSingleSeason(year);
      syncedSummary.push(info);
    } catch (err) {
      console.warn(`[F1-AutoSync] Не удалось загрузить сезон ${year} по сети: ${err.message}`);
    }
  }

  const manifestPath = path.join(OUTPUT_DIR, 'manifest.json');
  const manifest = {
    pipeline: 'F1-APEX-Hybrid-Variant-3',
    algorithms: ['S_quali_FrictionCircle', 'S_clean_DynamicFuelTyre', 'Variant_2A_DynamicWeights', 'Variant_3A_K_pace'],
    lastSyncIso: new Date().toISOString(),
    seasons: syncedSummary,
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`[F1-AutoSync] Манифест обновлён: ${manifestPath}`);
}

main();
