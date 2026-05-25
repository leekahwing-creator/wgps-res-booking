const fs = require("fs");
const path = require("path");
const { XMLParser } = require("fast-xml-parser");

const parser = new XMLParser({
  ignoreAttributes: false
});

const resourcesFile = path.join(__dirname, "resources.xml");
const bookingsFile = path.join(__dirname, "bookings.xml");

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function timeOverlaps(startA, endA, startB, endB) {
  return startA < endB && endA > startB;
}

function loadXML(filePath) {
  const xml = fs.readFileSync(filePath, "utf8");
  return parser.parse(xml);
}

function getBookedResourceIds(bookingRequest) {
  const parsedBookings = loadXML(bookingsFile);
  const bookings = toArray(parsedBookings.bookings?.booking);

  const overlappingBookings = bookings.filter(booking => {
    if (booking.bookingDate !== bookingRequest.bookingDate) return false;
    if (booking.status === "Cancelled") return false;

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
    resources.forEach(resourceId => bookedIds.add(resourceId));
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
        (currentSurplus === bestSurplus &&
          currentResources.length < bestCombination.length)
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

function allocateResources(bookingRequest) {
  const parsedResources = loadXML(resourcesFile);
  const allResources = toArray(parsedResources.resources?.resource);

  const bookedResourceIds = getBookedResourceIds(bookingRequest);

  const availableResources = allResources
    .filter(resource => resource.status === "Available")
    .filter(resource => resource.deviceType === bookingRequest.deviceType)
    .filter(resource => !bookedResourceIds.has(resource.id))
    .sort((a, b) => Number(b.capacity) - Number(a.capacity));

  const selectedResources = findBestResourceCombination(
    availableResources,
    Number(bookingRequest.devicesRequired)
  );

  const totalCapacity = selectedResources.reduce(
    (total, resource) => total + Number(resource.capacity),
    0
  );

  const canFulfil = totalCapacity >= Number(bookingRequest.devicesRequired);

  return {
    status: canFulfil ? "Confirmed" : "Unable to Fulfil",
    allocation: {
      allocationMethod: "Direct Allocation",
      cartCount: selectedResources.filter(resource => resource.resourceType === "Cart").length,
      bagCount: selectedResources.filter(resource => resource.resourceType === "Bag").length,
      totalAllocatedCapacity: totalCapacity,
      resources: {
        resourceId: selectedResources.map(resource => resource.id)
      }
    }
  };
}

module.exports = {
  allocateResources
};
