const express = require("express");
const session = require("express-session");
const argon2 = require("argon2");
const crypto = require("crypto");
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

const ENCRYPTION_PREFIX = "enc:v1:";

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

  if (storedUser.name && !storedUser.encryptedName) {
    storedUser.encryptedName = encryptText(storedUser.name);
  }

  if (storedUser.email && !storedUser.encryptedEmail) {
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

function getAppBaseUrl() {
  const baseUrl = String(process.env.APP_BASE_URL || "").trim();

  if (!baseUrl) {
    throw new Error("APP_BASE_URL is not configured in Render environment variables.");
  }

  return baseUrl.replace(/\/+$/, "");
}

function hashResetToken(token) {
  return crypto.createHash("sha256").update(String(token), "utf8").digest("hex");
}

function clearPasswordResetFields(user) {
  const cleanedUser = { ...user };
  delete cleanedUser.resetPasswordTokenHash;
  delete cleanedUser.resetPasswordExpiresAt;
  delete cleanedUser.resetPasswordRequestedAt;
  return cleanedUser;
}

async function sendPasswordResetEmail(user, resetLink) {
  const requiredEnvVars = [
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_USER",
    "SMTP_PASS",
    "SMTP_FROM",
    "APP_BASE_URL"
  ];

  const missingEnvVars = requiredEnvVars.filter(name => !process.env[name]);

  if (missingEnvVars.length > 0) {
    throw new Error(`Missing email configuration: ${missingEnvVars.join(", ")}`);
  }

  const nodemailer = require("nodemailer");

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: String(process.env.SMTP_PORT) === "465",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });

  await transporter.sendMail({
    from: process.env.SMTP_FROM,
    to: user.email,
    subject: "ICT Resource Booking Portal Password Reset",
    text: [
      `Dear ${user.name},`,
      "",
      "A request was made to reset the password for your ICT Resource Booking Portal account.",
      "",
      "Use the link below to reset your password. This link is valid for 30 minutes and can be used only once.",
      "",
      resetLink,
      "",
      "If you did not request this password reset, please ignore this email and inform the portal administrator.",
      "",
      "Do not share this link with anyone."
    ].join("\n"),
    html: `
      <p>Dear ${user.name},</p>
      <p>A request was made to reset the password for your ICT Resource Booking Portal account.</p>
      <p>Use the link below to reset your password. This link is valid for <strong>30 minutes</strong> and can be used only once.</p>
      <p><a href="${resetLink}">Reset your password</a></p>
      <p>If you did not request this password reset, please ignore this email and inform the portal administrator.</p>
      <p><strong>Do not share this link with anyone.</strong></p>
    `
  });
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
  const genericMessage = "If the email address belongs to an active portal account, a password reset link will be sent.";

  try {
    const cleanedEmail = normaliseEmail(req.body.email);

    if (!cleanedEmail) {
      return res.json({
        success: true,
        message: genericMessage
      });
    }

    const users = getUsersFromXML();
    const userIndex = users.findIndex(
      user => normaliseEmail(user.email) === cleanedEmail
    );

    if (userIndex === -1) {
      return res.json({
        success: true,
        message: genericMessage
      });
    }

    const user = users[userIndex];

    if (user.status !== "Active" || !user.passwordHash) {
      return res.json({
        success: true,
        message: genericMessage
      });
    }

    const resetToken = crypto.randomBytes(32).toString("base64url");
    const resetTokenHash = hashResetToken(resetToken);
    const resetPasswordExpiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

    users[userIndex] = {
      ...user,
      resetPasswordTokenHash: resetTokenHash,
      resetPasswordExpiresAt,
      resetPasswordRequestedAt: new Date().toISOString()
    };

    saveUsersToXML(users);

    const resetUrl = `${getAppBaseUrl()}/reset-password.html?token=${encodeURIComponent(resetToken)}&email=${encodeURIComponent(cleanedEmail)}`;

    try {
      await sendPasswordResetEmail(user, resetUrl);
    } catch (emailError) {
      console.error("Password reset email error:", emailError);
    }

    res.json({
      success: true,
      message: genericMessage
    });
  } catch (error) {
    console.error("Forgot password error:", error);

    res.json({
      success: true,
      message: genericMessage
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
      user => normaliseEmail(user.email) === cleanedEmail
    );

    if (userIndex === -1) {
      return res.status(400).json({
        success: false,
        message: "The reset link is invalid or has expired."
      });
    }

    const user = users[userIndex];

    if (
      user.status !== "Active" ||
      !user.passwordHash ||
      !user.resetPasswordTokenHash ||
      !user.resetPasswordExpiresAt
    ) {
      return res.status(400).json({
        success: false,
        message: "The reset link is invalid or has expired."
      });
    }

    const tokenHash = hashResetToken(cleanedToken);

    const tokenMatches = crypto.timingSafeEqual(
      Buffer.from(tokenHash, "hex"),
      Buffer.from(user.resetPasswordTokenHash, "hex")
    );

    const tokenExpired = new Date(user.resetPasswordExpiresAt).getTime() < Date.now();

    if (!tokenMatches || tokenExpired) {
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

    users[userIndex] = clearPasswordResetFields({
      ...user,
      passwordHash,
      passwordResetAt: new Date().toISOString()
    });

    saveUsersToXML(users);

    res.json({
      success: true,
      message: "Password reset successfully. Please sign in with your new password."
    });
  } catch (error) {
    console.error("Reset password error:", error);

    res.status(500).json({
      success: false,
      message: "Unable to reset password. Please try again or contact the portal administrator."
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

/* ---------------- ADMIN STORAGE DIAGNOSTIC ROUTE ---------------- */
/* Requires an authenticated Admin account. Remove before full production use if not needed. */

app.get("/api/debug/storage", requireLogin, requireAdmin, (req, res) => {
  try {
    res.json({
      success: true,
      dataDir,
      sourceUsersFile,
      liveUsersFile,
      dataDirExists: fs.existsSync(dataDir),
      sourceUsersFileExists: fs.existsSync(sourceUsersFile),
      liveUsersFileExists: fs.existsSync(liveUsersFile),
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

    console.log(`ICT booking server running on port ${PORT}`);
    console.log("Monthly booking storage enabled.");
    console.log(`DATA_DIR: ${dataDir}`);
    console.log(`Booking files directory: ${path.join(dataDir, "bookings")}`);
    console.log(`Source users file: ${sourceUsersFile}`);
    console.log(`Live users file: ${liveUsersFile}`);
    console.log(`Live users file exists: ${fs.existsSync(liveUsersFile)}`);
    console.log(`User records loaded from persistent storage: ${userCount}`);
  } catch (error) {
    console.error("Failed to initialise encrypted user storage:", error);
    process.exit(1);
  }
});
