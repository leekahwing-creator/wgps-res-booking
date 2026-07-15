const fs = require("fs");
const path = require("path");
const { XMLParser } = require("fast-xml-parser");
const { ensureMonthlyBookingsFile } = require("./bookingFileHelper");
const {
  resourceSupportsSoftware,
  normaliseAdditionalResources,
  normaliseResourceCategory,
  findBestResourceCombination,
  buildAllocationBlock,
  collectResourceIdsFromAllocation,
  normaliseAccessoryCompatibilityKey,
  resourceSupportsAdditionalResources
} = require("./resourceAllocator");
const { getOverlappingActiveBookings } = require("./journeyEngine");

const parser = new XMLParser({ ignoreAttributes: false });

const appDir = __dirname;
const dataDir = process.env.DATA_DIR || path.join(__dirname, "data");
const liveResourcesFile = path.join(dataDir, "resources.xml");
const sourceResourcesFile = path.join(appDir, "resources.xml");

function getResourcesFilePath() {
  return fs.existsSync(liveResourcesFile) ? liveResourcesFile : sourceResourcesFile;
}

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function loadXML(filePath) {
  return parser.parse(fs.readFileSync(filePath, "utf8"));
}


function selectResourcesForRequest(allResources, remainingResourceIds, predicate, quantityRequired) {
  const availableResources = allResources
    .filter(resource => remainingResourceIds.has(String(resource.id)))
    .filter(resource => resource.status === "Available")
    .filter(predicate)
    .sort((a, b) => Number(b.capacity) - Number(a.capacity));

  const selectedResources = findBestResourceCombination(availableResources, Number(quantityRequired));

  selectedResources.forEach(resource => remainingResourceIds.delete(String(resource.id)));

  return selectedResources;
}

function allocateBookingPackage(allResources, remainingResourceIds, booking, method) {
  const additionalRequests = normaliseAdditionalResources(booking.additionalResources);

  const selectedDeviceResources = selectResourcesForRequest(
    allResources,
    remainingResourceIds,
    resource =>
      normaliseResourceCategory(resource) !== "Accessory" &&
      resource.deviceType === booking.deviceType &&
      resourceSupportsSoftware(resource, booking.softwareRequirement) &&
      resourceSupportsAdditionalResources(resource, additionalRequests),
    Number(booking.devicesRequired)
  );

  const deviceAllocation = buildAllocationBlock(selectedDeviceResources, method);
  const deviceFulfilled = Number(deviceAllocation.totalAllocatedCapacity) >= Number(booking.devicesRequired);

  const additionalAllocations = additionalRequests.map(request => {
    const selectedAccessoryResources = selectResourcesForRequest(
      allResources,
      remainingResourceIds,
      resource =>
        normaliseResourceCategory(resource) === "Accessory" &&
        normaliseAccessoryCompatibilityKey(resource.deviceType) === normaliseAccessoryCompatibilityKey(request.type),
      request.quantity
    );

    const allocationBlock = buildAllocationBlock(selectedAccessoryResources, "Accessory Reallocation");
    return {
      type: request.type,
      quantityRequested: request.quantity,
      ...allocationBlock,
      fulfilled: Number(allocationBlock.totalAllocatedCapacity) >= Number(request.quantity)
    };
  });

  const accessoriesFulfilled = additionalAllocations.every(item => item.fulfilled !== false);

  return {
    success: deviceFulfilled && accessoriesFulfilled,
    allocation: {
      ...deviceAllocation,
      additionalResources: {
        resource: additionalAllocations
      }
    }
  };
}

function resolveConflict(newBookingRequest) {
  const parsedResources = loadXML(getResourcesFilePath());
  const bookingsFile = ensureMonthlyBookingsFile(newBookingRequest.bookingDate);
  const parsedBookings = loadXML(bookingsFile);

  const allResources = toArray(parsedResources.resources?.resource)
    .filter(resource => resource.status === "Available");

  const existingBookings = toArray(parsedBookings.bookings?.booking);

  // ADR-024 Phase 2: use the Journey Engine's authoritative overlap view.
  const affectedBookings = getOverlappingActiveBookings(
    existingBookings,
    newBookingRequest,
    { excludeBookingId: newBookingRequest.excludeBookingId || "" }
  );

  const unaffectedResourceIds = new Set(allResources.map(resource => String(resource.id)));
  affectedBookings.forEach(booking => {
    collectResourceIdsFromAllocation(booking.allocation)
      .forEach(resourceId => unaffectedResourceIds.add(String(resourceId)));
  });

  const remainingResourceIds = new Set(allResources.map(resource => String(resource.id)));

  const bookingsToReallocate = [
    ...affectedBookings.map(booking => ({ ...booking, isNewBooking: false })),
    { ...newBookingRequest, isNewBooking: true }
  ].sort((a, b) => {
    const aDemand = Number(a.devicesRequired || 0) + normaliseAdditionalResources(a.additionalResources).reduce((sum, item) => sum + item.quantity, 0);
    const bDemand = Number(b.devicesRequired || 0) + normaliseAdditionalResources(b.additionalResources).reduce((sum, item) => sum + item.quantity, 0);
    return bDemand - aDemand;
  });

  const allocationResults = [];

  for (const booking of bookingsToReallocate) {
    const result = allocateBookingPackage(
      allResources,
      remainingResourceIds,
      booking,
      booking.isNewBooking ? "Conflict Resolution" : "Reallocated"
    );

    if (!result.success) {
      return {
        success: false,
        reason: "Unable to reallocate resources and accessories without affecting existing bookings."
      };
    }

    allocationResults.push({
      booking,
      allocation: result.allocation
    });
  }

  const existingBookingUpdates = allocationResults
    .filter(result => !result.booking.isNewBooking)
    .map(result => ({
      bookingId: result.booking["@_id"],
      allocation: {
        ...result.allocation,
        allocationMethod: "Reallocated"
      },
      status: "Confirmed with Reallocation"
    }));

  const newBookingResult = allocationResults.find(result => result.booking.isNewBooking);

  return {
    success: true,
    status: "Confirmed with Reallocation",
    allocation: {
      ...newBookingResult.allocation,
      allocationMethod: "Conflict Resolution"
    },
    existingBookingUpdates
  };
}

module.exports = {
  resolveConflict
};
