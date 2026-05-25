const express = require("express");
const fs = require("fs");
const path = require("path");
const { XMLParser, XMLBuilder } = require("fast-xml-parser");
const { allocateResources } = require("./resourceAllocator");

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(__dirname));

app.get("/api/users", (req, res) => {
  const xml = fs.readFileSync(path.join(__dirname, "users.xml"), "utf8");
  const parsed = new XMLParser().parse(xml);
  const users = parsed.organisationUsers.user.map(u => u.name);
  res.json({ users });
});

app.get("/api/locations", (req, res) => {
  const xml = fs.readFileSync(path.join(__dirname, "locations.xml"), "utf8");
  const parsed = new XMLParser().parse(xml);
  const locations = parsed.deploymentLocations.location;
  res.json({ locations });
});

const bookingsFile = path.join(__dirname, "bookings.xml");

function ensureBookingsFile() {
  if (!fs.existsSync(bookingsFile)) {
    fs.writeFileSync(bookingsFile, `<?xml version="1.0" encoding="UTF-8"?>\n<bookings></bookings>`);
  }
}

app.post("/api/bookings", (req, res) => {
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
});

app.listen(PORT, () => {
  console.log(`ICT booking server running at http://localhost:${PORT}`);
});
