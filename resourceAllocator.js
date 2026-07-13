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

function normaliseAccessoryCompatibilityKey(value) {
  const text = String(value || "").trim();
  const lower = text.toLowerCase();

  if (!text) return "";

  if (/^acc[-_ ]?mouse$/i.test(text) || lower === "mouse" || lower.includes("mouse") || lower.includes("mice")) {
    return "ACC-MOUSE";
  }

  if (/^acc[-_ ]?apple[-_ ]?pencil$/i.test(text) || lower.includes("apple pencil") || lower.includes("stylus")) {
    return "ACC-APPLE-PENCIL";
  }

  if (
    /^acc[-_ ]?headset[-_ ]?(usb[-_ ]?c|usb_c|usbc)$/i.test(text) ||
    (/head\s*set|headset|headphones?|earpieces?/.test(lower) && /usb\s*-?\s*c|type\s*c|usb-c/.test(lower))
  ) {
    return "ACC-HEADSET-USB-C";
  }

  if (
    /^acc[-_ ]?headset[-_ ]?(35mm|3[-_ ]?5mm|audio[-_ ]?jack)$/i.test(text) ||
    (/head\s*set|headset|headphones?|earpieces?/.test(lower) && /3\.5|3\.5mm|audio\s*jack|aux|stereo\s*jack/.test(lower))
  ) {
    return "ACC-HEADSET-35MM";
  }

  if (/head\s*set|headset|headphones?|earpieces?/.test(lower)) {
    return "ACC-HEADSET";
  }

  return text
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normaliseCompatibleAccessoryKeys(resource) {
  const raw = resource?.compatibleAccessories;
  const values = raw?.accessory || raw?.item || raw || [];

  return Array.from(new Set(toArray(values)
    .map(normaliseAccessoryCompatibilityKey)
    .filter(Boolean)));
}

function resourceSupportsAdditionalResources(resource, additionalRequests) {
  const requests = normaliseAdditionalResources(additionalRequests);
  if (requests.length === 0) return true;

  const supportedKeys = new Set(normaliseCompatibleAccessoryKeys(resource));
  if (supportedKeys.size === 0) return false;

  return requests.every(request => supportedKeys.has(normaliseAccessoryCompatibilityKey(request.type)));
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
  const additionalRequests = normaliseAdditionalResources(bookingRequest.additionalResources);

  const selectedDeviceResources = selectResourcesForRequest(
    allResources,
    usedResourceIds,
    resource =>
      normaliseResourceCategory(resource) !== "Accessory" &&
      resource.deviceType === bookingRequest.deviceType &&
      resourceSupportsSoftware(resource, bookingRequest.softwareRequirement) &&
      resourceSupportsAdditionalResources(resource, additionalRequests),
    Number(bookingRequest.devicesRequired)
  );

  const deviceAllocation = buildAllocationBlock(selectedDeviceResources);
  const deviceCanFulfil =
    Number(deviceAllocation.totalAllocatedCapacity) >= Number(bookingRequest.devicesRequired);

  const additionalAllocations = additionalRequests.map(request => {
    const selectedAccessoryResources = selectResourcesForRequest(
      allResources,
      usedResourceIds,
      resource =>
        normaliseResourceCategory(resource) === "Accessory" &&
        normaliseAccessoryCompatibilityKey(resource.deviceType) === normaliseAccessoryCompatibilityKey(request.type),
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


function normaliseFulfilmentMode(resource = {}) {
  const configured = String(resource.fulfilmentMode || resource.fulfillmentMode || "").trim();
  if (configured === "Collection" || configured === "Deployment") return configured;

  const deviceType = String(resource.deviceType || "").toLowerCase();
  const resourceType = String(resource.resourceType || "").toLowerCase();
  const name = String(resource.name || "").toLowerCase();

  if (deviceType.includes("ipad") && (resourceType === "bag" || /\bipad\s+bag\b/.test(name))) {
    return "Collection";
  }

  return "Deployment";
}

function formatAdviceResource(resource) {
  return {
    id: String(resource.id || ""),
    name: String(resource.name || resource.id || ""),
    deviceType: String(resource.deviceType || ""),
    capacity: Number(resource.capacity || 0),
    resourceType: String(resource.resourceType || ""),
    fulfilmentMode: normaliseFulfilmentMode(resource),
    software: normaliseSoftwareList(resource),
    compatibleAccessoryKeys: normaliseCompatibleAccessoryKeys(resource)
  };
}

/**
 * Read-only availability assessment for the booking advisor.
 * This function never writes booking files and never reserves resources.
 */
function assessBookingAvailability(bookingRequest) {
  const parsedResources = loadXML(getResourcesFilePath());
  const allResources = toArray(parsedResources.resources?.resource);
  const bookedResourceIds = getBookedResourceIds(bookingRequest);
  const additionalRequests = normaliseAdditionalResources(bookingRequest.additionalResources);
  const quantityRequired = Number(bookingRequest.devicesRequired || 0);

  const compatibleDeviceResources = allResources
    .filter(resource => normaliseResourceCategory(resource) !== "Accessory")
    .filter(resource => resource.status === "Available")
    .filter(resource => resource.deviceType === bookingRequest.deviceType)
    .filter(resource => resourceSupportsSoftware(resource, bookingRequest.softwareRequirement))
    .filter(resource => resourceSupportsAdditionalResources(resource, additionalRequests));

  const currentlyAvailableDeviceResources = compatibleDeviceResources
    .filter(resource => !bookedResourceIds.has(String(resource.id)))
    .sort((a, b) => Number(b.capacity) - Number(a.capacity));

  const selectedDeviceResources = findBestResourceCombination(
    currentlyAvailableDeviceResources,
    quantityRequired
  );

  const selectedDeviceCapacity = selectedDeviceResources.reduce(
    (total, resource) => total + Number(resource.capacity || 0),
    0
  );

  const accessoryAssessments = additionalRequests.map(request => {
    const compatibleAccessoryResources = allResources
      .filter(resource => normaliseResourceCategory(resource) === "Accessory")
      .filter(resource => resource.status === "Available")
      .filter(resource =>
        normaliseAccessoryCompatibilityKey(resource.deviceType) ===
        normaliseAccessoryCompatibilityKey(request.type)
      );

    const currentlyAvailableAccessoryResources = compatibleAccessoryResources
      .filter(resource => !bookedResourceIds.has(String(resource.id)))
      .sort((a, b) => Number(b.capacity) - Number(a.capacity));

    const selected = findBestResourceCombination(
      currentlyAvailableAccessoryResources,
      Number(request.quantity)
    );

    const capacity = selected.reduce(
      (total, resource) => total + Number(resource.capacity || 0),
      0
    );

    return {
      type: request.type,
      quantityRequested: Number(request.quantity),
      availableCapacity: capacity,
      fulfilled: capacity >= Number(request.quantity),
      likelyResources: selected.map(formatAdviceResource)
    };
  });

  const deviceFulfilled = quantityRequired > 0 && selectedDeviceCapacity >= quantityRequired;
  const accessoriesFulfilled = accessoryAssessments.every(item => item.fulfilled);
  const directFulfilmentLikely = deviceFulfilled && accessoriesFulfilled;

  const availableCompatibleCapacity = currentlyAvailableDeviceResources.reduce(
    (total, resource) => total + Number(resource.capacity || 0),
    0
  );

  const totalCompatibleCapacity = compatibleDeviceResources.reduce(
    (total, resource) => total + Number(resource.capacity || 0),
    0
  );

  const selectedModes = Array.from(new Set(
    selectedDeviceResources.map(normaliseFulfilmentMode)
  ));

  let fulfilmentMode = "Unknown";
  if (selectedModes.length === 1) fulfilmentMode = selectedModes[0];
  if (selectedModes.length > 1) fulfilmentMode = "Mixed";

  let availabilityStatus = "Unable to fulfil as configured";
  let confidence = "Low";
  let healthScore = 1;

  if (directFulfilmentLikely) {
    if (selectedDeviceResources.length === 1 && selectedDeviceCapacity === quantityRequired) {
      availabilityStatus = "Likely available";
      confidence = "High";
      healthScore = 5;
    } else if (selectedDeviceResources.length <= 2) {
      availabilityStatus = "Likely available";
      confidence = "Moderate";
      healthScore = 4;
    } else {
      availabilityStatus = "Available with multiple resources";
      confidence = "Moderate";
      healthScore = 3;
    }
  } else if (availableCompatibleCapacity > 0 || totalCompatibleCapacity > 0) {
    availabilityStatus = "Limited options";
    confidence = "Low";
    healthScore = 2;
  }

  const warnings = [];
  const recommendations = [];

  if (!deviceFulfilled) {
    if (availableCompatibleCapacity > 0) {
      warnings.push(
        `Only ${availableCompatibleCapacity} compatible ${bookingRequest.deviceType} device(s) appear directly available for this time.`
      );
      recommendations.push(`Consider reducing the quantity to ${availableCompatibleCapacity} or selecting another time.`);
    } else if (totalCompatibleCapacity > 0) {
      warnings.push("Compatible resources exist, but they appear to be occupied during the selected period.");
      recommendations.push("Try a different time period.");
    } else {
      warnings.push("No resource matches the selected device, software and accessory combination.");
      recommendations.push("Remove an optional requirement or choose another device type.");
    }
  }

  accessoryAssessments
    .filter(item => !item.fulfilled)
    .forEach(item => {
      warnings.push(
        `${item.type}: ${item.availableCapacity} of ${item.quantityRequested} requested unit(s) appear directly available.`
      );
      recommendations.push(`Reduce the ${item.type} quantity or choose another time.`);
    });

  if (directFulfilmentLikely && selectedDeviceResources.length > 1) {
    recommendations.push(
      `The request is likely to use ${selectedDeviceResources.length} device resources.`
    );
  }

  if (fulfilmentMode === "Collection" || fulfilmentMode === "Mixed") {
    recommendations.push("At least one likely device resource requires collection from the ICT Work Room.");
  }

  if (String(bookingRequest.softwareRequirement || "None") !== "None") {
    recommendations.push(
      `${bookingRequest.softwareRequirement} support was included in the compatibility assessment.`
    );
  }

  return {
    advisoryOnly: true,
    availabilityStatus,
    confidence,
    healthScore,
    directFulfilmentLikely,
    estimatedAllocationMethod: directFulfilmentLikely
      ? "Automatic Allocation"
      : "May require conflict resolution or an alternative",
    quantityRequested: quantityRequired,
    selectedDeviceCapacity,
    availableCompatibleCapacity,
    totalCompatibleCapacity,
    fulfilmentMode,
    collectionRequired: fulfilmentMode === "Collection" || fulfilmentMode === "Mixed",
    likelyDeviceResources: selectedDeviceResources.map(formatAdviceResource),
    accessoryAssessments,
    warnings: Array.from(new Set(warnings)),
    recommendations: Array.from(new Set(recommendations)),
    disclaimer: "This is a live advisory estimate. Final allocation is determined when the booking is submitted."
  };
}

module.exports = {
  allocateResources,
  assessBookingAvailability,
  resourceSupportsSoftware,
  normaliseAdditionalResources,
  normaliseResourceCategory,
  collectResourceIdsFromAllocation,
  findBestResourceCombination,
  buildAllocationBlock,
  normaliseAccessoryCompatibilityKey,
  normaliseCompatibleAccessoryKeys,
  resourceSupportsAdditionalResources
};
