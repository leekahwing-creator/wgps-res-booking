const fs = require("fs");
const path = require("path");
const { XMLParser } = require("fast-xml-parser");
const { ensureMonthlyBookingsFile } = require("./bookingFileHelper");
const { resourceSupportsSoftware } = require("./resourceAllocator");

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

function findBestResourceCombination(resources, devicesRequired) {
  let best = null;

  function search(index, selected, capacity) {
    if (capacity >= devicesRequired) {
      const surplus = capacity - devicesRequired;

      if (!best) {
        best = [...selected];
        return;
      }

      const bestCapacity = best.reduce((sum, r) => sum + Number(r.capacity), 0);
      const bestSurplus = bestCapacity - devicesRequired;

      if (
        surplus < bestSurplus ||
        (surplus === bestSurplus && selected.length < best.length)
      ) {
        best = [...selected];
      }

      return;
    }

    if (index >= resources.length) return;

    search(index + 1, [...selected, resources[index]], capacity + Number(resources[index].capacity));
    search(index + 1, selected, capacity);
  }

  search(0, [], 0);
  return best || [];
}

function buildAllocation(resources, method = "Reallocated") {
  const totalAllocatedCapacity = resources.reduce(
    (sum, resource) => sum + Number(resource.capacity),
    0
  );

  return {
    allocationMethod: method,
    cartCount: resources.filter(r => r.resourceType === "Cart").length,
    bagCount: resources.filter(r => r.resourceType === "Bag").length,
    totalAllocatedCapacity,
    resources: {
      resourceId: resources.map(r => r.id)
    }
  };
}

function resolveConflict(newBookingRequest) {
  const parsedResources = loadXML(getResourcesFilePath());
  const bookingsFile = ensureMonthlyBookingsFile(newBookingRequest.bookingDate);
  const parsedBookings = loadXML(bookingsFile);

  const allResources = toArray(parsedResources.resources?.resource)
    .filter(resource => resource.status === "Available")
    .filter(resource => resource.deviceType === newBookingRequest.deviceType)
    .sort((a, b) => Number(b.capacity) - Number(a.capacity));

  const existingBookings = toArray(parsedBookings.bookings?.booking);

  const affectedBookings = existingBookings.filter(booking => {
    if (["Cancelled", "Deleted"].includes(booking.status)) return false;
    if (booking.deviceType !== newBookingRequest.deviceType) return false;
    if (booking.bookingDate !== newBookingRequest.bookingDate) return false;

    return timeOverlaps(
      newBookingRequest.startTime,
      newBookingRequest.endTime,
      booking.startTime,
      booking.endTime
    );
  });

  const bookingsToReallocate = [
    ...affectedBookings.map(booking => ({ ...booking, isNewBooking: false })),
    { ...newBookingRequest, isNewBooking: true }
  ].sort((a, b) => Number(b.devicesRequired) - Number(a.devicesRequired));

  const remainingResources = [...allResources];
  const allocationResults = [];

  for (const booking of bookingsToReallocate) {
    const compatibleRemainingResources = remainingResources.filter(resource =>
      resourceSupportsSoftware(resource, booking.softwareRequirement)
    );

    const selectedResources = findBestResourceCombination(
      compatibleRemainingResources,
      Number(booking.devicesRequired)
    );

    const selectedCapacity = selectedResources.reduce(
      (sum, resource) => sum + Number(resource.capacity),
      0
    );

    if (selectedCapacity < Number(booking.devicesRequired)) {
      return {
        success: false,
        reason: "Unable to reallocate resources without affecting existing bookings."
      };
    }

    selectedResources.forEach(selected => {
      const index = remainingResources.findIndex(r => r.id === selected.id);
      if (index !== -1) remainingResources.splice(index, 1);
    });

    allocationResults.push({
      booking,
      allocation: buildAllocation(
        selectedResources,
        booking.isNewBooking ? "Conflict Resolution" : "Reallocated"
      )
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
