const fs = require("fs");
const path = require("path");
const { XMLParser } = require("fast-xml-parser");
const { ensureMonthlyBookingsFile } = require("./bookingFileHelper");

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

function timeOverlaps(startA, endA, startB, endB) {
  return startA < endB && endA > startB;
}

function normaliseResourceCategory(resource) {
  return String(resource?.category || "Device").trim() || "Device";
}

function normaliseSoftwareList(resource) {
  return toArray(resource.software?.item)
    .map(item => String(item || "").trim())
    .filter(Boolean);
}

function resourceSupportsSoftware(resource, requiredSoftware) {
  const requirement = String(requiredSoftware || "None").trim();

  if (!requirement || requirement === "None") return true;

  const installedSoftware = normaliseSoftwareList(resource)
    .map(item => item.toLowerCase());

  return installedSoftware.includes(requirement.toLowerCase());
}

function normaliseAdditionalResources(additionalResources) {
  const items = toArray(additionalResources?.resource || additionalResources)
    .map(item => ({
      type: String(item?.type || item?.deviceType || item?.name || "").trim(),
      quantity: Number(item?.quantity || item?.devicesRequired || 0)
    }))
    .filter(item => item.type && Number.isInteger(item.quantity) && item.quantity > 0);

  const byType = new Map();
  items.forEach(item => {
    const key = item.type.toLowerCase();
    const existing = byType.get(key);
    if (existing) {
      existing.quantity += item.quantity;
    } else {
      byType.set(key, { ...item });
    }
  });

  return Array.from(byType.values());
}

function collectResourceIdsFromAllocation(allocation) {
  const bookedIds = [];

  toArray(allocation?.resources?.resourceId)
    .forEach(resourceId => bookedIds.push(String(resourceId)));

  toArray(allocation?.additionalResources?.resource)
    .forEach(additionalAllocation => {
      toArray(additionalAllocation?.resources?.resourceId)
        .forEach(resourceId => bookedIds.push(String(resourceId)));
    });

  return bookedIds;
}

function getBookedResourceIds(bookingRequest) {
  const bookingsFile = ensureMonthlyBookingsFile(bookingRequest.bookingDate);
  const parsedBookings = loadXML(bookingsFile);
  const bookings = toArray(parsedBookings.bookings?.booking);

  const overlappingBookings = bookings.filter(booking => {
    if (booking.bookingDate !== bookingRequest.bookingDate) return false;
    if (["Cancelled", "Deleted"].includes(booking.status)) return false;

    return timeOverlaps(
      bookingRequest.startTime,
      bookingRequest.endTime,
      booking.startTime,
      booking.endTime
    );
  });

  const bookedIds = new Set();

  overlappingBookings.forEach(booking => {
    collectResourceIdsFromAllocation(booking.allocation)
      .forEach(resourceId => bookedIds.add(String(resourceId)));
  });

  return bookedIds;
}

function findBestResourceCombination(availableResources, quantityRequired) {
  let bestCombination = null;

  function search(index, currentResources, currentCapacity) {
    if (currentCapacity >= quantityRequired) {
      const currentSurplus = currentCapacity - quantityRequired;

      if (!bestCombination) {
        bestCombination = [...currentResources];
        return;
      }

      const bestCapacity = bestCombination.reduce(
        (total, resource) => total + Number(resource.capacity),
        0
      );

      const bestSurplus = bestCapacity - quantityRequired;

      if (
        currentSurplus < bestSurplus ||
        (currentSurplus === bestSurplus && currentResources.length < bestCombination.length)
      ) {
        bestCombination = [...currentResources];
      }

      return;
    }

    if (index >= availableResources.length) return;

    search(
      index + 1,
      [...currentResources, availableResources[index]],
      currentCapacity + Number(availableResources[index].capacity)
    );

    search(index + 1, currentResources, currentCapacity);
  }

  search(0, [], 0);

  return bestCombination || [];
}

function buildAllocationBlock(selectedResources, method = "Automatic Allocation") {
  const totalCapacity = selectedResources.reduce(
    (total, resource) => total + Number(resource.capacity),
    0
  );

  return {
    allocationMethod: method,
    cartCount: selectedResources.filter(resource => resource.resourceType === "Cart").length,
    bagCount: selectedResources.filter(resource => resource.resourceType === "Bag").length,
    totalAllocatedCapacity: totalCapacity,
    resources: {
      resourceId: selectedResources.map(resource => resource.id)
    }
  };
}

function selectResourcesForRequest(allResources, usedResourceIds, predicate, quantityRequired) {
  const availableResources = allResources
    .filter(resource => resource.status === "Available")
    .filter(resource => !usedResourceIds.has(String(resource.id)))
    .filter(predicate)
    .sort((a, b) => Number(b.capacity) - Number(a.capacity));

  const selectedResources = findBestResourceCombination(
    availableResources,
    Number(quantityRequired)
  );

  selectedResources.forEach(resource => usedResourceIds.add(String(resource.id)));

  return selectedResources;
}

function allocateResources(bookingRequest) {
  const parsedResources = loadXML(getResourcesFilePath());
  const allResources = toArray(parsedResources.resources?.resource);
  const bookedResourceIds = getBookedResourceIds(bookingRequest);
  const usedResourceIds = new Set(bookedResourceIds);

  const selectedDeviceResources = selectResourcesForRequest(
    allResources,
    usedResourceIds,
    resource =>
      normaliseResourceCategory(resource) !== "Accessory" &&
      resource.deviceType === bookingRequest.deviceType &&
      resourceSupportsSoftware(resource, bookingRequest.softwareRequirement),
    Number(bookingRequest.devicesRequired)
  );

  const deviceAllocation = buildAllocationBlock(selectedDeviceResources);
  const deviceCanFulfil =
    Number(deviceAllocation.totalAllocatedCapacity) >= Number(bookingRequest.devicesRequired);

  const additionalRequests = normaliseAdditionalResources(bookingRequest.additionalResources);
  const additionalAllocations = additionalRequests.map(request => {
    const selectedAccessoryResources = selectResourcesForRequest(
      allResources,
      usedResourceIds,
      resource =>
        normaliseResourceCategory(resource) === "Accessory" &&
        String(resource.deviceType || "").toLowerCase() === request.type.toLowerCase(),
      request.quantity
    );

    const allocationBlock = buildAllocationBlock(selectedAccessoryResources, "Accessory Allocation");

    return {
      type: request.type,
      quantityRequested: request.quantity,
      ...allocationBlock,
      fulfilled: Number(allocationBlock.totalAllocatedCapacity) >= Number(request.quantity)
    };
  });

  const accessoriesCanFulfil = additionalAllocations.every(item => item.fulfilled !== false);

  return {
    status: deviceCanFulfil && accessoriesCanFulfil ? "Confirmed" : "Unable to Fulfil",
    allocation: {
      ...deviceAllocation,
      allocationMethod: deviceCanFulfil && accessoriesCanFulfil
        ? "Automatic Allocation"
        : "Partial Allocation",
      additionalResources: {
        resource: additionalAllocations
      }
    }
  };
}

module.exports = {
  allocateResources,
  resourceSupportsSoftware,
  normaliseAdditionalResources,
  normaliseResourceCategory,
  collectResourceIdsFromAllocation,
  findBestResourceCombination,
  buildAllocationBlock
};
