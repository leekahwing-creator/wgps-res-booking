"use strict";

/**
 * ADR-025 Operational Booking Segmentation Engine
 *
 * Converts legacy timetable period strings and optional resource/location
 * segments into discrete, continuous operational booking segments.
 *
 * This module is deliberately independent of Express, XML and allocation
 * concerns so it can be regression-tested as a deterministic pure service.
 */

function normaliseTime(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return "";
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) return "";
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function parsePeriodEntries(value) {
  const text = String(value || "");
  return Array.from(text.matchAll(/\bP(\d+)\s*\((\d{1,2}:\d{2})-(\d{1,2}:\d{2})\)/gi))
    .map(match => ({
      period: Number(match[1]),
      startTime: normaliseTime(match[2]),
      endTime: normaliseTime(match[3])
    }))
    .filter(entry => Number.isInteger(entry.period) && entry.period > 0 && entry.startTime && entry.endTime)
    .sort((a, b) => a.period - b.period || a.startTime.localeCompare(b.startTime));
}

function groupContinuousPeriods(entries) {
  const periods = Array.isArray(entries) ? entries : [];
  if (!periods.length) return [];

  const groups = [];
  let current = [periods[0]];

  for (let index = 1; index < periods.length; index += 1) {
    const previous = current[current.length - 1];
    const next = periods[index];
    const consecutivePeriod = next.period === previous.period + 1;
    const continuousTime = next.startTime === previous.endTime;

    if (consecutivePeriod && continuousTime) current.push(next);
    else {
      groups.push(current);
      current = [next];
    }
  }
  groups.push(current);
  return groups;
}

function buildTimeSegments(value) {
  const entries = parsePeriodEntries(value);
  const groups = groupContinuousPeriods(entries);

  return groups.map((group, index) => ({
    segmentIndex: index + 1,
    segmentTotal: groups.length,
    periodLabel: `P${group[0].period}${group.length > 1 ? `–P${group[group.length - 1].period}` : ""}`,
    periods: group.map(item => item.period),
    startTime: group[0].startTime,
    endTime: group[group.length - 1].endTime,
    segmentationReason: index === 0 ? "start of operational schedule" : "non-contiguous period boundary"
  }));
}

function withSegmentTotals(segments) {
  const list = Array.isArray(segments) ? segments : [];
  return list.map((segment, index) => ({
    ...segment,
    segmentIndex: index + 1,
    segmentTotal: list.length
  }));
}

/**
 * Pair resource/location segments with time segments without ever creating a
 * Cartesian product. A Cartesian product invents deployments that do not
 * exist in the source timetable and is prohibited by ADR-025.
 */
function pairOperationalSegments(resourceSegments, timeSegments) {
  const resources = Array.isArray(resourceSegments) ? resourceSegments.filter(Boolean) : [];
  const times = Array.isArray(timeSegments) ? timeSegments.filter(Boolean) : [];

  if (!resources.length && !times.length) {
    return { segments: [{ resourceSegment: null, timeSegment: null }], warnings: [], errors: [] };
  }
  if (!resources.length) {
    return { segments: times.map(timeSegment => ({ resourceSegment: null, timeSegment })), warnings: [], errors: [] };
  }
  if (!times.length) {
    return { segments: resources.map(resourceSegment => ({ resourceSegment, timeSegment: null })), warnings: [], errors: [] };
  }
  if (resources.length === 1) {
    return {
      segments: times.map(timeSegment => ({ resourceSegment: resources[0], timeSegment })),
      warnings: [],
      errors: []
    };
  }
  if (times.length === 1) {
    return {
      segments: resources.map(resourceSegment => ({ resourceSegment, timeSegment: times[0] })),
      warnings: ["Multiple resource deployments share one continuous time segment; each resource/location is retained as a separate operational booking."],
      errors: []
    };
  }
  if (resources.length === times.length) {
    return {
      segments: resources.map((resourceSegment, index) => ({ resourceSegment, timeSegment: times[index] })),
      warnings: ["Resource/location segments were paired sequentially with matching continuous time segments; no cross-product bookings were generated."],
      errors: []
    };
  }

  return {
    segments: [],
    warnings: [],
    errors: [
      `Ambiguous legacy segmentation: ${resources.length} resource/location segments cannot be safely paired with ${times.length} continuous time segments. Manual review is required.`
    ]
  };
}

function segmentLegacyRow({ timeslotValue, resourceSegments = [] } = {}) {
  const timeSegments = buildTimeSegments(timeslotValue);
  const pairing = pairOperationalSegments(resourceSegments, timeSegments);
  return {
    timeSegments: withSegmentTotals(timeSegments),
    operationalSegments: withSegmentTotals(pairing.segments),
    warnings: pairing.warnings,
    errors: pairing.errors
  };
}

module.exports = {
  normaliseTime,
  parsePeriodEntries,
  groupContinuousPeriods,
  buildTimeSegments,
  pairOperationalSegments,
  segmentLegacyRow
};
