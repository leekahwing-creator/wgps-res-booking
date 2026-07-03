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
    const resources = toArray(booking.allocation?.resources?.resourceId);
    resources.forEach(resourceId => bookedIds.add(String(resourceId)));
  });

  return bookedIds;
}

function findBestResourceCombination(availableResources, devicesRequired) {
  let bestCombination = null;

  function search(index, currentResources, currentCapacity) {
    if (currentCapacity >= devicesRequired) {
      const currentSurplus = currentCapacity - devicesRequired;

      if (!bestCombination) {
        bestCombination = [...currentResources];
        return;
      }

      const bestCapacity = bestCombination.reduce(
        (total, resource) => total + Number(resource.capacity),
        0
      );

      const bestSurplus = bestCapacity - devicesRequired;

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

function buildAllocation(selectedResources) {
  const totalCapacity = selectedResources.reduce(
    (total, resource) => total + Number(resource.capacity),
    0
  );

  return {
    cartCount: selectedResources.filter(resource => resource.resourceType === "Cart").length,
    bagCount: selectedResources.filter(resource => resource.resourceType === "Bag").length,
    totalAllocatedCapacity: totalCapacity,
    resources: {
      resourceId: selectedResources.map(resource => resource.id)
    }
  };
}

function allocateResources(bookingRequest) {
  const parsedResources = loadXML(getResourcesFilePath());
  const allResources = toArray(parsedResources.resources?.resource);

  const bookedResourceIds = getBookedResourceIds(bookingRequest);

  const availableResources = allResources
    .filter(resource => resource.status === "Available")
    .filter(resource => resource.deviceType === bookingRequest.deviceType)
    .filter(resource => resourceSupportsSoftware(resource, bookingRequest.softwareRequirement))
    .filter(resource => !bookedResourceIds.has(String(resource.id)))
    .sort((a, b) => Number(b.capacity) - Number(a.capacity));

  const selectedResources = findBestResourceCombination(
    availableResources,
    Number(bookingRequest.devicesRequired)
  );

  const allocation = buildAllocation(selectedResources);
  const canFulfil = Number(allocation.totalAllocatedCapacity) >= Number(bookingRequest.devicesRequired);

  return {
    status: canFulfil ? "Confirmed" : "Unable to Fulfil",
    allocation
  };
}

module.exports = {
  allocateResources,
  resourceSupportsSoftware
};
