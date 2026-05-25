const express = require("express");
const fs = require("fs");
const path = require("path");
const { XMLParser, XMLBuilder } = require("fast-xml-parser");
const { allocateResources } = require("./resourceAllocator");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(__dirname));

const dataDir = process.env.DATA_DIR || path.join(__dirname, "data");
const bookingsFile = path.join(dataDir, "bookings.xml");

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
  const xml = fs.readFileSync(path.join(__dirname, "users.xml"), "utf8");
  const parsed = new XMLParser().parse(xml);

  const users = toArray(parsed.organisationUsers?.user)
    .map(user => user.name)
    .filter(Boolean);

  res.json({ users });
});

app.get("/api/locations", (req, res) => {
  const xml = fs.readFileSync(path.join(__dirname, "locations.xml"), "utf8");
  const parsed = new XMLParser().parse(xml);

  const locations = toArray(parsed.deploymentLocations?.location)
    .filter(Boolean);

  res.json({ locations });
});

app.post("/api/bookings", (req, res) => {
  try {
    ensureBookingsFile();

    const parser = new XMLParser({ ignoreAttributes: false });
    const builder = new XMLBuilder({
      ignoreAttributes: false,
      format: true,
      suppressEmptyNode: true
    });

    const allocationResult = allocateResources(req.body);

    const xmlData = fs.readFileSync(bookingsFile, "utf8");
    const parsed = parser.parse(xmlData);

    if (!parsed.bookings) {
      parsed.bookings = {};
    }

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

app.listen(PORT, () => {
  console.log(`ICT booking server running on port ${PORT}`);
});
