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
    const parser = new XMLParser({ ignoreAttributes: false });
    const builder = new XMLBuilder({
      ignoreAttributes: false,
      format: true,
      suppressEmptyNode: true
    });

    const bookingRequest = req.body;
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

app.get("/api/bookings/search", (req, res) => {
  try {
    const name = (req.query.name || "").trim().toLowerCase();

    if (!name) {
      return res.status(400).json({
        success: false,
        message: "Name is required."
      });
    }

    const files = getAllMonthlyBookingFiles();
    const today = new Date().toISOString().split("T")[0];

    const bookings = files.flatMap(file => readBookingsFromFile(file))
      .filter(booking => {
        return (
          String(booking.name || "").toLowerCase() === name &&
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

app.delete("/api/bookings/:bookingId", (req, res) => {
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

app.delete("/api/bookings/recurring/:recurringGroupId", (req, res) => {
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

app.put("/api/bookings/:bookingId", (req, res) => {
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

    const bookingIndex = bookings.findIndex(
      booking => String(booking["@_id"]) === String(bookingId)
    );

    if (bookingIndex === -1) {
      return res.status(404).json({
        success: false,
        message: "Booking not found."
      });
    }

    bookings[bookingIndex] = {
      ...bookings[bookingIndex],
      ...req.body,
      status: "Pending Allocation"
    };

    writeBookingsToFile(bookingsFile, bookings);

    res.json({
      success: true,
      message: "Booking updated successfully.",
      booking: bookings[bookingIndex]
    });
  } catch (error) {
    console.error("Update booking error:", error);

    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`ICT booking server running on port ${PORT}`);
  console.log(`Monthly booking storage enabled.`);
  console.log(`Booking files directory: ${dataDir}/bookings`);
});
