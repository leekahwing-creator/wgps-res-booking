const { createJourneyEngine } = require("./journeyEngine");
const bookingSegmentationEngine = require("./bookingSegmentationEngine");
const express = require("express");
const session = require("express-session");
const argon2 = require("argon2");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");
const { XMLParser, XMLBuilder } = require("fast-xml-parser");
const { allocateResources, assessBookingAvailability } = require("./resourceAllocator");
const { resolveConflict } = require("./conflictResolver");
const { ensureMonthlyBookingsFile } = require("./bookingFileHelper");

const app = express();
const PORT = process.env.PORT || 3000;

// Large yearly booking-import files can exceed Express' default 100kb JSON limit
// after the browser converts Excel rows into JSON for preview/commit.
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));
app.set("trust proxy", 1);

app.use(session({
  secret: process.env.SESSION_SECRET || "change-this-secret",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 1000 * 60 * 60 * 8
  }
}));

app.use(express.static(__dirname));

const appDir = __dirname;
const dataDir = process.env.DATA_DIR || path.join(__dirname, "data");

const sourceUsersFile = path.join(appDir, "users.xml");
const liveUsersFile = path.join(dataDir, "users.xml");
const locationsFile = path.join(appDir, "locations.xml");
const liveLocationsFile = path.join(dataDir, "locations.xml");
const sourceResourcesFile = path.join(appDir, "resources.xml");
const liveResourcesFile = path.join(dataDir, "resources.xml");

const ENCRYPTION_PREFIX = "enc:v1:";

const RESET_TOKEN_EXPIRY_MINUTES = 30;

function getAppBaseUrl() {
  const baseUrl = process.env.APP_BASE_URL;
  if (!baseUrl) {
    throw new Error("APP_BASE_URL is not configured in Render environment variables.");
  }
  return baseUrl.replace(/\/+$/, "");
}

function getSmtpTransporter() {
  const requiredVariables = [
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_USER",
    "SMTP_PASS",
    "SMTP_FROM"
  ];

  const missingVariables = requiredVariables.filter(variable => !process.env[variable]);

  if (missingVariables.length > 0) {
    throw new Error(`Missing SMTP environment variable(s): ${missingVariables.join(", ")}`);
  }

  const port = Number(process.env.SMTP_PORT);

  if (!Number.isInteger(port)) {
    throw new Error("SMTP_PORT must be a valid number.");
  }

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}

function hashResetToken(token) {
  return crypto
    .createHash("sha256")
    .update(String(token))
    .digest("hex");
}

async function sendPasswordResetEmail(user, resetToken) {
  const resetLink =
    `${getAppBaseUrl()}/reset-password.html?email=${encodeURIComponent(user.email)}&token=${encodeURIComponent(resetToken)}`;

  const transporter = getSmtpTransporter();

  await transporter.sendMail({
    from: process.env.SMTP_FROM,
    to: user.email,
    subject: "Reset your ICT Resource Booking Portal password",
    text:
`Hello ${user.name},

A password reset was requested for your ICT Resource Booking Portal account.

Use this link to reset your password:
${resetLink}

This link will expire in ${RESET_TOKEN_EXPIRY_MINUTES} minutes.

If you did not request this reset, you can ignore this email.

ICT Resource Booking Portal`,
    html:
`<p>Hello ${user.name},</p>
<p>A password reset was requested for your ICT Resource Booking Portal account.</p>
<p><a href="${resetLink}">Reset your password</a></p>
<p>This link will expire in <strong>${RESET_TOKEN_EXPIRY_MINUTES} minutes</strong>.</p>
<p>If you did not request this reset, you can ignore this email.</p>
<p>ICT Resource Booking Portal</p>`
  });
}


function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function normaliseEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function ensureDataDir() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

function ensureLiveUsersFile() {
  ensureDataDir();

  if (!fs.existsSync(liveUsersFile)) {
    if (fs.existsSync(sourceUsersFile)) {
      fs.copyFileSync(sourceUsersFile, liveUsersFile);
    } else {
      fs.writeFileSync(
        liveUsersFile,
        `<?xml version="1.0" encoding="UTF-8"?>\n<organisationUsers></organisationUsers>`
      );
    }
  }
}

function getPersonalDataKey() {
  const rawKey = process.env.PERSONAL_DATA_KEY;

  if (!rawKey) {
    throw new Error("PERSONAL_DATA_KEY is not configured in Render environment variables.");
  }

  const trimmedKey = rawKey.trim();

  const base64Key = Buffer.from(trimmedKey, "base64");
  if (base64Key.length === 32) return base64Key;

  if (/^[0-9a-fA-F]{64}$/.test(trimmedKey)) {
    return Buffer.from(trimmedKey, "hex");
  }

  const utf8Key = Buffer.from(trimmedKey, "utf8");
  if (utf8Key.length === 32) return utf8Key;

  throw new Error("PERSONAL_DATA_KEY must decode to exactly 32 bytes. Use: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"");
}

function isEncrypted(value) {
  return typeof value === "string" && value.startsWith(ENCRYPTION_PREFIX);
}

function encryptText(value) {
  if (value === undefined || value === null || value === "") return "";

  const text = String(value);
  if (isEncrypted(text)) return text;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getPersonalDataKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(text, "utf8"),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();

  return ENCRYPTION_PREFIX + Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function decryptText(value) {
  if (!value) return "";

  const text = String(value);
  if (!isEncrypted(text)) return text;

  const packed = Buffer.from(text.slice(ENCRYPTION_PREFIX.length), "base64");
  const iv = packed.subarray(0, 12);
  const tag = packed.subarray(12, 28);
  const encrypted = packed.subarray(28);

  const decipher = crypto.createDecipheriv("aes-256-gcm", getPersonalDataKey(), iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([
    decipher.update(encrypted),
    decipher.final()
  ]).toString("utf8");
}

function sanitiseUserForStorage(user) {
  const storedUser = { ...user };

  if (storedUser.name !== undefined) {
    storedUser.encryptedName = encryptText(storedUser.name);
  }

  if (storedUser.email !== undefined) {
    storedUser.encryptedEmail = encryptText(normaliseEmail(storedUser.email));
  }

  delete storedUser.name;
  delete storedUser.email;

  return storedUser;
}

function decryptUserForUse(user) {
  return {
    ...user,
    name: decryptText(user.encryptedName || user.name),
    email: normaliseEmail(decryptText(user.encryptedEmail || user.email))
  };
}

function readStoredUsers() {
  ensureLiveUsersFile();

  const xml = fs.readFileSync(liveUsersFile, "utf8");
  const parsed = new XMLParser({ ignoreAttributes: false }).parse(xml);
  const users = toArray(parsed.organisationUsers?.user);

  let migrationNeeded = false;
  const storedUsers = users.map(user => {
    const needsMigration = Boolean(user.name || user.email);
    if (needsMigration) migrationNeeded = true;
    return sanitiseUserForStorage(user);
  });

  if (migrationNeeded) {
    saveStoredUsers(storedUsers);
  }

  return storedUsers;
}

function getUsersFromXML() {
  return readStoredUsers().map(decryptUserForUse);
}

function saveStoredUsers(users) {
  ensureLiveUsersFile();

  const builder = new XMLBuilder({
    ignoreAttributes: false,
    format: true,
    suppressEmptyNode: true
  });

  const storedUsers = users.map(sanitiseUserForStorage);

  const xml = builder.build({
    organisationUsers: {
      user: storedUsers
    }
  });

  fs.writeFileSync(liveUsersFile, xml);
}

function saveUsersToXML(users) {
  saveStoredUsers(users);
}

function initialiseUserStorage() {
  ensureDataDir();
  ensureLiveUsersFile();

  // Force migration/encryption during startup so /data/users.xml is protected
  // before any user activates or logs in.
  const storedUsers = readStoredUsers();
  saveStoredUsers(storedUsers);

  try {
    fs.chmodSync(liveUsersFile, 0o600);
  } catch (error) {
    console.warn("Unable to apply restricted permissions to users.xml:", error.message);
  }

  return storedUsers.length;
}


function ensureLiveResourcesFile() {
  ensureDataDir();

  if (!fs.existsSync(liveResourcesFile)) {
    if (fs.existsSync(sourceResourcesFile)) {
      fs.copyFileSync(sourceResourcesFile, liveResourcesFile);
    } else {
      fs.writeFileSync(
        liveResourcesFile,
        `<?xml version="1.0" encoding="UTF-8"?>\n<resources></resources>`
      );
    }
  }
}

function normaliseSoftwareItems(software) {
  if (!software) return [];

  if (Array.isArray(software)) {
    return software.map(item => String(item || "").trim()).filter(Boolean);
  }

  if (typeof software === "string") {
    return software
      .split(",")
      .map(item => item.trim())
      .filter(Boolean);
  }

  if (software.item) {
    return toArray(software.item)
      .map(item => String(item || "").trim())
      .filter(Boolean);
  }

  return [];
}

function normaliseBookingSoftwareRequirements(booking = {}) {
  const source = booking.softwareRequirements?.software ||
    booking.softwareRequirements?.item ||
    booking.softwareRequirements ||
    booking.softwareRequirement ||
    [];

  const values = toArray(source)
    .flatMap(item => typeof item === "string" ? item.split(",") : [item])
    .map(item => String(item || "").trim())
    .filter(item => item && item.toLowerCase() !== "none");

  return Array.from(new Map(values.map(item => [item.toLowerCase(), item])).values())
    .sort((a, b) => a.localeCompare(b));
}

function formatBookingSoftwareForDisplay(booking = {}) {
  const items = normaliseBookingSoftwareRequirements(booking);
  return items.length ? items.join(", ") : "None";
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

function accessoryKeyToDisplayName(key) {
  const normalisedKey = normaliseAccessoryCompatibilityKey(key);
  const displayNames = {
    "ACC-MOUSE": "Mouse",
    "ACC-APPLE-PENCIL": "Apple Pencil",
    "ACC-HEADSET-USB-C": "Headset (USB-C)",
    "ACC-HEADSET-35MM": "Headset (3.5mm audio jack)",
    "ACC-HEADSET": "Headset"
  };

  return displayNames[normalisedKey] || String(key || "").trim();
}

function normaliseCompatibleAccessories(compatibleAccessories) {
  if (!compatibleAccessories) return [];

  if (Array.isArray(compatibleAccessories)) {
    return Array.from(new Set(
      compatibleAccessories
        .map(item => normaliseAccessoryCompatibilityKey(item))
        .filter(Boolean)
    ));
  }

  if (typeof compatibleAccessories === "string") {
    return normaliseCompatibleAccessories(
      compatibleAccessories.split(/[\n,]/).map(item => item.trim())
    );
  }

  if (compatibleAccessories.accessory) {
    return normaliseCompatibleAccessories(toArray(compatibleAccessories.accessory));
  }

  if (compatibleAccessories.item) {
    return normaliseCompatibleAccessories(toArray(compatibleAccessories.item));
  }

  return [];
}

function normaliseResourceStatus(status) {
  const allowedStatuses = ["Available", "Unavailable", "Maintenance", "Retired"];
  return allowedStatuses.includes(status) ? status : "Available";
}

function normaliseResourceCategory(category) {
  return String(category || "Device").trim() === "Accessory" ? "Accessory" : "Device";
}

function normaliseResourceType(type) {
  const allowedTypes = ["Cart", "Bag", "Set", "Other"];
  return allowedTypes.includes(type) ? type : "Set";
}

function normaliseFulfilmentMode(mode, resource = {}) {
  const cleanedMode = String(mode || resource.fulfilmentMode || resource.fulfillmentMode || "").trim();
  const allowedModes = ["Deployment", "Collection"];
  if (allowedModes.includes(cleanedMode)) return cleanedMode;

  // Backward-compatible default for existing resources.xml records that do not
  // yet carry a fulfilmentMode field. iPad bags are collection-only in current
  // operating practice and should not require classroom deployment.
  const name = String(resource.name || "").toLowerCase();
  const deviceType = String(resource.deviceType || "").toLowerCase();
  const resourceType = String(resource.resourceType || "").toLowerCase();
  if (deviceType.includes("ipad") && (resourceType === "bag" || /\bipad\s+bag\b/.test(name))) {
    return "Collection";
  }

  return "Deployment";
}

function resourceRequiresDeployment(resource = {}) {
  return normaliseFulfilmentMode(resource.fulfilmentMode || resource.fulfillmentMode, resource) !== "Collection";
}

function buildResourceLookup() {
  const resources = readResourcesFromXML().map(formatResourceForResponse);
  return new Map(resources.map(resource => [String(resource.id || ""), resource]));
}

function getDEManagedAllocatedResourceIds(booking = {}, resourceById = buildResourceLookup()) {
  return getAllocatedResourceIds(booking).filter(resourceId => {
    const resource = resourceById.get(String(resourceId || ""));
    return resource ? resourceRequiresDeployment(resource) : true;
  });
}

function getUserCollectedAllocatedResourceIds(booking = {}, resourceById = buildResourceLookup()) {
  return getAllocatedResourceIds(booking).filter(resourceId => {
    const resource = resourceById.get(String(resourceId || ""));
    return resource ? !resourceRequiresDeployment(resource) : false;
  });
}

function bookingHasDEManagedResources(booking = {}, resourceById = buildResourceLookup()) {
  return getDEManagedAllocatedResourceIds(booking, resourceById).length > 0;
}

function bookingRequiresDeployment(booking = {}) {
  if (booking.deploymentRequired === false) return false;
  if (String(booking.deploymentRequired || "").toLowerCase() === "false") return false;
  if (String(booking.fulfilmentMode || booking.fulfillmentMode || "").toLowerCase() === "collection") return false;
  return true;
}

function normaliseDeviceType(type) {
  return String(type || "").trim() || "iPad";
}

function normaliseAccessoryVariantType(type) {
  const text = String(type || "").trim();
  const lower = text.toLowerCase();

  if (/head\s*set|headset|headphones?|earpieces?/.test(lower)) {
    if (/usb\s*-?\s*c|type\s*c|usb-c/.test(lower)) return "Headset (USB-C)";
    if (/3\.5|3\.5mm|audio\s*jack|aux|stereo\s*jack/.test(lower)) return "Headset (3.5mm audio jack)";
  }

  return text;
}

function normaliseAccessoryRequestType(type) {
  return normaliseAccessoryVariantType(type);
}


function normaliseSoftwareStatus(status) {
  const allowedStatuses = ["Active", "Retired"];
  return allowedStatuses.includes(status) ? status : "Active";
}

function formatSoftwareForResponse(software) {
  return {
    id: String(software.id || "").trim(),
    name: String(software.name || "").trim(),
    status: normaliseSoftwareStatus(software.status),
    createdAt: software.createdAt || "",
    updatedAt: software.updatedAt || ""
  };
}

function readResourcesDocument(filePath = liveResourcesFile) {
  if (filePath === liveResourcesFile) {
    ensureLiveResourcesFile();
  }
  const xml = fs.readFileSync(filePath, "utf8");
  const parsed = new XMLParser({ ignoreAttributes: false }).parse(xml);

  if (parsed.resourcesData) {
    return {
      resources: toArray(parsed.resourcesData.resources?.resource),
      softwareCatalog: toArray(parsed.resourcesData.softwareCatalog?.software)
    };
  }

  return {
    resources: toArray(parsed.resources?.resource),
    softwareCatalog: toArray(parsed.resources?.softwareCatalog?.software)
  };
}

function normaliseSoftwareCatalog(catalog, resources = []) {
  const existingCatalog = toArray(catalog)
    .map(formatSoftwareForResponse)
    .filter(item => item.name);

  const discoveredNames = resources
    .flatMap(resource => normaliseSoftwareItems(resource.software))
    .filter(Boolean);

  const byName = new Map();

  existingCatalog.forEach(item => {
    const key = item.name.toLowerCase();
    if (!byName.has(key)) {
      byName.set(key, {
        ...item,
        id: item.id || generateSoftwareIdFromName(item.name)
      });
    }
  });

  discoveredNames.forEach(name => {
    const key = String(name).toLowerCase();
    if (!byName.has(key)) {
      byName.set(key, {
        id: generateSoftwareIdFromName(name),
        name,
        status: "Active",
        createdAt: "",
        updatedAt: ""
      });
    }
  });

  return Array.from(byName.values())
    .sort((a, b) => a.name.localeCompare(b.name));
}

function generateSoftwareIdFromName(name) {
  const slug = String(name || "SOFTWARE")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "SOFTWARE";
  return `SW-${slug}`;
}

function generateNextSoftwareId(catalog) {
  const maxNumber = catalog.reduce((max, software) => {
    const match = String(software.id || "").match(/^SW(\d+)$/i);
    if (!match) return max;
    return Math.max(max, Number(match[1]));
  }, 0);

  return `SW${String(maxNumber + 1).padStart(3, "0")}`;
}

function buildResourcesXml(resources, softwareCatalog) {
  return {
    resources: {
      softwareCatalog: {
        software: softwareCatalog.map(formatSoftwareForResponse)
      },
      resource: resources.map(resource => {
        const softwareItems = normaliseSoftwareItems(resource.software);
        return {
          id: String(resource.id || "").trim(),
          name: String(resource.name || "").trim(),
          category: normaliseResourceCategory(resource.category),
          deviceType: normaliseResourceCategory(resource.category) === "Accessory" ? normaliseAccessoryVariantType(resource.deviceType) : normaliseDeviceType(resource.deviceType),
          capacity: Number(resource.capacity) || 0,
          resourceType: normaliseResourceType(resource.resourceType),
          status: normaliseResourceStatus(resource.status),
          location: String(resource.location || "").trim(),
          fulfilmentMode: normaliseFulfilmentMode(resource.fulfilmentMode || resource.fulfillmentMode, resource),
          software: {
            item: softwareItems
          },
          compatibleAccessories: {
            accessory: normaliseResourceCategory(resource.category) === "Device"
              ? normaliseCompatibleAccessories(resource.compatibleAccessories)
              : []
          },
          notes: String(resource.notes || "").trim(),
          createdAt: resource.createdAt || "",
          updatedAt: resource.updatedAt || ""
        };
      })
    }
  };
}

function readResourcesFromXML() {
  return readResourcesDocument().resources;
}

function readSoftwareCatalogFromXML() {
  const document = readResourcesDocument();
  return normaliseSoftwareCatalog(document.softwareCatalog, document.resources);
}

function saveResourcesAndSoftwareToXML(resources, softwareCatalog) {
  ensureLiveResourcesFile();

  const builder = new XMLBuilder({
    ignoreAttributes: false,
    format: true,
    suppressEmptyNode: true
  });

  const normalisedCatalog = normaliseSoftwareCatalog(softwareCatalog, resources);
  const xml = builder.build(buildResourcesXml(resources, normalisedCatalog));
  fs.writeFileSync(liveResourcesFile, xml);
}

function saveResourcesToXML(resources) {
  const document = readResourcesDocument();
  saveResourcesAndSoftwareToXML(resources, document.softwareCatalog);
}

function saveSoftwareCatalogToXML(softwareCatalog) {
  const document = readResourcesDocument();
  saveResourcesAndSoftwareToXML(document.resources, softwareCatalog);
}

function softwareIsUsedByResources(softwareName) {
  const lowerName = String(softwareName || "").toLowerCase();
  return readResourcesFromXML().some(resource =>
    normaliseSoftwareItems(resource.software)
      .some(item => String(item).toLowerCase() === lowerName)
  );
}

function initialiseResourceStorage() {
  ensureLiveResourcesFile();
  const document = readResourcesDocument(liveResourcesFile);

  // Migrate earlier generic Headset accessory records into the default 3.5mm
  // variant so headset inventory can be maintained separately by connector type.
  document.resources.forEach(resource => {
    if (
      normaliseResourceCategory(resource.category) === "Accessory" &&
      String(resource.deviceType || "").trim().toLowerCase() === "headset"
    ) {
      resource.deviceType = "Headset (3.5mm audio jack)";
      if (!/3\.5|usb/i.test(String(resource.name || ""))) {
        resource.name = `${String(resource.name || "Headset Set").trim()} (3.5mm audio jack)`;
      }
      resource.updatedAt = resource.updatedAt || new Date().toISOString();
    }
  });

  // Persistent disks keep an existing resources.xml across deployments. When the
  // bundled resources.xml gains new seed records such as accessory resources, merge
  // only missing records by ID into the live file without overwriting Admin edits.
  if (fs.existsSync(sourceResourcesFile) && path.resolve(sourceResourcesFile) !== path.resolve(liveResourcesFile)) {
    try {
      const sourceDocument = readResourcesDocument(sourceResourcesFile);
      const liveResourceIds = new Set(document.resources.map(resource => String(resource.id || "").toLowerCase()));
      const liveSoftwareKeys = new Set(toArray(document.softwareCatalog).map(item => String(item.name || item.id || "").toLowerCase()));

      sourceDocument.resources.forEach(resource => {
        const id = String(resource.id || "").toLowerCase();
        if (id && !liveResourceIds.has(id)) {
          document.resources.push(resource);
          liveResourceIds.add(id);
        }
      });

      toArray(sourceDocument.softwareCatalog).forEach(software => {
        const key = String(software.name || software.id || "").toLowerCase();
        if (key && !liveSoftwareKeys.has(key)) {
          document.softwareCatalog.push(software);
          liveSoftwareKeys.add(key);
        }
      });
    } catch (error) {
      console.warn("Unable to merge bundled resource seeds into persistent resources.xml:", error.message);
    }
  }

  saveResourcesAndSoftwareToXML(document.resources, document.softwareCatalog);
  return document.resources.length;
}

function generateNextResourceId(resources, deviceType, resourceType) {
  const prefixBase = String(deviceType || "RESOURCE")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "RESOURCE";

  const typePart = String(resourceType || "ITEM")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "ITEM";

  const prefix = `${prefixBase}-${typePart}`;
  const maxNumber = resources.reduce((max, resource) => {
    const match = String(resource.id || "").match(new RegExp(`^${prefix}-(\\d+)$`, "i"));
    if (!match) return max;
    return Math.max(max, Number(match[1]));
  }, 0);

  return `${prefix}-${String(maxNumber + 1).padStart(2, "0")}`;
}

function formatResourceForResponse(resource) {
  return {
    id: resource.id,
    name: resource.name || "",
    category: normaliseResourceCategory(resource.category),
    deviceType: normaliseResourceCategory(resource.category) === "Accessory" ? normaliseAccessoryVariantType(resource.deviceType) : normaliseDeviceType(resource.deviceType),
    capacity: Number(resource.capacity) || 0,
    resourceType: normaliseResourceType(resource.resourceType),
    status: normaliseResourceStatus(resource.status),
    location: resource.location || "",
    fulfilmentMode: normaliseFulfilmentMode(resource.fulfilmentMode || resource.fulfillmentMode, resource),
    deploymentRequired: resourceRequiresDeployment(resource),
    software: normaliseSoftwareItems(resource.software),
    compatibleAccessories: normaliseResourceCategory(resource.category) === "Device"
      ? normaliseCompatibleAccessories(resource.compatibleAccessories).map(accessoryKeyToDisplayName)
      : [],
    compatibleAccessoryKeys: normaliseResourceCategory(resource.category) === "Device"
      ? normaliseCompatibleAccessories(resource.compatibleAccessories)
      : [],
    notes: resource.notes || "",
    createdAt: resource.createdAt || "",
    updatedAt: resource.updatedAt || ""
  };
}

function resourceSupportsAdditionalResourceRequests(resource, additionalResources) {
  const requests = normaliseAdditionalResourceRequests(additionalResources);
  if (requests.length === 0) return true;

  const compatibleKeys = new Set(normaliseCompatibleAccessories(resource.compatibleAccessories));
  if (compatibleKeys.size === 0) return false;

  return requests.every(item => compatibleKeys.has(normaliseAccessoryCompatibilityKey(item.type)));
}

function getAvailableAccessoryKeySet(resources = readResourcesFromXML().map(formatResourceForResponse)) {
  return new Set(
    resources
      .filter(resource => resource.category === "Accessory")
      .filter(resource => resource.status === "Available")
      .map(resource => normaliseAccessoryCompatibilityKey(resource.deviceType))
      .filter(Boolean)
  );
}

function resourceHasFutureBookings(resourceId) {
  const today = new Date().toISOString().split("T")[0];
  return getAllMonthlyBookingFiles().some(file => {
    const bookings = readBookingsFromFile(file);
    return bookings.some(booking => {
      if (String(booking.bookingDate || "") < today) return false;
      if (["Cancelled", "Deleted"].includes(booking.status)) return false;
      const allocatedResourceIds = toArray(booking.allocation?.resources?.resourceId).map(String);
      return allocatedResourceIds.includes(String(resourceId));
    });
  });
}


function ensureLiveLocationsFile() {
  ensureDataDir();

  if (!fs.existsSync(liveLocationsFile)) {
    if (fs.existsSync(locationsFile)) {
      fs.copyFileSync(locationsFile, liveLocationsFile);
    } else {
      fs.writeFileSync(
        liveLocationsFile,
        `<?xml version="1.0" encoding="UTF-8"?>\n<deploymentLocations></deploymentLocations>`
      );
    }
  }
}

function normaliseLocationStatus(status) {
  const allowedStatuses = ["Active", "Inactive", "Retired"];
  return allowedStatuses.includes(status) ? status : "Active";
}

function normaliseLocationAliases(aliases) {
  if (!aliases) return [];
  if (Array.isArray(aliases)) return aliases.map(item => String(item || "").trim()).filter(Boolean);
  if (typeof aliases === "string") return aliases.split(/[\n,]/).map(item => item.trim()).filter(Boolean);
  if (aliases.alias) return toArray(aliases.alias).map(item => String(item || "").trim()).filter(Boolean);
  return [];
}

function generateNextLocationId(locations) {
  const maxNumber = locations.reduce((max, location) => {
    const match = String(location.id || "").match(/^LOC(\d+)$/i);
    if (!match) return max;
    return Math.max(max, Number(match[1]));
  }, 0);

  return `LOC${String(maxNumber + 1).padStart(3, "0")}`;
}

function formatLocationForResponse(location) {
  return {
    id: String(location.id || "").trim(),
    name: String(location.name || location || "").trim(),
    status: normaliseLocationStatus(location.status),
    aliases: normaliseLocationAliases(location.aliases),
    notes: String(location.notes || "").trim(),
    createdAt: location.createdAt || "",
    updatedAt: location.updatedAt || ""
  };
}

function readLocationsFromXML() {
  ensureLiveLocationsFile();

  const xml = fs.readFileSync(liveLocationsFile, "utf8");
  const parsed = new XMLParser({ ignoreAttributes: false }).parse(xml);
  const rawLocations = toArray(parsed.deploymentLocations?.location);

  return rawLocations
    .map((location, index) => {
      if (typeof location === "string") {
        return {
          id: `LOC${String(index + 1).padStart(3, "0")}`,
          name: location,
          status: location === "Other" ? "Active" : "Active",
          aliases: { alias: [] },
          notes: "",
          createdAt: "",
          updatedAt: ""
        };
      }

      return {
        ...location,
        id: location.id || `LOC${String(index + 1).padStart(3, "0")}`,
        name: location.name || "",
        status: normaliseLocationStatus(location.status),
        aliases: { alias: normaliseLocationAliases(location.aliases) }
      };
    })
    .map(formatLocationForResponse)
    .filter(location => location.name);
}

function saveLocationsToXML(locations) {
  ensureLiveLocationsFile();

  const builder = new XMLBuilder({
    ignoreAttributes: false,
    format: true,
    suppressEmptyNode: true
  });

  const xml = builder.build({
    deploymentLocations: {
      location: locations.map(location => {
        const formatted = formatLocationForResponse(location);
        return {
          id: formatted.id,
          name: formatted.name,
          status: formatted.status,
          aliases: {
            alias: formatted.aliases
          },
          notes: formatted.notes,
          createdAt: formatted.createdAt,
          updatedAt: formatted.updatedAt
        };
      })
    }
  });

  fs.writeFileSync(liveLocationsFile, xml);
}

function initialiseLocationStorage() {
  ensureLiveLocationsFile();
  const locations = readLocationsFromXML();
  saveLocationsToXML(locations);
  return locations.length;
}

function getActiveDeploymentLocationNames() {
  const names = readLocationsFromXML()
    .filter(location => location.status === "Active")
    .map(location => location.name)
    .filter(name => name && name !== "Other")
    .sort((a, b) => a.localeCompare(b));

  if (!names.includes("Other")) names.push("Other");
  return names;
}

function locationHasFutureBookings(locationName) {
  const today = new Date().toISOString().split("T")[0];
  const target = String(locationName || "").trim().toLowerCase();
  if (!target) return false;

  return getAllMonthlyBookingFiles().some(file => {
    const bookings = readBookingsFromFile(file);
    return bookings.some(booking => {
      if (String(booking.bookingDate || "") < today) return false;
      if (["Cancelled", "Deleted"].includes(booking.status)) return false;
      return String(booking.location || "").trim().toLowerCase() === target;
    });
  });
}


function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({
      success: false,
      message: "Login required."
    });
  }

  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== "Admin") {
    return res.status(403).json({
      success: false,
      message: "Admin access required."
    });
  }

  next();
}

function requireDEOrAdmin(req, res, next) {
  const role = req.session.user?.role;

  if (!req.session.user || (role !== "DE" && role !== "Admin")) {
    return res.status(403).json({
      success: false,
      message: "DE or Admin access required."
    });
  }

  next();
}

function validatePassword(password, name, email) {
  const errors = [];

  if (!password || password.length < 12) {
    errors.push("Password must be at least 12 characters long.");
  }

  if (password.length > 128) {
    errors.push("Password must not exceed 128 characters.");
  }

  const checks = [
    /[a-z]/.test(password),
    /[A-Z]/.test(password),
    /\d/.test(password),
    /[^A-Za-z0-9]/.test(password)
  ];

  if (checks.filter(Boolean).length < 3) {
    errors.push("Password must include at least 3 of: uppercase, lowercase, number, symbol.");
  }

  const emailPrefix = normaliseEmail(email).split("@")[0];

  if (emailPrefix && password.toLowerCase().includes(emailPrefix)) {
    errors.push("Password must not contain your email name.");
  }

  if (name && password.toLowerCase().includes(String(name).toLowerCase())) {
    errors.push("Password must not contain your name.");
  }

  return errors;
}

function readBookingsFromFile(filePath) {
  const parser = new XMLParser({ ignoreAttributes: false });
  const xml = fs.readFileSync(filePath, "utf8");
  const parsed = parser.parse(xml);

  return toArray(parsed.bookings?.booking);
}

function writeBookingsToFile(filePath, bookings) {
  const builder = new XMLBuilder({
    ignoreAttributes: false,
    format: true,
    suppressEmptyNode: true
  });

  const updatedXml = builder.build({
    bookings: {
      booking: bookings
    }
  });

  fs.writeFileSync(filePath, updatedXml);
}

function getAllMonthlyBookingFiles() {
  const bookingsDir = path.join(dataDir, "bookings");

  if (!fs.existsSync(bookingsDir)) {
    fs.mkdirSync(bookingsDir, { recursive: true });
  }

  return fs.readdirSync(bookingsDir)
    .filter(file => file.endsWith(".xml"))
    .map(file => path.join(bookingsDir, file));
}

function userOwnsBooking(req, booking) {
  const sameUserId = booking.userId && String(booking.userId) === String(req.session.user.userId);
  const sameLegacyEmail = booking.email && normaliseEmail(booking.email) === normaliseEmail(req.session.user.email);
  return Boolean(sameUserId || sameLegacyEmail);
}

function userCanManageBooking(req, booking) {
  return req.session.user?.role === "Admin" || userOwnsBooking(req, booking);
}

function formatBookingForManagementResponse(booking, users) {
  const requester = users.find(user => String(user.userId || "") === String(booking.userId || ""));
  return {
    ...booking,
    softwareRequirements: {
      software: normaliseBookingSoftwareRequirements(booking)
    },
    softwareRequirement: formatBookingSoftwareForDisplay(booking),
    requesterName: requester?.name || booking.importedRequesterName || "Requester",
    requesterEmail: requester?.email || booking.importedRequesterEmail || "",
    isManagedByAdmin: true
  };
}

function removePersonalDataFromBooking(booking) {
  const cleanedBooking = { ...booking };
  delete cleanedBooking.name;
  delete cleanedBooking.email;
  return cleanedBooking;
}

function generateNextUserId(users) {
  const maxNumber = users.reduce((max, user) => {
    const match = String(user.userId || "").match(/^U(\d+)$/i);
    if (!match) return max;
    return Math.max(max, Number(match[1]));
  }, 0);

  return `U${String(maxNumber + 1).padStart(4, "0")}`;
}

function normaliseUserStatus(status) {
  const allowedStatuses = ["PendingActivation", "Active", "Disabled"];
  return allowedStatuses.includes(status) ? status : "PendingActivation";
}

function normaliseUserRole(role) {
  const allowedRoles = ["User", "DE", "Admin"];
  return allowedRoles.includes(role) ? role : "User";
}

function normaliseBoolean(value) {
  if (value === true) return true;
  if (value === false) return false;
  return String(value || "").trim().toLowerCase() === "true";
}

function userCanCreateRecurringBookings(user) {
  return normaliseUserRole(user?.role) === "Admin" || normaliseBoolean(user?.allowRecurringBookings);
}

function formatAdminUserForResponse(user) {
  return {
    userId: user.userId,
    name: user.name || "",
    email: user.email || "",
    role: normaliseUserRole(user.role),
    status: normaliseUserStatus(user.status),
    activatedAt: user.activatedAt || "",
    passwordResetAt: user.passwordResetAt || "",
    roleUpdatedAt: user.roleUpdatedAt || "",
    updatedAt: user.updatedAt || "",
    createdAt: user.createdAt || "",
    createdByUserId: user.createdByUserId || "",
    updatedByUserId: user.updatedByUserId || "",
    disabledByUserId: user.disabledByUserId || "",
    activationResetByUserId: user.activationResetByUserId || "",
    allowRecurringBookings: userCanCreateRecurringBookings(user),
    allowRecurringBookingsByPermission: normaliseBoolean(user.allowRecurringBookings),
    hasPasswordHash: Boolean(user.passwordHash)
  };
}

function normaliseDeploymentStatus(booking) {
  return booking.deploymentStatus || "Pending Deployment";
}

function getUserDisplayNameById(users, userId) {
  if (!userId) return "";
  const user = users.find(existingUser => String(existingUser.userId) === String(userId));
  return user?.name || "";
}

function getDateBookingsFile(bookingDate) {
  if (!bookingDate) {
    throw new Error("Booking date is required.");
  }

  return ensureMonthlyBookingsFile(bookingDate);
}

function getBookingRecordId(booking = {}) {
  return String(booking["@_id"] || booking.bookingId || "").trim();
}

function getBookingIdentityKey(booking = {}) {
  return [
    getBookingRecordId(booking),
    String(booking.bookingDate || ""),
    String(booking.startTime || ""),
    String(booking.endTime || ""),
    String(booking.location || ""),
    String(booking.userId || "")
  ].join("|");
}

function findBookingsById(bookings, bookingId) {
  const target = String(bookingId || "");
  return bookings.filter(booking => getBookingRecordId(booking) === target);
}

function findBookingById(bookings, bookingId) {
  const matches = findBookingsById(bookings, bookingId);
  if (matches.length > 1) {
    const error = new Error(`Booking identity conflict: ${matches.length} records share booking ID ${bookingId}.`);
    error.statusCode = 409;
    error.code = "DUPLICATE_BOOKING_ID";
    throw error;
  }
  return matches[0];
}

function getNextBookingRecordId(bookings = []) {
  const numericIds = bookings
    .map(booking => Number.parseInt(getBookingRecordId(booking), 10))
    .filter(Number.isFinite);
  return String((numericIds.length ? Math.max(...numericIds) : 0) + 1);
}

function getDuplicateBookingIds(bookings = []) {
  const counts = new Map();
  bookings.forEach(booking => {
    const id = getBookingRecordId(booking);
    if (!id) return;
    counts.set(id, (counts.get(id) || 0) + 1);
  });
  return Array.from(counts.entries())
    .filter(([, count]) => count > 1)
    .map(([bookingId, count]) => ({ bookingId, count }));
}

function normaliseResourceIdList(value) {
  return toArray(value)
    .map(item => String(item || "").trim())
    .filter(Boolean);
}

function getAllocatedResourceIds(booking = {}) {
  const ids = [
    ...normaliseResourceIdList(booking.allocation?.resources?.resourceId)
  ];

  toArray(booking.allocation?.additionalResources?.resource).forEach(item => {
    ids.push(...normaliseResourceIdList(item?.resources?.resourceId));
  });

  return Array.from(new Set(ids));
}

function timeToMinutes(value) {
  const match = String(value || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function getResourceHomeLocation(resource = {}) {
  return String(resource.location || "").trim() || "ICT Room";
}

let journeyEngineInstance = null;

function getJourneyEngine() {
  if (!journeyEngineInstance) {
    journeyEngineInstance = createJourneyEngine({
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
    });
  }
  return journeyEngineInstance;
}


function getResourceCategoryPriority(resource = {}) {
  return normaliseResourceCategory(resource.category) === "Accessory" ? 2 : 1;
}

function getMovementTypePriority(type) {
  return String(type || "") === "Deployment" ? 1 : 2;
}

function findActiveOperationalBundleBooking(bookings, userId) {
  return bookings.find(booking =>
    String(booking.claimedByUserId || "") === String(userId || "") &&
    String(booking.operationalBundle?.status || "") === "Active"
  );
}


function formatDeploymentBookingForResponse(booking, users, provenanceByBookingId = new Map()) {
  const requesterName = getUserDisplayNameById(users, booking.userId) || "Requester";
  const claimedByName = booking.claimedByName || getUserDisplayNameById(users, booking.claimedByUserId);
  const deployedByName = booking.deployedByName || getUserDisplayNameById(users, booking.deployedByUserId);
  const bookingId = getBookingRecordId(booking);
  const bookingIdentityKey = getBookingIdentityKey(booking);
  const resourceMovements = provenanceByBookingId.get(bookingIdentityKey) || [];
  const resourceById = buildResourceLookup();
  const deManagedResourceIds = getDEManagedAllocatedResourceIds(booking, resourceById);
  const userCollectedResourceIds = getUserCollectedAllocatedResourceIds(booking, resourceById);
  const deManagedResources = deManagedResourceIds.map(resourceId => {
    const resource = resourceById.get(resourceId) || {};
    return {
      resourceId,
      resourceName: resource.name || resourceId,
      category: resource.category || "",
      fulfilmentMode: resource.fulfilmentMode || "Deployment"
    };
  });
  const userCollectedResources = userCollectedResourceIds.map(resourceId => {
    const resource = resourceById.get(resourceId) || {};
    return {
      resourceId,
      resourceName: resource.name || resourceId,
      category: resource.category || "",
      fulfilmentMode: resource.fulfilmentMode || "Collection"
    };
  });
  const pickupLocations = Array.from(new Set(resourceMovements.map(item => item.pickupLocation).filter(Boolean)));
  return {
    ...booking,
    bookingId,
    bookingIdentityKey,
    requesterName,
    deploymentStatus: normaliseDeploymentStatus(booking),
    claimedByName: claimedByName || "",
    deployedByName: deployedByName || "",
    resourceMovements,
    deManagedResources,
    userCollectedResources,
    deManagedResourceIds,
    userCollectedResourceIds,
    pickupLocations,
    pickupLocationSummary: pickupLocations.length ? pickupLocations.join(" + ") : "ICT Room",
    destinationLocation: String(booking.location || ""),
    multiplePickupLocations: pickupLocations.length > 1,
    movementComplexity: pickupLocations.length > 1 ? "Multiple pickup locations" : "Single pickup location",
    operationalBundle: booking.operationalBundle
      ? {
          ...booking.operationalBundle,
          resourcesToCollect: {
            resource: toArray(
              booking.operationalBundle?.resourcesToCollect?.resource ||
              booking.operationalBundle?.resourcesToCollect
            )
          },
          legs: {
            leg: getJourneyEngine().normaliseOperationalBundleLegs(booking.operationalBundle)
          }
        }
      : null
  };
}

function updateDeploymentBooking(bookingDate, bookingId, updater) {
  const bookingsFile = getDateBookingsFile(bookingDate);
  const bookings = readBookingsFromFile(bookingsFile);
  const booking = findBookingById(bookings, bookingId);

  if (!booking) {
    const error = new Error("Booking not found.");
    error.statusCode = 404;
    throw error;
  }

  updater(booking);
  writeBookingsToFile(bookingsFile, bookings);

  return booking;
}

/* ---------------- AUTH ROUTES ---------------- */

app.post("/api/auth/check-email", (req, res) => {
  try {
    const cleanedEmail = normaliseEmail(req.body.email);
    const users = getUsersFromXML();

    const user = users.find(
      existingUser => normaliseEmail(existingUser.email) === cleanedEmail
    );

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "This email address is not registered with the organisation."
      });
    }

    res.json({
      success: true,
      name: user.name,
      email: user.email,
      status: user.status || "PendingActivation",
      isActivated: user.status === "Active" && Boolean(user.passwordHash)
    });
  } catch (error) {
    console.error("Check email error:", error);

    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.post("/api/auth/activate", async (req, res) => {
  try {
    const { email, password } = req.body;
    const cleanedEmail = normaliseEmail(email);

    if (!cleanedEmail || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required."
      });
    }

    const users = getUsersFromXML();

    const userIndex = users.findIndex(
      user => normaliseEmail(user.email) === cleanedEmail
    );

    if (userIndex === -1) {
      return res.status(403).json({
        success: false,
        message: "This email address is not registered with the organisation."
      });
    }

    const user = users[userIndex];

    if (user.status === "Active" && user.passwordHash) {
      return res.status(409).json({
        success: false,
        message: "This account has already been activated. Please sign in."
      });
    }

    const passwordErrors = validatePassword(password, user.name, cleanedEmail);

    if (passwordErrors.length > 0) {
      return res.status(400).json({
        success: false,
        message: passwordErrors.join(" ")
      });
    }

    const passwordHash = await argon2.hash(password, {
      type: argon2.argon2id
    });

    users[userIndex] = {
      ...user,
      passwordHash,
      role: user.role || "User",
      status: "Active",
      activatedAt: new Date().toISOString()
    };

    saveUsersToXML(users);

    res.json({
      success: true,
      message: "Account activated successfully. Please sign in."
    });
  } catch (error) {
    console.error("Activate account error:", error);

    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.post("/api/auth/register", (req, res) => {
  res.status(410).json({
    success: false,
    message: "Open registration is disabled. Please activate your pre-approved organisation account."
  });
});


app.post("/api/auth/forgot-password", async (req, res) => {
  const genericResponse = {
    success: true,
    message: "If the email address is registered and active, a password reset link will be sent shortly."
  };

  try {
    const cleanedEmail = normaliseEmail(req.body.email);

    if (!cleanedEmail) {
      return res.json(genericResponse);
    }

    const users = getUsersFromXML();

    const userIndex = users.findIndex(
      existingUser => normaliseEmail(existingUser.email) === cleanedEmail
    );

    if (userIndex === -1) {
      return res.json(genericResponse);
    }

    const user = users[userIndex];

    if (user.status !== "Active" || !user.passwordHash) {
      return res.json(genericResponse);
    }

    const resetToken = crypto.randomBytes(32).toString("hex");

    users[userIndex] = {
      ...user,
      resetPasswordTokenHash: hashResetToken(resetToken),
      resetPasswordExpiresAt: new Date(Date.now() + RESET_TOKEN_EXPIRY_MINUTES * 60 * 1000).toISOString(),
      resetPasswordRequestedAt: new Date().toISOString()
    };

    saveUsersToXML(users);

    try {
      await sendPasswordResetEmail(user, resetToken);
    } catch (emailError) {
      console.error("Password reset email error:", emailError);
    }

    return res.json(genericResponse);
  } catch (error) {
    console.error("Forgot password error:", error);

    return res.json(genericResponse);
  }
});


app.post("/api/auth/validate-reset-token", (req, res) => {
  try {
    const { email, token } = req.body;
    const cleanedEmail = normaliseEmail(email);
    const cleanedToken = String(token || "").trim();

    if (!cleanedEmail || !cleanedToken) {
      return res.status(400).json({
        success: false,
        message: "This password reset link is invalid or has expired."
      });
    }

    const users = getUsersFromXML();

    const user = users.find(
      existingUser => normaliseEmail(existingUser.email) === cleanedEmail
    );

    if (!user) {
      return res.status(400).json({
        success: false,
        message: "This password reset link is invalid or has expired."
      });
    }

    const tokenHash = hashResetToken(cleanedToken);

    const tokenIsValid =
      user.resetPasswordTokenHash &&
      user.resetPasswordTokenHash === tokenHash;

    const tokenHasNotExpired =
      user.resetPasswordExpiresAt &&
      new Date(user.resetPasswordExpiresAt).getTime() > Date.now();

    if (!tokenIsValid || !tokenHasNotExpired) {
      return res.status(400).json({
        success: false,
        message: "This password reset link is invalid or has expired."
      });
    }

    return res.json({
      success: true,
      message: "Password reset link is valid."
    });
  } catch (error) {
    console.error("Validate reset token error:", error);

    return res.status(400).json({
      success: false,
      message: "This password reset link is invalid or has expired."
    });
  }
});

app.post("/api/auth/reset-password", async (req, res) => {
  try {
    const { email, token, password } = req.body;
    const cleanedEmail = normaliseEmail(email);
    const cleanedToken = String(token || "").trim();

    if (!cleanedEmail || !cleanedToken || !password) {
      return res.status(400).json({
        success: false,
        message: "Email, reset token and new password are required."
      });
    }

    const users = getUsersFromXML();

    const userIndex = users.findIndex(
      existingUser => normaliseEmail(existingUser.email) === cleanedEmail
    );

    if (userIndex === -1) {
      return res.status(400).json({
        success: false,
        message: "The reset link is invalid or has expired."
      });
    }

    const user = users[userIndex];

    const tokenHash = hashResetToken(cleanedToken);
    const tokenIsValid =
      user.resetPasswordTokenHash &&
      user.resetPasswordTokenHash === tokenHash;

    const tokenHasNotExpired =
      user.resetPasswordExpiresAt &&
      new Date(user.resetPasswordExpiresAt).getTime() > Date.now();

    if (!tokenIsValid || !tokenHasNotExpired) {
      return res.status(400).json({
        success: false,
        message: "The reset link is invalid or has expired."
      });
    }

    const passwordErrors = validatePassword(password, user.name, cleanedEmail);

    if (passwordErrors.length > 0) {
      return res.status(400).json({
        success: false,
        message: passwordErrors.join(" ")
      });
    }

    const passwordHash = await argon2.hash(password, {
      type: argon2.argon2id
    });

    const updatedUser = {
      ...user,
      passwordHash,
      passwordResetAt: new Date().toISOString(),
      resetPasswordTokenHash: "",
      resetPasswordExpiresAt: "",
      resetPasswordRequestedAt: ""
    };

    users[userIndex] = updatedUser;

    saveUsersToXML(users);

    req.session.destroy(() => {
      res.json({
        success: true,
        message: "Password reset successfully. Please sign in with your new password."
      });
    });
  } catch (error) {
    console.error("Reset password error:", error);

    res.status(500).json({
      success: false,
      message: "Unable to reset password."
    });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const cleanedEmail = normaliseEmail(email);

    const users = getUsersFromXML();

    const user = users.find(
      existingUser => normaliseEmail(existingUser.email) === cleanedEmail
    );

    if (!user || user.status !== "Active" || !user.passwordHash) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password."
      });
    }

    const passwordMatches = await argon2.verify(user.passwordHash, password || "");

    if (!passwordMatches) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password."
      });
    }

    req.session.user = {
      userId: user.userId,
      name: user.name,
      email: user.email,
      role: user.role || "User",
      allowRecurringBookings: userCanCreateRecurringBookings(user)
    };

    res.json({
      success: true,
      user: req.session.user
    });
  } catch (error) {
    console.error("Login error:", error);

    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.get("/api/me", (req, res) => {
  res.json({
    success: true,
    user: req.session.user || null
  });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

/* ---------------- BASIC DATA ROUTES ---------------- */

app.get("/api/users", requireLogin, (req, res) => {
  res.json({ users: [req.session.user.name] });
});

app.get("/api/locations", (req, res) => {
  try {
    res.json({ locations: getActiveDeploymentLocationNames() });
  } catch (error) {
    console.error("Locations retrieval error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});


app.get("/api/resources/catalog", requireLogin, (req, res) => {
  try {
    const resources = readResourcesFromXML().map(formatResourceForResponse);

    const deviceTypes = Array.from(new Set(
      resources
        .filter(resource => resource.category !== "Accessory")
        .filter(resource => resource.status === "Available")
        .map(resource => resource.deviceType)
        .filter(Boolean)
    )).sort((a, b) => a.localeCompare(b));

    const accessoryTypes = Array.from(new Set(
      resources
        .filter(resource => resource.category === "Accessory")
        .filter(resource => resource.status === "Available")
        .map(resource => resource.deviceType)
        .filter(Boolean)
    )).sort((a, b) => a.localeCompare(b));

    const availableAccessoryKeys = new Set(
      resources
        .filter(resource => resource.category === "Accessory")
        .filter(resource => resource.status === "Available")
        .map(resource => normaliseAccessoryCompatibilityKey(resource.deviceType))
        .filter(Boolean)
    );

    const accessoryCompatibilityByDevice = deviceTypes.reduce((lookup, deviceType) => {
      const compatibleKeys = new Set();

      resources
        .filter(resource => resource.category !== "Accessory")
        .filter(resource => resource.status === "Available")
        .filter(resource => String(resource.deviceType || "").trim().toLowerCase() === String(deviceType).trim().toLowerCase())
        .forEach(resource => {
          normaliseCompatibleAccessories(resource.compatibleAccessoryKeys || resource.compatibleAccessories)
            .filter(key => availableAccessoryKeys.has(key))
            .forEach(key => compatibleKeys.add(key));
        });

      lookup[deviceType] = Array.from(compatibleKeys)
        .map(accessoryKeyToDisplayName)
        .filter(displayName => accessoryTypes.some(type =>
          normaliseAccessoryCompatibilityKey(type) === normaliseAccessoryCompatibilityKey(displayName)
        ))
        .sort((a, b) => a.localeCompare(b));

      return lookup;
    }, {});

    const activeSoftwareCatalog = readSoftwareCatalogFromXML()
      .map(formatSoftwareForResponse)
      .filter(software => software.status === "Active");

    const softwareByDevice = deviceTypes.reduce((lookup, deviceType) => {
      const installedNames = new Set();

      resources
        .filter(resource => resource.category !== "Accessory")
        .filter(resource => resource.status === "Available")
        .filter(resource =>
          String(resource.deviceType || "").trim().toLowerCase() ===
          String(deviceType || "").trim().toLowerCase()
        )
        .forEach(resource => {
          normaliseSoftwareItems(resource.software)
            .forEach(name => installedNames.add(String(name).trim()));
        });

      lookup[deviceType] = activeSoftwareCatalog
        .filter(software => installedNames.has(String(software.name || "").trim()))
        .map(software => ({ id: software.id, name: software.name }))
        .sort((a, b) => a.name.localeCompare(b.name));

      return lookup;
    }, {});

    res.json({
      success: true,
      deviceTypes,
      accessoryTypes,
      accessoryCompatibilityByDevice,
      softwareCatalog: activeSoftwareCatalog.map(software => ({
        id: software.id,
        name: software.name
      })),
      softwareByDevice
    });
  } catch (error) {
    console.error("Resource catalog retrieval error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

function normaliseAdditionalResourceRequests(additionalResources) {
  return toArray(additionalResources?.resource || additionalResources)
    .map(item => ({
      type: normaliseAccessoryRequestType(item?.type || item?.deviceType || item?.name || ""),
      quantity: Number(item?.quantity || 0)
    }))
    .filter(item => item.type && Number.isInteger(item.quantity) && item.quantity > 0);
}

function validateAdditionalResourceRequests(bookingRequest) {
  const errors = [];
  const resources = readResourcesFromXML().map(formatResourceForResponse);
  const accessoryKeySet = getAvailableAccessoryKeySet(resources);
  const additionalRequests = normaliseAdditionalResourceRequests(bookingRequest.additionalResources);

  additionalRequests.forEach(item => {
    const accessoryKey = normaliseAccessoryCompatibilityKey(item.type);
    if (!accessoryKeySet.has(accessoryKey)) {
      errors.push(`${accessoryKeyToDisplayName(item.type)} is not an available accessory resource.`);
    }
  });

  const requestedHeadsetVariants = new Set(
    additionalRequests
      .map(item => normaliseAccessoryCompatibilityKey(item.type))
      .filter(key => key === "ACC-HEADSET-USB-C" || key === "ACC-HEADSET-35MM")
  );

  if (requestedHeadsetVariants.size > 1) {
    errors.push("Only one headset connector type may be requested for a booking.");
  }

  if (errors.length > 0 || additionalRequests.length === 0) {
    return errors;
  }

  const candidateDevices = resources
    .filter(resource => resource.category !== "Accessory")
    .filter(resource => resource.status === "Available")
    .filter(resource => String(resource.deviceType || "") === String(bookingRequest.deviceType || ""));

  if (candidateDevices.length === 0) {
    return errors;
  }

  const compatibleCandidateExists = candidateDevices.some(resource =>
    resourceSupportsAdditionalResourceRequests(resource, additionalRequests)
  );

  if (!compatibleCandidateExists) {
    const requestedAccessories = additionalRequests
      .map(item => accessoryKeyToDisplayName(item.type))
      .join(", ");
    errors.push(`No available ${bookingRequest.deviceType} resource is configured as compatible with the requested accessory combination: ${requestedAccessories}.`);
  }

  return errors;
}


app.post("/api/booking-advice", requireLogin, (req, res) => {
  try {
    const bookingRequest = prepareBookingForSave(removePersonalDataFromBooking({
      ...req.body,
      userId: req.session.user.userId
    }));

    const requiredFields = [
      ["bookingDate", "Booking date"],
      ["startTime", "Start time"],
      ["endTime", "End time"],
      ["deviceType", "Device type"]
    ];

    const missing = requiredFields
      .filter(([key]) => !String(bookingRequest[key] || "").trim())
      .map(([, label]) => label);

    if (!Number.isInteger(Number(bookingRequest.devicesRequired)) ||
        Number(bookingRequest.devicesRequired) <= 0) {
      missing.push("Number of devices");
    }

    if (missing.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Complete these fields before availability can be assessed: ${missing.join(", ")}.`
      });
    }

    if (bookingRequest.endTime <= bookingRequest.startTime) {
      return res.status(400).json({
        success: false,
        message: "End time must be later than start time."
      });
    }

    const additionalResourceErrors = validateAdditionalResourceRequests(bookingRequest);
    if (additionalResourceErrors.length > 0) {
      return res.status(400).json({
        success: false,
        message: additionalResourceErrors.join(" ")
      });
    }

    const advice = assessBookingAvailability(bookingRequest);

    return res.json({
      success: true,
      advice
    });
  } catch (error) {
    console.error("Booking advice error:", error);
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

function normaliseFingerprintText(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function getCanonicalAdditionalResources(additionalResources) {
  return normaliseAdditionalResourceRequests(additionalResources)
    .map(item => ({
      type: normaliseFingerprintText(item.type),
      quantity: Number(item.quantity) || 0
    }))
    .filter(item => item.type && item.quantity > 0)
    .sort((a, b) => a.type.localeCompare(b.type))
    .map(item => `${item.type}:${item.quantity}`)
    .join("|");
}

function buildBookingFingerprintPayload(booking) {
  return {
    userId: String(booking.userId || ""),
    bookingDate: String(booking.bookingDate || ""),
    startTime: String(booking.startTime || ""),
    endTime: String(booking.endTime || ""),
    location: normaliseFingerprintText(booking.location),
    deviceType: normaliseFingerprintText(booking.deviceType),
    devicesRequired: Number(booking.devicesRequired || 0),
    softwareRequirements: normaliseBookingSoftwareRequirements(booking)
      .map(normaliseFingerprintText)
      .join("|"),
    additionalResources: getCanonicalAdditionalResources(booking.additionalResources)
  };
}

function generateBookingFingerprint(booking) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(buildBookingFingerprintPayload(booking)))
    .digest("hex");
}

function getActiveBookingsForDate(bookingDate) {
  const bookingsFile = ensureMonthlyBookingsFile(bookingDate);
  return readBookingsFromFile(bookingsFile)
    .filter(booking => booking.status !== "Deleted" && booking.status !== "Cancelled");
}

function findDuplicateBooking(bookingRequest, options = {}) {
  const fingerprint = generateBookingFingerprint(bookingRequest);
  const bookings = getActiveBookingsForDate(bookingRequest.bookingDate);
  return bookings.find(booking => {
    if (options.excludeBookingId && String(booking["@_id"]) === String(options.excludeBookingId)) {
      return false;
    }

    if (String(booking.userId || "") !== String(bookingRequest.userId || "")) {
      return false;
    }

    const existingFingerprint = booking.bookingFingerprint || generateBookingFingerprint(booking);
    return existingFingerprint === fingerprint;
  });
}

function getBookingsByRequestId(bookingRequestId, userId) {
  const cleanedRequestId = String(bookingRequestId || "").trim();
  if (!cleanedRequestId) return [];

  return getAllMonthlyBookingFiles()
    .flatMap(file => readBookingsFromFile(file))
    .filter(booking => booking.status !== "Deleted" && booking.status !== "Cancelled")
    .filter(booking => String(booking.userId || "") === String(userId || ""))
    .filter(booking => String(booking.bookingRequestId || "") === cleanedRequestId)
    .sort((a, b) => `${a.bookingDate || ""} ${a.startTime || ""}`.localeCompare(`${b.bookingDate || ""} ${b.startTime || ""}`));
}

function prepareBookingForSave(bookingRequest) {
  const softwareItems = normaliseBookingSoftwareRequirements(bookingRequest);
  const prepared = {
    ...bookingRequest,
    bookingRequestId: String(bookingRequest.bookingRequestId || "").trim(),
    softwareRequirements: {
      software: softwareItems
    },
    // Retained for backward compatibility with existing pages and historic exports.
    softwareRequirement: softwareItems.length ? softwareItems.join(", ") : "None",
    additionalResources: {
      resource: normaliseAdditionalResourceRequests(bookingRequest.additionalResources)
    }
  };

  prepared.bookingFingerprint = generateBookingFingerprint(prepared);
  return prepared;
}



/* ---------------- BOOKING IMPORT FOUNDATION ---------------- */

function normaliseImportValue(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function getImportValue(row, keys) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== "") {
      return row[key];
    }
  }

  const lowerMap = new Map(Object.keys(row || {}).map(key => [key.toLowerCase().trim(), key]));
  for (const key of keys) {
    const actualKey = lowerMap.get(String(key).toLowerCase().trim());
    if (actualKey && String(row[actualKey]).trim() !== "") return row[actualKey];
  }

  return "";
}

function normaliseImportDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }

  const text = normaliseImportValue(value);
  if (!text) return "";

  const isoMatch = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (isoMatch) {
    return `${isoMatch[1]}-${String(isoMatch[2]).padStart(2, "0")}-${String(isoMatch[3]).padStart(2, "0")}`;
  }

  const sgMatch = text.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (sgMatch) {
    return `${sgMatch[3]}-${String(sgMatch[2]).padStart(2, "0")}-${String(sgMatch[1]).padStart(2, "0")}`;
  }

  return text;
}


function normaliseImportDateRange(value) {
  const text = normaliseImportValue(value);
  if (!text) return "";
  const normalised = normaliseImportDate(text);
  return /^\d{4}-\d{2}-\d{2}$/.test(normalised) ? normalised : "";
}

function getImportDateRange(body = {}) {
  const importFrom = normaliseImportDateRange(body.importFrom);
  const importTo = normaliseImportDateRange(body.importTo);

  if (importFrom && importTo && importFrom > importTo) {
    const error = new Error("Import From date cannot be later than Import To date.");
    error.statusCode = 400;
    throw error;
  }

  return { importFrom, importTo };
}

function bookingIsWithinImportDateRange(bookingDate, dateRange = {}) {
  const normalisedDate = normaliseImportDateRange(bookingDate);
  if (!normalisedDate) return false;
  if (dateRange.importFrom && normalisedDate < dateRange.importFrom) return false;
  if (dateRange.importTo && normalisedDate > dateRange.importTo) return false;
  return true;
}

function normaliseImportTime(value) {
  const text = normaliseImportValue(value);
  if (!text) return "";
  const match = text.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/i);
  if (!match) return text;

  let hour = Number(match[1]);
  const minute = match[2];
  const suffix = match[3]?.toUpperCase();

  if (suffix === "PM" && hour < 12) hour += 12;
  if (suffix === "AM" && hour === 12) hour = 0;

  return `${String(hour).padStart(2, "0")}:${minute}`;
}

function getAvailableAccessoryTypes() {
  return Array.from(new Set(
    readResourcesFromXML()
      .map(formatResourceForResponse)
      .filter(resource => resource.category === "Accessory")
      .filter(resource => resource.status === "Available")
      .map(resource => resource.deviceType)
      .filter(Boolean)
  ));
}



function buildLegacyEmailCandidates(email) {
  const cleanedEmail = normaliseEmail(email);
  if (!cleanedEmail) return [];

  const candidates = new Set([cleanedEmail]);

  if (cleanedEmail.endsWith("@schools.gov.sg")) {
    candidates.add(cleanedEmail.replace(/@schools\.gov\.sg$/i, "@moe.edu.sg"));
  }

  if (cleanedEmail.endsWith("@moe.edu.sg")) {
    candidates.add(cleanedEmail.replace(/@moe\.edu\.sg$/i, "@schools.gov.sg"));
  }

  return Array.from(candidates);
}

function normaliseLegacyNameForMatching(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/@/g, " ")
    .replace(/\bbinte\b/g, " ")
    .replace(/\bbte\b/g, " ")
    .replace(/\bbin\b/g, " ")
    .replace(/\bs\/o\b/g, " ")
    .replace(/\bd\/o\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getNameTokens(value) {
  return normaliseLegacyNameForMatching(value)
    .split(" ")
    .filter(token => token.length > 1);
}

function calculateNameSimilarity(a, b) {
  const aTokens = getNameTokens(a);
  const bTokens = getNameTokens(b);
  if (!aTokens.length || !bTokens.length) return 0;

  const aSet = new Set(aTokens);
  const bSet = new Set(bTokens);
  const intersection = Array.from(aSet).filter(token => bSet.has(token)).length;
  const denominator = Math.max(aSet.size, bSet.size);

  return denominator ? intersection / denominator : 0;
}

function findLegacyRequesterUser(users, requesterEmail, requesterName) {
  const emailCandidates = buildLegacyEmailCandidates(requesterEmail);

  for (const candidate of emailCandidates) {
    const user = users.find(existingUser => normaliseEmail(existingUser.email) === candidate);
    if (user) {
      return {
        user,
        matchMethod: candidate === normaliseEmail(requesterEmail)
          ? "Exact email match"
          : "Email domain-normalised match"
      };
    }
  }

  const legacyLocalPart = normaliseEmail(requesterEmail).split("@")[0];
  if (legacyLocalPart) {
    const user = users.find(existingUser => normaliseEmail(existingUser.email).split("@")[0] === legacyLocalPart);
    if (user) {
      return {
        user,
        matchMethod: "Email username match"
      };
    }
  }

  const normalisedRequesterName = normaliseLegacyNameForMatching(requesterName);
  if (normalisedRequesterName) {
    const exactNameUser = users.find(existingUser =>
      normaliseLegacyNameForMatching(existingUser.name) === normalisedRequesterName
    );

    if (exactNameUser) {
      return {
        user: exactNameUser,
        matchMethod: "Exact name match"
      };
    }

    let bestMatch = null;
    let bestScore = 0;

    users.forEach(existingUser => {
      const score = calculateNameSimilarity(requesterName, existingUser.name);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = existingUser;
      }
    });

    if (bestMatch && bestScore >= 0.72) {
      return {
        user: bestMatch,
        matchMethod: `Intelligent name match (${Math.round(bestScore * 100)}%)`
      };
    }
  }

  return {
    user: null,
    matchMethod: "No match"
  };
}

function normaliseResourceLookupText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/ipad/g, "ipad")
    .replace(/\bipads\b/g, "ipad")
    .replace(/\bnotebooks?\b/g, "laptop")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getResourceCapacityLookup() {
  return readResourcesFromXML()
    .map(formatResourceForResponse)
    .reduce((lookup, resource) => {
      const key = normaliseResourceLookupText(resource.name);
      if (key) lookup.set(key, Number(resource.capacity) || 0);
      return lookup;
    }, new Map());
}


function legacyResourceItemIsAccessory(text) {
  const normalised = normaliseSearchText(text);
  return /apple\s*pencil|stylus|head\s*set|headset|headphones?|earpieces?|\bmouse\b|mice/.test(normalised);
}

function legacyResourceItemIsDevice(text) {
  const normalised = normaliseSearchText(text);
  return /ipad|laptop|notebook|chromebook/.test(normalised) && !legacyResourceItemIsAccessory(text);
}

function extractQuantityFromLegacyResourceItem(item, fallback = 0) {
  const text = normaliseImportValue(item);
  if (!text) return fallback;

  const parentheticalNumbers = Array.from(text.matchAll(/\((?:[^)]*?)(\d+)\s*(?:pcs?|pieces?|devices?|units?|ipads?|notebooks?|laptops?|headsets?|headphones?|mice|mouse|pencils?)?[^)]*\)/gi))
    .map(match => Number(match[1]))
    .filter(value => Number.isInteger(value) && value > 0);

  if (parentheticalNumbers.length > 0) {
    return Math.max(...parentheticalNumbers);
  }

  const trailingQuantityMatch = text.match(/(?:-|–|—)\s*(\d{1,3})\s*$/);
  if (trailingQuantityMatch) return Number(trailingQuantityMatch[1]);

  const plainQuantityMatch = text.match(/\b(\d{1,3})\s*(?:pcs?|pieces?|devices?|units?|ipads?|notebooks?|laptops?|headsets?|headphones?|mice|mouse|pencils?)\b/i);
  if (plainQuantityMatch) return Number(plainQuantityMatch[1]);

  return fallback;
}

function splitLegacyResourceItems(resourceText) {
  return normaliseImportValue(resourceText)
    .split(/\s*,\s*/)
    .map(item => item.trim())
    .filter(Boolean);
}

function inferLegacyAccessoriesFromResourceText(resourceText) {
  const items = splitLegacyResourceItems(resourceText);
  const quantitiesByType = new Map();

  items.forEach(item => {
    const text = normaliseSearchText(item);
    let type = "";

    if (/apple\s*pencil|stylus/.test(text)) {
      type = "Apple Pencil";
    } else if (/head\s*set|headset|headphones?|earpieces?/.test(text)) {
      type = /usb\s*-?\s*c|type\s*c|usb-c/.test(text) ? "Headset (USB-C)" : (/3\.5|3\.5mm|audio\s*jack|aux|stereo\s*jack/.test(text) ? "Headset (3.5mm audio jack)" : "Headset");
    } else if (/\bmouse\b|mice/.test(text)) {
      type = "Mouse";
    }

    if (!type) return;

    const key = type.toLowerCase();
    const quantity = extractQuantityFromLegacyResourceItem(item, 0);

    // Multiple legacy resource entries can belong to the same accessory type,
    // for example "Headphones Set C (20), Headphones Set D (20)". These
    // are distinct physical accessory resources and should be summed before
    // later de-duplication against Purpose/Booking Remarks mentions.
    if (!quantitiesByType.has(key)) {
      quantitiesByType.set(key, { type, quantity: 0 });
    }

    quantitiesByType.get(key).quantity += quantity;
  });

  return Array.from(quantitiesByType.values());
}

function getResourceAliasEntries() {
  const colourByLetter = {
    a: "blue",
    b: "green",
    c: "yellow",
    d: "red"
  };

  return readResourcesFromXML()
    .map(formatResourceForResponse)
    .filter(resource => resource.status === "Available")
    .flatMap(resource => {
      const aliases = new Set();
      const name = String(resource.name || "").trim();
      const id = String(resource.id || "").trim();
      const deviceType = String(resource.deviceType || "").trim();
      const resourceType = String(resource.resourceType || "").trim();

      aliases.add(name);
      aliases.add(id.replace(/[-_]+/g, " "));

      const bagLetterMatch = name.match(/\b(?:bag|set)\s*([a-z])\b/i) || id.match(/\bbag[-_ ]*([a-z])\b/i);
      if (bagLetterMatch) {
        const letter = bagLetterMatch[1].toLowerCase();
        const colour = colourByLetter[letter] || "";
        aliases.add(`${deviceType} bag ${letter}`);
        aliases.add(`${deviceType} set ${letter}`);
        aliases.add(`${deviceType} ${letter}`);
        aliases.add(`bag ${letter}`);
        aliases.add(`set ${letter}`);
        if (colour) {
          aliases.add(`${deviceType} set ${letter} ${colour}`);
          aliases.add(`${deviceType} bag ${letter} ${colour}`);
          aliases.add(`${deviceType} ${colour}`);
          aliases.add(`set ${letter} ${colour}`);
          aliases.add(`bag ${letter} ${colour}`);
        }
      }

      const cartNumberMatch = name.match(/\bcart\s*(\d+)\b/i) || id.match(/\bcart[-_ ]*(\d+)\b/i);
      if (cartNumberMatch) {
        const number = cartNumberMatch[1];
        aliases.add(`${deviceType} cart ${number}`);
        aliases.add(`${deviceType} set ${number}`);
        aliases.add(`cart ${number}`);
      }

      return Array.from(aliases)
        .map(alias => normaliseResourceLookupText(alias))
        .filter(alias => alias && alias.length >= 5)
        .map(alias => ({ alias, resource }));
    })
    .sort((a, b) => b.alias.length - a.alias.length);
}

function findRegisteredResourceMatch(resourceText) {
  const text = normaliseResourceLookupText(resourceText);
  if (!text) return null;

  const entries = getResourceAliasEntries();
  let bestMatch = null;
  let bestScore = 0;

  entries.forEach(entry => {
    if (!entry.alias) return;

    let score = 0;
    if (text === entry.alias) {
      score = 1;
    } else if (text.includes(entry.alias)) {
      score = Math.min(0.95, entry.alias.length / Math.max(text.length, 1));
    } else if (entry.alias.includes(text) && text.length >= 7) {
      score = Math.min(0.9, text.length / Math.max(entry.alias.length, 1));
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = entry.resource;
    }
  });

  if (bestMatch && bestScore >= 0.45) {
    return {
      resource: bestMatch,
      score: bestScore,
      resolution: bestScore >= 0.95 ? "Matched registered resource" : "Matched registered resource by alias"
    };
  }

  return null;
}

function extractLegacyDeviceQuantityFromResource(resourceText, fallback = 1) {
  const text = normaliseImportValue(resourceText);
  if (!text) return fallback;

  const registeredMatch = findRegisteredResourceMatch(text);
  if (registeredMatch?.resource?.capacity && registeredMatch.resource.category !== "Accessory") {
    return Number(registeredMatch.resource.capacity) || fallback;
  }

  const items = splitLegacyResourceItems(text);
  const resourceCapacityLookup = getResourceCapacityLookup();
  let total = 0;

  items.forEach(item => {
    // Device quantity must come only from device resources. Accessory items in
    // the same legacy Resources cell, such as headphone sets, must not inflate
    // the laptop/iPad quantity.
    if (legacyResourceItemIsAccessory(item)) {
      return;
    }

    const parentheticalNumbers = Array.from(item.matchAll(/\((?:[^)]*?)(\d+)\s*(?:pcs?|pieces?|devices?|units?|ipads?|notebooks?|laptops?)?[^)]*\)/gi))
      .map(match => Number(match[1]))
      .filter(value => Number.isInteger(value) && value > 0);

    if (parentheticalNumbers.length > 0) {
      total += Math.max(...parentheticalNumbers);
      return;
    }

    const plainCapacityMatch = item.match(/\b(\d+)\s*(?:pcs?|pieces?|devices?|units?|ipads?|notebooks?|laptops?)\b/i);
    if (plainCapacityMatch) {
      total += Number(plainCapacityMatch[1]);
      return;
    }

    const itemKey = normaliseResourceLookupText(item.replace(/\([^)]*\)/g, ""));
    const exactCapacity = resourceCapacityLookup.get(itemKey);
    if (exactCapacity) {
      total += exactCapacity;
      return;
    }

    for (const [resourceName, capacity] of resourceCapacityLookup.entries()) {
      if (capacity > 0 && (itemKey.includes(resourceName) || resourceName.includes(itemKey))) {
        total += capacity;
        return;
      }
    }
  });

  return total > 0 ? total : fallback;
}

function parseLegacyPerson(value) {
  const text = normaliseImportValue(value);
  const match = text.match(/^(.*?)\s*\(([^()@\s]+@[^()\s]+)\)\s*$/);
  if (match) {
    return {
      name: match[1].trim(),
      email: normaliseEmail(match[2])
    };
  }
  return {
    name: text,
    email: ""
  };
}

function parseLegacyTimeslots(value) {
  const text = normaliseImportValue(value);
  const matches = Array.from(text.matchAll(/\((\d{1,2}:\d{2})-(\d{1,2}:\d{2})\)/g));
  if (matches.length === 0) {
    return {
      startTime: normaliseImportTime(text),
      endTime: ""
    };
  }

  return {
    startTime: normaliseImportTime(matches[0][1]),
    endTime: normaliseImportTime(matches[matches.length - 1][2])
  };
}


function parseLegacyTimeslotSegments(value) {
  const segments = bookingSegmentationEngine.buildTimeSegments(value);
  return segments.length > 1 ? segments : [];
}

function normaliseSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function inferLegacyResource(resourceText) {
  const text = normaliseSearchText(resourceText);
  const result = {
    isICT: false,
    isNonICT: false,
    isUnknownICT: false,
    deviceType: "",
    devicesRequired: 0,
    matchedResourceId: "",
    matchedResourceName: "",
    matchedResourceCategory: "",
    matchedResourceFulfilmentMode: "Deployment",
    matchedResourceDeploymentRequired: true,
    resourceResolution: "",
    accessoryResources: [],
    softwareRequirement: "None",
    reason: ""
  };

  if (!text) {
    result.isNonICT = true;
    result.reason = "Legacy row does not contain an ICT resource booking.";
    result.resourceResolution = "Skipped non-ICT resource";
    return result;
  }

  const nonIctPatterns = [
    /library\s*visits?/,
    /\blibrary\b/,
    /\bmrl\b/,
    /meeting\s*room/,
    /conference\s*room/,
    /seminar\s*room/,
    /staff\s*room/,
    /training\s*room/,
    /computer\s*lab/,
    /science\s*lab/,
    /\blab\s*[0-9a-z]?\b/,
    /\bhall\b/,
    /auditorium/,
    /classroom\s*visit/
  ];

  if (nonIctPatterns.some(pattern => pattern.test(text))) {
    result.isNonICT = true;
    result.reason = "Legacy resource is not managed by the ICT Resource Booking Portal.";
    result.resourceResolution = "Skipped non-ICT resource";
    return result;
  }

  const registeredMatch = findRegisteredResourceMatch(resourceText);
  if (registeredMatch?.resource) {
    const resource = registeredMatch.resource;
    result.isICT = true;
    result.deviceType = resource.category === "Accessory" ? "" : resource.deviceType;
    result.devicesRequired = Number(resource.capacity) || 1;
    result.matchedResourceId = resource.id || "";
    result.matchedResourceName = resource.name || "";
    result.matchedResourceCategory = resource.category || "";
    result.matchedResourceFulfilmentMode = normaliseFulfilmentMode(resource.fulfilmentMode || resource.fulfillmentMode, resource);
    result.matchedResourceDeploymentRequired = resourceRequiresDeployment(resource);
    result.resourceResolution = registeredMatch.resolution;

    if (resource.category === "Accessory") {
      result.accessoryResources.push({ type: resource.deviceType, quantity: Number(resource.capacity) || 1 });
    }
  } else if (/ipad/.test(text)) {
    result.isICT = true;
    result.deviceType = /keyboard/.test(text) ? "iPad with Keyboard" : "iPad";
    result.resourceResolution = "Generic device type detected; no registered resource name matched";
  } else if (/laptop|notebook|chromebook/.test(text)) {
    result.isICT = true;
    result.deviceType = "Laptop";
    result.resourceResolution = "Generic device type detected; no registered resource name matched";
  }

  const legacyResourceAccessories = inferLegacyAccessoriesFromResourceText(resourceText);
  legacyResourceAccessories.forEach(item => {
    result.accessoryResources.push(item);
    result.isICT = true;
  });

  if (/procreate/.test(text)) {
    result.softwareRequirement = "Procreate";
  }

  const unknownIctPatterns = [
    /\bswivl\b/,
    /visuali[sz]er/,
    /camera/,
    /tripod/,
    /microphone/,
    /projector/,
    /speaker/,
    /robot/,
    /bee\s*bot/,
    /sphero/
  ];

  if (!result.isICT && unknownIctPatterns.some(pattern => pattern.test(text))) {
    result.isUnknownICT = true;
    result.reason = "Legacy resource appears to be an ICT item but is not registered in Resources Admin.";
    result.resourceResolution = "Unknown ICT resource";
    return result;
  }

  if (!result.isICT) {
    result.isNonICT = true;
    result.reason = "Legacy resource did not match any registered portal resource or supported generic ICT device type and is treated as a non-ICT / venue-only booking.";
    result.resourceResolution = "Skipped non-ICT resource";
  }

  return result;
}

function extractLegacyQuantity(value, fallback = 1) {
  const numeric = Number(value);
  if (Number.isInteger(numeric) && numeric > 0) return numeric;

  const text = normaliseImportValue(value);
  const bracketMatch = text.match(/\((\d+)\)/);
  if (bracketMatch) return Number(bracketMatch[1]);

  const numberMatch = text.match(/\b(\d+)\b/);
  if (numberMatch) return Number(numberMatch[1]);

  return fallback;
}

function getKnownLocationNames() {
  return readLocationsFromXML()
    .filter(location => location.status === "Active")
    .map(location => location.name)
    .filter(name => name && name !== "Other")
    .sort((a, b) => b.length - a.length);
}

function normaliseLocationCandidate(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

function findKnownLocationByCandidate(candidate, knownLocations) {
  const cleanedCandidate = normaliseLocationCandidate(candidate);
  if (!cleanedCandidate) return "";

  return knownLocations.find(location =>
    normaliseLocationCandidate(location) === cleanedCandidate
  ) || "";
}

function looksLikeDescriptiveDeploymentLocation(text) {
  const raw = normaliseImportValue(text);
  if (!raw) return false;

  const lower = raw.toLowerCase();
  const locationIntentPatterns = [
    /\b(?:student\s+care\s+room|room|classroom|venue|block|level|lvl|floor)\b/,
    /\b(?:next\s+to|beside|near|outside|opposite|behind|in\s+front\s+of|at)\b/,
    /\b(?:ish|annex|library|canteen|hall|studio|dance\s+studio|staff\s+room)\b/
  ];

  return locationIntentPatterns.some(pattern => pattern.test(lower));
}

function extractLegacyLocation(row) {
  if (row?.__legacyLocationOverride) {
    const overrideLocation = normaliseImportValue(row.__legacyLocationOverride);
    const knownLocations = getKnownLocationNames();
    return {
      location: overrideLocation,
      resolution: knownLocations.includes(overrideLocation) ? "Matched existing location" : "Custom resource-specific location",
      sourceText: overrideLocation
    };
  }

  const sources = [
    getImportValue(row, ["Deployment Location", "Location", "Venue", "location"]),
    getImportValue(row, ["Booking Remarks", "Booking Remark", "Remarks", "Remark", "bookingRemarks"]),
    getImportValue(row, ["Purpose"]),
    getImportValue(row, ["Booked For"])
  ].map(normaliseImportValue).filter(Boolean);

  const searchableText = sources.join("\n");
  const knownLocations = getKnownLocationNames();

  for (const locationName of knownLocations) {
    const escaped = locationName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?:^|[^A-Za-z0-9])(?:class\\s*)?${escaped}(?:\\s*class(?:room)?)?(?=$|[^A-Za-z0-9])`, "i");
    if (pattern.test(searchableText)) {
      return {
        location: locationName,
        resolution: "Matched existing location",
        sourceText: searchableText
      };
    }
  }

  // Primary-school class shorthand is commonly entered as P6D, P 6D,
  // P6D classroom, or P6D EL. Strip the optional P prefix before matching
  // against the maintained deployment-location list.
  const prefixedClassMatch = searchableText.match(/\bP\s*([1-6])\s*([A-G])(?=\b|\s*(?:class|classroom|room|el|math|science|mt|mother\s*tongue))/i);
  if (prefixedClassMatch) {
    const classCandidate = `${prefixedClassMatch[1]}${prefixedClassMatch[2]}`.toUpperCase();
    const knownClassLocation = findKnownLocationByCandidate(classCandidate, knownLocations);
    return {
      location: knownClassLocation || classCandidate,
      resolution: knownClassLocation ? "Matched existing location" : "Custom class-like location",
      sourceText: searchableText
    };
  }

  const classMatch = searchableText.match(/\b(?:class(?:room)?\s*)?([1-6][A-G])(?:\s*class(?:room)?)?\b/i);
  if (classMatch) {
    const classCandidate = classMatch[1].toUpperCase();
    const knownClassLocation = findKnownLocationByCandidate(classCandidate, knownLocations);
    return {
      location: knownClassLocation || classCandidate,
      resolution: knownClassLocation ? "Matched existing location" : "Custom class-like location",
      sourceText: searchableText
    };
  }

  // Free-text legacy remarks often contain room locations without the word "Room",
  // for example "venue at 4.38", "3.03 LSM", or "Classroom 3.03".
  const labelledRoomMatch = searchableText.match(/\b(?:classroom|room|rm|venue\s+at|venue)\s*([A-Z]?\d(?:\.\d{1,3})?[A-Z]?|[A-Z]?\d{2,4}[A-Z]?)\b/i);
  if (labelledRoomMatch) {
    const rawRoom = labelledRoomMatch[1].trim();
    return {
      location: `Room ${rawRoom}`,
      resolution: "Custom room location",
      sourceText: searchableText
    };
  }

  const decimalRoomMatch = searchableText.match(/\b\d\.\d{1,3}\b/);
  if (decimalRoomMatch) {
    return {
      location: `Room ${decimalRoomMatch[0].trim()}`,
      resolution: "Custom room location",
      sourceText: searchableText
    };
  }


  const descriptiveSource = sources.find(source => looksLikeDescriptiveDeploymentLocation(source));
  if (descriptiveSource) {
    return {
      location: descriptiveSource,
      resolution: "Custom descriptive location",
      sourceText: searchableText
    };
  }

  return {
    location: "",
    resolution: "No location detected",
    sourceText: searchableText
  };
}

function getAccessoryDetectionRules() {
  return getAvailableAccessoryTypes().map(type => {
    const normalisedType = String(type || "").trim();
    const escapedType = normalisedType.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*");
    const aliases = [escapedType];

    if (/apple\s*pencil/i.test(normalisedType)) {
      aliases.push("apple\\s*pencils?", "pencils?", "stylus(?:es)?");
    } else if (/headset/i.test(normalisedType)) {
      aliases.push("head\\s*sets?", "headsets?", "headphones?", "earpieces?");
      if (/usb\s*-?\s*c/i.test(normalisedType)) {
        aliases.push("usb\\s*-?\\s*c", "type\\s*c", "usb-c\\s*jack");
      }
      if (/3\.5|audio\s*jack/i.test(normalisedType)) {
        aliases.push("3\\.5\\s*mm", "3\\.5mm", "audio\\s*jack", "aux", "stereo\\s*jack");
      }
    } else if (/mouse/i.test(normalisedType)) {
      aliases.push("mouses?", "mice");
    }

    return {
      type: normalisedType,
      pattern: new RegExp(`(?:${aliases.join("|")})`, "i")
    };
  });
}

function detectQuantityNearAccessory(text, matchIndex, matchLength) {
  const leftContext = text.slice(Math.max(0, matchIndex - 36), matchIndex);
  const rightContext = text.slice(matchIndex + matchLength, Math.min(text.length, matchIndex + matchLength + 36));

  const quantityPatterns = [
    /(?:qty|quantity|x|×|need|needs|needed|require|requires|required|request|requests|requested|for|with)\s*[:=-]?\s*(\d{1,3})\s*$/i,
    /(\d{1,3})\s*(?:x|×|pcs?|pieces?|units?|sets?|pairs?|nos?\.?|number)?\s*$/i,
    /^\s*(?:qty|quantity|x|×|need|needs|needed|require|requires|required|request|requests|requested|for|with)?\s*[:=-]?\s*(\d{1,3})\b/i,
    /^\s*(?:-|–|—|:)\s*(\d{1,3})\b/i
  ];

  for (const pattern of quantityPatterns.slice(0, 2)) {
    const match = leftContext.match(pattern);
    if (match) return Number(match[1]);
  }

  for (const pattern of quantityPatterns.slice(2)) {
    const match = rightContext.match(pattern);
    if (match) return Number(match[1]);
  }

  return 0;
}

function inferLegacyAccessoriesFromText(text, sourceLabel) {
  const rawText = normaliseImportValue(text);
  if (!rawText) return { accessories: [], resolutions: [] };

  const accessories = [];
  const resolutions = [];
  const rules = getAccessoryDetectionRules();

  rules.forEach(rule => {
    const match = rawText.match(rule.pattern);
    if (!match) return;

    const ruleTypeLower = String(rule.type || "").toLowerCase();
    const rawLower = rawText.toLowerCase();
    if (ruleTypeLower.includes("headset") && ruleTypeLower.includes("usb") && !/usb\s*-?\s*c|type\s*c|usb-c/.test(rawLower)) return;
    if (ruleTypeLower.includes("headset") && (ruleTypeLower.includes("3.5") || ruleTypeLower.includes("audio")) && !/3\.5|3\.5mm|audio\s*jack|aux|stereo\s*jack/.test(rawLower)) return;

    const quantity = detectQuantityNearAccessory(rawText, match.index || 0, match[0].length);
    accessories.push({ type: rule.type, quantity });
    resolutions.push(`${rule.type} detected from ${sourceLabel}${quantity > 0 ? ` (${quantity})` : ""}`);
  });

  return { accessories, resolutions };
}

function mergeAccessoryQuantities(accessories, defaultQuantity) {
  const byType = new Map();

  accessories.forEach(item => {
    const type = String(item.type || "").trim();
    if (!type) return;
    const quantity = Number(item.quantity) > 0 ? Number(item.quantity) : defaultQuantity;
    const key = type.toLowerCase();

    // Legacy exports often mention the same accessory in both the Resources
    // column and the Purpose/Booking Remarks columns. Use the highest detected
    // quantity instead of summing duplicate mentions, to avoid over-booking.
    if (!byType.has(key)) {
      byType.set(key, { type, quantity });
    } else {
      byType.get(key).quantity = Math.max(byType.get(key).quantity, quantity);
    }
  });

  return Array.from(byType.values());
}


function splitLegacyResourceDeploymentLines(text) {
  return normaliseImportValue(text)
    .split(/\r?\n+/)
    .map(line => line.trim())
    .filter(Boolean);
}

function cleanLegacyResourceSegmentText(value) {
  return normaliseImportValue(value)
    .replace(/\s+/g, " ")
    .replace(/\s*[-–—]\s*$/g, "")
    .trim();
}

function parseLegacyResourceDeploymentSegments(row) {
  const legacyResourceText = normaliseImportValue(getImportValue(row, [
    "Resources", "Resource", "Device Type", "Resource Type", "Main Resource", "deviceType"
  ]));

  const remarksText = normaliseImportValue(getImportValue(row, [
    "Booking Remarks", "Booking Remark", "Remarks", "Remark", "bookingRemarks"
  ]));

  if (!legacyResourceText || !remarksText) return [];

  const resourceItems = splitLegacyResourceItems(legacyResourceText);
  if (resourceItems.length <= 1) return [];

  const resourceItemsWithMatches = resourceItems
    .map(item => ({
      item,
      match: findRegisteredResourceMatch(item)
    }))
    .filter(entry => entry.match?.resource && entry.match.resource.category !== "Accessory");

  if (resourceItemsWithMatches.length <= 1) return [];

  const lines = splitLegacyResourceDeploymentLines(remarksText);
  if (lines.length <= 1) return [];

  const segments = [];
  const usedResourceKeys = new Set();

  lines.forEach(line => {
    const parts = line.split(/\s+[-–—]\s+/);
    if (parts.length < 2) return;

    const locationText = cleanLegacyResourceSegmentText(parts[0]);
    const resourceHint = cleanLegacyResourceSegmentText(parts.slice(1).join(" - "));
    if (!locationText || !resourceHint) return;

    let matchedEntry = null;
    let matchedBy = "";

    for (const entry of resourceItemsWithMatches) {
      const itemKey = normaliseResourceLookupText(entry.item);
      const resourceNameKey = normaliseResourceLookupText(entry.match.resource.name);
      const resourceHintKey = normaliseResourceLookupText(resourceHint);
      const resourceIdKey = normaliseResourceLookupText(entry.match.resource.id);

      if (
        resourceHintKey.includes(resourceNameKey) ||
        resourceNameKey.includes(resourceHintKey) ||
        resourceHintKey.includes(resourceIdKey) ||
        itemKey.includes(resourceHintKey) ||
        resourceHintKey.includes(itemKey)
      ) {
        matchedEntry = entry;
        matchedBy = "remarks resource hint";
        break;
      }
    }

    if (!matchedEntry) {
      const directMatch = findRegisteredResourceMatch(resourceHint);
      if (directMatch?.resource && directMatch.resource.category !== "Accessory") {
        matchedEntry = {
          item: resourceHint,
          match: directMatch
        };
        matchedBy = "direct remarks resource match";
      }
    }

    if (!matchedEntry?.match?.resource) return;

    const resourceKey = String(matchedEntry.match.resource.id || matchedEntry.match.resource.name || resourceHint).toLowerCase();
    if (usedResourceKeys.has(resourceKey)) return;
    usedResourceKeys.add(resourceKey);

    segments.push({
      segmentIndex: segments.length + 1,
      resourceText: matchedEntry.item,
      locationText,
      resourceId: matchedEntry.match.resource.id || "",
      resourceName: matchedEntry.match.resource.name || "",
      resolution: `Split from bulk resource booking using ${matchedBy}`
    });
  });

  if (segments.length <= 1) return [];

  return segments.map((segment, index) => ({
    ...segment,
    segmentIndex: index + 1,
    segmentTotal: segments.length
  }));
}

function buildLegacySegmentRow(sourceRow, resourceSegment, timeSegment) {
  const segmentRow = { ...sourceRow };

  if (resourceSegment) {
    segmentRow.Resources = resourceSegment.resourceText;
    segmentRow.Resource = resourceSegment.resourceText;
    segmentRow.__legacyResourceSegment = resourceSegment;
    segmentRow.__legacyLocationOverride = resourceSegment.locationText;
  }

  if (timeSegment) {
    segmentRow.__legacyTimeSegment = timeSegment;
  }

  return segmentRow;
}

function buildImportSegmentLabel(index, row) {
  const labels = [];
  if (row.__legacyResourceSegment) labels.push(`R${row.__legacyResourceSegment.segmentIndex}`);
  if (row.__legacyTimeSegment) labels.push(`T${row.__legacyTimeSegment.segmentIndex}`);
  return labels.length ? `${index + 1}.${labels.join(".")}` : String(index + 1);
}


function mapLegacyBookingRow(row, index, users) {
  const errors = [];
  const warnings = [];
  const accessoryTypes = getAvailableAccessoryTypes();

  const legacyResourceText = normaliseImportValue(getImportValue(row, [
    "Resources", "Resource", "Device Type", "Resource Type", "Main Resource", "deviceType"
  ]));
  const legacyResourceInference = inferLegacyResource(legacyResourceText);

  const bookedFor = parseLegacyPerson(getImportValue(row, [
    "Booked For", "Requester", "Requester Email", "Email", "User Email", "Teacher Email", "requesterEmail", "email"
  ]));
  const bookedBy = parseLegacyPerson(getImportValue(row, [
    "Booked By", "Requester Name", "Name", "Teacher", "User", "requesterName", "name"
  ]));

  const requesterEmail = bookedFor.email || bookedBy.email;
  const requesterName = bookedFor.name || bookedBy.name;
  const requesterMatch = findLegacyRequesterUser(users, requesterEmail, requesterName);
  const matchedUser = requesterMatch.user;

  const bookingDate = normaliseImportDate(getImportValue(row, [
    "Booking Date", "Date", "bookingDate", "BookingDate"
  ]));

  const timeslotParse = parseLegacyTimeslots(getImportValue(row, [
    "Timeslots", "Timeslot", "Time Slots", "Time", "Start Time", "Start", "startTime", "StartTime"
  ]));
  const injectedSegment = row.__legacyTimeSegment || null;
  const startTime = normaliseImportTime(getImportValue(row, [
    "Start Time", "Start", "startTime", "StartTime"
  ])) || injectedSegment?.startTime || timeslotParse.startTime;
  const endTime = normaliseImportTime(getImportValue(row, [
    "End Time", "End", "endTime", "EndTime"
  ])) || injectedSegment?.endTime || timeslotParse.endTime;

  const locationResolution = extractLegacyLocation(row);
  let location = locationResolution.location;

  const isCollectionOnlyResource = legacyResourceInference.isICT && legacyResourceInference.matchedResourceDeploymentRequired === false;
  const fulfilmentMode = isCollectionOnlyResource ? "Collection" : "Deployment";
  const deploymentRequired = fulfilmentMode !== "Collection";
  if (!location && isCollectionOnlyResource) {
    location = "ICT Work Room Collection";
    locationResolution.location = location;
    locationResolution.resolution = "Collection-only resource; no deployment location required";
  }

  const deviceType = normaliseImportValue(getImportValue(row, [
    "Device Type", "deviceType"
  ])) || legacyResourceInference.deviceType;

  const devicesRequired = legacyResourceInference.devicesRequired || extractLegacyDeviceQuantityFromResource(
    legacyResourceText,
    extractLegacyQuantity(getImportValue(row, [
      "Number of Devices", "Devices Required", "Quantity", "Qty", "devicesRequired"
    ]), 1)
  );

  const softwareRequirement = normaliseImportValue(getImportValue(row, [
    "Software Requirement", "Software", "softwareRequirement"
  ])) || legacyResourceInference.softwareRequirement || "None";
  const softwareRequirements = {
    software: normaliseBookingSoftwareRequirements({ softwareRequirement })
  };

  const legacyPurpose = normaliseImportValue(getImportValue(row, ["Purpose"]));
  const legacyBookingRemarks = normaliseImportValue(getImportValue(row, ["Booking Remarks", "Booking Remark", "Remarks", "Remark", "bookingRemarks"]));

  const additionalResources = [];
  const accessoryResolutionNotes = [];

  accessoryTypes.forEach(type => {
    const quantity = Number(getImportValue(row, [
      `${type} Quantity`, `${type} Qty`, `${type}`, `${type.toLowerCase()}Quantity`, `${type.toLowerCase()}Qty`
    ]));
    if (Number.isInteger(quantity) && quantity > 0) {
      additionalResources.push({ type, quantity });
    }
  });

  legacyResourceInference.accessoryResources.forEach(item => additionalResources.push(item));

  const purposeAccessories = inferLegacyAccessoriesFromText(legacyPurpose, "Purpose");
  purposeAccessories.accessories.forEach(item => additionalResources.push(item));
  purposeAccessories.resolutions.forEach(note => accessoryResolutionNotes.push(note));

  const remarksAccessories = inferLegacyAccessoriesFromText(legacyBookingRemarks, "Booking Remarks");
  remarksAccessories.accessories.forEach(item => additionalResources.push(item));
  remarksAccessories.resolutions.forEach(note => accessoryResolutionNotes.push(note));

  const legacyResourceType = normaliseImportValue(getImportValue(row, [
    "Accessory Type", "Additional Resource Type", "Additional Resource", "Peripheral", "Accessory"
  ]));
  const legacyResourceQuantity = Number(getImportValue(row, [
    "Accessory Quantity", "Additional Resource Quantity", "Additional Resource Qty", "Peripheral Quantity"
  ]));

  if (legacyResourceType && Number.isInteger(legacyResourceQuantity) && legacyResourceQuantity > 0) {
    additionalResources.push({ type: legacyResourceType, quantity: legacyResourceQuantity });
  }

  if (legacyResourceInference.isNonICT) {
    errors.push(legacyResourceInference.reason);
  }

  if (legacyResourceInference.isUnknownICT) {
    errors.push(legacyResourceInference.reason);
  }

  if (!bookingDate) errors.push("Booking date is required.");
  if (!startTime) errors.push("Start time is required.");
  if (!endTime) errors.push("End time is required.");
  if (!location && deploymentRequired) errors.push("Deployment location could not be detected from the legacy record.");
  if (!deviceType) errors.push(legacyResourceInference.reason || "Device type is required.");
  if (!Number.isInteger(devicesRequired) || devicesRequired <= 0) errors.push("Number of devices must be a positive whole number.");

  if (!matchedUser && requesterEmail) {
    warnings.push("Requester was not found in Users Admin after email domain-normalisation and intelligent name matching; importer account will own the booking while preserving legacy requester details.");
  }

  if (locationResolution.resolution && locationResolution.resolution !== "Matched existing location") {
    warnings.push(locationResolution.resolution);
  }

  if (isCollectionOnlyResource) {
    warnings.push("Collection-only resource; excluded from DE Deployment Dashboard.");
  }

  if (row.__legacyResourceSegment?.resolution) {
    warnings.push(row.__legacyResourceSegment.resolution);
  }

  const mappedBooking = {
    userId: matchedUser?.userId || "",
    importedRequesterName: requesterName || matchedUser?.name || "",
    importedRequesterEmail: requesterEmail || matchedUser?.email || "",
    bookingDate,
    startTime,
    endTime,
    location,
    fulfilmentMode,
    deploymentRequired,
    collectionInstructions: isCollectionOnlyResource ? "Collect from ICT Work Room and return after the booking session." : "",
    deviceType,
    devicesRequired,
    softwareRequirement,
    bookingMode: "one-time",
    additionalResources: {
      resource: normaliseAdditionalResourceRequests(mergeAccessoryQuantities(additionalResources, devicesRequired))
    },
    importSource: "Legacy Platform",
    importRowNumber: index + 1,
    importSegmentLabel: buildImportSegmentLabel(index, row),
    legacyPeriodLabel: injectedSegment?.periodLabel || "",
    legacyResourceSegmentLabel: row.__legacyResourceSegment ? `Resource ${row.__legacyResourceSegment.segmentIndex} of ${row.__legacyResourceSegment.segmentTotal}` : "",
    legacyResourceText,
    matchedResourceId: legacyResourceInference.matchedResourceId || "",
    matchedResourceName: legacyResourceInference.matchedResourceName || "",
    matchedResourceCategory: legacyResourceInference.matchedResourceCategory || "",
    matchedResourceFulfilmentMode: legacyResourceInference.matchedResourceFulfilmentMode || fulfilmentMode,
    legacyResourceResolution: legacyResourceInference.resourceResolution || "",
    legacyAccessoryResolution: accessoryResolutionNotes.join("; "),
    legacyPurpose,
    legacyBookingRemarks,
    legacyLocationResolution: locationResolution.resolution,
    importWarnings: {
      warning: warnings
    }
  };

  const additionalErrors = validateAdditionalResourceRequests(mappedBooking);
  additionalErrors.forEach(error => errors.push(error));

  if (errors.length === 0 && findDuplicateBooking(prepareBookingForSave(mappedBooking))) {
    errors.push("Duplicate booking already exists and will not be imported again.");
  }

  return {
    rowNumber: buildImportSegmentLabel(index, row),
    valid: errors.length === 0,
    skipped: legacyResourceInference.isNonICT,
    classification: legacyResourceInference.isNonICT ? "Skipped non-ICT" : (legacyResourceInference.isUnknownICT ? "Unknown ICT resource" : (legacyResourceInference.isICT ? "ICT booking" : "Needs review")),
    errors,
    warnings,
    mappedBooking
  };
}

function normaliseConsolidationKeyValue(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function getImportRequesterKey(mappedBooking = {}) {
  return normaliseConsolidationKeyValue(
    mappedBooking.userId ||
    mappedBooking.importedRequesterEmail ||
    mappedBooking.importedRequesterName
  );
}

function getImportLocationKey(mappedBooking = {}) {
  return normaliseConsolidationKeyValue(mappedBooking.location);
}

function getImportBookingMergeKey(row) {
  const booking = row?.mappedBooking || {};
  return [
    getImportRequesterKey(booking),
    normaliseConsolidationKeyValue(booking.bookingDate),
    getImportLocationKey(booking)
  ].join("|");
}

function getAdditionalResourceList(booking = {}) {
  return normaliseAdditionalResourceRequests(booking.additionalResources);
}

function hasDeviceRequest(row) {
  const booking = row?.mappedBooking || {};
  return Boolean(booking.deviceType && Number(booking.devicesRequired || 0) > 0);
}

function hasAccessoryRequest(row) {
  return getAdditionalResourceList(row?.mappedBooking || {}).length > 0;
}

function isAccessoryOnlyImportRow(row) {
  return !hasDeviceRequest(row) && hasAccessoryRequest(row);
}

function mergeAdditionalResourcesForImport(deviceBooking, accessoryBooking) {
  const merged = [
    ...getAdditionalResourceList(deviceBooking),
    ...getAdditionalResourceList(accessoryBooking)
  ];
  return {
    resource: normaliseAdditionalResourceRequests(mergeAccessoryQuantities(merged, Number(deviceBooking.devicesRequired || 0) || 1))
  };
}

function removeDeviceTypeErrors(errors = []) {
  return toArray(errors).filter(error =>
    !/device type is required|number of devices must be a positive whole number/i.test(String(error || ""))
  );
}

function timeRangesOverlapForImport(a = {}, b = {}) {
  const aStart = String(a.startTime || "");
  const aEnd = String(a.endTime || "");
  const bStart = String(b.startTime || "");
  const bEnd = String(b.endTime || "");
  if (!aStart || !aEnd || !bStart || !bEnd) return false;
  return aStart < bEnd && aEnd > bStart;
}

function consolidateAccessoryOnlyImportRows(mappedRows) {
  const rows = toArray(mappedRows);
  const deviceRows = rows.filter(row => hasDeviceRequest(row));
  const mergedAccessoryRowIds = new Set();

  rows.forEach((row, rowIndex) => {
    if (!isAccessoryOnlyImportRow(row)) return;

    const booking = row.mappedBooking || {};
    if (!booking.bookingDate || !booking.location) return;

    // Tier 1: same requester, date and location. This remains the strongest
    // and preferred match. Device-booking timing takes precedence.
    const sameRequesterCandidates = deviceRows.filter(candidate => {
      const candidateBooking = candidate.mappedBooking || {};
      return getImportRequesterKey(candidateBooking) &&
        getImportRequesterKey(candidateBooking) === getImportRequesterKey(booking) &&
        normaliseConsolidationKeyValue(candidateBooking.bookingDate) === normaliseConsolidationKeyValue(booking.bookingDate) &&
        getImportLocationKey(candidateBooking) === getImportLocationKey(booking);
    });

    let target = sameRequesterCandidates.find(candidate =>
      timeRangesOverlapForImport(candidate.mappedBooking, booking)
    ) || sameRequesterCandidates.find(candidate =>
      candidate.mappedBooking?.startTime === booking.startTime ||
      candidate.mappedBooking?.endTime === booking.endTime
    ) || sameRequesterCandidates[0];

    let matchTier = "same requester";

    // Tier 2: legacy helper booking. Different users sometimes booked the
    // device and accessories separately for the same lesson. Merge only when
    // exactly one device booking shares the date, location and overlapping
    // time, so ambiguous records remain available for Admin review.
    if (!target) {
      const crossRequesterCandidates = deviceRows.filter(candidate => {
        const candidateBooking = candidate.mappedBooking || {};
        return normaliseConsolidationKeyValue(candidateBooking.bookingDate) === normaliseConsolidationKeyValue(booking.bookingDate) &&
          getImportLocationKey(candidateBooking) === getImportLocationKey(booking) &&
          timeRangesOverlapForImport(candidateBooking, booking);
      });

      if (crossRequesterCandidates.length === 1) {
        target = crossRequesterCandidates[0];
        matchTier = "unique same-location lesson";
      }
    }

    if (!target) return;

    target.mappedBooking.additionalResources = mergeAdditionalResourcesForImport(target.mappedBooking, booking);

    const mergeNote = `Accessory-only legacy row ${row.rowNumber} merged into device row ${target.rowNumber} using ${matchTier} matching; device booking timing retained.`;
    const targetWarnings = toArray(target.warnings);
    if (!targetWarnings.includes(mergeNote)) targetWarnings.push(mergeNote);
    target.warnings = targetWarnings;
    target.mappedBooking.importWarnings = {
      warning: Array.from(new Set([
        ...toArray(target.mappedBooking.importWarnings?.warning),
        mergeNote
      ]))
    };

    const accessoryResolutionText = [
      target.mappedBooking.legacyAccessoryResolution,
      `Merged accessories from legacy row ${row.rowNumber}`
    ].filter(Boolean).join('; ');
    target.mappedBooking.legacyAccessoryResolution = accessoryResolutionText;

    mergedAccessoryRowIds.add(rowIndex);
  });

  return rows
    .filter((_, index) => !mergedAccessoryRowIds.has(index))
    .map(row => {
      if (row.valid) return row;
      const cleanedErrors = removeDeviceTypeErrors(row.errors);
      return {
        ...row,
        errors: cleanedErrors,
        valid: cleanedErrors.length === 0
      };
    });
}

function previewLegacyBookingRows(rows, dateRange = {}) {
  const users = getUsersFromXML();
  let allRows = toArray(rows).flatMap((row, index) => {
    const sourceRow = row || {};
    const resourceSegments = parseLegacyResourceDeploymentSegments(sourceRow);
    const timeSegments = parseLegacyTimeslotSegments(getImportValue(sourceRow, [
      "Timeslots", "Timeslot", "Time Slots", "Time", "Start Time", "Start", "startTime", "StartTime"
    ]));

    const segmentation = bookingSegmentationEngine.pairOperationalSegments(resourceSegments, timeSegments);

    if (segmentation.errors.length) {
      const reviewRow = mapLegacyBookingRow(sourceRow, index, users);
      reviewRow.valid = false;
      reviewRow.errors = Array.from(new Set([...(reviewRow.errors || []), ...segmentation.errors]));
      reviewRow.warnings = Array.from(new Set([...(reviewRow.warnings || []), ...segmentation.warnings]));
      reviewRow.mappedBooking.importWarnings = { warning: reviewRow.warnings };
      reviewRow.classification = "Needs review";
      return [reviewRow];
    }

    return segmentation.segments.map(({ resourceSegment, timeSegment }) => {
      const mapped = mapLegacyBookingRow(buildLegacySegmentRow(sourceRow, resourceSegment, timeSegment), index, users);
      if (segmentation.warnings.length) {
        mapped.warnings = Array.from(new Set([...(mapped.warnings || []), ...segmentation.warnings]));
        mapped.mappedBooking.importWarnings = { warning: mapped.warnings };
      }
      mapped.mappedBooking.operationalSegmentNumber = timeSegment?.segmentIndex || resourceSegment?.segmentIndex || 1;
      mapped.mappedBooking.operationalSegmentTotal = Math.max(timeSegment?.segmentTotal || 1, resourceSegment?.segmentTotal || 1);
      mapped.mappedBooking.operationalSegmentationReason = timeSegment?.segmentationReason || "resource/location boundary";
      return mapped;
    });
  });

  allRows = consolidateAccessoryOnlyImportRows(allRows);

  const inRangeRows = [];
  const outOfRangeRows = [];

  allRows.forEach(row => {
    const bookingDate = row.mappedBooking?.bookingDate || "";
    if (bookingIsWithinImportDateRange(bookingDate, dateRange)) {
      inRangeRows.push(row);
    } else {
      outOfRangeRows.push({
        ...row,
        skippedReason: bookingDate
          ? "Outside selected import date range."
          : "No valid booking date found for date-range filtering."
      });
    }
  });

  const validRows = inRangeRows.filter(row => row.valid);
  const skippedRows = inRangeRows.filter(row => row.skipped);
  const invalidRows = inRangeRows.filter(row => !row.valid && !row.skipped);

  const classificationSummary = inRangeRows.reduce((summary, row) => {
    const key = row.classification || "Needs review";
    summary[key] = (summary[key] || 0) + 1;
    return summary;
  }, {});

  const resourceSummary = validRows.reduce((summary, row) => {
    const key = row.mappedBooking?.deviceType || "Unknown";
    summary[key] = (summary[key] || 0) + 1;
    return summary;
  }, {});

  const accessorySummary = validRows.reduce((summary, row) => {
    const accessories = toArray(row.mappedBooking?.additionalResources?.resource);
    accessories.forEach(item => {
      const key = item.type || "Unknown";
      summary[key] = (summary[key] || 0) + Number(item.quantity || 0);
    });
    return summary;
  }, {});

  return {
    totalRows: allRows.length,
    rowsWithinRange: inRangeRows.length,
    rowsOutsideRange: outOfRangeRows.length,
    dateRange,
    validRows,
    invalidRows,
    skippedRows,
    outOfRangeRows,
    classificationSummary,
    resourceSummary,
    accessorySummary
  };
}

function saveImportedBooking(mappedBooking, importerUser) {
  const bookingRequest = prepareBookingForSave(removePersonalDataFromBooking({
    ...mappedBooking,
    userId: mappedBooking.userId || importerUser.userId,
    importedByUserId: importerUser.userId,
    importedByName: importerUser.name,
    importedAt: new Date().toISOString(),
    status: "Pending Allocation"
  }));

  const duplicateBooking = findDuplicateBooking(bookingRequest);
  if (duplicateBooking) {
    return {
      skipped: true,
      reason: "Duplicate booking already exists.",
      existingBooking: duplicateBooking,
      importRowNumber: bookingRequest.importRowNumber
    };
  }

  let allocationResult = allocateResources(bookingRequest);
  let reallocationUpdates = [];

  if (allocationResult.status !== "Confirmed") {
    const conflictResolution = resolveConflict(bookingRequest);

    if (conflictResolution.success) {
      allocationResult = {
        status: conflictResolution.status,
        allocation: conflictResolution.allocation
      };
      reallocationUpdates = conflictResolution.existingBookingUpdates;
    }
  }

  const bookingsFile = ensureMonthlyBookingsFile(bookingRequest.bookingDate);
  const bookings = readBookingsFromFile(bookingsFile);

  reallocationUpdates.forEach(update => {
    const bookingToUpdate = bookings.find(booking => String(booking["@_id"]) === String(update.bookingId));
    if (bookingToUpdate) {
      bookingToUpdate.status = update.status;
      bookingToUpdate.allocation = update.allocation;
    }
  });

  const newBooking = {
    "@_id": getNextBookingRecordId(bookings),
    ...bookingRequest,
    status: allocationResult.status,
    allocation: allocationResult.allocation,
    deploymentStatus: bookingRequiresDeployment(bookingRequest) ? "Pending Deployment" : "Collection Only",
    claimedByUserId: "",
    claimedByName: "",
    claimedAt: "",
    deployedByUserId: "",
    deployedByName: "",
    deployedAt: "",
    deploymentRemarks: ""
  };

  bookings.push(newBooking);
  writeBookingsToFile(bookingsFile, bookings);
  return newBooking;
}

app.post("/api/admin/import/bookings/preview", requireLogin, requireAdmin, (req, res) => {
  try {
    const rows = req.body.rows;
    if (!Array.isArray(rows)) {
      return res.status(400).json({ success: false, message: "rows must be an array of booking records." });
    }

    const dateRange = getImportDateRange(req.body);
    const preview = previewLegacyBookingRows(rows, dateRange);
    res.json({ success: true, ...preview });
  } catch (error) {
    console.error("Booking import preview error:", error);
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
});

app.post("/api/admin/import/bookings/commit", requireLogin, requireAdmin, (req, res) => {
  try {
    const rows = req.body.rows;
    if (!Array.isArray(rows)) {
      return res.status(400).json({ success: false, message: "rows must be an array of booking records." });
    }

    const dateRange = getImportDateRange(req.body);
    const preview = previewLegacyBookingRows(rows, dateRange);
    if (preview.invalidRows.length > 0 && !req.body.allowPartialImport) {
      return res.status(400).json({
        success: false,
        message: "Some rows within the selected date range are invalid. Fix them or set allowPartialImport to true.",
        ...preview
      });
    }

    const importResults = preview.validRows.map(row => saveImportedBooking(row.mappedBooking, req.session.user));
    const importedBookings = importResults.filter(result => !result.skipped);
    const duplicateRows = importResults.filter(result => result.skipped);

    res.json({
      success: true,
      message: `${importedBookings.length} booking record(s) imported from the selected date range. ${duplicateRows.length} duplicate row(s) skipped. ${preview.rowsOutsideRange} row(s) were outside the selected date range.`,
      importedCount: importedBookings.length,
      skippedCount: preview.invalidRows.length + preview.skippedRows.length + duplicateRows.length + preview.rowsOutsideRange,
      duplicateRows,
      importedBookings,
      invalidRows: preview.invalidRows,
      skippedRows: preview.skippedRows,
      outOfRangeRows: preview.outOfRangeRows,
      rowsWithinRange: preview.rowsWithinRange,
      rowsOutsideRange: preview.rowsOutsideRange,
      dateRange: preview.dateRange
    });
  } catch (error) {
    console.error("Booking import commit error:", error);
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
});

/* ---------------- BOOKING ROUTES ---------------- */

app.post("/api/bookings", requireLogin, (req, res) => {
  try {
    const parser = new XMLParser({ ignoreAttributes: false });
    const builder = new XMLBuilder({
      ignoreAttributes: false,
      format: true,
      suppressEmptyNode: true
    });

    const bookingRequest = removePersonalDataFromBooking({
      ...req.body,
      userId: req.session.user.userId
    });

    const isRecurring =
      bookingRequest.bookingMode === "recurring" &&
      bookingRequest.recurrence &&
      Array.isArray(bookingRequest.recurrence.dates);

    if (isRecurring && !userCanCreateRecurringBookings(req.session.user)) {
      return res.status(403).json({
        success: false,
        message: "Recurring booking is available only to authorised users."
      });
    }

    const additionalResourceErrors = validateAdditionalResourceRequests(bookingRequest);
    if (additionalResourceErrors.length > 0) {
      return res.status(400).json({
        success: false,
        message: additionalResourceErrors.join(" ")
      });
    }

    const bookingDates = isRecurring
      ? bookingRequest.recurrence.dates.slice(0, 4)
      : [bookingRequest.bookingDate];

    const existingBookingsForRequestId = getBookingsByRequestId(
      bookingRequest.bookingRequestId,
      req.session.user.userId
    );

    if (existingBookingsForRequestId.length > 0) {
      return res.json({
        success: true,
        message: "This booking request was already processed. The existing booking has been returned instead of creating a duplicate.",
        booking: existingBookingsForRequestId[0],
        bookings: existingBookingsForRequestId,
        recurringGroupId: existingBookingsForRequestId[0].recurringGroupId || "",
        idempotentReplay: true
      });
    }

    const recurringGroupId = isRecurring ? `REC-${Date.now()}` : "";
    const preparedBookingRequests = bookingDates.map((date, index) => {
      const singleBookingRequest = prepareBookingForSave({
        ...bookingRequest,
        bookingDate: date,
        bookingMode: isRecurring ? "recurring" : "one-time",
        recurringGroupId,
        recurrenceTotal: bookingDates.length,
        recurrenceSequence: index + 1
      });

      delete singleBookingRequest.recurrence;
      return singleBookingRequest;
    });

    const duplicateBooking = preparedBookingRequests
      .map(request => findDuplicateBooking(request))
      .find(Boolean);

    if (duplicateBooking) {
      return res.status(409).json({
        success: false,
        message: "You already have an identical booking for this date, time, location, resource and accessory request. Please modify the existing booking instead of creating a duplicate.",
        duplicateBooking
      });
    }

    const savedBookings = [];

    for (const singleBookingRequest of preparedBookingRequests) {
      let allocationResult = allocateResources(singleBookingRequest);
      let reallocationUpdates = [];

      if (allocationResult.status !== "Confirmed") {
        const conflictResolution = resolveConflict(singleBookingRequest);

        if (conflictResolution.success) {
          allocationResult = {
            status: conflictResolution.status,
            allocation: conflictResolution.allocation
          };

          reallocationUpdates = conflictResolution.existingBookingUpdates;
        }
      }

      const bookingsFile = ensureMonthlyBookingsFile(singleBookingRequest.bookingDate);
      const xmlData = fs.readFileSync(bookingsFile, "utf8");
      const parsed = parser.parse(xmlData);

      if (!parsed.bookings) parsed.bookings = {};

      if (!parsed.bookings.booking) {
        parsed.bookings.booking = [];
      } else if (!Array.isArray(parsed.bookings.booking)) {
        parsed.bookings.booking = [parsed.bookings.booking];
      }

      reallocationUpdates.forEach(update => {
        const bookingToUpdate = parsed.bookings.booking.find(
          booking => String(booking["@_id"]) === String(update.bookingId)
        );

        if (bookingToUpdate) {
          bookingToUpdate.status = update.status;
          bookingToUpdate.allocation = update.allocation;
        }
      });

      const newBooking = {
        "@_id": getNextBookingRecordId(parsed.bookings.booking),
        ...singleBookingRequest,
        status: allocationResult.status,
        allocation: allocationResult.allocation,
        deploymentStatus: bookingRequiresDeployment(singleBookingRequest) ? "Pending Deployment" : "Collection Only",
        claimedByUserId: "",
        claimedByName: "",
        claimedAt: "",
        deployedByUserId: "",
        deployedByName: "",
        deployedAt: "",
        deploymentRemarks: ""
      };

      parsed.bookings.booking.push(newBooking);

      fs.writeFileSync(bookingsFile, builder.build(parsed));
      savedBookings.push(newBooking);
    }

    res.json({
      success: true,
      message: isRecurring
        ? `${savedBookings.length} recurring booking records processed.`
        : "Booking saved with resource allocation.",
      booking: savedBookings[0],
      bookings: savedBookings,
      recurringGroupId
    });
  } catch (error) {
    console.error("Booking save error:", error);

    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.get("/api/bookings", requireLogin, requireAdmin, (req, res) => {
  try {
    const bookingDate = req.query.date;

    if (!bookingDate) {
      return res.status(400).send("Please provide a date, e.g. /api/bookings?date=2026-06-01");
    }

    const bookingsFile = ensureMonthlyBookingsFile(bookingDate);
    const xml = fs.readFileSync(bookingsFile, "utf8");

    res.set("Content-Type", "application/xml");
    res.send(xml);
  } catch (error) {
    res.status(500).send(error.message);
  }
});

app.get("/api/bookings/search", requireLogin, (req, res) => {
  try {
    const files = getAllMonthlyBookingFiles();
    const today = new Date().toISOString().split("T")[0];
    const isAdmin = req.session.user.role === "Admin";
    const users = isAdmin ? getUsersFromXML() : [];

    const bookings = files.flatMap(file => readBookingsFromFile(file))
      .filter(booking => {
        const activeFutureBooking =
          booking.bookingDate >= today &&
          booking.status !== "Deleted" &&
          booking.status !== "Cancelled";

        if (!activeFutureBooking) return false;
        return isAdmin || userOwnsBooking(req, booking);
      })
      .map(booking => isAdmin ? formatBookingForManagementResponse(booking, users) : booking)
      .sort((a, b) => {
        return `${a.bookingDate} ${a.startTime}`.localeCompare(
          `${b.bookingDate} ${b.startTime}`
        );
      });

    res.json({
      success: true,
      mode: isAdmin ? "admin" : "user",
      bookings
    });
  } catch (error) {
    console.error("Search bookings error:", error);

    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.delete("/api/bookings/:bookingId", requireLogin, (req, res) => {
  try {
    const bookingId = req.params.bookingId;
    const bookingDate = req.query.date;

    if (!bookingDate) {
      return res.status(400).json({
        success: false,
        message: "Booking date is required."
      });
    }

    const bookingsFile = ensureMonthlyBookingsFile(bookingDate);
    const bookings = readBookingsFromFile(bookingsFile);

    const bookingToDelete = bookings.find(
      booking => String(booking["@_id"]) === String(bookingId)
    );

    if (!bookingToDelete) {
      return res.status(404).json({
        success: false,
        message: "Booking not found."
      });
    }

    if (!userCanManageBooking(req, bookingToDelete)) {
      return res.status(403).json({
        success: false,
        message: "You are not authorised to delete this booking."
      });
    }

    const updatedBookings = bookings.filter(
      booking => String(booking["@_id"]) !== String(bookingId)
    );

    writeBookingsToFile(bookingsFile, updatedBookings);

    res.json({
      success: true,
      message: "Booking deleted successfully."
    });
  } catch (error) {
    console.error("Delete booking error:", error);

    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.delete("/api/bookings/recurring/:recurringGroupId", requireLogin, (req, res) => {
  try {
    const recurringGroupId = req.params.recurringGroupId;
    const files = getAllMonthlyBookingFiles();

    let deletedCount = 0;

    files.forEach(file => {
      const bookings = readBookingsFromFile(file);

      const updatedBookings = bookings.filter(booking => {
        const shouldDelete =
          booking.recurringGroupId === recurringGroupId &&
          userCanManageBooking(req, booking);

        if (shouldDelete) deletedCount++;

        return !shouldDelete;
      });

      writeBookingsToFile(file, updatedBookings);
    });

    res.json({
      success: true,
      message: "Recurring booking set deleted successfully.",
      deletedCount
    });
  } catch (error) {
    console.error("Delete recurring booking error:", error);

    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.put("/api/bookings/:bookingId", requireLogin, (req, res) => {
  try {
    const bookingId = req.params.bookingId;
    const originalBookingDate = req.query.date;

    if (!originalBookingDate) {
      return res.status(400).json({
        success: false,
        message: "Original booking date is required."
      });
    }

    const originalBookingsFile = ensureMonthlyBookingsFile(originalBookingDate);
    const originalBookings = readBookingsFromFile(originalBookingsFile);

    const bookingIndex = originalBookings.findIndex(
      booking => String(booking["@_id"]) === String(bookingId)
    );

    if (bookingIndex === -1) {
      return res.status(404).json({
        success: false,
        message: "Booking not found in original month file."
      });
    }

    const existingBooking = originalBookings[bookingIndex];

    if (!userCanManageBooking(req, existingBooking)) {
      return res.status(403).json({
        success: false,
        message: "You are not authorised to modify this booking."
      });
    }

    const updatedBookingRequest = prepareBookingForSave(removePersonalDataFromBooking({
      ...existingBooking,
      ...req.body,
      userId: existingBooking.userId || req.session.user.userId,
      bookingDate: req.body.bookingDate || existingBooking.bookingDate,
      status: "Pending Allocation",
      modifiedByUserId: req.session.user.userId,
      modifiedByName: req.session.user.name
    }));

    const additionalResourceErrors = validateAdditionalResourceRequests(updatedBookingRequest);
    if (additionalResourceErrors.length > 0) {
      return res.status(400).json({
        success: false,
        message: additionalResourceErrors.join(" ")
      });
    }

    const duplicateBooking = findDuplicateBooking(updatedBookingRequest, {
      excludeBookingId: updatedBookingRequest.bookingDate === originalBookingDate ? bookingId : ""
    });

    if (duplicateBooking) {
      return res.status(409).json({
        success: false,
        message: "This change would create a duplicate of an existing booking. Please modify the existing booking instead.",
        duplicateBooking
      });
    }

    const remainingOriginalBookings = originalBookings.filter(
      booking => String(booking["@_id"]) !== String(bookingId)
    );

    writeBookingsToFile(originalBookingsFile, remainingOriginalBookings);

    let allocationResult = allocateResources(updatedBookingRequest);
    let reallocationUpdates = [];

    if (allocationResult.status !== "Confirmed") {
      const conflictResolution = resolveConflict(updatedBookingRequest);

      if (conflictResolution.success) {
        allocationResult = {
          status: conflictResolution.status,
          allocation: conflictResolution.allocation
        };

        reallocationUpdates = conflictResolution.existingBookingUpdates;
      }
    }

    const targetBookingsFile = ensureMonthlyBookingsFile(updatedBookingRequest.bookingDate);
    const targetBookings = readBookingsFromFile(targetBookingsFile);

    reallocationUpdates.forEach(update => {
      const bookingToUpdate = targetBookings.find(
        booking => String(booking["@_id"]) === String(update.bookingId)
      );

      if (bookingToUpdate) {
        bookingToUpdate.status = update.status;
        bookingToUpdate.allocation = update.allocation;
      }
    });

    const newBookingId =
      updatedBookingRequest.bookingDate === originalBookingDate
        ? bookingId
        : targetBookings.length + 1;

    const finalUpdatedBooking = {
      ...updatedBookingRequest,
      "@_id": newBookingId,
      status: allocationResult.status,
      allocation: allocationResult.allocation,
      modifiedAt: new Date().toISOString()
    };

    targetBookings.push(finalUpdatedBooking);
    writeBookingsToFile(targetBookingsFile, targetBookings);

    res.json({
      success: true,
      message:
        updatedBookingRequest.bookingDate === originalBookingDate
          ? "Booking updated successfully."
          : "Booking updated and moved to the correct monthly file.",
      booking: finalUpdatedBooking
    });
  } catch (error) {
    console.error("Update booking error:", error);

    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

/* ---------------- DE DEPLOYMENT ROUTES ---------------- */

app.get("/api/de/bookings", requireLogin, requireDEOrAdmin, (req, res) => {
  try {
    const bookingDate = req.query.date;

    if (!bookingDate) {
      return res.status(400).json({
        success: false,
        message: "Booking date is required."
      });
    }

    const bookingsFile = getDateBookingsFile(bookingDate);
    const resourceById = buildResourceLookup();
    const bookings = readBookingsFromFile(bookingsFile)
      .filter(booking => booking.bookingDate === bookingDate)
      .filter(booking => booking.status !== "Deleted" && booking.status !== "Cancelled")
      .filter(booking => bookingRequiresDeployment(booking))
      .filter(booking => bookingHasDEManagedResources(booking, resourceById))
      .sort((a, b) => `${a.startTime || ""} ${a.location || ""}`.localeCompare(`${b.startTime || ""} ${b.location || ""}`));

    const duplicateBookingIds = getDuplicateBookingIds(bookings);
    const users = getUsersFromXML();
    const provenanceByBookingId = getJourneyEngine().buildDeploymentProvenance(bookings);
    const formattedBookings = bookings.map(booking =>
      formatDeploymentBookingForResponse(booking, users, provenanceByBookingId)
    );
    const operations = getJourneyEngine().buildOperationalTimelineAndJourneys(
      formattedBookings,
      bookingDate
    );

    res.json({
      success: true,
      bookings: formattedBookings,
      operationalTimeline: operations.timeline,
      resourceJourneys: operations.resourceJourneys,
      operationalSummary: operations.summary,
      journeyOptimization: getJourneyEngine().buildOptimizationPlan(formattedBookings, bookingDate),
      journeyValidation: getJourneyEngine().buildValidationReport(formattedBookings, bookingDate),
      bookingIdentityIntegrity: {
        valid: duplicateBookingIds.length === 0,
        duplicateBookingIds
      }
    });
  } catch (error) {
    console.error("DE bookings retrieval error:", error);

    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.put("/api/de/bookings/:bookingId/claim", requireLogin, requireDEOrAdmin, (req, res) => {
  try {
    const bookingId = req.params.bookingId;
    const bookingDate = req.body.bookingDate || req.query.date;
    const bookingsFile = getDateBookingsFile(bookingDate);
    const bookings = readBookingsFromFile(bookingsFile);
    const booking = findBookingById(bookings, bookingId);

    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found." });
    }

    const existingBundle = findActiveOperationalBundleBooking(bookings, req.session.user.userId);
    if (existingBundle) {
      return res.status(409).json({
        success: false,
        message: "Complete or release your current operational job before claiming another."
      });
    }

    if (normaliseDeploymentStatus(booking) !== "Pending Deployment") {
      return res.status(409).json({
        success: false,
        message: "This job is no longer pending and cannot be claimed."
      });
    }

    const resourceById = buildResourceLookup();
    if (!bookingHasDEManagedResources(booking, resourceById)) {
      return res.status(409).json({
        success: false,
        message: "This booking is collection-only and does not require DE deployment."
      });
    }

    const bundle = getJourneyEngine().buildOperationalBundle(bookings, booking);
    const linkedBookingIds = getJourneyEngine().getBundleLinkedBookingIds(bundle);
    const now = new Date().toISOString();

    linkedBookingIds.forEach(linkedId => {
      const linkedBooking = findBookingById(bookings, linkedId);
      if (!linkedBooking) return;

      const linkedStatus = normaliseDeploymentStatus(linkedBooking);
      const claimedByOther =
        linkedStatus === "Claimed" &&
        String(linkedBooking.claimedByUserId || "") !== String(req.session.user.userId);

      if (claimedByOther || !["Pending Deployment", "Claimed"].includes(linkedStatus)) {
        const error = new Error("Part of this operational route is no longer available to claim.");
        error.statusCode = 409;
        throw error;
      }
    });

    linkedBookingIds.forEach(linkedId => {
      const linkedBooking = findBookingById(bookings, linkedId);
      if (!linkedBooking) return;
      linkedBooking.deploymentStatus = "Claimed";
      linkedBooking.claimedByUserId = req.session.user.userId;
      linkedBooking.claimedByName = req.session.user.name;
      linkedBooking.claimedAt = linkedBooking.claimedAt || now;
    });

    booking.deploymentStatus = "Claimed";
    booking.claimedByUserId = req.session.user.userId;
    booking.claimedByName = req.session.user.name;
    booking.claimedAt = now;
    booking.operationalBundle = bundle;
    booking.deployedByUserId = "";
    booking.deployedByName = "";
    booking.deployedAt = "";
    booking.deploymentRemarks = booking.deploymentRemarks || "";

    writeBookingsToFile(bookingsFile, bookings);

    const provenance = getJourneyEngine().buildDeploymentProvenance(bookings);
    res.json({
      success: true,
      message: `Operational route claimed with ${getJourneyEngine().normaliseOperationalBundleLegs(bundle).length} stop(s).`,
      booking: formatDeploymentBookingForResponse(
        booking,
        getUsersFromXML(),
        provenance
      )
    });
  } catch (error) {
    console.error("DE claim job error:", error);
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message
    });
  }
});

app.put("/api/de/bookings/:bookingId/release", requireLogin, requireDEOrAdmin, (req, res) => {
  try {
    const bookingId = req.params.bookingId;
    const bookingDate = req.body.bookingDate || req.query.date;
    const bookingsFile = getDateBookingsFile(bookingDate);
    const bookings = readBookingsFromFile(bookingsFile);
    const booking = findBookingById(bookings, bookingId);

    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found." });
    }

    const isClaimant = String(booking.claimedByUserId || "") === String(req.session.user.userId);
    const isAdmin = req.session.user.role === "Admin";
    if (!isClaimant && !isAdmin) {
      return res.status(403).json({
        success: false,
        message: "Only the claimant or an Admin can release this job."
      });
    }

    const linkedIds = booking.operationalBundle
      ? getJourneyEngine().getBundleLinkedBookingIds(booking.operationalBundle)
      : [String(bookingId)];

    linkedIds.forEach(linkedId => {
      const linked = findBookingById(bookings, linkedId);
      if (!linked) return;
      if (normaliseDeploymentStatus(linked) === "Claimed") {
        linked.deploymentStatus = "Pending Deployment";
        linked.claimedByUserId = "";
        linked.claimedByName = "";
        linked.claimedAt = "";
      }
    });

    booking.deploymentStatus = "Pending Deployment";
    booking.claimedByUserId = "";
    booking.claimedByName = "";
    booking.claimedAt = "";
    delete booking.operationalBundle;

    writeBookingsToFile(bookingsFile, bookings);

    res.json({
      success: true,
      message: "Operational route released.",
      booking: formatDeploymentBookingForResponse(booking, getUsersFromXML())
    });
  } catch (error) {
    console.error("DE release job error:", error);
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message
    });
  }
});

app.put("/api/de/bookings/:bookingId/bundle-legs/:legId/complete", requireLogin, requireDEOrAdmin, (req, res) => {
  try {
    const bookingId = req.params.bookingId;
    const legId = req.params.legId;
    const bookingDate = req.body.bookingDate || req.query.date;
    const remarks = String(req.body.remarks || "").trim();
    const bookingsFile = getDateBookingsFile(bookingDate);
    const bookings = readBookingsFromFile(bookingsFile);
    const anchorBooking = findBookingById(bookings, bookingId);

    if (!anchorBooking || !anchorBooking.operationalBundle) {
      return res.status(404).json({
        success: false,
        message: "Active operational route not found."
      });
    }

    const isClaimant =
      String(anchorBooking.claimedByUserId || "") === String(req.session.user.userId);
    const isAdmin = req.session.user.role === "Admin";
    if (!isClaimant && !isAdmin) {
      return res.status(403).json({
        success: false,
        message: "Only the claimant or an Admin can complete this route stop."
      });
    }

    const legs = getJourneyEngine().normaliseOperationalBundleLegs(anchorBooking.operationalBundle);
    const leg = legs.find(item => String(item.legId) === String(legId));
    if (!leg) {
      return res.status(404).json({ success: false, message: "Route stop not found." });
    }

    if (leg.status === "Completed") {
      return res.json({
        success: true,
        message: "This route stop was already completed.",
        booking: formatDeploymentBookingForResponse(anchorBooking, getUsersFromXML())
      });
    }

    leg.status = "Completed";
    leg.completedAt = new Date().toISOString();
    leg.completedByUserId = req.session.user.userId;
    leg.completedByName = req.session.user.name;
    leg.remarks = remarks;

    if (leg.type === "Deployment") {
      toArray(leg.linkedBookingIds?.bookingId).forEach(linkedId => {
        const linked = findBookingById(bookings, linkedId);
        if (!linked) return;
        linked.deploymentStatus = "Deployed";
        linked.deployedByUserId = req.session.user.userId;
        linked.deployedByName = req.session.user.name;
        linked.deployedAt = new Date().toISOString();
        linked.deploymentRemarks = remarks;
      });
    }

    anchorBooking.operationalBundle.legs = { leg: legs };

    const allCompleted = legs.every(item => item.status === "Completed");
    if (allCompleted) {
      anchorBooking.operationalBundle.status = "Completed";
      anchorBooking.operationalBundle.completedAt = new Date().toISOString();
      anchorBooking.deploymentStatus = "Deployed";
      anchorBooking.deployedByUserId = req.session.user.userId;
      anchorBooking.deployedByName = req.session.user.name;
      anchorBooking.deployedAt = new Date().toISOString();
    }

    writeBookingsToFile(bookingsFile, bookings);

    const provenance = getJourneyEngine().buildDeploymentProvenance(bookings);
    res.json({
      success: true,
      message: allCompleted
        ? "Operational route completed."
        : `Stop ${leg.routeOrder} marked complete.`,
      booking: formatDeploymentBookingForResponse(
        anchorBooking,
        getUsersFromXML(),
        provenance
      )
    });
  } catch (error) {
    console.error("DE complete route stop error:", error);
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message
    });
  }
});

app.put("/api/de/bookings/:bookingId/complete", requireLogin, requireDEOrAdmin, (req, res) => {
  try {
    const bookingId = req.params.bookingId;
    const bookingDate = req.body.bookingDate || req.query.date;
    const remarks = String(req.body.remarks || "").trim();

    const updatedBooking = updateDeploymentBooking(bookingDate, bookingId, booking => {
      const currentStatus = normaliseDeploymentStatus(booking);
      const isClaimant = String(booking.claimedByUserId || "") === String(req.session.user.userId);
      const isAdmin = req.session.user.role === "Admin";

      if (currentStatus === "Deployed") {
        const error = new Error("This job has already been marked as deployed.");
        error.statusCode = 409;
        throw error;
      }

      if (currentStatus === "Claimed" && !isClaimant && !isAdmin) {
        const error = new Error("Only the claimant or an Admin can complete this job.");
        error.statusCode = 403;
        throw error;
      }

      booking.deploymentStatus = "Deployed";
      booking.deployedByUserId = req.session.user.userId;
      booking.deployedByName = req.session.user.name;
      booking.deployedAt = new Date().toISOString();
      booking.deploymentRemarks = remarks;

      if (!booking.claimedByUserId) {
        booking.claimedByUserId = req.session.user.userId;
        booking.claimedByName = req.session.user.name;
        booking.claimedAt = booking.claimedAt || new Date().toISOString();
      }
    });

    res.json({
      success: true,
      message: "Deployment job marked as deployed.",
      booking: formatDeploymentBookingForResponse(updatedBooking, getUsersFromXML())
    });
  } catch (error) {
    console.error("DE complete job error:", error);

    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message
    });
  }
});

app.put("/api/de/bookings/:bookingId/fail", requireLogin, requireDEOrAdmin, (req, res) => {
  try {
    const bookingId = req.params.bookingId;
    const bookingDate = req.body.bookingDate || req.query.date;
    const remarks = String(req.body.remarks || "").trim();

    const updatedBooking = updateDeploymentBooking(bookingDate, bookingId, booking => {
      const currentStatus = normaliseDeploymentStatus(booking);
      const isClaimant = String(booking.claimedByUserId || "") === String(req.session.user.userId);
      const isAdmin = req.session.user.role === "Admin";

      if (currentStatus === "Claimed" && !isClaimant && !isAdmin) {
        const error = new Error("Only the claimant or an Admin can update this claimed job.");
        error.statusCode = 403;
        throw error;
      }

      booking.deploymentStatus = "Unable to Deploy";
      booking.deployedByUserId = req.session.user.userId;
      booking.deployedByName = req.session.user.name;
      booking.deployedAt = new Date().toISOString();
      booking.deploymentRemarks = remarks || "Unable to deploy.";

      if (!booking.claimedByUserId) {
        booking.claimedByUserId = req.session.user.userId;
        booking.claimedByName = req.session.user.name;
        booking.claimedAt = booking.claimedAt || new Date().toISOString();
      }
    });

    res.json({
      success: true,
      message: "Deployment job marked as unable to deploy.",
      booking: formatDeploymentBookingForResponse(updatedBooking, getUsersFromXML())
    });
  } catch (error) {
    console.error("DE fail job error:", error);

    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message
    });
  }
});


/* ---------------- ADMIN USER MANAGEMENT ROUTES ---------------- */

app.get("/api/admin/users", requireLogin, requireAdmin, (req, res) => {
  try {
    const users = getUsersFromXML()
      .map(formatAdminUserForResponse)
      .sort((a, b) => a.name.localeCompare(b.name));

    res.json({
      success: true,
      users
    });
  } catch (error) {
    console.error("Admin list users error:", error);

    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.post("/api/admin/users", requireLogin, requireAdmin, (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const email = normaliseEmail(req.body.email);
    const role = normaliseUserRole(req.body.role || "User");
    const status = normaliseUserStatus(req.body.status || "PendingActivation");
    const allowRecurringBookings = role === "Admin" || normaliseBoolean(req.body.allowRecurringBookings);

    if (!name || !email) {
      return res.status(400).json({
        success: false,
        message: "Name and official email address are required."
      });
    }

    const users = getUsersFromXML();

    const emailExists = users.some(user => normaliseEmail(user.email) === email);
    if (emailExists) {
      return res.status(409).json({
        success: false,
        message: "A user with this email address already exists."
      });
    }

    const newUser = {
      userId: generateNextUserId(users),
      name,
      email,
      role,
      status,
      allowRecurringBookings,
      createdAt: new Date().toISOString(),
      createdByUserId: req.session.user.userId
    };

    users.push(newUser);
    saveUsersToXML(users);

    res.json({
      success: true,
      message: "User added successfully.",
      user: formatAdminUserForResponse(newUser)
    });
  } catch (error) {
    console.error("Admin add user error:", error);

    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.put("/api/admin/users/:userId", requireLogin, requireAdmin, (req, res) => {
  try {
    const userId = req.params.userId;
    const name = String(req.body.name || "").trim();
    const email = normaliseEmail(req.body.email);
    const role = normaliseUserRole(req.body.role || "User");
    const status = normaliseUserStatus(req.body.status || "PendingActivation");
    const allowRecurringBookings = role === "Admin" || normaliseBoolean(req.body.allowRecurringBookings);

    if (!name || !email) {
      return res.status(400).json({
        success: false,
        message: "Name and official email address are required."
      });
    }

    const users = getUsersFromXML();

    const userIndex = users.findIndex(user => String(user.userId) === String(userId));
    if (userIndex === -1) {
      return res.status(404).json({
        success: false,
        message: "User not found."
      });
    }

    const emailUsedByAnotherUser = users.some(user =>
      String(user.userId) !== String(userId) &&
      normaliseEmail(user.email) === email
    );

    if (emailUsedByAnotherUser) {
      return res.status(409).json({
        success: false,
        message: "Another user already uses this email address."
      });
    }

    const existingUser = users[userIndex];

    if (String(existingUser.userId) === String(req.session.user.userId) && role !== "Admin") {
      return res.status(400).json({
        success: false,
        message: "You cannot remove your own Admin role while signed in."
      });
    }

    users[userIndex] = {
      ...existingUser,
      name,
      email,
      role,
      status,
      allowRecurringBookings,
      updatedAt: new Date().toISOString(),
      updatedByUserId: req.session.user.userId
    };

    saveUsersToXML(users);

    res.json({
      success: true,
      message: "User updated successfully.",
      user: formatAdminUserForResponse(users[userIndex])
    });
  } catch (error) {
    console.error("Admin update user error:", error);

    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.delete("/api/admin/users/:userId", requireLogin, requireAdmin, (req, res) => {
  try {
    const userId = req.params.userId;
    const users = getUsersFromXML();

    const userIndex = users.findIndex(user => String(user.userId) === String(userId));
    if (userIndex === -1) {
      return res.status(404).json({
        success: false,
        message: "User not found."
      });
    }

    if (String(userId) === String(req.session.user.userId)) {
      return res.status(400).json({
        success: false,
        message: "You cannot disable your own account while signed in."
      });
    }

    users[userIndex] = {
      ...users[userIndex],
      status: "Disabled",
      disabledAt: new Date().toISOString(),
      disabledByUserId: req.session.user.userId
    };

    saveUsersToXML(users);

    res.json({
      success: true,
      message: "User disabled successfully.",
      user: formatAdminUserForResponse(users[userIndex])
    });
  } catch (error) {
    console.error("Admin disable user error:", error);

    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.post("/api/admin/users/:userId/reset-activation", requireLogin, requireAdmin, (req, res) => {
  try {
    const userId = req.params.userId;
    const users = getUsersFromXML();

    const userIndex = users.findIndex(user => String(user.userId) === String(userId));
    if (userIndex === -1) {
      return res.status(404).json({
        success: false,
        message: "User not found."
      });
    }

    if (String(userId) === String(req.session.user.userId)) {
      return res.status(400).json({
        success: false,
        message: "You cannot reset activation for your own signed-in account."
      });
    }

    users[userIndex] = {
      ...users[userIndex],
      status: "PendingActivation",
      passwordHash: "",
      activatedAt: "",
      resetPasswordTokenHash: "",
      resetPasswordExpiresAt: "",
      resetPasswordRequestedAt: "",
      activationResetAt: new Date().toISOString(),
      activationResetByUserId: req.session.user.userId
    };

    saveUsersToXML(users);

    res.json({
      success: true,
      message: "User activation reset successfully.",
      user: formatAdminUserForResponse(users[userIndex])
    });
  } catch (error) {
    console.error("Admin reset activation error:", error);

    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});



/* ---------------- ADMIN LOCATION MANAGEMENT ROUTES ---------------- */

app.get("/api/admin/locations", requireLogin, requireAdmin, (req, res) => {
  try {
    const locations = readLocationsFromXML()
      .sort((a, b) => a.name.localeCompare(b.name));

    res.json({
      success: true,
      locations
    });
  } catch (error) {
    console.error("Admin locations retrieval error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post("/api/admin/locations", requireLogin, requireAdmin, (req, res) => {
  try {
    const locations = readLocationsFromXML();
    const name = String(req.body.name || "").trim();
    const status = normaliseLocationStatus(req.body.status || "Active");
    const aliases = normaliseLocationAliases(req.body.aliases);
    const notes = String(req.body.notes || "").trim();

    if (!name) {
      return res.status(400).json({ success: false, message: "Location name is required." });
    }

    const nameExists = locations.some(location => location.name.toLowerCase() === name.toLowerCase());
    if (nameExists) {
      return res.status(409).json({ success: false, message: "A location with this name already exists." });
    }

    const now = new Date().toISOString();
    const newLocation = {
      id: generateNextLocationId(locations),
      name,
      status,
      aliases,
      notes,
      createdAt: now,
      updatedAt: now
    };

    locations.push(newLocation);
    saveLocationsToXML(locations);

    res.json({
      success: true,
      message: "Location added successfully.",
      location: formatLocationForResponse(newLocation)
    });
  } catch (error) {
    console.error("Admin location creation error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.put("/api/admin/locations/:locationId", requireLogin, requireAdmin, (req, res) => {
  try {
    const locationId = req.params.locationId;
    const locations = readLocationsFromXML();
    const index = locations.findIndex(location => String(location.id) === String(locationId));

    if (index === -1) {
      return res.status(404).json({ success: false, message: "Location not found." });
    }

    const name = String(req.body.name || "").trim();
    const status = normaliseLocationStatus(req.body.status || "Active");
    const aliases = normaliseLocationAliases(req.body.aliases);
    const notes = String(req.body.notes || "").trim();

    if (!name) {
      return res.status(400).json({ success: false, message: "Location name is required." });
    }

    const nameUsedByAnotherLocation = locations.some(location =>
      String(location.id) !== String(locationId) &&
      location.name.toLowerCase() === name.toLowerCase()
    );

    if (nameUsedByAnotherLocation) {
      return res.status(409).json({ success: false, message: "Another location already uses this name." });
    }

    locations[index] = {
      ...locations[index],
      name,
      status,
      aliases,
      notes,
      updatedAt: new Date().toISOString()
    };

    saveLocationsToXML(locations);

    res.json({
      success: true,
      message: "Location updated successfully.",
      location: formatLocationForResponse(locations[index])
    });
  } catch (error) {
    console.error("Admin location update error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.delete("/api/admin/locations/:locationId", requireLogin, requireAdmin, (req, res) => {
  try {
    const locationId = req.params.locationId;
    const locations = readLocationsFromXML();
    const index = locations.findIndex(location => String(location.id) === String(locationId));

    if (index === -1) {
      return res.status(404).json({ success: false, message: "Location not found." });
    }

    const selectedLocation = locations[index];

    if (selectedLocation.name === "Other") {
      return res.status(400).json({ success: false, message: "The Other location cannot be deleted because it is needed for custom locations." });
    }

    if (locationHasFutureBookings(selectedLocation.name)) {
      locations[index] = {
        ...selectedLocation,
        status: "Retired",
        updatedAt: new Date().toISOString()
      };
      saveLocationsToXML(locations);

      return res.json({
        success: true,
        message: "This location is used by future bookings, so it has been marked as Retired instead of deleted."
      });
    }

    locations.splice(index, 1);
    saveLocationsToXML(locations);

    res.json({
      success: true,
      message: "Location deleted successfully."
    });
  } catch (error) {
    console.error("Admin location deletion error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/* ---------------- ADMIN RESOURCE MANAGEMENT ROUTES ---------------- */

app.get("/api/admin/resources", requireLogin, requireAdmin, (req, res) => {
  try {
    const resources = readResourcesFromXML().map(formatResourceForResponse);

    res.json({
      success: true,
      resources,
      softwareCatalog: readSoftwareCatalogFromXML().map(formatSoftwareForResponse)
    });
  } catch (error) {
    console.error("Admin resources retrieval error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post("/api/admin/resources", requireLogin, requireAdmin, (req, res) => {
  try {
    const resources = readResourcesFromXML();
    const payload = req.body || {};

    const name = String(payload.name || "").trim();
    const category = normaliseResourceCategory(payload.category);
    const deviceType = category === "Accessory" ? normaliseAccessoryVariantType(payload.deviceType) : normaliseDeviceType(payload.deviceType);
    const resourceType = normaliseResourceType(payload.resourceType);
    const capacity = Number(payload.capacity);

    if (!name) {
      return res.status(400).json({ success: false, message: "Resource name is required." });
    }

    if (!Number.isInteger(capacity) || capacity <= 0) {
      return res.status(400).json({ success: false, message: "Capacity must be a positive whole number." });
    }

    const id = String(payload.id || "").trim() || generateNextResourceId(resources, deviceType, resourceType);

    if (resources.some(resource => String(resource.id).toLowerCase() === id.toLowerCase())) {
      return res.status(409).json({ success: false, message: "A resource with this ID already exists." });
    }

    const now = new Date().toISOString();
    const newResource = {
      id,
      name,
      category,
      deviceType,
      capacity,
      resourceType,
      status: normaliseResourceStatus(payload.status),
      location: String(payload.location || "").trim(),
      fulfilmentMode: normaliseFulfilmentMode(payload.fulfilmentMode || payload.fulfillmentMode, { ...payload, name, category, deviceType, resourceType }),
      software: { item: normaliseSoftwareItems(payload.software) },
      compatibleAccessories: { accessory: category === "Device" ? normaliseCompatibleAccessories(payload.compatibleAccessories) : [] },
      notes: String(payload.notes || "").trim(),
      createdAt: now,
      updatedAt: now
    };

    resources.push(newResource);
    saveResourcesToXML(resources);

    res.json({
      success: true,
      message: "Resource added successfully.",
      resource: formatResourceForResponse(newResource)
    });
  } catch (error) {
    console.error("Admin resource creation error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.put("/api/admin/resources/:resourceId", requireLogin, requireAdmin, (req, res) => {
  try {
    const resourceId = req.params.resourceId;
    const resources = readResourcesFromXML();
    const index = resources.findIndex(resource => String(resource.id) === String(resourceId));

    if (index === -1) {
      return res.status(404).json({ success: false, message: "Resource not found." });
    }

    const existing = resources[index];
    const payload = req.body || {};
    const capacity = Number(payload.capacity);

    if (!String(payload.name || "").trim()) {
      return res.status(400).json({ success: false, message: "Resource name is required." });
    }

    if (!Number.isInteger(capacity) || capacity <= 0) {
      return res.status(400).json({ success: false, message: "Capacity must be a positive whole number." });
    }

    const name = String(payload.name || "").trim();
    const category = normaliseResourceCategory(payload.category);
    const deviceType = category === "Accessory" ? normaliseAccessoryVariantType(payload.deviceType) : normaliseDeviceType(payload.deviceType);
    const resourceType = normaliseResourceType(payload.resourceType);
    const previousId = String(existing.id || "").trim();
    const typeChanged =
      String(existing.deviceType || "") !== deviceType ||
      String(existing.resourceType || "") !== resourceType;

    const updatedId = typeChanged
      ? generateNextResourceId(resources.filter((_, resourceIndex) => resourceIndex !== index), deviceType, resourceType)
      : previousId;

    resources[index] = {
      ...existing,
      id: updatedId,
      name,
      category,
      deviceType,
      capacity,
      resourceType,
      status: normaliseResourceStatus(payload.status),
      location: String(payload.location || "").trim(),
      fulfilmentMode: normaliseFulfilmentMode(payload.fulfilmentMode || payload.fulfillmentMode, {
        ...payload,
        name,
        category,
        deviceType,
        resourceType
      }),
      software: { item: normaliseSoftwareItems(payload.software) },
      compatibleAccessories: { accessory: category === "Device" ? normaliseCompatibleAccessories(payload.compatibleAccessories) : [] },
      notes: String(payload.notes || "").trim(),
      updatedAt: new Date().toISOString()
    };

    saveResourcesToXML(resources);

    res.json({
      success: true,
      message: typeChanged && previousId !== updatedId
        ? `Resource updated successfully. Resource ID changed from ${previousId} to ${updatedId} to match the updated resource type.`
        : "Resource updated successfully.",
      resource: formatResourceForResponse(resources[index]),
      previousResourceId: previousId,
      resourceIdChanged: previousId !== updatedId
    });
  } catch (error) {
    console.error("Admin resource update error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.delete("/api/admin/resources/:resourceId", requireLogin, requireAdmin, (req, res) => {
  try {
    const resourceId = req.params.resourceId;
    const resources = readResourcesFromXML();
    const index = resources.findIndex(resource => String(resource.id) === String(resourceId));

    if (index === -1) {
      return res.status(404).json({ success: false, message: "Resource not found." });
    }

    if (resourceHasFutureBookings(resourceId)) {
      resources[index] = {
        ...resources[index],
        status: "Retired",
        updatedAt: new Date().toISOString()
      };
      saveResourcesToXML(resources);

      return res.json({
        success: true,
        message: "This resource is used by future bookings, so it has been marked as Retired instead of deleted."
      });
    }

    resources.splice(index, 1);
    saveResourcesToXML(resources);

    res.json({
      success: true,
      message: "Resource deleted successfully."
    });
  } catch (error) {
    console.error("Admin resource deletion error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/* ---------------- ADMIN SOFTWARE CATALOG MANAGEMENT ROUTES ---------------- */

app.get("/api/admin/software", requireLogin, requireAdmin, (req, res) => {
  try {
    const softwareCatalog = readSoftwareCatalogFromXML().map(formatSoftwareForResponse);

    res.json({
      success: true,
      softwareCatalog
    });
  } catch (error) {
    console.error("Admin software retrieval error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post("/api/admin/software", requireLogin, requireAdmin, (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const status = normaliseSoftwareStatus(req.body.status || "Active");

    if (!name) {
      return res.status(400).json({ success: false, message: "Software name is required." });
    }

    const catalog = readSoftwareCatalogFromXML();
    const nameExists = catalog.some(software => software.name.toLowerCase() === name.toLowerCase());

    if (nameExists) {
      return res.status(409).json({ success: false, message: "A software item with this name already exists." });
    }

    const now = new Date().toISOString();
    const newSoftware = {
      id: generateNextSoftwareId(catalog),
      name,
      status,
      createdAt: now,
      updatedAt: now
    };

    catalog.push(newSoftware);
    saveSoftwareCatalogToXML(catalog);

    res.json({
      success: true,
      message: "Software added successfully.",
      software: formatSoftwareForResponse(newSoftware)
    });
  } catch (error) {
    console.error("Admin software creation error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.put("/api/admin/software/:softwareId", requireLogin, requireAdmin, (req, res) => {
  try {
    const softwareId = req.params.softwareId;
    const name = String(req.body.name || "").trim();
    const status = normaliseSoftwareStatus(req.body.status || "Active");

    if (!name) {
      return res.status(400).json({ success: false, message: "Software name is required." });
    }

    const catalog = readSoftwareCatalogFromXML();
    const index = catalog.findIndex(software => String(software.id) === String(softwareId));

    if (index === -1) {
      return res.status(404).json({ success: false, message: "Software not found." });
    }

    const nameUsedByAnotherItem = catalog.some(software =>
      String(software.id) !== String(softwareId) &&
      software.name.toLowerCase() === name.toLowerCase()
    );

    if (nameUsedByAnotherItem) {
      return res.status(409).json({ success: false, message: "Another software item already uses this name." });
    }

    const oldName = catalog[index].name;
    catalog[index] = {
      ...catalog[index],
      name,
      status,
      updatedAt: new Date().toISOString()
    };

    const document = readResourcesDocument();
    const updatedResources = document.resources.map(resource => ({
      ...resource,
      software: {
        item: normaliseSoftwareItems(resource.software).map(item =>
          String(item).toLowerCase() === String(oldName).toLowerCase() ? name : item
        )
      }
    }));

    saveResourcesAndSoftwareToXML(updatedResources, catalog);

    res.json({
      success: true,
      message: "Software updated successfully.",
      software: formatSoftwareForResponse(catalog[index])
    });
  } catch (error) {
    console.error("Admin software update error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.delete("/api/admin/software/:softwareId", requireLogin, requireAdmin, (req, res) => {
  try {
    const softwareId = req.params.softwareId;
    const catalog = readSoftwareCatalogFromXML();
    const index = catalog.findIndex(software => String(software.id) === String(softwareId));

    if (index === -1) {
      return res.status(404).json({ success: false, message: "Software not found." });
    }

    const selectedSoftware = catalog[index];

    if (softwareIsUsedByResources(selectedSoftware.name)) {
      catalog[index] = {
        ...selectedSoftware,
        status: "Retired",
        updatedAt: new Date().toISOString()
      };
      saveSoftwareCatalogToXML(catalog);

      return res.json({
        success: true,
        message: "This software is installed on resources, so it has been marked as Retired instead of deleted."
      });
    }

    catalog.splice(index, 1);
    saveSoftwareCatalogToXML(catalog);

    res.json({
      success: true,
      message: "Software deleted successfully."
    });
  } catch (error) {
    console.error("Admin software deletion error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/* ---------------- ADMIN STORAGE DIAGNOSTIC ROUTE ---------------- */
/* Requires an authenticated Admin account. Remove before full production use if not needed. */

app.get("/api/debug/storage", requireLogin, requireAdmin, (req, res) => {
  try {
    res.json({
      success: true,
      dataDir,
      sourceUsersFile,
      liveUsersFile,
      sourceResourcesFile,
      liveResourcesFile,
      locationsFile,
      liveLocationsFile,
      dataDirExists: fs.existsSync(dataDir),
      sourceUsersFileExists: fs.existsSync(sourceUsersFile),
      liveUsersFileExists: fs.existsSync(liveUsersFile),
      sourceResourcesFileExists: fs.existsSync(sourceResourcesFile),
      liveResourcesFileExists: fs.existsSync(liveResourcesFile),
      locationsFileExists: fs.existsSync(locationsFile),
      liveLocationsFileExists: fs.existsSync(liveLocationsFile),
      filesInDataDir: fs.existsSync(dataDir) ? fs.readdirSync(dataDir) : [],
      liveUsersFileSizeBytes: fs.existsSync(liveUsersFile)
        ? fs.statSync(liveUsersFile).size
        : 0
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

/* ---------------- ADMIN DEBUG ROUTE ---------------- */
/* Requires an authenticated Admin account. Does not reveal names, emails, or password hashes. */

app.get("/api/debug/users", requireLogin, requireAdmin, (req, res) => {
  try {
    const users = readStoredUsers().map(user => ({
      userId: user.userId,
      role: user.role,
      status: user.status,
      activatedAt: user.activatedAt,
      hasPasswordHash: Boolean(user.passwordHash),
      hasEncryptedName: Boolean(user.encryptedName),
      hasEncryptedEmail: Boolean(user.encryptedEmail)
    }));

    res.json({
      success: true,
      users
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.listen(PORT, () => {
  try {
    const userCount = initialiseUserStorage();
    const resourceCount = initialiseResourceStorage();
    const locationCount = initialiseLocationStorage();

    console.log(`ICT booking server running on port ${PORT}`);
    console.log("Monthly booking storage enabled.");
    console.log(`DATA_DIR: ${dataDir}`);
    console.log(`Booking files directory: ${path.join(dataDir, "bookings")}`);
    console.log(`Source users file: ${sourceUsersFile}`);
    console.log(`Live users file: ${liveUsersFile}`);
    console.log(`Live users file exists: ${fs.existsSync(liveUsersFile)}`);
    console.log(`User records loaded from persistent storage: ${userCount}`);
    console.log(`Live resources file: ${liveResourcesFile}`);
    console.log(`Resource records loaded from persistent storage: ${resourceCount}`);
    console.log(`Live locations file: ${liveLocationsFile}`);
    console.log(`Location records loaded from persistent storage: ${locationCount}`);
  } catch (error) {
    console.error("Failed to initialise encrypted user storage:", error);
    process.exit(1);
  }
});
