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
