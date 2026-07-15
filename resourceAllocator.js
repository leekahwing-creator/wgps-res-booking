const fs = require("fs");
const path = require("path");
const { XMLParser } = require("fast-xml-parser");
const { ensureMonthlyBookingsFile } = require("./bookingFileHelper");
const { getReservedResourceIds } = require("./journeyEngine");

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

function normaliseSoftwareRequirements(requiredSoftware) {
  const raw = requiredSoftware?.software || requiredSoftware?.item || requiredSoftware;
  const values = toArray(raw)
    .flatMap(item => typeof item === "string" ? item.split(",") : [item])
    .map(item => String(item || "").trim())
    .filter(item => item && item.toLowerCase() !== "none");

  return Array.from(new Map(values.map(item => [item.toLowerCase(), item])).values());
}

function resourceSupportsSoftware(resource, requiredSoftware) {
  const requirements = normaliseSoftwareRequirements(requiredSoftware);
  if (requirements.length === 0) return true;

  const installedSoftware = new Set(
    normaliseSoftwareList(resource).map(item => item.toLowerCase())
  );

  return requirements.every(requirement =>
    installedSoftware.has(requirement.toLowerCase())
  );
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

  // ADR-024 Phase 2: reservation state is derived by the Journey Engine.
  return getReservedResourceIds(bookings, bookingRequest, {
    excludeBookingId: bookingRequest.excludeBookingId || ""
  });
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
      resourceSupportsSoftware(resource, bookingRequest.softwareRequirements || bookingRequest.softwareRequirement) &&
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


function timeToMinutes(value) {
  const match = String(value || "").match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function minutesToTime(value) {
  const hours = Math.floor(value / 60);
  const minutes = value % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function assessDirectFulfilmentForRequest(allResources, bookingRequest) {
  const bookedResourceIds = getBookedResourceIds(bookingRequest);
  const additionalRequests = normaliseAdditionalResources(bookingRequest.additionalResources);
  const quantityRequired = Number(bookingRequest.devicesRequired || 0);

  const compatibleDeviceResources = allResources
    .filter(resource => normaliseResourceCategory(resource) !== "Accessory")
    .filter(resource => resource.status === "Available")
    .filter(resource => resource.deviceType === bookingRequest.deviceType)
    .filter(resource => resourceSupportsSoftware(resource, bookingRequest.softwareRequirements || bookingRequest.softwareRequirement))
    .filter(resource => resourceSupportsAdditionalResources(resource, additionalRequests));

  const availableDeviceResources = compatibleDeviceResources
    .filter(resource => !bookedResourceIds.has(String(resource.id)))
    .sort((a, b) => Number(b.capacity) - Number(a.capacity));

  const selectedDeviceResources = findBestResourceCombination(
    availableDeviceResources,
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

    const availableAccessoryResources = compatibleAccessoryResources
      .filter(resource => !bookedResourceIds.has(String(resource.id)))
      .sort((a, b) => Number(b.capacity) - Number(a.capacity));

    const selected = findBestResourceCombination(
      availableAccessoryResources,
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

  const availableCompatibleCapacity = availableDeviceResources.reduce(
    (total, resource) => total + Number(resource.capacity || 0),
    0
  );

  const totalCompatibleCapacity = compatibleDeviceResources.reduce(
    (total, resource) => total + Number(resource.capacity || 0),
    0
  );

  const deviceFulfilled =
    quantityRequired > 0 && selectedDeviceCapacity >= quantityRequired;
  const accessoriesFulfilled =
    accessoryAssessments.every(item => item.fulfilled);

  return {
    bookedResourceIds,
    compatibleDeviceResources,
    availableDeviceResources,
    selectedDeviceResources,
    selectedDeviceCapacity,
    accessoryAssessments,
    availableCompatibleCapacity,
    totalCompatibleCapacity,
    deviceFulfilled,
    accessoriesFulfilled,
    directFulfilmentLikely: deviceFulfilled && accessoriesFulfilled
  };
}

function buildAlternativeTimeSuggestions(allResources, bookingRequest, maxSuggestions = 3) {
  const startMinutes = timeToMinutes(bookingRequest.startTime);
  const endMinutes = timeToMinutes(bookingRequest.endTime);
  if (startMinutes === null || endMinutes === null || endMinutes <= startMinutes) return [];

  const duration = endMinutes - startMinutes;
  const dayStart = 7 * 60 + 45;
  const dayEnd = 17 * 60 + 30;
  const offsets = [-15, 15, -30, 30, -45, 45, -60, 60, -90, 90, -120, 120];
  const suggestions = [];

  for (const offset of offsets) {
    const candidateStart = startMinutes + offset;
    const candidateEnd = candidateStart + duration;

    if (candidateStart < dayStart || candidateEnd > dayEnd) continue;

    const candidateRequest = {
      ...bookingRequest,
      startTime: minutesToTime(candidateStart),
      endTime: minutesToTime(candidateEnd)
    };

    const assessment = assessDirectFulfilmentForRequest(allResources, candidateRequest);
    if (!assessment.directFulfilmentLikely) continue;

    suggestions.push({
      startTime: candidateRequest.startTime,
      endTime: candidateRequest.endTime,
      confidence: assessment.selectedDeviceResources.length <= 1 ? "High" : "Moderate",
      likelyDeviceResources: assessment.selectedDeviceResources.map(formatAdviceResource)
    });

    if (suggestions.length >= maxSuggestions) break;
  }

  return suggestions;
}

function buildAlternativeDeviceSuggestions(allResources, bookingRequest, maxSuggestions = 2) {
  const deviceTypes = Array.from(new Set(
    allResources
      .filter(resource => normaliseResourceCategory(resource) !== "Accessory")
      .filter(resource => resource.status === "Available")
      .map(resource => String(resource.deviceType || "").trim())
      .filter(Boolean)
  ));

  return deviceTypes
    .filter(deviceType => deviceType !== bookingRequest.deviceType)
    .map(deviceType => {
      const candidateRequest = {
        ...bookingRequest,
        deviceType
      };
      const assessment = assessDirectFulfilmentForRequest(allResources, candidateRequest);

      return {
        deviceType,
        directFulfilmentLikely: assessment.directFulfilmentLikely,
        availableCompatibleCapacity: assessment.availableCompatibleCapacity,
        likelyDeviceResources: assessment.selectedDeviceResources.map(formatAdviceResource),
        fulfilmentMode: Array.from(new Set(
          assessment.selectedDeviceResources.map(normaliseFulfilmentMode)
        )).join(" / ") || "Unknown"
      };
    })
    .filter(item => item.directFulfilmentLikely)
    .sort((a, b) => {
      const aCount = a.likelyDeviceResources.length || Number.MAX_SAFE_INTEGER;
      const bCount = b.likelyDeviceResources.length || Number.MAX_SAFE_INTEGER;
      if (aCount !== bCount) return aCount - bCount;
      return b.availableCompatibleCapacity - a.availableCompatibleCapacity;
    })
    .slice(0, maxSuggestions);
}


function buildR34Guidance(selectedResources, quantityRequired, fulfilmentMode, conflictHeat, totalCapacity, availableCapacity, accessoryAssessments, directFulfilmentLikely, deviceFulfilled, accessoriesFulfilled, softwareRequirement, recommendationScore, alternatives) {
  const names = selectedResources.map(r => String(r.name || r.id));
  const totalSelected = selectedResources.reduce((s,r)=>s+Number(r.capacity||0),0);
  const preferredResource = {
    title: names.length ? names.join(", ") : "No direct resource identified",
    reason: !names.length ? "No currently available resource combination fully satisfies the configured request." :
      selectedResources.length === 1 && totalSelected === Number(quantityRequired) ? "Single-resource exact-capacity match with minimal handling." :
      selectedResources.length === 1 ? "Fulfils the request with one resource, reducing setup complexity." :
      `Lowest-surplus compatible combination using ${selectedResources.length} resources.`
  };
  const occupied = Math.max(0, Number(totalCapacity||0)-Number(availableCapacity||0));
  const conflictExplanation = {
    level: conflictHeat,
    summary: directFulfilmentLikely ? `${conflictHeat} contention; the request still appears fulfilable.` : "Existing bookings constrain this request.",
    detail: `${occupied} compatible device places are already committed; ${availableCapacity} appear directly available.`
  };
  const accessoryCount = accessoryAssessments.reduce((n,a)=>n+(Array.isArray(a.likelyResources)?a.likelyResources.length:0),0);
  const totalResources = selectedResources.length + accessoryCount;
  const operationalImpact = {
    complexity: totalResources >= 4 || fulfilmentMode === "Mixed" ? "High" : (totalResources >= 2 || fulfilmentMode === "Collection" ? "Moderate" : "Low"),
    workload: fulfilmentMode === "Collection" ? "User collection from ICT Work Room" : (fulfilmentMode === "Mixed" ? "Mixed deployment and collection" : selectedResources.length > 1 ? `Deployment of ${selectedResources.length} device resources` : "Single-resource deployment"),
    deviceResourceCount: selectedResources.length,
    accessoryResourceCount: accessoryCount
  };
  const confidenceBreakdown = [
    {label:"Device capacity",status:deviceFulfilled?"pass":"risk",detail:deviceFulfilled?"Sufficient compatible device capacity appears available.":"Directly available compatible capacity is insufficient."},
    {label:"Accessory compatibility",status:accessoriesFulfilled?"pass":"risk",detail:accessoriesFulfilled?"Requested accessories appear compatible and available.":"One or more requested accessories cannot be fully matched."},
    {label:"Software support",status:"pass",detail:normaliseSoftwareRequirements(softwareRequirement).length?`${normaliseSoftwareRequirements(softwareRequirement).join(", ")} compatibility was included in the assessment.`:"No specialist software requirement was selected."},
    {label:"Time-slot contention",status:conflictHeat==="High"?"risk":(conflictHeat==="Moderate"?"caution":"pass"),detail:`${conflictHeat} resource demand is estimated for this period.`},
    {label:"Operational simplicity",status:selectedResources.length<=1&&fulfilmentMode!=="Mixed"?"pass":"caution",detail:selectedResources.length<=1?`Likely fulfilled with one ${String(fulfilmentMode).toLowerCase()} resource.`:`Likely fulfilled using ${selectedResources.length} device resources.`}
  ];
  const rankedRecommendations=[];
  if (directFulfilmentLikely) rankedRecommendations.push({category:"Current request",title:"Keep the current booking",reason:"A direct likely fulfilment path is available.",action:null});
  (alternatives.alternativeTimes||[]).forEach(x=>rankedRecommendations.push({category:"Alternative time",title:`${x.startTime}–${x.endTime}`,reason:`${x.confidence} confidence with compatible resources identified.`,action:{type:"time",value:`${x.startTime}|${x.endTime}`}}));
  if (Number(alternatives.alternativeQuantity)>0) rankedRecommendations.push({category:"Alternative quantity",title:`Request ${alternatives.alternativeQuantity} devices`,reason:"Matches the compatible capacity directly available in this period.",action:{type:"quantity",value:String(alternatives.alternativeQuantity)}});
  (alternatives.alternativeDevices||[]).forEach(x=>rankedRecommendations.push({category:"Alternative device",title:x.deviceType,reason:`${x.availableCompatibleCapacity} compatible places appear available.`,action:{type:"device",value:x.deviceType}}));
  rankedRecommendations.splice(5);
  rankedRecommendations.forEach((x,i)=>x.rank=i+1);
  return {preferredResource,conflictExplanation,operationalImpact,confidenceBreakdown,rankedRecommendations,qualityLabel:recommendationScore>=85?"Excellent":recommendationScore>=70?"Good":recommendationScore>=50?"Fair":"Needs adjustment"};
}

/**
 * Read-only availability assessment for the booking advisor.
 * This function never writes booking files and never reserves resources.
 */
function assessBookingAvailability(bookingRequest) {
  const parsedResources = loadXML(getResourcesFilePath());
  const allResources = toArray(parsedResources.resources?.resource);
  const quantityRequired = Number(bookingRequest.devicesRequired || 0);
  const coreAssessment = assessDirectFulfilmentForRequest(allResources, bookingRequest);
  const {
    compatibleDeviceResources,
    availableDeviceResources: currentlyAvailableDeviceResources,
    selectedDeviceResources,
    selectedDeviceCapacity,
    accessoryAssessments,
    availableCompatibleCapacity,
    totalCompatibleCapacity,
    deviceFulfilled,
    accessoriesFulfilled,
    directFulfilmentLikely
  } = coreAssessment;

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

  const requestedSoftware = normaliseSoftwareRequirements(
    bookingRequest.softwareRequirements || bookingRequest.softwareRequirement
  );
  if (requestedSoftware.length > 0) {
    recommendations.push(
      `${requestedSoftware.join(", ")} support was included in the compatibility assessment.`
    );
  }

  const alternativeQuantity =
    !deviceFulfilled && availableCompatibleCapacity > 0 && availableCompatibleCapacity < quantityRequired
      ? availableCompatibleCapacity
      : null;

  const alternativeTimes = directFulfilmentLikely
    ? []
    : buildAlternativeTimeSuggestions(allResources, bookingRequest);

  const alternativeDevices = directFulfilmentLikely
    ? []
    : buildAlternativeDeviceSuggestions(allResources, bookingRequest);

  const occupiedCompatibleCapacity = Math.max(
    0,
    totalCompatibleCapacity - availableCompatibleCapacity
  );
  const utilisationRatio = totalCompatibleCapacity > 0
    ? occupiedCompatibleCapacity / totalCompatibleCapacity
    : 1;

  const conflictHeat = utilisationRatio >= 0.75
    ? "High"
    : (utilisationRatio >= 0.35 ? "Moderate" : "Low");

  const fragmentationPenalty = Math.max(0, selectedDeviceResources.length - 1) * 8;
  const accessoryPenalty = accessoryAssessments.filter(item => !item.fulfilled).length * 18;
  const availabilityBase = directFulfilmentLikely ? 92 : (availableCompatibleCapacity > 0 ? 58 : 28);
  const recommendationScore = Math.max(
    0,
    Math.min(100, Math.round(
      availabilityBase -
      fragmentationPenalty -
      accessoryPenalty -
      (utilisationRatio * 18)
    ))
  );

  const successProbability = Math.max(
    5,
    Math.min(99, Math.round(
      directFulfilmentLikely
        ? 96 - fragmentationPenalty - (utilisationRatio * 12)
        : 42 - accessoryPenalty - (utilisationRatio * 18)
    ))
  );

  const r34 = buildR34Guidance(
    selectedDeviceResources, quantityRequired, fulfilmentMode, conflictHeat,
    totalCompatibleCapacity, availableCompatibleCapacity, accessoryAssessments,
    directFulfilmentLikely, deviceFulfilled, accessoriesFulfilled,
    bookingRequest.softwareRequirements || bookingRequest.softwareRequirement, recommendationScore,
    { alternativeQuantity, alternativeTimes, alternativeDevices }
  );

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
    recommendationScore,
    successProbability,
    conflictHeat,
    qualityLabel: r34.qualityLabel,
    preferredResource: r34.preferredResource,
    conflictExplanation: r34.conflictExplanation,
    operationalImpact: r34.operationalImpact,
    confidenceBreakdown: r34.confidenceBreakdown,
    rankedRecommendations: r34.rankedRecommendations,
    structuredRecommendations: {
      alternativeQuantity,
      alternativeTimes,
      alternativeDevices
    },
    warnings: Array.from(new Set(warnings)),
    recommendations: Array.from(new Set(recommendations)),
    disclaimer: "This is a live advisory estimate. Final allocation is determined when the booking is submitted."
  };
}

module.exports = {
  allocateResources,
  assessBookingAvailability,
  resourceSupportsSoftware,
  normaliseSoftwareRequirements,
  normaliseAdditionalResources,
  normaliseResourceCategory,
  collectResourceIdsFromAllocation,
  findBestResourceCombination,
  buildAllocationBlock,
  normaliseAccessoryCompatibilityKey,
  normaliseCompatibleAccessoryKeys,
  resourceSupportsAdditionalResources
};
