const session = require("express-session");
const argon2 = require("argon2");
const express = require("express");
const fs = require("fs");
const path = require("path");
const { XMLParser, XMLBuilder } = require("fast-xml-parser");
const { allocateResources } = require("./resourceAllocator");
const { resolveConflict } = require("./conflictResolver");
const { ensureMonthlyBookingsFile } = require("./bookingFileHelper");

const googleClient = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID
);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
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

// App folder files
const appDir = __dirname;
const usersFile = path.join(appDir, "users.xml");
const locationsFile = path.join(appDir, "locations.xml");

// Persistent disk folder for saved bookings only
const dataDir = process.env.DATA_DIR || path.join(__dirname, "data");

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function ensureDataFolder() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

function ensureBookingsFile() {
  ensureDataFolder();

  if (!fs.existsSync(bookingsFile)) {
    fs.writeFileSync(
      bookingsFile,
      `<?xml version="1.0" encoding="UTF-8"?>\n<bookings></bookings>`
    );
  }
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

function normaliseEmail(email) {
  return String(email || "").trim().toLowerCase();
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

app.get("/api/users", (req, res) => {
  const xml = fs.readFileSync(usersFile, "utf8");
  const parsed = new XMLParser().parse(xml);

  const users = toArray(parsed.organisationUsers?.user)
    .map(user => user.name)
    .filter(Boolean);

  res.json({ users });
});

app.get("/api/locations", (req, res) => {
  const xml = fs.readFileSync(locationsFile, "utf8");
  const parsed = new XMLParser().parse(xml);

  const locations = toArray(parsed.deploymentLocations?.location)
    .filter(Boolean);

  res.json({ locations });
});

app.post("/api/bookings", requireLogin, (req, res) => {
  try {
    const parser = new XMLParser({ ignoreAttributes: false });
    const builder = new XMLBuilder({
      ignoreAttributes: false,
      format: true,
      suppressEmptyNode: true
    });

    const bookingRequest = {
      req.body,
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

    const recurringGroupId = isRecurring
      ? `REC-${Date.now()}`
      : "";

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

      const updatedXml = builder.build(parsed);
      fs.writeFileSync(bookingsFile, updatedXml);

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

function getAllMonthlyBookingFiles() {
  const bookingsDir = path.join(dataDir, "bookings");

  if (!fs.existsSync(bookingsDir)) {
    fs.mkdirSync(bookingsDir, { recursive: true });
  }

  return fs.readdirSync(bookingsDir)
    .filter(file => file.endsWith(".xml"))
    .map(file => path.join(bookingsDir, file));
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

app.get("/api/bookings/search", requireLogin, (req, res) => {
  try {
    const email = req.session.user.email;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email is required."
      });
    }

    const files = getAllMonthlyBookingFiles();
    const today = new Date().toISOString().split("T")[0];

    const bookings = files.flatMap(file => readBookingsFromFile(file))
      .filter(booking => {
        return (
          String(booking.email || "").toLowerCase() === email.toLowerCase() &&
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

    const updatedBookings = bookings.filter(
      booking => String(booking["@_id"]) !== String(bookingId)
    );

    if (updatedBookings.length === bookings.length) {
      return res.status(404).json({
        success: false,
        message: "Booking not found."
      });
    }

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
        const shouldDelete = booking.recurringGroupId === recurringGroupId;
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

    const updatedBookingRequest = {
      ...existingBooking,
      ...req.body,
      bookingDate: req.body.bookingDate || existingBooking.bookingDate,
      status: "Pending Allocation"
    };

    // Remove the existing booking from its original monthly XML first.
    // This prevents the allocator from treating its old allocation as a conflict.
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

    const targetBookingsFile = ensureMonthlyBookingsFile(
      updatedBookingRequest.bookingDate
    );

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

function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({
      success: false,
      message: "Login required."
    });
  }

  next();
}

app.post("/api/auth/google", async (req, res) => {
  try {
    const { credential } = req.body;

    if (!credential) {
      return res.status(400).json({
        success: false,
        message: "Missing Google credential."
      });
    }

    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID
    });

    const payload = ticket.getPayload();

    const allowedDomain = process.env.ALLOWED_GOOGLE_DOMAIN;

    if (allowedDomain && payload.hd !== allowedDomain) {
      return res.status(403).json({
        success: false,
        message: "Unauthorised Google account."
      });
    }

    const authenticatedUser = {
      name: payload.name,
      email: payload.email,
      picture: payload.picture,
      googleSubject: payload.sub
    };

    req.session.user = authenticatedUser;

    res.json({
      success: true,
      user: authenticatedUser
    });

  } catch (error) {
    console.error("Google login error:", error);

    res.status(401).json({
      success: false,
      message: "Google login failed."
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
    res.json({
      success: true
    });
  });
});

app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;

    const cleanedName = String(name || "").trim();
    const cleanedEmail = normaliseEmail(email);

    if (!cleanedName || !cleanedEmail || !password) {
      return res.status(400).json({
        success: false,
        message: "Name, email and password are required."
      });
    }

    const passwordErrors = validatePassword(password, cleanedName, cleanedEmail);

    if (passwordErrors.length > 0) {
      return res.status(400).json({
        success: false,
        message: passwordErrors.join(" ")
      });
    }

    const parser = new XMLParser({ ignoreAttributes: false });
    const builder = new XMLBuilder({
      ignoreAttributes: false,
      format: true,
      suppressEmptyNode: true
    });

    const xml = fs.readFileSync(usersFile, "utf8");
    const parsed = parser.parse(xml);

    if (!parsed.organisationUsers) {
      parsed.organisationUsers = {};
    }

    if (!parsed.organisationUsers.user) {
      parsed.organisationUsers.user = [];
    } else if (!Array.isArray(parsed.organisationUsers.user)) {
      parsed.organisationUsers.user = [parsed.organisationUsers.user];
    }

    const existingUser = parsed.organisationUsers.user.find(
      user => normaliseEmail(user.email) === cleanedEmail
    );

    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: "An account with this email already exists."
      });
    }

    const passwordHash = await argon2.hash(password, {
      type: argon2.argon2id
    });

    const newUser = {
      userId: `U${String(parsed.organisationUsers.user.length + 1).padStart(4, "0")}`,
      name: cleanedName,
      email: cleanedEmail,
      passwordHash,
      role: "User",
      status: "Active",
      createdAt: new Date().toISOString()
    };

    parsed.organisationUsers.user.push(newUser);

    fs.writeFileSync(usersFile, builder.build(parsed));

    req.session.user = {
      userId: newUser.userId,
      name: newUser.name,
      email: newUser.email,
      role: newUser.role
    };

    res.json({
      success: true,
      user: req.session.user
    });
  } catch (error) {
    console.error("Register error:", error);

    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const cleanedEmail = normaliseEmail(email);

    const parser = new XMLParser({ ignoreAttributes: false });
    const xml = fs.readFileSync(usersFile, "utf8");
    const parsed = parser.parse(xml);

    const users = toArray(parsed.organisationUsers?.user);

    const user = users.find(
      existingUser => normaliseEmail(existingUser.email) === cleanedEmail
    );

    if (!user || user.status !== "Active") {
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

app.listen(PORT, () => {
  console.log(`ICT booking server running on port ${PORT}`);
  console.log(`Monthly booking storage enabled.`);
  console.log(`Booking files directory: ${dataDir}/bookings`);
});
