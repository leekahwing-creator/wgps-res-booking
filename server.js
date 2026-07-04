const express = require("express");
const session = require("express-session");
const argon2 = require("argon2");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");
const { XMLParser, XMLBuilder } = require("fast-xml-parser");
const { allocateResources } = require("./resourceAllocator");
const { resolveConflict } = require("./conflictResolver");
const { ensureMonthlyBookingsFile } = require("./bookingFileHelper");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
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

function normaliseResourceStatus(status) {
  const allowedStatuses = ["Available", "Unavailable", "Maintenance", "Retired"];
  return allowedStatuses.includes(status) ? status : "Available";
}

function normaliseResourceType(type) {
  const allowedTypes = ["Cart", "Bag", "Set", "Other"];
  return allowedTypes.includes(type) ? type : "Cart";
}

function normaliseDeviceType(type) {
  const allowedTypes = ["iPad", "iPad with Keyboard", "Laptop"];
  return allowedTypes.includes(type) ? type : "iPad";
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

function readResourcesDocument() {
  ensureLiveResourcesFile();
  const xml = fs.readFileSync(liveResourcesFile, "utf8");
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
          deviceType: normaliseDeviceType(resource.deviceType),
          capacity: Number(resource.capacity) || 0,
          resourceType: normaliseResourceType(resource.resourceType),
          status: normaliseResourceStatus(resource.status),
          location: String(resource.location || "").trim(),
          software: {
            item: softwareItems
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
  const document = readResourcesDocument();
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
    deviceType: normaliseDeviceType(resource.deviceType),
    capacity: Number(resource.capacity) || 0,
    resourceType: normaliseResourceType(resource.resourceType),
    status: normaliseResourceStatus(resource.status),
    location: resource.location || "",
    software: normaliseSoftwareItems(resource.software),
    notes: resource.notes || "",
    createdAt: resource.createdAt || "",
    updatedAt: resource.updatedAt || ""
  };
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

function findBookingById(bookings, bookingId) {
  return bookings.find(booking => String(booking["@_id"]) === String(bookingId));
}

function formatDeploymentBookingForResponse(booking, users) {
  const requesterName = getUserDisplayNameById(users, booking.userId) || "Requester";
  const claimedByName = booking.claimedByName || getUserDisplayNameById(users, booking.claimedByUserId);
  const deployedByName = booking.deployedByName || getUserDisplayNameById(users, booking.deployedByUserId);

  return {
    ...booking,
    requesterName,
    deploymentStatus: normaliseDeploymentStatus(booking),
    claimedByName: claimedByName || "",
    deployedByName: deployedByName || ""
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
  const xml = fs.readFileSync(locationsFile, "utf8");
  const parsed = new XMLParser().parse(xml);

  const locations = toArray(parsed.deploymentLocations?.location)
    .filter(Boolean);

  res.json({ locations });
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

    const bookingDates = isRecurring
      ? bookingRequest.recurrence.dates.slice(0, 4)
      : [bookingRequest.bookingDate];

    const recurringGroupId = isRecurring ? `REC-${Date.now()}` : "";
    const savedBookings = [];

    for (const date of bookingDates) {
      const singleBookingRequest = {
        ...bookingRequest,
        bookingDate: date,
        bookingMode: isRecurring ? "recurring" : "one-time",
        recurringGroupId,
        recurrenceTotal: bookingDates.length,
        recurrenceSequence: savedBookings.length + 1
      };

      delete singleBookingRequest.recurrence;

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

      const bookingsFile = ensureMonthlyBookingsFile(date);
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
        "@_id": parsed.bookings.booking.length + 1,
        ...singleBookingRequest,
        status: allocationResult.status,
        allocation: allocationResult.allocation,
        deploymentStatus: "Pending Deployment",
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

    const bookings = files.flatMap(file => readBookingsFromFile(file))
      .filter(booking => {
        return (
          userOwnsBooking(req, booking) &&
          booking.bookingDate >= today &&
          booking.status !== "Deleted" &&
          booking.status !== "Cancelled"
        );
      })
      .sort((a, b) => {
        return `${a.bookingDate} ${a.startTime}`.localeCompare(
          `${b.bookingDate} ${b.startTime}`
        );
      });

    res.json({
      success: true,
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

    if (!userOwnsBooking(req, bookingToDelete)) {
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
          userOwnsBooking(req, booking);

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

    if (!userOwnsBooking(req, existingBooking)) {
      return res.status(403).json({
        success: false,
        message: "You are not authorised to modify this booking."
      });
    }

    const updatedBookingRequest = removePersonalDataFromBooking({
      ...existingBooking,
      ...req.body,
      userId: req.session.user.userId,
      bookingDate: req.body.bookingDate || existingBooking.bookingDate,
      status: "Pending Allocation"
    });

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
    const bookings = readBookingsFromFile(bookingsFile)
      .filter(booking => booking.bookingDate === bookingDate)
      .filter(booking => booking.status !== "Deleted" && booking.status !== "Cancelled")
      .sort((a, b) => `${a.startTime || ""} ${a.location || ""}`.localeCompare(`${b.startTime || ""} ${b.location || ""}`));

    const users = getUsersFromXML();

    res.json({
      success: true,
      bookings: bookings.map(booking => formatDeploymentBookingForResponse(booking, users))
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

    const updatedBooking = updateDeploymentBooking(bookingDate, bookingId, booking => {
      const currentStatus = normaliseDeploymentStatus(booking);

      if (currentStatus !== "Pending Deployment") {
        const error = new Error("This job is no longer pending and cannot be claimed.");
        error.statusCode = 409;
        throw error;
      }

      booking.deploymentStatus = "Claimed";
      booking.claimedByUserId = req.session.user.userId;
      booking.claimedByName = req.session.user.name;
      booking.claimedAt = new Date().toISOString();
      booking.deployedByUserId = "";
      booking.deployedByName = "";
      booking.deployedAt = "";
      booking.deploymentRemarks = booking.deploymentRemarks || "";
    });

    res.json({
      success: true,
      message: "Deployment job claimed.",
      booking: formatDeploymentBookingForResponse(updatedBooking, getUsersFromXML())
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

    const updatedBooking = updateDeploymentBooking(bookingDate, bookingId, booking => {
      const currentStatus = normaliseDeploymentStatus(booking);
      const isClaimant = String(booking.claimedByUserId || "") === String(req.session.user.userId);
      const isAdmin = req.session.user.role === "Admin";

      if (currentStatus !== "Claimed") {
        const error = new Error("Only claimed jobs can be released.");
        error.statusCode = 409;
        throw error;
      }

      if (!isClaimant && !isAdmin) {
        const error = new Error("Only the claimant or an Admin can release this job.");
        error.statusCode = 403;
        throw error;
      }

      booking.deploymentStatus = "Pending Deployment";
      booking.claimedByUserId = "";
      booking.claimedByName = "";
      booking.claimedAt = "";
    });

    res.json({
      success: true,
      message: "Deployment job released.",
      booking: formatDeploymentBookingForResponse(updatedBooking, getUsersFromXML())
    });
  } catch (error) {
    console.error("DE release job error:", error);

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
    const deviceType = normaliseDeviceType(payload.deviceType);
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
      deviceType,
      capacity,
      resourceType,
      status: normaliseResourceStatus(payload.status),
      location: String(payload.location || "").trim(),
      software: { item: normaliseSoftwareItems(payload.software) },
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

    resources[index] = {
      ...existing,
      name: String(payload.name || "").trim(),
      deviceType: normaliseDeviceType(payload.deviceType),
      capacity,
      resourceType: normaliseResourceType(payload.resourceType),
      status: normaliseResourceStatus(payload.status),
      location: String(payload.location || "").trim(),
      software: { item: normaliseSoftwareItems(payload.software) },
      notes: String(payload.notes || "").trim(),
      updatedAt: new Date().toISOString()
    };

    saveResourcesToXML(resources);

    res.json({
      success: true,
      message: "Resource updated successfully.",
      resource: formatResourceForResponse(resources[index])
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
      dataDirExists: fs.existsSync(dataDir),
      sourceUsersFileExists: fs.existsSync(sourceUsersFile),
      liveUsersFileExists: fs.existsSync(liveUsersFile),
      sourceResourcesFileExists: fs.existsSync(sourceResourcesFile),
      liveResourcesFileExists: fs.existsSync(liveResourcesFile),
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
  } catch (error) {
    console.error("Failed to initialise encrypted user storage:", error);
    process.exit(1);
  }
});
