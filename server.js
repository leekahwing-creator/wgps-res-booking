const express = require("express");
const fs = require("fs");
const path = require("path");
const { XMLParser, XMLBuilder } = require("fast-xml-parser");
const { allocateResources } = require("./resourceAllocator");
const { resolveConflict } = require("./conflictResolver");
const { ensureMonthlyBookingsFile } = require("./bookingFileHelper");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
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

app.post("/api/bookings", (req, res) => {
  try {
    const bookingsFile = ensureMonthlyBookingsFile(req.body.bookingDate);

    const parser = new XMLParser({ ignoreAttributes: false });
    const builder = new XMLBuilder({
      ignoreAttributes: false,
      format: true,
      suppressEmptyNode: true
    });

    let allocationResult = allocateResources(req.body);

    let reallocationUpdates = [];

    if (allocationResult.status !== "Confirmed") {
      const conflictResolution = resolveConflict(req.body);

      if (conflictResolution.success) {
        allocationResult = {
          status: conflictResolution.status,
          allocation: conflictResolution.allocation
        };

        reallocationUpdates = conflictResolution.existingBookingUpdates;
      }
    }

    const xmlData = fs.readFileSync(bookingsFile, "utf8");
    const parsed = parser.parse(xmlData);

    if (!parsed.bookings) parsed.bookings = {};

    if (!parsed.bookings.booking) {
      parsed.bookings.booking = [];
    } else if (!Array.isArray(parsed.bookings.booking)) {
      parsed.bookings.booking = [parsed.bookings.booking];
    }

    const newBooking = {
      "@_id": parsed.bookings.booking.length + 1,
      ...req.body,
      status: allocationResult.status,
      allocation: allocationResult.allocation
    };

    reallocationUpdates.forEach(update => {
      const bookingToUpdate = parsed.bookings.booking.find(
        booking => String(booking["@_id"]) === String(update.bookingId)
      );

      if (bookingToUpdate) {
        bookingToUpdate.status = update.status;
        bookingToUpdate.allocation = update.allocation;
      }
    });

    parsed.bookings.booking.push(newBooking);

    const updatedXml = builder.build(parsed);
    fs.writeFileSync(bookingsFile, updatedXml);

    res.json({
      success: true,
      message: "Booking saved with resource allocation.",
      booking: newBooking
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

app.listen(PORT, () => {
  console.log(`ICT booking server running on port ${PORT}`);
  console.log(`Monthly booking storage enabled.`);
  console.log(`Booking files directory: ${dataDir}/bookings`);
});
