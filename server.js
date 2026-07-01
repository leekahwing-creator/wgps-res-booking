const crypto = require("crypto");
const express = require("express");
const session = require("express-session");
const argon2 = require("argon2");
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

/* ---------------- GENERAL HELPERS ---------------- */

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function normaliseEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function maskEmail(email) {
  const cleanedEmail = normaliseEmail(email);
  const [name, domain] = cleanedEmail.split("@");

  if (!name || !domain) return "";

  const visiblePrefix = name.slice(0, 2);
  return `${visiblePrefix}${"*".repeat(Math.max(2, name.length - 2))}@${domain}`;
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

/* ---------------- PERSONAL DATA ENCRYPTION ----------------
   Names and email addresses are encrypted at rest with AES-256-GCM.

   Required Render environment variable:
   PERSONAL_DATA_KEY

   Generate a key with:
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

   Store only the generated value in Render. Do not commit it to GitHub.
------------------------------------------------------------ */

function getPersonalDataKey() {
  const encodedKey = process.env.PERSONAL_DATA_KEY;

  if (!encodedKey) {
    throw new Error(
      "PERSONAL_DATA_KEY is missing. Add a 32-byte base64 key in Render environment variables."
    );
  }

  const key = Buffer.from(encodedKey, "base64");

  if (key.length !== 32) {
    throw new Error(
      "PERSONAL_DATA_KEY must be a base64-encoded 32-byte key. Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\""
    );
  }

  return key;
}

function encryptPersonalData(value) {
  const text = String(value || "").trim();

  if (!text) return "";

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getPersonalDataKey(), iv);

  const encrypted = Buffer.concat([
    cipher.update(text, "utf8"),
    cipher.final()
  ]);

  const authTag = cipher.getAuthTag();

  return [
    iv.toString("base64"),
    authTag.toString("base64"),
    encrypted.toString("base64")
  ].join(":");
}

function decryptPersonalData(encryptedValue) {
  const value = String(encryptedValue || "").trim();

  if (!value) return "";

  const parts = value.split(":");

  if (parts.length !== 3) {
    throw new Error("Encrypted personal data is not in the expected AES-GCM format.");
  }

  const [ivBase64, tagBase64, encryptedBase64] = parts;
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getPersonalDataKey(),
    Buffer.from(ivBase64, "base64")
  );

  decipher.setAuthTag(Buffer.from(tagBase64, "base64"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedBase64, "base64")),
    decipher.final()
  ]);

  return decrypted.toString("utf8");
}

function readRawUsersFromXML() {
  ensureLiveUsersFile();

  const xml = fs.readFileSync(liveUsersFile, "utf8");
  const parsed = new XMLParser({ ignoreAttributes: false }).parse(xml);

  return toArray(parsed.organisationUsers?.user);
}

function decryptUserRecord(user) {
  const decryptedName = user.encryptedName
    ? decryptPersonalData(user.encryptedName)
    : String(user.name || "").trim();

  const decryptedEmail = user.encryptedEmail
    ? normaliseEmail(decryptPersonalData(user.encryptedEmail))
    : normaliseEmail(user.email);

  return {
    ...user,
    name: decryptedName,
    email: decryptedEmail
  };
}

function getUsersFromXML() {
  return readRawUsersFromXML().map(decryptUserRecord);
}

function buildEncryptedUserRecord(user) {
  const encryptedRecord = {
    userId: user.userId,
    encryptedName: user.encryptedName || encryptPersonalData(user.name),
    encryptedEmail: user.encryptedEmail || encryptPersonalData(normaliseEmail(user.email)),
    role: user.role || "User",
    status: user.status || "PendingActivation"
  };

  if (user.passwordHash) encryptedRecord.passwordHash = user.passwordHash;
  if (user.createdAt) encryptedRecord.createdAt = user.createdAt;
  if (user.activatedAt) encryptedRecord.activatedAt = user.activatedAt;
  if (user.lastLoginAt) encryptedRecord.lastLoginAt = user.lastLoginAt;
  if (user.failedLoginAttempts) encryptedRecord.failedLoginAttempts = user.failedLoginAttempts;
  if (user.lockUntil) encryptedRecord.lockUntil = user.lockUntil;

  return encryptedRecord;
}

function saveUsersToXML(users) {
  ensureLiveUsersFile();

  const builder = new XMLBuilder({
    ignoreAttributes: false,
    format: true,
    suppressEmptyNode: true
  });

  const encryptedUsers = users.map(buildEncryptedUserRecord);

  const xml = builder.build({
    organisationUsers: {
      user: encryptedUsers
    }
  });

  fs.writeFileSync(liveUsersFile, xml);
}

function migratePlaintextUsersToEncryptedXML() {
  const rawUsers = readRawUsersFromXML();
  const hasPlaintextPersonalData = rawUsers.some(user => user.name || user.email);

  if (!hasPlaintextPersonalData) {
    return false;
  }

  const hydratedUsers = rawUsers.map(decryptUserRecord);
  saveUsersToXML(hydratedUsers);

  console.log("Plaintext user names/emails migrated to encryptedName/encryptedEmail in live users.xml.");
  return true;
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

/* ---------------- BOOKING FILE HELPERS ---------------- */

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
  return normaliseEmail(booking.email) === normaliseEmail(req.session.user.email);
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

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const cleanedEmail = normaliseEmail(email);

    const users = getUsersFromXML();

    const userIndex = users.findIndex(
      existingUser => normaliseEmail(existingUser.email) === cleanedEmail
    );

    const user = users[userIndex];

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

    users[userIndex] = {
      ...user,
      lastLoginAt: new Date().toISOString()
    };

    saveUsersToXML(users);

    req.session.user = {
      userId: user.userId,
      name: user.name,
      email: user.email,
      role: user.role || "User"
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
  // Privacy-preserving legacy endpoint.
  // The portal no longer exposes the full staff directory to normal users.
  res.json({
    users: [req.session.user.name].filter(Boolean)
  });
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

    const bookingRequest = {
      ...req.body,
      userId: req.session.user.userId,
      name: req.session.user.name,
      email: req.session.user.email
    };

    const isRecurring =
      bookingRequest.bookingMode === "recurring" &&
      bookingRequest.recurrence &&
      Array.isArray(bookingRequest.recurrence.dates);

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
        allocation: allocationResult.allocation
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

app.get("/api/bookings", (req, res) => {
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
    const email = req.session.user.email;
    const files = getAllMonthlyBookingFiles();
    const today = new Date().toISOString().split("T")[0];

    const bookings = files.flatMap(file => readBookingsFromFile(file))
      .filter(booking => {
        return (
          normaliseEmail(booking.email) === normaliseEmail(email) &&
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

    const updatedBookingRequest = {
      ...existingBooking,
      ...req.body,
      userId: req.session.user.userId,
      name: req.session.user.name,
      email: req.session.user.email,
      bookingDate: req.body.bookingDate || existingBooking.bookingDate,
      status: "Pending Allocation"
    };

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

/* ---------------- DEBUG ROUTE ---------------- */
/* Disabled by default. Enable only temporarily with ENABLE_DEBUG_ROUTES=true. */

if (process.env.ENABLE_DEBUG_ROUTES === "true") {
  app.get("/api/debug/users", requireLogin, (req, res) => {
    try {
      const users = getUsersFromXML().map(user => ({
        userId: user.userId,
        maskedEmail: maskEmail(user.email),
        role: user.role,
        status: user.status,
        activatedAt: user.activatedAt,
        hasPasswordHash: Boolean(user.passwordHash)
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
}

app.listen(PORT, () => {
  ensureLiveUsersFile();

  try {
    migratePlaintextUsersToEncryptedXML();
  } catch (error) {
    console.warn(`User XML encryption migration skipped: ${error.message}`);
  }

  console.log(`ICT booking server running on port ${PORT}`);
  console.log("Monthly booking storage enabled.");
  console.log(`Booking files directory: ${path.join(dataDir, "bookings")}`);
  console.log(`Live encrypted users file: ${liveUsersFile}`);
});
