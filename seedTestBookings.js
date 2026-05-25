const fs = require("fs");
const path = require("path");

const dataDir = process.env.DATA_DIR || path.join(__dirname, "data");
const bookingsFile = path.join(dataDir, "bookings.xml");

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const testBookingsXML = `<?xml version="1.0" encoding="UTF-8"?>
<bookings>
  <booking id="1">
    <name>Test User A</name>
    <bookingDate>2026-06-01</bookingDate>
    <startTime>09:00</startTime>
    <endTime>10:00</endTime>
    <location>Classroom 1</location>
    <deviceType>iPad</deviceType>
    <softwareRequirement>None</softwareRequirement>
    <devicesRequired>20</devicesRequired>
    <status>Confirmed</status>
    <allocation>
      <allocationMethod>Direct Allocation</allocationMethod>
      <cartCount>1</cartCount>
      <bagCount>0</bagCount>
      <totalAllocatedCapacity>40</totalAllocatedCapacity>
      <resources>
        <resourceId>IPAD-CART-05</resourceId>
      </resources>
    </allocation>
    <submittedAt>2026-05-25T01:00:00.000Z</submittedAt>
  </booking>

  <booking id="2">
    <name>Test User B</name>
    <bookingDate>2026-06-01</bookingDate>
    <startTime>09:00</startTime>
    <endTime>10:00</endTime>
    <location>Classroom 2</location>
    <deviceType>iPad</deviceType>
    <softwareRequirement>None</softwareRequirement>
    <devicesRequired>8</devicesRequired>
    <status>Confirmed</status>
    <allocation>
      <allocationMethod>Direct Allocation</allocationMethod>
      <cartCount>1</cartCount>
      <bagCount>0</bagCount>
      <totalAllocatedCapacity>40</totalAllocatedCapacity>
      <resources>
        <resourceId>IPAD-CART-06</resourceId>
      </resources>
    </allocation>
    <submittedAt>2026-05-25T01:05:00.000Z</submittedAt>
  </booking>
</bookings>`;

fs.writeFileSync(bookingsFile, testBookingsXML);

console.log(`Test bookings written to ${bookingsFile}`);
