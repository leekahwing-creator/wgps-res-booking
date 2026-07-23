"use strict";

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function collectAllocationResourceIds(allocation = {}) {
  const ids = asArray(allocation?.resources?.resourceId).map(String);
  asArray(allocation?.additionalResources?.resource).forEach(item => {
    asArray(item?.resources?.resourceId).forEach(id => ids.push(String(id)));
  });
  return Array.from(new Set(ids.filter(Boolean)));
}

function bookingTimesOverlap(startA, endA, startB, endB) {
  return String(startA || "") < String(endB || "") && String(endA || "") > String(startB || "");
}

function getOverlappingActiveBookings(bookings = [], request = {}, options = {}) {
  const excludeBookingId = String(options.excludeBookingId || request.excludeBookingId || "");
  return asArray(bookings).filter(booking => {
    const bookingId = String(booking?.["@_id"] || booking?.bookingId || "");
    if (excludeBookingId && bookingId === excludeBookingId) return false;
    if (["Cancelled", "Deleted"].includes(String(booking?.status || ""))) return false;
    if (String(booking?.bookingDate || "") !== String(request?.bookingDate || "")) return false;
    return bookingTimesOverlap(request?.startTime, request?.endTime, booking?.startTime, booking?.endTime);
  });
}

function getReservedResourceIds(bookings = [], request = {}, options = {}) {
  const reserved = new Set();
  getOverlappingActiveBookings(bookings, request, options).forEach(booking => {
    collectAllocationResourceIds(booking?.allocation).forEach(id => reserved.add(String(id)));
  });
  return reserved;
}

/**
 * ADR-024 Centralised Journey Engine.
 *
 * This module is the sole authority for deployment provenance, operational
 * route bundling, resource timelines, current location, next movement and
 * completed movement interpretation. Consumers must render these outputs
 * rather than independently reconstructing resource movement.
 */
function createJourneyEngine(dependencies = {}) {
  const {
    readResourcesFromXML,
    formatResourceForResponse,
    bookingRequiresDeployment,
    bookingHasDEManagedResources,
    getDEManagedAllocatedResourceIds,
    getResourceHomeLocation,
    timeToMinutes,
    normaliseDeploymentStatus,
    normaliseResourceCategory,
    getMovementTypePriority,
    buildResourceLookup,
    toArray
  } = dependencies;

  const required = {
    readResourcesFromXML, formatResourceForResponse, bookingRequiresDeployment,
    bookingHasDEManagedResources, getDEManagedAllocatedResourceIds,
    getResourceHomeLocation, timeToMinutes, normaliseDeploymentStatus,
    normaliseResourceCategory, getMovementTypePriority, buildResourceLookup,
    toArray
  };
  const missing = Object.entries(required).filter(([, value]) => typeof value !== "function").map(([name]) => name);
  if (missing.length) {
    throw new Error(`Journey Engine initialisation failed; missing dependencies: ${missing.join(", ")}`);
  }

  function buildDeploymentProvenance(bookings = []) {
    const resources = readResourcesFromXML().map(formatResourceForResponse);
    const resourceById = new Map(resources.map(resource => [String(resource.id || ""), resource]));
    const activeBookings = bookings
      .filter(booking => booking.status !== "Deleted" && booking.status !== "Cancelled")
      .filter(booking => bookingRequiresDeployment(booking))
      .filter(booking => bookingHasDEManagedResources(booking, resourceById))
      .sort((a, b) => `${a.startTime || ""} ${a.endTime || ""} ${a.location || ""}`.localeCompare(`${b.startTime || ""} ${b.endTime || ""} ${b.location || ""}`));
    const bookingsByResource = new Map();
    activeBookings.forEach(booking => {
      getDEManagedAllocatedResourceIds(booking, resourceById).forEach(resourceId => {
        if (!bookingsByResource.has(resourceId)) bookingsByResource.set(resourceId, []);
        bookingsByResource.get(resourceId).push(booking);
      });
    });
    const provenanceByBookingId = new Map();
    const DIRECT_HANDOVER_GAP_MINUTES = 30;
    bookingsByResource.forEach((resourceBookings, resourceId) => {
      const resource = resourceById.get(resourceId) || {};
      const homeLocation = getResourceHomeLocation(resource);
      resourceBookings.forEach((booking, index) => {
        const previous = index > 0 ? resourceBookings[index - 1] : null;
        const previousEnd = previous ? timeToMinutes(previous.endTime) : null;
        const currentStart = timeToMinutes(booking.startTime);
        const gapMinutes = previousEnd !== null && currentStart !== null ? currentStart - previousEnd : null;
        const directHandover = previous && gapMinutes !== null && gapMinutes >= 0 && gapMinutes <= DIRECT_HANDOVER_GAP_MINUTES && normaliseDeploymentStatus(previous) !== "Unable to Deploy";
        const pickupLocation = directHandover ? String(previous.location || homeLocation) : homeLocation;
        const bookingId = String(booking["@_id"] || booking.bookingId || "");
        if (!provenanceByBookingId.has(bookingId)) provenanceByBookingId.set(bookingId, []);
        provenanceByBookingId.get(bookingId).push({
          resourceId,
          resourceName: resource.name || resourceId,
          pickupLocation,
          destinationLocation: String(booking.location || ""),
          homeLocation,
          source: directHandover ? "Previous booking location" : "Resource home location",
          previousBookingLocation: previous?.location || "",
          previousBookingEndTime: previous?.endTime || "",
          gapMinutes: gapMinutes === null ? "" : gapMinutes
        });
      });
    });
    return provenanceByBookingId;
  }

  function normaliseOperationalBundleLegs(bundle = {}) {
    return toArray(bundle?.legs?.leg || bundle?.legs)
      .filter(Boolean)
      .map(leg => ({
        ...leg,
        resources: {
          resource: toArray(leg?.resources?.resource || leg?.resources)
        },
        linkedBookingIds: {
          bookingId: toArray(leg?.linkedBookingIds?.bookingId || leg?.linkedBookingIds)
        }
      }));
  }

  function buildOperationalBundle(bookings, anchorBooking) {
    const resources = readResourcesFromXML().map(formatResourceForResponse);
    const resourceById = new Map(resources.map(resource => [String(resource.id || ""), resource]));
    const active = bookings
      .filter(booking => booking.status !== "Deleted" && booking.status !== "Cancelled")
      .filter(booking => bookingRequiresDeployment(booking))
      .filter(booking => bookingHasDEManagedResources(booking, resourceById))
      .sort((a, b) =>
        `${a.startTime || ""} ${a.endTime || ""} ${a.location || ""}`
          .localeCompare(`${b.startTime || ""} ${b.endTime || ""} ${b.location || ""}`)
      );
  
    const anchorId = String(anchorBooking["@_id"] || "");
    const anchorStart = timeToMinutes(anchorBooking.startTime);
    const HANDOVER_GAP_MINUTES = 30;
    const resourceBookings = new Map();
  
    active.forEach(booking => {
      getDEManagedAllocatedResourceIds(booking, resourceById).forEach(resourceId => {
        if (!resourceBookings.has(resourceId)) resourceBookings.set(resourceId, []);
        resourceBookings.get(resourceId).push(booking);
      });
    });
  
    const anchorResourceIds = getDEManagedAllocatedResourceIds(anchorBooking, resourceById);
    const anchorPickupByResource = new Map();
  
    anchorResourceIds.forEach(resourceId => {
      const sequence = resourceBookings.get(resourceId) || [];
      const anchorIndex = sequence.findIndex(booking => String(booking["@_id"]) === anchorId);
      const resource = resourceById.get(resourceId) || {};
      const home = getResourceHomeLocation(resource);
      let pickupLocation = home;
  
      if (anchorIndex > 0) {
        const previous = sequence[anchorIndex - 1];
        const previousEnd = timeToMinutes(previous.endTime);
        const gap = previousEnd !== null && anchorStart !== null ? anchorStart - previousEnd : null;
        if (gap !== null && gap >= 0 && gap <= HANDOVER_GAP_MINUTES) {
          pickupLocation = String(previous.location || home);
        }
      }
  
      anchorPickupByResource.set(resourceId, pickupLocation);
    });
  
    const anchorPickupLocations = new Set(
      Array.from(anchorPickupByResource.values()).filter(Boolean)
    );
    const candidateResources = [];
  
    resourceBookings.forEach((sequence, resourceId) => {
      const resource = resourceById.get(resourceId) || {};
      const homeLocation = getResourceHomeLocation(resource);
      const isAnchorResource = anchorResourceIds.includes(resourceId);
  
      let previousIndex = -1;
      sequence.forEach((booking, index) => {
        const end = timeToMinutes(booking.endTime);
        if (end !== null && anchorStart !== null && end <= anchorStart) previousIndex = index;
      });
  
      if (isAnchorResource) {
        const pickupLocation = anchorPickupByResource.get(resourceId) || homeLocation;
        const previous = previousIndex >= 0 && String(sequence[previousIndex]?.location || "") === String(pickupLocation)
          ? sequence[previousIndex]
          : null;
        candidateResources.push({
          resourceId,
          resourceName: resource.name || resourceId,
          category: normaliseResourceCategory(resource.category),
          homeLocation,
          pickupLocation,
          previousBooking: previous,
          nextBooking: anchorBooking
        });
        return;
      }
  
      if (previousIndex < 0) return;
      const previous = sequence[previousIndex];
      const pickupLocation = String(previous.location || homeLocation);
      if (!anchorPickupLocations.has(pickupLocation)) return;
  
      candidateResources.push({
        resourceId,
        resourceName: resource.name || resourceId,
        category: normaliseResourceCategory(resource.category),
        homeLocation,
        pickupLocation,
        previousBooking: previous,
        nextBooking: sequence[previousIndex + 1] || null
      });
    });
  
    // Defensive inclusion for any anchor resource omitted from the booking index.
    anchorResourceIds.forEach(resourceId => {
      if (candidateResources.some(item => item.resourceId === resourceId)) return;
      const resource = resourceById.get(resourceId) || {};
      candidateResources.push({
        resourceId,
        resourceName: resource.name || resourceId,
        category: normaliseResourceCategory(resource.category),
        homeLocation: getResourceHomeLocation(resource),
        pickupLocation: anchorPickupByResource.get(resourceId) || getResourceHomeLocation(resource),
        previousBooking: null,
        nextBooking: anchorBooking
      });
    });
  
    const grouped = new Map();
  
    candidateResources.forEach(item => {
      const next = item.nextBooking;
      const previousEnd = item.previousBooking ? timeToMinutes(item.previousBooking.endTime) : null;
      const nextStart = next ? timeToMinutes(next.startTime) : null;
      const gap = previousEnd !== null && nextStart !== null ? nextStart - previousEnd : null;
      const canDirectTransfer = next && (
        // Every anchor resource is required for the anchor booking, including
        // resources collected from home where no previous booking exists.
        String(next["@_id"] || "") === anchorId ||
        (gap !== null && gap >= 0 && gap <= HANDOVER_GAP_MINUTES)
      );
  
      const type = canDirectTransfer ? "Deployment" : "Return";
      const movementClass = canDirectTransfer
        ? (item.previousBooking ? "Direct Transfer" : "Deployment")
        : "Recovery Return";
      const destination = canDirectTransfer
        ? String(next.location || item.homeLocation)
        : item.homeLocation;
      const requiredTime = canDirectTransfer
        ? String(next.startTime || anchorBooking.startTime || "")
        : "";
      const returnReason = !canDirectTransfer
        ? (next
            ? `Return during the gap before the next booking at ${String(next.startTime || "a later time")}.`
            : "No further booking is scheduled for this resource on the selected date.")
        : "";
      const linkedBookingId = canDirectTransfer ? String(next["@_id"] || "") : "";
      const containsDevice = item.category !== "Accessory";
      const key = `${movementClass}|${requiredTime}|${destination}`;
  
      if (!grouped.has(key)) {
        grouped.set(key, {
          legId: `LEG-${grouped.size + 1}`,
          destination,
          type,
          movementClass,
          requiredTime,
          returnReason,
          status: "Pending",
          containsDevice,
          resources: { resource: [] },
          linkedBookingIds: { bookingId: [] }
        });
      }
  
      const leg = grouped.get(key);
      leg.containsDevice = leg.containsDevice || containsDevice;
      leg.resources.resource.push({
        resourceId: item.resourceId,
        resourceName: item.resourceName,
        category: item.category,
        pickupLocation: item.pickupLocation
      });
      if (linkedBookingId && !leg.linkedBookingIds.bookingId.includes(linkedBookingId)) {
        leg.linkedBookingIds.bookingId.push(linkedBookingId);
      }
    });
  
    const routeClassPriority = movementClass => {
      if (movementClass === "Deployment") return 1;
      if (movementClass === "Direct Transfer") return 2;
      return 3;
    };
  
    const legs = Array.from(grouped.values())
      .sort((a, b) => {
        const classCompare = routeClassPriority(a.movementClass) - routeClassPriority(b.movementClass);
        if (classCompare !== 0) return classCompare;
        const timeCompare = String(a.requiredTime || "99:99").localeCompare(String(b.requiredTime || "99:99"));
        if (timeCompare !== 0) return timeCompare;
        const deviceCompare = Number(!a.containsDevice) - Number(!b.containsDevice);
        if (deviceCompare !== 0) return deviceCompare;
        const typeCompare = getMovementTypePriority(a.type) - getMovementTypePriority(b.type);
        if (typeCompare !== 0) return typeCompare;
        return String(a.destination).localeCompare(String(b.destination));
      })
      .map((leg, index) => ({ ...leg, legId: `LEG-${index + 1}`, routeOrder: index + 1 }));
  
    const pickupLocations = Array.from(new Set(
      candidateResources.map(item => item.pickupLocation).filter(Boolean)
    ));
    const pickupLocationSummary = pickupLocations.length
      ? pickupLocations.join(" + ")
      : "ICT Room";
  
    return {
      bundleId: `BUNDLE-${Date.now()}-${anchorId}`,
      status: "Active",
      anchorBookingId: anchorId,
      // Retained for backwards compatibility. New clients should use the
      // resource-specific manifest and pickupLocations.
      pickupLocation: pickupLocationSummary,
      pickupLocations: { location: pickupLocations },
      pickupLocationSummary,
      claimedAt: new Date().toISOString(),
      resourcesToCollect: {
        resource: candidateResources.map(item => ({
          resourceId: item.resourceId,
          resourceName: item.resourceName,
          category: item.category,
          pickupLocation: item.pickupLocation
        }))
      },
      legs: { leg: legs }
    };
  }

  function getBundleLinkedBookingIds(bundle = {}) {
    return Array.from(new Set(
      normaliseOperationalBundleLegs(bundle)
        .flatMap(leg => toArray(leg.linkedBookingIds?.bookingId))
        .map(String)
        .filter(Boolean)
    ));
  }

  function getCompletedResourceMovements(bookings = [], resourceById = buildResourceLookup()) {
    const completedByResource = new Map();
  
    const recordMovement = (resourceId, movement) => {
      const id = String(resourceId || "").trim();
      if (!id || !movement?.destination) return;
  
      const existing = completedByResource.get(id);
      const movementTime = Date.parse(movement.completedAt || "") || 0;
      const existingTime = Date.parse(existing?.completedAt || "") || 0;
  
      if (!existing || movementTime >= existingTime) {
        completedByResource.set(id, movement);
      }
    };
  
    bookings.forEach(booking => {
      normaliseOperationalBundleLegs(booking.operationalBundle).forEach(leg => {
        if (String(leg.status || "") !== "Completed") return;
  
        toArray(leg.resources?.resource).forEach(resource => {
          recordMovement(resource?.resourceId, {
            destination: String(leg.destination || "").trim(),
            movementClass: String(leg.movementClass || leg.type || "").trim(),
            completedAt: String(leg.completedAt || booking.operationalBundle?.completedAt || ""),
            bookingId: String(booking["@_id"] || booking.bookingId || ""),
            source: "Operational route leg"
          });
        });
      });
  
      // Preserve compatibility with legacy/single-job completion records that do
      // not have an operational bundle leg. A completed deployment means the
      // allocated DE-managed resources physically reached the booking location.
      if (!booking.operationalBundle && normaliseDeploymentStatus(booking) === "Deployed") {
        getDEManagedAllocatedResourceIds(booking, resourceById).forEach(resourceId => {
          recordMovement(resourceId, {
            destination: String(booking.location || "").trim(),
            movementClass: "Deployment",
            completedAt: String(booking.deployedAt || ""),
            bookingId: String(booking["@_id"] || booking.bookingId || ""),
            source: "Completed deployment job"
          });
        });
      }
    });
  
    return completedByResource;
  }

  function buildOperationalTimelineAndJourneys(bookings = [], bookingDate = "") {
    const resourceById = buildResourceLookup();
    const completedResourceMovements = getCompletedResourceMovements(bookings, resourceById);
    const DIRECT_HANDOVER_GAP_MINUTES = 30;
    const bookingsByResource = new Map();
  
    bookings
      .filter(booking => booking.status !== "Deleted" && booking.status !== "Cancelled")
      .filter(booking => bookingRequiresDeployment(booking))
      .filter(booking => bookingHasDEManagedResources(booking, resourceById))
      .forEach(booking => {
        getDEManagedAllocatedResourceIds(booking, resourceById).forEach(resourceId => {
          if (!bookingsByResource.has(resourceId)) bookingsByResource.set(resourceId, []);
          bookingsByResource.get(resourceId).push(booking);
        });
      });
  
    bookingsByResource.forEach(sequence => {
      sequence.sort((a, b) =>
        `${a.startTime || ""} ${a.endTime || ""}`
          .localeCompare(`${b.startTime || ""} ${b.endTime || ""}`)
      );
    });
  
    const timelineEvents = [];
    const journeys = [];
    const now = new Date();
    const todayKey = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0")
    ].join("-");
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const relation = bookingDate < todayKey ? "past" : bookingDate > todayKey ? "future" : "today";
  
    bookingsByResource.forEach((sequence, resourceId) => {
      const resource = resourceById.get(resourceId) || {};
      const resourceName = resource.name || resourceId;
      const category = normaliseResourceCategory(resource.category);
      const homeLocation = getResourceHomeLocation(resource);
      const steps = [{
        sequence: 0,
        time: "",
        type: "Ready",
        fromLocation: "",
        location: homeLocation,
        status: relation === "past" ? "Completed" : "Ready",
        bookingId: "",
        bookingStatus: "",
        note: "Resource home location"
      }];
  
      sequence.forEach((booking, index) => {
        const previous = index > 0 ? sequence[index - 1] : null;
        const next = index < sequence.length - 1 ? sequence[index + 1] : null;
        const previousEnd = previous ? timeToMinutes(previous.endTime) : null;
        const start = timeToMinutes(booking.startTime);
        const end = timeToMinutes(booking.endTime);
        const nextStart = next ? timeToMinutes(next.startTime) : null;
        const pickupLocation =
          previous &&
          previousEnd !== null &&
          start !== null &&
          start - previousEnd >= 0 &&
          start - previousEnd <= DIRECT_HANDOVER_GAP_MINUTES
            ? String(previous.location || homeLocation)
            : homeLocation;
  
        const deploymentStatus = normaliseDeploymentStatus(booking);
        let movementStatus = "Upcoming";
        if (deploymentStatus === "Deployed") movementStatus = "Completed";
        else if (deploymentStatus === "Unable to Deploy") movementStatus = "Exception";
        else if (deploymentStatus === "Claimed") movementStatus = "Active";
        else if (relation === "past" || (relation === "today" && end !== null && currentMinutes > end)) {
          movementStatus = "Overdue";
        } else if (relation === "today" && start !== null && currentMinutes >= start && currentMinutes <= (end ?? start)) {
          movementStatus = "Due now";
        }
  
        const movementType = pickupLocation === homeLocation ? "Deployment" : "Direct Transfer";
        const bookingId = String(booking["@_id"] || booking.bookingId || "");
  
        timelineEvents.push({
          eventId: `${resourceId}-DEPLOY-${index + 1}`,
          time: String(booking.startTime || ""),
          endTime: String(booking.endTime || ""),
          type: movementType,
          fromLocation: pickupLocation,
          toLocation: String(booking.location || ""),
          status: movementStatus,
          resourceId,
          resourceName,
          category,
          bookingId,
          requesterName: booking.requesterName || "",
          note: movementType === "Direct Transfer"
            ? "Move directly from the previous booking location."
            : "Collect from the resource home location."
        });
  
        steps.push({
          sequence: steps.length,
          time: String(booking.startTime || ""),
          endTime: String(booking.endTime || ""),
          type: movementType,
          fromLocation: pickupLocation,
          location: String(booking.location || ""),
          status: movementStatus,
          bookingId,
          bookingStatus: deploymentStatus,
          note: booking.requesterName ? `Requested by ${booking.requesterName}` : ""
        });
  
        const gapToNext =
          nextStart !== null && end !== null
            ? nextStart - end
            : null;
        const directToNext =
          next &&
          gapToNext !== null &&
          gapToNext >= 0 &&
          gapToNext <= DIRECT_HANDOVER_GAP_MINUTES;
  
        if (!directToNext) {
          let returnStatus = "Upcoming";
          const completedMovement = completedResourceMovements.get(resourceId);
          const completedThisReturn =
            completedMovement &&
            completedMovement.movementClass === "Recovery Return" &&
            String(completedMovement.bookingId || "") === bookingId &&
            String(completedMovement.destination || "") === String(homeLocation);
          if (completedThisReturn) returnStatus = "Completed";
          else if (relation === "past") returnStatus = "Overdue";
          else if (relation === "today" && end !== null && currentMinutes > end) returnStatus = "Awaiting Return";
  
          timelineEvents.push({
            eventId: `${resourceId}-RETURN-${index + 1}`,
            time: String(booking.endTime || ""),
            endTime: "",
            type: "Recovery Return",
            fromLocation: String(booking.location || ""),
            toLocation: homeLocation,
            status: returnStatus,
            resourceId,
            resourceName,
            category,
            bookingId,
            requesterName: booking.requesterName || "",
            note: next
              ? `Return during the gap before the next booking at ${next.startTime}.`
              : "No further booking is scheduled for this resource on the selected date."
          });
  
          steps.push({
            sequence: steps.length,
            time: String(booking.endTime || ""),
            type: "Recovery Return",
            fromLocation: String(booking.location || ""),
            location: homeLocation,
            status: returnStatus,
            bookingId,
            bookingStatus: deploymentStatus,
            note: next
              ? `Long gap before next booking at ${next.startTime}.`
              : "End of today's deployment journey."
          });
        }
      });
  
      let currentStep = steps[0];
      if (relation === "past") {
        currentStep = steps[steps.length - 1] || steps[0];
      } else if (relation === "future") {
        currentStep = steps[0];
      } else {
        steps.forEach(step => {
          const stepMinutes = timeToMinutes(step.time);
          if (stepMinutes !== null && stepMinutes <= currentMinutes) {
            currentStep = step;
          }
        });
      }
  
      // Derive physical location from this resource journey's ordered completed
      // steps. This keeps the journey header consistent with the last completed
      // job shown in the drawer and prevents an unrelated/stale movement record
      // from resetting the resource to its home location.
      const latestCompletedStep = [...steps]
        .reverse()
        .find(step =>
          step.status === "Completed" &&
          ["Deployment", "Direct Transfer", "Recovery Return"].includes(step.type)
        ) || null;
  
      const completedMovement = latestCompletedStep
        ? {
            destination: latestCompletedStep.location,
            movementClass: latestCompletedStep.type,
            bookingId: latestCompletedStep.bookingId,
            completedAt: "",
            source: "Completed journey step"
          }
        : null;
  
      const actualLocation =
        relation !== "future" && latestCompletedStep?.location
          ? latestCompletedStep.location
          : homeLocation;
  
      let operationalStatus = "Ready";
      if (currentStep.status === "Exception") operationalStatus = "Exception";
      else if (currentStep.status === "Overdue") operationalStatus = "Overdue";
      else if (latestCompletedStep?.type === "Recovery Return" && actualLocation === homeLocation) operationalStatus = "Ready";
      else if (latestCompletedStep && actualLocation !== homeLocation) operationalStatus = "Deployed";
      else if (currentStep.type === "Recovery Return" && currentStep.status !== "Completed") operationalStatus = "Awaiting Return";
      else if (currentStep.type === "Direct Transfer" && currentStep.status !== "Completed") operationalStatus = "Direct Transfer";
      else if (currentStep.type === "Deployment" && currentStep.location !== homeLocation) operationalStatus = "Deployed";
      else if (currentStep.status === "Active" || currentStep.status === "Due now") operationalStatus = "In Transit";
  
      // The summary card's "Next" item must follow operational progress, not
      // merely the clock. Completed steps are skipped even when their scheduled
      // time is still the earliest matching time. This keeps the summary aligned
      // with the detailed journey drawer after jobs are completed early or late.
      const nextStep = relation === "past"
        ? null
        : steps.find(step =>
            ["Deployment", "Direct Transfer", "Recovery Return"].includes(step.type) &&
            step.status !== "Completed"
          ) || null;
  
      journeys.push({
        resourceId,
        resourceName,
        category,
        homeLocation,
        currentExpectedLocation: actualLocation,
        locationEvidence: completedMovement || null,
        operationalStatus,
        currentStep,
        nextStep,
        steps
      });
    });
  
    const groupedTimeline = new Map();
  
    timelineEvents.forEach(event => {
      const key = [
        event.time,
        event.type,
        event.fromLocation,
        event.toLocation,
        event.status
      ].join("|");
  
      if (!groupedTimeline.has(key)) {
        groupedTimeline.set(key, {
          ...event,
          eventId: `EVT-${groupedTimeline.size + 1}`,
          resources: []
        });
        delete groupedTimeline.get(key).resourceId;
        delete groupedTimeline.get(key).resourceName;
        delete groupedTimeline.get(key).category;
      }
  
      groupedTimeline.get(key).resources.push({
        resourceId: event.resourceId,
        resourceName: event.resourceName,
        category: event.category
      });
    });
  
    const timeline = Array.from(groupedTimeline.values())
      .sort((a, b) => {
        const timeCompare = String(a.time || "99:99").localeCompare(String(b.time || "99:99"));
        if (timeCompare !== 0) return timeCompare;
        const priority = type => {
          if (type === "Deployment") return 1;
          if (type === "Direct Transfer") return 2;
          return 3;
        };
        return priority(a.type) - priority(b.type);
      });
  
    const summary = {
      totalResources: journeys.length,
      ready: journeys.filter(item => item.operationalStatus === "Ready").length,
      deployed: journeys.filter(item => item.operationalStatus === "Deployed").length,
      inTransit: journeys.filter(item => item.operationalStatus === "In Transit").length,
      directTransfer: journeys.filter(item => item.operationalStatus === "Direct Transfer").length,
      awaitingReturn: journeys.filter(item => item.operationalStatus === "Awaiting Return").length,
      overdue: journeys.filter(item => item.operationalStatus === "Overdue").length,
      exceptions: journeys.filter(item => item.operationalStatus === "Exception").length,
      completedEvents: timeline.filter(item => item.status === "Completed").length,
      upcomingEvents: timeline.filter(item => ["Upcoming", "Due now", "Active"].includes(item.status)).length
    };
  
    return {
      timeline,
      resourceJourneys: journeys.sort((a, b) => a.resourceName.localeCompare(b.resourceName)),
      summary
    };
  }

  /**
   * ADR-024 Phase 3.1 — Journey Chain Optimisation Engine.
   *
   * Builds deterministic resource-continuity chains without mutating booking
   * records. A chain begins at the resource home location, follows eligible
   * sequential bookings, and ends with a recovery return. Chain breaks remain
   * explicit and auditable so Operations Centre consumers can explain why an
   * otherwise sequential booking was not linked.
   */
  function buildJourneyChains(bookings = [], bookingDate = "", options = {}) {
    const resources = readResourcesFromXML().map(formatResourceForResponse);
    const resourceById = new Map(resources.map(resource => [String(resource.id || ""), resource]));
    const maximumIdleGapMinutes = Number.isFinite(Number(options.maximumIdleGapMinutes))
      ? Math.max(0, Number(options.maximumIdleGapMinutes))
      : 30;
    const minimumTransferMinutes = Number.isFinite(Number(options.minimumTransferMinutes))
      ? Math.max(0, Number(options.minimumTransferMinutes))
      : 0;

    const active = toArray(bookings)
      .filter(booking => booking.status !== "Deleted" && booking.status !== "Cancelled")
      .filter(booking => !bookingDate || String(booking.bookingDate || "") === String(bookingDate))
      .filter(booking => bookingRequiresDeployment(booking))
      .filter(booking => bookingHasDEManagedResources(booking, resourceById));

    const byResource = new Map();
    active.forEach(booking => {
      getDEManagedAllocatedResourceIds(booking, resourceById).forEach(resourceId => {
        const id = String(resourceId || "");
        if (!id) return;
        if (!byResource.has(id)) byResource.set(id, []);
        byResource.get(id).push(booking);
      });
    });

    const chains = [];
    const auditEvents = [];
    const rejectedLinks = [];

    const bookingIdOf = booking => String(booking?.["@_id"] || booking?.bookingId || "");
    const hasManualBreak = booking => {
      const values = [
        booking?.journeyChainBreak,
        booking?.manualJourneyBreak,
        booking?.operationalOverride?.breakJourneyChain,
        booking?.journeyOverride?.breakChain
      ];
      return values.some(value => value === true || String(value || "").toLowerCase() === "true");
    };

    const confidenceForLink = (gapMinutes, sameLocation) => {
      if (gapMinutes === 0) return { level: "High", score: 100, reason: "Back-to-back bookings for the same physical resource." };
      if (gapMinutes <= Math.min(15, maximumIdleGapMinutes)) {
        return { level: "High", score: 95, reason: sameLocation ? "Short idle gap at the same location." : "Short transfer gap within the direct-handover policy." };
      }
      if (gapMinutes <= maximumIdleGapMinutes) {
        return { level: "Medium", score: 80, reason: "Sequential bookings remain within the configured idle-gap policy." };
      }
      return { level: "Low", score: 40, reason: "Gap exceeds the configured chaining policy." };
    };

    byResource.forEach((sequence, resourceId) => {
      sequence.sort((a, b) => {
        const timeCompare = `${a.startTime || ""} ${a.endTime || ""}`.localeCompare(`${b.startTime || ""} ${b.endTime || ""}`);
        if (timeCompare !== 0) return timeCompare;
        return bookingIdOf(a).localeCompare(bookingIdOf(b));
      });

      const resource = resourceById.get(resourceId) || {};
      const resourceName = resource.name || resourceId;
      const homeLocation = getResourceHomeLocation(resource);
      let currentChain = null;

      const startChain = (booking, index, reason) => {
        const chainId = `JC-${String(resourceId).replace(/[^A-Za-z0-9_-]/g, "-")}-${String(chains.length + 1).padStart(3, "0")}`;
        currentChain = {
          chainId,
          bookingDate: String(booking.bookingDate || bookingDate || ""),
          resourceId,
          resourceName,
          homeLocation,
          status: "Optimised",
          startReason: reason,
          confidence: { level: "High", score: 100, reason: "Physical resource identity is authoritative." },
          nodes: [],
          links: [],
          movements: [],
          auditTrail: []
        };
        chains.push(currentChain);
        const event = {
          auditId: `JCA-${String(auditEvents.length + 1).padStart(5, "0")}`,
          eventType: "CHAIN_CREATED",
          chainId,
          resourceId,
          bookingId: bookingIdOf(booking),
          reason,
          sequenceIndex: index + 1
        };
        auditEvents.push(event);
        currentChain.auditTrail.push(event);
      };

      sequence.forEach((booking, index) => {
        const bookingId = bookingIdOf(booking);
        const node = {
          nodeId: `${resourceId}-NODE-${index + 1}`,
          sequence: 0,
          bookingId,
          startTime: String(booking.startTime || ""),
          endTime: String(booking.endTime || ""),
          location: String(booking.location || ""),
          deploymentStatus: normaliseDeploymentStatus(booking)
        };

        if (!currentChain) {
          startChain(booking, index, "First eligible booking for the resource on the selected date.");
          node.sequence = 1;
          currentChain.nodes.push(node);
          currentChain.movements.push({
            movementClass: "Deployment",
            fromLocation: homeLocation,
            toLocation: node.location,
            requiredTime: node.startTime,
            bookingId
          });
          return;
        }

        const previous = sequence[index - 1];
        const previousId = bookingIdOf(previous);
        const previousEnd = timeToMinutes(previous?.endTime);
        const currentStart = timeToMinutes(booking.startTime);
        const gapMinutes = previousEnd !== null && currentStart !== null ? currentStart - previousEnd : null;
        const sameLocation = String(previous?.location || "") === String(booking.location || "");
        const manualBreak = hasManualBreak(previous) || hasManualBreak(booking);
        const previousFailed = normaliseDeploymentStatus(previous) === "Unable to Deploy";

        let eligible = true;
        let breakCode = "";
        let breakReason = "";

        if (gapMinutes === null) {
          eligible = false;
          breakCode = "INVALID_TIME";
          breakReason = "Booking times could not be interpreted safely.";
        } else if (gapMinutes < 0) {
          eligible = false;
          breakCode = "OVERLAP";
          breakReason = "Bookings overlap and cannot form a sequential journey chain.";
        } else if (manualBreak) {
          eligible = false;
          breakCode = "MANUAL_OVERRIDE";
          breakReason = "A manual operational override requires the chain to break.";
        } else if (previousFailed) {
          eligible = false;
          breakCode = "FAILED_PREVIOUS_DEPLOYMENT";
          breakReason = "The previous deployment did not complete, so its destination cannot be used as a pickup location.";
        } else if (gapMinutes > maximumIdleGapMinutes) {
          eligible = false;
          breakCode = "IDLE_GAP_EXCEEDED";
          breakReason = `Idle gap of ${gapMinutes} minutes exceeds the ${maximumIdleGapMinutes}-minute policy.`;
        } else if (!sameLocation && gapMinutes < minimumTransferMinutes) {
          eligible = false;
          breakCode = "INSUFFICIENT_TRANSFER_TIME";
          breakReason = `Transfer gap of ${gapMinutes} minutes is below the ${minimumTransferMinutes}-minute minimum.`;
        }

        if (!eligible) {
          currentChain.movements.push({
            movementClass: "Recovery Return",
            fromLocation: String(previous?.location || ""),
            toLocation: homeLocation,
            requiredTime: String(previous?.endTime || ""),
            bookingId: previousId,
            reason: breakReason
          });
          const rejection = {
            auditId: `JCA-${String(auditEvents.length + 1).padStart(5, "0")}`,
            eventType: "CHAIN_LINK_REJECTED",
            chainId: currentChain.chainId,
            resourceId,
            previousBookingId: previousId,
            nextBookingId: bookingId,
            gapMinutes,
            code: breakCode,
            reason: breakReason
          };
          auditEvents.push(rejection);
          rejectedLinks.push(rejection);
          currentChain.auditTrail.push(rejection);

          startChain(booking, index, breakReason);
          node.sequence = 1;
          currentChain.nodes.push(node);
          currentChain.movements.push({
            movementClass: "Deployment",
            fromLocation: homeLocation,
            toLocation: node.location,
            requiredTime: node.startTime,
            bookingId
          });
          return;
        }

        const confidence = confidenceForLink(gapMinutes, sameLocation);
        const link = {
          linkId: `${currentChain.chainId}-LINK-${currentChain.links.length + 1}`,
          previousBookingId: previousId,
          nextBookingId: bookingId,
          fromLocation: String(previous?.location || homeLocation),
          toLocation: node.location,
          gapMinutes,
          movementClass: sameLocation ? "Resource Continuity" : "Direct Transfer",
          confidence
        };
        currentChain.links.push(link);
        node.sequence = currentChain.nodes.length + 1;
        currentChain.nodes.push(node);
        currentChain.movements.push({
          movementClass: link.movementClass,
          fromLocation: link.fromLocation,
          toLocation: link.toLocation,
          requiredTime: node.startTime,
          bookingId,
          gapMinutes
        });
        if (confidence.score < currentChain.confidence.score) currentChain.confidence = confidence;

        const event = {
          auditId: `JCA-${String(auditEvents.length + 1).padStart(5, "0")}`,
          eventType: "CHAIN_LINK_CREATED",
          chainId: currentChain.chainId,
          resourceId,
          previousBookingId: previousId,
          nextBookingId: bookingId,
          gapMinutes,
          movementClass: link.movementClass,
          confidence: confidence.level,
          reason: confidence.reason,
          estimatedMovementsSaved: 1
        };
        auditEvents.push(event);
        currentChain.auditTrail.push(event);
      });

      if (currentChain && currentChain.nodes.length) {
        const lastNode = currentChain.nodes[currentChain.nodes.length - 1];
        currentChain.movements.push({
          movementClass: "Recovery Return",
          fromLocation: lastNode.location,
          toLocation: homeLocation,
          requiredTime: lastNode.endTime,
          bookingId: lastNode.bookingId,
          reason: "End of journey chain."
        });
      }
    });

    chains.forEach(chain => {
      chain.bookingCount = chain.nodes.length;
      chain.directTransfers = chain.links.filter(link => link.movementClass === "Direct Transfer").length;
      chain.continuityLinks = chain.links.length;
      chain.avoidedReturns = chain.links.length;
      chain.estimatedMovementsSaved = chain.links.length;
    });

    return {
      bookingDate,
      policy: {
        maximumIdleGapMinutes,
        minimumTransferMinutes,
        mutationMode: "Advisory only",
        sourceOfTruth: "ADR-024 Journey Engine"
      },
      summary: {
        resourcesAnalysed: byResource.size,
        bookingsAnalysed: active.length,
        chainsCreated: chains.length,
        linksCreated: chains.reduce((sum, chain) => sum + chain.links.length, 0),
        rejectedLinks: rejectedLinks.length,
        avoidedReturns: chains.reduce((sum, chain) => sum + chain.avoidedReturns, 0),
        estimatedMovementsSaved: chains.reduce((sum, chain) => sum + chain.estimatedMovementsSaved, 0)
      },
      chains,
      rejectedLinks,
      auditTrail: auditEvents
    };
  }

  /**
   * ADR-024 Phase 3 — Intelligent Journey Optimisation.
   *
   * Produces an advisory, deterministic optimisation plan from the same
   * authoritative booking and resource data used by the operational journey.
   * It does not mutate bookings or allocations. Consumers may use the output
   * to explain avoided returns, direct-transfer chains and multi-location
   * collection work before an operational route is claimed.
   */
  function buildOptimizationPlan(bookings = [], bookingDate = "", options = {}) {
    const resources = readResourcesFromXML().map(formatResourceForResponse);
    const resourceById = new Map(resources.map(resource => [String(resource.id || ""), resource]));
    const directTransferWindowMinutes = Number.isFinite(Number(options.directTransferWindowMinutes))
      ? Math.max(0, Number(options.directTransferWindowMinutes))
      : 30;

    const active = toArray(bookings)
      .filter(booking => booking.status !== "Deleted" && booking.status !== "Cancelled")
      .filter(booking => !bookingDate || String(booking.bookingDate || "") === String(bookingDate))
      .filter(booking => bookingRequiresDeployment(booking))
      .filter(booking => bookingHasDEManagedResources(booking, resourceById));

    const byResource = new Map();
    active.forEach(booking => {
      getDEManagedAllocatedResourceIds(booking, resourceById).forEach(resourceId => {
        if (!byResource.has(resourceId)) byResource.set(resourceId, []);
        byResource.get(resourceId).push(booking);
      });
    });

    const resourcePlans = [];
    const opportunities = [];
    let baselineMovements = 0;
    let optimisedMovements = 0;
    let avoidedReturns = 0;
    let directTransfers = 0;

    byResource.forEach((sequence, resourceId) => {
      sequence.sort((a, b) => `${a.startTime || ""} ${a.endTime || ""}`.localeCompare(`${b.startTime || ""} ${b.endTime || ""}`));
      const resource = resourceById.get(resourceId) || {};
      const homeLocation = getResourceHomeLocation(resource);
      const movements = [];

      sequence.forEach((booking, index) => {
        const previous = index > 0 ? sequence[index - 1] : null;
        const previousEnd = previous ? timeToMinutes(previous.endTime) : null;
        const currentStart = timeToMinutes(booking.startTime);
        const gapMinutes = previousEnd !== null && currentStart !== null ? currentStart - previousEnd : null;
        const canTransfer = Boolean(previous) && gapMinutes !== null && gapMinutes >= 0 && gapMinutes <= directTransferWindowMinutes;
        const fromLocation = canTransfer ? String(previous.location || homeLocation) : homeLocation;
        const movementClass = canTransfer ? "Direct Transfer" : "Deployment";

        baselineMovements += previous ? 2 : 1;
        optimisedMovements += 1;
        if (canTransfer) {
          avoidedReturns += 1;
          directTransfers += 1;
          opportunities.push({
            type: "AVOID_RETURN",
            resourceId,
            resourceName: resource.name || resourceId,
            fromLocation,
            toLocation: String(booking.location || ""),
            previousBookingId: String(previous?.["@_id"] || previous?.bookingId || ""),
            nextBookingId: String(booking?.["@_id"] || booking?.bookingId || ""),
            gapMinutes,
            estimatedMovementsSaved: 1
          });
        }

        movements.push({
          sequence: index + 1,
          movementClass,
          fromLocation,
          toLocation: String(booking.location || ""),
          requiredTime: String(booking.startTime || ""),
          bookingId: String(booking?.["@_id"] || booking?.bookingId || ""),
          gapMinutes: gapMinutes === null ? null : gapMinutes
        });
      });

      if (sequence.length) {
        baselineMovements += 1;
        optimisedMovements += 1;
        const last = sequence[sequence.length - 1];
        movements.push({
          sequence: movements.length + 1,
          movementClass: "Recovery Return",
          fromLocation: String(last.location || ""),
          toLocation: homeLocation,
          requiredTime: String(last.endTime || ""),
          bookingId: String(last?.["@_id"] || last?.bookingId || ""),
          gapMinutes: null
        });
      }

      resourcePlans.push({
        resourceId,
        resourceName: resource.name || resourceId,
        homeLocation,
        bookingCount: sequence.length,
        directTransfers: movements.filter(item => item.movementClass === "Direct Transfer").length,
        movements
      });
    });

    const estimatedMovementReduction = Math.max(0, baselineMovements - optimisedMovements);
    const estimatedReductionPercent = baselineMovements
      ? Math.round((estimatedMovementReduction / baselineMovements) * 100)
      : 0;

    const journeyChains = buildJourneyChains(bookings, bookingDate, {
      maximumIdleGapMinutes: directTransferWindowMinutes,
      minimumTransferMinutes: options.minimumTransferMinutes
    });

    return {
      bookingDate,
      policy: {
        directTransferWindowMinutes,
        mutationMode: "Advisory only",
        sourceOfTruth: "ADR-024 Journey Engine"
      },
      summary: {
        resourcesAnalysed: resourcePlans.length,
        bookingsAnalysed: active.length,
        baselineMovements,
        optimisedMovements,
        estimatedMovementReduction,
        estimatedReductionPercent,
        avoidedReturns,
        directTransfers,
        opportunities: opportunities.length
      },
      opportunities,
      resourcePlans: resourcePlans.sort((a, b) => String(a.resourceName).localeCompare(String(b.resourceName))),
      journeyChains
    };
  }


  /**
   * ADR-024 Phase 4 — Journey Validation.
   *
   * Validates the authoritative daily journey model without mutating bookings.
   * Findings are deliberately classified so consumers can distinguish hard
   * contradictions from operational warnings and advisory observations.
   */
  function buildValidationReport(bookings = [], bookingDate = "", options = {}) {
    const resources = readResourcesFromXML().map(formatResourceForResponse);
    const resourceById = new Map(resources.map(resource => [String(resource.id || ""), resource]));
    const minimumTransferMinutes = Number.isFinite(Number(options.minimumTransferMinutes))
      ? Math.max(0, Number(options.minimumTransferMinutes))
      : 10;
    const directTransferWindowMinutes = Number.isFinite(Number(options.directTransferWindowMinutes))
      ? Math.max(minimumTransferMinutes, Number(options.directTransferWindowMinutes))
      : 30;

    const active = toArray(bookings)
      .filter(booking => booking.status !== "Deleted" && booking.status !== "Cancelled")
      .filter(booking => !bookingDate || String(booking.bookingDate || "") === String(bookingDate))
      .filter(booking => bookingRequiresDeployment(booking))
      .filter(booking => bookingHasDEManagedResources(booking, resourceById));

    const findings = [];
    const addFinding = (severity, code, message, detail = {}) => {
      findings.push({
        findingId: `JV-${String(findings.length + 1).padStart(4, "0")}`,
        severity,
        code,
        message,
        ...detail
      });
    };

    const byResource = new Map();
    active.forEach(booking => {
      const bookingId = String(booking?.["@_id"] || booking?.bookingId || "");
      const resourceIds = getDEManagedAllocatedResourceIds(booking, resourceById);
      if (!resourceIds.length) {
        addFinding("ERROR", "NO_MANAGED_RESOURCE", "Deployment booking has no DE-managed allocated resource.", {
          bookingId,
          bookingTime: `${booking.startTime || ""}-${booking.endTime || ""}`,
          location: String(booking.location || "")
        });
      }
      resourceIds.forEach(resourceId => {
        if (!byResource.has(resourceId)) byResource.set(resourceId, []);
        byResource.get(resourceId).push(booking);
      });
    });

    byResource.forEach((sequence, resourceId) => {
      sequence.sort((a, b) => `${a.startTime || ""} ${a.endTime || ""}`.localeCompare(`${b.startTime || ""} ${b.endTime || ""}`));
      const resource = resourceById.get(resourceId) || {};
      const resourceName = resource.name || resourceId;
      const homeLocation = getResourceHomeLocation(resource);
      if (!homeLocation) {
        addFinding("ERROR", "MISSING_HOME_LOCATION", "Resource has no configured home location.", { resourceId, resourceName });
      }

      sequence.forEach((booking, index) => {
        const bookingId = String(booking?.["@_id"] || booking?.bookingId || "");
        if (!String(booking.location || "").trim()) {
          addFinding("ERROR", "MISSING_DESTINATION", "Booking has no deployment destination.", {
            resourceId, resourceName, bookingId
          });
        }
        if (index === 0) return;

        const previous = sequence[index - 1];
        const previousId = String(previous?.["@_id"] || previous?.bookingId || "");
        const previousEnd = timeToMinutes(previous.endTime);
        const currentStart = timeToMinutes(booking.startTime);
        if (previousEnd === null || currentStart === null) {
          addFinding("ERROR", "INVALID_TIME", "Journey contains an unparseable booking time.", {
            resourceId, resourceName, previousBookingId: previousId, bookingId
          });
          return;
        }

        const gapMinutes = currentStart - previousEnd;
        const fromLocation = String(previous.location || homeLocation || "");
        const toLocation = String(booking.location || "");

        if (gapMinutes < 0) {
          addFinding("ERROR", "RESOURCE_BOOKING_OVERLAP", "The same resource is allocated to overlapping bookings.", {
            resourceId, resourceName, previousBookingId: previousId, bookingId,
            fromLocation, toLocation, gapMinutes
          });
          return;
        }

        if (fromLocation !== toLocation && gapMinutes < minimumTransferMinutes) {
          addFinding("WARNING", "INSUFFICIENT_TRANSFER_TIME", "The planned transfer gap may be too short for movement between locations.", {
            resourceId, resourceName, previousBookingId: previousId, bookingId,
            fromLocation, toLocation, gapMinutes, minimumTransferMinutes
          });
        } else if (fromLocation !== toLocation && gapMinutes <= directTransferWindowMinutes) {
          addFinding("INFO", "DIRECT_TRANSFER_AVAILABLE", "A direct transfer is operationally available within the configured handover window.", {
            resourceId, resourceName, previousBookingId: previousId, bookingId,
            fromLocation, toLocation, gapMinutes
          });
        }

        if (normaliseDeploymentStatus(previous) === "Unable to Deploy" && gapMinutes <= directTransferWindowMinutes) {
          addFinding("ERROR", "STALE_LOCATION_ASSUMPTION", "A later journey step assumes the resource reached a previous location even though that deployment was unable to complete.", {
            resourceId, resourceName, previousBookingId: previousId, bookingId,
            assumedLocation: fromLocation, gapMinutes
          });
        }
      });
    });

    const operations = buildOperationalTimelineAndJourneys(active, bookingDate);
    operations.resourceJourneys.forEach(journey => {
      let incompleteMovementSeen = false;
      journey.steps.forEach(step => {
        if (!["Deployment", "Direct Transfer", "Recovery Return"].includes(step.type)) return;
        if (step.status !== "Completed") incompleteMovementSeen = true;
        else if (incompleteMovementSeen) {
          addFinding("ERROR", "COMPLETION_SEQUENCE_CONTRADICTION", "A later movement is completed while an earlier movement in the same resource journey remains incomplete.", {
            resourceId: journey.resourceId,
            resourceName: journey.resourceName,
            bookingId: String(step.bookingId || ""),
            movementType: step.type,
            location: String(step.location || "")
          });
        }
      });

      const evidence = journey.locationEvidence;
      if (evidence && String(journey.currentExpectedLocation || "") !== String(evidence.destination || "")) {
        addFinding("ERROR", "LOCATION_EVIDENCE_MISMATCH", "Current expected location contradicts the latest completed movement evidence.", {
          resourceId: journey.resourceId,
          resourceName: journey.resourceName,
          currentExpectedLocation: journey.currentExpectedLocation,
          evidenceDestination: evidence.destination,
          evidenceBookingId: evidence.bookingId || ""
        });
      }
    });

    const counts = {
      errors: findings.filter(item => item.severity === "ERROR").length,
      warnings: findings.filter(item => item.severity === "WARNING").length,
      information: findings.filter(item => item.severity === "INFO").length
    };

    return {
      bookingDate,
      valid: counts.errors === 0,
      policy: {
        minimumTransferMinutes,
        directTransferWindowMinutes,
        mutationMode: "Validation only",
        sourceOfTruth: "ADR-024 Journey Engine"
      },
      summary: {
        resourcesValidated: byResource.size,
        bookingsValidated: active.length,
        findings: findings.length,
        ...counts
      },
      findings
    };
  }


  /**
   * ADR-024 Phase 6 — Operational Recommendations.
   *
   * Converts advisory optimisation and validation output into reviewable,
   * non-destructive operational recommendations for the DE dashboard.
   */
  function buildOperationalRecommendations(bookings = [], bookingDate = "", options = {}) {
    const optimization = buildOptimizationPlan(bookings, bookingDate, options);
    const validation = buildValidationReport(bookings, bookingDate, options);
    const findings = toArray(validation.findings);
    const recommendations = [];

    const relatedFindings = (resourceId, bookingIds = []) => {
      const idSet = new Set(bookingIds.map(value => String(value || "")).filter(Boolean));
      return findings.filter(finding => {
        if (String(finding.resourceId || "") === String(resourceId || "")) return true;
        return [finding.bookingId, finding.previousBookingId, finding.nextBookingId]
          .map(value => String(value || ""))
          .some(value => value && idSet.has(value));
      });
    };

    const classifyReadiness = relevant => {
      if (relevant.some(item => item.severity === "ERROR")) return "BLOCKED";
      if (relevant.some(item => item.severity === "WARNING")) return "REVIEW";
      return "READY";
    };

    toArray(optimization.opportunities).forEach(opportunity => {
      const bookingIds = [opportunity.previousBookingId, opportunity.nextBookingId].filter(Boolean);
      const relevant = relatedFindings(opportunity.resourceId, bookingIds);
      const readiness = classifyReadiness(relevant);
      recommendations.push({
        recommendationId: `OR-${String(recommendations.length + 1).padStart(4, "0")}`,
        recommendationType: "DIRECT_TRANSFER",
        readiness,
        title: `Direct transfer ${opportunity.resourceName || opportunity.resourceId}`,
        resourceId: String(opportunity.resourceId || ""),
        resourceName: String(opportunity.resourceName || opportunity.resourceId || "Resource"),
        bookingIds,
        fromLocation: String(opportunity.fromLocation || ""),
        toLocation: String(opportunity.toLocation || ""),
        gapMinutes: Number(opportunity.gapMinutes || 0),
        estimatedMovementsSaved: Number(opportunity.estimatedMovementsSaved || 1),
        instruction: `Move directly from ${opportunity.fromLocation || "the current venue"} to ${opportunity.toLocation || "the next venue"} instead of returning to the home location.`,
        blockingFindings: relevant.filter(item => item.severity === "ERROR").map(item => item.findingId),
        cautionFindings: relevant.filter(item => item.severity === "WARNING").map(item => item.findingId)
      });
    });

    // Group parallel deployments that share a route and start time.
    const plans = toArray(optimization.resourcePlans);
    const movementGroups = new Map();
    plans.forEach(plan => {
      toArray(plan.movements).forEach(movement => {
        if (movement.movementClass !== "Deployment") return;
        const key = [movement.requiredTime, movement.fromLocation, movement.toLocation].join("|");
        if (!movementGroups.has(key)) movementGroups.set(key, []);
        movementGroups.get(key).push({ plan, movement });
      });
    });
    movementGroups.forEach(items => {
      if (items.length < 2) return;
      const resourceIds = items.map(item => String(item.plan.resourceId || ""));
      const bookingIds = items.map(item => String(item.movement.bookingId || "")).filter(Boolean);
      const relevant = items.flatMap(item => relatedFindings(item.plan.resourceId, [item.movement.bookingId]));
      const readiness = classifyReadiness(relevant);
      recommendations.push({
        recommendationId: `OR-${String(recommendations.length + 1).padStart(4, "0")}`,
        recommendationType: "GROUPED_DEPLOYMENT",
        readiness,
        title: `Grouped deployment to ${items[0].movement.toLocation || "destination"}`,
        resourceIds,
        resources: items.map(item => ({
          resourceId: String(item.plan.resourceId || ""),
          resourceName: String(item.plan.resourceName || item.plan.resourceId || "Resource")
        })),
        bookingIds,
        fromLocation: String(items[0].movement.fromLocation || ""),
        toLocation: String(items[0].movement.toLocation || ""),
        requiredTime: String(items[0].movement.requiredTime || ""),
        instruction: `Collect ${items.length} resources together from ${items[0].movement.fromLocation || "the home location"} and deliver them to ${items[0].movement.toLocation || "the destination"}.`,
        estimatedMovementsSaved: Math.max(1, items.length - 1),
        blockingFindings: relevant.filter(item => item.severity === "ERROR").map(item => item.findingId),
        cautionFindings: relevant.filter(item => item.severity === "WARNING").map(item => item.findingId)
      });
    });

    const counts = recommendations.reduce((acc, item) => {
      acc[item.readiness.toLowerCase()] += 1;
      acc[item.recommendationType === "DIRECT_TRANSFER" ? "directTransfers" : "groupedDeployments"] += 1;
      acc.estimatedMovementsSaved += Number(item.estimatedMovementsSaved || 0);
      return acc;
    }, { ready: 0, review: 0, blocked: 0, directTransfers: 0, groupedDeployments: 0, estimatedMovementsSaved: 0 });

    return {
      bookingDate,
      policy: {
        mutationMode: "Reviewable recommendations only",
        automaticExecution: false,
        sourceOfTruth: "ADR-024 Journey Engine"
      },
      summary: {
        totalRecommendations: recommendations.length,
        ...counts
      },
      recommendations
    };
  }

  function getResourceState(bookings = [], bookingDate = "", resourceId = "") {
    const result = buildOperationalTimelineAndJourneys(bookings, bookingDate);
    return result.resourceJourneys.find(item => String(item.resourceId) === String(resourceId)) || null;
  }

  function getTimeline(bookings = [], bookingDate = "", resourceId = "") {
    return getResourceState(bookings, bookingDate, resourceId)?.steps || [];
  }

  function getCurrentLocation(bookings = [], bookingDate = "", resourceId = "") {
    return getResourceState(bookings, bookingDate, resourceId)?.currentExpectedLocation || null;
  }

  function getNextStep(bookings = [], bookingDate = "", resourceId = "") {
    return getResourceState(bookings, bookingDate, resourceId)?.nextStep || null;
  }

  return Object.freeze({
    buildDeploymentProvenance,
    buildOperationalBundle,
    buildOperationalTimelineAndJourneys,
    normaliseOperationalBundleLegs,
    getBundleLinkedBookingIds,
    getCompletedResourceMovements,
    getResourceState,
    getTimeline,
    getCurrentLocation,
    getNextStep,
    buildJourneyChains,
    buildOptimizationPlan,
    buildValidationReport,
    buildOperationalRecommendations,
    getOverlappingActiveBookings,
    getReservedResourceIds
  });
}

module.exports = {
  createJourneyEngine,
  getOverlappingActiveBookings,
  getReservedResourceIds,
  collectAllocationResourceIds
};
